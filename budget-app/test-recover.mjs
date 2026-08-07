// Recover-overassigned test. The mirror of Fund Goals: when more has been
// assigned than exists, take it back starting with the money needed furthest
// out. Ordering is the whole feature, so most of this checks the sequence
// rather than just the total.
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

const EMAIL = 'recover-test@example.com';
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

await call('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: 'recover-test-1' } });

const state = async () => (await call('/api/state')).json;
const MONTH = (await state()).month;
const group = (await call('/api/groups', { method: 'POST', body: { name: 'Plan' } })).json.id;

const mk = async (name, goal) => {
  const id = (await call('/api/categories', { method: 'POST', body: { groupId: group, name } })).json.id;
  if (goal) await call(`/api/categories/${id}`, { method: 'PATCH', body: goal });
  return id;
};
const assign = (id, amount) => call('/api/assign', { method: 'PUT', body: { month: MONTH, categoryId: id, amount } });
const cats = async () => (await state()).groups.flatMap(g => g.categories);
const catById = async id => (await cats()).find(c => c.id === id);
const recover = () => call('/api/auto-assign', { method: 'POST', body: { month: MONTH, mode: 'recover-overassigned' } });

// $1,000 of income to work with
await call('/api/accounts', { method: 'POST', body: { name: 'Checking', type: 'cash', startingBalance: 100000 } });

const weekly = await mk('Coffee', { goal: 2000, goalPeriod: 'weekly' });
const monthly = await mk('Rent', { goal: 20000, goalPeriod: 'monthly' });
const quarterly = await mk('Car reg', { goal: 30000, goalPeriod: 'quarterly' });
const annual = await mk('Insurance', { goal: 120000, goalPeriod: 'annual' });
const noGoal = await mk('Misc', null);

// assign $200 to each: $1,000 of income against $1,000 assigned is exactly flat
for (const id of [weekly, monthly, quarterly, annual, noGoal]) await assign(id, 20000);
check('flat budget leaves nothing to recover', (await state()).readyToAssign === 0);
let r = await recover();
check('recovering when not overassigned is a no-op',
  r.json.recovered === 0 && r.json.categories.length === 0, JSON.stringify(r.json));

// now overassign by $300
await assign(annual, 50000);
check('overassigning shows a negative Ready to Assign', (await state()).readyToAssign === -30000,
  `rta ${(await state()).readyToAssign}`);

r = await recover();
check('recovers exactly the overassignment', r.json.recovered === 30000, `recovered ${r.json.recovered}`);
check('and clears the negative', (await state()).readyToAssign === 0);
check('nothing left short', r.json.shortfall === 0);

// no goal is furthest out, so it goes first; the annual goal is next
check('takes from the goalless category first',
  r.json.categories[0]?.id === noGoal, JSON.stringify(r.json.categories));
check('then from the goal needed furthest out',
  r.json.categories[1]?.id === annual, JSON.stringify(r.json.categories));
check('leaves the weekly goal alone',
  !r.json.categories.some(c => c.id === weekly));
check('leaves rent alone', !r.json.categories.some(c => c.id === monthly));

// ---------- full ordering, with nothing goalless in the way ----------
await assign(noGoal, 0);
for (const [id, amt] of [[weekly, 20000], [monthly, 20000], [quarterly, 20000], [annual, 20000]]) await assign(id, amt);
// $1,000 income, $800 assigned -> assign another $500 to go $300 over
await assign(annual, 70000);
check('set up a $300 overassignment', (await state()).readyToAssign === -30000,
  `rta ${(await state()).readyToAssign}`);
r = await recover();
const order = r.json.categories.map(c => c.id);
check('annual is raided before quarterly', order.indexOf(annual) === 0, JSON.stringify(order));
check('and nothing shorter-dated is touched',
  !order.includes(monthly) && !order.includes(weekly), JSON.stringify(order));

// ---------- by-date goals rank on their real deadline ----------
const shift = (m, n) => {
  const [y, mo] = m.split('-').map(Number);
  const i = y * 12 + (mo - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};
for (const id of [weekly, monthly, quarterly, annual, noGoal]) await assign(id, 0);
const soon = await mk('Laptop', { goal: 50000, goalPeriod: 'by-date', goalDate: `${shift(MONTH, 2)}-01` });
const later = await mk('Holiday', { goal: 50000, goalPeriod: 'by-date', goalDate: `${shift(MONTH, 30)}-01` });
await assign(soon, 40000);
await assign(later, 40000);
await assign(monthly, 40000);
check('set up for by-date ordering', (await state()).readyToAssign === -20000,
  `rta ${(await state()).readyToAssign}`);
r = await recover();
check('the further deadline gives money back first',
  r.json.categories[0]?.id === later, JSON.stringify(r.json.categories));
check('the nearer deadline is untouched',
  !r.json.categories.some(c => c.id === soon), JSON.stringify(r.json.categories));

// ---------- spent money can't be taken back ----------
for (const id of [soon, later, monthly]) await assign(id, 0);
const spent = await mk('Groceries', null);
await assign(spent, 60000);
const acct = (await state()).accounts[0].id;
// spend nearly all of it, so what's left is less than the overassignment and
// the rest genuinely cannot be taken back
for (const amount of [-55000, -72000]) {
  await call('/api/transactions', {
    method: 'POST',
    body: { accountId: acct, date: `${MONTH}-05`, payee: 'Store', memo: '', amount, kind: 'category', categoryId: spent },
  });
}
await assign(spent, 130000);
const before = await state();
const stuck = await catById(spent);
check('overassigned with most of it already spent',
  before.readyToAssign === -30000 && stuck.available === 3000,
  `rta ${before.readyToAssign}, available ${stuck.available}`);
r = await recover();
const after = await catById(spent);
check('takes back only what is still sitting there', r.json.recovered === 3000,
  `recovered ${r.json.recovered}`);
check('never pulls Available below zero', after.available >= 0, `available ${after.available}`);
check('reports the part it could not recover', r.json.shortfall === 27000,
  `short ${r.json.shortfall}`);
check('and leaves Ready to Assign still negative by that much',
  (await state()).readyToAssign === -27000, `rta ${(await state()).readyToAssign}`);

// ---------- guards ----------
check('an unknown mode is still refused',
  (await call('/api/auto-assign', { method: 'POST', body: { month: MONTH, mode: 'nonsense' } })).status === 400);

console.log(out.join('\n'));
console.log(out.some(l => l.startsWith('FAIL')) ? '\nFAILED' : '\nAll recover checks passed');
