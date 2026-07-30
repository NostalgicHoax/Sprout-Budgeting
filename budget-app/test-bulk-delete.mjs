// Bulk delete test. Deleting many transactions at once has to behave exactly
// like deleting them one at a time: transfer pairs go together, loan payments
// hand their month back to the term, and selecting both sides of a pair must not
// double-count or fail.
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

const EMAIL = 'bulk-delete-test@example.com';
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

await call('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: 'bulk-delete-1' } });

const checking = (await call('/api/accounts', {
  method: 'POST', body: { name: 'Checking', type: 'cash', startingBalance: 10000000 },
})).json.id;
const savings = (await call('/api/accounts', {
  method: 'POST', body: { name: 'Savings', type: 'cash' },
})).json.id;
const loan = (await call('/api/accounts', {
  method: 'POST', body: { name: 'Car Note', type: 'loan', startingBalance: -3000000, apr: 5.49, loanMonths: 60 },
})).json.id;

const txnsOn = async id => (await call(`/api/transactions?accountId=${id}`)).json;
const acct = async id => (await call('/api/state')).json.accounts.find(a => a.id === id);

const addPlain = async (payee, amount, date) => (await call('/api/transactions', {
  method: 'POST', body: { accountId: checking, date, payee, memo: '', amount, kind: 'uncategorized' },
})).json.id;

// ---------- plain rows ----------
const plain = [];
for (let i = 1; i <= 5; i++) plain.push(await addPlain(`Store ${i}`, -1000 * i, `2026-03-0${i}`));
const before = (await acct(checking)).balance;

let r = await call('/api/transactions/bulk-delete', { method: 'POST', body: { ids: plain.slice(0, 3) } });
check('bulk delete reports how many rows went', r.status === 200 && r.json.deleted === 3, JSON.stringify(r.json));
check('only the selected rows are gone',
  (await txnsOn(checking)).filter(t => plain.includes(t.id)).length === 2);
check('balance reflects exactly the deleted rows',
  (await acct(checking)).balance === before + 1000 + 2000 + 3000);

// ---------- transfers: one side selected removes both ----------
await call('/api/transactions', {
  method: 'POST',
  body: { accountId: checking, date: '2026-03-10', payee: '', memo: '', amount: -50000, kind: 'transfer', transferAccountId: savings },
});
const xfer = (await txnsOn(checking)).find(t => t.is_transfer);
r = await call('/api/transactions/bulk-delete', { method: 'POST', body: { ids: [xfer.id] } });
check('deleting one side of a transfer removes both', r.json.deleted === 2, `deleted ${r.json.deleted}`);
check('the mirror really is gone', (await txnsOn(savings)).length === 0);

// ---------- transfers: both sides selected must not fail ----------
await call('/api/transactions', {
  method: 'POST',
  body: { accountId: checking, date: '2026-03-11', payee: '', memo: '', amount: -25000, kind: 'transfer', transferAccountId: savings },
});
const bothA = (await txnsOn(checking)).find(t => t.is_transfer);
const bothB = (await txnsOn(savings)).find(t => t.is_transfer);
r = await call('/api/transactions/bulk-delete', { method: 'POST', body: { ids: [bothA.id, bothB.id] } });
check('selecting both sides of a transfer still succeeds', r.status === 200, JSON.stringify(r.json));
check('and does not double-count the removal', r.json.deleted === 2, `deleted ${r.json.deleted}`);
check('both accounts end up clean',
  (await txnsOn(savings)).length === 0 && (await txnsOn(checking)).filter(t => t.is_transfer).length === 0);

// ---------- loan payments give their term back ----------
for (const m of ['01', '02', '03']) {
  await call('/api/loan-payment', {
    method: 'POST', body: { fromAccountId: checking, loanAccountId: loan, amount: 57290, date: `2026-${m}-15` },
  });
}
const loanBefore = await acct(loan);
check('three payments consumed three months', loanBefore.loanMonths === 57, `loanMonths=${loanBefore.loanMonths}`);

const payments = (await txnsOn(loan)).filter(t => t.interest != null);
const owedBefore = -loanBefore.balance;
const principalBack = payments.slice(0, 2).reduce((s, t) => s + (t.amount - t.interest), 0);
r = await call('/api/transactions/bulk-delete', { method: 'POST', body: { ids: payments.slice(0, 2).map(t => t.id) } });
check('bulk-deleting loan payments removes both sides of each', r.json.deleted === 4, `deleted ${r.json.deleted}`);

const loanAfter = await acct(loan);
check('the term gets a month back per payment', loanAfter.loanMonths === 59, `loanMonths=${loanAfter.loanMonths}`);
check('principal is restored, interest is not', -loanAfter.balance === owedBefore + principalBack,
  `${-loanAfter.balance} vs ${owedBefore + principalBack}`);

// ---------- guards ----------
check('an empty selection is refused',
  (await call('/api/transactions/bulk-delete', { method: 'POST', body: { ids: [] } })).status === 400);
check('non-numeric ids are refused',
  (await call('/api/transactions/bulk-delete', { method: 'POST', body: { ids: ['1; DROP TABLE transactions'] } })).status === 400);
check('ids that no longer exist are tolerated',
  (await call('/api/transactions/bulk-delete', { method: 'POST', body: { ids: [999999] } })).json.deleted === 0);
check('the table survived all of that', Array.isArray(await txnsOn(checking)));

console.log(out.join('\n'));
console.log(out.some(l => l.startsWith('FAIL')) ? '\nFAILED' : '\nAll bulk delete checks passed');
