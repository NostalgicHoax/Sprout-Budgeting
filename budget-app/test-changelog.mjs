// Changelog data check. No server needed — this guards the one thing the
// What's New panel can't recover from on its own: package.json being bumped
// without a matching entry, which would show an empty "what's new" and leave
// the unread dot keyed to a version nobody wrote about.
import { readFileSync } from 'node:fs';
import { CHANGELOG } from './src/changelog.js';

const out = [];
const check = (n, ok, d = '') => { out.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); if (!ok) process.exitCode = 1; };

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

check('there is at least one release entry', CHANGELOG.length > 0);
check('the newest entry matches package.json',
  CHANGELOG[0]?.version === pkg.version,
  `changelog ${CHANGELOG[0]?.version} vs package.json ${pkg.version}`);

const versions = CHANGELOG.map(r => r.version);
check('no version appears twice', new Set(versions).size === versions.length, versions.join(', '));

const parse = v => v.split('.').map(Number);
const descending = versions.every((v, i) => {
  if (i === 0) return true;
  const [a, b, c] = parse(versions[i - 1]);
  const [x, y, z] = parse(v);
  return a * 1e6 + b * 1e3 + c > x * 1e6 + y * 1e3 + z;
});
check('entries run newest first', descending, versions.join(' > '));
check('every version is x.y.z', versions.every(v => /^\d+\.\d+\.\d+$/.test(v)), versions.join(', '));

const dates = CHANGELOG.map(r => r.date);
check('every date is YYYY-MM-DD', dates.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)), dates.join(', '));
check('every date is real', dates.every(d => !Number.isNaN(Date.parse(d))));
check('dates run newest first too',
  dates.every((d, i) => i === 0 || Date.parse(dates[i - 1]) >= Date.parse(d)), dates.join(' >= '));

check('every release has a title', CHANGELOG.every(r => typeof r.title === 'string' && r.title.trim()));
check('every release has items', CHANGELOG.every(r => Array.isArray(r.items) && r.items.length > 0));
check('every item has a heading and body',
  CHANGELOG.every(r => r.items.every(i => i.heading?.trim() && i.body?.trim())));
check('headings are unique within a release',
  CHANGELOG.every(r => new Set(r.items.map(i => i.heading)).size === r.items.length));

// written for the person using the budget, not the person who wrote the code
const jargon = /\bAPI\b|endpoint|refactor|commit|\bPR\b|SQL|schema|migrat|null|undefined/i;
const offenders = CHANGELOG.flatMap(r =>
  r.items.filter(i => jargon.test(i.heading) || jargon.test(i.body)).map(i => `${r.version}: ${i.heading}`)
);
check('entries avoid developer jargon', offenders.length === 0, offenders.join('; '));

console.log(out.join('\n'));
console.log(out.some(l => l.startsWith('FAIL')) ? '\nFAILED' : '\nAll changelog checks passed');
