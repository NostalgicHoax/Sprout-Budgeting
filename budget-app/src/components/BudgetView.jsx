import { useState } from 'react';
import { fmt, parseAmount, monthLabel } from '../money.js';
import { api } from '../api.js';
import RightPanel from './RightPanel.jsx';
import ConfirmButton from './ConfirmButton.jsx';

export default function BudgetView({ state, month, setMonth, refresh, setView }) {
  const [filter, setFilter] = useState('all');
  const [collapsed, setCollapsed] = useState({});
  const [addingGroup, setAddingGroup] = useState(false);
  const [addingCatFor, setAddingCatFor] = useState(null);
  const [assignAnchor, setAssignAnchor] = useState(null);
  const [selectedCatId, setSelectedCatId] = useState(null);

  const allCats = state.groups.flatMap(g => g.categories);
  const selectedCat = allCats.find(c => c.id === selectedCatId) ?? null;
  const overspentCount = allCats.filter(c => c.available < 0).length;
  const matches = c =>
    filter === 'all' ? true :
    filter === 'overspent' ? c.available < 0 :
    c.available > 0;

  const rta = state.readyToAssign;

  async function saveGroup(name) {
    if (name.trim()) {
      await api('/api/groups', { method: 'POST', body: { name } });
      await refresh();
    }
    setAddingGroup(false);
  }

  return (
    <>
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
              <button
                className="rta-assign-btn"
                onClick={e => setAssignAnchor(e.currentTarget.getBoundingClientRect())}
              >
                Assign <span className="rta-caret">▾</span>
              </button>
            </div>
          </div>
          {assignAnchor && (
            <RtaAssignMenu
              anchor={assignAnchor}
              state={state}
              month={month}
              refresh={refresh}
              onClose={() => setAssignAnchor(null)}
            />
          )}
        </header>

        <div className="filter-tabs">
          <FilterTab active={filter === 'all'} onClick={() => setFilter('all')}>All</FilterTab>
          <FilterTab active={filter === 'overspent'} onClick={() => setFilter('overspent')} warn={overspentCount > 0}>
            {overspentCount > 0 ? `⚠ ${overspentCount} Overspent` : 'Overspent'}
          </FilterTab>
          <FilterTab active={filter === 'available'} onClick={() => setFilter('available')}>Money Available</FilterTab>
        </div>

        <div className="toolbar">
          {addingGroup ? (
            <InlineInput placeholder="New group name" onCommit={saveGroup} onCancel={() => setAddingGroup(false)} />
          ) : (
            <span className="toolbar-action" onClick={() => setAddingGroup(true)}>
              <span className="toolbar-plus">＋</span>
              <span>Category Group</span>
            </span>
          )}
        </div>

        <div className="table-scroll">
        <div className="grid-row col-head">
          <div>CATEGORY</div>
          <div className="num">ASSIGNED</div>
          <div className="num">ACTIVITY</div>
          <div className="num">AVAILABLE</div>
        </div>

        <div className="table-body">
          {(state.uncategorized.activityM !== 0 || state.uncategorized.availableM !== 0) && filter === 'all' && (
            <div className="grid-row row">
              <div className="cat-cell"><span className="cat-name plain">Uncategorized Transactions</span></div>
              <div className="num muted">–</div>
              <div className="num">{fmt(state.uncategorized.activityM)}</div>
              <div className="num"><span className="pill yellow">{fmt(state.uncategorized.availableM)}</span></div>
            </div>
          )}

          {state.groups.map(g => (
            <Group
              key={g.id}
              group={g}
              month={month}
              refresh={refresh}
              setView={setView}
              allGroups={state.groups}
              accounts={state.accounts}
              visibleCats={g.categories.filter(matches)}
              open={!collapsed[g.id]}
              onToggle={() => setCollapsed(c => ({ ...c, [g.id]: !c[g.id] }))}
              adding={addingCatFor === g.id}
              setAdding={v => setAddingCatFor(v ? g.id : null)}
              filtered={filter !== 'all'}
              selectedCatId={selectedCatId}
              onSelectCat={id => setSelectedCatId(cur => (cur === id ? null : id))}
            />
          ))}
        </div>
        </div>
      </main>

      <RightPanel
        state={state}
        month={month}
        refresh={refresh}
        selectedCat={selectedCat}
        onCloseInspector={() => setSelectedCatId(null)}
        setView={setView}
      />
    </>
  );
}

function FilterTab({ active, warn, onClick, children }) {
  return (
    <span className={`filter-tab ${active ? 'active' : ''} ${warn ? 'warn' : ''}`} onClick={onClick}>
      {children}
    </span>
  );
}

function Group({ group, month, refresh, setView, allGroups, accounts, visibleCats, open, onToggle, adding, setAdding, filtered, selectedCatId, onSelectCat }) {
  const [renaming, setRenaming] = useState(false);
  if (filtered && visibleCats.length === 0) return null;

  const totals = group.categories.reduce(
    (t, c) => ({ assigned: t.assigned + c.assigned, activity: t.activity + c.activity, available: t.available + c.available }),
    { assigned: 0, activity: 0, available: 0 }
  );

  async function rename(name) {
    if (name.trim() && name.trim() !== group.name) {
      await api(`/api/groups/${group.id}`, { method: 'PATCH', body: { name } });
      await refresh();
    }
    setRenaming(false);
  }

  async function remove() {
    try {
      await api(`/api/groups/${group.id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  async function addCategory(name) {
    const trimmed = name.trim();
    if (trimmed) {
      // A leading emoji becomes the category icon.
      const m = trimmed.match(/^(\p{Extended_Pictographic}(?:️)?)\s*(.*)$/u);
      const body = m && m[2]
        ? { groupId: group.id, emoji: m[1], name: m[2] }
        : { groupId: group.id, name: trimmed };
      await api('/api/categories', { method: 'POST', body });
      await refresh();
    }
    setAdding(false);
  }

  return (
    <>
      <div className="grid-row group-head">
        <div className="cat-cell">
          <div className="cat-line">
            <span className="caret" onClick={onToggle}>{open ? '▾' : '▸'}</span>
            {renaming ? (
              <InlineInput initial={group.name} onCommit={rename} onCancel={() => setRenaming(false)} />
            ) : (
              <span className="group-name" onClick={() => !group.isPaymentGroup && setRenaming(true)}>{group.name}</span>
            )}
            {!group.isPaymentGroup && !renaming && (
              <span className="row-actions">
                <button className="icon-btn" title="Add category" onClick={() => setAdding(true)}>＋</button>
                {group.categories.length === 0 && (
                  <ConfirmButton
                    className="icon-btn"
                    label="✕"
                    confirmLabel="Delete group?"
                    title="Delete group"
                    onConfirm={remove}
                  />
                )}
              </span>
            )}
          </div>
        </div>
        <div className="num strong">{fmt(totals.assigned)}</div>
        <div className="num strong">{fmt(totals.activity)}</div>
        <div className="num">
          {group.isPaymentGroup ? (
            <div className="payment-avail">
              <div className="payment-tag">ⓘ PAYMENT</div>
              <div className="strong">{fmt(totals.available)}</div>
            </div>
          ) : (
            <span className="strong">{fmt(totals.available)}</span>
          )}
        </div>
      </div>

      {adding && (
        <div className="grid-row row">
          <div className="cat-cell indent">
            <InlineInput placeholder="New category (emoji optional, e.g. 🎮 Games)" onCommit={addCategory} onCancel={() => setAdding(false)} />
          </div>
          <div /><div /><div />
        </div>
      )}

      {open && visibleCats.map(c => (
        <CategoryRow
          key={c.id}
          cat={c}
          month={month}
          refresh={refresh}
          setView={setView}
          allGroups={allGroups}
          accounts={accounts}
          isPayment={group.isPaymentGroup}
          selected={c.id === selectedCatId}
          onSelect={() => onSelectCat(c.id)}
        />
      ))}
    </>
  );
}

function CategoryRow({ cat, month, refresh, setView, allGroups, accounts, isPayment, selected, onSelect }) {
  // rename / goal / delete all live in the inspector panel, so the row keeps
  // its full width for the goal status text

  // payment categories reconcile against the synced card balance: Available
  // should equal what the bank says is owed, or the pill turns yellow
  const linkedAccount = isPayment ? accounts?.find(a => a.id === cat.linkedAccountId) : null;
  const owed = linkedAccount ? -linkedAccount.balance : null;
  const mismatch = linkedAccount?.connectionId != null && cat.available !== owed;
  const mismatchTitle = mismatch
    ? `Set aside ${fmt(cat.available)}, but the bank reports ${fmt(owed)} owed (off by ${fmt(cat.available - owed)})`
    : undefined;

  const carryover = cat.available - cat.assigned - cat.activity;
  const funds = carryover + cat.assigned;      // money put in through this month
  const spent = Math.max(0, -cat.activity);

  let status = null;
  if (!isPayment) {
    if (cat.available < 0) {
      status = `Overspent ${fmt(spent)} of ${fmt(funds)}`;
    } else if (cat.goal > 0) {
      status = cat.available >= cat.goal
        ? `🎯 Goal met — ${fmt(cat.goal)}`
        : `${fmt(cat.available)} of ${fmt(cat.goal)} goal`;
    } else if (spent > 0) {
      status = `Spent ${fmt(spent)} of ${fmt(funds)}`;
    } else if (funds > 0) {
      status = 'Funded';
    }
  }
  const showBar = !isPayment && ((cat.segments?.length ?? 0) > 0 || spent > 0 || cat.goal > 0);

  return (
    <div
      className={`grid-row row selectable ${selected ? 'selected' : ''}`}
      onClick={e => {
        // interactive elements inside the row keep their own click behavior
        if (e.target.closest('button, input, select, .pill, .assign-value, .cat-name, .inline-input')) return;
        onSelect();
      }}
    >
      <div className="cat-cell indent">
        <div className="cat-line">
          {cat.emoji && <span className="cat-emoji">{cat.emoji}</span>}
          <span
            className="cat-name"
            title={isPayment && cat.linkedAccountId ? 'Open the card\'s account ledger' : 'View transactions'}
            onClick={() => setView(
              isPayment && cat.linkedAccountId
                ? { type: 'account', accountId: cat.linkedAccountId }
                : { type: 'category', categoryId: cat.id }
            )}
          >
            {cat.name}
          </span>
          {status && <span className="cat-status">{status}</span>}
        </div>
        {showBar && (
          <FundingBar segments={cat.segments ?? []} spent={spent} goal={cat.goal} month={month} />
        )}
      </div>
      <div className="num"><AssignCell cat={cat} month={month} refresh={refresh} /></div>
      <div className={`num ${cat.activity === 0 ? 'muted' : ''}`}>{fmt(cat.activity)}</div>
      <div className="num"><AvailPill cat={cat} month={month} refresh={refresh} groups={allGroups} warn={mismatch} warnTitle={mismatchTitle} /></div>
    </div>
  );
}

/** One bar per category: segments (with gaps) show which month each chunk of
 *  funding came from, and the striped overlay covers what's been spent. Empty
 *  track to the right is the gap to an unmet goal. */
function FundingBar({ segments, spent, goal, month }) {
  const funds = segments.reduce((t, s) => t + s.amount, 0);
  const total = Math.max(funds, goal ?? 0, spent, 1);
  const label = m => {
    const d = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1);
    return d.toLocaleString('en-US', { month: 'short' });
  };

  // Each funding month is its own rounded pill. Spending consumes the oldest
  // money first (same FIFO rule the engine uses), so the hatch fills pills from
  // the left — a pill can be fully, partly, or not at all hatched.
  let toSpend = Math.min(spent, funds);
  const pills = segments.map((s, i) => {
    const hatched = Math.min(s.amount, toSpend);
    toSpend -= hatched;
    return {
      key: s.month,
      amount: s.amount,
      hatchPct: s.amount > 0 ? (hatched / s.amount) * 100 : 0,
      // older money renders dimmer; the current month is full strength
      opacity: Math.max(0.35, 1 - (segments.length - 1 - i) * 0.22),
    };
  // every funded month gets a pill; CSS floors them at 20px so the rounded
  // ends stay legible even for a few cents
  }).filter(p => p.amount > 0);
  // spending past the funded amount gets its own red pill
  if (spent > funds) {
    // overspending is money spent, so the whole pill is hatched
    pills.push({ key: 'over', amount: Math.min(spent, total) - funds, over: true, hatchPct: 100, opacity: 1 });
  }

  // widths are shares of the track minus the 2px gaps between pills
  const gapPx = 2;
  const gapTotal = Math.max(0, pills.length - 1) * gapPx;
  const width = amount => `calc((100% - ${gapTotal}px) * ${(amount / total).toFixed(5)})`;

  const title = [
    ...segments.map(s => `${label(s.month)} ${s.month === month ? 'assigned' : 'leftover'} ${fmt(s.amount)}`),
    `spent ${fmt(spent)} of ${fmt(funds)}`,
  ].join(' · ');

  return (
    <div className="fbar-track" title={title}>
      {pills.map(p => (
        <div
          key={p.key}
          className={`fbar-seg ${p.over ? 'over' : ''}`}
          style={{ width: width(p.amount), opacity: p.opacity }}
        >
          {p.hatchPct > 0 && <div className="fbar-hatch" style={{ width: `${p.hatchPct}%` }} />}
        </div>
      ))}
    </div>
  );
}

function AssignCell({ cat, month, refresh }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  async function commit(value) {
    const cents = parseAmount(value);
    if (cents == null || cents === cat.assigned) { setEditing(false); return; }
    setSaving(true);
    try {
      await api('/api/assign', { method: 'PUT', body: { month, categoryId: cat.id, amount: cents } });
      await refresh();
    } catch (e) {
      alert(e.message);
    }
    setSaving(false);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        className="assign-input"
        autoFocus
        defaultValue={(cat.assigned / 100).toFixed(2)}
        disabled={saving}
        onFocus={e => e.target.select()}
        onBlur={e => commit(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') e.target.blur();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <span className="assign-value" title="Click to edit" onClick={() => setEditing(true)}>
      {fmt(cat.assigned)}
    </span>
  );
}

function AvailPill({ cat, month, refresh, groups, warn = false, warnTitle }) {
  const cents = cat.available;
  const [anchor, setAnchor] = useState(null);
  const cls = cents < 0 ? 'red' : warn ? 'yellow' : cents > 0 ? 'green' : 'gray';
  const movable = cents > 0;
  return (
    <>
      <span
        className={`pill ${cls} ${movable ? 'clickable' : ''}`}
        title={warnTitle ?? (movable ? 'Move money from this category' : undefined)}
        onClick={e => movable && setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        {cents > 0 && !warn ? '✓ ' : ''}{fmt(cents)}
      </span>
      {anchor && (
        <MoveMoneyPopover
          anchor={anchor}
          from={cat}
          defaultAmount={cents}
          groups={groups}
          month={month}
          refresh={refresh}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

function MoveMoneyPopover({ anchor, from, defaultAmount, groups, month, refresh, onClose, title }) {
  const destinations = groups.flatMap(g =>
    g.categories.filter(c => c.id !== from?.id).map(c => ({ ...c, groupName: g.name }))
  );
  const [amount, setAmount] = useState(defaultAmount > 0 ? (defaultAmount / 100).toFixed(2) : '');
  const [dest, setDest] = useState(from ? 'rta' : String(destinations[0]?.id ?? ''));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function move(e) {
    e.preventDefault();
    const cents = parseAmount(amount);
    if (cents == null || cents <= 0) { setError('Enter a positive amount'); return; }
    setBusy(true);
    try {
      await api('/api/move-money', {
        method: 'POST',
        body: {
          month,
          fromCategoryId: from?.id ?? null,
          toCategoryId: dest === 'rta' ? null : Number(dest),
          amount: cents,
        },
      });
      await refresh();
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const style = {
    position: 'fixed',
    top: Math.min(anchor.bottom + 6, window.innerHeight - 220),
    right: Math.max(12, window.innerWidth - anchor.right),
  };

  return (
    <>
      <div className="menu-overlay" onClick={onClose} />
      <form className="popover" style={style} onSubmit={move}>
        <div className="popover-title">{title ?? `Move money from ${from.emoji ? `${from.emoji} ` : ''}${from.name}`}</div>
        <label>
          Amount
          <input
            autoFocus inputMode="decimal" placeholder="0.00"
            value={amount} onChange={e => setAmount(e.target.value)}
            onFocus={e => e.target.select()}
          />
        </label>
        <label>
          To
          <select value={dest} onChange={e => setDest(e.target.value)}>
            {from && <option value="rta">💵 Ready to Assign</option>}
            {groups.map(g => (
              <optgroup key={g.id} label={g.name}>
                {g.categories.filter(c => c.id !== from?.id).map(c => (
                  <option key={c.id} value={c.id}>{c.emoji ? `${c.emoji} ` : ''}{c.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {error && <p className="modal-error">{error}</p>}
        <div className="popover-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-accent btn-sm" disabled={busy}>Move</button>
        </div>
      </form>
    </>
  );
}

function RtaAssignMenu({ anchor, state, month, refresh, onClose }) {
  const [step, setStep] = useState('menu');
  const allCats = state.groups.flatMap(g => g.categories);
  const goalGap = allCats.reduce(
    (s, c) => s + (c.goal > 0 ? Math.max(0, c.goal - c.available) : 0), 0
  );
  const canFund = goalGap > 0 && state.readyToAssign > 0;

  async function fundGoals() {
    await api('/api/auto-assign', { method: 'POST', body: { month, mode: 'fund-goals' } });
    await refresh();
    onClose();
  }

  if (step === 'assign') {
    return (
      <MoveMoneyPopover
        anchor={anchor}
        from={null}
        title="Assign from Ready to Assign"
        defaultAmount={0}
        groups={state.groups}
        month={month}
        refresh={refresh}
        onClose={onClose}
      />
    );
  }

  const style = {
    position: 'fixed',
    top: anchor.bottom + 6,
    left: Math.max(12, Math.min(anchor.left, window.innerWidth - 300)),
  };

  return (
    <>
      <div className="menu-overlay" onClick={onClose} />
      <div className="popover" style={style}>
        <div className="popover-title">Assign money</div>
        <div className="pop-item" onClick={() => setStep('assign')}>
          <span>→ Assign to a category…</span>
        </div>
        <div
          className={`pop-item ${canFund ? '' : 'disabled'}`}
          title={goalGap === 0 ? 'All goals are met' : state.readyToAssign <= 0 ? 'Nothing left to assign' : `Fund underfunded goals, up to what's available`}
          onClick={() => canFund && fundGoals()}
        >
          <span>🎯 Fund goals</span>
          <span className="pop-amt">{fmt(Math.min(goalGap, Math.max(0, state.readyToAssign)))}</span>
        </div>
      </div>
    </>
  );
}

function InlineInput({ initial = '', placeholder, onCommit, onCancel }) {
  return (
    <input
      className="inline-input"
      autoFocus
      defaultValue={initial}
      placeholder={placeholder}
      onFocus={e => e.target.select()}
      onBlur={e => onCommit(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') e.target.blur();
        if (e.key === 'Escape') onCancel();
      }}
    />
  );
}

