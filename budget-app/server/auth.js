import express from 'express';
import { randomBytes } from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import {
  createUser, findUser, unlockUserKey, changePassword,
  createSession, getSession, setSessionBudget, deleteSession,
  createBudgetFor, firstBudgetFor, budgetsFor, budgetOwnedBy, sysdb, openBudgetDb,
  generateRecoveryCodes, storeRecoveryCodes, consumeRecoveryCode,
  addCredential, credentialsFor, credentialById, updateCredentialCounter, deleteCredential,
} from './system.js';
import { verifyPassword, wrapKey, unwrapKey, subKey, hashToken } from './crypto.js';
import { generateTotpSecret, verifyTotp, otpauthUri } from './totp.js';

const COOKIE = 'session';
const MAX_AGE = 90 * 24 * 3600;
const setCookie = (res, token) =>
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${MAX_AGE}`);
const clearCookie = res =>
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);

function getToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function mePayload(userId, activeBudgetId) {
  const user = sysdb.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  return { email: user.email, budgets: budgetsFor(userId), activeBudgetId };
}

/** RP identity is derived from the request so self-hosted domains just work. */
function rpFrom(req) {
  const origin = req.headers.origin || `http://${req.headers.host}`;
  return { origin, rpID: new URL(origin).hostname };
}

// short-lived WebAuthn challenges (single-process self-host: memory is fine)
const challenges = new Map();
function putChallenge(key, challenge) {
  challenges.set(key, { challenge, expires: Date.now() + 5 * 60 * 1000 });
}
function takeChallenge(key) {
  const entry = challenges.get(key);
  challenges.delete(key);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.challenge;
}

const TOTP_WRAP = 'budget-app-totp-wrap:';
const PRF_WRAP = 'budget-app-prf-wrap:';

// ---------- /api/auth ----------
export const authRouter = express.Router();

authRouter.post('/register', (req, res) => {
  const { email, password } = req.body ?? {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? '')) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (findUser(email)) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }
  const { id: userId, dek } = createUser(email, password);
  const budget = firstBudgetFor(userId, dek);
  setCookie(res, createSession(userId, budget.id, dek));
  res.json(mePayload(userId, budget.id));
});

authRouter.post('/login', (req, res) => {
  const { email, password, totpCode } = req.body ?? {};
  const user = findUser(email);
  if (!user || !password || !verifyPassword(password, user.pass)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const dek = unlockUserKey(user, password);
  if (!dek) {
    return res.status(500).json({
      error: 'Your budget can\'t be opened — your account\'s security details look damaged. Restore your most recent backup.',
    });
  }
  if (user.totp_secret) {
    const code = String(totpCode ?? '').trim();
    if (!code) {
      return res.status(401).json({ error: 'Enter your authentication code', totpRequired: true });
    }
    const secret = unwrapKey(user.totp_secret, subKey(dek, TOTP_WRAP))?.toString('utf8');
    const ok = (secret && verifyTotp(secret, code)) || consumeRecoveryCode(user, code);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid authentication code', totpRequired: true });
    }
  }
  const budgets = budgetsFor(user.id);
  const budget = budgets[0] ?? firstBudgetFor(user.id, dek);
  setCookie(res, createSession(user.id, budget.id, dek));
  res.json(mePayload(user.id, budget.id));
});

authRouter.post('/logout', (req, res) => {
  const token = getToken(req);
  if (token) deleteSession(token);
  clearCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  const session = getSession(getToken(req));
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  res.json(mePayload(session.user_id, session.active_budget_id));
});

// ---------- account security (all require a live session) ----------
function requireSession(req, res) {
  const session = getSession(getToken(req));
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  return session;
}

authRouter.post('/change-password', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const { currentPassword, newPassword } = req.body ?? {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const user = sysdb.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  if (!currentPassword || !verifyPassword(currentPassword, user.pass)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  changePassword(user.id, session.dek, newPassword, hashToken(session.token));
  res.json({ ok: true });
});

authRouter.get('/security', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const user = sysdb.prepare('SELECT totp_secret, totp_recovery FROM users WHERE id = ?').get(session.user_id);
  res.json({
    totpEnabled: !!user.totp_secret,
    recoveryCodesLeft: user.totp_recovery ? JSON.parse(user.totp_recovery).length : 0,
    passkeys: credentialsFor(session.user_id).map(c => ({ id: c.id, name: c.name, createdAt: c.created_at })),
  });
});

// ---------- TOTP ----------
authRouter.post('/totp/setup', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const secret = generateTotpSecret();
  sysdb.prepare('UPDATE users SET totp_pending = ? WHERE id = ?')
    .run(wrapKey(Buffer.from(secret, 'utf8'), subKey(session.dek, TOTP_WRAP)), session.user_id);
  res.json({ secret, otpauth: otpauthUri(session.email, secret) });
});

authRouter.post('/totp/confirm', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const user = sysdb.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  if (!user.totp_pending) return res.status(400).json({ error: 'Setup didn\'t start properly — try again' });
  const secret = unwrapKey(user.totp_pending, subKey(session.dek, TOTP_WRAP))?.toString('utf8');
  if (!secret || !verifyTotp(secret, req.body?.code)) {
    return res.status(400).json({ error: 'That code didn\'t match — try again' });
  }
  sysdb.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL WHERE id = ?').run(user.id);
  const recoveryCodes = generateRecoveryCodes();
  storeRecoveryCodes(user.id, recoveryCodes);
  res.json({ recoveryCodes });
});

authRouter.post('/totp/disable', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const user = sysdb.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  if (!req.body?.password || !verifyPassword(req.body.password, user.pass)) {
    return res.status(401).json({ error: 'Password is incorrect' });
  }
  sysdb.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_recovery = NULL WHERE id = ?')
    .run(user.id);
  res.json({ ok: true });
});

// ---------- passkeys (WebAuthn + PRF so a passkey can unlock the data key) ----------
authRouter.post('/webauthn/register-options', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const { rpID } = rpFrom(req);
  const existing = credentialsFor(session.user_id);
  const options = await generateRegistrationOptions({
    rpName: 'Budget',
    rpID,
    userID: Buffer.from(`user-${session.user_id}`),
    userName: session.email,
    attestationType: 'none',
    excludeCredentials: existing.map(c => ({
      id: c.id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  putChallenge(`reg:${hashToken(session.token)}`, options.challenge);
  res.json(options);
});

authRouter.post('/webauthn/register-verify', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const { origin, rpID } = rpFrom(req);
  const expectedChallenge = takeChallenge(`reg:${hashToken(session.token)}`);
  if (!expectedChallenge) return res.status(400).json({ error: 'Registration expired — try again' });
  const prfOutput = req.body?.prfOutput ? Buffer.from(req.body.prfOutput, 'base64url') : null;
  if (!prfOutput || prfOutput.length < 32) {
    return res.status(400).json({
      error: 'This device can\'t be used as a passkey here. Try Windows Hello, your phone, or a security key.',
    });
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body.attResp,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (e) {
    return res.status(400).json({ error: `Passkey registration failed: ${e.message}` });
  }
  if (!verification.verified) return res.status(400).json({ error: 'Passkey registration failed' });
  const cred = verification.registrationInfo.credential;
  addCredential({
    id: cred.id,
    userId: session.user_id,
    name: req.body?.name?.trim() || `Passkey (${new Date().toLocaleDateString('en-US')})`,
    publicKey: Buffer.from(cred.publicKey).toString('base64'),
    counter: cred.counter,
    transports: JSON.stringify(cred.transports ?? []),
    dekPrf: wrapKey(session.dek, subKey(prfOutput, PRF_WRAP)),
  });
  res.json({ ok: true });
});

authRouter.post('/webauthn/login-options', async (req, res) => {
  const { rpID } = rpFrom(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
  const flowId = randomBytes(16).toString('hex');
  putChallenge(`login:${flowId}`, options.challenge);
  res.json({ flowId, options });
});

authRouter.post('/webauthn/login-verify', async (req, res) => {
  const { origin, rpID } = rpFrom(req);
  const { flowId, assertion, prfOutput } = req.body ?? {};
  const expectedChallenge = takeChallenge(`login:${flowId}`);
  if (!expectedChallenge) return res.status(400).json({ error: 'Sign-in expired — try again' });
  const credRow = assertion?.id ? credentialById(assertion.id) : null;
  if (!credRow) return res.status(401).json({ error: 'Unknown passkey' });
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credRow.id,
        publicKey: Buffer.from(credRow.public_key, 'base64'),
        counter: credRow.counter,
      },
      requireUserVerification: false,
    });
  } catch (e) {
    return res.status(401).json({ error: `Passkey sign-in failed: ${e.message}` });
  }
  if (!verification.verified) return res.status(401).json({ error: 'Passkey sign-in failed' });
  updateCredentialCounter(credRow.id, verification.authenticationInfo.newCounter);
  const prf = prfOutput ? Buffer.from(prfOutput, 'base64url') : null;
  const dek = prf ? unwrapKey(credRow.dek_prf, subKey(prf, PRF_WRAP)) : null;
  if (!dek) {
    return res.status(401).json({
      error: 'That passkey was recognized but can\'t open your budget. Sign in with your password instead.',
    });
  }
  const budgets = budgetsFor(credRow.user_id);
  const budget = budgets[0] ?? firstBudgetFor(credRow.user_id, dek);
  setCookie(res, createSession(credRow.user_id, budget.id, dek));
  res.json(mePayload(credRow.user_id, budget.id));
});

authRouter.delete('/webauthn/credentials/:id', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  if (!deleteCredential(session.user_id, req.params.id)) {
    return res.status(404).json({ error: 'Passkey not found' });
  }
  res.json({ ok: true });
});

// ---------- auth gate: unlocks the session's active budget database ----------
export function requireAuth(req, res, next) {
  const session = getSession(getToken(req));
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  req.session = session;
  try {
    req.db = openBudgetDb(session.budget_file, session.dek);
  } catch (e) {
    if (e.code === 'WRONG_KEY') {
      return res.status(409).json({
        error: 'This budget belongs to a different account and can\'t be opened here.',
      });
    }
    throw e;
  }
  next();
}

// ---------- /api/budgets (mounted behind requireAuth) ----------
export const budgetsRouter = express.Router();

budgetsRouter.post('/', (req, res) => {
  const name = req.body?.name?.trim();
  if (!name) return res.status(400).json({ error: 'Budget name is required' });
  const budget = createBudgetFor(req.session.user_id, name, {
    demo: !!req.body.demo,
    dek: req.session.dek,
  });
  setSessionBudget(req.session.token, budget.id);
  res.json(budget);
});

budgetsRouter.post('/:id/select', (req, res) => {
  const budget = budgetOwnedBy(req.session.user_id, req.params.id);
  if (!budget) return res.status(404).json({ error: 'Budget not found' });
  setSessionBudget(req.session.token, budget.id);
  res.json({ ok: true });
});

budgetsRouter.patch('/:id', (req, res) => {
  const budget = budgetOwnedBy(req.session.user_id, req.params.id);
  if (!budget) return res.status(404).json({ error: 'Budget not found' });
  const name = req.body?.name?.trim();
  if (!name) return res.status(400).json({ error: 'Budget name is required' });
  sysdb.prepare('UPDATE budgets SET name = ? WHERE id = ?').run(name, budget.id);
  res.json({ ok: true });
});
