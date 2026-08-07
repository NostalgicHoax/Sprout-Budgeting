import { useState } from 'react';
import { fmt, parseAmount } from '../money.js';
import { api } from '../api.js';

/** Month-by-month amortization. Amounts in cents; returns null when the
 *  payment doesn't cover interest (the loan would never be paid off). */
function simulate(balance, aprPct, payment, { extra = 0, lump = 0 } = {}) {
  let b = balance - lump;
  if (b <= 0) return { months: 0, interest: 0, points: [0] };
  const r = aprPct / 100 / 12;
  const pay = payment + extra;
  if (pay <= b * r) return null;
  let interest = 0;
  let months = 0;
  const points = [b]; // remaining principal at each month, starting today
  // terms are capped at 120 months; small buffer covers payment rounding
  while (b > 0.5 && months < 132) {
    const i = b * r;
    interest += i;
    b = b + i - pay;
    months++;
    points.push(Math.max(0, b));
  }
  return { months, interest: Math.round(interest), points };
}

/** Standard amortization payment for balance (cents) at aprPct over n months. */
function monthlyPayment(balance, aprPct, n) {
  const r = aprPct / 100 / 12;
  if (r === 0) return Math.ceil(balance / n);
  return Math.round((balance * r) / (1 - Math.pow(1 + r, -n)));
}

/** Months from `from` to `month`; negative for months already past. */
function monthOffset(month, from) {
  const [y1, m1] = month.split('-').map(Number);
  const [y2, m2] = from.split('-').map(Number);
  return (y1 * 12 + m1) - (y2 * 12 + m2);
}

function termLabel(months) {
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m} mo`;
  return m === 0 ? `${y} yr` : `${y} yr ${m} mo`;
}

function payoffDate(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

function compactMoney(cents) {
  const d = cents / 100;
  if (d >= 1000) return `$${(d / 1000).toFixed(d >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(d)}`;
}

function PayoffChart({ baseline, scenario, startBalance, actual = [] }) {
  // extra top padding keeps the legend in its own band above the plot
  const W = 620, H = 216, L = 52, R = 12, T = 34, B = 30;
  const plotW = W - L - R, plotH = H - T - B;
  // `actual` sits at negative month offsets — history to the left of today — so
  // the axis has to start behind zero once there are payments to show
  const minX = actual.length ? Math.min(...actual.map(p => p.m), 0) : 0;
  const maxX = Math.max(baseline.points.length - 1, 1);
  const span = maxX - minX;
  const maxY = Math.max(startBalance, ...actual.map(p => p.balance), 1);
  const x = m => L + ((m - minX) / span) * plotW;
  const y = v => T + (1 - v / maxY) * plotH;
  const path = pts => pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const step = span <= 12 ? 3 : span <= 36 ? 6 : span <= 96 ? 12 : 24;
  const xTicks = [];
  for (let m = 0; m <= maxX; m += step) xTicks.push(m);
  for (let m = -step; m >= minX; m -= step) xTicks.unshift(m);
  const xLabel = m => {
    if (m === 0) return 'Now';
    const a = Math.abs(m);
    const label = a % 12 === 0 ? `${a / 12} yr` : `${a} mo`;
    return m < 0 ? `−${label}` : label;
  };
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => f * maxY);

  return (
    <svg className="payoff-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Remaining principal over time">
      {yTicks.map(v => (
        <g key={v}>
          <line x1={L} y1={y(v)} x2={W - R} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
          <text x={L - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="var(--muted)">{compactMoney(v)}</text>
        </g>
      ))}
      {xTicks.map(m => (
        <g key={m}>
          <line x1={x(m)} y1={T} x2={x(m)} y2={H - B} stroke="var(--border)"
            strokeWidth={m === 0 ? (minX < 0 ? 1.5 : 0) : 0.5} opacity={m === 0 ? 1 : 0.6} />
          <text x={x(m)} y={H - B + 14} textAnchor={m === 0 && minX === 0 ? 'start' : 'middle'}
            fontSize="10" fill="var(--muted)">{xLabel(m)}</text>
        </g>
      ))}
      <path d={path(baseline.points)} fill="none" stroke="var(--muted)" strokeWidth="2"
        strokeDasharray={scenario ? '5 4' : 'none'} strokeLinejoin="round" />
      {scenario && (
        <path d={path(scenario.points)} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" />
      )}
      {/* payments actually made: a trail behind today showing real progress, so
          drift from the plan is visible rather than implied */}
      {actual.length > 1 && (
        <path
          d={actual.map((p, i) => `${i ? 'L' : 'M'}${x(p.m).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ')}
          fill="none" stroke="var(--good, #4ade80)" strokeWidth="1.5" opacity=".5" strokeLinejoin="round"
        />
      )}
      {actual.map(p => (
        <circle key={p.month} cx={x(p.m)} cy={y(p.balance)} r="3.5" fill="var(--good, #4ade80)">
          <title>{`${p.month}: ${fmt(p.balance)} owed`}</title>
        </circle>
      ))}
      <g fontSize="11">
        <circle cx={L + 4} cy={10} r="4" fill="var(--muted)" />
        <text x={L + 14} y={14} fill="var(--soft)">Current plan</text>
        {scenario && (
          <>
            <circle cx={L + 104} cy={10} r="4" fill="var(--accent)" />
            <text x={L + 114} y={14} fill="var(--soft)">With extra payments</text>
          </>
        )}
        {actual.length > 0 && (
          <>
            <circle cx={L + (scenario ? 244 : 104)} cy={10} r="4" fill="var(--good, #4ade80)" />
            <text x={L + (scenario ? 254 : 114)} y={14} fill="var(--soft)">Payments made</text>
          </>
        )}
      </g>
    </svg>
  );
}

export default function LoanPanel({ account, groups = [], refresh }) {
  const [detailsAnchor, setDetailsAnchor] = useState(null);
  const [extraInput, setExtraInput] = useState('');
  const [lumpInput, setLumpInput] = useState('');

  const balance = Math.max(0, -account.balance); // amount owed, cents
  const ready = account.apr != null && account.loanMonths != null && balance > 0;

  // month-end balances already recorded, placed at negative offsets so they land
  // behind "Now" on the chart
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const actual = (account.history ?? [])
    .map(h => ({ month: h.month, m: monthOffset(h.month, thisMonth), balance: Math.max(0, -h.balance) }))
    .filter(p => p.m <= 0);

  let payment = null, baseline = null, scenario = null, extra = 0, lump = 0;
  if (ready) {
    payment = monthlyPayment(balance, account.apr, account.loanMonths);
    baseline = simulate(balance, account.apr, payment);
    extra = Math.max(0, parseAmount(extraInput || '0') ?? 0);
    lump = Math.max(0, parseAmount(lumpInput || '0') ?? 0);
    if (extra > 0 || lump > 0) {
      scenario = simulate(balance, account.apr, payment, { extra, lump });
    }
  }

  return (
    <div className="loan-panel">
      <div className="loan-panel-bar">
        <button
          className="btn btn-ghost btn-sm loan-details-toggle"
          onClick={e => setDetailsAnchor(e.currentTarget.getBoundingClientRect())}
        >
          ⚙ Loan Details <span className="rta-caret">▾</span>
        </button>
        {ready && (
          <span className="loan-bar-summary">{account.apr}% APR · {account.loanMonths} payments left</span>
        )}
      </div>

      {!ready && (
        <p className="panel-hint loan-span">
          Set the APR and remaining payments under Loan Details to unlock the payoff simulator.
        </p>
      )}

      {ready && baseline && (
        <div className="loan-body">
          <div className="loan-chart-area">
            <PayoffChart baseline={baseline} scenario={scenario} startBalance={balance} actual={actual} />
          </div>
          <div className="loan-side">
            <div className="loan-col">
              <div className="insp-label">CURRENT TRACK</div>
              <div className="loan-stat"><span>Monthly payment</span><span>{fmt(payment)}</span></div>
              <div className="loan-stat"><span>Payoff</span><span>{payoffDate(baseline.months)} · {termLabel(baseline.months)}</span></div>
              <div className="loan-stat"><span>Interest remaining</span><span>{fmt(baseline.interest)}</span></div>
            </div>
            <div className="loan-col loan-sim">
              <div className="insp-label">📉 PAYOFF SIMULATOR</div>
              <div className="loan-field">
                <span>Extra principal / month</span>
                <input inputMode="decimal" placeholder="0.00" value={extraInput} onChange={e => setExtraInput(e.target.value)} />
              </div>
              <div className="loan-field">
                <span>One-time lump sum today</span>
                <input inputMode="decimal" placeholder="0.00" value={lumpInput} onChange={e => setLumpInput(e.target.value)} />
              </div>
              {scenario === null && (extra > 0 || lump > 0) && (
                <p className="soft-error">Payment doesn't cover interest.</p>
              )}
              {scenario && (
                <div className="loan-result">
                  <div className="loan-stat"><span>New payoff</span><span>{payoffDate(scenario.months)} · {termLabel(scenario.months)}</span></div>
                  <div className="loan-stat highlight">
                    <span>Time saved</span>
                    <span>{baseline.months - scenario.months > 0 ? termLabel(baseline.months - scenario.months) : '—'}</span>
                  </div>
                  <div className="loan-stat highlight">
                    <span>Interest saved</span>
                    <span>{fmt(Math.max(0, baseline.interest - scenario.interest))}</span>
                  </div>
                </div>
              )}
              {!scenario && extra === 0 && lump === 0 && (
                <p className="panel-hint">Add an extra monthly amount, a lump sum, or both.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {detailsAnchor && (
        <LoanDetailsPopover
          anchor={detailsAnchor}
          account={account}
          groups={groups}
          refresh={refresh}
          onClose={() => setDetailsAnchor(null)}
        />
      )}
    </div>
  );
}

function LoanDetailsPopover({ anchor, account, groups = [], refresh, onClose }) {
  const [aprInput, setAprInput] = useState(account.apr != null ? String(account.apr) : '');
  const [monthsInput, setMonthsInput] = useState(account.loanMonths != null ? String(account.loanMonths) : '');
  const [payCat, setPayCat] = useState(account.paymentCategoryId != null ? String(account.paymentCategoryId) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    const apr = aprInput.trim() === '' ? null : Number(aprInput);
    const loanMonths = monthsInput.trim() === '' ? null : Number(monthsInput);
    if (loanMonths != null && (!Number.isInteger(loanMonths) || loanMonths < 1 || loanMonths > 120)) {
      setError('Loan term must be 1–120 months');
      return;
    }
    if (apr != null && (!Number.isFinite(apr) || apr < 0 || apr > 100)) {
      setError('APR must be between 0 and 100');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api(`/api/accounts/${account.id}`, {
        method: 'PATCH',
        body: { apr, loanMonths, paymentCategoryId: payCat === '' ? null : Number(payCat) },
      });
      await refresh();
      onClose();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  const style = {
    position: 'fixed',
    top: anchor.bottom + 6,
    left: Math.max(12, Math.min(anchor.left, window.innerWidth - 304)),
  };

  return (
    <>
      <div className="menu-overlay" onClick={onClose} />
      <form className="popover" style={style} onSubmit={save}>
        <div className="popover-title">Loan Details</div>
        <label>
          APR %
          <input autoFocus inputMode="decimal" placeholder="e.g. 5.49" value={aprInput} onChange={e => setAprInput(e.target.value)} />
        </label>
        <label>
          Payments left (months)
          <input inputMode="numeric" placeholder="e.g. 60" value={monthsInput} onChange={e => setMonthsInput(e.target.value)} />
        </label>
        <label>
          Budget payments to
          <select value={payCat} onChange={e => setPayCat(e.target.value)}>
            <option value="">Don't budget these payments</option>
            {groups.filter(g => !g.isPaymentGroup).map(g => (
              <optgroup key={g.id} label={g.name}>
                {g.categories.map(c => (
                  <option key={c.id} value={c.id}>{c.emoji ? `${c.emoji} ` : ''}{c.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <p className="panel-hint">
          Payments recorded against this loan land in that category, so they show
          up in the budget instead of passing straight through.
        </p>
        {error && <p className="soft-error">{error}</p>}
        <div className="popover-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-accent btn-sm" disabled={saving}>Save</button>
        </div>
      </form>
    </>
  );
}
