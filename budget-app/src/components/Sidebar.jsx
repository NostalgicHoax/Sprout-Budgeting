import { useState } from 'react';
import { fmt, parseAmount } from '../money.js';
import { api } from '../api.js';
import SecurityModal from './SecurityModal.jsx';
import ConnectionsModal from './ConnectionsModal.jsx';
import ChangelogModal, { hasUnreadChangelog, markChangelogSeen, lastSeenVersion } from './ChangelogModal.jsx';
import { APP_VERSION } from '../changelog.js';

const GROUPS = [
  { key: 'cash', label: 'CASH', match: a => a.type === 'cash' && !a.closed },
  { key: 'credit', label: 'CREDIT', match: a => a.type === 'credit' && !a.closed },
  { key: 'loans', label: 'LOANS', match: a => a.type === 'loan' && !a.closed },
  { key: 'closed', label: 'CLOSED', match: a => a.closed },
];

const NAV = [
  { type: 'plan', icon: '📋', label: 'Plan' },
  { type: 'calendar', icon: '🗓️', label: 'Calendar' },
  { type: 'reports', icon: '📊', label: 'Reports' },
  { type: 'account', icon: '🏛️', label: 'All Accounts', accountId: 'all' },
];

export default function Sidebar({ state, view, setView, refresh, auth, onAuthChange }) {
  const [collapsed, setCollapsed] = useState({});
  const [showAdd, setShowAdd] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [budgetModal, setBudgetModal] = useState(null); // 'new' | 'rename'
  const [showSecurity, setShowSecurity] = useState(false);
  const [showConnections, setShowConnections] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  // read once on mount: opening What's New clears it, and it shouldn't flicker
  // back on every re-render in between
  const [unreadNews, setUnreadNews] = useState(hasUnreadChangelog);
  const [railed, setRailed] = useState(() => localStorage.getItem('sidebarCollapsed') === '1');

  const [changelogSince, setChangelogSince] = useState(null);

  function openChangelog() {
    // capture what they'd already read before marking it seen, or the modal
    // would have nothing left to flag
    setChangelogSince(lastSeenVersion());
    setMenuOpen(false);
    setShowChangelog(true);
    markChangelogSeen();
    setUnreadNews(false);
  }

  const toggle = key => setCollapsed(c => ({ ...c, [key]: !c[key] }));
  const activeBudget = auth.budgets.find(b => b.id === auth.activeBudgetId);

  function toggleRail() {
    setRailed(r => {
      localStorage.setItem('sidebarCollapsed', r ? '0' : '1');
      return !r;
    });
  }

  const isActive = item => item.type === 'account'
    ? view.type === 'account' && view.accountId === 'all'
    : view.type === item.type;
  const go = item => setView(item.accountId ? { type: item.type, accountId: item.accountId } : { type: item.type });

  // collapsed: a slim rail keeping the nav icons reachable
  if (railed) {
    return (
      <aside className="sidebar railed">
        <button className="panel-toggle rail-toggle" title="Expand sidebar" onClick={toggleRail}>»</button>
        <div className="sidebar-logo rail-logo" title={activeBudget?.name ?? 'Budget'}>🌿</div>
        <nav className="rail-nav">
          {NAV.map(item => (
            <div
              key={item.label}
              className={`nav-item rail-item ${isActive(item) ? 'active' : ''}`}
              title={item.label}
              onClick={() => go(item)}
            >
              <span className="nav-icon">{item.icon}</span>
            </div>
          ))}
        </nav>
      </aside>
    );
  }

  async function switchBudget(id) {
    setMenuOpen(false);
    if (id === auth.activeBudgetId) return;
    await api(`/api/budgets/${id}/select`, { method: 'POST' });
    onAuthChange(await api('/api/auth/me'));
  }

  async function signOut() {
    setMenuOpen(false);
    await api('/api/auth/logout', { method: 'POST' });
    onAuthChange(null);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head clickable" onClick={() => setMenuOpen(o => !o)}>
        <div className="sidebar-logo">🌿</div>
        <div className="sidebar-title">
          <div className="sidebar-budget-name">{activeBudget?.name ?? 'Budget'}</div>
          <div className="sidebar-email">{auth.email}</div>
        </div>
        {/* without this the only hint of a new release is buried in the menu */}
        <div className="head-caret">{unreadNews && <span className="news-dot" title="New in this version" />}▾</div>
        <button
          className="panel-toggle"
          title="Collapse sidebar"
          onClick={e => { e.stopPropagation(); toggleRail(); }}
        >
          «
        </button>
      </div>

      {menuOpen && (
        <>
          <div className="menu-overlay" onClick={() => setMenuOpen(false)} />
          <div className="budget-menu">
            <div className="menu-section">BUDGETS</div>
            {auth.budgets.map(b => (
              <div
                key={b.id}
                className={`menu-item ${b.id === auth.activeBudgetId ? 'current' : ''}`}
                onClick={() => switchBudget(b.id)}
              >
                <span>{b.name}</span>
                {b.id === auth.activeBudgetId && <span className="menu-check">✓</span>}
              </div>
            ))}
            <div className="menu-item" onClick={() => { setMenuOpen(false); setBudgetModal('new'); }}>
              ＋ New Budget
            </div>
            <div className="menu-item" onClick={() => { setMenuOpen(false); setBudgetModal('rename'); }}>
              ✎ Rename Budget
            </div>
            <div className="menu-divider" />
            <div className="menu-section">ACCOUNT</div>
            <div className="menu-item static">{auth.email}</div>
            <div className="menu-item" onClick={() => { setMenuOpen(false); setShowSecurity(true); }}>
              🔐 Security
            </div>
            <div className="menu-item" onClick={signOut}>⏻ Sign Out</div>
            <div className="menu-divider" />
            <div className="menu-section">ABOUT</div>
            <div className="menu-item" onClick={openChangelog}>
              <span>🌱 What's New</span>
              {unreadNews
                ? <span className="news-badge">NEW</span>
                : <span className="menu-version">{APP_VERSION}</span>}
            </div>
          </div>
        </>
      )}

      <nav className="sidebar-nav">
        {NAV.map(item => (
          <div
            key={item.label}
            className={`nav-item ${isActive(item) ? 'active' : ''}`}
            onClick={() => go(item)}
          >
            <span className="nav-icon">{item.icon}</span><span>{item.label}</span>
          </div>
        ))}
      </nav>

      <div className="sidebar-accounts">
        {GROUPS.map(g => {
          const accounts = state.accounts.filter(g.match);
          if (accounts.length === 0) return null;
          const total = accounts.reduce((s, a) => s + a.balance, 0);
          const open = !collapsed[g.key];
          return (
            <div key={g.key}>
              <div className="acct-group-head" onClick={() => toggle(g.key)}>
                <span className="acct-group-label">
                  <span className="acct-caret" style={{ transform: `rotate(${open ? 0 : -90}deg)` }}>▾</span>
                  <span>{g.label}</span>
                </span>
                <span className={`acct-group-total ${total < 0 ? (g.key === 'credit' ? 'neg' : 'muted') : ''}`}>
                  {g.key === 'closed' ? '' : fmt(total)}
                </span>
              </div>
              {open && accounts.map(a => (
                <div
                  key={a.id}
                  className={`acct-row ${view.type === 'account' && view.accountId === a.id ? 'active' : ''}`}
                  onClick={() => setView({ type: 'account', accountId: a.id })}
                >
                  <span className="acct-name">{a.name}</span>
                  <span className={`acct-amt ${a.balance < 0 ? (a.type === 'credit' ? 'neg' : 'muted') : ''}`}>
                    {fmt(a.balance)}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className="sidebar-foot">
        <button className="btn btn-solid" onClick={() => setShowAdd(true)}>＋ Add Account</button>
        <button className="btn btn-ghost sidebar-connections" onClick={() => setShowConnections(true)}>
          🏦 Bank Connections
        </button>
      </div>

      {showAdd && (
        <AddAccountModal
          onClose={() => setShowAdd(false)}
          onCreated={async id => {
            setShowAdd(false);
            await refresh();
            setView({ type: 'account', accountId: id });
          }}
        />
      )}

      {budgetModal && (
        <BudgetModal
          mode={budgetModal}
          auth={auth}
          onClose={() => setBudgetModal(null)}
          onDone={me => { setBudgetModal(null); onAuthChange(me); }}
        />
      )}

      {showSecurity && <SecurityModal onClose={() => setShowSecurity(false)} />}
      {showChangelog && <ChangelogModal since={changelogSince} onClose={() => setShowChangelog(false)} />}
      {showConnections && (
        <ConnectionsModal state={state} refresh={refresh} onClose={() => setShowConnections(false)} />
      )}
    </aside>
  );
}

function BudgetModal({ mode, auth, onClose, onDone }) {
  const active = auth.budgets.find(b => b.id === auth.activeBudgetId);
  const [name, setName] = useState(mode === 'rename' ? active?.name ?? '' : '');
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      if (mode === 'new') {
        await api('/api/budgets', { method: 'POST', body: { name, demo } });
      } else {
        await api(`/api/budgets/${active.id}`, { method: 'PATCH', body: { name } });
      }
      onDone(await api('/api/auth/me'));
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={save}>
        <h3>{mode === 'new' ? 'New Budget' : 'Rename Budget'}</h3>
        <label>
          Budget name
          <input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. 2027 Budget" />
        </label>
        {mode === 'new' && (
          <>
            <label className="modal-check">
              <input type="checkbox" checked={demo} onChange={e => setDemo(e.target.checked)} />
              Start with demo data
            </label>
            <p className="modal-hint">Budgets are kept completely separate from each other. You'll switch to the new one right away.</p>
          </>
        )}
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-accent" disabled={saving}>
            {mode === 'new' ? 'Create Budget' : 'Rename'}
          </button>
        </div>
      </form>
    </div>
  );
}

function AddAccountModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('cash');
  const [balance, setBalance] = useState('');
  const [apr, setApr] = useState('');
  const [loanMonths, setLoanMonths] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const balanceLabel = {
    cash: 'Current balance',
    credit: 'Current balance owed',
    loan: 'Remaining loan balance',
  }[type];

  async function save(e) {
    e.preventDefault();
    const cents = parseAmount(balance || '0');
    if (cents == null) { setError('Enter a valid amount'); return; }
    // Debt accounts store what you owe as a negative balance.
    const startingBalance = type === 'cash' ? cents : -Math.abs(cents);
    if (type === 'loan' && loanMonths.trim() !== '') {
      const n = Number(loanMonths);
      if (!Number.isInteger(n) || n < 1 || n > 120) {
        setError({ text: 'Loan term must be 1–120 months', soft: true });
        return;
      }
    }
    setSaving(true);
    try {
      const body = { name, type, startingBalance };
      if (type === 'loan') {
        if (apr.trim() !== '') body.apr = Number(apr);
        if (loanMonths.trim() !== '') body.loanMonths = Number(loanMonths);
      }
      const { id } = await api('/api/accounts', { method: 'POST', body });
      await onCreated(id);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={save}>
        <h3>Add Account</h3>
        <label>
          Account name
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. 360 Checking" required />
        </label>
        <label>
          Type
          <select value={type} onChange={e => setType(e.target.value)}>
            <option value="cash">Checking / Savings / Cash</option>
            <option value="credit">Credit Card</option>
            <option value="loan">Loan (tracking only)</option>
          </select>
        </label>
        <label>
          {balanceLabel}
          <input value={balance} onChange={e => setBalance(e.target.value)} placeholder="0.00" inputMode="decimal" />
        </label>
        {type === 'loan' && (
          <>
            <div className="modal-row">
              <label>
                APR %
                <input value={apr} onChange={e => setApr(e.target.value)} placeholder="e.g. 5.49" inputMode="decimal" />
              </label>
              <label>
                Payments left (months)
                <input value={loanMonths} onChange={e => setLoanMonths(e.target.value)} placeholder="e.g. 60" inputMode="numeric" />
              </label>
            </div>
            <p className="modal-hint">These power the payoff simulator shown on the loan's page. You can edit them later.</p>
          </>
        )}
        {type === 'cash' && <p className="modal-hint">Cash starting balances are added to Ready to Assign.</p>}
        {type === 'credit' && <p className="modal-hint">A payment category is created under Credit Card Payments.</p>}
        {error && (
          <p className={error.soft ? 'soft-error' : 'modal-error'}>{error.text ?? error}</p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-accent" disabled={saving}>Add Account</button>
        </div>
      </form>
    </div>
  );
}
