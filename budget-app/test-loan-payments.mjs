// Loan payment test. The monthly payment shown on the payoff panel is derived
// from (balance, apr, months remaining), so it only stays put if all three move
// together. A plain transfer moved the balance alone and made the payment drift
// downward; /api/loan-payment moves the balance by principal only and steps the
// term down by one, which is exactly the amortization identity.
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

/** Mirrors monthlyPayment() in LoanPanel.jsx — the number the user actually sees. */
function derivedPayment(balance, aprPct, n) {
  const r = aprPct / 100 / 12;
  if (r === 0) return Math.ceil(balance / n);
  return Math.round((balance * r) / (1 - Math.pow(1 + r, -n)));
}

const EMAIL = 'loan-payment-test@example.com';
{
  // honour DATA_DIR the way the server does, so this is safe to run against a
  // throwaway data directory
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

await call('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: 'loan-payment-1' } });

const APR = 5.49;
const TERM = 60;
const OWED = 3000000; // $30,000

const checking = (await call('/api/accounts', {
  method: 'POST', body: { name: 'Checking', type: 'cash', startingBalance: 5000000 },
})).json.id;
const loan = (await call('/api/accounts', {
  method: 'POST',
  body: { name: 'Car Note', type: 'loan', startingBalance: -OWED, apr: APR, loanMonths: TERM },
})).json.id;
const drifty = (await call('/api/accounts', {
  method: 'POST',
  body: { name: 'Control Note', type: 'loan', startingBalance: -OWED, apr: APR, loanMonths: TERM },
})).json.id;

const acct = async id => (await call('/api/state')).json.accounts.find(a => a.id === id);

const loan0 = await acct(loan);
const PAYMENT = derivedPayment(-loan0.balance, APR, loan0.loanMonths);
check('starting payment is the amortized figure', PAYMENT > 0, `$${(PAYMENT / 100).toFixed(2)}/mo on $30,000`);

// ---------- the reported bug: a plain transfer drags the payment down ----------
await call('/api/transactions', {
  method: 'POST',
  body: {
    accountId: checking, date: '2026-01-15', payee: '', memo: '', amount: -PAYMENT,
    kind: 'transfer', transferAccountId: drifty,
  },
});
const d1 = await acct(drifty);
const driftPayment = derivedPayment(-d1.balance, APR, d1.loanMonths);
check('plain transfer still moves the payment (the original bug)',
  driftPayment < PAYMENT - 100,
  `$${(PAYMENT / 100).toFixed(2)} -> $${(driftPayment / 100).toFixed(2)} after one transfer`);

// ---------- loan payments hold the payment steady ----------
let owed = OWED;
let worst = 0;
let totalInterest = 0;
for (let i = 1; i <= 12; i++) {
  const month = String(i).padStart(2, '0');
  const expectInterest = Math.round(owed * (APR / 100 / 12));
  const r = await call('/api/loan-payment', {
    method: 'POST',
    body: { fromAccountId: checking, loanAccountId: loan, amount: PAYMENT, date: `2026-${month}-15` },
  });
  if (r.status !== 200) { check(`payment ${i} accepted`, false, JSON.stringify(r.json)); break; }
  if (i === 1) {
    check('interest is this month\'s accrual on the balance', r.json.interest === expectInterest,
      `got ${r.json.interest}, expected ${expectInterest}`);
    check('principal is the rest of the payment', r.json.principal === PAYMENT - r.json.interest);
  }
  totalInterest += r.json.interest;
  owed -= r.json.principal;

  const a = await acct(loan);
  const seen = derivedPayment(-a.balance, APR, a.loanMonths);
  worst = Math.max(worst, Math.abs(seen - PAYMENT));
  if (i === 1) {
    check('balance moves by principal, not the full payment', -a.balance === owed,
      `owed ${-a.balance}, expected ${owed}`);
    check('term steps down by one payment', a.loanMonths === TERM - 1);
  }
}

const after = await acct(loan);
check('payment holds steady across 12 payments', worst <= 5,
  `max drift ${worst}c over a year; still $${(derivedPayment(-after.balance, APR, after.loanMonths) / 100).toFixed(2)}/mo`);
check('term reflects 12 payments made', after.loanMonths === TERM - 12, `loanMonths=${after.loanMonths}`);
check('interest accrued is not treated as principal', -after.balance === owed && totalInterest > 0,
  `$${(totalInterest / 100).toFixed(2)} interest kept off the principal`);

// ---------- the ledger still shows what was actually paid ----------
const txns = (await call(`/api/transactions?accountId=${loan}`)).json;
const paid = txns.filter(t => t.interest != null);
check('loan ledger records the full amount paid', paid.length === 12 && paid.every(t => t.amount === PAYMENT),
  `${paid.length} rows at $${(PAYMENT / 100).toFixed(2)}`);
const fromSide = (await call(`/api/transactions?accountId=${checking}`)).json
  .filter(t => t.transfer_account_id === loan);
check('paying account is debited the full amount', fromSide.every(t => t.amount === -PAYMENT));

// ---------- chart history ----------
check('state exposes month-end balances for the chart',
  Array.isArray(after.history) && after.history.length > 0 && after.history.at(-1).balance === -owed,
  `${after.history?.length} points, last ${after.history?.at(-1)?.balance}`);
// payments dated before the starting balance they pay down would otherwise
// accumulate against zero debt and plot the loan above the axis
check('history never plots the loan above zero',
  (after.history ?? []).every(h => h.balance < 0),
  `${(after.history ?? []).filter(h => h.balance >= 0).length} non-debt points`);
check('history is ordered oldest first',
  (after.history ?? []).every((h, i, arr) => i === 0 || arr[i - 1].month < h.month));

// ---------- guards ----------
const tiny = await call('/api/loan-payment', {
  method: 'POST', body: { fromAccountId: checking, loanAccountId: loan, amount: 100, date: '2027-01-15' },
});
check('a payment below the interest is refused', tiny.status === 400, tiny.json?.error);

const toCash = await call('/api/loan-payment', {
  method: 'POST', body: { fromAccountId: checking, loanAccountId: checking, amount: PAYMENT, date: '2027-01-15' },
});
check('the target must be a loan account', toCash.status === 400, toCash.json?.error);

const edit = await call(`/api/transactions/${paid[0].id}`, {
  method: 'PATCH',
  body: { accountId: loan, date: paid[0].date, payee: '', memo: '', amount: 1, kind: 'uncategorized' },
});
check('editing a loan payment is refused rather than silently corrupting it',
  edit.status === 400, edit.json?.error);

// ---------- delete restores both sides ----------
const beforeDel = await acct(loan);
await call(`/api/transactions/${paid[0].id}`, { method: 'DELETE' });
const afterDel = await acct(loan);
check('deleting a payment gives the term back', afterDel.loanMonths === beforeDel.loanMonths + 1);
check('deleting a payment restores the principal',
  -afterDel.balance === -beforeDel.balance + (PAYMENT - paid[0].interest),
  `${-afterDel.balance} vs ${-beforeDel.balance + (PAYMENT - paid[0].interest)}`);
check('deleting removes both sides of the pair',
  (await call(`/api/transactions?accountId=${checking}`)).json.filter(t => t.transfer_account_id === loan).length === 11);

console.log(out.join('\n'));
console.log(out.some(l => l.startsWith('FAIL')) ? '\nFAILED' : '\nAll loan payment checks passed');
