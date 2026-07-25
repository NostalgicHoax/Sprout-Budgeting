import { useEffect, useState } from 'react';
import { fmt } from '../money.js';
import { api } from '../api.js';
import SpendingDonut from './SpendingDonut.jsx';

const RANGES = [
  { key: 'month', label: 'This Month' },
  { key: 'last-month', label: 'Last Month' },
  { key: '3mo', label: 'Last 3 Months' },
  { key: 'ytd', label: 'Year to Date' },
  { key: 'all', label: 'All Time' },
];

function rangeDates(key) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = iso(now);
  if (key === 'month') return { start: iso(new Date(y, m, 1)), end: today };
  if (key === 'last-month') return { start: iso(new Date(y, m - 1, 1)), end: iso(new Date(y, m, 0)) };
  if (key === '3mo') return { start: iso(new Date(y, m - 2, 1)), end: today };
  if (key === 'ytd') return { start: `${y}-01-01`, end: today };
  return {};
}

export default function ReportsView() {
  const [range, setRange] = useState('month');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const { start, end } = rangeDates(range);
    const q = new URLSearchParams();
    if (start) q.set('start', start);
    if (end) q.set('end', end);
    setData(null);
    api(`/api/reports/spending?${q}`).then(setData).catch(e => setError(e.message));
  }, [range]);

  const hasSpending = data && (data.categories.length > 0 || data.uncategorized > 0);

  return (
    <main className="main">
      <header className="topbar account-topbar">
        <div>
          <div className="account-title">Reports</div>
          <div className="account-subtitle">Spending by category</div>
        </div>
        <div className="account-balance">
          <div className="balance-amount neg">{data ? fmt(data.total) : '—'}</div>
          <div className="balance-label">Total Spent</div>
        </div>
      </header>

      <div className="filter-tabs">
        {RANGES.map(r => (
          <span
            key={r.key}
            className={`filter-tab ${range === r.key ? 'active' : ''}`}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </span>
        ))}
      </div>

      <div className="report-body">
        {error && <p className="modal-error">{error}</p>}
        {data && !hasSpending && (
          <p className="empty-state">No spending in this range.</p>
        )}
        {hasSpending && (
          <SpendingDonut categories={data.categories} uncategorized={data.uncategorized} />
        )}
        {hasSpending && (
          <p className="report-note">
            Spending share for the selected range, largest first. Income, transfers,
            and balance adjustments aren't counted.
          </p>
        )}
      </div>
    </main>
  );
}
