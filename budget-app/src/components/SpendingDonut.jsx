import { useState } from 'react';
import { fmt } from '../money.js';

// Ported from the "Interactive Budgeting Pie Chart" design artifact
// (Spending Donut.dc.html): rounded ring segments with surface-color gaps,
// hover dims the other slices and swaps the center readout, labels sit outside
// the ring, and a Categories/Groups toggle re-aggregates the data.

const PALETTE = ['#5865f2', '#57b545', '#d7a319', '#5f7cf9', '#7cc244', '#f2c218', '#d9646d', '#aab2f0', '#8bd05a', '#d7d5f4'];
const UNCAT_COLOR = '#c8323e';  // the artifact reserves red for Uncategorized
const OTHER_COLOR = '#6b7079';

const RING_THICKNESS = 100;
const CORNER_RADIUS = 10;
const MIN_LABEL_PCT = 4; // smaller slices live in the legend below
const MAX_SLICES = 9; // beyond this the tail folds into "Other"

/** Rounded annular-sector path — verbatim from the design artifact. */
function segPath(cx, cy, a0, a1, r0, r1, cr) {
  const pt = (a, r) => (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2);
  cr = Math.max(0, Math.min(cr, (r1 - r0) / 2 - 1, (a1 - a0) * r0 / 2.2));
  if (cr < 1.5) {
    const la = (a1 - a0) > Math.PI ? 1 : 0;
    return `M ${pt(a0, r1)} A ${r1} ${r1} 0 ${la} 1 ${pt(a1, r1)} L ${pt(a1, r0)} A ${r0} ${r0} 0 ${la} 0 ${pt(a0, r0)} Z`;
  }
  const co = Math.asin(cr / (r1 - cr)), ci = Math.asin(cr / (r0 + cr));
  const la = (a1 - a0 - 2 * co) > Math.PI ? 1 : 0;
  return [
    `M ${pt(a0 + co, r1)}`,
    `A ${r1} ${r1} 0 ${la} 1 ${pt(a1 - co, r1)}`,
    `A ${cr} ${cr} 0 0 1 ${pt(a1, r1 - cr)}`,
    `L ${pt(a1, r0 + cr)}`,
    `A ${cr} ${cr} 0 0 1 ${pt(a1 - ci, r0)}`,
    `A ${r0} ${r0} 0 ${la} 0 ${pt(a0 + ci, r0)}`,
    `A ${cr} ${cr} 0 0 1 ${pt(a0, r0 + cr)}`,
    `L ${pt(a0, r1 - cr)}`,
    `A ${cr} ${cr} 0 0 1 ${pt(a0 + co, r1)}`,
    'Z',
  ].join(' ');
}

export default function SpendingDonut({ categories, uncategorized }) {
  const [view, setView] = useState('categories');
  const [hover, setHover] = useState(null);

  // rows for the active view (amounts in cents)
  let rows;
  if (view === 'categories') {
    rows = categories.map(c => ({ key: `c${c.id}`, name: c.name, emoji: c.emoji, amount: c.spent }));
  } else {
    const byGroup = new Map();
    for (const c of categories) {
      const g = byGroup.get(c.groupName) ?? { key: `g:${c.groupName}`, name: c.groupName, emoji: null, amount: 0 };
      g.amount += c.spent;
      if (!g.emoji && c.emoji) g.emoji = c.emoji;
      byGroup.set(c.groupName, g);
    }
    rows = [...byGroup.values()];
  }
  rows.sort((a, b) => b.amount - a.amount);
  // Other is held out and appended strictly last: slices sweep clockwise from
  // top-center, so the final slice always ENDS at 12 o'clock — Other can never
  // cross the top no matter how large it gets.
  let other = null;
  if (rows.length > MAX_SLICES) {
    const tail = rows.slice(MAX_SLICES);
    rows = rows.slice(0, MAX_SLICES);
    other = { key: 'other', name: 'Other', emoji: null, amount: tail.reduce((s, r) => s + r.amount, 0), other: true, color: OTHER_COLOR };
  }
  rows = rows.map((r, i) => ({ ...r, color: PALETTE[i % PALETTE.length] }));
  if (uncategorized > 0) {
    rows.push({ key: 'uncat', name: 'Uncategorized', emoji: null, amount: uncategorized, color: UNCAT_COLOR });
    rows.sort((a, b) => b.amount - a.amount);
  }
  if (other) rows.push(other);

  const total = rows.reduce((s, r) => s + r.amount, 0);
  if (total <= 0) return null;

  const cx = 500, cy = 400, r1 = 265, r0 = r1 - RING_THICKNESS;
  let a = -Math.PI / 2;
  const slices = [], labels = [];
  for (const d of rows) {
    // the 0.9999 keeps a single full-circle slice from degenerating
    const ang = (d.amount / total) * Math.PI * 2 * 0.9999;
    const a0 = a, a1 = a + ang;
    a = a1;
    const dim = hover && hover !== d.key;
    slices.push({ key: d.key, d: segPath(cx, cy, a0, a1, r0, r1, CORNER_RADIUS), color: d.color, dim });
    const pct = Math.round((d.amount / total) * 100);
    if (pct >= MIN_LABEL_PCT) {
      const m = (a0 + a1) / 2, lr = r1 + 42;
      const c = Math.cos(m), s = Math.sin(m);
      labels.push({
        key: d.key,
        x: Math.round(cx + lr * c),
        y: Math.round(cy + lr * s + s * 16 - 6),
        anchor: c > 0.18 ? 'start' : c < -0.18 ? 'end' : 'middle',
        dim,
        title: (d.emoji ? `${d.emoji} ` : '') + d.name,
        sub: `${fmt(d.amount)} (${pct}%)`,
      });
    }
  }
  // two-line labels on the same side get pushed apart if slices crowd together
  for (const side of ['start', 'middle', 'end']) {
    const group = labels.filter(l => l.anchor === side).sort((a, b) => a.y - b.y);
    for (let i = 1; i < group.length; i++) {
      if (group[i].y - group[i - 1].y < 58) group[i].y = group[i - 1].y + 58;
    }
  }

  const hovered = hover ? rows.find(r => r.key === hover) : null;

  return (
    <div className="donut-wrap">
      <div className="donut-toggle">
        <button
          className={view === 'categories' ? 'active' : ''}
          onClick={() => { setView('categories'); setHover(null); }}
        >
          Categories
        </button>
        <button
          className={view === 'groups' ? 'active' : ''}
          onClick={() => { setView('groups'); setHover(null); }}
        >
          Groups
        </button>
      </div>
      <svg viewBox="0 0 1000 800" className="donut-svg" role="img" aria-label="Spending share by category">
        {slices.map(s => (
          <path
            key={s.key}
            d={s.d}
            fill={s.color}
            strokeWidth="5"
            strokeLinejoin="round"
            style={{ stroke: 'var(--bg)', opacity: s.dim ? 0.3 : 1, transition: 'opacity .18s', cursor: 'pointer' }}
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        {labels.map(l => (
          <text
            key={l.key}
            x={l.x}
            y={l.y}
            textAnchor={l.anchor}
            style={{ opacity: l.dim ? 0.3 : 1, transition: 'opacity .18s', pointerEvents: 'none' }}
          >
            <tspan style={{ fontSize: 21, fontWeight: 700, fill: 'var(--bright)' }}>{l.title}</tspan>
            <tspan x={l.x} dy="27" style={{ fontSize: 19, fill: 'var(--muted)' }}>{l.sub}</tspan>
          </text>
        ))}
        <text x="500" y="378" textAnchor="middle" style={{ fontSize: 23, fill: 'var(--soft)', pointerEvents: 'none' }}>
          {hovered ? hovered.name : 'Total Spending'}
        </text>
        <text x="500" y="424" textAnchor="middle" style={{ fontSize: 38, fontWeight: 800, fill: 'var(--bright)', pointerEvents: 'none' }}>
          {fmt(hovered ? hovered.amount : total)}
        </text>
      </svg>
      <div className="report-legend" aria-label="Spending breakdown">
        {rows.map(r => {
          const pct = Math.round((r.amount / total) * 100);
          return (
            <div
              key={r.key}
              className="report-legend-row"
              style={{ opacity: hover && hover !== r.key ? 0.4 : 1 }}
              title={`${r.name} — ${fmt(r.amount)} (${pct}%)`}
              onMouseEnter={() => setHover(r.key)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="report-swatch" style={{ background: r.color }} aria-hidden="true" />
              <span className={`report-label ${r.key === 'uncat' ? 'uncat' : ''}`}>
                {r.emoji ? `${r.emoji} ` : ''}{r.name}
              </span>
              <span className="report-amt">{fmt(r.amount)}</span>
              <span className="report-pct">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
