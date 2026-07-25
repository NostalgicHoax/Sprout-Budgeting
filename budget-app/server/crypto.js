import {
  createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto';

// Envelope encryption:
// - Each user has a random 32-byte data key (DEK) that encrypts their budget
//   database files (SQLCipher-style page encryption).
// - The DEK is never stored bare. It is stored wrapped (AES-256-GCM):
//     * by a key derived from the user's password  -> users.dek_pw
//     * by a key derived from each session token   -> sessions.dek_sess
// - Session tokens live only in the user's cookie; the sessions table stores a
//   hash of the token, so the database alone can never unwrap a DEK.

// ---------- passwords ----------
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 64));
}

// ---------- data keys ----------
export function generateDek() {
  return randomBytes(32);
}

/** AES-256-GCM wrap; returns a JSON string safe to store. */
export function wrapKey(dek, kek) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  return JSON.stringify({
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ct: ct.toString('hex'),
  });
}

/** Returns the unwrapped key, or null when the KEK is wrong / data corrupt. */
export function unwrapKey(wrappedJson, kek) {
  try {
    const { iv, tag, ct } = JSON.parse(wrappedJson);
    const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'hex')), decipher.final()]);
  } catch {
    return null;
  }
}

/** KEK derived from a password + per-user salt (hex). */
export function passwordKek(password, saltHex) {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
}

/** KEK derived from a raw session token (which only exists in the cookie). */
export function tokenKek(token) {
  return createHash('sha256').update('budget-app-session-wrap:').update(token).digest();
}

/** Sessions are looked up by token hash so the DB never holds raw tokens. */
export function hashToken(token) {
  return createHash('sha256').update('budget-app-session-id:').update(token).digest('hex');
}

/** Domain-separated 32-byte key derived from other key material — used to wrap
 *  TOTP secrets with the DEK and the DEK with passkey PRF output. */
export function subKey(material, label) {
  return createHash('sha256').update(label).update(material).digest();
}
