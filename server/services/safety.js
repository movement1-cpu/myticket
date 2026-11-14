// Passenger safety: time-limited live-location links for family, and SOS from the bus.
import { bad, notFound, conflict, addMinutes, localTime } from '../util.js';
import { randomToken, sha256 } from '../security.js';
import { tripPosition } from './trips.js';
import { queue } from './notify.js';
import { config } from '../config.js';

/** A link anyone can open to see where this bus is. Shows no passenger details. Ends 2 hours after arrival. */
export function createShare(db, booking) {
  if (!['confirmed', 'completed'].includes(booking.status)) throw conflict('You can share a trip once it is paid.');
  const t = db.prepare(`SELECT tr.depart_at, tr.delay_min, ts.offset_min FROM trips tr JOIN route_stops ts ON ts.id = ? WHERE tr.id = ?`).get(booking.to_stop_id, booking.trip_id);
  const arrive = addMinutes(t.depart_at, t.offset_min + t.delay_min);
  if (arrive < new Date(Date.now() - 2 * 3600e3)) throw conflict('This trip is over.');
  const token = randomToken(24);
  const expires = addMinutes(arrive, 120).toISOString();
  db.prepare('INSERT INTO trip_shares (booking_id, token_hash, expires_at) VALUES (?,?,?)').run(booking.id, sha256(token), expires);
  return { url: `${config.baseUrl}/track.html?s=${token}`, expires_at: expires };
}
export function stopSharing(db, booking) {
  return db.prepare("UPDATE trip_shares SET revoked_at = datetime('now') WHERE booking_id = ? AND revoked_at IS NULL").run(booking.id).changes;
}
export function sharedView(db, token) {
  const s = db.prepare('SELECT * FROM trip_shares WHERE token_hash = ?').get(sha256(String(token || '')));
  if (!s || s.revoked_at) throw notFound('This link was stopped or is not valid.');
  if (s.expires_at < new Date().toISOString()) throw notFound('This trip has ended, so the link no longer works.');
  const b = db.prepare('SELECT trip_id, from_stop_id, to_stop_id, operator_id FROM bookings WHERE id = ?').get(s.booking_id);
  const pos = tripPosition(db, b.trip_id);
  const stop = id => db.prepare('SELECT te.city, te.name FROM route_stops rs JOIN terminals te ON te.id = rs.terminal_id WHERE rs.id = ?').get(id);
  const o = db.prepare('SELECT name, emergency_phone FROM operators WHERE id = ?').get(b.operator_id);
  return { ...pos, from: stop(b.from_stop_id), to: stop(b.to_stop_id), operator_phone: o.emergency_phone, expires_at: s.expires_at };
}

/** SOS from the conductor's phone: alert the company and the platform at once, with the bus's location. */
export function raiseSos(db, { trip, user, kind, note, lat, lng }) {
  if (!['accident', 'breakdown', 'medical', 'security', 'other'].includes(kind)) throw bad('Choose what happened.');
  const la = lat == null || lat === '' ? null : Number(lat), ln = lng == null || lng === '' ? null : Number(lng);
  const pos = la != null && ln != null && Math.abs(la) <= 90 && Math.abs(ln) <= 180 ? { lat: la, lng: ln } : (trip.last_lat ? { lat: trip.last_lat, lng: trip.last_lng } : null);
  const inc = db.prepare('INSERT INTO incidents (trip_id, operator_id, reported_by, kind, note, lat, lng) VALUES (?,?,?,?,?,?,?) RETURNING *')
    .get(trip.id, trip.operator_id, user.id, kind, String(note || '').slice(0, 300) || null, pos?.lat ?? null, pos?.lng ?? null);
  const info = db.prepare(`SELECT b.plate, r.name route, o.name operator, o.emergency_phone FROM trips t JOIN buses b ON b.id = t.bus_id JOIN routes r ON r.id = t.route_id JOIN operators o ON o.id = t.operator_id WHERE t.id = ?`).get(trip.id);
  const where = pos ? `Location: https://www.google.com/maps?q=${pos.lat},${pos.lng}` : 'Location unknown (no GPS).';
  const body = `MyTicket SOS (${kind.toUpperCase()}): bus ${info.plate}, ${info.route}, reported by ${user.name} at ${localTime(new Date())}. ${note ? `"${String(note).slice(0, 120)}" ` : ''}${where} Call the crew now.`;
  const phones = new Set([info.emergency_phone,
    ...db.prepare("SELECT phone FROM users WHERE operator_id = ? AND role = 'operator' AND active = 1").all(trip.operator_id).map(u => u.phone),
    ...db.prepare("SELECT phone FROM users WHERE role = 'admin' AND admin_scope IN ('full','support') AND active = 1").all().map(u => u.phone)].filter(Boolean));
  for (const p of phones) { queue(db, { channel: 'sms', to: p, kind: 'sos', body }); queue(db, { channel: 'whatsapp', to: p, kind: 'sos', body }); }
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)').run(user.id, 'sos', 'trip', String(trip.id), `${kind} ${pos ? `${pos.lat},${pos.lng}` : 'no location'} ${note || ''}`.trim());
  return { ...inc, alerted: phones.size };
}
