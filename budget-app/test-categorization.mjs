// Payee → category rules: learning a choice, auto-applying it to synced
// transactions, re-learning when the user switches, and per-payee suggestion
// ordering. Drives the real API; bank import goes through a mock SimpleFIN
// bridge so the sync path is exercised end to end.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { payeeKey } from './shared/payee-key.js';

const API = 'http://localhost:3178';
const BRIDGE_PORT = 3181;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

// ---------- mock SimpleFIN bridge ----------
// phase 1 has nothing to import; each later phase adds one transaction whose
// payee the test has already taught the app about
let phase = 0;
let claimed = false;
const days = n => Math.floor(Date.now() / 1000) - n * 86400;
const feed = [
  { id: 'c1', posted: days(4), amount: '-31.40', description: 'KROGER #452' },
  { id: 'c2', posted: days(3), amount: '-18.20', description: 'kroger' },
  { id: 'c3', posted: days(2), amount: '-27.75', description: 'Unknown Merchant' },
];
function bridgeAccounts(balancesOnly) {
  return {
    errors: [],
    accounts: [{
      org: { name: 'Rule Bank', domain: 'rule.example' },
      id: 'ext-rule', name: 'Rule Checking', currency: 'USD',
      balance: '1000.00', 'balance-date': days(0),
      transactions: balancesOnly ? [] : feed.slice(0, phase),
    }],
  };
}

const bridge = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
  if (req.method === 'POST' && u.pathname === '/claim/tok-rule') {
    if (claimed) { res.statusCode = 403; res.end('token already claimed'); return; }
    claimed = true;
    res.end(`http://rule-user:rule-pass@127.0.0.1:${BRIDGE_PORT}/simplefin`);
    return;
  }
  const m = u.pathname.match(/^\/phase\/(\d+)$/);
  if (req.method === 'POST' && m) { phase = Number(m[1]); res.end('ok'); return; }
  if (u.pathname === '/simplefin/accounts') {
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

const EMAIL = 'rules-test@example.com';

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

// ---------- normalization (pure, no server needed) ----------
check('store numbers normalize away', payeeKey('KROGER #452') === payeeKey('Kroger'));
check('punctuation and case normalize away', payeeKey("McDonald's") === payeeKey('MCDONALDS'));
check('distinct payees stay distinct', payeeKey('Kroger') !== payeeKey('Krogers Deli'));
check('blank payee has no key', payeeKey('   ') === '');

// ---------- setup ----------
let r = await call('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: 'rules-test-pass-1' } });
check('register throwaway', r.status === 200);

r = await call('/api/accounts', { method: 'POST', body: { name: 'Rule Checking', type: 'cash' } });
const acctId = r.json?.id;

r = await call('/api/groups', { method: 'POST', body: { name: 'Rule Test' } });
const groupId = r.json?.id;
const mkCat = async name => (await call('/api/categories', { method: 'POST', body: { groupId, name } })).json.id;
const groceries = await mkCat('Groceries');
const restaurants = await mkCat('Restaurants');
const fun = await mkCat('Fun Money');
check('fixtures created', !!acctId && !!groceries && !!restaurants && !!fun);

const addTxn = (payee, categoryId, amount = -1000) => call('/api/transactions', {
  method: 'POST',
  body: { accountId: acctId, date: '2026-07-10', payee, amount, kind: 'category', categoryId },
});
const memoryFor = async payee => {
  const res = await call('/api/payee-categories');
  return res.json.find(e => e.key === payeeKey(payee)) ?? null;
};

// ---------- learning ----------
r = await call('/api/payee-categories');
check('memory starts empty', Array.isArray(r.json) && r.json.length === 0, JSON.stringify(r.json));

await addTxn('Kroger', groceries);
let mem = await memoryFor('Kroger');
check('one categorized transaction creates a rule', mem?.rule === groceries, JSON.stringify(mem));

r = await addTxn('Chipotle', restaurants);
mem = await memoryFor('Chipotle');
check('rules are per payee', mem?.rule === restaurants && (await memoryFor('Kroger')).rule === groceries);

// income and transfers have no category and must not create rules
await call('/api/transactions', {
  method: 'POST',
  body: { accountId: acctId, date: '2026-07-10', payee: 'Employer', amount: 200000, kind: 'income' },
});
check('income creates no rule', (await memoryFor('Employer')) === null);

// ---------- auto-apply on bank sync ----------
const token = Buffer.from(`http://127.0.0.1:${BRIDGE_PORT}/claim/tok-rule`).toString('base64');
r = await call('/api/connections', { method: 'POST', body: { token } });
const connId = r.json?.id;
r = await call(`/api/accounts/${acctId}/link`, {
  method: 'POST',
  body: { connectionId: connId, externalId: 'ext-rule', adjustBalance: false },
});
check('linked with nothing to import', r.status === 200 && r.json.imported === 0, JSON.stringify(r.json));

await fetch(`http://127.0.0.1:${BRIDGE_PORT}/phase/3`, { method: 'POST' });
r = await call('/api/sync', { method: 'POST', body: {} });
check('sync imported the feed', r.json?.imported === 3, JSON.stringify(r.json));

r = await call(`/api/transactions?accountId=${acctId}`);
const byExt = id => r.json.find(t => t.external_id === id);
check('synced transaction adopts the payee rule', byExt('c1')?.category_id === groceries,
  `got ${byExt('c1')?.category_name}`);
check('rule matches despite the store number', byExt('c1')?.payee === 'KROGER #452');
check('rule matches a differently-cased payee', byExt('c2')?.category_id === groceries);
check('unknown payee stays uncategorized', byExt('c3')?.category_id === null,
  `got ${byExt('c3')?.category_name}`);

// auto-applied categories are not user choices, so they must not inflate counts
mem = await memoryFor('Kroger');
check('auto-apply does not re-learn on its own', mem?.suggestions.length === 1 && mem.rule === groceries,
  JSON.stringify(mem));

// ---------- switching the category re-teaches the rule ----------
const c1 = byExt('c1');
r = await call(`/api/transactions/${c1.id}`, {
  method: 'PATCH',
  body: {
    accountId: acctId, date: c1.date, payee: c1.payee, amount: c1.amount,
    kind: 'category', categoryId: restaurants,
  },
});
check('recategorize succeeds', r.status === 200, JSON.stringify(r.json));
mem = await memoryFor('Kroger');
check('switching category moves the rule', mem?.rule === restaurants, JSON.stringify(mem));
check('the old category is still remembered', mem?.suggestions.includes(groceries));

// manual entry is the user's call: the editor offers the rule, but a saved
// "Uncategorized" must survive the round trip
r = await call('/api/transactions', {
  method: 'POST',
  body: { accountId: acctId, date: '2026-07-12', payee: 'Kroger', amount: -500, kind: 'uncategorized' },
});
const manualId = r.json?.id;
r = await call(`/api/transactions?accountId=${acctId}`);
check('an explicit uncategorized choice is respected',
  r.json.find(t => t.id === manualId)?.category_id === null,
  `got ${r.json.find(t => t.id === manualId)?.category_name}`);

// ---------- suggestion ordering ----------
// groceries pulls ahead on count; restaurants stays the (most recent) rule
await addTxn('Kroger', groceries);
await addTxn('Kroger', groceries);
mem = await memoryFor('Kroger');
check('suggestions rank by how often a category was picked', mem?.suggestions[0] === groceries,
  JSON.stringify(mem));
check('most recent pick becomes the rule again', mem?.rule === groceries);

await addTxn('Kroger', fun);
mem = await memoryFor('Kroger');
check('suggestions cover every category used for the payee', mem?.suggestions.length === 3);

await addTxn('Kroger', await mkCat('Fourth Category'));
mem = await memoryFor('Kroger');
check('suggestions cap at three', mem?.suggestions.length === 3, `got ${mem?.suggestions.length}`);

// ---------- category deletion cleans up ----------
const doomed = await mkCat('Doomed');
await addTxn('One Off Shop', doomed);
check('rule exists before delete', (await memoryFor('One Off Shop'))?.rule === doomed);
r = await call(`/api/transactions?accountId=${acctId}`);
const doomedTxn = r.json.find(t => t.category_id === doomed);
await call(`/api/transactions/${doomedTxn.id}`, { method: 'DELETE' });
r = await call(`/api/categories/${doomed}`, { method: 'DELETE' });
check('category deleted', r.status === 200, JSON.stringify(r.json));
check('deleting a category drops its rules', (await memoryFor('One Off Shop')) === null);

bridge.close();
console.log(results.join('\n'));
