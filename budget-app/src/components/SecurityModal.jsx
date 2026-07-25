import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api.js';
import { registerPasskey, passkeysSupported } from '../webauthn.js';

export default function SecurityModal({ onClose }) {
  const [security, setSecurity] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    try {
      setSecurity(await api('/api/auth/security'));
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => { load(); }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal security-modal" onClick={e => e.stopPropagation()}>
        <h3>🔐 Security</h3>
        {error && <p className="modal-error">{error}</p>}
        {security && (
          <>
            <PasswordSection />
            <div className="divider" />
            <TotpSection security={security} reload={load} />
            <div className="divider" />
            <PasskeySection security={security} reload={load} />
          </>
        )}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function PasswordSection() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (next !== confirm) { setMsg({ error: true, text: 'New passwords don\'t match' }); return; }
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      setMsg({ error: false, text: 'Password changed. Other devices were signed out.' });
      setCurrent(''); setNext(''); setConfirm('');
      setOpen(false);
    } catch (e) {
      setMsg({ error: true, text: e.message });
    }
    setBusy(false);
  }

  return (
    <div className="sec-section">
      <div className="sec-head">
        <div>
          <div className="sec-title">Password</div>
          <div className="sec-sub">Use a strong password you don't reuse elsewhere. Changing it signs out your other devices.</div>
        </div>
        {!open && <button className="btn btn-ghost btn-sm" onClick={() => { setOpen(true); setMsg(null); }}>Change</button>}
      </div>
      {open && (
        <div className="sec-body">
          <label>Current password
            <input type="password" autoFocus value={current} onChange={e => setCurrent(e.target.value)} />
          </label>
          <label>New password
            <input type="password" placeholder="At least 8 characters" value={next} onChange={e => setNext(e.target.value)} />
          </label>
          <label>Confirm new password
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} />
          </label>
          <div className="sec-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-accent btn-sm" disabled={busy || !current || next.length < 8} onClick={save}>
              Change Password
            </button>
          </div>
        </div>
      )}
      {msg && <p className={msg.error ? 'modal-error' : 'sec-success'}>{msg.text}</p>}
    </div>
  );
}

function TotpSection({ security, reload }) {
  const [setup, setSetup] = useState(null);      // { secret, otpauth, qr }
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function begin() {
    setBusy(true);
    setMsg(null);
    try {
      const s = await api('/api/auth/totp/setup', { method: 'POST', body: {} });
      const qr = await QRCode.toDataURL(s.otpauth, { margin: 1, width: 180, color: { dark: '#e6e8ec', light: '#1e212700' } });
      setSetup({ ...s, qr });
    } catch (e) {
      setMsg({ error: true, text: e.message });
    }
    setBusy(false);
  }

  async function confirm() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api('/api/auth/totp/confirm', { method: 'POST', body: { code } });
      setRecoveryCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      await reload();
    } catch (e) {
      setMsg({ error: true, text: e.message });
    }
    setBusy(false);
  }

  async function disable() {
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/auth/totp/disable', { method: 'POST', body: { password } });
      setDisabling(false);
      setPassword('');
      setRecoveryCodes(null);
      await reload();
    } catch (e) {
      setMsg({ error: true, text: e.message });
    }
    setBusy(false);
  }

  return (
    <div className="sec-section">
      <div className="sec-head">
        <div>
          <div className="sec-title">Two-factor authentication</div>
          <div className="sec-sub">
            {security.totpEnabled
              ? `Enabled · ${security.recoveryCodesLeft} recovery code${security.recoveryCodesLeft === 1 ? '' : 's'} left`
              : 'Require a 6-digit code from an authenticator app at sign-in.'}
          </div>
        </div>
        {!security.totpEnabled && !setup && (
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={begin}>Enable</button>
        )}
        {security.totpEnabled && !disabling && (
          <button className="btn btn-ghost btn-sm" onClick={() => { setDisabling(true); setMsg(null); }}>Disable</button>
        )}
      </div>

      {setup && (
        <div className="sec-body">
          <div className="totp-setup">
            <img src={setup.qr} alt="TOTP QR code" className="totp-qr" />
            <div className="totp-side">
              <p className="sec-sub">Scan this with your authenticator app, or type in this key instead:</p>
              <code className="totp-secret">{setup.secret}</code>
              <label>Enter the current code to confirm
                <input inputMode="numeric" placeholder="123456" value={code} onChange={e => setCode(e.target.value)} />
              </label>
              <div className="sec-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => { setSetup(null); setCode(''); }}>Cancel</button>
                <button className="btn btn-accent btn-sm" disabled={busy || code.trim().length < 6} onClick={confirm}>
                  Confirm & Enable
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {recoveryCodes && (
        <div className="sec-body recovery-box">
          <p className="sec-sub"><strong>Recovery codes</strong> — each works once if you lose your authenticator.
            Save them now; they won't be shown again.</p>
          <div className="recovery-grid">
            {recoveryCodes.map(c => <code key={c}>{c}</code>)}
          </div>
        </div>
      )}

      {disabling && (
        <div className="sec-body">
          <label>Confirm your password to disable two-factor
            <input type="password" autoFocus value={password} onChange={e => setPassword(e.target.value)} />
          </label>
          <div className="sec-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setDisabling(false)}>Cancel</button>
            <button className="btn btn-accent btn-sm" disabled={busy || !password} onClick={disable}>Disable 2FA</button>
          </div>
        </div>
      )}

      {msg && <p className={msg.error ? 'modal-error' : 'sec-success'}>{msg.text}</p>}
    </div>
  );
}

function PasskeySection({ security, reload }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      await registerPasskey(name.trim() || undefined);
      setAdding(false);
      setName('');
      setMsg({ error: false, text: 'Passkey added — you can now sign in with it.' });
      await reload();
    } catch (e) {
      setMsg({ error: true, text: e.message });
    }
    setBusy(false);
  }

  async function remove(id, keyName) {
    if (!confirm(`Remove passkey "${keyName}"?`)) return;
    try {
      await api(`/api/auth/webauthn/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await reload();
    } catch (e) {
      setMsg({ error: true, text: e.message });
    }
  }

  return (
    <div className="sec-section">
      <div className="sec-head">
        <div>
          <div className="sec-title">Passkeys</div>
          <div className="sec-sub">Sign in without typing your password — use Windows Hello, Face ID, your phone, or a security key.</div>
        </div>
        {passkeysSupported() && !adding && (
          <button className="btn btn-ghost btn-sm" onClick={() => { setAdding(true); setMsg(null); }}>Add</button>
        )}
      </div>
      {security.passkeys.length > 0 && (
        <div className="passkey-list">
          {security.passkeys.map(p => (
            <div key={p.id} className="passkey-row">
              <span className="passkey-name">🔑 {p.name}</span>
              <span className="passkey-date">{p.createdAt?.slice(0, 10)}</span>
              <button className="icon-btn" title="Remove passkey" onClick={() => remove(p.id, p.name)}>✕</button>
            </div>
          ))}
        </div>
      )}
      {adding && (
        <div className="sec-body">
          <label>Name (optional)
            <input autoFocus placeholder="e.g. Windows Hello, YubiKey" value={name} onChange={e => setName(e.target.value)} />
          </label>
          <div className="sec-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn btn-accent btn-sm" disabled={busy} onClick={add}>Create Passkey</button>
          </div>
        </div>
      )}
      {!passkeysSupported() && <p className="sec-sub">This browser doesn't support passkeys.</p>}
      {security.passkeys.length === 0 && passkeysSupported() && !adding && (
        <p className="sec-sub">No passkeys yet.</p>
      )}
      {msg && <p className={msg.error ? 'modal-error' : 'sec-success'}>{msg.text}</p>}
    </div>
  );
}
