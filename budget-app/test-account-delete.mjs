// Account deletion test. Deleting an account is the one irreversible action in
// the app, so the cascade has to be exact: its own rows go, transfers to
// accounts that stay keep their side (and their balance), a credit card's
// payment category releases whatever was assigned to it, and a loan payment
// keeps the interest split that holds the loan balance together.
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

const EMAIL = 'account-delete-test@example.com';
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

await call('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: 'account-delete-1' } });

const state = async () => (await call('/api/state')).json;
const acct = async id => (await state()).accounts.find(a => a.id === id);
const txnsOn = async id => (await call(`/api/transactions?accountId=${id}`)).json;

const mk = async (name, type, startingBalance = 0, extra = {}) =>
  (await call('/api/accounts', { method: 'POST', body: { name, type, startingBalance, ...extra } })).json.id;

const keeper = await mk('Keeper Checking', 'cash', 10000000);
const doomed = await mk('Doomed Savings', 'cash', 500000);

// a transfer between them: the money genuinely left Keeper
await call('/api/transactions', {
  method: 'POST',
  body: { accountId: keeper, date: '2026-02-10', payee: '', memo: 'to savings', amount: -80000, kind: 'transfer', transferAccountId: doomed },
});
const keeperBefore = (await acct(keeper)).balance;

// ---------- impact preview ----------
let r = await call(`/api/accounts/${doomed}/deletion-impact`);
check('impact preview counts the account\'s own rows', r.json.transactions === 2, `got ${r.json.transactions}`);
check('impact preview reports Ready to Assign falling', r.json.incomeRemoved === 500000, `got ${r.json.incomeRemoved}`);
check('impact preview names the account left holding a transfer',
  r.json.stranded.length === 1 && r.json.stranded[0].account === 'Keeper Checking' && r.json.stranded[0].count === 1,
  JSON.stringify(r.json.stranded));
check('impact preview is read-only', (await acct(doomed)) != null);

const rtaBefore = (await state()).readyToAssign;

// ---------- the delete itself ----------
r = await call(`/api/accounts/${doomed}`, { method: 'DELETE' });
check('delete succeeds', r.status === 200, JSON.stringify(r.json));
check('the account is gone', (await acct(doomed)) === undefined);
check('its transactions are gone', (await txnsOn(doomed)).length === 0);

const keeperAfter = await acct(keeper);
check('the surviving account keeps its balance', keeperAfter.balance === keeperBefore,
  `${keeperAfter.balance} vs ${keeperBefore}`);
const stranded = (await txnsOn(keeper)).find(t => t.memo === 'to savings');
check('the surviving transfer row is still there', stranded != null);
check('and is no longer a transfer', stranded && !stranded.is_transfer && stranded.transfer_account_id == null);
check('and is uncategorized so it can be re-filed', stranded && stranded.category_id == null);
check('and remembers where the money went', stranded && stranded.payee === 'Doomed Savings', stranded?.payee);
check('Ready to Assign drops by the income that left',
  (await state()).readyToAssign === rtaBefore - 500000,
  `${(await state()).readyToAssign} vs ${rtaBefore - 500000}`);

// ---------- credit card: payment category and its assigned money ----------
const card = await mk('Doomed Card', 'credit', -30000);
let st = await state();
const payCat = st.groups.flatMap(g => g.categories).find(c => c.name === 'Doomed Card');
check('a credit card brings a payment category', payCat != null);
await call('/api/assign', { method: 'PUT', body: { month: st.month, categoryId: payCat.id, amount: 40000 } });
const rtaAssigned = (await state()).readyToAssign;

r = await call(`/api/accounts/${card}/deletion-impact`);
check('impact preview reports the assigned money coming back',
  r.json.category?.assigned === 40000, JSON.stringify(r.json.category));

await call(`/api/accounts/${card}`, { method: 'DELETE' });
st = await state();
check('the payment category goes with the card',
  !st.groups.flatMap(g => g.categories).some(c => c.id === payCat.id));
check('its assigned money returns to Ready to Assign',
  st.readyToAssign === rtaAssigned + 40000, `${st.readyToAssign} vs ${rtaAssigned + 40000}`);

// ---------- loan: the interest split must survive on the paying side ----------
const payer = await mk('Payer Checking', 'cash', 10000000);
const loan = await mk('Car Note', 'loan', -3000000, { apr: 5.49, loanMonths: 60 });
await call('/api/loan-payment', {
  method: 'POST', body: { fromAccountId: payer, loanAccountId: loan, amount: 57290, date: '2026-01-15' },
});
const loanOwedBefore = -(await acct(loan)).balance;

await call(`/api/accounts/${payer}`, { method: 'DELETE' });
const loanAfter = await acct(loan);
check('deleting the paying account leaves the loan balance alone',
  -loanAfter.balance === loanOwedBefore, `${-loanAfter.balance} vs ${loanOwedBefore}`);
// rows come back newest first, and the starting balance is dated today — the
// payment is the one carrying an interest slice
const loanRow = (await txnsOn(loan)).find(t => t.amount === 57290);
// $30,000 at 5.49% accrues $137.25 in the first month
check('the loan row keeps its interest split', loanRow?.interest === 13725, `interest=${loanRow?.interest}`);
check('and is no longer a transfer either', loanRow && !loanRow.is_transfer);
check('the payment still isn\'t credited back to the term', loanAfter.loanMonths === 59,
  `loanMonths=${loanAfter.loanMonths}`);

// ---------- guards ----------
check('deleting an account that does not exist 404s',
  (await call('/api/accounts/999999', { method: 'DELETE' })).status === 404);
check('impact for a missing account 404s',
  (await call('/api/accounts/999999/deletion-impact')).status === 404);

// ---------- close / reopen still works alongside ----------
await call(`/api/accounts/${keeper}`, { method: 'PATCH', body: { closed: true } });
check('an account can be closed instead', (await acct(keeper)).closed === true);
await call(`/api/accounts/${keeper}`, { method: 'PATCH', body: { closed: false } });
check('and reopened', (await acct(keeper)).closed === false);
check('closing never touched its transactions', (await txnsOn(keeper)).length > 0);

console.log(out.join('\n'));
console.log(out.some(l => l.startsWith('FAIL')) ? '\nFAILED' : '\nAll account delete checks passed');
