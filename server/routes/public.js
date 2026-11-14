import { Router } from 'express';
import { tx } from '../db.js';
import { hashPassword, verifyPassword, issueToken, requireRole } from '../auth.js';
import { bad, notFound, forbidden, conflict, normPhone, required, isDate, HttpError, localDate } from '../util.js';
import { searchTrips, tripRow, routeStops, tripPosition, ensureTrips } from '../services/trips.js';
import { seatMap, holdSeats, releaseHold } from '../services/seats.js';
import { priceLeg, findPromo, refundQuote, adultFare } from '../services/pricing.js';
import { createBookings, startPayment, checkPayment, cancelBooking, rescheduleBooking, groupBookings } from '../services/bookings.js';
import { ticketData, ticketPdf, qrSvg, validKey } from '../services/tickets.js';
import { providers } from '../services/payments/providers.js';
import { bus } from '../services/events.js';
import { pointsBalance, loyaltyTerms } from '../services/loyalty.js';
import { LANGS, t as tr } from '../i18n.js';
import { rateLimit, clearLimit, createOtp, verifyOtp } from '../security.js';
import { queue } from '../services/notify.js';
import { joinWaitlist, getOffer } from '../services/waitlist.js';
import { config } from '../config.js';

const list = v => v == null || v === '' ? [] : Array.isArray(v) ? v : String(v).split(',');

export default function publicRoutes(db) {
  const r = Router();

  /* ---------- auth ---------- */
  const COMMON = new Set(['password', 'password1', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123', 'zambia123', 'lusaka123', 'iloveyou', '11111111', '00000000', 'abcd1234', 'myticket']);
  const checkPassword = (pw, phone) => {
    pw = String(pw || '');
    if (pw.length < 8) throw bad('Use at least 8 characters for the password.');
    if (pw.length > 200) throw bad('That password is too long.');
    if (COMMON.has(pw.toLowerCase()) || /^(\d)\1+$/.test(pw)) throw bad('That password is too easy to guess. Use a longer phrase.');
    if (phone && pw.replace(/\D/g, '').length >= 9 && phone.endsWith(pw.replace(/\D/g, '').slice(-9))) throw bad('Do not use your phone number as the password.');
  };
  const devCode = code => (config.isProd ? {} : { dev_code: code }); // development only: SMS is not really sent
  const sendCode = (phone, purpose, lang) => {
    const code = createOtp(db, phone, purpose);
    queue(db, { channel: 'sms', to: phone, kind: `otp_${purpose}`, body: tr(lang || 'en', `otp.${purpose}`, { code }) });
    return code;
  };

  r.post('/auth/register', (req, res) => {
    required(req.body, ['name', 'phone', 'password']);
    const phone = normPhone(req.body.phone);
    checkPassword(req.body.password, phone);
    rateLimit(db, `register:${req.ip}`, 10, 3600);
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw conflict('An account with this phone number already exists. Sign in instead, or reset your password.');
    const u = db.prepare("INSERT INTO users (role, name, phone, email, password_hash, lang) VALUES ('passenger',?,?,?,?,?) RETURNING id, role, name, phone, email, phone_verified, lang")
      .get(req.body.name.trim(), phone, req.body.email?.trim() || null, hashPassword(req.body.password), LANGS[req.body.lang] ? req.body.lang : 'en');
    // Earlier guest bookings with this number are linked only after the phone is verified (stops anyone claiming someone else's trips).
    const code = sendCode(phone, 'verify', u.lang);
    res.status(201).json({ token: issueToken(u), user: u, verify_phone: true, ...devCode(code) });
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
      return db.prepare("INSERT INTO users (role, name, phone, email, password_hash, operator_id) VALUES ('operator',?,?,?,?,?) RETURNING id, role, name, phone, email, operator_id, phone_verified")
        .get(req.body.name.trim(), phone, req.body.email || null, hashPassword(req.body.password), o.id);
    });
    const code = sendCode(phone, 'verify');
    res.status(201).json({ token: issueToken(u), user: { ...u, operator_status: 'pending' }, verify_phone: true, ...devCode(code) });
  });

  r.post('/auth/login', (req, res) => {
    required(req.body, ['phone', 'password']);
    const phone = normPhone(req.body.phone);
    rateLimit(db, `login:ip:${req.ip}`, 30, 900, 'Too many sign-in attempts from this network.');
    rateLimit(db, `login:${phone}`, 8, 900, 'Too many sign-in attempts for this number. Wait, or reset your password.');
    const u = db.prepare('SELECT u.*, o.status operator_status, o.name operator_name FROM users u LEFT JOIN operators o ON o.id = u.operator_id WHERE phone = ?').get(phone);
    if (!u || !u.active || !verifyPassword(req.body.password, u.password_hash)) throw new HttpError(401, 'Phone number or password is wrong.');
    clearLimit(db, `login:${phone}`);
    const { password_hash, ...user } = u;
    res.json({ token: issueToken(u), user });
  });

  /** Ask for a code by SMS. purpose=reset works signed out; the answer never reveals whether the number has an account. */
  r.post('/auth/otp', (req, res) => {
    const purpose = req.body.purpose;
    if (purpose === 'verify') {
      if (!req.user) throw new HttpError(401, 'Sign in to continue.');
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

  r.post('/auth/verify-phone', requireRole('passenger', 'clerk', 'conductor', 'operator', 'admin'), (req, res) => {
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
    setPassword(u, req.body.password, 'reset');
    clearLimit(db, `login:${phone}`);
    res.json({ ok: true });
  });

  r.post('/auth/password/change', requireRole('passenger', 'clerk', 'conductor', 'operator', 'admin'), (req, res) => {
    required(req.body, ['current_password', 'password']);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    rateLimit(db, `pwchange:${u.id}`, 5, 900);
    if (!verifyPassword(req.body.current_password, u.password_hash)) throw new HttpError(400, 'Your current password is wrong.');
    checkPassword(req.body.password, u.phone);
    setPassword(u, req.body.password, 'change');
    res.json({ ok: true, token: issueToken(u) });
  });

  /** New password: every earlier sign-in stops working, and the owner gets an SMS. */
  function setPassword(u, pw, how) {
    db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ?, phone_verified = 1 WHERE id = ?").run(hashPassword(pw), new Date().toISOString(), u.id);
    queue(db, { channel: 'sms', to: u.phone, kind: 'password_changed', body: tr(u.lang, 'sms.password_changed', {}) });
    db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES (?,?,?,?)').run(u.id, `password_${how}`, 'user', String(u.id));
  }

  r.get('/me', requireRole('passenger', 'clerk', 'conductor', 'operator', 'admin'), (req, res) => res.json(req.user));
  r.put('/me', requireRole('passenger', 'clerk', 'conductor', 'operator', 'admin'), (req, res) => {
    if (req.body.lang !== undefined) {
      if (!LANGS[req.body.lang]) throw bad('Unknown language.');
      db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(req.body.lang, req.user.id);
    }
    res.json({ ok: true });
  });
  r.get('/languages', (_req, res) => res.json({ languages: LANGS, ussd_code: config.ussdCode }));

  /* ---------- loyalty points ---------- */
  r.get('/my/points', requireRole('passenger'), (req, res) => {
    const t = loyaltyTerms(db);
    res.json({ balance: pointsBalance(db, req.user.id), point_value: t.pointValue, points_per_kwacha: t.perKwacha, max_pct: t.maxPct,
      history: db.prepare('SELECT l.points, l.kind, l.note, l.created_at FROM loyalty_ledger l WHERE l.user_id = ? ORDER BY l.id DESC LIMIT 30').all(req.user.id) });
  });

  /* ---------- discovery ---------- */
  r.get('/cities', (_req, res) => {
    res.json(db.prepare('SELECT city, COUNT(*) terminals FROM terminals GROUP BY city ORDER BY city').all().map(c => c.city));
  });
  r.get('/filters', (_req, res) => {
    const ops = db.prepare("SELECT id, name FROM operators WHERE status = 'approved' ORDER BY name").all();
    const am = new Set(db.prepare("SELECT amenities FROM buses WHERE status='active'").all().flatMap(b => JSON.parse(b.amenities)));
    res.json({ operators: ops, classes: ['Luxury', 'Semi-Luxury', 'VIP Sleeper', 'Express', 'Standard'], amenities: [...am].sort(), windows: ['morning', 'afternoon', 'night'] });
  });

  r.get('/search', (req, res) => {
    const { from, to, date, return_date } = req.query;
    if (!from || !to) throw bad('Choose where you are travelling from and to.');
    if (from === to) throw bad('Origin and destination must be different.');
    if (!isDate(date)) throw bad('Choose a travel date.');
    if (date < localDate()) throw bad('The travel date is in the past.');
    if (return_date && (!isDate(return_date) || return_date < date)) throw bad('The return date must be on or after the travel date.');
    const filters = { operator_id: list(req.query.operator), class: list(req.query.class), window: list(req.query.window), amenities: list(req.query.amenities),
      min_price: req.query.min_price || null, max_price: req.query.max_price || null };
    const sort = req.query.sort || 'depart';
    const sorter = { depart: (a, b) => a.depart_at.localeCompare(b.depart_at), price: (a, b) => a.fare - b.fare, rating: (a, b) => (b.rating?.avg || 0) - (a.rating?.avg || 0), seats: (a, b) => b.seats_left - a.seats_left }[sort];
    // Show the fare passengers will actually pay (peak, demand and early-booking adjustments included).
    const live = list => list.map(r => {
      const trip = db.prepare('SELECT tr.*, ro.distance_km FROM trips tr JOIN routes ro ON ro.id = tr.route_id WHERE tr.id = ?').get(r.trip_id);
      const st = id => db.prepare('SELECT * FROM route_stops WHERE id = ?').get(id);
      const a = adultFare(db, trip, st(r.boarding_points[0].stop_id), st(r.dropping_points[0].stop_id));
      return { ...r, fare: a.fare, base_fare: a.base, demand_pct: a.demand, early_pct: a.early, peak_pct: a.peak };
    }).filter(r => (filters.min_price == null || r.fare >= Number(filters.min_price)) && (filters.max_price == null || r.fare <= Number(filters.max_price)));
    const outbound = live(searchTrips(db, { from, to, date, filters: { ...filters, min_price: null, max_price: null } })).sort(sorter);
    const ret = return_date ? live(searchTrips(db, { from: to, to: from, date: return_date, filters: { ...filters, min_price: null, max_price: null } })).sort(sorter) : null;
    res.json({ outbound, return: ret });
  });

  r.get('/trips/:id', (req, res) => {
    const t = tripRow(db, req.params.id);
    if (!t || t.operator_status !== 'approved') throw notFound('Trip not found.');
    res.json({ id: t.id, operator: t.operator_name, operator_id: t.operator_id, class: t.class, plate: t.plate, amenities: JSON.parse(t.amenities), status: t.status,
      depart_at: t.depart_at, service_date: t.service_date, route: t.route_name, stops: routeStops(db, t.route_id) });
  });

  r.get('/trips/:id/seats', (req, res) => res.json(seatMap(db, Number(req.params.id), req.get('x-hold-token'))));

  /** Server-sent events: pushes a "change" event whenever seats on this trip are held, booked or released. */
  r.get('/trips/:id/seats/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = () => res.write('event: change\ndata: {}\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    bus.on(`seats:${req.params.id}`, send);
    req.on('close', () => { clearInterval(ping); bus.off(`seats:${req.params.id}`, send); });
  });

  r.post('/trips/:id/holds', (req, res) => {
    res.json(holdSeats(db, { tripId: Number(req.params.id), seats: req.body.seats, token: req.body.hold_token, userId: req.user?.id }));
  });
  /* ---------- waitlist for full buses ---------- */
  r.post('/trips/:id/waitlist', (req, res) => {
    required(req.body, ['seats', 'name', 'phone', 'from_stop_id', 'to_stop_id']);
    res.status(201).json(joinWaitlist(db, { tripId: Number(req.params.id), fromStopId: Number(req.body.from_stop_id), toStopId: Number(req.body.to_stop_id),
      seats: req.body.seats, name: req.body.name, phone: req.body.phone, user: req.user, lang: req.body.lang }));
  });
  r.get('/waitlist/offer/:id', (req, res) => {
    const o = getOffer(db, Number(req.params.id), String(req.query.k || ''));
    const t = tripRow(db, o.trip_id);
    const stops = routeStops(db, t.route_id);
    const view = s => ({ stop_id: s.id, terminal: s.terminal, city: s.city, time: new Date(new Date(t.depart_at).getTime() + (s.offset_min + t.delay_min) * 60000).toISOString(), map_url: `https://www.google.com/maps?q=${s.lat},${s.lng}` });
    res.json({ ...o, trip: { trip_id: t.id, operator: t.operator_name, class: t.class, plate: t.plate, depart_at: t.depart_at,
      boarding_points: stops.filter(s => s.id === o.from_stop_id).map(view), dropping_points: stops.filter(s => s.id === o.to_stop_id).map(view) } });
  });
  r.delete('/holds/:token', (req, res) => { releaseHold(db, req.params.token); res.json({ ok: true }); });

  r.post('/quote', (req, res) => {
    const { trip_id, from_stop_id, to_stop_id, passengers, promo_code } = req.body;
    const trip = db.prepare('SELECT tr.*, r.distance_km FROM trips tr JOIN routes r ON r.id = tr.route_id WHERE tr.id = ?').get(trip_id);
    if (!trip) throw notFound('Trip not found.');
    const st = id => db.prepare('SELECT * FROM route_stops WHERE id = ? AND route_id = ?').get(id, trip.route_id);
    const from = st(from_stop_id), to = st(to_stop_id);
    if (!from || !to || to.seq <= from.seq) throw bad('Pick a boarding point before the dropping point.');
    res.json(priceLeg(db, { trip, fromStop: from, toStop: to, passengers: passengers?.length ? passengers : [{}], promo: findPromo(db, promo_code, trip.operator_id) }));
  });

  r.get('/trips/:id/track', (req, res) => {
    const t = db.prepare('SELECT id FROM trips WHERE id = ?').get(req.params.id);
    if (!t) throw notFound('Trip not found.');
    res.json(tripPosition(db, t.id));
  });

  /* ---------- booking & payment (guests allowed; signed-in passengers get it in My trips) ---------- */
  r.post('/bookings', (req, res) => {
    if (req.user && req.user.role !== 'passenger') throw forbidden('Staff sell tickets from the counter screen.');
    res.status(201).json(createBookings(db, { ...req.body, user: req.user, channel: 'web' }));
  });

  /** Anyone holding the group reference can view status and pay (the reference is unguessable). */
  r.get('/groups/:group', (req, res) => {
    const bs = groupBookings(db, req.params.group);
    if (!bs.length) throw notFound('Booking not found.');
    const pays = db.prepare('SELECT id, provider, amount, status, failure_reason, created_at FROM payments WHERE group_ref = ? ORDER BY id DESC').all(req.params.group);
    res.json({ group_ref: req.params.group, bookings: bs.map(b => ({ ref: b.ref, status: b.status, total: b.total, expires_at: b.expires_at, ticket: b.status === 'confirmed' ? ticketData(db, b.ref).url : null })), payments: pays });
  });
  r.post('/groups/:group/pay', async (req, res) => {
    res.json(await startPayment(db, { group_ref: req.params.group, method: req.body.method, msisdn: req.body.msisdn }));
  });
  r.get('/payments/:id', async (req, res) => {
    const p = await checkPayment(db, Number(req.params.id));
    res.json({ id: p.id, status: p.status, amount: p.amount, reason: p.failure_reason, group_ref: p.group_ref });
  });
  /** Provider callbacks. The body is not trusted: we re-query the provider for the real status. */
  r.post('/payments/callback/:provider', async (req, res) => {
    const refId = req.get('x-reference-id') || req.body?.referenceId || req.body?.transaction?.id;
    const p = refId && db.prepare("SELECT id FROM payments WHERE provider = ? AND provider_ref = ? AND status = 'initiated'").get(req.params.provider, refId);
    if (p) await checkPayment(db, p.id);
    res.json({ ok: true });
  });
  /** Sandbox hosted-card page posts the outcome here. Disabled when a real card gateway is configured. */
  r.post('/payments/sandbox-card', (req, res) => {
    if (!providers.card.sandbox) throw notFound();
    providers.card.complete(req.body.provider_ref, !!req.body.approve);
    res.json({ ok: true });
  });

  /* ---------- tickets ---------- */
  const ticketAccess = (req, ref) => {
    const t = ticketData(db, ref);
    if (!t) throw notFound('Ticket not found.');
    const owner = req.user && (req.user.id === t.user_id || req.user.role === 'admin' || req.user.operator_id === t.operator_id);
    if (!owner && !validKey(ref, req.query.k)) throw forbidden('This ticket link is not valid.');
    return t;
  };
  r.get('/tickets/:ref', async (req, res) => {
    const t = ticketAccess(req, req.params.ref);
    const { contact_phone, ...rest } = t;
    res.json({ ...rest, contact_phone: contact_phone.replace(/^(\d{5})\d{4}/, '$1****'), qr_svg: t.status === 'confirmed' || t.status === 'completed' ? await qrSvg(t.ref) : null });
  });
  r.get('/tickets/:ref/pdf', async (req, res) => {
    const t = ticketAccess(req, req.params.ref);
    if (!['confirmed', 'completed'].includes(t.status)) throw conflict('The ticket is available once payment is confirmed.');
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="ticket-${t.ref}.pdf"` });
    res.send(await ticketPdf(t));
  });

  /** Guests find their booking with the reference + the phone number used to book. */
  r.post('/lookup', (req, res) => {
    required(req.body, ['ref', 'phone']);
    rateLimit(db, `lookup:${req.ip}`, 20, 900);
    const b = db.prepare('SELECT ref, group_ref, status, contact_phone FROM bookings WHERE ref = ?').get(String(req.body.ref).trim().toUpperCase());
    if (!b || b.contact_phone !== normPhone(req.body.phone)) throw notFound('No booking matches that reference and phone number.');
    res.json({ ref: b.ref, group_ref: b.group_ref, status: b.status, url: ticketData(db, b.ref).url });
  });

  /* ---------- passenger: my trips ---------- */
  const passenger = requireRole('passenger');
  const ownBooking = (req) => {
    const b = db.prepare('SELECT * FROM bookings WHERE ref = ?').get(req.params.ref);
    if (!b || b.user_id !== req.user.id) throw notFound('Booking not found.');
    return b;
  };
  r.get('/my/bookings', passenger, (req, res) => {
    const rows = db.prepare(`SELECT b.ref FROM bookings b WHERE b.user_id = ? AND b.status NOT IN ('expired') ORDER BY b.created_at DESC LIMIT 100`).all(req.user.id);
    const now = new Date().toISOString();
    const items = rows.map(r => {
      const t = ticketData(db, r.ref);
      const review = db.prepare('SELECT cleanliness, punctuality, driver, comment FROM reviews WHERE booking_id = ?').get(t.id);
      return { ...t, upcoming: t.arrive_at > now && !['cancelled', 'completed'].includes(t.status), review };
    });
    res.json(items);
  });
  r.get('/my/bookings/:ref/refund-quote', passenger, (req, res) => {
    const b = ownBooking(req);
    res.json(refundQuote(db, b, db.prepare('SELECT * FROM trips WHERE id = ?').get(b.trip_id)));
  });
  r.post('/my/bookings/:ref/cancel', passenger, (req, res) => res.json(cancelBooking(db, ownBooking(req), { by: req.user, reason: 'Cancelled by passenger' })));
  r.get('/my/bookings/:ref/alternatives', passenger, (req, res) => {
    const b = ownBooking(req);
    const old = db.prepare('SELECT * FROM trips WHERE id = ?').get(b.trip_id);
    const date = isDate(req.query.date) ? req.query.date : old.service_date;
    ensureTrips(db, date);
    const trips = db.prepare(`SELECT tr.id, tr.depart_at, tr.base_fare, bu.class, bu.plate FROM trips tr JOIN buses bu ON bu.id = tr.bus_id
      WHERE tr.route_id = ? AND tr.operator_id = ? AND tr.service_date = ? AND tr.id != ? AND tr.status IN ('scheduled','boarding','delayed') AND tr.depart_at > ?`)
      .all(old.route_id, b.operator_id, date, old.id, new Date().toISOString());
    res.json(trips);
  });
  r.post('/my/bookings/:ref/reschedule', passenger, (req, res) => res.json(rescheduleBooking(db, ownBooking(req), { ...req.body, user: req.user })));
  r.post('/my/bookings/:ref/review', passenger, (req, res) => {
    const b = ownBooking(req);
    if (b.status !== 'completed') throw conflict('You can rate a trip after it is completed.');
    const score = k => { const n = Number(req.body[k]); if (!(n >= 1 && n <= 5)) throw bad('Rate each item from 1 to 5 stars.'); return n; };
    try {
      db.prepare('INSERT INTO reviews (booking_id, operator_id, trip_id, cleanliness, punctuality, driver, comment) VALUES (?,?,?,?,?,?,?)')
        .run(b.id, b.operator_id, b.trip_id, score('cleanliness'), score('punctuality'), score('driver'), String(req.body.comment || '').slice(0, 1000) || null);
    } catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict('You already rated this trip.'); throw e; }
    res.status(201).json({ ok: true });
  });
  r.post('/my/disputes', passenger, (req, res) => {
    required(req.body, ['category', 'description']);
    let bookingId = null;
    if (req.body.ref) { req.params.ref = req.body.ref; bookingId = ownBooking(req).id; }
    const d = db.prepare('INSERT INTO disputes (booking_id, user_id, category, description) VALUES (?,?,?,?) RETURNING id').get(bookingId, req.user.id, req.body.category, String(req.body.description).slice(0, 2000));
    res.status(201).json(d);
  });
  r.get('/my/disputes', passenger, (req, res) => {
    res.json(db.prepare('SELECT d.*, b.ref FROM disputes d LEFT JOIN bookings b ON b.id = d.booking_id WHERE d.user_id = ? ORDER BY d.id DESC').all(req.user.id));
  });

  return r;
}
