import { useState } from 'react';
import { api } from '../api.js';
import { passkeyLogin, passkeysSupported } from '../webauthn.js';

export default function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpNeeded, setTotpNeeded] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  function switchMode(next) {
    setMode(next);
    setError(null);
    setTotpNeeded(false);
    setTotpCode('');
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { email, password };
      if (totpNeeded && totpCode.trim()) body.totpCode = totpCode.trim();
      const me = await api(`/api/auth/${mode}`, { method: 'POST', body });
      onAuthed(me);
    } catch (err) {
      if (err.data?.totpRequired) {
        setTotpNeeded(true);
        if (totpCode.trim()) setError(err.message);
      } else {
        setError(err.message);
      }
      setBusy(false);
    }
  }

  async function usePasskey() {
    setBusy(true);
    setError(null);
    try {
      onAuthed(await passkeyLogin());
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">🌿</div>
        <h2>Budget</h2>
        <div className="auth-tabs">
          <span className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>
            Sign In
          </span>
          <span className={mode === 'register' ? 'active' : ''} onClick={() => switchMode('register')}>
            Create Account
          </span>
        </div>
        <label>
          Email
          <input
            type="email" autoFocus required placeholder="you@example.com"
            value={email} onChange={e => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password" required placeholder={mode === 'register' ? 'At least 8 characters' : 'Password'}
            minLength={mode === 'register' ? 8 : undefined}
            value={password} onChange={e => setPassword(e.target.value)}
          />
        </label>
        {totpNeeded && (
          <label>
            Authentication code
            <input
              autoFocus required inputMode="numeric" placeholder="6-digit code or recovery code"
              value={totpCode} onChange={e => setTotpCode(e.target.value)}
            />
          </label>
        )}
        {error && <p className="modal-error">{error}</p>}
        <button type="submit" className="btn btn-accent" disabled={busy}>
          {mode === 'login' ? 'Sign In' : 'Create Account'}
        </button>
        {mode === 'login' && passkeysSupported() && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={usePasskey}>
            🔑 Sign in with a passkey
          </button>
        )}
        {mode === 'register' && (
          <p className="auth-hint">
            Your budget is private to you — only your password can open it. If you forget
            it, there's no way to recover your data, so keep it somewhere safe.
          </p>
        )}
      </form>
    </div>
  );
}
