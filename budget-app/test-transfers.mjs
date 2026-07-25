// Transfer test: paired inverse transactions stay in lockstep through create,
// edit (either side), destination change, kind change, and delete.
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const EMAIL = 'transfer-test@example.com';
{
  const dp = p => fileURLToPath(new URL(`./server/data/${p}`, import.meta.url));
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

await call('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: 'transfer-test-1' } });

const mk = async (name, startingBalance = 0) =>
  (await call('/api/accounts', { method: 'POST', body: { name, type: 'cash', startingBalance } })).json.id;
const A = await mk('Alpha Checking', 100000);
const B = await mk('Beta Savings');
const C = await mk('Gamma Savings');

const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const balances = async () => {
  const s = (await call(`/api/state?month=${month}`)).json;
  return {
    A: s.accounts.find(a => a.id === A).balance,
    B: s.accounts.find(a => a.id === B).balance,
    C: s.accounts.find(a => a.id === C).balance,
    rta: s.readyToAssign,
  };
};
const txnsOf = async acct => (await call(`/api/transactions?accountId=${acct}`)).json;

// ---------- validation ----------
let r = await call('/api/transactions', { method: 'POST', body: { accountId: A, date: today, amount: -25000, kind: 'transfer' } });
check('transfer without destination rejected', r.status === 400, r.json?.error);
r = await call('/api/transactions', { method: 'POST', body: { accountId: A, date: today, amount: -25000, kind: 'transfer', transferAccountId: A } });
check('transfer to same account rejected', r.status === 400, r.json?.error);

// ---------- create ----------
r = await call('/api/transactions', { method: 'POST', body: { accountId: A, date: today, amount: -25000, kind: 'transfer', transferAccountId: B, memo: 'monthly move' } });
check('transfer created', r.status === 200);
const primaryId = r.json.id;

let aTxns = await txnsOf(A);
let bTxns = await txnsOf(B);
const primary = aTxns.find(t => t.id === primaryId);
const mirror = bTxns.find(t => t.transfer_pair_id === primaryId);
check('mirror exists with inverse amount', mirror?.amount === 25000, `mirror amount ${mirror?.amount}`);
check('pair linked both ways', primary?.transfer_pair_id === mirror?.id && mirror?.transfer_account_id === A);
check('mirror shows source account name', mirror?.transfer_account_name === 'Alpha Checking');
check('mirror copies memo/date/cleared', mirror?.memo === 'monthly move' && mirror?.date === today && mirror?.cleared === 1);

let b = await balances();
check('balances moved', b.A === 75000 && b.B === 25000, JSON.stringify(b));
check('transfer is budget-neutral', b.rta === 100000, `rta ${b.rta}`);

// ---------- edit amount ----------
r = await call(`/api/transactions/${primaryId}`, { method: 'PATCH', body: { accountId: A, date: today, amount: -30000, kind: 'transfer', transferAccountId: B, memo: 'monthly move' } });
check('edit amount', r.status === 200);
bTxns = await txnsOf(B);
check('mirror amount follows edit', bTxns.find(t => t.transfer_pair_id === primaryId)?.amount === 30000);

// ---------- change destination ----------
r = await call(`/api/transactions/${primaryId}`, { method: 'PATCH', body: { accountId: A, date: today, amount: -30000, kind: 'transfer', transferAccountId: C, memo: 'monthly move' } });
check('destination changed', r.status === 200);
b = await balances();
check('mirror moved to new account', b.B === 0 && b.C === 30000, JSON.stringify(b));

// ---------- edit from the mirror side ----------
const mirrorId = (await txnsOf(C)).find(t => t.transfer_pair_id === primaryId)?.id;
r = await call(`/api/transactions/${mirrorId}`, { method: 'PATCH', body: { accountId: C, date: today, amount: 35000, kind: 'transfer', transferAccountId: A, memo: 'monthly move' } });
check('mirror side editable', r.status === 200);
aTxns = await txnsOf(A);
check('primary follows mirror edit', aTxns.find(t => t.id === primaryId)?.amount === -35000,
  `primary now ${aTxns.find(t => t.id === primaryId)?.amount}`);

// ---------- convert away from transfer ----------
r = await call(`/api/transactions/${primaryId}`, { method: 'PATCH', body: { accountId: A, date: today, amount: -35000, kind: 'uncategorized', payee: 'Now a purchase' } });
check('converted to non-transfer', r.status === 200);
check('mirror deleted on conversion', (await txnsOf(C)).every(t => t.transfer_pair_id !== primaryId));
aTxns = await txnsOf(A);
check('pair link cleared', aTxns.find(t => t.id === primaryId)?.transfer_pair_id == null);

// ---------- convert back ----------
r = await call(`/api/transactions/${primaryId}`, { method: 'PATCH', body: { accountId: A, date: today, amount: -35000, kind: 'transfer', transferAccountId: B } });
check('converted back to transfer', r.status === 200);
check('mirror recreated', (await txnsOf(B)).some(t => t.transfer_pair_id === primaryId));

// ---------- delete removes both ----------
await call(`/api/transactions/${primaryId}`, { method: 'DELETE' });
check('delete removes both sides',
  (await txnsOf(A)).every(t => t.id !== primaryId) && (await txnsOf(B)).every(t => t.transfer_pair_id !== primaryId));
b = await balances();
check('balances restored after delete', b.A === 100000 && b.B === 0 && b.C === 0, JSON.stringify(b));

console.log(out.join('\n'));
