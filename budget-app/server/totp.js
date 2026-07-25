import { createHmac, randomBytes } from 'node:crypto';

// RFC 6238 TOTP (SHA-1, 6 digits, 30s period) — no dependencies needed.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secretBuf).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function totpCode(secretBase32, step = Math.floor(Date.now() / 30000)) {
  return hotp(base32Decode(secretBase32), step);
}

/** Accepts the current code plus one step of clock drift either way. */
export function verifyTotp(secretBase32, code, windowSteps = 1) {
  const secret = base32Decode(secretBase32);
  const step = Math.floor(Date.now() / 30000);
  const c = String(code ?? '').trim();
  if (!/^\d{6}$/.test(c)) return false;
  for (let w = -windowSteps; w <= windowSteps; w++) {
    if (hotp(secret, step + w) === c) return true;
  }
  return false;
}

export function otpauthUri(email, secretBase32) {
  return `otpauth://totp/${encodeURIComponent(`Budget:${email}`)}?secret=${secretBase32}&issuer=Budget&algorithm=SHA1&digits=6&period=30`;
}
