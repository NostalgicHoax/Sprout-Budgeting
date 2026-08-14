// Sync matching test. Bank feeds lag: the two halves of a payment can arrive a
// day or more apart, and people record the payment by hand in the meantime.
// Without matching, the import lands a second copy of a transaction the user
// already entered, and the account reads double.
//
// Matching is on (account, exact amount, nearby date) against rows that carry no
// external id. Everything the user decided — category, memo, payee, the other
// half of a transfer — survives; only the bank's identity and cleared state are
// taken on.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const API = 'http://localhost:3178';
const BRIDGE_PORT = 3183;
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

const secs = iso => Math.floor(new Date(`${iso}T12:00:00Z`).getTime() / 1000);
const iso = d => d.toISOString().slice(0, 10);
const shiftDay = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const TODAY = iso(new Date());

// the bridge serves whatever the test puts here
let checkingTxns = [];
let cardTxns = [];
let claimed = false;

function payload(balancesOnly) {
  return {
    errors: [],
    accounts: [
      {
        org: { name: 'Mock Bank', domain: 'mock.example' },
        id: 'ext-check', name: 'Checking', currency: 'USD',
        balance: '1000.00', 'balance-date': secs(TODAY),
        transactions: balancesOnly ? [] : checkingTxns,
      },
      {
        org: { name: 'Mock Bank', domain: 'mock.example' },
        id: 'ext-card', name: 'Card', currency: 'USD',
        balance: '-200.00', 'balance-date': secs(TODAY),
        transactions: balancesOnly ? [] : cardTxns,
      },
    ],
  };
}

const bridge = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
  if (req.method === 'POST' && u.pathname === '/claim/tok-match') {
    if (claimed) { res.statusCode = 403; res.end('already claimed'); return; }
    claimed = true;
    res.end(`http://match-user:match-pass@127.0.0.1:${BRIDGE_PORT}/simplefin`);
    return;
  }
  if (u.pathname === '/simplefin/accounts') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload(u.searchParams.get('balances-only') === '1')));
    return;
  }
  res.statusCode = 404; res.end('nope');
});
await new Promise(r => bridge.listen(BRIDGE_PORT, '127.0.0.1', r));

const EMAIL = 'sync-match-test@example.com';
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

await call('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: 'sync-match-1' } });

const checking = (await call('/api/accounts', { method: 'POST', body: { name: 'Checking', type: 'cash' } })).json.id;
const card = (await call('/api/accounts', { method: 'POST', body: { name: 'Card', type: 'credit' } })).json.id;

const token = Buffer.from(`http://127.0.0.1:${BRIDGE_PORT}/claim/tok-match`).toString('base64');
const conn = (await call('/api/connections', { method: 'POST', body: { token } })).json;
const connId = conn?.id;
check('bridge connection claimed', connId != null, JSON.stringify(conn));
await call(`/api/accounts/${checking}/link`, { method: 'POST', body: { connectionId: connId, externalId: 'ext-check' } });
await call(`/api/accounts/${card}/link`, { method: 'POST', body: { connectionId: connId, externalId: 'ext-card' } });

const sync = () => call('/api/sync', { method: 'POST', body: { connectionId: connId } });
const rows = async id => (await call(`/api/transactions?accountId=${id}`)).json;

// ---------- the reported case: user records the payment before the bank does ----------
// they pay the card by hand, which writes both halves
await call('/api/transactions', {
  method: 'POST',
  body: {
    accountId: checking, date: shiftDay(TODAY, -2), payee: '', memo: 'card payment',
    amount: -25000, kind: 'transfer', transferAccountId: card,
  },
});
const beforeCount = (await rows(checking)).length;
check('the manual payment wrote one row on checking', beforeCount === 1, `${beforeCount} rows`);

// two days later the bank reports the same outflow
checkingTxns = [{ id: 'bank-pay', posted: secs(TODAY), amount: '-250.00', description: 'CARD PAYMENT ACH' }];
let r = await sync();
check('sync reports it as matched, not imported',
  r.json.matched === 1 && r.json.imported === 0,
  `imported ${r.json.imported}, matched ${r.json.matched}`);

const after = await rows(checking);
check('no duplicate appears', after.length === 1, `${after.length} rows`);
const adopted = after[0];
check('the manual row took on the bank id', adopted.external_id === 'bank-pay', `${adopted.external_id}`);
check('and kept the memo the user typed', adopted.memo === 'card payment', adopted.memo);
check('and is still half of the transfer', !!adopted.is_transfer && adopted.transfer_account_id === card);
check('the other half is untouched', (await rows(card)).some(t => t.transfer_pair_id === adopted.id));

// ---------- a second sync updates rather than matching again ----------
r = await sync();
check('re-syncing the same transaction updates it',
  r.json.updated === 1 && r.json.matched === 0 && r.json.imported === 0,
  JSON.stringify({ i: r.json.imported, u: r.json.updated, m: r.json.matched }));
check('still exactly one row', (await rows(checking)).length === 1);

// ---------- an unmatched transaction still imports ----------
checkingTxns = [
  { id: 'bank-pay', posted: secs(TODAY), amount: '-250.00', description: 'CARD PAYMENT ACH' },
  { id: 'bank-new', posted: secs(TODAY), amount: '-31.50', description: 'Hardware Store' },
];
r = await sync();
check('something with no counterpart is imported normally', r.json.imported === 1, `imported ${r.json.imported}`);
check('checking now has two rows', (await rows(checking)).length === 2);

// ---------- the amount has to be exact ----------
await call('/api/transactions', {
  method: 'POST',
  body: { accountId: checking, date: TODAY, payee: 'Cafe', memo: '', amount: -1200, kind: 'uncategorized' },
});
checkingTxns.push({ id: 'bank-near', posted: secs(TODAY), amount: '-12.01', description: 'Cafe' });
r = await sync();
check('a cent out is not a match', r.json.imported === 1 && r.json.matched === 0,
  `imported ${r.json.imported}, matched ${r.json.matched}`);

// ---------- and the date has to be close ----------
const far = shiftDay(TODAY, -40);
await call('/api/transactions', {
  method: 'POST',
  body: { accountId: checking, date: far, payee: 'Old thing', memo: '', amount: -7700, kind: 'uncategorized' },
});
checkingTxns.push({ id: 'bank-far', posted: secs(TODAY), amount: '-77.00', description: 'Old thing' });
r = await sync();
check('a matching amount far away in time is not a match',
  r.json.imported === 1 && r.json.matched === 0,
  `imported ${r.json.imported}, matched ${r.json.matched}`);

// ---------- one bank row cannot steal another's match ----------
const dupDate = shiftDay(TODAY, -1);
for (let i = 0; i < 2; i++) {
  await call('/api/transactions', {
    method: 'POST',
    body: { accountId: checking, date: dupDate, payee: 'Twice', memo: `copy ${i}`, amount: -4200, kind: 'uncategorized' },
  });
}
checkingTxns.push(
  { id: 'bank-dup-1', posted: secs(TODAY), amount: '-42.00', description: 'Twice' },
  { id: 'bank-dup-2', posted: secs(TODAY), amount: '-42.00', description: 'Twice' },
);
r = await sync();
check('two identical bank rows match the two manual rows, one each',
  r.json.matched === 2 && r.json.imported === 0,
  `imported ${r.json.imported}, matched ${r.json.matched}`);
const twice = (await rows(checking)).filter(t => t.payee === 'Twice' || t.memo?.startsWith('copy'));
check('and each carries a different bank id',
  new Set(twice.map(t => t.external_id)).size === 2 && twice.every(t => t.external_id),
  JSON.stringify(twice.map(t => t.external_id)));

// ---------- pending state comes from the bank ----------
checkingTxns.push({ id: 'bank-pending', posted: secs(TODAY), amount: '-15.00', description: 'Pending Thing', pending: true });
await call('/api/transactions', {
  method: 'POST',
  body: { accountId: checking, date: TODAY, payee: 'Pending Thing', memo: '', amount: -1500, kind: 'uncategorized' },
});
await sync();
const pend = (await rows(checking)).find(t => t.external_id === 'bank-pending');
check('an adopted row takes the bank\'s pending state', pend && !pend.cleared, `cleared ${pend?.cleared}`);

bridge.close();
console.log(out.join('\n'));
console.log(out.some(l => l.startsWith('FAIL')) ? '\nFAILED' : '\nAll sync matching checks passed');
