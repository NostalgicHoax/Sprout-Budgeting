// Bank-sync test: spins up a mock SimpleFIN bridge and drives the full flow
// through the real API — claim, link (with balance alignment), import, dedupe,
// pending -> posted updates, unlink, delete.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'http://localhost:3178';
const BRIDGE_PORT = 3179;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

// ---------- mock SimpleFIN bridge ----------
let phase = 1;
let claimed = false;
const days = n => Math.floor(Date.now() / 1000) - n * 86400;
function bridgeAccounts(balancesOnly) {
  const checkingTxns = [
    { id: 't1', posted: days(3), amount: '-12.34', description: 'Coffee Shop' },
    { id: 't2', posted: days(2), amount: '-45.00', description: 'Grocery Store' },
    { id: 't3', posted: days(1), amount: '-9.99', description: 'Streaming Service', pending: phase === 1 },
    ...(phase >= 2 ? [{ id: 't5', posted: days(0), amount: '-20.00', description: 'Gas Station' }] : []),
  ];
  const savingsTxns = [
    { id: 't4', posted: days(2), amount: '100.00', description: 'Interest Payment' },
  ];
  return {
    errors: [],
    accounts: [
      {
        org: { name: 'Mock Bank', domain: 'mock.example' },
        id: 'ext-check', name: 'Everyday Checking', currency: 'USD',
        balance: phase >= 2 ? '1480.00' : '1500.00',
        'balance-date': days(0),
        transactions: balancesOnly ? [] : checkingTxns,
      },
      {
        org: { name: 'Mock Bank', domain: 'mock.example' },
        id: 'ext-save', name: 'Rainy Day Savings', currency: 'USD',
        balance: '2500.00',
        'balance-date': days(0),
        transactions: balancesOnly ? [] : savingsTxns,
      },
    ],
  };
}

const bridge = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
  if (req.method === 'POST' && u.pathname === '/claim/tok-abc') {
    if (claimed) { res.statusCode = 403; res.end('token already claimed'); return; }
    claimed = true;
    res.end(`http://sync-user:sync-pass@127.0.0.1:${BRIDGE_PORT}/simplefin`);
    return;
  }
  if (req.method === 'POST' && u.pathname === '/phase/2') { phase = 2; res.end('ok'); return; }
  if (u.pathname === '/simplefin/accounts') {
    const auth = req.headers.authorization ?? '';
    const expected = 'Basic ' + Buffer.from('sync-user:sync-pass').toString('base64');
    if (auth !== expected) { res.statusCode = 403; res.end('bad auth'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(bridgeAccounts(u.searchParams.get('balances-only') === '1')));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});
await new Promise(r => bridge.listen(BRIDGE_PORT, '127.0.0.1', r));

// ---------- api helper with cookie ----------
let cookie = null;
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const EMAIL = 'sync-test@example.com';

// idempotent pre-clean
{
  const dataPath = p => fileURLToPath(new URL(`./server/data/${p}`, import.meta.url));
  const sysdb = new DatabaseSync(dataPath('system.db'));
  const old = sysdb.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL);
  if (old) {
    const budgets = sysdb.prepare('SELECT file FROM budgets WHERE user_id = ?').all(old.id);
    sysdb.prepare('DELETE FROM sessions WHERE user_id = ?').run(old.id);
    sysdb.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(old.id);
    sysdb.prepare('DELETE FROM budgets WHERE user_id = ?').run(old.id);
    sysdb.prepare('DELETE FROM users WHERE id = ?').run(old.id);
    for (const b of budgets) {
      if (b.file === 'budget.db') continue;
      for (const s of ['', '-wal', '-shm']) { try { rmSync(dataPath(b.file + s)); } catch {} }
    }
  }
  sysdb.close();
}

// ---------- flow ----------
let r = await call('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: 'sync-test-pass-1' } });
check('register throwaway', r.status === 200);

r = await call('/api/accounts', { method: 'POST', body: { name: 'Sync Checking', type: 'cash' } });
const checkingId = r.json?.id;
r = await call('/api/accounts', { method: 'POST', body: { name: 'Sync Savings', type: 'cash' } });
const savingsId = r.json?.id;
check('created two accounts', !!checkingId && !!savingsId);

const token = Buffer.from(`http://127.0.0.1:${BRIDGE_PORT}/claim/tok-abc`).toString('base64');
r = await call('/api/connections', { method: 'POST', body: { token } });
check('connection claimed', r.status === 200 && r.json.name === 'Mock Bank', JSON.stringify(r.json?.name));
const connId = r.json?.id;
check('external accounts listed with balances', r.json?.accounts?.length === 2 && r.json.accounts[0].balance === 150000);

r = await call('/api/connections', { method: 'POST', body: { token } });
check('reused token rejected', r.status === 400, r.json?.error);

r = await call(`/api/accounts/${checkingId}/link`, {
  method: 'POST',
  body: { connectionId: connId, externalId: 'ext-check', bankBalance: 150000 },
});
check('link checking imports history', r.status === 200 && r.json.imported === 3, JSON.stringify(r.json));
check('balance adjustment aligns to bank', r.json?.adjustment === 150000 + 6733, `adjustment ${r.json?.adjustment}`);

r = await call(`/api/accounts/${savingsId}/link`, {
  method: 'POST',
  body: { connectionId: connId, externalId: 'ext-save', bankBalance: 250000 },
});
check('link savings imports history', r.status === 200 && r.json.imported === 1);

r = await call('/api/state?month=2026-07');
const acctById = id => r.json.accounts.find(a => a.id === id);
check('checking balance matches bank', acctById(checkingId)?.balance === 150000, `${acctById(checkingId)?.balance}`);
check('savings balance matches bank', acctById(savingsId)?.balance === 250000);
check('state exposes connection', r.json.connections?.length === 1 && r.json.connections[0].lastSyncStatus === 'ok');
check('account exposes link', acctById(checkingId)?.connectionId === connId);

r = await call(`/api/transactions?accountId=${checkingId}`);
const pending = r.json.find(t => t.external_id === 't3');
check('pending transaction imported uncleared', pending?.cleared === 0);
check('payee mapped from description', r.json.some(t => t.payee === 'Coffee Shop'));

// second sync: t5 appears, t3 posts
await fetch(`http://127.0.0.1:${BRIDGE_PORT}/phase/2`, { method: 'POST' });
r = await call('/api/sync', { method: 'POST', body: {} });
check('incremental sync imports only new', r.json?.imported === 1, JSON.stringify(r.json));
check('resync updates known transactions', r.json?.updated === 4);

r = await call(`/api/transactions?accountId=${checkingId}`);
check('no duplicates after resync', r.json.filter(t => t.external_id).length === 4, `${r.json.filter(t => t.external_id).length} external txns`);
check('pending transaction now cleared', r.json.find(t => t.external_id === 't3')?.cleared === 1);

r = await call('/api/state?month=2026-07');
check('balance reflects new transaction', acctById.call && r.json.accounts.find(a => a.id === checkingId)?.balance === 148000,
  `${r.json.accounts.find(a => a.id === checkingId)?.balance}`);

// stale gate: a sync that just ran is skipped with ifStaleHours
r = await call('/api/sync', { method: 'POST', body: { ifStaleHours: 6 } });
check('fresh connection skipped by stale gate', r.json?.synced === 0);

r = await call(`/api/accounts/${savingsId}/unlink`, { method: 'POST', body: {} });
r = await call('/api/state?month=2026-07');
check('unlink clears account link', r.json.accounts.find(a => a.id === savingsId)?.connectionId === null);

r = await call(`/api/connections/${connId}`, { method: 'DELETE' });
r = await call('/api/state?month=2026-07');
check('delete connection unlinks all', r.json.connections.length === 0 &&
  r.json.accounts.every(a => a.connectionId == null));

bridge.close();
console.log(results.join('\n'));
