import { currentMonth, shiftMonth } from './budget.js';
import { backfillFromTransactions } from './payees.js';

// Budget databases are per-budget SQLite files opened by system.js. This module
// holds everything that operates on a single budget's schema and data.

export function createSchema(db) {
  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('cash','credit','loan')),
      closed INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      apr REAL,
      loan_months INTEGER,
      connection_id INTEGER,
      external_id TEXT
    );
    CREATE TABLE connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'simplefin',
      name TEXT NOT NULL,
      access_url TEXT NOT NULL,
      last_sync_at INTEGER,
      last_sync_status TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE category_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_payment_group INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES category_groups(id),
      name TEXT NOT NULL,
      emoji TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      linked_account_id INTEGER REFERENCES accounts(id),
      goal_amount INTEGER
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      date TEXT NOT NULL,
      payee TEXT NOT NULL DEFAULT '',
      category_id INTEGER REFERENCES categories(id),
      memo TEXT NOT NULL DEFAULT '',
      amount INTEGER NOT NULL,
      is_income INTEGER NOT NULL DEFAULT 0,
      is_transfer INTEGER NOT NULL DEFAULT 0,
      is_starting INTEGER NOT NULL DEFAULT 0,
      cleared INTEGER NOT NULL DEFAULT 1,
      is_recurring INTEGER NOT NULL DEFAULT 0,
      external_id TEXT,
      transfer_account_id INTEGER,
      transfer_pair_id INTEGER,
      interest INTEGER
    );
    CREATE UNIQUE INDEX idx_txn_external ON transactions(account_id, external_id)
      WHERE external_id IS NOT NULL;
    CREATE TABLE assignments (
      month TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      amount INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (month, category_id)
    );
    CREATE TABLE payee_categories (
      payee_key TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (payee_key, category_id)
    );
    CREATE INDEX idx_txn_account ON transactions(account_id);
    CREATE INDEX idx_txn_date ON transactions(date);
  `);
}

/** Bring databases created by older versions of the app up to date. */
export function migrateBudgetDb(db) {
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map(c => c.name);
  if (!cols.includes('is_recurring')) {
    db.exec('ALTER TABLE transactions ADD COLUMN is_recurring INTEGER NOT NULL DEFAULT 0');
  }
  const catCols = db.prepare('PRAGMA table_info(categories)').all().map(c => c.name);
  if (!catCols.includes('goal_amount')) {
    db.exec('ALTER TABLE categories ADD COLUMN goal_amount INTEGER');
  }
  const acctCols = db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
  if (!acctCols.includes('apr')) {
    db.exec('ALTER TABLE accounts ADD COLUMN apr REAL');
    db.exec('ALTER TABLE accounts ADD COLUMN loan_months INTEGER');
  }
  if (!cols.includes('transfer_account_id')) {
    db.exec('ALTER TABLE transactions ADD COLUMN transfer_account_id INTEGER');
    db.exec('ALTER TABLE transactions ADD COLUMN transfer_pair_id INTEGER');
  }
  if (!acctCols.includes('connection_id')) {
    db.exec('ALTER TABLE accounts ADD COLUMN connection_id INTEGER');
    db.exec('ALTER TABLE accounts ADD COLUMN external_id TEXT');
    db.exec('ALTER TABLE transactions ADD COLUMN external_id TEXT');
    db.exec(`CREATE UNIQUE INDEX idx_txn_external ON transactions(account_id, external_id)
      WHERE external_id IS NOT NULL`);
    db.exec(`CREATE TABLE connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'simplefin',
      name TEXT NOT NULL,
      access_url TEXT NOT NULL,
      last_sync_at INTEGER,
      last_sync_status TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  }
  // Loan payments carry the interest slice of the payment so the ledger can show
  // what was actually paid while the balance moves by principal only.
  if (!cols.includes('interest')) {
    db.exec('ALTER TABLE transactions ADD COLUMN interest INTEGER');
  }
  const hasPayeeCategories = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'payee_categories'"
  ).get();
  if (!hasPayeeCategories) {
    db.exec(`CREATE TABLE payee_categories (
      payee_key TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (payee_key, category_id)
    )`);
    // an existing budget already encodes the user's habits — learn from it
    // rather than starting the memory empty
    backfillFromTransactions(db);
  }
}

/** Creates an account plus its payment category (credit) and starting-balance
 *  transaction. Cash starting balances are income (they fund Ready to Assign);
 *  credit/loan starting balances are budget-neutral debt. */
export function createAccount(db, { name, type, startingBalance = 0, date, apr = null, loanMonths = null }) {
  const order = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM accounts').get().n;
  const { lastInsertRowid: accountId } = db.prepare(
    'INSERT INTO accounts (name, type, sort_order, apr, loan_months) VALUES (?, ?, ?, ?, ?)'
  ).run(name, type, order, type === 'loan' ? apr : null, type === 'loan' ? loanMonths : null);

  if (type === 'credit') {
    let group = db.prepare('SELECT id FROM category_groups WHERE is_payment_group = 1').get();
    if (!group) {
      const r = db.prepare(
        'INSERT INTO category_groups (name, sort_order, is_payment_group) VALUES (?, 0, 1)'
      ).run('Credit Card Payments');
      group = { id: r.lastInsertRowid };
    }
    const catOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM categories WHERE group_id = ?').get(group.id).n;
    db.prepare(
      'INSERT INTO categories (group_id, name, sort_order, linked_account_id) VALUES (?, ?, ?, ?)'
    ).run(group.id, name, catOrder, accountId);
  }

  if (startingBalance !== 0) {
    db.prepare(
      `INSERT INTO transactions (account_id, date, payee, amount, is_income, is_starting)
       VALUES (?, ?, 'Starting Balance', ?, ?, 1)`
    ).run(accountId, date ?? new Date().toISOString().slice(0, 10), startingBalance, type === 'cash' ? 1 : 0);
  }
  return accountId;
}

function $(n) { return Math.round(n * 100); }

export function seedDemo(db) {
  const M = currentMonth();          // e.g. 2026-07
  const P = shiftMonth(M, -1);       // previous month
  const d = (m, day) => `${m}-${String(day).padStart(2, '0')}`;

  // --- accounts (payment categories auto-created for credit cards) ---
  const checking = createAccount(db, { name: '360 Checking', type: 'cash', startingBalance: $(1900), date: d(P, 1) });
  createAccount(db, { name: '360 Performance Savings', type: 'cash', startingBalance: $(3284.99), date: d(P, 1) });
  createAccount(db, { name: 'Chase Savings', type: 'cash', startingBalance: $(301), date: d(P, 1) });
  const quicksilver = createAccount(db, { name: 'Quicksilver', type: 'credit', startingBalance: $(-305.53), date: d(P, 1) });
  const savor = createAccount(db, { name: 'Savor', type: 'credit', startingBalance: $(-143.84), date: d(P, 1) });
  createAccount(db, { name: 'Platinum', type: 'credit' });
  const loan = createAccount(db, { name: '2026 Ioniq 5', type: 'loan', startingBalance: $(-49502.48), date: d(P, 1), apr: 5.49, loanMonths: 86 });
  const golf = createAccount(db, { name: '2025 Golf GTI', type: 'cash' });
  db.prepare('UPDATE accounts SET closed = 1 WHERE id = ?').run(golf);

  // --- category groups & categories ---
  const addGroup = (name, order) => db.prepare(
    'INSERT INTO category_groups (name, sort_order) VALUES (?, ?)'
  ).run(name, order).lastInsertRowid;
  const addCat = (groupId, emoji, name, order) => db.prepare(
    'INSERT INTO categories (group_id, name, emoji, sort_order) VALUES (?, ?, ?, ?)'
  ).run(groupId, name, emoji, order).lastInsertRowid;

  const everyMonth = addGroup('Every Month', 1);
  const carPayment = addCat(everyMonth, '🚙', '2026 Ioniq 5', 1);
  const charging = addCat(everyMonth, '⚡', 'Car Charging', 2);
  const cell = addCat(everyMonth, '📱', 'Cell Service', 3);
  const gym = addCat(everyMonth, '💪', 'Gym', 4);

  const food = addGroup('Food', 2);
  const groceries = addCat(food, '🛒', 'Groceries', 1);
  const restaurants = addCat(food, '🍽️', 'Restaurants', 2);
  const fastFood = addCat(food, '🍟', 'Fast Food', 3);
  const delivery = addCat(food, '❌', 'Food Delivery', 4);

  const payCat = accountId => db.prepare(
    'SELECT id FROM categories WHERE linked_account_id = ?'
  ).get(accountId).id;

  // --- monthly goals ---
  const setGoal = (cat, amount) => db.prepare(
    'UPDATE categories SET goal_amount = ? WHERE id = ?'
  ).run(amount, cat);
  setGoal(carPayment, $(687.53));
  setGoal(charging, $(100));
  setGoal(cell, $(40));
  setGoal(gym, $(20));
  setGoal(groceries, $(60));
  setGoal(restaurants, $(25));
  setGoal(fastFood, $(300));
  setGoal(delivery, $(105.76));

  // --- income ---
  const income = (acct, date, amount, payee) => db.prepare(
    `INSERT INTO transactions (account_id, date, payee, amount, is_income) VALUES (?, ?, ?, ?, 1)`
  ).run(acct, date, payee, amount);
  income(checking, d(P, 5), $(1584), 'Employer');
  income(checking, d(P, 19), $(1584), 'Employer');
  income(checking, d(M, 5), $(1584), 'Employer');

  // --- assignments ---
  const assign = (month, cat, amount) => db.prepare(
    'INSERT INTO assignments (month, category_id, amount) VALUES (?, ?, ?)'
  ).run(month, cat, amount);
  assign(P, carPayment, $(687.53));
  assign(P, charging, $(114.75));
  assign(P, cell, $(40));
  assign(P, gym, $(20.02));
  assign(P, groceries, $(60));
  assign(P, restaurants, $(20.80));
  assign(P, fastFood, $(107.17));
  assign(P, delivery, $(98.50));
  assign(P, payCat(savor), $(143.84));
  assign(P, payCat(quicksilver), $(305.53));

  assign(M, carPayment, $(687.53));
  assign(M, charging, $(100));
  assign(M, cell, $(40));
  assign(M, gym, $(20));
  assign(M, groceries, $(60));
  assign(M, fastFood, $(300));
  assign(M, delivery, $(105.76));

  // --- spending ---
  const spend = (acct, date, payee, cat, amount, memo = '') => db.prepare(
    `INSERT INTO transactions (account_id, date, payee, category_id, memo, amount) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(acct, date, payee, cat, memo, amount);

  // previous month
  spend(checking, d(P, 3), 'Planet Fitness', gym, $(-19.99));
  spend(checking, d(P, 10), 'Hyundai Motor Finance', carPayment, $(-687.53));
  db.prepare(
    `INSERT INTO transactions (account_id, date, payee, amount, is_transfer) VALUES (?, ?, 'Loan Payment', ?, 1)`
  ).run(loan, d(P, 10), $(687.53));
  spend(checking, d(P, 12), 'Verizon', cell, $(-40));
  spend(savor, d(P, 8), 'Kroger', groceries, $(-52.30));
  spend(savor, d(P, 14), 'Olive Garden', restaurants, $(-18.75));
  spend(quicksilver, d(P, 16), "Chick-fil-A", fastFood, $(-42.99));
  spend(quicksilver, d(P, 21), 'DoorDash', delivery, $(-98.50));

  // current month
  spend(checking, d(M, 3), 'Planet Fitness', gym, $(-19.99));
  spend(savor, d(M, 4), 'Kroger', groceries, $(-51.97));
  spend(savor, d(M, 6), 'Olive Garden', restaurants, $(-20.12));
  spend(quicksilver, d(M, 2), "McDonald's", fastFood, $(-64.75));
  spend(checking, d(M, 6), 'Five Guys', fastFood, $(-11.39));
  spend(savor, d(M, 5), 'DoorDash', delivery, $(-145.39));
  db.prepare(
    `INSERT INTO transactions (account_id, date, payee, amount) VALUES (?, ?, 'Venmo', ?)`
  ).run(checking, d(M, 7), $(-3.20));

  // regular bills and paychecks show up on the calendar as recurring
  db.prepare(
    `UPDATE transactions SET is_recurring = 1
     WHERE payee IN ('Planet Fitness', 'Verizon', 'Hyundai Motor Finance', 'Employer')`
  ).run();

  // the demo's spending history doubles as the starting payee → category memory
  backfillFromTransactions(db);
}
