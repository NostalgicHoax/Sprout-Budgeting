export function fmt(cents) {
  const neg = cents < 0;
  const s = `$${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  return neg ? `-${s}` : s;
}

/** "1,234.56" | "$12" | "-3.2" -> integer cents, or null if unparseable. */
export function parseAmount(str) {
  if (str == null) return null;
  const cleaned = String(str).replace(/[$,\s]/g, '');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

export function monthName(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long' });
}

/** "2026-07-09" -> "07/09/26" */
export function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y.slice(2)}`;
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
