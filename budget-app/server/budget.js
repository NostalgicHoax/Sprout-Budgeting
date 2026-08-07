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

// A goal is an amount per period. The budget works a month at a time, so every
// goal has to resolve to a monthly figure — that is what Fund Goals assigns,
// what the progress bar fills, and what "Goal met" compares against. Spreading
// evenly is deliberate: the alternative, wanting the whole amount in the month
// it falls due, makes Fund Goals drain Ready to Assign in a single month.

/** Months in one period of a recurring goal. Weeks are converted at 52/12 so a
 *  weekly goal costs what it actually costs over a year, not four weeks a month. */
export function periodMonths(cat) {
  switch (cat.goal_period) {
    case 'weekly': return 12 / 52;
    case 'monthly': return 1;
    case 'quarterly': return 3;
    case 'biannual': return 6;
    case 'annual': return 12;
    case 'custom': {
      const n = Math.max(1, cat.goal_every ?? 1);
      return cat.goal_unit === 'week' ? (n * 12) / 52 : n;
    }
    default: return 1;
  }
}

/** Whole months from `month` (YYYY-MM) to `date` (YYYY-MM-DD), floored at 0. */
function monthsUntil(month, date) {
  if (!date) return 0;
  const [y1, m1] = month.split('-').map(Number);
  const [y2, m2] = date.split('-').map(Number);
  return Math.max(0, (y2 * 12 + m2) - (y1 * 12 + m1));
}

/** How much Available this category should hold by the end of `month`.
 *
 *  Everything downstream reads it that way — Fund Goals assigns the difference
 *  between this and current Available — so a by-date goal has to return a
 *  running target rather than this month's instalment, or the instalment would
 *  be counted against savings that already exist.
 *
 *  For a recurring goal it's the per-period amount spread across the period.
 *  For a by-date goal it's what was already saved plus a fair share of what's
 *  missing, so the ask self-corrects: fall behind and it rises, get ahead and it
 *  falls.
 *
 *  `saved` must exclude this month's own assignment. Measuring against current
 *  Available instead makes the target climb as you fund it — every dollar
 *  assigned shrinks the remainder, which re-spreads over a window that still
 *  counts this month, so the goal runs away from the money chasing it. */
export function monthlyGoal(cat, month, saved = 0) {
  const amount = cat.goal_amount ?? 0;
  if (amount <= 0) return 0;
  if (cat.goal_period === 'by-date') {
    const banked = Math.max(0, saved);
    const remaining = Math.max(0, amount - banked);
    if (remaining === 0) return amount;
    // the due month counts itself, so a goal due this month asks for all of it
    const left = Math.max(1, monthsUntil(month, cat.goal_date) + 1);
    return Math.min(amount, banked + Math.ceil(remaining / left));
  }
  return Math.round(amount / periodMonths(cat));
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
        // `goal` stays the monthly figure everything downstream already works
        // in; the period fields ride alongside so the UI can say where it came
        // from ("$1,200 a year") without recomputing it
        // available minus this month's assignment = what was banked coming in
        goal: monthlyGoal(c, month, available - s.assignedM),
        goalAmount: c.goal_amount ?? 0,
        goalPeriod: c.goal_period ?? null,
        goalEvery: c.goal_every ?? null,
        goalUnit: c.goal_unit ?? null,
        goalDate: c.goal_date ?? null,
        assigned: s.assignedM,
        activity: s.activityM,
        available,
        // How much this goal has actually been fed, which is not the same as
        // what's left in the envelope. Fund a $20 gym goal and spend the $20 and
        // Available is back to nothing — measuring progress against Available
        // then reads "$0 of $20" and asks for another $20, even though the goal
        // was met. Adding this month's spending back answers the real question:
        // was the money there for it.
        //
        // A by-date goal is the exception and stays on Available, because it
        // targets a balance. Spending the holiday fund really does mean the
        // holiday fund no longer holds what it needs.
        funded: c.goal_period === 'by-date' ? available : available - Math.min(0, s.activityM),
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

/** How many months until this category's money is actually wanted. Drives which
 *  categories give money back first when you've assigned more than you have.
 *
 *  A category with no goal has nothing scheduled against it, so it ranks
 *  furthest out and is raided first. A by-date goal uses its real deadline.
 *  Everything else uses its period: an annual goal doesn't need its money again
 *  for a year, a weekly one needs it next week. */
function fundingHorizon(cat, month) {
  if (!cat.goalAmount || cat.goalAmount <= 0) return Infinity;
  if (cat.goalPeriod === 'by-date') {
    if (!cat.goalDate) return Infinity;
    const [y1, m1] = month.split('-').map(Number);
    const [y2, m2] = cat.goalDate.split('-').map(Number);
    return (y2 * 12 + m2) - (y1 * 12 + m1);
  }
  return periodMonths({
    goal_period: cat.goalPeriod, goal_every: cat.goalEvery, goal_unit: cat.goalUnit,
  });
}

/** The inverse of fundGoals: when more has been assigned than exists, take it
 *  back, starting with the categories whose money is needed furthest out.
 *
 *  A category can only give back what is still sitting there — money already
 *  spent can't be unassigned without driving Available negative, which would
 *  turn an over-assignment into an overspend. Returns what it managed to
 *  recover, which can be less than the shortfall if the money has been spent. */
export function recoverOverassigned(db, month) {
  const state = buildState(db, month);
  let short = -state.readyToAssign;
  if (short <= 0) return { recovered: 0, shortfall: 0, categories: [] };

  const candidates = [];
  for (const g of state.groups) {
    for (const c of g.categories) {
      const givable = Math.max(0, Math.min(c.assigned, c.available));
      if (givable > 0) candidates.push({ ...c, givable, horizon: fundingHorizon(c, month) });
    }
  }
  // furthest-out money first; ties fall back to the larger pot so fewer
  // categories get disturbed
  candidates.sort((a, b) => (b.horizon - a.horizon) || (b.givable - a.givable));

  const touched = [];
  let recovered = 0;
  for (const c of candidates) {
    if (short <= 0) break;
    const take = Math.min(c.givable, short);
    upsertAssign(db, month, c.id, c.assigned - take);
    touched.push({ id: c.id, name: c.name, amount: take });
    recovered += take;
    short -= take;
  }
  return { recovered, shortfall: Math.max(0, short), categories: touched };
}

/** Clears every assignment for the month, handing the whole lot back to Ready to
 *  Assign so the month can be budgeted again from scratch.
 *
 *  Unlike recoverOverassigned this does not stop at what is unspent, because it
 *  isn't trying to fix anything — it is a deliberate start-over. Categories
 *  already spent from will read overspent until they are re-assigned, which is
 *  true rather than broken: that money is gone and still has to be budgeted
 *  for. `spent` counts them so the UI can say so before the user commits.
 *
 *  Rows are deleted rather than zeroed; a missing row already means nothing
 *  assigned, and leaving zeroes behind would just be litter. */
export function resetAssignments(db, month) {
  const state = buildState(db, month);
  const cats = state.groups.flatMap(g => g.categories);
  const assigned = cats.filter(c => c.assigned !== 0);
  const returned = assigned.reduce((s, c) => s + c.assigned, 0);
  const spent = cats.filter(c => c.assigned !== 0 && c.activity < 0);
  db.prepare('DELETE FROM assignments WHERE month = ?').run(month);
  return {
    cleared: assigned.length,
    returned,
    spent: spent.map(c => ({ id: c.id, name: c.name, activity: c.activity })),
  };
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
      const underfunded = c.goal - c.funded;
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
