// Goal period test. A goal is an amount per period, but the budget works a
// month at a time, so every cadence has to resolve to a monthly figure that
// Fund Goals, the progress bar and "Goal met" can all read the same way.
//
// The subtle one is by-date: `goal` means "Available this category should hold
// by month end", not "this month's instalment". Fund Goals assigns the gap
// between goal and Available, so returning an instalment would count it against
// savings that already exist.
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

const EMAIL = 'goals-test@example.com';
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

await call('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: 'goals-test-1' } });

const state = async () => (await call('/api/state')).json;
const st0 = await state();
const MONTH = st0.month;
const group = (await call('/api/groups', { method: 'POST', body: { name: 'Bills' } })).json.id;

const mkCat = async name =>
  (await call('/api/categories', { method: 'POST', body: { groupId: group, name } })).json.id;
const findCat = async id => (await state()).groups.flatMap(g => g.categories).find(c => c.id === id);
const setGoal = async (id, body) => call(`/api/categories/${id}`, { method: 'PATCH', body });

// ---------- each cadence resolves to a monthly figure ----------
const cases = [
  { period: 'monthly', amount: 10000, expect: 10000, label: '$100 monthly -> $100' },
  { period: 'quarterly', amount: 30000, expect: 10000, label: '$300 quarterly -> $100' },
  { period: 'biannual', amount: 60000, expect: 10000, label: '$600 half-yearly -> $100' },
  { period: 'annual', amount: 120000, expect: 10000, label: '$1200 annually -> $100' },
  // 52 weeks over 12 months, not 4 weeks a month — otherwise a weekly goal
  // silently under-funds by about 8% a year
  { period: 'weekly', amount: 5000, expect: 21667, label: '$50 weekly -> $216.67' },
];
for (const c of cases) {
  const id = await mkCat(`Cat ${c.period}`);
  const r = await setGoal(id, { goal: c.amount, goalPeriod: c.period });
  if (r.status !== 200) { check(c.label, false, JSON.stringify(r.json)); continue; }
  const cat = await findCat(id);
  check(c.label, cat.goal === c.expect, `got ${cat.goal}, expected ${c.expect}`);
}

// ---------- custom cadences ----------
const custom2m = await mkCat('Every 2 months');
await setGoal(custom2m, { goal: 40000, goalPeriod: 'custom', goalEvery: 2, goalUnit: 'month' });
check('$400 every 2 months -> $200', (await findCat(custom2m)).goal === 20000,
  `got ${(await findCat(custom2m)).goal}`);

const custom3w = await mkCat('Every 3 weeks');
await setGoal(custom3w, { goal: 6000, goalPeriod: 'custom', goalEvery: 3, goalUnit: 'week' });
// 3 weeks = 3 * 12/52 months, so $60 per 3 weeks is $86.67 a month
check('$60 every 3 weeks -> $86.67', (await findCat(custom3w)).goal === 8667,
  `got ${(await findCat(custom3w)).goal}`);

// ---------- by-date ----------
const shift = (m, n) => {
  const [y, mo] = m.split('-').map(Number);
  const i = y * 12 + (mo - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};
const byDate = await mkCat('Trip fund');
await setGoal(byDate, { goal: 240000, goalPeriod: 'by-date', goalDate: `${shift(MONTH, 3)}-01` });
let c = await findCat(byDate);
// 4 months counting this one, nothing saved yet
check('$2400 by 3 months out asks $600 now', c.goal === 60000, `got ${c.goal}`);

// fund it, and the target should track what's saved plus the next instalment
await call('/api/assign', { method: 'PUT', body: { month: MONTH, categoryId: byDate, amount: 60000 } });
c = await findCat(byDate);
check('by-date target counts what is already saved', c.goal === 60000 && c.available === 60000,
  `goal ${c.goal}, available ${c.available}`);
check('and reports itself met once funded for the month', c.available >= c.goal);

// falling behind raises the ask rather than hiding it
const behind = await mkCat('Behind fund');
await setGoal(behind, { goal: 120000, goalPeriod: 'by-date', goalDate: `${shift(MONTH, 1)}-01` });
c = await findCat(behind);
check('a nearer deadline asks for more', c.goal === 60000, `got ${c.goal}`);

const dueNow = await mkCat('Due now');
await setGoal(dueNow, { goal: 50000, goalPeriod: 'by-date', goalDate: `${MONTH}-28` });
check('a goal due this month asks for all of it', (await findCat(dueNow)).goal === 50000,
  `got ${(await findCat(dueNow)).goal}`);

// ---------- Fund Goals uses the monthly figure, not the period amount ----------
const fundCat = await mkCat('Annual insurance');
await setGoal(fundCat, { goal: 120000, goalPeriod: 'annual' });
const income = (await call('/api/accounts', {
  method: 'POST', body: { name: 'Checking', type: 'cash', startingBalance: 500000 },
})).json.id;
check('account created for funding', income != null);
await call('/api/auto-assign', { method: 'POST', body: { month: MONTH, mode: 'fund-goals' } });
c = await findCat(fundCat);
check('Fund Goals assigns the monthly share, not the year',
  c.assigned === 10000, `assigned ${c.assigned}`);

// by-date should be funded to its running target, not double-counted
const fundByDate = await findCat(byDate);
check('Fund Goals leaves a by-date goal already met alone',
  fundByDate.assigned === 60000, `assigned ${fundByDate.assigned}`);

// ---------- validation ----------
check('an unknown period is refused',
  (await setGoal(fundCat, { goal: 1000, goalPeriod: 'fortnightly' })).status === 400);
check('custom needs a unit',
  (await setGoal(fundCat, { goal: 1000, goalPeriod: 'custom', goalEvery: 2, goalUnit: 'decade' })).status === 400);
check('custom needs a sane count',
  (await setGoal(fundCat, { goal: 1000, goalPeriod: 'custom', goalEvery: 0, goalUnit: 'month' })).status === 400);
check('by-date needs a date',
  (await setGoal(fundCat, { goal: 1000, goalPeriod: 'by-date' })).status === 400);

// ---------- clearing and switching ----------
await setGoal(custom3w, { goal: null });
c = await findCat(custom3w);
check('clearing the amount clears the goal', c.goal === 0 && c.goalPeriod == null,
  `goal ${c.goal}, period ${c.goalPeriod}`);

await setGoal(custom2m, { goal: 40000, goalPeriod: 'annual' });
c = await findCat(custom2m);
check('switching off custom drops its leftover fields',
  c.goalEvery == null && c.goalUnit == null, `every ${c.goalEvery}, unit ${c.goalUnit}`);

// ---------- goals set before periods existed ----------
const legacy = await mkCat('Legacy');
await setGoal(legacy, { goal: 7500 });
c = await findCat(legacy);
check('an amount with no period is treated as monthly',
  c.goal === 7500 && c.goalPeriod === 'monthly', `goal ${c.goal}, period ${c.goalPeriod}`);


// ---------- funding a goal and then spending it still counts ----------
// Reported from a real budget: a $20 monthly gym goal, funded with $20 and then
// spent, read "$0 of $20" and asked for another $20. Progress was measured
// against Available, which spending drains.
const gym = await mkCat('Gym');
await setGoal(gym, { goal: 2000, goalPeriod: 'monthly' });
const cash = (await call('/api/accounts', {
  method: 'POST', body: { name: 'Wallet', type: 'cash', startingBalance: 500000 },
})).json.id;
await call('/api/assign', { method: 'PUT', body: { month: MONTH, categoryId: gym, amount: 2000 } });
c = await findCat(gym);
check('a funded goal reads as funded before spending', c.goal === 2000 && c.funded === 2000 && c.funded >= c.goal,
  `funded ${c.funded}, goal ${c.goal}`);

await call('/api/transactions', {
  method: 'POST',
  body: { accountId: cash, date: `${MONTH}-10`, payee: 'Gym', memo: '', amount: -2000, kind: 'category', categoryId: gym },
});
c = await findCat(gym);
check('spending it empties Available', c.available === 0, `available ${c.available}`);
check('but the goal still counts as funded', c.goal === 2000 && c.funded === 2000 && c.funded >= c.goal,
  `funded ${c.funded}, goal ${c.goal}`);

await call('/api/auto-assign', { method: 'POST', body: { month: MONTH, mode: 'fund-goals' } });
c = await findCat(gym);
check('Fund Goals leaves a spent-but-funded goal alone', c.assigned === 2000, `assigned ${c.assigned}`);

const gym2 = await mkCat('Gym Two');
await setGoal(gym2, { goal: 2000, goalPeriod: 'monthly' });
await call('/api/assign', { method: 'PUT', body: { month: MONTH, categoryId: gym2, amount: 800 } });
await call('/api/transactions', {
  method: 'POST',
  body: { accountId: cash, date: `${MONTH}-11`, payee: 'Gym', memo: '', amount: -2000, kind: 'category', categoryId: gym2 },
});
c = await findCat(gym2);
check('a part-funded goal still shows the shortfall', c.funded === 800, `funded ${c.funded}`);

const roll = await mkCat('Rollover');
await setGoal(roll, { goal: 2000, goalPeriod: 'monthly' });
await call('/api/assign', { method: 'PUT', body: { month: shift(MONTH, -1), categoryId: roll, amount: 2000 } });
c = await findCat(roll);
check('carried-over money counts as funded', c.funded === 2000 && c.assigned === 0,
  `funded ${c.funded}, assigned ${c.assigned}`);

const pot = await mkCat('Trip pot');
await setGoal(pot, { goal: 100000, goalPeriod: 'by-date', goalDate: `${shift(MONTH, 4)}-01` });
await call('/api/assign', { method: 'PUT', body: { month: MONTH, categoryId: pot, amount: 20000 } });
const beforeSpend = (await findCat(pot)).funded;
await call('/api/transactions', {
  method: 'POST',
  body: { accountId: cash, date: `${MONTH}-12`, payee: 'Flights', memo: '', amount: -20000, kind: 'category', categoryId: pot },
});
c = await findCat(pot);
check('spending a by-date pot does reduce it', c.funded === 0 && beforeSpend === 20000,
  `before ${beforeSpend}, after ${c.funded}`);

// ---------- start the month over ----------
const beforeReset = await state();
const totalAssigned = beforeReset.groups.flatMap(g => g.categories).reduce((s, x) => s + x.assigned, 0);
const r2 = await call('/api/auto-assign', { method: 'POST', body: { month: MONTH, mode: 'reset-assignments' } });
check('reset reports what it handed back', r2.json.returned === totalAssigned,
  `returned ${r2.json.returned}, expected ${totalAssigned}`);
check('and names the categories already spent from', r2.json.spent.length > 0,
  JSON.stringify(r2.json.spent.map(x => x.name)));
const afterReset = await state();
check('every category is back to nothing assigned',
  afterReset.groups.flatMap(g => g.categories).every(x => x.assigned === 0));
check('Ready to Assign gains the whole lot',
  afterReset.readyToAssign === beforeReset.readyToAssign + totalAssigned,
  `${afterReset.readyToAssign} vs ${beforeReset.readyToAssign + totalAssigned}`);
check('resetting an already-clear month is harmless',
  (await call('/api/auto-assign', { method: 'POST', body: { month: MONTH, mode: 'reset-assignments' } })).json.returned === 0);

console.log(out.join('\n'));
console.log(out.some(l => l.startsWith('FAIL')) ? '\nFAILED' : '\nAll goal checks passed');
