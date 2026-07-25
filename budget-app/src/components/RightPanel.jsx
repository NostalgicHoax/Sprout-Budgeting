import { useEffect, useState } from 'react';
import { fmt, fmtDate, monthLabel, monthName, parseAmount } from '../money.js';
import { api } from '../api.js';
import ConfirmButton from './ConfirmButton.jsx';

export default function RightPanel({ state, month, refresh, selectedCat, onCloseInspector, setView }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('rightPanelCollapsed') === '1');

  // picking a category should always reveal the inspector
  useEffect(() => {
    if (selectedCat) setCollapsed(false);
  }, [selectedCat?.id]);

  function toggle() {
    setCollapsed(c => {
      localStorage.setItem('rightPanelCollapsed', c ? '0' : '1');
      return !c;
    });
  }

  if (collapsed) {
    return (
      <aside className="right-panel collapsed" onClick={toggle} title="Expand panel">
        <span className="panel-toggle">«</span>
        <div className="collapsed-label">
          {selectedCat ? selectedCat.name : `${monthName(month)}'s Summary`}
        </div>
      </aside>
    );
  }

  return selectedCat ? (
    <CategoryInspector
      key={selectedCat.id}
      cat={selectedCat}
      month={month}
      rta={state.readyToAssign}
      refresh={refresh}
      onClose={onCloseInspector}
      onCollapse={toggle}
      setView={setView}
    />
  ) : (
    <SummaryPanel state={state} month={month} refresh={refresh} onCollapse={toggle} />
  );
}

function SummaryPanel({ state, month, refresh, onCollapse }) {
  const { summary } = state;
  const allCats = state.groups.flatMap(g => g.categories);
  const overspentTotal = allCats.reduce((s, c) => s + Math.min(c.available, 0), 0);

  async function autoAssign(mode) {
    await api('/api/auto-assign', { method: 'POST', body: { month, mode } });
    await refresh();
  }

  return (
    <aside className="right-panel">
      <div className="panel-head">
        <div className="panel-title">{monthName(month)}'s Summary</div>
        <button className="panel-toggle" title="Collapse panel" onClick={onCollapse}>»</button>
      </div>
      <section className="insp-section">
        <div className="stat-block">
          <div className="summary-row"><span>Left Over from Last Month</span><span>{fmt(summary.leftover)}</span></div>
          <div className="summary-row"><span>Assigned in {monthName(month)}</span><span>{fmt(summary.assigned)}</span></div>
          <div className="summary-row"><span>Activity</span><span>{fmt(summary.activity)}</span></div>
          <div className="summary-row bold total"><span>Available</span><span>{fmt(summary.available)}</span></div>
        </div>
      </section>

      <section className="insp-section">
        <div className="insp-label">⚡ AUTO-ASSIGN</div>
        <div className="auto-list">
          <button
            className="auto-item"
            disabled={overspentTotal === 0}
            onClick={() => autoAssign('cover-overspending')}
            title="Assign enough to bring overspent categories back to zero"
          >
            <span>Cover Overspending</span><span>{fmt(-overspentTotal)}</span>
          </button>
          <button
            className="auto-item"
            disabled={summary.prevAssignedTotal === 0}
            onClick={() => autoAssign('assigned-last-month')}
            title="Repeat last month's assignments"
          >
            <span>Assigned Last Month</span><span>{fmt(summary.prevAssignedTotal)}</span>
          </button>
        </div>
      </section>

      {/* figures, not actions — they were styled as buttons and read as two
          more things to click */}
      <section className="insp-section">
        <div className="insp-label">FOR REFERENCE</div>
        <div className="stat-block">
          <div className="summary-row"><span>Spent Last Month</span><span>{fmt(summary.prevSpentTotal)}</span></div>
          <div className="summary-row"><span>Income This Month</span><span>{fmt(state.incomeThisMonth)}</span></div>
        </div>
        <p className="panel-hint">Select a category to see its goal, history, and recent spending.</p>
      </section>
    </aside>
  );
}

function CategoryInspector({ cat, month, rta, refresh, onClose, onCollapse, setView }) {
  const [details, setDetails] = useState(null);
  const [goalInput, setGoalInput] = useState('');
  const [savingGoal, setSavingGoal] = useState(false);
  const [nameInput, setNameInput] = useState(cat.name);
  const [manageMsg, setManageMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api(`/api/categories/${cat.id}/details?month=${month}`).then(d => {
      if (!live) return;
      setDetails(d);
      setGoalInput(d.category.goal > 0 ? (d.category.goal / 100).toFixed(2) : '');
    }).catch(() => {});
    return () => { live = false; };
  }, [cat.id, month, cat.assigned, cat.activity, cat.available, cat.goal]);

  const underfunded = cat.goal > 0 ? Math.max(0, cat.goal - cat.available) : 0;
  const fundable = Math.min(underfunded, Math.max(0, rta));

  async function saveGoal() {
    const trimmed = goalInput.trim();
    const cents = trimmed === '' ? null : parseAmount(trimmed);
    if (trimmed !== '' && (cents == null || cents < 0)) return;
    setSavingGoal(true);
    try {
      await api(`/api/categories/${cat.id}`, { method: 'PATCH', body: { goal: cents } });
      await refresh();
    } catch (e) {
      alert(e.message);
    }
    setSavingGoal(false);
  }

  async function fundGoal() {
    await api('/api/move-money', {
      method: 'POST',
      body: { month, fromCategoryId: null, toCategoryId: cat.id, amount: fundable },
    });
    await refresh();
  }

  async function saveName() {
    const name = nameInput.trim();
    if (!name || name === cat.name) return;
    setBusy(true);
    setManageMsg(null);
    try {
      await api(`/api/categories/${cat.id}`, { method: 'PATCH', body: { name } });
      await refresh();
      setManageMsg({ text: 'Renamed.' });
    } catch (e) {
      setManageMsg({ error: true, text: e.message });
    }
    setBusy(false);
  }

  async function removeCategory() {
    setBusy(true);
    setManageMsg(null);
    try {
      await api(`/api/categories/${cat.id}`, { method: 'DELETE' });
      await refresh();
      onClose(); // the category is gone — fall back to the summary
    } catch (e) {
      setManageMsg({ error: true, text: e.message });
      setBusy(false);
    }
  }

  const goalChanged = details && goalInput.trim() !== (details.category.goal > 0 ? (details.category.goal / 100).toFixed(2) : '');

  return (
    <aside className="right-panel">
      <div className="panel-head">
        <div className="panel-head-text">
          <div className="panel-title ellipsis">{cat.emoji ? `${cat.emoji} ` : ''}{cat.name}</div>
          {details && <div className="insp-group">{details.category.groupName}</div>}
        </div>
        <span className="panel-head-actions">
          <button className="panel-toggle" title="Back to summary" onClick={onClose}>✕</button>
          <button className="panel-toggle" title="Collapse panel" onClick={onCollapse}>»</button>
        </span>
      </div>

      <section className="insp-section">
        <div className="insp-label">THIS MONTH</div>
        <div className="stat-block">
          <div className="summary-row"><span>Assigned</span><span>{fmt(cat.assigned)}</span></div>
          <div className="summary-row"><span>Activity</span><span>{fmt(cat.activity)}</span></div>
          <div className="summary-row bold total">
            <span>Available</span>
            <span className={cat.available < 0 ? 'neg-amt' : cat.available > 0 ? 'pos-amt' : ''}>{fmt(cat.available)}</span>
          </div>
        </div>
      </section>

      <section className="insp-section">
        <div className="insp-label">🎯 MONTHLY GOAL</div>
        <div className="insp-goal-row">
          <input
            inputMode="decimal"
            placeholder="No goal — enter amount"
            value={goalInput}
            onChange={e => setGoalInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && saveGoal()}
          />
          <button className="btn btn-accent btn-sm" disabled={savingGoal || !goalChanged} onClick={saveGoal}>Save</button>
        </div>
        {cat.goal > 0 && (
          <>
            <div className="bar-track insp-bar">
              <div
                className="bar-fill"
                style={{
                  width: `${Math.min(100, (Math.max(0, cat.available) / cat.goal) * 100)}%`,
                  background: cat.available >= cat.goal ? 'var(--accent)' : 'var(--yellow)',
                }}
              />
            </div>
            <div className="insp-goal-status">
              {cat.available >= cat.goal ? (
                <span>Goal met — {fmt(cat.goal)}</span>
              ) : (
                <>
                  <span>{fmt(cat.available)} of {fmt(cat.goal)} · needs {fmt(underfunded)}</span>
                  {fundable > 0 && (
                    <button className="btn btn-accent btn-sm" onClick={fundGoal}>Fund {fmt(fundable)}</button>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </section>

      {details && (
        <>
          <section className="insp-section">
            <div className="insp-label">LAST 6 MONTHS</div>
            <div className="hist-table">
              <div className="hist-row head"><span>MONTH</span><span className="num">ASSIGNED</span><span className="num">ACTIVITY</span></div>
              {details.months.map(m => (
                <div key={m.month} className={`hist-row ${m.month === month ? 'current' : ''}`}>
                  <span>{monthLabel(m.month)}</span>
                  <span className="num">{fmt(m.assigned)}</span>
                  <span className="num">{fmt(m.activity)}</span>
                </div>
              ))}
              <div className="hist-foot">
                <div className="summary-row insp-avg"><span>Avg assigned / month</span><span>{fmt(details.stats.avgAssigned)}</span></div>
                <div className="summary-row insp-avg"><span>Avg spent / month</span><span>{fmt(details.stats.avgSpent)}</span></div>
              </div>
            </div>
          </section>

          <section className="insp-section">
            <div className="insp-label">RECENT TRANSACTIONS</div>
            {details.transactions.length === 0 && <p className="panel-hint">No transactions in this category yet.</p>}
            {details.transactions.slice(0, 8).map(t => (
              <div key={t.id} className="txn-mini">
                <span className="txn-mini-main">
                  <span className="txn-mini-payee">{t.is_recurring ? '🔁 ' : ''}{t.payee || '(no payee)'}</span>
                  <span className="txn-mini-date">{fmtDate(t.date)} · {t.account_name}</span>
                </span>
                <span className={`txn-mini-amt ${t.amount > 0 ? 'pos-amt' : ''}`}>{fmt(t.amount)}</span>
              </div>
            ))}
            {details.transactions.length > 0 && (
              <span className="insp-link" onClick={() => setView({ type: 'category', categoryId: cat.id })}>
                View all transactions →
              </span>
            )}
          </section>
        </>
      )}

      {cat.linkedAccountId == null && (
        <section className="insp-section">
          <div className="insp-label">MANAGE</div>
          <div className="insp-goal-row">
            <input
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveName()}
              placeholder="Category name"
            />
            <button
              className="btn btn-accent btn-sm"
              disabled={busy || !nameInput.trim() || nameInput.trim() === cat.name}
              onClick={saveName}
            >
              Rename
            </button>
          </div>
          <ConfirmButton
            className="btn btn-danger btn-sm insp-delete"
            label="Delete category"
            confirmLabel="Confirm delete"
            disabled={busy}
            onConfirm={removeCategory}
          />
          {manageMsg && (
            <p className={manageMsg.error ? 'modal-error' : 'sec-success'}>{manageMsg.text}</p>
          )}
        </section>
      )}
    </aside>
  );
}
