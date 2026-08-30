import { useEffect, useState } from 'react';
import { fmt, monthLabel } from '../money.js';
import { api } from '../api.js';
import { usePhone } from '../useNarrow.js';

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// Three fits the cell at its natural height. A fourth pushed the row taller,
// and because grid rows size together every other week in the month grew with
// it — one busy Tuesday and the whole calendar stopped fitting on screen.
const VISIBLE_CHIPS = 3;

/** What a day cost, for the spending view. The sign is carried by the figure
 *  itself as well as the colour, so the two directions are still told apart
 *  without relying on red and green. */
function DayFlow({ flow }) {
  if (!flow || (flow.in === 0 && flow.out === 0)) {
    return <div className="cal-flow quiet">—</div>;
  }
  const net = flow.in - flow.out;
  return (
    <div className={`cal-flow ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}`}>
      <div className="cal-flow-net">{fmt(net)}</div>
      {flow.in > 0 && flow.out > 0 && (
        <div className="cal-flow-split">
          <span className="pos">{fmt(flow.in)}</span>
          <span className="neg">{fmt(-flow.out)}</span>
        </div>
      )}
    </div>
  );
}

/** One transaction, in either layout. The grid shows at most three of these
 *  in a cell; the list shows every one a day has. */
function DayChip({ c, setView }) {
  return (
    <div
      className={`cal-chip ${c.projected ? 'projected' : ''} ${c.amount > 0 ? 'inflow' : ''}`}
      title={`${c.payee || '(no payee)'} — ${fmt(c.amount)}${c.projected ? ' · upcoming recurring' : c.is_recurring ? ' · recurring' : ''}${c.memo ? `\n${c.memo}` : ''}`}
      onClick={() => !c.projected && setView({ type: 'account', accountId: c.account_id })}
    >
      <span className="chip-payee">{(c.is_recurring || c.projected) ? '🔁 ' : ''}{c.payee || (c.is_transfer ? `⇄ ${c.transfer_account_name || 'Transfer'}` : c.category_name) || 'Transaction'}</span>
      <span className="chip-amt">{fmt(c.amount)}</span>
    </div>
  );
}

export default function CalendarView({ state, month, setMonth, setView }) {
  const [txns, setTxns] = useState(null);
  const [showCleared, setShowCleared] = useState(true);
  const [showRecurring, setShowRecurring] = useState(true);
  const [dayPopup, setDayPopup] = useState(null); // { day, anchor }
  const [mode, setMode] = useState('transactions'); // 'transactions' | 'spending'
  const phone = usePhone();

  useEffect(() => { api('/api/transactions').then(setTxns); }, []);

  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const firstDow = new Date(y, m - 1, 1).getDay();

  // One chip per real transaction this month; recurring transactions from past
  // months project forward as dashed "upcoming" chips on their day-of-month,
  // unless a matching real transaction (account + payee + day) already posted.
  const byDay = new Map();
  if (txns) {
    const push = c => {
      const day = Number(c.date.slice(8, 10));
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(c);
    };
    const dayOf = t => t.date.slice(8, 10);
    const seriesKey = t => `${t.account_id}|${t.payee}|${dayOf(t)}`;
    const real = txns.filter(t => !t.is_starting && t.date.slice(0, 7) === month);
    for (const t of real) {
      if ((showCleared && t.cleared) || (showRecurring && t.is_recurring)) {
        push({ ...t, projected: false });
      }
    }
    if (showRecurring) {
      const posted = new Set(real.map(seriesKey));
      const latest = new Map();
      for (const t of txns) {
        if (!t.is_recurring || t.is_starting || t.date.slice(0, 7) >= month) continue;
        const k = seriesKey(t);
        if (!latest.has(k) || latest.get(k).date < t.date) latest.set(k, t);
      }
      for (const [k, t] of latest) {
        if (posted.has(k)) continue;
        const day = Math.min(Number(dayOf(t)), daysInMonth);
        push({ ...t, id: `proj-${t.id}`, date: `${month}-${String(day).padStart(2, '0')}`, projected: true });
      }
    }
    for (const list of byDay.values()) {
      list.sort((a, b) => (a.projected - b.projected) || (b.amount - a.amount));
    }
  }

  // What was actually spent or received each day. Same exclusions as the Income
  // vs Expenses report, so the two views of a month can never disagree:
  // transfers between your own accounts are not spending, starting balances are
  // not income you earned, balance adjustments are reconciliation noise, and
  // loan accounts are tracking-only.
  const flowByDay = new Map();
  if (txns) {
    for (const t of txns) {
      if (t.date.slice(0, 7) !== month) continue;
      if (t.is_starting || t.is_transfer) continue;
      if (t.account_type === 'loan') continue;
      if (t.payee === 'Balance Adjustment') continue;
      const day = Number(t.date.slice(8, 10));
      const f = flowByDay.get(day) ?? { in: 0, out: 0 };
      if (t.amount > 0) f.in += t.amount; else f.out += -t.amount;
      flowByDay.set(day, f);
    }
  }
  const monthNet = [...flowByDay.values()].reduce((s2, f) => s2 + f.in - f.out, 0);

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const now = new Date();
  const todayDay = now.getFullYear() === y && now.getMonth() + 1 === m ? now.getDate() : null;

  const rta = state.readyToAssign;

  return (
    <main className="main">
      <header className="topbar">
        <div className="month-nav">
          <button className="round-btn" onClick={() => setMonth(state.prevMonth)}>‹</button>
          <div className="month-label">{monthLabel(month)}</div>
          <button className="round-btn" onClick={() => setMonth(state.nextMonth)}>›</button>
        </div>
        <div className="rta-wrap">
          <div className={`rta-box ${rta < 0 ? 'rta-neg' : ''}`}>
            <div>
              <div className="rta-amount">{fmt(rta)}</div>
              <div className="rta-label">{rta < 0 ? 'Overassigned' : 'Ready to Assign'}</div>
            </div>
          </div>
        </div>
      </header>

      <div className="filter-tabs">
        <span
          className={`filter-tab ${mode === 'transactions' ? 'active' : ''}`}
          onClick={() => setMode('transactions')}
          title="Show each transaction on the day it happened"
        >
          Transactions
        </span>
        <span
          className={`filter-tab ${mode === 'spending' ? 'active' : ''}`}
          onClick={() => setMode('spending')}
          title="Show what each day cost you, in and out"
        >
          Spending
        </span>
        <span className="cal-tab-gap" />
        {mode === 'transactions' ? (
          <>
            <span
              className={`filter-tab toggle ${showCleared ? 'active' : ''}`}
              onClick={() => setShowCleared(v => !v)}
              title="Show transactions that have cleared"
            >
              ✓ Cleared
            </span>
            <span
              className={`filter-tab toggle ${showRecurring ? 'active' : ''}`}
              onClick={() => setShowRecurring(v => !v)}
              title="Show recurring transactions, including upcoming ones"
            >
              🔁 Recurring
            </span>
            <span className="cal-legend">
              <span className="cal-chip demo">Posted</span>
              <span className="cal-chip demo projected">Upcoming recurring</span>
            </span>
          </>
        ) : (
          /* the cleared and recurring toggles hide chips; they have no meaning
             for a figure that is asking what actually moved */
          <span className="cal-legend cal-month-net">
            <span>Net this month</span>
            <strong className={monthNet > 0 ? 'pos-amt' : monthNet < 0 ? 'neg-amt' : ''}>{fmt(monthNet)}</strong>
          </span>
        )}
      </div>

      <div className="calendar-wrap">
        {/* Seven columns of a 390px screen is 50px a day — too little for a
            date and an amount, let alone a payee. On a phone the month runs
            down the page instead: one row per day, the 1st at the top. Every
            transaction a day has is shown, because rows in a list do not share
            a height, which is the only thing the three-chip cap was ever for.
            Tapping a day still opens it; tapping a chip still opens its
            account; both modes and both filters work as they do on a grid. */}
        {phone ? (
          <div className="calendar-list">
            {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => {
              const chips = byDay.get(d) ?? [];
              return (
                <div
                  key={d}
                  className={`cal-day-row ${d === todayDay ? 'today' : ''}`}
                  onClick={e => {
                    if (e.target.closest('.cal-chip')) return;
                    setDayPopup({ day: d, anchor: e.currentTarget.getBoundingClientRect() });
                  }}
                >
                  <div className="cal-day-mark">
                    <span className="cal-dow">{DOW[new Date(y, m - 1, d).getDay()]}</span>
                    <span className="cal-dnum">{d}</span>
                  </div>
                  <div className="cal-day-body">
                    {mode === 'spending'
                      ? <DayFlow flow={flowByDay.get(d)} />
                      : chips.length === 0
                        ? <div className="cal-flow quiet">—</div>
                        : chips.map(c => <DayChip key={c.id} c={c} setView={setView} />)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
        <>
        <div className="calendar-head">
          {DOW.map(d => <div key={d}>{d}</div>)}
        </div>
        <div className="calendar-grid">
          {cells.map((d, i) => {
            const chips = d ? byDay.get(d) ?? [] : [];
            return (
              <div
                key={i}
                className={`cal-cell ${d == null ? 'empty' : ''} ${d === todayDay ? 'today' : ''}`}
                onClick={e => {
                  if (!d) return;
                  if (e.target.closest('.cal-chip')) return; // chips keep their own click-through
                  setDayPopup({ day: d, anchor: e.currentTarget.getBoundingClientRect() });
                }}
              >
                {d && <div className="cal-day"><span>{d}</span></div>}
                {d && mode === 'spending' && <DayFlow flow={flowByDay.get(d)} />}
                {mode === 'transactions' && chips.slice(0, VISIBLE_CHIPS).map(c => (
                  <DayChip key={c.id} c={c} setView={setView} />
                ))}
                {mode === 'transactions' && chips.length > VISIBLE_CHIPS && (
                  <div className="cal-more" title="Open this day to see them all">
                    +{chips.length - VISIBLE_CHIPS} more…
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </>
        )}
      </div>

      {dayPopup && (
        <DayPopover
          day={dayPopup.day}
          anchor={dayPopup.anchor}
          month={month}
          chips={byDay.get(dayPopup.day) ?? []}
          setView={setView}
          onClose={() => setDayPopup(null)}
        />
      )}
    </main>
  );
}

function DayPopover({ day, anchor, month, chips, setView, onClose }) {
  const [y, m] = month.split('-').map(Number);
  const label = new Date(y, m - 1, day).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  const total = chips.reduce((s, c) => s + c.amount, 0);

  // Open downward when there's room; otherwise flip above the cell. Either way
  // the popover is height-capped and the list scrolls inside it.
  const MAX_H = 420;
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - 344));
  const spaceBelow = window.innerHeight - anchor.bottom - 18;
  const spaceAbove = anchor.top - 18;
  const openUp = spaceBelow < 280 && spaceAbove > spaceBelow;
  const style = openUp
    ? { position: 'fixed', bottom: window.innerHeight - anchor.top + 6, left, maxHeight: Math.max(180, Math.min(MAX_H, spaceAbove)) }
    : { position: 'fixed', top: anchor.bottom + 6, left, maxHeight: Math.max(180, Math.min(MAX_H, spaceBelow)) };

  return (
    <>
      <div className="menu-overlay" onClick={onClose} />
      <div className="popover day-popover" style={style}>
        <div className="popover-title day-pop-head">
          <span>{label}</span>
          <button className="icon-btn" title="Close" onClick={onClose}>✕</button>
        </div>
        {chips.length === 0 && <p className="panel-hint">No transactions on this day.</p>}
        {chips.length > 0 && (
          <div className="day-pop-list">
            {chips.map(c => (
              <div
                key={c.id}
                className={`day-pop-row ${c.projected ? 'projected' : ''}`}
                title={c.projected ? 'Upcoming recurring — not posted yet' : `Open ${c.account_name}`}
                onClick={() => { if (!c.projected) setView({ type: 'account', accountId: c.account_id }); }}
              >
                <div className="day-pop-main">
                  <span className="day-pop-payee">
                    {(c.is_recurring || c.projected) ? '🔁 ' : ''}
                    {c.payee || (c.is_transfer ? `⇄ ${c.transfer_account_name || 'Transfer'}` : c.category_name) || 'Transaction'}
                    {c.projected ? ' · upcoming' : ''}
                  </span>
                  <span className="day-pop-sub">
                    {c.account_name}
                    {c.category_name ? ` · ${c.category_emoji ? `${c.category_emoji} ` : ''}${c.category_name}`
                      : c.is_income ? ' · 💵 Ready to Assign'
                      : c.is_transfer ? ' · 🔁 Transfer / Payment'
                      : ' · Uncategorized'}
                    {c.memo ? ` · ${c.memo}` : ''}
                  </span>
                </div>
                <span className={`day-pop-amt ${c.amount > 0 ? 'pos-amt' : ''}`}>{fmt(c.amount)}</span>
              </div>
            ))}
          </div>
        )}
        {chips.length > 1 && (
          <div className="day-pop-total">
            <span>Net total</span>
            <span className={total > 0 ? 'pos-amt' : total < 0 ? 'neg-amt' : ''}>{fmt(total)}</span>
          </div>
        )}
      </div>
    </>
  );
}
