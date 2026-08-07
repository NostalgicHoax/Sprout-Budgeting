import { useState } from 'react';
import { fmt, monthName } from '../money.js';

// Income against expenses, month by month, on one shared axis — two dollar
// measures never get two scales.
//
// Polarity is carried by POSITION, not hue: money in rises above the zero line,
// money out falls below it. The palette does pass a colourblind check (the
// app's green and red separate at deutan ΔE 10.5, helped by the green being a
// yellow-green), but the green sits lighter than the red, so leaning on colour
// alone would let income read heavier than it is. Above/below the baseline is
// legible to everyone regardless.
//
// The net line rides in neutral ink rather than a third hue, so it reads as the
// summary of the two series instead of competing as a third category.

const IN = 'var(--accent)';
const OUT = 'var(--red)';
const NET = 'var(--soft)';

function shortMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1, 1);
  return d.toLocaleString('en-US', { month: 'short' });
}

export default function CashflowChart({ months }) {
  const [hover, setHover] = useState(null);

  const W = 720, H = 300, L = 62, R = 16, T = 22, B = 42;
  const plotW = W - L - R, plotH = H - T - B;
  const n = months.length;

  // one scale for both directions, so a dollar up is the same length as a
  // dollar down
  const peak = Math.max(1, ...months.map(m => Math.max(m.income, m.expense, Math.abs(m.net))));
  const step = plotW / n;
  const barW = Math.min(26, step * 0.3);
  const gap = 2;                       // surface gap between the paired bars
  const zeroY = T + plotH / 2;
  const y = v => zeroY - (v / peak) * (plotH / 2);
  const cx = i => L + step * (i + 0.5);

  const ticks = [1, 0.5, 0, -0.5, -1].map(f => f * peak);
  const money = v => {
    const a = Math.abs(v) / 100;
    if (a >= 1000) return `${v < 0 ? '-' : ''}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
    return `${v < 0 ? '-' : ''}$${Math.round(a)}`;
  };

  // 4px rounded ends on the data end only, anchored to the baseline
  const bar = (i, value, side, fill) => {
    if (value <= 0) return null;
    const h = Math.max(1, (value / peak) * (plotH / 2));
    const x = side === 'in' ? cx(i) - barW - gap / 2 : cx(i) + gap / 2;
    const top = side === 'in' ? zeroY - h : zeroY;
    const r = Math.min(4, h);
    const d = side === 'in'
      ? `M${x},${zeroY} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + barW - r},${top} Q${x + barW},${top} ${x + barW},${top + r} L${x + barW},${zeroY} Z`
      : `M${x},${zeroY} L${x},${top + h - r} Q${x},${top + h} ${x + r},${top + h} L${x + barW - r},${top + h} Q${x + barW},${top + h} ${x + barW},${top + h - r} L${x + barW},${zeroY} Z`;
    return <path d={d} fill={fill} />;
  };

  const netPath = months
    .map((m, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${y(m.net).toFixed(1)}`)
    .join(' ');

  return (
    <div className="cashflow-wrap">
      <svg className="cashflow-chart" viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label="Money in and money out by month, with net">
        {ticks.map(v => (
          <g key={v}>
            <line x1={L} y1={y(v)} x2={W - R} y2={y(v)} stroke="var(--border)"
              strokeWidth={v === 0 ? 1.2 : 0.5} opacity={v === 0 ? 1 : 0.5} />
            <text x={L - 8} y={y(v) + 3} textAnchor="end" fontSize="10" fill="var(--muted)">{money(v)}</text>
          </g>
        ))}

        {months.map((m, i) => (
          <g key={m.month}>
            {bar(i, m.income, 'in', IN)}
            {bar(i, m.expense, 'out', OUT)}
            <text x={cx(i)} y={H - B + 15} textAnchor="middle" fontSize="10"
              fill={hover === i ? 'var(--bright)' : 'var(--muted)'}>{shortMonth(m.month)}</text>
            {/* hit target spans the whole column, not just the bars */}
            <rect x={L + step * i} y={T} width={step} height={plotH} fill="transparent"
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          </g>
        ))}

        {n > 1 && (
          <path d={netPath} fill="none" stroke={NET} strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" opacity=".9" />
        )}
        {months.map((m, i) => (
          // 2px surface ring keeps the marker readable where it crosses a bar
          <circle key={m.month} cx={cx(i)} cy={y(m.net)} r={hover === i ? 5 : 4}
            fill={NET} stroke="var(--bg)" strokeWidth="2" />
        ))}

        {hover != null && (
          <g pointerEvents="none">
            <line x1={cx(hover)} y1={T} x2={cx(hover)} y2={H - B}
              stroke="var(--border2)" strokeWidth="1" />
          </g>
        )}
      </svg>

      <div className="cashflow-legend">
        <span><i style={{ background: IN }} /> Money in</span>
        <span><i style={{ background: OUT }} /> Money out</span>
        <span><i className="line" style={{ background: NET }} /> Net</span>
      </div>

      {hover != null && (
        <div className="cashflow-tip">
          <strong>{monthName(months[hover].month)}</strong>
          <span><i style={{ background: IN }} /> In <b>{fmt(months[hover].income)}</b></span>
          <span><i style={{ background: OUT }} /> Out <b>{fmt(months[hover].expense)}</b></span>
          <span className={months[hover].net < 0 ? 'neg' : 'pos'}>
            Net <b>{fmt(months[hover].net)}</b>
          </span>
        </div>
      )}
    </div>
  );
}
