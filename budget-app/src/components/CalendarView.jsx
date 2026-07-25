import { useEffect, useState } from 'react';
import { fmt, monthLabel } from '../money.js';
import { api } from '../api.js';

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export default function CalendarView({ state, month, setMonth, setView }) {
  const [txns, setTxns] = useState(null);
  const [showCleared, setShowCleared] = useState(true);
  const [showRecurring, setShowRecurring] = useState(true);
  const [dayPopup, setDayPopup] = useState(null); // { day, anchor }

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
      </div>

      <div className="calendar-wrap">
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
                {chips.slice(0, 4).map(c => (
                  <div
                    key={c.id}
                    className={`cal-chip ${c.projected ? 'projected' : ''} ${c.amount > 0 ? 'inflow' : ''}`}
                    title={`${c.payee || '(no payee)'} — ${fmt(c.amount)}${c.projected ? ' · upcoming recurring' : c.is_recurring ? ' · recurring' : ''}${c.memo ? `\n${c.memo}` : ''}`}
                    onClick={() => !c.projected && setView({ type: 'account', accountId: c.account_id })}
                  >
                    <span className="chip-payee">{(c.is_recurring || c.projected) ? '🔁 ' : ''}{c.payee || (c.is_transfer ? `⇄ ${c.transfer_account_name || 'Transfer'}` : c.category_name) || 'Transaction'}</span>
                    <span className="chip-amt">{fmt(c.amount)}</span>
                  </div>
                ))}
                {chips.length > 4 && (
                  <div className="cal-more">+{chips.length - 4} more</div>
                )}
              </div>
            );
          })}
        </div>
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
