// Sign-up, sign-in (with second step), password reset, phone verification, authenticator apps, sessions.
import { Router } from 'express';
import QRCode from 'qrcode';
import { tx, setting } from '../db.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword, createSession, clearSessionCookie, revokeAllSessions, requireRole, requireSession, deviceId } from '../auth.js';
import { bad, conflict, normPhone, required, HttpError } from '../util.js';
import { rateLimit, clearLimit, createOtp, verifyOtp, encrypt, decrypt, newTotpSecret, verifyTotp, totpUri, sha256, randomToken } from '../security.js';
import { queue } from '../services/notify.js';
import { LANGS, t as tr } from '../i18n.js';

const ANY = ['passenger', 'clerk', 'conductor', 'operator', 'admin'];
const COMMON = new Set(['password', 'password1', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123', 'zambia123', 'lusaka123', 'iloveyou', '11111111', '00000000', 'abcd1234', 'myticket']);

export function checkPassword(pw, phone) {
  pw = String(pw || '');
  if (pw.length < 8) throw bad('Use at least 8 characters for the password.');
  if (pw.length > 200) throw bad('That password is too long.');
  if (COMMON.has(pw.toLowerCase()) || /^(\d)\1+$/.test(pw)) throw bad('That password is too easy to guess. Use a longer phrase.');
  const digits = pw.replace(/\D/g, '');
  if (phone && digits.length >= 9 && phone.endsWith(digits.slice(-9))) throw bad('Do not use your phone number as the password.');
}

export default function accountRoutes(db) {
  const r = Router();
  const devCode = code => (config.isProd ? {} : { dev_code: code }); // development only: SMS is not really sent
  const sendCode = (phone, purpose, lang) => {
    const code = createOtp(db, phone, purpose);
    queue(db, { channel: 'sms', to: phone, kind: `otp_${purpose}`, body: tr(lang || 'en', `otp.${purpose}`, { code }) });
    return code;
  };
  const audit = (userId, action, detail) => db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)').run(userId, action, 'user', String(userId), detail ?? null);
  const publicUser = id => {
    const u = db.prepare(`SELECT u.id, u.role, u.name, u.phone, u.email, u.operator_id, u.lang, u.phone_verified, u.totp_enabled, u.admin_scope,
      o.status operator_status, o.name operator_name,
      (SELECT station_city FROM staff st WHERE st.user_id = u.id AND st.active = 1) station_city FROM users u LEFT JOIN operators o ON o.id = u.operator_id WHERE u.id = ?`).get(id);
    return u;
  };
  /** Who must use a second step: every admin; bus company owners when the platform requires it; anyone who turned on an authenticator. */
  const needsMfa = u => u.role === 'admin' || u.totp_enabled || (u.role === 'operator' && setting(db, 'mfa_operator_required') === '1');

  /** Finish a sign-in: remember the device and SMS the owner if it is new. */
  function completeSignIn(req, res, u) {
    const dev = deviceId(req, res);
    const known = db.prepare('SELECT COUNT(*) n FROM known_devices WHERE user_id = ?').get(u.id).n;
    const seen = db.prepare('SELECT 1 FROM known_devices WHERE user_id = ? AND device_id = ?').get(u.id, dev);
    if (!seen) {
      db.prepare('INSERT OR IGNORE INTO known_devices (user_id, device_id, user_agent) VALUES (?,?,?)').run(u.id, dev, String(req.get('user-agent') || '').slice(0, 200));
      if (known > 0) queue(db, { channel: 'sms', to: u.phone, kind: 'new_device', body: tr(u.lang, 'sms.new_device', { device: browserName(req.get('user-agent')), time: new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lusaka', dateStyle: 'medium', timeStyle: 'short' }) }) });
    }
    audit(u.id, 'sign_in', `${req.ip} ${browserName(req.get('user-agent'))}`);
  }

  /* ---------- sign-up ---------- */
  r.post('/auth/register', (req, res) => {
    required(req.body, ['name', 'phone', 'password']);
    const phone = normPhone(req.body.phone);
    checkPassword(req.body.password, phone);
    rateLimit(db, `register:${req.ip}`, 10, 3600);
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw conflict('An account with this phone number already exists. Sign in instead, or reset your password.');
    const u = db.prepare("INSERT INTO users (role, name, phone, email, password_hash, lang) VALUES ('passenger',?,?,?,?,?) RETURNING id, phone, lang")
      .get(req.body.name.trim(), phone, req.body.email?.trim() || null, hashPassword(req.body.password), LANGS[req.body.lang] ? req.body.lang : 'en');
    // Earlier guest bookings with this number are linked only after the phone is verified (stops anyone claiming someone else's trips).
    const code = sendCode(phone, 'verify', u.lang);
    const token = createSession(db, { id: u.id, role: 'passenger' }, req, res);
    completeSignIn(req, res, { ...u, phone });
    res.status(201).json({ token, user: publicUser(u.id), verify_phone: true, ...devCode(code) });
  });

  r.post('/auth/register-operator', (req, res) => {
    required(req.body, ['company_name', 'name', 'phone', 'password']);
    const phone = normPhone(req.body.phone);
    checkPassword(req.body.password, phone);
    rateLimit(db, `register:${req.ip}`, 10, 3600);
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw conflict('An account with this phone number already exists.');
    if (db.prepare('SELECT 1 FROM operators WHERE name = ?').get(req.body.company_name.trim())) throw conflict('A company with this name is already registered.');
    const u = tx(db, () => {
      const o = db.prepare('INSERT INTO operators (name, pacra_no, tpin, contact_phone, contact_email) VALUES (?,?,?,?,?) RETURNING id')
        .get(req.body.company_name.trim(), req.body.pacra_no || null, req.body.tpin || null, phone, req.body.email || null);
      return db.prepare("INSERT INTO users (role, name, phone, email, password_hash, operator_id) VALUES ('operator',?,?,?,?,?) RETURNING id, phone, lang")
        .get(req.body.name.trim(), phone, req.body.email || null, hashPassword(req.body.password), o.id);
    });
    const code = sendCode(phone, 'verify');
    const token = createSession(db, { id: u.id, role: 'operator' }, req, res);
    completeSignIn(req, res, u);
    res.status(201).json({ token, user: publicUser(u.id), verify_phone: true, ...devCode(code) });
  });

  /* ---------- sign-in ---------- */
  r.post('/auth/login', (req, res) => {
    required(req.body, ['phone', 'password']);
    const phone = normPhone(req.body.phone);
    rateLimit(db, `login:ip:${req.ip}`, 60, 900, 'Too many sign-in attempts from this network.'); // stations share one connection
    rateLimit(db, `login:${phone}`, 8, 900, 'Too many sign-in attempts for this number. Wait, or reset your password.');
    const u = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!u || !u.active || !verifyPassword(req.body.password, u.password_hash)) throw new HttpError(401, 'Phone number or password is wrong.');
    clearLimit(db, `login:${phone}`);
    if (needsMfa(u)) {
      const token = createSession(db, u, req, res, { mfaPending: true });
      const methods = [...(u.totp_enabled ? ['totp'] : []), 'sms', ...(u.totp_enabled ? ['recovery'] : [])];
      return res.json({ token, mfa_required: true, methods, user: { name: u.name, role: u.role } });
    }
    const token = createSession(db, u, req, res);
    completeSignIn(req, res, u);
    res.json({ token, user: publicUser(u.id) });
  });

  /** Second step: SMS code, authenticator code or one-time recovery code. */
  r.post('/auth/mfa/sms', requireSession, (req, res) => {
    if (!req.mfaPending) return res.json({ ok: true });
    rateLimit(db, `otp:${req.user.phone}`, 3, 900, 'We already sent several codes.');
    res.json({ ok: true, sent_to: `0${req.user.phone.slice(3, 5)}*****${req.user.phone.slice(-2)}`, ...devCode(sendCode(req.user.phone, 'login', req.user.lang)) });
  });
  r.post('/auth/mfa/verify', requireSession, (req, res) => {
    if (!req.mfaPending) return res.json({ ok: true, user: publicUser(req.user.id) });
    rateLimit(db, `mfa:${req.user.id}`, 6, 900, 'Too many wrong codes.');
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const { method, code } = req.body;
    if (method === 'totp') {
      if (!u.totp_enabled || !verifyTotp(decrypt(u.totp_secret), code)) throw new HttpError(400, 'That code is wrong or has expired. Use the newest code in your authenticator app.', 'mfa_wrong');
    } else if (method === 'recovery') {
      const row = u.totp_enabled && db.prepare('SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').get(u.id, sha256(String(code || '').trim().toUpperCase().replace(/\s/g, '')));
      if (!row) throw new HttpError(400, 'That recovery code is wrong or already used.', 'mfa_wrong');
      db.prepare("UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ?").run(row.id);
      queue(db, { channel: 'sms', to: u.phone, kind: 'recovery_used', body: tr(u.lang, 'sms.recovery_used', {}) });
    } else if (method === 'sms') {
      verifyOtp(db, u.phone, 'login', code);
    } else throw bad('Choose how to confirm it is you.');
    db.prepare('UPDATE sessions SET mfa_pending = 0 WHERE id = ?').run(req.session.id);
    clearLimit(db, `mfa:${u.id}`);
    completeSignIn(req, res, u);
    res.json({ ok: true, user: publicUser(u.id) });
  });

  r.post('/auth/logout', (req, res) => {
    if (req.session) db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?").run(req.session.id);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  /* ---------- sessions ---------- */
  r.get('/auth/sessions', requireRole(...ANY), (req, res) => {
    const rows = db.prepare(`SELECT id, created_at, last_seen, ip, user_agent, device_id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND mfa_pending = 0
      AND expires_at > datetime('now') AND datetime(last_seen, '+' || idle_minutes || ' minutes') > datetime('now') ORDER BY last_seen DESC`).all(req.user.id);
    res.json(rows.map(s => ({ id: s.id.slice(0, 12), created_at: s.created_at, last_seen: s.last_seen, ip: s.ip, device: browserName(s.user_agent), current: s.id === req.session.id })));
  });
  r.delete('/auth/sessions/:id', requireRole(...ANY), (req, res) => {
    const n = db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND substr(id, 1, 12) = ? AND revoked_at IS NULL").run(req.user.id, String(req.params.id)).changes;
    res.json({ ok: true, signed_out: n });
  });
  r.post('/auth/logout-all', requireRole(...ANY), (req, res) => {
    const n = revokeAllSessions(db, req.user.id, req.session.id);
    audit(req.user.id, 'sign_out_everywhere', `${n} sessions`);
    res.json({ ok: true, signed_out: n });
  });

  /* ---------- phone verification & passwords ---------- */
  /** Ask for a code by SMS. purpose=reset works signed out; the answer never reveals whether the number has an account. */
  r.post('/auth/otp', (req, res) => {
    const purpose = req.body.purpose;
    if (purpose === 'verify') {
      if (!req.user || req.mfaPending) throw new HttpError(401, 'Sign in to continue.');
      if (req.user.phone_verified) return res.json({ ok: true, already: true });
      rateLimit(db, `otp:${req.user.phone}`, 3, 900, 'We already sent several codes.');
      return res.json({ ok: true, ...devCode(sendCode(req.user.phone, 'verify', req.user.lang)) });
    }
    if (purpose !== 'reset') throw bad('Unknown code type.');
    const phone = normPhone(req.body.phone);
    rateLimit(db, `otp:ip:${req.ip}`, 10, 3600, 'Too many code requests from this network.');
    rateLimit(db, `otp:${phone}`, 3, 900, 'We already sent several codes to this number.');
    const u = db.prepare('SELECT id, lang FROM users WHERE phone = ? AND active = 1').get(phone);
    const code = u ? sendCode(phone, 'reset', u.lang) : null;
    res.json({ ok: true, message: 'If this number has an account, a code is on its way by SMS.', ...(code ? devCode(code) : {}) });
  });

  r.post('/auth/verify-phone', requireRole(...ANY), (req, res) => {
    verifyOtp(db, req.user.phone, 'verify', req.body.code);
    db.prepare('UPDATE users SET phone_verified = 1 WHERE id = ?').run(req.user.id);
    const linked = req.user.role === 'passenger'
      ? db.prepare("UPDATE bookings SET user_id = ? WHERE user_id IS NULL AND contact_phone = ? AND channel = 'web'").run(req.user.id, req.user.phone).changes : 0;
    res.json({ ok: true, linked_bookings: linked });
  });

  /** Reset with an SMS code. Signs out every device and tells the owner by SMS. */
  r.post('/auth/password/reset', (req, res) => {
    required(req.body, ['phone', 'code', 'password']);
    const phone = normPhone(req.body.phone);
    rateLimit(db, `reset:${phone}`, 10, 3600);
    const u = db.prepare('SELECT * FROM users WHERE phone = ? AND active = 1').get(phone);
    if (!u) throw new HttpError(400, 'That code has expired. Ask for a new one.', 'otp_expired');
    verifyOtp(db, phone, 'reset', req.body.code);
    checkPassword(req.body.password, phone);
    setPassword(u, req.body.password, 'reset', null);
    clearLimit(db, `login:${phone}`);
    res.json({ ok: true });
  });

  r.post('/auth/password/change', requireRole(...ANY), (req, res) => {
    required(req.body, ['current_password', 'password']);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    rateLimit(db, `pwchange:${u.id}`, 5, 900);
    if (!verifyPassword(req.body.current_password, u.password_hash)) throw new HttpError(400, 'Your current password is wrong.');
    checkPassword(req.body.password, u.phone);
    setPassword(u, req.body.password, 'change', req.session.id);
    res.json({ ok: true });
  });

  /** New password: other sessions stop working (all of them after a reset), and the owner gets an SMS. */
  function setPassword(u, pw, how, keepSessionId) {
    db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, phone_verified = 1 WHERE id = ?').run(hashPassword(pw), new Date().toISOString(), u.id);
    revokeAllSessions(db, u.id, keepSessionId);
    queue(db, { channel: 'sms', to: u.phone, kind: 'password_changed', body: tr(u.lang, 'sms.password_changed', {}) });
    audit(u.id, `password_${how}`);
  }

  /* ---------- authenticator app (TOTP) ---------- */
  r.post('/auth/totp/setup', requireRole(...ANY), async (req, res) => {
    const secret = newTotpSecret();
    db.prepare('UPDATE users SET totp_pending_secret = ? WHERE id = ?').run(encrypt(secret), req.user.id);
    const uri = totpUri(secret, `0${req.user.phone.slice(3)}`);
    res.json({ secret, uri, qr_svg: await QRCode.toString(uri, { type: 'svg', margin: 1 }) });
  });
  r.post('/auth/totp/enable', requireRole(...ANY), (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!u.totp_pending_secret) throw bad('Start the setup again.');
    rateLimit(db, `totpsetup:${u.id}`, 10, 900);
    const secret = decrypt(u.totp_pending_secret);
    if (!verifyTotp(secret, req.body.code)) throw bad('That code does not match. Check the time on your phone is automatic, then try the newest code.');
    // Recovery codes: shown once, stored hashed.
    const codes = Array.from({ length: 8 }, () => randomToken(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 8));
    tx(db, () => {
      db.prepare('UPDATE users SET totp_secret = ?, totp_pending_secret = NULL, totp_enabled = 1 WHERE id = ?').run(u.totp_pending_secret, u.id);
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(u.id);
      const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
      for (const c of codes) ins.run(u.id, sha256(c));
    });
    queue(db, { channel: 'sms', to: u.phone, kind: 'totp_on', body: tr(u.lang, 'sms.totp_on', {}) });
    audit(u.id, 'totp_enabled');
    res.json({ ok: true, recovery_codes: codes });
  });
  r.post('/auth/totp/disable', requireRole(...ANY), (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(req.body.password, u.password_hash)) throw bad('Your password is wrong.');
    if (!u.totp_enabled || !verifyTotp(decrypt(u.totp_secret), req.body.code)) throw bad('Enter the current code from your authenticator app.');
    db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(u.id);
    queue(db, { channel: 'sms', to: u.phone, kind: 'totp_off', body: tr(u.lang, 'sms.totp_off', {}) });
    audit(u.id, 'totp_disabled');
    res.json({ ok: true });
  });

  r.get('/auth/security', requireRole(...ANY), (req, res) => {
    const left = db.prepare('SELECT COUNT(*) n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(req.user.id).n;
    res.json({ totp_enabled: !!req.user.totp_enabled, recovery_codes_left: left, mfa_required: needsMfa(req.user), phone_verified: !!req.user.phone_verified });
  });

  return r;
}

export function browserName(ua = '') {
  ua = String(ua);
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ua ? 'App' : 'Browser';
  return `${br} on ${os}`;
}
