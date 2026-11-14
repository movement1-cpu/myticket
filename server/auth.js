import crypto from 'node:crypto';
import { HttpError, forbidden } from './util.js';
import { config } from './config.js';
import { sha256, randomToken } from './security.js';

/* ---------- passwords (scrypt) ---------- */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'base64'));
}

/* ---------- sessions ----------
 * A session is a random token; only its SHA-256 is stored, so a database leak does not leak live sessions.
 * Browsers get it in an HttpOnly, SameSite=Strict cookie (scripts cannot read it). API clients may send it as
 * "Authorization: Bearer <token>". Cookie-authenticated requests that change data must also carry the
 * X-MT-CSRF header, which other websites cannot add without a CORS preflight we never allow.
 */
const STAFF = ['admin', 'operator', 'clerk', 'conductor'];
const POLICY = {
  staff: { idleMin: 12 * 60, maxDays: 7 },
  passenger: { idleMin: 30 * 24 * 60, maxDays: 60 },
};
export const COOKIE = 'mt_session', DEVICE_COOKIE = 'mt_device';
const secure = () => config.baseUrl.startsWith('https://');

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (secure()) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

/** Long-lived random device id (cookie), used for new-device alerts and the session list. */
export function deviceId(req, res) {
  let id = parseCookies(req)[DEVICE_COOKIE];
  if (!id || !/^[\w-]{20,64}$/.test(id)) { id = randomToken(18); setCookie(res, DEVICE_COOKIE, id, 400 * 86400); }
  return id;
}

export function createSession(db, user, req, res, { mfaPending = false } = {}) {
  const token = randomToken(32);
  const p = STAFF.includes(user.role) ? POLICY.staff : POLICY.passenger;
  const device = deviceId(req, res);
  db.prepare(`INSERT INTO sessions (id, user_id, expires_at, idle_minutes, ip, user_agent, device_id, mfa_pending)
    VALUES (?, ?, datetime('now', ?), ?, ?, ?, ?, ?)`).run(sha256(token), user.id, `+${p.maxDays} days`, p.idleMin, req.ip || null,
    String(req.get('user-agent') || '').slice(0, 200), device, mfaPending ? 1 : 0);
  setCookie(res, COOKIE, token, p.maxDays * 86400);
  return token;
}
export function clearSessionCookie(res) { setCookie(res, COOKIE, '', 0); }
export const revokeAllSessions = (db, userId, exceptId = null) =>
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?").run(userId, exceptId).changes;

/** Loads req.user from the session cookie or Bearer token. Never rejects on its own (except CSRF). */
export function authenticate(db) {
  const getUser = db.prepare(`SELECT u.id, u.role, u.name, u.phone, u.email, u.operator_id, u.active, u.lang, u.phone_verified, u.totp_enabled, u.admin_scope,
      o.status AS operator_status, o.name AS operator_name,
      (SELECT station_city FROM staff st WHERE st.user_id = u.id AND st.active = 1) AS station_city
    FROM users u LEFT JOIN operators o ON o.id = u.operator_id WHERE u.id = ?`);
  const getSession = db.prepare(`SELECT * FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
    AND datetime(last_seen, '+' || idle_minutes || ' minutes') > datetime('now')`);
  const touch = db.prepare("UPDATE sessions SET last_seen = datetime('now') WHERE id = ? AND last_seen < datetime('now', '-5 minutes')");
  return (req, _res, next) => {
    const h = req.headers.authorization || '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
    const cookie = parseCookies(req)[COOKIE];
    const token = bearer || cookie;
    if (token) {
      const s = getSession.get(sha256(token));
      if (s) {
        if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-mt-csrf') !== '1') {
          return next(new HttpError(403, 'This request was blocked because it did not come from the MyTicket app.', 'csrf'));
        }
        const u = getUser.get(s.user_id);
        if (u && u.active) { req.user = u; req.session = s; req.mfaPending = !!s.mfa_pending; touch.run(s.id); }
      }
    }
    next();
  };
}

/**
 * Role-based access control.
 *   passenger  – own bookings, reviews, disputes
 *   clerk      – counter sales, manifests and parcels for their own company
 *   conductor  – ticket scanning, trip status, cash sales for their own company
 *   operator   – everything for their own company (fleet, routes, pricing, finance)
 *   admin      – platform-wide governance (narrowed by admin_scope)
 * Company staff are scoped by req.operatorId; every operator query filters on it.
 * A session that still needs its second sign-in step is refused everywhere except the MFA endpoints.
 */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
    if (req.mfaPending) return next(new HttpError(401, 'Finish signing in with your second step.', 'mfa_required'));
    if (!roles.includes(req.user.role)) return next(forbidden());
    if (['operator', 'clerk', 'conductor'].includes(req.user.role)) {
      if (!req.user.operator_id) return next(forbidden('Your account is not linked to a bus company.'));
      req.operatorId = req.user.operator_id;
    }
    next();
  };
}
/** For the second sign-in step: a signed-in session that may still be pending. */
export function requireSession(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
  next();
}

/** Blocks operational endpoints for companies that are pending, rejected or suspended. */
export function requireApprovedOperator(req, _res, next) {
  if (req.user?.role === 'admin' || req.user?.operator_status === 'approved') return next();
  next(forbidden(req.user?.operator_status === 'suspended'
    ? 'This company is suspended. Contact the platform team.'
    : 'This company is awaiting approval. Upload your PACRA, RTSA and tax clearance documents to be verified.'));
}
