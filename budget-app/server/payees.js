// Payee → category memory.
//
// Every time a transaction is saved with a payee and a real category, that
// pairing is recorded. Two features read it back:
//   - a new transaction for a known payee adopts that payee's most recently
//     chosen category automatically (bank sync applies it server-side; manual
//     entry fills it in the editor so the user can see and override it)
//   - the category picker floats a payee's most-used categories to the top
//
// Rows are (payee_key, category_id) with a use count and a last-used stamp:
// the count drives the suggestion order, the stamp decides the auto-apply rule.

import { payeeKey } from '../shared/payee-key.js';

export { payeeKey };

const MAX_SUGGESTIONS = 3;

/** Records that `payee` was filed under `categoryId`. No-op for blank payees
 *  and for transfers/income, which have no category. */
export function recordChoice(db, payee, categoryId) {
  const key = payeeKey(payee);
  if (!key || categoryId == null) return;
  db.prepare(`
    INSERT INTO payee_categories (payee_key, category_id, count, last_used_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT (payee_key, category_id)
    DO UPDATE SET count = count + 1, last_used_at = excluded.last_used_at
  `).run(key, categoryId, Date.now());
}

/** The category a new transaction for this payee should default to — the one
 *  chosen most recently, which is what a user changing their mind expects. */
export function ruleFor(db, payee) {
  const key = payeeKey(payee);
  if (!key) return null;
  const row = db.prepare(`
    SELECT pc.category_id FROM payee_categories pc
    JOIN categories c ON c.id = pc.category_id
    WHERE pc.payee_key = ?
    ORDER BY pc.last_used_at DESC, pc.count DESC
    LIMIT 1
  `).get(key);
  return row?.category_id ?? null;
}

/** Every payee's rule and top categories, for the client to hold in memory —
 *  the editor needs an answer on each keystroke, not a round trip. */
export function allPayeeCategories(db) {
  const rows = db.prepare(`
    SELECT pc.payee_key, pc.category_id, pc.count, pc.last_used_at
    FROM payee_categories pc
    JOIN categories c ON c.id = pc.category_id
    ORDER BY pc.payee_key, pc.count DESC, pc.last_used_at DESC
  `).all();

  const byKey = new Map();
  for (const r of rows) {
    let e = byKey.get(r.payee_key);
    if (!e) byKey.set(r.payee_key, (e = { key: r.payee_key, rule: null, ruleAt: -1, suggestions: [] }));
    // rows arrive in suggestion order already; the rule is a separate ranking
    if (e.suggestions.length < MAX_SUGGESTIONS) e.suggestions.push(r.category_id);
    if (r.last_used_at > e.ruleAt) { e.ruleAt = r.last_used_at; e.rule = r.category_id; }
  }
  return [...byKey.values()].map(({ key, rule, suggestions }) => ({ key, rule, suggestions }));
}

/** Drops a deleted category from every payee's history. */
export function forgetCategory(db, categoryId) {
  db.prepare('DELETE FROM payee_categories WHERE category_id = ?').run(categoryId);
}

/** Seeds the table from transactions that were already categorized, so the
 *  feature knows a user's habits the first time it runs instead of having to
 *  relearn them. Counts real history; ranks recency by history position. */
export function backfillFromTransactions(db) {
  const rows = db.prepare(`
    SELECT payee, category_id FROM transactions
    WHERE payee != '' AND category_id IS NOT NULL
      AND is_transfer = 0 AND is_income = 0 AND is_starting = 0
    ORDER BY date, id
  `).all();

  const seen = new Map();
  rows.forEach((r, i) => {
    const key = payeeKey(r.payee);
    if (!key) return;
    const id = `${key} ${r.category_id}`;
    const e = seen.get(id) ?? { key, categoryId: r.category_id, count: 0, lastSeen: i };
    e.count++;
    e.lastSeen = i; // rows are date-ordered, so the last hit is the most recent
    seen.set(id, e);
  });

  const insert = db.prepare(`
    INSERT INTO payee_categories (payee_key, category_id, count, last_used_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (payee_key, category_id) DO NOTHING
  `);
  // synthetic stamps keep the historical order but all land before "now", so a
  // real choice made later always outranks backfilled history
  const base = Date.now() - rows.length - 1;
  for (const e of seen.values()) insert.run(e.key, e.categoryId, e.count, base + e.lastSeen);
}
