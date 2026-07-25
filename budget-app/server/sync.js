// SimpleFIN bank sync (https://www.simplefin.org/protocol.html).
// A connection's access URL is a long-lived read-only credential; it lives in
// the budget database, so it is encrypted at rest with the user's data key.
// The provider column keeps this pluggable for other services later.

const FIRST_SYNC_DAYS = 60;   // history pulled when an account is first linked
const RESYNC_OVERLAP_DAYS = 7; // re-fetch window so pending -> posted updates land

/** Accepts a SimpleFIN setup token (base64 claim URL), a claim URL, or an
 *  already-claimed access URL, and returns the access URL. */
export async function claimToken(setupToken) {
  const trimmed = String(setupToken ?? '').trim();
  if (!trimmed) throw new Error('Paste your SimpleFIN setup token');
  let claimUrl;
  if (/^https?:\/\//.test(trimmed)) {
    if (trimmed.includes('@')) return trimmed; // already an access URL
    claimUrl = trimmed;
  } else {
    claimUrl = Buffer.from(trimmed, 'base64').toString('utf8').trim();
    if (!/^https?:\/\//.test(claimUrl)) {
      throw new Error('That doesn\'t look like a SimpleFIN setup token');
    }
  }
  const res = await fetch(claimUrl, { method: 'POST' });
  if (!res.ok) {
    throw new Error('That setup token didn\'t work. Tokens can only be used once — copy a fresh one from SimpleFIN and try again.');
  }
  const accessUrl = (await res.text()).trim();
  if (!/^https?:\/\/.+@.+/.test(accessUrl)) {
    throw new Error('SimpleFIN sent back something unexpected. Try again with a new setup token.');
  }
  return accessUrl;
}

/** fetch() refuses URLs with embedded credentials, so split them into a
 *  basic-auth header. */
async function sfFetch(accessUrl, path, params = {}) {
  const u = new URL(accessUrl);
  const auth = Buffer.from(
    `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`
  ).toString('base64');
  u.username = '';
  u.password = '';
  const url = new URL(u.toString().replace(/\/$/, '') + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    const err = new Error(sfErrorMessage(res.status));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** SimpleFIN signals bridge-account problems with specific HTTP statuses;
 *  translate the common ones into something the user can act on. */
function sfErrorMessage(status) {
  if (status === 402) {
    return 'Your SimpleFIN subscription looks inactive or unpaid, so your bank data can\'t be fetched. '
      + 'Renew it with your SimpleFIN provider, then try again — you won\'t need a new setup token.';
  }
  if (status === 403) {
    return 'SimpleFIN refused this connection — it may have been revoked. '
      + 'Remove it here and set it up again with a new setup token.';
  }
  return `Couldn't reach SimpleFIN (error ${status}). Try again in a moment.`;
}

/** External account list with balances (no transactions) — used for linking. */
export async function listExternalAccounts(accessUrl) {
  const data = await sfFetch(accessUrl, '/accounts', { 'balances-only': 1 });
  return (data.accounts ?? []).map(a => ({
    id: a.id,
    org: a.org?.name ?? a.org?.domain ?? 'Bank',
    name: a.name,
    currency: a.currency,
    balance: Math.round(parseFloat(a.balance ?? '0') * 100),
  }));
}

function toDate(unixSeconds) {
  return new Date((unixSeconds ?? 0) * 1000).toISOString().slice(0, 10);
}

/** Imports transactions for every account linked to this connection.
 *  Dedupes on (account_id, external_id); a known transaction is updated in
 *  place so pending charges become cleared when they post. */
export async function syncConnection(db, connection, { accountId = null } = {}) {
  const linked = db.prepare(
    accountId != null
      ? 'SELECT * FROM accounts WHERE connection_id = ? AND id = ?'
      : 'SELECT * FROM accounts WHERE connection_id = ?'
  ).all(...(accountId != null ? [connection.id, accountId] : [connection.id]));
  if (linked.length === 0) return { imported: 0, updated: 0, linked: 0 };

  const lookbackDays = connection.last_sync_at ? RESYNC_OVERLAP_DAYS : FIRST_SYNC_DAYS;
  const since = Math.floor(
    (connection.last_sync_at ? connection.last_sync_at / 1000 : Date.now() / 1000) - lookbackDays * 86400
  );

  let data;
  try {
    data = await sfFetch(connection.access_url, '/accounts', { 'start-date': since, pending: 1 });
  } catch (e) {
    db.prepare('UPDATE connections SET last_sync_status = ? WHERE id = ?')
      .run(`error: ${e.message}`, connection.id);
    throw e;
  }

  const findExisting = db.prepare('SELECT id FROM transactions WHERE account_id = ? AND external_id = ?');
  const update = db.prepare('UPDATE transactions SET date = ?, amount = ?, cleared = ? WHERE id = ?');
  const insert = db.prepare(`
    INSERT INTO transactions (account_id, date, payee, memo, amount, cleared, external_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let imported = 0, updated = 0;
  for (const ext of data.accounts ?? []) {
    const acct = linked.find(a => a.external_id === ext.id);
    if (!acct) continue;
    for (const t of ext.transactions ?? []) {
      const amount = Math.round(parseFloat(t.amount) * 100);
      if (!Number.isFinite(amount)) continue;
      const date = toDate(t.posted || t.transacted_at);
      const cleared = t.pending ? 0 : 1;
      const existing = findExisting.get(acct.id, String(t.id));
      if (existing) {
        update.run(date, amount, cleared, existing.id);
        updated++;
      } else {
        const payee = String(t.payee || t.description || '').trim().slice(0, 200);
        insert.run(acct.id, date, payee, String(t.memo ?? '').slice(0, 500), amount, cleared, String(t.id));
        imported++;
      }
    }
  }

  db.prepare('UPDATE connections SET last_sync_at = ?, last_sync_status = ? WHERE id = ?')
    .run(Date.now(), 'ok', connection.id);
  return { imported, updated, linked: linked.length };
}
