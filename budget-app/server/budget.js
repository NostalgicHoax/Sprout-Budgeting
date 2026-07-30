// Zero-based budget engine. All amounts are integer cents; outflows are negative.
//
// Model rules:
// - Loan accounts are tracking-only: their transactions never touch the budget.
// - Income transactions (is_income=1) add to Ready to Assign for their month.
// - Starting balances on credit/loan accounts (is_starting=1, not income) are
//   budget-neutral debt, not uncategorized spending.
// - Transfer transactions (is_transfer=1) never touch the budget; recording a
//   credit-card payment is a categorized outflow on the checking side (category =
//   the card's payment category) plus a transfer inflow on the card side.
// - Categorized spending on a credit account moves that money into the card's
//   payment category (the YNAB credit mechanic).
// - Available carries over across months, including negative balances.

export function shiftMonth(month, delta) {
  let [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  y = Math.floor(idx / 12);
  m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** How much of a transaction moves its account's balance. Normally the whole
 *  amount; for the loan side of a loan payment, only the principal slice, since
 *  the interest was never part of what you owed. */
export function principalOf(t) {
  if (t.interest == null) return t.amount;
  return t.amount >= 0 ? t.amount - t.interest : t.amount + t.interest;
}

/** Month-end balance of a loan for every month it has activity, oldest first.
 *  Feeds the actual-vs-projected trail on the payoff chart. */
export function loanHistory(db, accountId) {
  const rows = db.prepare(
    'SELECT date, amount, interest FROM transactions WHERE account_id = ? ORDER BY date, id'
  ).all(accountId);
  const byMonth = new Map();
  let running = 0;
  for (const t of rows) {
    running += principalOf(t);
    // Months where the running total isn't a debt aren't real history: they show
    // up when payments are dated before the balance they pay down, and plotting
    // them would draw the loan above zero. Skip rather than render a fiction.
    if (running < 0) byMonth.set(t.date.slice(0, 7), running);
  }
  return [...byMonth].map(([month, balance]) => ({ month, balance }));
}

export function buildState(db, month) {
  const prev = shiftMonth(month, -1);
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY sort_order, id').all();
  const groups = db.prepare('SELECT * FROM category_groups ORDER BY sort_order, id').all();
  const cats = db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all();
  const txns = db.prepare('SELECT * FROM transactions').all();
  const assigns = db.prepare('SELECT * FROM assignments').all();

  const acctById = new Map(accounts.map(a => [a.id, a]));
  const onBudget = a => a.type !== 'loan';
  const payCatByAcct = new Map(cats.filter(c => c.linked_account_id != null).map(c => [c.linked_account_id, c.id]));
  const payCatIds = new Set(payCatByAcct.values());

  const stat = new Map(cats.map(c => [c.id, {
    assignedM: 0, assignedP: 0, assignedCumM: 0, assignedCumP: 0,
    activityM: 0, activityP: 0, activityCumM: 0, activityCumP: 0,
  }]));
  const balances = new Map(accounts.map(a => [a.id, 0]));
  let totalAssignedCum = 0;
  let incomeCumM = 0;
  let incomeM = 0;
  const uncat = { activityM: 0, availableM: 0, countM: 0 };

  // per-category net flow (assigned + activity) for each PRIOR month — used to
  // attribute the current carryover to the months it came from
  const priorNet = new Map();
  const addPriorNet = (catId, m, amount) => {
    let byMonth = priorNet.get(catId);
    if (!byMonth) priorNet.set(catId, (byMonth = new Map()));
    byMonth.set(m, (byMonth.get(m) ?? 0) + amount);
  };

  for (const as of assigns) {
    const s = stat.get(as.category_id);
    if (!s) continue;
    if (as.month === month) s.assignedM += as.amount;
    if (as.month === prev) s.assignedP += as.amount;
    if (as.month <= month) { s.assignedCumM += as.amount; totalAssignedCum += as.amount; }
    if (as.month <= prev) s.assignedCumP += as.amount;
    if (as.month < month) addPriorNet(as.category_id, as.month, as.amount);
  }

  for (const t of txns) {
    // A loan payment records the full amount paid but only its principal slice
    // moves the balance — the interest was never owed as principal. `interest`
    // is set on the loan side of a loan payment and null everywhere else.
    balances.set(t.account_id, (balances.get(t.account_id) ?? 0) + principalOf(t));
    const acct = acctById.get(t.account_id);
    if (!acct || !onBudget(acct) || t.is_transfer) continue;
    const tm = t.date.slice(0, 7);
    const inM = tm === month, inP = tm === prev;
    const inCumM = tm <= month, inCumP = tm <= prev;

    if (t.is_income) {
      if (inCumM) incomeCumM += t.amount;
      if (inM) incomeM += t.amount;
      continue;
    }
    if (t.is_starting) continue;
    if (t.category_id == null) {
      if (inM) { uncat.activityM += t.amount; uncat.countM++; }
      if (inCumM) uncat.availableM += t.amount;
      continue;
    }
    const s = stat.get(t.category_id);
    if (!s) continue;
    if (inM) s.activityM += t.amount;
    if (inP) s.activityP += t.amount;
    if (inCumM) s.activityCumM += t.amount;
    if (inCumP) s.activityCumP += t.amount;
    if (tm < month) addPriorNet(t.category_id, tm, t.amount);

    if (acct.type === 'credit' && !payCatIds.has(t.category_id)) {
      const ps = stat.get(payCatByAcct.get(acct.id));
      if (ps) {
        if (inM) ps.activityM -= t.amount;
        if (inP) ps.activityP -= t.amount;
        if (inCumM) ps.activityCumM -= t.amount;
        if (inCumP) ps.activityCumP -= t.amount;
      }
    }
  }

  let assignedTotal = 0, activityTotal = 0, availableTotal = 0, leftover = 0;
  let prevAssignedTotal = 0, prevSpentTotal = 0;

  const groupsOut = groups.map(g => ({
    id: g.id,
    name: g.name,
    isPaymentGroup: !!g.is_payment_group,
    categories: cats.filter(c => c.group_id === g.id).map(c => {
      const s = stat.get(c.id);
      const available = s.assignedCumM + s.activityCumM;
      const availablePrev = s.assignedCumP + s.activityCumP;
      assignedTotal += s.assignedM;
      activityTotal += s.activityM;
      availableTotal += available;
      leftover += availablePrev;
      prevAssignedTotal += s.assignedP;
      prevSpentTotal += Math.min(s.activityP, 0);

      // Funding segments: which months the money in this envelope came from.
      // Walk prior months chronologically; a month's positive net adds a
      // segment, a negative net consumes the OLDEST segments first (spending
      // eats old money first), leaving segments that sum to the carryover.
      // This month's assignment is the newest segment (or a consumer if
      // money was moved out).
      const segments = [];
      const consume = deficit => {
        while (deficit > 0 && segments.length) {
          const take = Math.min(segments[0].amount, deficit);
          segments[0].amount -= take;
          deficit -= take;
          if (segments[0].amount === 0) segments.shift();
        }
      };
      const byMonth = priorNet.get(c.id);
      if (byMonth) {
        for (const m of [...byMonth.keys()].sort()) {
          const net = byMonth.get(m);
          if (net > 0) segments.push({ month: m, amount: net });
          else if (net < 0) consume(-net);
        }
      }
      if (s.assignedM > 0) segments.push({ month, amount: s.assignedM });
      else if (s.assignedM < 0) consume(-s.assignedM);
      while (segments.length > 5) {
        segments[1].amount += segments[0].amount; // fold the oldest together
        segments.shift();
      }

      return {
        id: c.id,
        name: c.name,
        emoji: c.emoji,
        linkedAccountId: c.linked_account_id,
        goal: c.goal_amount ?? 0,
        assigned: s.assignedM,
        activity: s.activityM,
        available,
        segments,
      };
    }),
  }));

  return {
    month,
    prevMonth: prev,
    nextMonth: shiftMonth(month, 1),
    readyToAssign: incomeCumM - totalAssignedCum,
    incomeThisMonth: incomeM,
    accounts: accounts.map(a => ({
      id: a.id, name: a.name, type: a.type, closed: !!a.closed,
      balance: balances.get(a.id) ?? 0,
      apr: a.apr, loanMonths: a.loan_months,
      connectionId: a.connection_id, externalId: a.external_id,
      // actual month-end balances, so the payoff chart can show real progress
      // behind the projection rather than only the plan
      ...(a.type === 'loan' ? { history: loanHistory(db, a.id) } : {}),
    })),
    connections: db.prepare(
      'SELECT id, provider, name, last_sync_at, last_sync_status FROM connections ORDER BY id'
    ).all().map(c => ({
      id: c.id, provider: c.provider, name: c.name,
      lastSyncAt: c.last_sync_at, lastSyncStatus: c.last_sync_status,
    })),
    groups: groupsOut,
    uncategorized: uncat,
    summary: {
      leftover,
      assigned: assignedTotal,
      activity: activityTotal + uncat.activityM,
      available: availableTotal,
      prevAssignedTotal,
      prevSpentTotal: -prevSpentTotal,
    },
  };
}

const upsertAssign = (db, month, categoryId, amount) => db.prepare(
  `INSERT INTO assignments (month, category_id, amount) VALUES (?, ?, ?)
   ON CONFLICT(month, category_id) DO UPDATE SET amount = excluded.amount`
).run(month, categoryId, amount);

export function setAssigned(db, month, categoryId, amount) {
  upsertAssign(db, month, categoryId, amount);
}

export function coverOverspending(db, month) {
  const state = buildState(db, month);
  for (const g of state.groups) {
    for (const c of g.categories) {
      if (c.available < 0) upsertAssign(db, month, c.id, c.assigned - c.available);
    }
  }
}

/** Moves assigned money between categories (or Ready to Assign when a side is
 *  null) by adjusting this month's assignments. */
export function moveMoney(db, month, fromCategoryId, toCategoryId, amount) {
  const assigned = id => db.prepare(
    'SELECT amount FROM assignments WHERE month = ? AND category_id = ?'
  ).get(month, id)?.amount ?? 0;
  if (fromCategoryId != null) upsertAssign(db, month, fromCategoryId, assigned(fromCategoryId) - amount);
  if (toCategoryId != null) upsertAssign(db, month, toCategoryId, assigned(toCategoryId) + amount);
}

/** Assigns money to categories whose Available is below their goal, in display
 *  order, without assigning more than Ready to Assign holds. */
export function fundGoals(db, month) {
  const state = buildState(db, month);
  let rta = state.readyToAssign;
  if (rta <= 0) return;
  for (const g of state.groups) {
    for (const c of g.categories) {
      if (!c.goal || c.goal <= 0) continue;
      const underfunded = c.goal - c.available;
      if (underfunded <= 0) continue;
      const add = Math.min(underfunded, rta);
      upsertAssign(db, month, c.id, c.assigned + add);
      rta -= add;
      if (rta <= 0) return;
    }
  }
}

export function assignLastMonth(db, month) {
  const prev = shiftMonth(month, -1);
  const prevRows = db.prepare('SELECT category_id, amount FROM assignments WHERE month = ?').all(prev);
  const catIds = new Set(db.prepare('SELECT id FROM categories').all().map(r => r.id));
  for (const r of prevRows) {
    if (catIds.has(r.category_id)) upsertAssign(db, month, r.category_id, r.amount);
  }
}
