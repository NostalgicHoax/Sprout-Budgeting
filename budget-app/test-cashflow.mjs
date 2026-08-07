// Income vs expenses report. The classification has to match the spending
// report or the two views of the same month disagree: transfers between your own
// accounts aren't flows, starting balances aren't income you earned, balance
// adjustments are reconciliation noise, and loan accounts are tracking-only.
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const API = 'http://localhost:3178';
const out = [];
const check = (n, ok, d = '') => { out.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); if (!ok) process.exitCode = 1; };

let cookie = null;
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const EMAIL = 'cashflow-test@example.com';
{
  const base = process.env.DATA_DIR
    ? resolve(process.env.DATA_DIR)
    : fileURLToPath(new URL('./server/data', import.meta.url));
  const dp = p => resolve(base, p);
  const sysdb = new DatabaseSync(dp('system.db'));
  const old = sysdb.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL);
  if (old) {
    const bs = sysdb.prepare('SELECT file FROM budgets WHERE user_id = ?').all(old.id);
    sysdb.prepare('DELETE FROM sessions WHERE user_id = ?').run(old.id);
    sysdb.prepare('DELETE FROM budgets WHERE user_id = ?').run(old.id);
    sysdb.prepare('DELETE FROM users WHERE id = ?').run(old.id);
    for (const b of bs) if (b.file !== 'budget.db') for (const s of ['', '-wal', '-shm']) { try { rmSync(dp(b.file + s)); } catch {} }
  }
  sysdb.close();
}

await call('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: 'cashflow-test-1' } });

const state = async () => (await call('/api/state')).json;
const MONTH = (await state()).month;
const shift = (m, n) => {
  const [y, mo] = m.split('-').map(Number);
  const i = y * 12 + (mo - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};
const flow = async months => (await call(`/api/reports/cashflow${months ? `?months=${months}` : ''}`)).json;
const monthOf = (r, m) => r.months.find(x => x.month === m);

const checking = (await call('/api/accounts', { method: 'POST', body: { name: 'Checking', type: 'cash' } })).json.id;
const savings = (await call('/api/accounts', { method: 'POST', body: { name: 'Savings', type: 'cash' } })).json.id;
const loan = (await call('/api/accounts', {
  method: 'POST', body: { name: 'Car Note', type: 'loan', startingBalance: -1000000, apr: 5, loanMonths: 48 },
})).json.id;
const group = (await call('/api/groups', { method: 'POST', body: { name: 'Life' } })).json.id;
const cat = (await call('/api/categories', { method: 'POST', body: { groupId: group, name: 'Food' } })).json.id;

const txn = (body) => call('/api/transactions', { method: 'POST', body: { memo: '', payee: 'x', ...body } });

// ---------- shape ----------
let r = await flow();
check('defaults to 3 months', r.months.length === 3, `got ${r.months.length}`);
check('and the last of them is this month', r.months.at(-1).month === MONTH,
  `${r.months.at(-1).month} vs ${MONTH}`);
check('oldest first', r.months[0].month === shift(MONTH, -2), r.months[0].month);
check('longer lookbacks are honoured', (await flow(12)).months.length === 12);
check('lookback is capped', (await flow(999)).months.length === 60);
check('a silly lookback falls back to 3', (await flow(0)).months.length === 3);
check('empty months still appear', r.months.every(m => m.income === 0 && m.expense === 0));

// ---------- the basics ----------
await txn({ accountId: checking, date: `${MONTH}-03`, amount: 300000, kind: 'income' });
await txn({ accountId: checking, date: `${MONTH}-06`, amount: -50000, kind: 'category', categoryId: cat });
await txn({ accountId: checking, date: `${MONTH}-09`, amount: -20000, kind: 'uncategorized' });
r = await flow();
let m = monthOf(r, MONTH);
check('income is money in', m.income === 300000, `income ${m.income}`);
check('spending counts whether categorized or not', m.expense === 70000, `expense ${m.expense}`);
check('net is in minus out', m.net === 230000, `net ${m.net}`);

// ---------- what must not count ----------
await txn({
  accountId: checking, date: `${MONTH}-11`, amount: -90000,
  kind: 'transfer', transferAccountId: savings,
});
m = monthOf(await flow(), MONTH);
check('a transfer between your accounts is not spending', m.expense === 70000, `expense ${m.expense}`);
check('and not income on the receiving side', m.income === 300000, `income ${m.income}`);

// a starting balance is income-flagged on cash accounts, but it isn't earnings
const seeded = (await call('/api/accounts', {
  method: 'POST', body: { name: 'Seeded', type: 'cash', startingBalance: 800000 },
})).json.id;
check('seeded account created', seeded != null);
m = monthOf(await flow(), MONTH);
check('a starting balance is not income', m.income === 300000, `income ${m.income}`);

await txn({ accountId: checking, date: `${MONTH}-12`, amount: -4000, kind: 'uncategorized', payee: 'Balance Adjustment' });
m = monthOf(await flow(), MONTH);
check('a balance adjustment is not spending', m.expense === 70000, `expense ${m.expense}`);

// loan accounts are tracking-only everywhere else, so they are here too
await txn({ accountId: loan, date: `${MONTH}-14`, amount: -25000, kind: 'uncategorized' });
m = monthOf(await flow(), MONTH);
check('loan account activity is left out', m.expense === 70000, `expense ${m.expense}`);

// ---------- month bucketing ----------
const prev = shift(MONTH, -1);
await txn({ accountId: checking, date: `${prev}-15`, amount: 100000, kind: 'income' });
await txn({ accountId: checking, date: `${prev}-16`, amount: -130000, kind: 'category', categoryId: cat });
r = await flow();
const p = monthOf(r, prev);
check('last month lands in last month', p.income === 100000 && p.expense === 130000,
  `in ${p.income}, out ${p.expense}`);
check('a losing month reports a negative net', p.net === -30000, `net ${p.net}`);
check('this month is unaffected', monthOf(r, MONTH).income === 300000);

// ---------- totals ----------
check('totals add the window up',
  r.totals.income === 400000 && r.totals.expense === 200000 && r.totals.net === 200000,
  JSON.stringify(r.totals));
check('averages divide by the window, not by months with data',
  r.average.income === Math.round(400000 / 3), `avg ${r.average.income}`);

// ---------- agrees with the spending report ----------
const firstOfMonth = `${MONTH}-01`;
const spend = (await call(`/api/reports/spending?start=${firstOfMonth}&end=${MONTH}-28`)).json;
check('spending total matches this month\'s money out',
  Math.abs(spend.total) === monthOf(r, MONTH).expense,
  `spending ${Math.abs(spend.total)} vs cashflow ${monthOf(r, MONTH).expense}`);

// ---------- an opening balance can be dated in the past ----------
const backdated = shift(MONTH, -2);
const older = (await call('/api/accounts', {
  method: 'POST',
  body: { name: 'Old Account', type: 'cash', startingBalance: 500000, date: `${backdated}-04` },
})).json.id;
const openingRow = (await call(`/api/transactions?accountId=${older}`)).json.find(t => t.is_starting);
check('an opening balance keeps the date it was given', openingRow?.date === `${backdated}-04`,
  `dated ${openingRow?.date}, expected ${backdated}-04`);
check('a bad opening date is refused',
  (await call('/api/accounts', {
    method: 'POST', body: { name: 'Bad', type: 'cash', startingBalance: 100, date: 'last tuesday' },
  })).status === 400);

console.log(out.join('\n'));
console.log(out.some(l => l.startsWith('FAIL')) ? '\nFAILED' : '\nAll cashflow checks passed');
