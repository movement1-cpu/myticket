// Shared security building blocks: persistent rate limits, one-time SMS codes, field encryption, TOTP.
import crypto from 'node:crypto';
import { config } from './config.js';
import { HttpError, safeEqual } from './util.js';

/* ---------- rate limits (stored in the database, so a restart does not reset them) ---------- */
export function rateLimit(db, key, max, windowSec, message = 'Too many attempts. Wait a few minutes and try again.') {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT window_start, count FROM rate_limits WHERE key = ?').get(key);
  if (!row || now - row.window_start >= windowSec) {
    db.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1').run(key, now);
    return;
  }
  if (row.count >= max) {
    const wait = Math.ceil((windowSec - (now - row.window_start)) / 60);
    throw new HttpError(429, `${message}${wait > 1 ? ` (about ${wait} minutes)` : ''}`, 'rate_limited');
  }
  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
}
export const clearLimit = (db, key) => db.prepare('DELETE FROM rate_limits WHERE key = ?').run(key);
export function pruneRateLimits(db) {
  db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(Math.floor(Date.now() / 1000) - 86400);
}

/* ---------- field encryption (AES-256-GCM) ---------- */
// DATA_KEY: 32 random bytes, base64. Without it, a key is derived from APP_SECRET (fine for development).
const dataKey = config.dataKey
  ? Buffer.from(config.dataKey, 'base64')
  : Buffer.from(crypto.hkdfSync('sha256', config.secret, 'myticket', 'field-encryption', 32));
if (dataKey.length !== 32) throw new Error('DATA_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).');

export const isEncrypted = v => typeof v === 'string' && v.startsWith('enc:v1:');
export function encrypt(plain) {
  if (plain == null || plain === '' || isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}
export function decrypt(v) {
  if (!isEncrypted(v)) return v;
  const [, , iv, tag, ct] = v.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/* ---------- one-time SMS codes ---------- */
const OTP_MINUTES = 5, OTP_TRIES = 3;
const otpHash = (phone, purpose, code) => crypto.createHmac('sha256', config.secret).update(`otp|${phone}|${purpose}|${code}`).digest('hex');

/** Create a 6-digit code (replaces any earlier unused one for the same phone + purpose). Returns the code. */
export function createOtp(db, phone, purpose) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare('UPDATE otp_codes SET used_at = datetime(\'now\') WHERE phone = ? AND purpose = ? AND used_at IS NULL').run(phone, purpose);
  db.prepare("INSERT INTO otp_codes (phone, purpose, code_hash, expires_at) VALUES (?, ?, ?, datetime('now', ?))").run(phone, purpose, otpHash(phone, purpose, code), `+${OTP_MINUTES} minutes`);
  return code;
}

/** Check a code. Wrong codes count as attempts; after 3 the code is dead. Throws on failure. */
export function verifyOtp(db, phone, purpose, code) {
  const row = db.prepare("SELECT * FROM otp_codes WHERE phone = ? AND purpose = ? AND used_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1").get(phone, purpose);
  if (!row) throw new HttpError(400, 'That code has expired. Ask for a new one.', 'otp_expired');
  if (row.attempts >= OTP_TRIES) throw new HttpError(400, 'Too many wrong codes. Ask for a new one.', 'otp_locked');
  if (!safeEqual(row.code_hash, otpHash(phone, purpose, String(code || '').trim()))) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = OTP_TRIES - row.attempts - 1;
    throw new HttpError(400, left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Ask for a new one.', 'otp_wrong');
  }
  db.prepare("UPDATE otp_codes SET used_at = datetime('now') WHERE id = ?").run(row.id);
}

/* ---------- TOTP (RFC 6238: authenticator apps such as Google Authenticator, Microsoft Authenticator) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32(crypto.randomBytes(20));
export function totp(secret, at = Date.now(), step = 30) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
/** Accepts the current code and one step either side (clock drift). */
export const verifyTotp = (secret, code) => [-1, 0, 1].some(w => safeEqual(totp(secret, Date.now() + w * 30000), String(code || '').trim()));
export const totpUri = (secret, label) => `otpauth://totp/${encodeURIComponent(`MyTicket:${label}`)}?secret=${secret}&issuer=MyTicket&digits=6&period=30`;

export const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/* ---------- ID numbers (NRC / passport) ---------- */
/** What staff and passengers see: enough to compare with the physical ID, not enough to misuse. */
export function maskId(type, num) {
  const v = String(num || '').trim().toUpperCase();
  if (!v || v === 'REMOVED') return 'removed';
  if (type === 'NRC' && /^\d{6}\/\d{2}\/\d$/.test(v)) return `****${v.slice(4)}`;
  return `${'*'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`;
}
/** [encrypted value, masked hint] for storage. */
export function protectId(type, num) {
  const v = String(num || '').trim().toUpperCase();
  return [encrypt(v), maskId(type, v)];
}
/** Encrypt any ID numbers still stored in plain text (older data, seed data). Idempotent. */
export function protectStoredIds(db) {
  const rows = db.prepare("SELECT id, id_type, id_number FROM booking_seats WHERE id_number NOT LIKE 'enc:v1:%' AND id_number != 'REMOVED'").all();
  const up = db.prepare('UPDATE booking_seats SET id_number = ?, id_hint = ? WHERE id = ?');
  db.exec('BEGIN');
  try { for (const r of rows) up.run(...protectId(r.id_type, r.id_number), r.id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  return rows.length;
}
