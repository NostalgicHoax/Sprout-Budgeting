import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import BudgetView from './components/BudgetView.jsx';
import AccountView from './components/AccountView.jsx';
import CalendarView from './components/CalendarView.jsx';
import ReportsView from './components/ReportsView.jsx';
import AuthScreen from './components/AuthScreen.jsx';
import { api } from './api.js';

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function App() {
  const [auth, setAuth] = useState(undefined); // undefined = checking, null = signed out
  const [month, setMonth] = useState(currentMonth());
  const [view, setView] = useState({ type: 'plan' });
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/api/auth/me').then(setAuth).catch(() => setAuth(null));
  }, []);

  const refresh = useCallback(async () => {
    if (!auth) return;
    try {
      setState(await api(`/api/state?month=${month}`));
      setError(null);
    } catch (e) {
      if (e.status === 401) setAuth(null);
      else setError(e.message);
    }
  }, [month, auth]);

  useEffect(() => { refresh(); }, [refresh]);

  // switching budgets (or signing in) starts back at the Plan view
  const activeBudgetId = auth?.activeBudgetId;
  useEffect(() => {
    setView({ type: 'plan' });
  }, [activeBudgetId]);

  // automatic bank sync: whenever a budget is opened, pull fresh transactions
  // for connections that haven't synced in the last 6 hours
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!activeBudgetId) return;
    api('/api/sync', { method: 'POST', body: { ifStaleHours: 6 } })
      .then(r => { if (r.imported > 0 || r.updated > 0) refreshRef.current(); })
      .catch(() => { /* offline or no connections — fine */ });
  }, [activeBudgetId]);

  if (auth === undefined) return null;
  if (auth === null) return <AuthScreen onAuthed={setAuth} />;

  if (error && !state) {
    return (
      <div className="boot-error">
        <div>
          <h2>Can't reach the budget server</h2>
          <p>{error}</p>
          <p>Make sure the server is running, then reload this page.</p>
        </div>
      </div>
    );
  }
  if (!state) return null;

  return (
    <div className="app">
      <Sidebar state={state} view={view} setView={setView} refresh={refresh} auth={auth} onAuthChange={setAuth} />
      {view.type === 'plan' ? (
        <BudgetView state={state} month={month} setMonth={setMonth} refresh={refresh} setView={setView} />
      ) : view.type === 'calendar' ? (
        <CalendarView state={state} month={month} setMonth={setMonth} setView={setView} />
      ) : view.type === 'reports' ? (
        <ReportsView />
      ) : (
        <AccountView
          key={`${activeBudgetId}:${view.type}:${view.accountId ?? view.categoryId}`}
          state={state}
          accountId={view.accountId}
          categoryId={view.categoryId}
          refresh={refresh}
          // the account this view is showing no longer exists, so fall back to
          // the budget rather than rendering an empty register
          onAccountDeleted={() => setView({ type: 'plan' })}
        />
      )}
    </div>
  );
}
