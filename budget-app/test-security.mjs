// End-to-end security test against the running API: password change, TOTP
// (+recovery codes), and passkeys via a simulated WebAuthn authenticator.
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { totpCode } from './server/totp.js';

const BASE = 'http://localhost:3178';
const ORIGIN = BASE;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

let cookie = null;
async function call(path, { method = 'GET', body, keepCookie = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (keepCookie && setCookie) cookie = setCookie.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const EMAIL = 'sec-test@example.com';
const PASS1 = 'initial-password-1';
const PASS2 = 'rotated-password-2';

// idempotent: remove leftovers from a previous run
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
{
  const dataPath = p => fileURLToPath(new URL(`./server/data/${p}`, import.meta.url));
  const sysdb = new DatabaseSync(dataPath('system.db'));
  const old = sysdb.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL);
  if (old) {
    const budgets = sysdb.prepare('SELECT file FROM budgets WHERE user_id = ?').all(old.id);
    sysdb.prepare('DELETE FROM sessions WHERE user_id = ?').run(old.id);
    sysdb.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(old.id);
    sysdb.prepare('DELETE FROM budgets WHERE user_id = ?').run(old.id);
    sysdb.prepare('DELETE FROM users WHERE id = ?').run(old.id);
    for (const b of budgets) {
      if (b.file === 'budget.db') continue;
      for (const s of ['', '-wal', '-shm']) {
        try { rmSync(dataPath(b.file + s)); } catch {}
      }
    }
  }
  sysdb.close();
}

// ---------- register + baseline ----------
let r = await call('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: PASS1 } });
check('register', r.status === 200, `status ${r.status}`);
r = await call('/api/state?month=2026-07');
check('state readable after register', r.status === 200);

// ---------- password change ----------
r = await call('/api/auth/change-password', { method: 'POST', body: { currentPassword: 'nope', newPassword: PASS2 } });
check('change-password rejects wrong current', r.status === 401);
r = await call('/api/auth/change-password', { method: 'POST', body: { currentPassword: PASS1, newPassword: PASS2 } });
check('change-password succeeds', r.status === 200);
r = await call('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASS1 }, keepCookie: false });
check('old password rejected after change', r.status === 401);
r = await call('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASS2 } });
check('new password logs in', r.status === 200);
r = await call('/api/state?month=2026-07');
check('data still decrypts after password change', r.status === 200, 'DEK re-wrap intact');

// ---------- TOTP ----------
r = await call('/api/auth/totp/setup', { method: 'POST', body: {} });
check('totp setup returns secret', r.status === 200 && !!r.json.secret);
const secret = r.json.secret;
r = await call('/api/auth/totp/confirm', { method: 'POST', body: { code: '000000' } });
check('totp confirm rejects bad code', r.status === 400);
r = await call('/api/auth/totp/confirm', { method: 'POST', body: { code: totpCode(secret) } });
check('totp confirm accepts valid code', r.status === 200 && r.json.recoveryCodes?.length === 8,
  `${r.json?.recoveryCodes?.length ?? 0} recovery codes`);
const recovery = r.json.recoveryCodes ?? [];

r = await call('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASS2 }, keepCookie: false });
check('login without code returns totpRequired', r.status === 401 && r.json.totpRequired === true);
r = await call('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASS2, totpCode: '111111' }, keepCookie: false });
check('login rejects wrong code', r.status === 401);
r = await call('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASS2, totpCode: totpCode(secret) } });
check('login accepts totp code', r.status === 200);
r = await call('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASS2, totpCode: recovery[0] } });
check('login accepts recovery code', r.status === 200);
r = await call('/api/auth/security');
check('recovery code consumed', r.json?.recoveryCodesLeft === 7, `${r.json?.recoveryCodesLeft} left`);
r = await call('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASS2, totpCode: recovery[0] }, keepCookie: false });
check('used recovery code rejected', r.status === 401);

// ---------- passkeys (simulated authenticator) ----------
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
}
function cbor(v) {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) { const b = Buffer.from(v); return Buffer.concat([head(2, b.length), b]); }
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (Number.isInteger(v)) return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v.entries()].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const e = Object.entries(v);
  return Buffer.concat([head(5, e.length), ...e.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });
const credId = randomBytes(32);
const rpIdHash = createHash('sha256').update('localhost').digest();
const fakePrf = randomBytes(32); // stands in for the authenticator's PRF output

r = await call('/api/auth/webauthn/register-options', { method: 'POST', body: {} });
check('register-options', r.status === 200 && !!r.json.challenge);
const regChallenge = r.json.challenge;

const cosePubkey = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
const attestedCred = Buffer.concat([
  Buffer.alloc(16),                               // aaguid
  (() => { const b = Buffer.alloc(2); b.writeUInt16BE(credId.length); return b; })(),
  credId,
  cbor(cosePubkey),
]);
const regAuthData = Buffer.concat([rpIdHash, Buffer.from([0x45]), Buffer.alloc(4), attestedCred]);
const regClientData = Buffer.from(JSON.stringify({
  type: 'webauthn.create', challenge: regChallenge, origin: ORIGIN, crossOrigin: false,
}));

r = await call('/api/auth/webauthn/register-verify', {
  method: 'POST',
  body: {
    name: 'Simulated Key',
    prfOutput: fakePrf.toString('base64url'),
    attResp: {
      id: credId.toString('base64url'),
      rawId: credId.toString('base64url'),
      type: 'public-key',
      response: {
        clientDataJSON: regClientData.toString('base64url'),
        attestationObject: cbor({ fmt: 'none', attStmt: {}, authData: regAuthData }).toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    },
  },
});
check('passkey registration verifies', r.status === 200, JSON.stringify(r.json));

r = await call('/api/auth/security');
check('passkey listed', r.json?.passkeys?.length === 1 && r.json.passkeys[0].name === 'Simulated Key');

async function assertLogin(prfBuf, counter) {
  const o = await call('/api/auth/webauthn/login-options', { method: 'POST', body: {}, keepCookie: false });
  const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(counter); return b; })()]);
  const clientData = Buffer.from(JSON.stringify({
    type: 'webauthn.get', challenge: o.json.options.challenge, origin: ORIGIN, crossOrigin: false,
  }));
  const sig = createSign('SHA256')
    .update(Buffer.concat([authData, createHash('sha256').update(clientData).digest()]))
    .sign(privateKey);
  return call('/api/auth/webauthn/login-verify', {
    method: 'POST',
    body: {
      flowId: o.json.flowId,
      prfOutput: prfBuf ? prfBuf.toString('base64url') : null,
      assertion: {
        id: credId.toString('base64url'),
        rawId: credId.toString('base64url'),
        type: 'public-key',
        response: {
          clientDataJSON: clientData.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: sig.toString('base64url'),
          userHandle: null,
        },
        clientExtensionResults: {},
      },
    },
    keepCookie: prfBuf === fakePrf,
  });
}

r = await assertLogin(randomBytes(32), 1);
check('wrong PRF output cannot unlock data', r.status === 401);
cookie = null; // the passkey session must stand on its own
r = await assertLogin(fakePrf, 2);
check('passkey login with PRF succeeds', r.status === 200, JSON.stringify(r.json?.email));
r = await call('/api/state?month=2026-07');
check('data decrypts via passkey session', r.status === 200);

// ---------- TOTP disable ----------
r = await call('/api/auth/totp/disable', { method: 'POST', body: { password: PASS2 } });
check('totp disable', r.status === 200);
r = await call('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASS2 }, keepCookie: false });
check('login without code after disable', r.status === 200);

console.log(results.join('\n'));
