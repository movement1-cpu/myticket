import { Router } from 'express';
import { tx } from '../db.js';
import { requireRole, requireApprovedOperator } from '../auth.js';
import { rateLimit } from '../security.js';
import { bad, notFound, conflict, localDate, localTime, required } from '../util.js';
import { ensureTrips, routeStops } from '../services/trips.js';
import { parseQr, qrPayload } from '../services/tickets.js';
import { cancelBooking } from '../services/bookings.js';
import { notifyContact } from '../services/notify.js';
import { layoutForTrip } from '../services/seats.js';
import { luggageOf } from '../services/luggage.js';
import { t as tr } from '../i18n.js';
import { raiseSos } from '../services/safety.js';
import { scanParcel, parcelsFollowTrip } from '../services/parcels.js';

/**
 * Conductor / station agent field app.
 * Offline model: the app downloads the trip manifest (with each booking's expected QR payload),
 * validates scans locally, and queues check-ins with a device-generated client_id.
 * POST /agent/sync is idempotent on client_id, and the first valid check-in for a seat wins.
 */
export default function agentRoutes(db) {
  const r = Router();
  const field = [requireRole('conductor', 'clerk', 'operator'), requireApprovedOperator];
  const myTrip = (req) => {
    const t = db.prepare('SELECT * FROM trips WHERE id = ? AND operator_id = ?').get(req.params.id, req.operatorId);
    if (!t) throw notFound('Trip not found for your company.');
    return t;
  };

  r.get('/agent/trips', ...field, (req, res) => {
    const date = req.query.date || localDate();
    ensureTrips(db, date);
    const staff = db.prepare('SELECT id FROM staff WHERE user_id = ?').get(req.user.id);
    const rows = db.prepare(`SELECT t.id, t.status, t.depart_at, t.delay_min, t.conductor_id, r.name route_name, b.plate, b.class, l.capacity,
        (SELECT COUNT(*) FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id WHERE bs.trip_id = t.id AND bs.active = 1 AND bk.status IN ('confirmed','completed')) booked,
        (SELECT COUNT(*) FROM booking_seats bs WHERE bs.trip_id = t.id AND bs.active = 1 AND bs.boarded_at IS NOT NULL) boarded
      FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id JOIN layouts l ON l.id = b.layout_id
      WHERE t.operator_id = ? AND t.service_date = ? ORDER BY t.depart_at`).all(req.operatorId, date);
    res.json(rows.map(t => ({ ...t, depart_local: localTime(t.depart_at), mine: !!staff && t.conductor_id === staff.id })));
  });

  /** Everything the device needs to board this trip offline. */
  r.get('/agent/trips/:id/manifest', ...field, (req, res) => {
    const t = myTrip(req);
    const seats = db.prepare(`SELECT bs.id, bs.seat_no, bs.passenger_name, bs.id_type, COALESCE(bs.id_hint, '') AS id_number, bs.is_child, bs.boarded_at, b.ref, b.status, b.contact_phone, b.channel,
        bs.lug_bags, bs.lug_sacks, bs.lug_containers, bs.lug_boxes, bs.lug_crates, bs.lug_other, bs.lug_note,
        ft.name from_stop, tt.name to_stop, tt.city to_city
      FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
      JOIN route_stops fs ON fs.id = b.from_stop_id JOIN terminals ft ON ft.id = fs.terminal_id
      JOIN route_stops ts ON ts.id = b.to_stop_id JOIN terminals tt ON tt.id = ts.terminal_id
      WHERE bs.trip_id = ? AND bs.active = 1 AND b.status IN ('confirmed','completed','reserved') ORDER BY bs.seat_no`).all(t.id)
      .map(s => ({ ...s, luggage: luggageOf(s) }));
    // Seats someone is paying for right now (online checkout or another counter), so the bus view shows them as taken.
    const held = db.prepare('SELECT seat_no FROM seat_holds WHERE trip_id = ? AND expires_at > ?').all(t.id, new Date().toISOString()).map(h => h.seat_no);
    const layout = layoutForTrip(db, t.id);
    const refs = [...new Set(seats.map(s => s.ref))];
    res.json({
      trip: { id: t.id, status: t.status, depart_local: localTime(t.depart_at), emergency_phone: db.prepare('SELECT emergency_phone FROM operators WHERE id = ?').get(t.operator_id)?.emergency_phone, service_date: t.service_date, stops: routeStops(db, t.route_id).map(s => ({ city: s.city, terminal: s.terminal })) },
      codes: Object.fromEntries(refs.map(ref => [ref, qrPayload(ref)])),
      parcels: db.prepare("SELECT ref, from_city, to_city, pieces, description, status FROM parcels WHERE trip_id = ? AND status NOT IN ('cancelled') ORDER BY to_city, ref").all(t.id),
      seats, held, layout: { name: layout.name, decks: layout.spec.decks }, downloaded_at: new Date().toISOString(),
    });
  });

  /** Online scan (also used by sync). Accepts the raw QR text or a booking reference typed by hand. */
  const checkin = (req, { code, client_id, scanned_at }, tripId) => {
    if (client_id) {
      const prev = db.prepare('SELECT result, booking_seat_id FROM checkins WHERE client_id = ?').get(client_id);
      if (prev) return { client_id, result: prev.result, duplicate_sync: true };
    }
    const text = String(code || '').trim();
    const ref = text.startsWith('MT1|') ? parseQr(text) : text.toUpperCase();
    const record = (result, seatId = null) => {
      db.prepare('INSERT OR IGNORE INTO checkins (client_id, booking_seat_id, trip_id, agent_id, scanned_at, result) VALUES (?,?,?,?,?,?)')
        .run(client_id || crypto.randomUUID(), seatId, tripId, req.user.id, scanned_at || new Date().toISOString(), result);
    };
    if (!ref) { record('invalid'); return { client_id, result: 'invalid', message: 'This QR code is not a MyTicket ticket.' }; }
    const b = db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
    if (!b) { record('invalid'); return { client_id, result: 'invalid', message: `No booking ${ref}.` }; }
    if (b.trip_id !== tripId) { record('invalid'); return { client_id, result: 'wrong_trip', message: `Booking ${ref} is for another bus or date.` }; }
    if (!['confirmed', 'completed'].includes(b.status)) { record('invalid'); return { client_id, result: 'unpaid', message: b.status === 'reserved' ? `Booking ${ref} is not paid. Collect cash at the counter first.` : `Booking ${ref} is ${b.status}.` }; }
    const seats = db.prepare('SELECT * FROM booking_seats WHERE booking_id = ? AND active = 1').all(b.id);
    const fresh = seats.filter(s => !s.boarded_at);
    if (!fresh.length) { record('duplicate', seats[0]?.id); return { client_id, result: 'duplicate', message: `Already boarded: ${ref} was scanned at ${localTime(seats[0].boarded_at)}.`, seats }; }
    const at = scanned_at || new Date().toISOString();
    tx(db, () => {
      for (const s of fresh) db.prepare('UPDATE booking_seats SET boarded_at = ?, boarded_by = ? WHERE id = ? AND boarded_at IS NULL').run(at, req.user.id, s.id);
      record('boarded', fresh[0].id);
    });
    return { client_id, result: 'boarded', ref, seats: fresh.map(s => ({ seat_no: s.seat_no, passenger_name: s.passenger_name, id_type: s.id_type, id_number: s.id_hint, luggage: luggageOf(s) })) };
  };

  r.post('/agent/trips/:id/scan', ...field, (req, res) => res.json(checkin(req, req.body, myTrip(req).id)));

  r.post('/agent/sync', ...field, (req, res) => {
    const items = Array.isArray(req.body.checkins) ? req.body.checkins.slice(0, 500) : [];
    const results = items.map(c => {
      const t = db.prepare('SELECT id FROM trips WHERE id = ? AND operator_id = ?').get(c.trip_id, req.operatorId);
      if (!t) return { client_id: c.client_id, result: 'invalid', message: 'Trip not found.' };
      return checkin(req, c, t.id);
    });
    res.json({ results, synced_at: new Date().toISOString() });
  });

  /** Boarding / departed / delayed / arrived / cancelled — passengers are told by SMS + WhatsApp. */
  r.post('/agent/trips/:id/status', ...field, (req, res) => {
    const t = myTrip(req);
    const { status } = req.body;
    const delay = Math.max(0, Math.min(1440, Number(req.body.delay_min) || 0));
    const allowed = { scheduled: ['boarding', 'delayed', 'cancelled'], boarding: ['departed', 'delayed', 'cancelled'], delayed: ['boarding', 'departed', 'delayed', 'cancelled'], departed: ['arrived', 'delayed'], arrived: [], cancelled: [] };
    if (!allowed[t.status]?.includes(status)) throw conflict(`A ${t.status} trip cannot be marked ${status}.`);
    if (status === 'cancelled' && req.user.role !== 'operator') throw conflict('Only the bus company owner can cancel a trip.');
    if (status === 'delayed' && !delay) throw bad('Enter the delay in minutes.');
    db.prepare('UPDATE trips SET status = ?, delay_min = CASE WHEN ? = \'delayed\' THEN ? ELSE delay_min END WHERE id = ?').run(status === 'delayed' && t.status === 'departed' ? 'departed' : status, status, delay, t.id);
    const info = db.prepare(`SELECT b.plate, ft.name terminal, r.name route FROM trips t JOIN buses b ON b.id = t.bus_id JOIN routes r ON r.id = t.route_id
      JOIN route_stops fs ON fs.route_id = t.route_id AND fs.seq = 1 JOIN terminals ft ON ft.id = fs.terminal_id WHERE t.id = ?`).get(t.id);
    const bookings = db.prepare("SELECT * FROM bookings WHERE trip_id = ? AND status IN ('confirmed','reserved','pending_payment')").all(t.id);
    const vars = { plate: info.plate, route: info.route, terminal: info.terminal, min: delay, date: t.service_date };
    const msg = lang => tr(lang, `trip.${status}`, vars);
    let refunded = 0;
    for (const b of bookings) {
      if (status === 'cancelled') { cancelBooking(db, b, { by: req.user, reason: 'Trip cancelled by operator', full: true }); refunded++; }
      else if (b.status === 'confirmed') notifyContact(db, { phone: b.contact_phone, kind: `trip_${status}`, body: msg(b.lang) });
    }
    parcelsFollowTrip(db, t.id, status);
    db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)').run(req.user.id, `trip_${status}`, 'trip', String(t.id), delay ? `${delay} min` : null);
    res.json({ ok: true, status, notified: bookings.length, refunded });
  });

  /** SOS: one tap alerts the company and the platform with the bus's location. Rate-limited only lightly on purpose. */
  r.post('/agent/trips/:id/sos', ...field, (req, res) => {
    const t = myTrip(req);
    rateLimit(db, `sos:${req.user.id}`, 10, 600, 'SOS already sent several times. The company and platform have been alerted.');
    res.status(201).json(raiseSos(db, { trip: t, user: req.user, ...req.body }));
  });

  /** Parcel label scanned on this bus: load before departure, unload on arrival. Needs a signal. */
  r.post('/agent/trips/:id/parcel-scan', ...field, (req, res) => res.json(scanParcel(db, req.user, myTrip(req).id, req.body.code)));

  /** GPS ping from the conductor's phone while the trip is running. */
  r.post('/agent/trips/:id/position', ...field, (req, res) => {
    const t = myTrip(req);
    required(req.body, ['lat', 'lng']);
    const lat = Number(req.body.lat), lng = Number(req.body.lng);
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) throw bad('Invalid coordinates.');
    db.prepare("UPDATE trips SET last_lat = ?, last_lng = ?, last_pos_at = ? WHERE id = ?").run(lat, lng, new Date().toISOString(), t.id);
    res.json({ ok: true });
  });

  return r;
}
