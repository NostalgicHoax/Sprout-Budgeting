import { useEffect, useState } from 'react';
import { fmt } from '../money.js';
import { api } from '../api.js';
import ConfirmButton from './ConfirmButton.jsx';

function timeAgo(ts) {
  if (!ts) return 'never';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function ConnectionsModal({ state, refresh, onClose }) {
  const [connections, setConnections] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [external, setExternal] = useState(null);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(null); // { extId, name, type }
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setConnections(await api('/api/connections'));
  }
  useEffect(() => {
    load().catch(e => setMsg({ error: true, text: e.message }));
  }, []);

  async function expand(id) {
    if (expandedId === id) { setExpandedId(null); setExternal(null); return; }
    setExpandedId(id);
    setExternal(null);
    try {
      setExternal(await api(`/api/connections/${id}/accounts`));
    } catch (e) {
      setMsg({ error: true, text: e.message });
      setExpandedId(null);
    }
  }

  async function addConnection() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api('/api/connections', { method: 'POST', body: { token } });
      setToken('');
      setAdding(false);
      await load();
      setExpandedId(r.id);
      setExternal(r.accounts.map(a => ({ ...a, linkedAccountId: null })));
      if (r.warning) {
        // token was accepted and the connection saved, but the bridge wouldn't
        // serve data yet — surface why without making them re-claim a token
        setMsg({ error: true, text: `Connected to ${r.name}, but couldn't load accounts: ${r.warning}` });
      } else {
        setMsg({ error: false, text: `Connected to ${r.name} — now link its accounts below.` });
      }
    } catch (e) {
      setMsg({ error: true, text: e.message });
    }
    setBusy(false);
  }

  /** Bank accounts don't declare their type, so guess from the balance and let
   *  the user correct it before creating. */
  function startCreate(ext) {
    setMsg(null);
    setCreating({
      extId: ext.id,
      name: ext.name,
      type: ext.balance < 0 ? 'credit' : 'cash',
    });
  }

  async function createAndLink(ext) {
    setBusy(true);
    setMsg(null);
    try {
      const { id } = await api('/api/accounts', {
        method: 'POST',
        body: { name: creating.name.trim(), type: creating.type },
      });
      const r = await api(`/api/accounts/${id}/link`, {
        method: 'POST',
        body: { connectionId: expandedId, externalId: ext.id, bankBalance: ext.balance },
      });
      setCreating(null);
      setMsg({
        error: false,
        text: `Added ${creating.name.trim()} and brought in ${r.imported} transaction${r.imported === 1 ? '' : 's'}.`,
      });
      setExternal(await api(`/api/connections/${expandedId}/accounts`));
      await Promise.all([load(), refresh()]);
    } catch (e) {
      setMsg({ error: true, text: e.message });
    }
    setBusy(false);
  }

  async function changeLink(ext, accountId) {
    if (accountId === 'new') { startCreate(ext); return; }
    setCreating(null);
    setBusy(true);
    setMsg(null);
    try {
      if (accountId === '') {
        if (ext.linkedAccountId) {
          await api(`/api/accounts/${ext.linkedAccountId}/unlink`, { method: 'POST', body: {} });
        }
      } else {
        const r = await api(`/api/accounts/${accountId}/link`, {
          method: 'POST',
          body: { connectionId: expandedId, externalId: ext.id, bankBalance: ext.balance },
        });
        setMsg({
          error: false,
          text: `Linked — imported ${r.imported} transaction${r.imported === 1 ? '' : 's'}` +
            (r.adjustment ? ` and added a ${fmt(r.adjustment)} balance adjustment` : ''),
        });
      }
      setExternal(await api(`/api/connections/${expandedId}/accounts`));
      await Promise.all([load(), refresh()]);
    } catch (e) {
      setMsg({ error: true, text: e.message });
    }
    setBusy(false);
  }

  async function syncAll() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api('/api/sync', { method: 'POST', body: {} });
      setMsg({
        error: r.errors.length > 0,
        text: r.errors.length > 0
          ? r.errors.map(e => `${e.connection}: ${e.error}`).join(' · ')
          : `Synced ${r.synced} connection${r.synced === 1 ? '' : 's'} — ${r.imported} new, ${r.updated} updated.`,
      });
      await Promise.all([load(), refresh()]);
    } catch (e) {
      setMsg({ error: true, text: e.message });
    }
    setBusy(false);
  }

  async function remove(conn) {
    await api(`/api/connections/${conn.id}`, { method: 'DELETE' });
    if (expandedId === conn.id) { setExpandedId(null); setExternal(null); }
    await Promise.all([load(), refresh()]);
  }

  const linkableAccounts = state.accounts.filter(a => !a.closed && a.type !== 'loan');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal connections-modal" onClick={e => e.stopPropagation()}>
        <div className="conn-head">
          <h3>🏦 Bank Connections</h3>
          {connections?.length > 0 && (
            <button className="btn btn-accent btn-sm" disabled={busy} onClick={syncAll}>Sync All</button>
          )}
        </div>
        <p className="modal-hint">
          Bring in transactions automatically through <strong>SimpleFIN</strong>. Link each bank
          account to one account in your budget. Your bank details stay private to you.
        </p>

        {connections?.length === 0 && !adding && (
          <p className="panel-hint">No connections yet.</p>
        )}

        {connections?.map(c => (
          <div key={c.id} className="conn-card">
            <div className="conn-row">
              <div className="conn-main">
                <span className="conn-name">{c.name}</span>
                <span className={`conn-status ${c.last_sync_status?.startsWith('error') ? 'err' : ''}`}>
                  {c.last_sync_status?.startsWith('error')
                    ? c.last_sync_status.replace(/^error:\s*/, '')
                    : `${c.linked_accounts} linked · synced ${timeAgo(c.last_sync_at)}`}
                </span>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => expand(c.id)}>
                {expandedId === c.id ? 'Hide' : 'Accounts'}
              </button>
              <ConfirmButton
                className="icon-btn"
                label="✕"
                confirmLabel="Remove?"
                title="Remove connection — linked accounts stay, but stop updating"
                onConfirm={() => remove(c)}
              />
            </div>
            {expandedId === c.id && (
              <div className="conn-external">
                {!external && <p className="panel-hint">Loading bank accounts…</p>}
                {external?.map(ext => (
                  <div key={ext.id} className="ext-item">
                    <div className="ext-row">
                      <div className="ext-main">
                        <span className="ext-name">{ext.name}</span>
                        <span className="ext-balance">{fmt(ext.balance)}</span>
                      </div>
                      <select
                        value={creating?.extId === ext.id ? 'new' : (ext.linkedAccountId ?? '')}
                        disabled={busy}
                        onChange={e => changeLink(ext, e.target.value)}
                      >
                        <option value="">Not linked</option>
                        {linkableAccounts.map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                        <option value="new">＋ Create new account…</option>
                      </select>
                    </div>
                    {creating?.extId === ext.id && (
                      <div className="ext-create">
                        <input
                          autoFocus
                          value={creating.name}
                          placeholder="Account name"
                          onChange={e => setCreating({ ...creating, name: e.target.value })}
                        />
                        <select
                          value={creating.type}
                          onChange={e => setCreating({ ...creating, type: e.target.value })}
                        >
                          <option value="cash">Checking / Savings / Cash</option>
                          <option value="credit">Credit Card</option>
                          <option value="loan">Loan (tracking only)</option>
                        </select>
                        <button className="btn btn-ghost btn-sm" onClick={() => setCreating(null)}>Cancel</button>
                        <button
                          className="btn btn-accent btn-sm"
                          disabled={busy || !creating.name.trim()}
                          onClick={() => createAndLink(ext)}
                        >
                          Create & Link
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {adding ? (
          <div className="sec-body">
            <label>
              SimpleFIN setup token
              <textarea
                className="token-input" rows={3} autoFocus
                placeholder="Paste your SimpleFIN setup token…"
                value={token} onChange={e => setToken(e.target.value)}
              />
            </label>
            <p className="modal-hint">
              Get one from SimpleFIN at bridge.simplefin.org. Each token can only be used once.
            </p>
            <div className="sec-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn btn-accent btn-sm" disabled={busy || !token.trim()} onClick={addConnection}>
                Connect
              </button>
            </div>
          </div>
        ) : (
          <button className="btn btn-solid" onClick={() => { setAdding(true); setMsg(null); }}>
            ＋ Add Connection
          </button>
        )}

        {msg && <p className={msg.error ? 'modal-error' : 'sec-success'}>{msg.text}</p>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
