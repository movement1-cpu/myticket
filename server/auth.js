import crypto from 'node:crypto';
import { sign, safeEqual, HttpError, forbidden } from './util.js';

const TOKEN_DAYS = 7;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'base64'));
}

export function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({ uid: user.id, role: user.role, exp: Date.now() + TOKEN_DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign('tok.' + payload)}`;
}
export function readToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !safeEqual(sig, sign('tok.' + payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

/** Loads req.user from the Bearer token, if any. Never rejects on its own. */
export function authenticate(db) {
  const getUser = db.prepare(`SELECT u.id, u.role, u.name, u.phone, u.email, u.operator_id, u.active,
      o.status AS operator_status, o.name AS operator_name
    FROM users u LEFT JOIN operators o ON o.id = u.operator_id WHERE u.id = ?`);
  return (req, _res, next) => {
    const h = req.headers.authorization || '';
    const data = h.startsWith('Bearer ') && readToken(h.slice(7));
    if (data) {
      const u = getUser.get(data.uid);
      if (u && u.active) req.user = u;
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
 *   admin      – platform-wide governance
 * Company staff are scoped by req.operatorId; every operator query filters on it.
 */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
    if (!roles.includes(req.user.role)) return next(forbidden());
    if (['operator', 'clerk', 'conductor'].includes(req.user.role)) {
      if (!req.user.operator_id) return next(forbidden('Your account is not linked to a bus company.'));
      req.operatorId = req.user.operator_id;
    }
    next();
  };
}

/** Blocks operational endpoints for companies that are pending, rejected or suspended. */
export function requireApprovedOperator(req, _res, next) {
  if (req.user?.role === 'admin' || req.user?.operator_status === 'approved') return next();
  next(forbidden(req.user?.operator_status === 'suspended'
    ? 'This company is suspended. Contact the platform team.'
    : 'This company is awaiting approval. Upload your PACRA, RTSA and tax clearance documents to be verified.'));
}
