import { Router } from 'express';
import { tx, setting } from '../db.js';
import { requireRole, hashPassword } from '../auth.js';
import { bad, notFound, conflict, required, normPhone, money, localDate, addDays, isDate } from '../util.js';
import { notifyContact, queue } from '../services/notify.js';
import { balance } from './operator.js';

export default function adminRoutes(db) {
  const r = Router();
  const admin = requireRole('admin');
  const audit = (req, action, entity, id, detail) => db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)').run(req.user.id, action, entity, String(id), detail ?? null);

  /* ---------- operator governance ---------- */
  r.get('/admin/operators', admin, (_req, res) => {
    const ops = db.prepare(`SELECT o.*, (SELECT COUNT(*) FROM buses b WHERE b.operator_id = o.id) buses,
        (SELECT ROUND(AVG((cleanliness+punctuality+driver)/3.0),2) FROM reviews WHERE operator_id = o.id) rating FROM operators o ORDER BY o.status = 'pending' DESC, o.name`).all();
    const docs = db.prepare("SELECT id, kind, filename, status, expires_on, uploaded_at FROM documents WHERE operator_id = ? AND owner_type = 'operator' ORDER BY id DESC");
    res.json(ops.map(o => ({ ...o, documents: docs.all(o.id) })));
  });
  r.post('/admin/operators/:id/status', admin, (req, res) => {
    const o = db.prepare('SELECT * FROM operators WHERE id = ?').get(req.params.id);
    if (!o) throw notFound();
    const { status, note } = req.body;
    if (!['approved', 'suspended', 'rejected'].includes(status)) throw bad('Status must be approved, suspended or rejected.');
    if (status === 'approved') {
      const kinds = new Set(db.prepare("SELECT kind FROM documents WHERE operator_id = ? AND owner_type = 'operator' AND status != 'rejected'").all(o.id).map(d => d.kind));
      const missing = ['pacra', 'rtsa_licence', 'tax_clearance'].filter(k => !kinds.has(k));
      if (missing.length && !req.body.override) throw conflict(`Missing documents: ${missing.join(', ')}. Ask the company to upload them, or approve with override.`);
    }
    if (status !== 'approved' && !note) throw bad('Give a reason. The company sees it.');
    db.prepare('UPDATE operators SET status = ?, status_note = ?, rtsa_verified = CASE WHEN ? = \'approved\' THEN 1 ELSE rtsa_verified END WHERE id = ?').run(status, note || null, status, o.id);
    if (o.contact_phone) notifyContact(db, { phone: o.contact_phone, email: o.contact_email, kind: 'operator_status', subject: `MyTicket account ${status}`,
      body: status === 'approved' ? `MyTicket: ${o.name} is approved. Your buses can now be booked online.` : `MyTicket: ${o.name} has been ${status}. Reason: ${note}` });
    audit(req, `operator_${status}`, 'operator', o.id, note);
    res.json({ ok: true });
  });
  r.post('/admin/documents/:id', admin, (req, res) => {
    if (!['verified', 'rejected'].includes(req.body.status)) throw bad('Mark the document verified or rejected.');
    const d = db.prepare('UPDATE documents SET status = ? WHERE id = ? RETURNING id').get(req.body.status, req.params.id);
    if (!d) throw notFound();
    audit(req, `document_${req.body.status}`, 'document', d.id);
    res.json({ ok: true });
  });

  /* ---------- commission & fee engine ---------- */
  r.get('/admin/settings', admin, (_req, res) => {
    res.json({ booking_fee: Number(setting(db, 'booking_fee')), commission_pct: Number(setting(db, 'commission_pct')), hold_minutes: Number(setting(db, 'hold_minutes')),
      reserve_minutes: Number(setting(db, 'reserve_minutes')), refund_policy: JSON.parse(setting(db, 'refund_policy')),
      loyalty_points_per_kwacha: Number(setting(db, 'loyalty_points_per_kwacha')), loyalty_point_value: Number(setting(db, 'loyalty_point_value')), loyalty_max_pct: Number(setting(db, 'loyalty_max_pct')) });
  });
  r.put('/admin/settings', admin, (req, res) => {
    const b = req.body, up = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    const num = (k, min, max) => { if (b[k] === undefined) return; const v = Number(b[k]); if (!(v >= min && v <= max)) throw bad(`${k.replace(/_/g, ' ')} must be between ${min} and ${max}.`); up.run(String(v), k); };
    tx(db, () => { num('booking_fee', 0, 500); num('commission_pct', 0, 30); num('hold_minutes', 5, 15); num('reserve_minutes', 10, 120);
      num('loyalty_points_per_kwacha', 0, 1); num('loyalty_point_value', 0, 1); num('loyalty_max_pct', 0, 100); });
    audit(req, 'settings', 'settings', '-', JSON.stringify(b));
    res.json({ ok: true });
  });
  r.put('/admin/operators/:id/terms', admin, (req, res) => {
    const pct = req.body.commission_pct === '' || req.body.commission_pct == null ? null : Number(req.body.commission_pct);
    const fee = req.body.booking_fee === '' || req.body.booking_fee == null ? null : Number(req.body.booking_fee);
    if (pct != null && !(pct >= 0 && pct <= 30)) throw bad('Commission must be between 0% and 30%.');
    if (fee != null && !(fee >= 0 && fee <= 500)) throw bad('Booking fee must be between K0 and K500.');
    db.prepare('UPDATE operators SET commission_pct = ?, booking_fee = ? WHERE id = ?').run(pct, fee, req.params.id);
    audit(req, 'terms', 'operator', req.params.id, `commission=${pct} fee=${fee}`);
    res.json({ ok: true });
  });

  /* ---------- disputes, refunds, failed payments ---------- */
  r.get('/admin/disputes', admin, (req, res) => {
    res.json(db.prepare(`SELECT d.*, b.ref, b.total, b.status booking_status, b.contact_phone, b.contact_name, o.name operator FROM disputes d
      LEFT JOIN bookings b ON b.id = d.booking_id LEFT JOIN operators o ON o.id = b.operator_id
      WHERE (? = 'all' OR d.status = ?) ORDER BY d.status = 'open' DESC, d.id DESC LIMIT 200`).all(req.query.status || 'open', req.query.status || 'open'));
  });
  r.post('/admin/disputes/:id/resolve', admin, (req, res) => {
    const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(req.params.id);
    if (!d) throw notFound();
    if (d.status !== 'open') throw conflict('This case is already closed.');
    const status = req.body.status === 'rejected' ? 'rejected' : 'resolved';
    required(req.body, ['resolution']);
    const amount = money(Number(req.body.refund_amount) || 0);
    tx(db, () => {
      if (amount > 0) {
        if (!d.booking_id) throw bad('A refund needs a booking on the case.');
        const b = db.prepare('SELECT total FROM bookings WHERE id = ?').get(d.booking_id);
        const already = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM refunds WHERE booking_id = ?').get(d.booking_id).v;
        if (amount + already > b.total + 0.001) throw bad(`Refunds cannot exceed what was paid (K${b.total.toFixed(2)}, already refunded K${already.toFixed(2)}).`);
        db.prepare('INSERT INTO refunds (booking_id, amount, reason) VALUES (?,?,?)').run(d.booking_id, amount, `Dispute #${d.id}: ${req.body.resolution}`);
      }
      db.prepare("UPDATE disputes SET status = ?, resolution = ?, refund_amount = ?, resolved_at = datetime('now') WHERE id = ?").run(status, req.body.resolution, amount || null, d.id);
    });
    const b = d.booking_id && db.prepare('SELECT contact_phone, contact_email, ref FROM bookings WHERE id = ?').get(d.booking_id);
    if (b) notifyContact(db, { phone: b.contact_phone, email: b.contact_email, kind: 'dispute', subject: `Case #${d.id} ${status}`,
      body: `MyTicket: Your case #${d.id} about ${b.ref} is ${status}. ${req.body.resolution}${amount ? ` Refund: K${amount.toFixed(2)}.` : ''}` });
    audit(req, `dispute_${status}`, 'dispute', d.id, req.body.resolution);
    res.json({ ok: true });
  });
  r.get('/admin/payments', admin, (req, res) => {
    res.json(db.prepare(`SELECT p.*, (SELECT GROUP_CONCAT(ref) FROM bookings WHERE group_ref = p.group_ref) refs, (SELECT contact_phone FROM bookings WHERE group_ref = p.group_ref LIMIT 1) phone
      FROM payments p WHERE (? = 'all' OR p.status = ?) ORDER BY p.id DESC LIMIT 200`).all(req.query.status || 'failed', req.query.status || 'failed'));
  });
  r.get('/admin/refunds', admin, (req, res) => {
    res.json(db.prepare(`SELECT r.*, b.ref, b.payment_method, b.contact_phone, o.name operator FROM refunds r JOIN bookings b ON b.id = r.booking_id JOIN operators o ON o.id = b.operator_id
      WHERE (? = 'all' OR r.status = ?) ORDER BY r.id DESC LIMIT 200`).all(req.query.status || 'pending', req.query.status || 'pending'));
  });
  /** Mark a refund as paid out (the actual disbursement happens in the provider's portal or a payout API). */
  r.post('/admin/refunds/:id', admin, (req, res) => {
    const st = req.body.status;
    if (!['paid', 'failed'].includes(st)) throw bad('Mark the refund paid or failed.');
    const row = db.prepare("UPDATE refunds SET status = ? WHERE id = ? AND status = 'pending' RETURNING id").get(st, req.params.id);
    if (!row) throw conflict('This refund is already processed.');
    audit(req, `refund_${st}`, 'refund', row.id);
    res.json({ ok: true });
  });

  /* ---------- settlements ---------- */
  r.get('/admin/settlements', admin, (_req, res) => {
    res.json(db.prepare(`SELECT s.*, o.name operator FROM settlements s JOIN operators o ON o.id = s.operator_id ORDER BY s.status = 'requested' DESC, s.id DESC LIMIT 200`).all()
      .map(s => ({ ...s, balance: s.status === 'requested' ? balance(db, s.operator_id) : null })));
  });
  r.post('/admin/settlements/:id', admin, (req, res) => {
    const st = req.body.status;
    if (!['paid', 'rejected'].includes(st)) throw bad('Mark the payout paid or rejected.');
    const row = db.prepare("UPDATE settlements SET status = ?, note = ?, processed_at = datetime('now') WHERE id = ? AND status = 'requested' RETURNING *").get(st, req.body.note || null, req.params.id);
    if (!row) throw conflict('This payout is already processed.');
    audit(req, `settlement_${st}`, 'settlement', row.id, req.body.note);
    res.json({ ok: true });
  });

  /* ---------- analytics ---------- */
  r.get('/admin/analytics', admin, (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 366);
    const since = addDays(localDate(), -days + 1);
    const paid = "b.status IN ('confirmed','completed')";
    const totals = db.prepare(`SELECT COALESCE(SUM(b.total),0) gmv, COALESCE(SUM(b.commission + b.booking_fee - b.points_discount),0) revenue, COUNT(*) bookings,
        (SELECT COUNT(*) FROM booking_seats bs JOIN bookings b2 ON b2.id = bs.booking_id JOIN trips t2 ON t2.id = b2.trip_id WHERE bs.active = 1 AND b2.status IN ('confirmed','completed') AND t2.service_date >= ?) seats
      FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE ${paid} AND t.service_date >= ?`).get(since, since);
    const daily = db.prepare(`SELECT t.service_date day, SUM(b.total) gmv, COUNT(*) bookings FROM bookings b JOIN trips t ON t.id = b.trip_id
      WHERE ${paid} AND t.service_date >= ? AND t.service_date <= ? GROUP BY day ORDER BY day`).all(since, localDate());
    const routes = db.prepare(`SELECT ft.city || ' → ' || tt.city route, COUNT(*) bookings, SUM(b.total) gmv FROM bookings b JOIN trips t ON t.id = b.trip_id
      JOIN route_stops fs ON fs.id = b.from_stop_id JOIN terminals ft ON ft.id = fs.terminal_id JOIN route_stops ts ON ts.id = b.to_stop_id JOIN terminals tt ON tt.id = ts.terminal_id
      WHERE ${paid} AND t.service_date >= ? GROUP BY route ORDER BY gmv DESC LIMIT 10`).all(since);
    const operators = db.prepare(`SELECT o.name, COUNT(b.id) bookings, COALESCE(SUM(b.total),0) gmv, COALESCE(SUM(b.commission + b.booking_fee - b.points_discount),0) revenue FROM operators o
      LEFT JOIN bookings b ON b.operator_id = o.id AND ${paid} AND b.trip_id IN (SELECT id FROM trips WHERE service_date >= ?) GROUP BY o.id ORDER BY gmv DESC`).all(since);
    const monthly = db.prepare(`SELECT substr(t.service_date,1,7) month, SUM(b.total) gmv, COUNT(*) bookings FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE ${paid} GROUP BY month ORDER BY month DESC LIMIT 12`).all().reverse();
    const users = db.prepare(`SELECT substr(created_at,1,10) day, COUNT(*) n FROM users WHERE role = 'passenger' AND created_at >= ? GROUP BY day ORDER BY day`).all(since);
    const channels = db.prepare(`SELECT COALESCE(source, channel) channel, COUNT(*) n FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE ${paid} AND t.service_date >= ? GROUP BY COALESCE(source, channel)`).all(since);
    const payMethods = db.prepare(`SELECT provider, COUNT(*) n, SUM(status='success') ok, SUM(status='failed') failed FROM payments WHERE created_at >= ? GROUP BY provider`).all(since);
    res.json({ days, totals, daily, routes, operators, monthly, user_growth: users, total_passengers: db.prepare("SELECT COUNT(*) n FROM users WHERE role='passenger'").get().n,
      channels, payment_methods: payMethods, open_disputes: db.prepare("SELECT COUNT(*) n FROM disputes WHERE status='open'").get().n,
      pending_operators: db.prepare("SELECT COUNT(*) n FROM operators WHERE status='pending'").get().n });
  });

  /* ---------- notifications & promos ---------- */
  r.post('/admin/broadcast', admin, (req, res) => {
    required(req.body, ['audience', 'message']);
    const msg = String(req.body.message).trim();
    if (msg.length > 320) throw bad('Keep broadcasts under 320 characters (two SMS).');
    let phones = [];
    if (req.body.audience === 'all_passengers') phones = db.prepare("SELECT phone FROM users WHERE role='passenger' AND active=1").all().map(r => r.phone);
    else if (req.body.audience === 'trip') {
      phones = db.prepare("SELECT DISTINCT contact_phone phone FROM bookings WHERE trip_id = ? AND status IN ('confirmed','reserved')").all(Number(req.body.trip_id)).map(r => r.phone);
    } else if (req.body.audience === 'route_city') {
      if (!req.body.city) throw bad('Pick the city affected.');
      phones = db.prepare(`SELECT DISTINCT b.contact_phone phone FROM bookings b JOIN trips t ON t.id = b.trip_id JOIN route_stops rs ON rs.route_id = t.route_id JOIN terminals te ON te.id = rs.terminal_id
        WHERE te.city = ? AND b.status = 'confirmed' AND t.depart_at > ?`).all(req.body.city, new Date().toISOString()).map(r => r.phone);
    } else if (req.body.audience === 'operators') phones = db.prepare("SELECT contact_phone phone FROM operators WHERE status='approved' AND contact_phone IS NOT NULL").all().map(r => r.phone);
    else throw bad('Choose who receives the message.');
    const channels = (req.body.channels?.length ? req.body.channels : ['sms']).filter(c => ['sms', 'whatsapp'].includes(c));
    tx(db, () => { for (const p of phones) for (const c of channels) queue(db, { channel: c, to: p, body: `MyTicket: ${msg}`, kind: 'broadcast' }); });
    audit(req, 'broadcast', 'notification', req.body.audience, `${phones.length} recipients: ${msg}`);
    res.json({ recipients: phones.length, messages: phones.length * channels.length });
  });
  r.get('/admin/notifications', admin, (_req, res) => {
    res.json(db.prepare('SELECT id, channel, recipient, kind, status, attempts, last_error, created_at, sent_at, substr(body,1,140) body FROM notifications ORDER BY id DESC LIMIT 100').all());
  });
  r.get('/admin/promos', admin, (_req, res) => res.json(db.prepare("SELECT p.*, o.name operator FROM pricing_rules p LEFT JOIN operators o ON o.id = p.operator_id WHERE kind = 'promo' ORDER BY p.id DESC").all()));
  r.post('/admin/promos', admin, (req, res) => {
    required(req.body, ['name', 'code', 'pct']);
    const code = String(req.body.code).trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(code)) throw bad('Promo codes are 4–16 letters or digits.');
    const pct = Number(req.body.pct);
    if (!(pct > 0 && pct <= 50)) throw bad('Platform promos are between 1% and 50%.');
    if ((req.body.start_date && !isDate(req.body.start_date)) || (req.body.end_date && !isDate(req.body.end_date))) throw bad('Dates must be YYYY-MM-DD.');
    try {
      res.status(201).json(db.prepare("INSERT INTO pricing_rules (operator_id, kind, name, pct, code, start_date, end_date, max_uses) VALUES (NULL,'promo',?,?,?,?,?,?) RETURNING *")
        .get(req.body.name.trim(), pct, code, req.body.start_date || null, req.body.end_date || null, req.body.max_uses ? Number(req.body.max_uses) : null));
    } catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict('That promo code already exists.'); throw e; }
  });
  r.put('/admin/promos/:id', admin, (req, res) => {
    db.prepare("UPDATE pricing_rules SET active = ? WHERE id = ? AND kind = 'promo'").run(req.body.active ? 1 : 0, req.params.id);
    res.json({ ok: true });
  });

  /* ---------- users ---------- */
  r.post('/admin/admins', admin, (req, res) => {
    required(req.body, ['name', 'phone', 'password']);
    if (String(req.body.password).length < 12) throw bad('Admin passwords need at least 12 characters.');
    const phone = normPhone(req.body.phone);
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw conflict('That phone number already has an account.');
    const u = db.prepare("INSERT INTO users (role, name, phone, email, password_hash) VALUES ('admin',?,?,?,?) RETURNING id, name, phone").get(req.body.name, phone, req.body.email || null, hashPassword(req.body.password));
    audit(req, 'create_admin', 'user', u.id);
    res.status(201).json(u);
  });
  r.get('/admin/audit', admin, (_req, res) => res.json(db.prepare('SELECT a.*, u.name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200').all()));

  return r;
}
