import { useEffect, useState } from 'react';
import { fmt, monthName } from '../money.js';
import { api } from '../api.js';
import SpendingDonut from './SpendingDonut.jsx';
import CashflowChart from './CashflowChart.jsx';

const REPORTS = [
  { key: 'spending', label: 'Spending by Category' },
  { key: 'cashflow', label: 'Income vs Expenses' },
];

const RANGES = [
  { key: 'month', label: 'This Month' },
  { key: 'last-month', label: 'Last Month' },
  { key: '3mo', label: 'Last 3 Months' },
  { key: 'ytd', label: 'Year to Date' },
  { key: 'all', label: 'All Time' },
];

const LOOKBACKS = [
  { months: 3, label: '3 Months' },
  { months: 6, label: '6 Months' },
  { months: 12, label: '12 Months' },
  { months: 24, label: '24 Months' },
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
  const [report, setReport] = useState('spending');
  const [range, setRange] = useState('month');
  const [lookback, setLookback] = useState(3);
  const [data, setData] = useState(null);
  const [flow, setFlow] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (report !== 'spending') return;
    const { start, end } = rangeDates(range);
    const q = new URLSearchParams();
    if (start) q.set('start', start);
    if (end) q.set('end', end);
    setData(null);
    api(`/api/reports/spending?${q}`).then(setData).catch(e => setError(e.message));
  }, [range, report]);

  useEffect(() => {
    if (report !== 'cashflow') return;
    setFlow(null);
    api(`/api/reports/cashflow?months=${lookback}`).then(setFlow).catch(e => setError(e.message));
  }, [lookback, report]);

  const hasSpending = data && (data.categories.length > 0 || data.uncategorized > 0);
  const isFlow = report === 'cashflow';
  const hasFlow = flow && flow.months.some(m => m.income !== 0 || m.expense !== 0);

  return (
    <main className="main">
      <header className="topbar account-topbar">
        <div>
          <div className="account-title">Reports</div>
          <div className="account-subtitle">
            {isFlow ? 'What came in against what went out' : 'Spending by category'}
          </div>
        </div>
        <div className="account-balance">
          {isFlow ? (
            <>
              <div className={`balance-amount ${flow && flow.totals.net < 0 ? 'neg' : ''}`}>
                {flow ? fmt(flow.totals.net) : '—'}
              </div>
              <div className="balance-label">Net over {lookback} months</div>
            </>
          ) : (
            <>
              <div className="balance-amount neg">{data ? fmt(data.total) : '—'}</div>
              <div className="balance-label">Total Spent</div>
            </>
          )}
        </div>
      </header>

      <div className="filter-tabs report-picker">
        {REPORTS.map(r => (
          <span
            key={r.key}
            className={`filter-tab ${report === r.key ? 'active' : ''}`}
            onClick={() => setReport(r.key)}
          >
            {r.label}
          </span>
        ))}
      </div>

      <div className="filter-tabs">
        {(isFlow ? LOOKBACKS : RANGES).map(r => {
          const key = isFlow ? r.months : r.key;
          const active = isFlow ? lookback === r.months : range === r.key;
          return (
            <span
              key={key}
              className={`filter-tab ${active ? 'active' : ''}`}
              onClick={() => (isFlow ? setLookback(r.months) : setRange(r.key))}
            >
              {r.label}
            </span>
          );
        })}
      </div>

      <div className="report-body">
        {error && <p className="modal-error">{error}</p>}

        {isFlow && flow && !hasFlow && (
          <p className="empty-state">Nothing came in or went out over these {lookback} months.</p>
        )}
        {isFlow && hasFlow && (
          <>
            <div className="flow-stats">
              <div className="flow-stat">
                <span className="flow-stat-label">Money in</span>
                <span className="flow-stat-value pos">{fmt(flow.totals.income)}</span>
                <span className="flow-stat-sub">{fmt(flow.average.income)} a month</span>
              </div>
              <div className="flow-stat">
                <span className="flow-stat-label">Money out</span>
                <span className="flow-stat-value neg">{fmt(flow.totals.expense)}</span>
                <span className="flow-stat-sub">{fmt(flow.average.expense)} a month</span>
              </div>
              <div className="flow-stat">
                <span className="flow-stat-label">Net</span>
                <span className={`flow-stat-value ${flow.totals.net < 0 ? 'neg' : 'pos'}`}>
                  {fmt(flow.totals.net)}
                </span>
                <span className="flow-stat-sub">{fmt(flow.average.net)} a month</span>
              </div>
            </div>

            <CashflowChart months={flow.months} />

            {/* the same numbers in text, so the chart is never the only way to
                read them */}
            <table className="flow-table">
              <thead>
                <tr><th>Month</th><th className="num">In</th><th className="num">Out</th><th className="num">Net</th></tr>
              </thead>
              <tbody>
                {flow.months.map(m => (
                  <tr key={m.month}>
                    <td>{monthName(m.month)}</td>
                    <td className="num">{fmt(m.income)}</td>
                    <td className="num">{fmt(m.expense)}</td>
                    <td className={`num ${m.net < 0 ? 'neg' : 'pos'}`}>{fmt(m.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="report-note">
              Money in is income; money out is everything you spent. Transfers between
              your own accounts, starting balances and balance adjustments aren't counted,
              and loan accounts are tracking-only.
            </p>
          </>
        )}

        {!isFlow && data && !hasSpending && (
          <p className="empty-state">No spending in this range.</p>
        )}
        {!isFlow && hasSpending && (
          <>
            <SpendingDonut categories={data.categories} uncategorized={data.uncategorized} />
            <p className="report-note">
              Spending share for the selected range, largest first. Income, transfers,
              and balance adjustments aren't counted.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
