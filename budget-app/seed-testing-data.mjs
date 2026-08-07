// Fills a budget with enough realistic history to check every feature by hand.
//
// It creates a NEW budget inside the account rather than writing into whatever
// you already have — switch to it from the menu at the top of the sidebar, and
// delete it when you're done. Your real budget is never touched.
//
//   SEED_EMAIL=test@example.com SEED_PASSWORD=... npm run seed
//
// Registers the account if it doesn't exist yet. Everything goes through the
// public API, so loan payments really are split into interest and principal and
// goals really are stored with their periods — nothing is faked into the
// database behind the app's back.

const API = process.env.SEED_API || 'http://localhost:3178';
const EMAIL = process.env.SEED_EMAIL || 'test@example.com';
const PASSWORD = process.env.SEED_PASSWORD;
const MONTHS_BACK = Number(process.env.SEED_MONTHS || 8);

if (!PASSWORD) {
  console.error('Set SEED_PASSWORD (and optionally SEED_EMAIL, default test@example.com).');
  process.exit(1);
}

let cookie = null;
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let json = null; try { json = await res.json(); } catch {}
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const $ = d => Math.round(d * 100);
const pad = n => String(n).padStart(2, '0');
const now = new Date();
const shift = n => {
  const i = now.getFullYear() * 12 + now.getMonth() + n;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
};
const THIS = shift(0);
const day = (m, d) => `${m}-${pad(d)}`;
// deterministic jitter, so re-running produces the same budget rather than a
// different one every time
let seed = 20260730;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const vary = (base, pct) => $(+(base * (1 + (rnd() * 2 - 1) * pct)).toFixed(2));
const pick = arr => arr[Math.floor(rnd() * arr.length)];

// ---------- sign in ----------
try {
  await call('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  console.log(`signed in as ${EMAIL}`);
} catch {
  await call('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  console.log(`registered ${EMAIL}`);
}

const stamp = `${THIS} ${pad(now.getHours())}${pad(now.getMinutes())}`;
const budget = await call('/api/budgets', { method: 'POST', body: { name: `Sandbox ${stamp}`, demo: false } });
await call(`/api/budgets/${budget.id}/select`, { method: 'POST' });
console.log(`created and switched to budget "Sandbox ${stamp}"`);

// ---------- accounts ----------
const start = shift(-MONTHS_BACK);
const acct = (name, type, startingBalance = 0, extra = {}) =>
  call('/api/accounts', { method: 'POST', body: { name, type, startingBalance, date: day(start, 1), ...extra } });

const checking = (await acct('Everyday Checking', 'cash', $(2400))).id;
const savings = (await acct('Emergency Savings', 'cash', $(6100))).id;
const travel = (await acct('Travel Fund', 'cash', $(850))).id;
const visa = (await acct('Blue Cash Visa', 'credit', $(-420.18))).id;
const amex = (await acct('Amex Everyday', 'credit', $(-96.4))).id;
const car = (await acct('2024 Civic', 'loan', $(-18400), { apr: 5.49, loanMonths: 42 })).id;
const oldCard = (await acct('Retired Store Card', 'credit', 0)).id;
await call(`/api/accounts/${oldCard}`, { method: 'PATCH', body: { closed: true } });

// ---------- categories, one per goal shape ----------
const group = name => call('/api/groups', { method: 'POST', body: { name } }).then(r => r.id);
const cat = (groupId, emoji, name, goal) =>
  call('/api/categories', { method: 'POST', body: { groupId, name, emoji } })
    .then(async r => { if (goal) await call(`/api/categories/${r.id}`, { method: 'PATCH', body: goal }); return r.id; });

const bills = await group('Every Month');
const rent = await cat(bills, '🏠', 'Rent', { goal: $(1450), goalPeriod: 'monthly' });
const power = await cat(bills, '💡', 'Electric', { goal: $(95), goalPeriod: 'monthly' });
const phone = await cat(bills, '📱', 'Cell Service', { goal: $(55), goalPeriod: 'monthly' });
const carPay = await cat(bills, '🚙', 'Car Payment', { goal: $(478), goalPeriod: 'monthly' });

const food = await group('Food');
const groceries = await cat(food, '🛒', 'Groceries', { goal: $(160), goalPeriod: 'weekly' });
const dining = await cat(food, '🍽️', 'Restaurants', { goal: $(220), goalPeriod: 'monthly' });
const coffee = await cat(food, '☕', 'Coffee', { goal: $(18), goalPeriod: 'weekly' });

const periodic = await group('Comes Around');
const insurance = await cat(periodic, '🛡️', 'Car Insurance', { goal: $(1320), goalPeriod: 'annual' });
const registration = await cat(periodic, '📋', 'Registration', { goal: $(210), goalPeriod: 'quarterly' });
const dentist = await cat(periodic, '🦷', 'Dentist', { goal: $(340), goalPeriod: 'biannual' });
const subs = await cat(periodic, '📺', 'Subscriptions', {
  goal: $(64), goalPeriod: 'custom', goalEvery: 2, goalUnit: 'month', goalDate: day(shift(-1), 1),
});

const saving = await group('Saving Up');
const vacation = await cat(saving, '🏖️', 'Iceland Trip', {
  goal: $(3200), goalPeriod: 'by-date', goalDate: day(shift(9), 1),
});
const laptop = await cat(saving, '💻', 'New Laptop', {
  goal: $(1500), goalPeriod: 'by-date', goalDate: day(shift(3), 1),
});

const fun = await group('Whatever');
const hobbies = await cat(fun, '🎸', 'Hobbies', null);      // no goal on purpose
const gifts = await cat(fun, '🎁', 'Gifts', null);          // ditto — Recover raids these first

// ---------- history ----------
const txn = body => call('/api/transactions', { method: 'POST', body: { memo: '', ...body } });
const spend = (accountId, date, payee, amount, categoryId, extra = {}) =>
  txn({ accountId, date, payee, amount: -amount, kind: 'category', categoryId, ...extra });

const GROCERS = ['Trader Joe\'s', 'Safeway', 'Costco', 'Whole Foods'];
const CAFES = ['Blue Bottle', 'Local Roasters', 'Starbucks'];
const EATS = ['Thai Basil', 'Pizzeria Uno', 'Sushi Ten', 'The Diner', 'Taqueria Sol'];

let made = 0;
for (let i = MONTHS_BACK; i >= 0; i--) {
  const m = shift(-i);
  const isCurrent = m === THIS;

  // two paychecks, with one lean month so the trend line actually moves
  const lean = i === 3;
  await txn({ accountId: checking, date: day(m, 1), payee: 'Northwind Payroll', amount: vary(lean ? 1900 : 2650, 0.02), kind: 'income' });
  made++;
  if (!lean) {
    await txn({ accountId: checking, date: day(m, 15), payee: 'Northwind Payroll', amount: vary(2650, 0.02), kind: 'income' });
    made++;
  }
  if (i === 5) { await txn({ accountId: checking, date: day(m, 22), payee: 'Tax Refund', amount: $(1240), kind: 'income' }); made++; }

  // fixed monthly bills
  await spend(checking, day(m, 2), 'Bayview Property', $(1450), rent, { recurring: true }); made++;
  await spend(checking, day(m, 8), 'City Power', vary(95, 0.22), power, { recurring: true }); made++;
  await spend(visa, day(m, 12), 'Mobilink', $(55), phone, { recurring: true }); made++;
  await spend(visa, day(m, 6), 'Streamly', $(32), subs, { recurring: true }); made++;

  // weekly-ish groceries and coffee
  for (const d of [4, 11, 18, 25]) {
    await spend(pick([checking, visa, amex]), day(m, d), pick(GROCERS), vary(148, 0.3), groceries); made++;
    await spend(amex, day(m, d + 1), pick(CAFES), vary(16, 0.4), coffee); made++;
  }
  // a few meals out
  for (let k = 0; k < 3; k++) {
    await spend(pick([visa, amex, checking]), day(m, 5 + k * 8), pick(EATS), vary(52, 0.5), dining); made++;
  }

  // the periodic ones only land in their months
  if (i === 6 || i === 2) { await spend(checking, day(m, 14), 'Statewide Insurance', $(660), insurance); made++; }
  if (i === 7 || i === 4 || i === 1) { await spend(checking, day(m, 9), 'DMV', $(210), registration); made++; }
  if (i === 5) { await spend(checking, day(m, 17), 'Bright Smile Dental', $(340), dentist); made++; }
  if (i === 4) { await spend(amex, day(m, 20), 'Guitar Center', $(288), hobbies); made++; }
  if (i === 2) { await spend(checking, day(m, 21), 'Bookshop', $(74), gifts); made++; }

  // moving money to savings — a transfer, so the cashflow report must ignore it
  if (!isCurrent) {
    await txn({ accountId: checking, date: day(m, 16), payee: '', amount: -$(300), kind: 'transfer', transferAccountId: savings });
    made++;
    await txn({ accountId: checking, date: day(m, 16), payee: '', amount: -$(150), kind: 'transfer', transferAccountId: travel });
    made++;
  }

  // a real loan payment: interest split off, term steps down
  await call('/api/loan-payment', {
    method: 'POST',
    body: { fromAccountId: checking, loanAccountId: car, amount: $(478), date: day(m, 3), categoryId: carPay },
  });
  made++;

  // paying the cards off, as a transfer from checking
  if (!isCurrent) {
    await txn({ accountId: checking, date: day(m, 26), payee: '', amount: -$(380), kind: 'transfer', transferAccountId: visa });
    made++;
  }

  // a couple of uncleared and uncategorized rows to poke at
  if (isCurrent) {
    await txn({ accountId: checking, date: day(m, 24), payee: 'Pending Charge', amount: -$(41.2), kind: 'uncategorized', cleared: false });
    await txn({ accountId: amex, date: day(m, 23), payee: 'Unknown Merchant', amount: -$(19.99), kind: 'uncategorized' });
    made += 2;
  }
}

// ---------- this month's assignments ----------
const state = await call('/api/state');
const byName = Object.fromEntries(state.groups.flatMap(g => g.categories).map(c => [c.name, c]));
const assign = (id, amount) => call('/api/assign', { method: 'PUT', body: { month: THIS, categoryId: id, amount } });

for (const [name, amount] of [
  ['Rent', $(1450)], ['Electric', $(95)], ['Cell Service', $(55)], ['Car Payment', $(478)],
  ['Groceries', $(693)], ['Restaurants', $(220)], ['Coffee', $(78)],
  ['Car Insurance', $(110)], ['Registration', $(70)], ['Dentist', $(57)], ['Subscriptions', $(32)],
  ['Iceland Trip', $(320)], ['New Laptop', $(375)],
  ['Hobbies', $(120)], ['Gifts', $(60)],
]) {
  if (byName[name]) await assign(byName[name].id, amount);
}

// Deliberately push past what's available so the red "Overassigned" state and
// the Recover overassigned action are both visible the moment you open it.
const after = await call('/api/state');
if (after.readyToAssign > 0) {
  await assign(byName['Hobbies'].id, $(120) + after.readyToAssign + $(180));
}

const final = await call('/api/state');
console.log(`\n${made} transactions across ${MONTHS_BACK + 1} months`);
console.log(`accounts: 5 open, 1 closed, 1 loan`);
console.log(`ready to assign: ${(final.readyToAssign / 100).toFixed(2)} (negative on purpose — try "Recover overassigned")`);
console.log(`\nOpen ${API}, sign in as ${EMAIL}, and pick "Sandbox ${stamp}" from the menu at the top left.`);
