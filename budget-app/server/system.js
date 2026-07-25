import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPlain, openEncrypted } from './sqlite.js';
import {
  hashPassword, verifyPassword, generateDek, wrapKey, unwrapKey, passwordKek, tokenKek, hashToken,
} from './crypto.js';
import { createSchema, migrateBudgetDb, seedDemo } from './db.js';

// system.db holds users, budgets, and sessions — metadata and *wrapped* keys
// only, never financial data and never a usable key. Each budget lives in its
// own SQLite file encrypted with the owner's data key (DEK); see crypto.js for
// the envelope scheme. Losing the account password means the data is
// unrecoverable by design.

const __dirname = dirname(fileURLToPath(import.meta.url));
export const dataDir = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });

export const sysdb = openPlain(join(dataDir, 'system.db'));
sysdb.pragma('journal_mode = WAL');
sysdb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    pass TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    file TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// users.dek_pw: the user's DEK wrapped by their password-derived key
const userCols = sysdb.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('dek_pw')) {
  sysdb.exec('ALTER TABLE users ADD COLUMN dek_pw TEXT');
}
// TOTP secrets are stored wrapped with the user's DEK; recovery codes hashed
for (const col of ['totp_secret', 'totp_pending', 'totp_recovery']) {
  if (!userCols.includes(col)) sysdb.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
}

// passkeys: public key for verification + the DEK wrapped by the credential's
// PRF output, which only the authenticator can reproduce
sysdb.exec(`
  CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    dek_prf TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// sessions are keyed by token hash and carry the DEK wrapped by the raw token;
// pre-encryption sessions lack these columns and cannot be upgraded — drop them
const sessionCols = (() => {
  try { return sysdb.prepare('PRAGMA table_info(sessions)').all().map(c => c.name); }
  catch { return []; }
})();
if (sessionCols.length > 0 && !sessionCols.includes('token_hash')) {
  sysdb.exec('DROP TABLE sessions');
}
sysdb.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    active_budget_id INTEGER NOT NULL REFERENCES budgets(id),
    expires_at INTEGER NOT NULL,
    dek_sess TEXT NOT NULL
  );
`);

// ---------- budget database connections ----------
const connections = new Map();

export function openBudgetDb(file, dek) {
  let db = connections.get(file);
  if (db) return db;
  db = openEncrypted(join(dataDir, file), dek.toString('hex'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const has = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'"
  ).get();
  if (!has) createSchema(db);
  migrateBudgetDb(db);
  connections.set(file, db);
  return db;
}

// ---------- users & their data keys ----------
export function createUser(email, password) {
  const { lastInsertRowid } = sysdb.prepare(
    'INSERT INTO users (email, pass) VALUES (?, ?)'
  ).run(email.trim().toLowerCase(), hashPassword(password));
  const id = Number(lastInsertRowid);
  const dek = provisionUserKey(id, password);
  return { id, dek };
}

export function findUser(email) {
  return sysdb.prepare('SELECT * FROM users WHERE email = ?').get(String(email ?? '').trim().toLowerCase());
}

/** Generates a fresh DEK and stores it wrapped by the password. Also used to
 *  upgrade accounts that predate encryption (their first login provisions a
 *  key, and their plaintext budget files are encrypted on next open). */
export function provisionUserKey(userId, password) {
  const dek = generateDek();
  const salt = randomBytes(16).toString('hex');
  const wrapped = { salt, ...JSON.parse(wrapKey(dek, passwordKek(password, salt))) };
  sysdb.prepare('UPDATE users SET dek_pw = ? WHERE id = ?').run(JSON.stringify(wrapped), userId);
  return dek;
}

/** Recovers the user's DEK from their password at login. Returns null when the
 *  wrap doesn't open (wrong password — should not happen after verifyPassword). */
export function unlockUserKey(user, password) {
  if (!user.dek_pw) return provisionUserKey(user.id, password);
  const wrapped = JSON.parse(user.dek_pw);
  return unwrapKey(user.dek_pw, passwordKek(password, wrapped.salt));
}

/** New password: re-hash, re-wrap the DEK (no data re-encryption needed), and
 *  sign out every other session. */
export function changePassword(userId, dek, newPassword, currentTokenHash) {
  const salt = randomBytes(16).toString('hex');
  const wrapped = { salt, ...JSON.parse(wrapKey(dek, passwordKek(newPassword, salt))) };
  sysdb.prepare('UPDATE users SET pass = ?, dek_pw = ? WHERE id = ?')
    .run(hashPassword(newPassword), JSON.stringify(wrapped), userId);
  sysdb.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
    .run(userId, currentTokenHash ?? '');
}

// ---------- TOTP & recovery codes ----------
export function generateRecoveryCodes() {
  return Array.from({ length: 8 }, () => {
    const raw = randomBytes(5).toString('hex');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function storeRecoveryCodes(userId, codes) {
  sysdb.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?')
    .run(JSON.stringify(codes.map(c => hashPassword(c))), userId);
}

/** Burns a matching recovery code; returns whether one matched. */
export function consumeRecoveryCode(user, code) {
  if (!user.totp_recovery) return false;
  const hashes = JSON.parse(user.totp_recovery);
  const idx = hashes.findIndex(h => {
    try { return verifyPassword(code, h); } catch { return false; }
  });
  if (idx === -1) return false;
  hashes.splice(idx, 1);
  sysdb.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?')
    .run(JSON.stringify(hashes), user.id);
  return true;
}

// ---------- passkey credentials ----------
export function addCredential({ id, userId, name, publicKey, counter, transports, dekPrf }) {
  sysdb.prepare(`
    INSERT INTO webauthn_credentials (id, user_id, name, public_key, counter, transports, dek_prf)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, name, publicKey, counter, transports, dekPrf);
}

export function credentialsFor(userId) {
  return sysdb.prepare(
    'SELECT id, name, counter, transports, created_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at'
  ).all(userId);
}

export function credentialById(id) {
  return sysdb.prepare('SELECT * FROM webauthn_credentials WHERE id = ?').get(id);
}

export function updateCredentialCounter(id, counter) {
  sysdb.prepare('UPDATE webauthn_credentials SET counter = ? WHERE id = ?').run(counter, id);
}

export function deleteCredential(userId, id) {
  return sysdb.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

// ---------- budgets ----------
export function createBudgetFor(userId, name, { demo = false, dek } = {}) {
  const { lastInsertRowid } = sysdb.prepare(
    "INSERT INTO budgets (user_id, name, file) VALUES (?, ?, '')"
  ).run(userId, name);
  const id = Number(lastInsertRowid);
  const file = `budget-${id}.db`;
  sysdb.prepare('UPDATE budgets SET file = ? WHERE id = ?').run(file, id);
  const db = openBudgetDb(file, dek);
  if (demo) seedDemo(db);
  return { id, name };
}

/** First budget for a new user: adopt the pre-auth budget.db if nobody owns it
 *  yet, otherwise start a fresh empty budget. */
export function firstBudgetFor(userId, dek) {
  const legacyOwned = sysdb.prepare(
    "SELECT COUNT(*) AS n FROM budgets WHERE file = 'budget.db'"
  ).get().n > 0;
  if (!legacyOwned && existsSync(join(dataDir, 'budget.db'))) {
    const { lastInsertRowid } = sysdb.prepare(
      "INSERT INTO budgets (user_id, name, file) VALUES (?, '2026 Budget', 'budget.db')"
    ).run(userId);
    return { id: Number(lastInsertRowid), name: '2026 Budget' };
  }
  return createBudgetFor(userId, 'My Budget', { dek });
}

export function budgetsFor(userId) {
  return sysdb.prepare(
    'SELECT id, name FROM budgets WHERE user_id = ? ORDER BY id'
  ).all(userId);
}

export function budgetOwnedBy(userId, budgetId) {
  return sysdb.prepare(
    'SELECT * FROM budgets WHERE id = ? AND user_id = ?'
  ).get(budgetId, userId);
}

// ---------- sessions ----------
const SESSION_DAYS = 90;

export function createSession(userId, budgetId, dek) {
  const token = randomBytes(32).toString('hex');
  sysdb.prepare(
    'INSERT INTO sessions (token_hash, user_id, active_budget_id, expires_at, dek_sess) VALUES (?, ?, ?, ?, ?)'
  ).run(hashToken(token), userId, budgetId, Date.now() + SESSION_DAYS * 24 * 3600 * 1000, wrapKey(dek, tokenKek(token)));
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const row = sysdb.prepare(`
    SELECT s.token_hash, s.user_id, s.active_budget_id, s.expires_at, s.dek_sess,
           u.email, b.file AS budget_file
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN budgets b ON b.id = s.active_budget_id
    WHERE s.token_hash = ?
  `).get(hashToken(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    sysdb.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  const dek = unwrapKey(row.dek_sess, tokenKek(token));
  if (!dek) return null;
  return { ...row, token, dek };
}

export function setSessionBudget(token, budgetId) {
  sysdb.prepare('UPDATE sessions SET active_budget_id = ? WHERE token_hash = ?').run(budgetId, hashToken(token));
}

export function deleteSession(token) {
  sysdb.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}
