import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccount } from './db.js';
import { authRouter, budgetsRouter, requireAuth } from './auth.js';
import { claimToken, listExternalAccounts, syncConnection } from './sync.js';
import { allPayeeCategories, forgetCategory, recordChoice } from './payees.js';
import {
  buildState, currentMonth, shiftMonth, setAssigned, coverOverspending, assignLastMonth,
  moveMoney, fundGoals,
} from './budget.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const portArgIndex = process.argv.indexOf('--port');
const PORT = portArgIndex >= 0
  ? Number(process.argv[portArgIndex + 1])
  : Number(process.env.PORT || 3178);
const app = express();
app.use(express.json());

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const bad = (res, msg) => res.status(400).json({ error: msg });

// ---------- auth (no session required) ----------
app.use('/api/auth', authRouter);

// everything else under /api requires a session; req.db is the active budget
app.use('/api', requireAuth);
app.use('/api/budgets', budgetsRouter);

// ---------- budget state ----------
app.get('/api/state', (req, res) => {
  const month = MONTH_RE.test(req.query.month || '') ? req.query.month : currentMonth();
  res.json(buildState(req.db, month));
});

app.put('/api/assign', (req, res) => {
  const { month, categoryId, amount } = req.body;
  if (!MONTH_RE.test(month || '')) return bad(res, 'invalid month');
  if (!Number.isInteger(amount)) return bad(res, 'Enter a valid amount');
  const cat = req.db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  if (!cat) return bad(res, 'Choose a category');
  setAssigned(req.db, month, categoryId, amount);
  res.json({ ok: true });
});

app.post('/api/auto-assign', (req, res) => {
  const { month, mode } = req.body;
  if (!MONTH_RE.test(month || '')) return bad(res, 'invalid month');
  if (mode === 'cover-overspending') coverOverspending(req.db, month);
  else if (mode === 'assigned-last-month') assignLastMonth(req.db, month);
  else if (mode === 'fund-goals') fundGoals(req.db, month);
  else return bad(res, 'unknown mode');
  res.json({ ok: true });
});

app.post('/api/move-money', (req, res) => {
  const { month, fromCategoryId = null, toCategoryId = null, amount } = req.body;
  if (!MONTH_RE.test(month || '')) return bad(res, 'invalid month');
  if (!Number.isInteger(amount) || amount <= 0) return bad(res, 'Enter an amount greater than zero');
  if (fromCategoryId == null && toCategoryId == null) return bad(res, 'Choose where to move the money');
  if (fromCategoryId === toCategoryId) return bad(res, 'Choose two different categories');
  for (const id of [fromCategoryId, toCategoryId]) {
    if (id != null && !req.db.prepare('SELECT id FROM categories WHERE id = ?').get(id)) {
      return bad(res, 'Choose a category');
    }
  }
  moveMoney(req.db, month, fromCategoryId, toCategoryId, amount);
  res.json({ ok: true });
});

// ---------- accounts ----------
function loanFields(body, res) {
  let apr = null, loanMonths = null;
  if (body.apr != null && body.apr !== '') {
    apr = Number(body.apr);
    if (!Number.isFinite(apr) || apr < 0 || apr > 100) return bad(res, 'APR must be between 0 and 100'), null;
  }
  if (body.loanMonths != null && body.loanMonths !== '') {
    loanMonths = Number(body.loanMonths);
    if (!Number.isInteger(loanMonths) || loanMonths < 1 || loanMonths > 120) return bad(res, 'Loan term must be between 1 and 120 months'), null;
  }
  return { apr, loanMonths };
}

app.post('/api/accounts', (req, res) => {
  const { name, type, startingBalance } = req.body;
  if (!name?.trim()) return bad(res, 'Enter a name');
  if (!['cash', 'credit', 'loan'].includes(type)) return bad(res, 'Choose an account type');
  if (startingBalance != null && !Number.isInteger(startingBalance)) return bad(res, 'Enter a valid balance');
  const loan = loanFields(req.body, res);
  if (!loan) return;
  const id = createAccount(req.db, {
    name: name.trim(), type, startingBalance: startingBalance ?? 0,
    apr: loan.apr, loanMonths: loan.loanMonths,
  });
  res.json({ id });
});

app.patch('/api/accounts/:id', (req, res) => {
  const acct = req.db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  const name = req.body.name?.trim() || acct.name;
  const closed = req.body.closed != null ? (req.body.closed ? 1 : 0) : acct.closed;
  let { apr, loan_months } = acct;
  if (req.body.apr !== undefined || req.body.loanMonths !== undefined) {
    const loan = loanFields(req.body, res);
    if (!loan) return;
    if (req.body.apr !== undefined) apr = loan.apr;
    if (req.body.loanMonths !== undefined) loan_months = loan.loanMonths;
  }
  req.db.prepare('UPDATE accounts SET name = ?, closed = ?, apr = ?, loan_months = ? WHERE id = ?')
    .run(name, closed, apr, loan_months, acct.id);
  req.db.prepare('UPDATE categories SET name = ? WHERE linked_account_id = ?').run(name, acct.id);
  res.json({ ok: true });
});

// ---------- category groups ----------
app.post('/api/groups', (req, res) => {
  if (!req.body.name?.trim()) return bad(res, 'Enter a name');
  const order = req.db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM category_groups').get().n;
  const { lastInsertRowid } = req.db.prepare(
    'INSERT INTO category_groups (name, sort_order) VALUES (?, ?)'
  ).run(req.body.name.trim(), order);
  res.json({ id: lastInsertRowid });
});

app.patch('/api/groups/:id', (req, res) => {
  if (!req.body.name?.trim()) return bad(res, 'Enter a name');
  req.db.prepare('UPDATE category_groups SET name = ? WHERE id = ?').run(req.body.name.trim(), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/groups/:id', (req, res) => {
  const group = req.db.prepare('SELECT * FROM category_groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.is_payment_group) return res.status(409).json({ error: 'Credit Card Payments can\'t be deleted' });
  const count = req.db.prepare('SELECT COUNT(*) AS n FROM categories WHERE group_id = ?').get(group.id).n;
  if (count > 0) return res.status(409).json({ error: 'Delete or move this group\'s categories first' });
  req.db.prepare('DELETE FROM category_groups WHERE id = ?').run(group.id);
  res.json({ ok: true });
});

// ---------- categories ----------
app.post('/api/categories', (req, res) => {
  const { groupId, name, emoji } = req.body;
  const group = req.db.prepare('SELECT * FROM category_groups WHERE id = ?').get(groupId);
  if (!group) return bad(res, 'unknown group');
  if (group.is_payment_group) return bad(res, 'Payment categories come from your credit card accounts');
  if (!name?.trim()) return bad(res, 'Enter a name');
  const order = req.db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM categories WHERE group_id = ?').get(groupId).n;
  const { lastInsertRowid } = req.db.prepare(
    'INSERT INTO categories (group_id, name, emoji, sort_order) VALUES (?, ?, ?, ?)'
  ).run(groupId, name.trim(), emoji || null, order);
  res.json({ id: lastInsertRowid });
});

app.patch('/api/categories/:id', (req, res) => {
  const cat = req.db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  if (cat.linked_account_id != null && req.body.name) {
    return res.status(409).json({ error: 'Rename the credit card account instead' });
  }
  const name = req.body.name?.trim() || cat.name;
  const emoji = req.body.emoji !== undefined ? (req.body.emoji || null) : cat.emoji;
  let goal = cat.goal_amount;
  if (req.body.goal !== undefined) {
    if (req.body.goal != null && (!Number.isInteger(req.body.goal) || req.body.goal < 0)) {
      return bad(res, 'Enter a valid goal amount');
    }
    goal = req.body.goal || null;
  }
  req.db.prepare('UPDATE categories SET name = ?, emoji = ?, goal_amount = ? WHERE id = ?').run(name, emoji, goal, cat.id);
  res.json({ ok: true });
});

app.delete('/api/categories/:id', (req, res) => {
  const cat = req.db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  if (cat.linked_account_id != null) {
    return res.status(409).json({ error: 'This category is removed when you delete its credit card account' });
  }
  const used = req.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?').get(cat.id).n;
  if (used > 0) {
    return res.status(409).json({
      error: `${used} transaction${used === 1 ? '' : 's'} still ${used === 1 ? 'uses' : 'use'} this category — move them to another category first`,
    });
  }
  req.db.prepare('DELETE FROM assignments WHERE category_id = ?').run(cat.id);
  forgetCategory(req.db, cat.id);
  req.db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
  res.json({ ok: true });
});

app.get('/api/categories/:id/details', (req, res) => {
  const cat = req.db.prepare(`
    SELECT c.*, g.name AS group_name FROM categories c
    JOIN category_groups g ON g.id = c.group_id WHERE c.id = ?
  `).get(req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const month = MONTH_RE.test(req.query.month || '') ? req.query.month : currentMonth();

  // six months of history ending at the requested month, via the same engine
  // that renders the budget table so payment-category mechanics stay consistent
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const m = shiftMonth(month, -i);
    const c = buildState(req.db, m).groups
      .flatMap(g => g.categories)
      .find(x => x.id === cat.id);
    if (c) months.push({ month: m, assigned: c.assigned, activity: c.activity, available: c.available });
  }

  const transactions = req.db.prepare(`
    SELECT t.id, t.date, t.payee, t.memo, t.amount, t.is_recurring, a.name AS account_name
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.category_id = ?
    ORDER BY t.date DESC, t.id DESC
    LIMIT 25
  `).all(cat.id);

  const n = months.length || 1;
  res.json({
    category: { id: cat.id, name: cat.name, emoji: cat.emoji, goal: cat.goal_amount ?? 0, groupName: cat.group_name },
    months,
    transactions,
    stats: {
      avgAssigned: Math.round(months.reduce((s, m) => s + m.assigned, 0) / n),
      avgSpent: Math.round(months.reduce((s, m) => s - Math.min(m.activity, 0), 0) / n),
    },
  });
});

// ---------- transactions ----------
app.get('/api/transactions', (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.accountId) {
    clauses.push('t.account_id = ?');
    params.push(req.query.accountId);
  }
  if (req.query.categoryId) {
    clauses.push('t.category_id = ?');
    params.push(req.query.categoryId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = req.db.prepare(`
    SELECT t.*, a.name AS account_name, a.type AS account_type, c.name AS category_name, c.emoji AS category_emoji,
           ta.name AS transfer_account_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
    ${where}
    ORDER BY t.date DESC, t.id DESC
  `).all(...params);
  res.json(rows);
});

function txnFields(db, body, res) {
  const { accountId, date, payee = '', memo = '', amount, kind, categoryId, transferAccountId } = body;
  const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acct) return bad(res, 'Choose an account'), null;
  if (!DATE_RE.test(date || '')) return bad(res, 'Choose a valid date'), null;
  if (!Number.isInteger(amount)) return bad(res, 'Enter a valid amount'), null;
  let is_income = 0, is_transfer = 0, category_id = null, transfer_account_id = null;
  if (kind === 'income') is_income = 1;
  else if (kind === 'transfer') {
    is_transfer = 1;
    const dest = db.prepare('SELECT * FROM accounts WHERE id = ?').get(transferAccountId);
    if (!dest) return bad(res, 'Choose the account this transfers to'), null;
    if (dest.id === acct.id) return bad(res, 'A transfer needs two different accounts'), null;
    transfer_account_id = dest.id;
  } else if (kind === 'category') {
    const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
    if (!cat) return bad(res, 'Choose a category'), null;
    category_id = cat.id;
  } else if (kind !== 'uncategorized') return bad(res, 'invalid kind'), null;
  return {
    account_id: acct.id, date, memo: String(memo), amount,
    payee: is_transfer ? '' : String(payee), // transfer display derives from the linked account
    is_income, is_transfer, category_id, transfer_account_id,
    cleared: body.cleared === false ? 0 : 1,
    is_recurring: body.recurring ? 1 : 0,
  };
}

/** The mirror side of a transfer: inverse amount, opposite account, linked back. */
function insertMirror(db, f, primaryId) {
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO transactions (account_id, date, payee, memo, amount, is_transfer, cleared, is_recurring,
      transfer_account_id, transfer_pair_id)
    VALUES (?, ?, '', ?, ?, 1, ?, ?, ?, ?)
  `).run(f.transfer_account_id, f.date, f.memo, -f.amount, f.cleared, f.is_recurring, f.account_id, primaryId);
  db.prepare('UPDATE transactions SET transfer_pair_id = ? WHERE id = ?').run(lastInsertRowid, primaryId);
  return Number(lastInsertRowid);
}

app.post('/api/transactions', (req, res) => {
  const f = txnFields(req.db, req.body, res);
  if (!f) return;
  const { lastInsertRowid } = req.db.prepare(`
    INSERT INTO transactions (account_id, date, payee, category_id, memo, amount, is_income, is_transfer,
      cleared, is_recurring, transfer_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(f.account_id, f.date, f.payee, f.category_id, f.memo, f.amount, f.is_income, f.is_transfer,
    f.cleared, f.is_recurring, f.transfer_account_id);
  if (f.is_transfer) insertMirror(req.db, f, Number(lastInsertRowid));
  recordChoice(req.db, f.payee, f.category_id);
  res.json({ id: Number(lastInsertRowid) });
});

app.patch('/api/transactions/:id', (req, res) => {
  const txn = req.db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const f = txnFields(req.db, req.body, res);
  if (!f) return;
  req.db.prepare(`
    UPDATE transactions SET account_id = ?, date = ?, payee = ?, category_id = ?, memo = ?, amount = ?,
      is_income = ?, is_transfer = ?, cleared = ?, is_recurring = ?, transfer_account_id = ?, is_starting = 0
    WHERE id = ?
  `).run(f.account_id, f.date, f.payee, f.category_id, f.memo, f.amount, f.is_income, f.is_transfer,
    f.cleared, f.is_recurring, f.transfer_account_id, txn.id);
  recordChoice(req.db, f.payee, f.category_id);

  // keep the mirror in lockstep through every transition
  const pair = txn.transfer_pair_id
    ? req.db.prepare('SELECT * FROM transactions WHERE id = ?').get(txn.transfer_pair_id)
    : null;
  if (f.is_transfer) {
    if (pair) {
      req.db.prepare(`
        UPDATE transactions SET account_id = ?, date = ?, memo = ?, amount = ?, cleared = ?, is_recurring = ?,
          transfer_account_id = ?
        WHERE id = ?
      `).run(f.transfer_account_id, f.date, f.memo, -f.amount, f.cleared, f.is_recurring, f.account_id, pair.id);
    } else {
      insertMirror(req.db, f, txn.id);
    }
  } else if (pair) {
    // no longer a transfer — the inverse side goes away
    req.db.prepare('DELETE FROM transactions WHERE id = ?').run(pair.id);
    req.db.prepare('UPDATE transactions SET transfer_pair_id = NULL WHERE id = ?').run(txn.id);
  }
  res.json({ ok: true });
});

app.delete('/api/transactions/:id', (req, res) => {
  const txn = req.db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  req.db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  if (txn?.transfer_pair_id) {
    // a transfer is one logical operation — removing one side removes both
    req.db.prepare('DELETE FROM transactions WHERE id = ?').run(txn.transfer_pair_id);
  }
  res.json({ ok: true });
});

// ---------- reports ----------
app.get('/api/reports/spending', (req, res) => {
  const start = DATE_RE.test(req.query.start || '') ? req.query.start : '0000-01-01';
  const end = DATE_RE.test(req.query.end || '') ? req.query.end : '9999-12-31';
  // spending = categorized/uncategorized outflows on budget accounts; income,
  // transfers, starting balances, and reconciliation adjustments are not spending
  const rows = req.db.prepare(`
    SELECT t.category_id, c.name, c.emoji, g.name AS group_name, c.linked_account_id,
           SUM(t.amount) AS net,
           SUM(CASE WHEN t.amount < 0 THEN t.amount ELSE 0 END) AS outflows
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id AND a.type != 'loan'
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN category_groups g ON g.id = c.group_id
    WHERE t.date >= ? AND t.date <= ?
      AND t.is_income = 0 AND t.is_transfer = 0 AND t.is_starting = 0
      AND t.payee != 'Balance Adjustment'
    GROUP BY t.category_id
  `).all(start, end);
  let total = 0;
  let uncategorized = 0;
  const categories = [];
  for (const r of rows) {
    if (r.linked_account_id != null) continue; // payment categories aren't spending
    if (r.category_id == null) {
      // uncategorized inflows are unclassified income, not refunds — count
      // only the outflows as spending
      uncategorized = -r.outflows;
      total += uncategorized;
      continue;
    }
    const spent = -r.net;                      // real categories net out refunds
    if (spent <= 0) continue;
    categories.push({ id: r.category_id, name: r.name, emoji: r.emoji, groupName: r.group_name, spent });
    total += spent;
  }
  categories.sort((a, b) => b.spent - a.spent);
  res.json({ start, end, total, uncategorized, categories });
});

// ---------- bank connections (SimpleFIN) ----------
app.get('/api/connections', (req, res) => {
  const rows = req.db.prepare(`
    SELECT c.id, c.provider, c.name, c.last_sync_at, c.last_sync_status,
           COUNT(a.id) AS linked_accounts
    FROM connections c
    LEFT JOIN accounts a ON a.connection_id = c.id
    GROUP BY c.id ORDER BY c.id
  `).all();
  res.json(rows);
});

app.post('/api/connections', async (req, res) => {
  // Claiming consumes the single-use setup token. If it fails, nothing is saved
  // and the user retries with the same token.
  let accessUrl;
  try {
    accessUrl = await claimToken(req.body?.token);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  // Token is now spent; the access URL is reusable, so persist the connection
  // even if the first account fetch fails (e.g. bridge payment required) so the
  // user never has to burn a fresh token just to retry.
  let external = [];
  let warning = null;
  try {
    external = await listExternalAccounts(accessUrl);
  } catch (e) {
    warning = e.message;
  }
  const name = req.body?.name?.trim() || external[0]?.org || 'SimpleFIN';
  const { lastInsertRowid } = req.db.prepare(
    "INSERT INTO connections (provider, name, access_url, last_sync_status) VALUES ('simplefin', ?, ?, ?)"
  ).run(name, accessUrl, warning ? `error: ${warning}` : null);
  res.json({ id: Number(lastInsertRowid), name, accounts: external, warning });
});

app.get('/api/connections/:id/accounts', async (req, res) => {
  const conn = req.db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  try {
    const external = await listExternalAccounts(conn.access_url);
    const links = req.db.prepare(
      'SELECT id, name, external_id FROM accounts WHERE connection_id = ?'
    ).all(conn.id);
    res.json(external.map(e => ({
      ...e,
      linkedAccountId: links.find(l => l.external_id === e.id)?.id ?? null,
    })));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.delete('/api/connections/:id', (req, res) => {
  const conn = req.db.prepare('SELECT id FROM connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  req.db.prepare('UPDATE accounts SET connection_id = NULL, external_id = NULL WHERE connection_id = ?').run(conn.id);
  req.db.prepare('DELETE FROM connections WHERE id = ?').run(conn.id);
  res.json({ ok: true });
});

app.post('/api/accounts/:id/link', async (req, res) => {
  const acct = req.db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  const conn = req.db.prepare('SELECT * FROM connections WHERE id = ?').get(req.body?.connectionId);
  if (!conn) return bad(res, 'unknown connection');
  const externalId = String(req.body?.externalId ?? '');
  if (!externalId) return bad(res, 'externalId is required');
  const taken = req.db.prepare(
    'SELECT id FROM accounts WHERE connection_id = ? AND external_id = ? AND id != ?'
  ).get(conn.id, externalId, acct.id);
  if (taken) return res.status(409).json({ error: 'That bank account is already linked to another account' });

  req.db.prepare('UPDATE accounts SET connection_id = ?, external_id = ? WHERE id = ?')
    .run(conn.id, externalId, acct.id);

  // initial import first, then align the balance to the bank's
  let result = { imported: 0, updated: 0 };
  let adjustment = 0;
  try {
    result = await syncConnection(req.db, conn, { accountId: acct.id });
    if (req.body?.adjustBalance !== false && Number.isInteger(req.body?.bankBalance)) {
      const current = req.db.prepare(
        'SELECT COALESCE(SUM(amount), 0) AS b FROM transactions WHERE account_id = ?'
      ).get(acct.id).b;
      adjustment = req.body.bankBalance - current;
      if (adjustment !== 0) {
        req.db.prepare(`
          INSERT INTO transactions (account_id, date, payee, amount, is_income, cleared)
          VALUES (?, ?, 'Balance Adjustment', ?, ?, 1)
        `).run(acct.id, new Date().toISOString().slice(0, 10), adjustment,
          acct.type === 'cash' && adjustment > 0 ? 1 : 0);
      }
    }
  } catch (e) {
    return res.status(502).json({ error: `Linked, but the first sync failed: ${e.message}` });
  }
  res.json({ ok: true, ...result, adjustment });
});

app.post('/api/accounts/:id/unlink', (req, res) => {
  req.db.prepare('UPDATE accounts SET connection_id = NULL, external_id = NULL WHERE id = ?')
    .run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/sync', async (req, res) => {
  const { connectionId, ifStaleHours } = req.body ?? {};
  let conns = req.db.prepare('SELECT * FROM connections ORDER BY id').all();
  if (connectionId != null) conns = conns.filter(c => c.id === Number(connectionId));
  if (Number.isFinite(ifStaleHours)) {
    const cutoff = Date.now() - ifStaleHours * 3600 * 1000;
    conns = conns.filter(c => !c.last_sync_at || c.last_sync_at < cutoff);
  }
  let imported = 0, updated = 0;
  const errors = [];
  for (const conn of conns) {
    try {
      const r = await syncConnection(req.db, conn);
      imported += r.imported;
      updated += r.updated;
    } catch (e) {
      errors.push({ connection: conn.name, error: e.message });
    }
  }
  res.json({ synced: conns.length, imported, updated, errors });
});

app.get('/api/payees', (req, res) => {
  const rows = req.db.prepare(
    "SELECT DISTINCT payee FROM transactions WHERE payee != '' ORDER BY payee"
  ).all();
  res.json(rows.map(r => r.payee));
});

// what each payee has been categorized as before: `rule` is the category a new
// transaction adopts, `suggestions` are the ones the picker floats to the top
app.get('/api/payee-categories', (req, res) => {
  res.json(allPayeeCategories(req.db));
});

// ---------- static client (after `npm run build`) ----------
const dist = join(__dirname, '..', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.listen(PORT, () => console.log(`budget-app API listening on http://localhost:${PORT}`));
