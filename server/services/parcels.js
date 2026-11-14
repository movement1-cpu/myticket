// Parcel tracking: plate-based tracking codes, QR labels, load/unload scans, secret collection codes,
// an append-only custody history, automatic status from the bus, and loss alerts.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { bad, conflict, notFound, forbidden, normPhone, sign, safeEqual, localDate, localTime, money } from '../util.js';
import { rateLimit } from '../security.js';
import { notifyContact, queue } from './notify.js';
import { tripPosition } from './trips.js';

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LEFT_BEHIND = 'left_behind', NOT_UNLOADED_MIN = 120, UNCOLLECTED_DAYS = 7;

export const trackUrl = code => `${config.baseUrl}/parcel.html?c=${encodeURIComponent(code)}`;
const qrKey = code => sign('parcel.' + code).slice(0, 12);
export const parcelQr = code => `MTP|${code}|${qrKey(code)}`;
const collectHash = (code, secret) => crypto.createHmac('sha256', config.secret).update(`parcel-collect|${code}|${String(secret).trim()}`).digest('hex');

/** Tracking code = the bus number plate + 4 random characters, e.g. BAZ4521-K7Q2. Unique. */
export function parcelCode(db, plate) {
  const base = String(plate || 'PC').toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (let i = 0; i < 50; i++) {
    const code = `${base}-${Array.from(crypto.randomBytes(4), b => ALPHA[b % ALPHA.length]).join('')}`;
    if (!db.prepare('SELECT 1 FROM parcels WHERE ref = ?').get(code)) return code;
  }
  throw new Error('Could not make a unique parcel code');
}

/** QR text (from the label) or a typed code → the code. */
export function parseParcelCode(text) {
  const t = String(text || '').trim();
  if (t.startsWith('MTP|')) {
    const [, code, k] = t.split('|');
    return code && k && safeEqual(k, qrKey(code)) ? code : null;
  }
  return t.toUpperCase() || null;
}

const tripInfo = (db, tripId) => db.prepare(`SELECT t.*, b.plate, r.name route_name FROM trips t JOIN buses b ON b.id = t.bus_id JOIN routes r ON r.id = t.route_id WHERE t.id = ?`).get(tripId);
const stopsOf = (db, routeId) => db.prepare('SELECT rs.seq, te.city FROM route_stops rs JOIN terminals te ON te.id = rs.terminal_id WHERE rs.route_id = ? ORDER BY rs.seq').all(routeId);
/** The bus must stop in the sending town and later in the receiving town. */
function routeServes(db, trip, from, to) {
  const s = stopsOf(db, trip.route_id);
  const a = s.find(x => x.city === from), z = [...s].reverse().find(x => x.city === to);
  return a && z && z.seq > a.seq;
}
export function logEvent(db, parcel, event, { trip = null, city = null, user = null, note = null } = {}) {
  db.prepare('INSERT INTO parcel_events (parcel_id, event, trip_id, plate, city, user_id, note) VALUES (?,?,?,?,?,?,?)')
    .run(parcel.id, event, trip?.id ?? null, trip?.plate ?? null, city, user?.id ?? null, note);
}
const ownersOf = (db, operatorId) => db.prepare("SELECT phone FROM users WHERE operator_id = ? AND role = 'operator' AND active = 1").all(operatorId).map(u => u.phone);

export function registerParcel(db, user, b) {
  if (!b.trip_id) throw bad('Choose the bus (departure) the parcel goes on. The tracking code includes its number plate.');
  const trip = tripInfo(db, b.trip_id);
  if (!trip || trip.operator_id !== user.operator_id) throw notFound('Departure not found.');
  if (['departed', 'arrived', 'cancelled'].includes(trip.status)) throw conflict('That bus has already left. Choose a later departure.');
  if (!routeServes(db, trip, b.from_city, b.to_city)) throw bad(`Bus ${trip.plate} does not go from ${b.from_city} to ${b.to_city}.`);
  const pieces = Math.max(1, Math.min(50, Number(b.pieces) || 1));
  const weight = Number(b.weight_kg), fee = Number(b.fee);
  if (!(weight > 0 && weight <= 2000)) throw bad('Enter the weight in kg.');
  if (!(fee >= 0)) throw bad('Enter the fee.');
  const code = parcelCode(db, trip.plate);
  const secret = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const p = db.prepare(`INSERT INTO parcels (ref, operator_id, trip_id, from_city, to_city, sender_name, sender_phone, receiver_name, receiver_phone, description, weight_kg, fee, created_by, pieces, collection_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`).get(code, user.operator_id, trip.id, b.from_city, b.to_city, String(b.sender_name).trim(), normPhone(b.sender_phone),
    String(b.receiver_name).trim(), normPhone(b.receiver_phone), String(b.description).trim().slice(0, 200), weight, money(fee), user.id, pieces, collectHash(code, secret));
  logEvent(db, p, 'registered', { trip, city: b.from_city, user, note: `${pieces} piece${pieces > 1 ? 's' : ''}, ${weight} kg` });
  const when = `${localDate(trip.depart_at)} ${localTime(trip.depart_at)}`;
  notifyContact(db, { phone: p.sender_phone, kind: 'parcel', body: `MyTicket: Parcel ${code} registered on bus ${trip.plate} to ${p.to_city}, departing ${when}. Track it: ${trackUrl(code)}` });
  notifyContact(db, { phone: p.receiver_phone, kind: 'parcel', body: `MyTicket: Parcel ${code} from ${p.sender_name} is coming to ${p.to_city} on bus ${trip.plate}. Track it: ${trackUrl(code)}. Your collection code is ${secret}. Give it only when you collect the parcel, with your ID.` });
  return { ...p, plate: trip.plate, depart_at: trip.depart_at, ...(config.isProd ? {} : { dev_collection_code: secret }) };
}

/**
 * Conductor or clerk scans a parcel label against a bus.
 *   Before the bus leaves: received → loaded (wrong bus refused).
 *   After it left / arrived: loaded, in_transit or missing → arrived (unloaded); the receiver is told.
 */
export function scanParcel(db, user, tripId, text) {
  const code = parseParcelCode(text);
  if (!code) return { result: 'invalid', message: 'This is not a MyTicket parcel label.' };
  const p = db.prepare('SELECT * FROM parcels WHERE ref = ? AND operator_id = ?').get(code, user.operator_id);
  if (!p) return { result: 'invalid', message: `No parcel ${code} for your company.` };
  const trip = tripInfo(db, tripId);
  const view = { ref: p.ref, to_city: p.to_city, pieces: p.pieces, description: p.description };
  if (['collected', 'cancelled'].includes(p.status)) return { result: 'invalid', message: `Parcel ${code} is ${p.status}.`, parcel: view };
  if (p.trip_id !== trip.id) {
    const other = p.trip_id ? tripInfo(db, p.trip_id) : null;
    logEvent(db, p, 'wrong_bus_scan', { trip, user, note: `scanned on ${trip.plate}` });
    return { result: 'wrong_bus', message: `STOP: parcel ${code} belongs on bus ${other?.plate || '?'}${other ? ` (${localTime(other.depart_at)})` : ''}, not this one.`, parcel: view };
  }
  const left = ['departed', 'arrived'].includes(trip.status) || (trip.status === 'delayed' && p.status === 'in_transit');
  if (!left) {
    if (p.status === 'loaded') return { result: 'duplicate', message: `Parcel ${code} is already loaded.`, parcel: view };
    db.prepare("UPDATE parcels SET status = 'loaded', updated_at = datetime('now') WHERE id = ?").run(p.id);
    logEvent(db, p, 'loaded', { trip, city: p.from_city, user });
    return { result: 'loaded', message: `Loaded: ${code} → ${p.to_city} (${p.pieces} piece${p.pieces > 1 ? 's' : ''}).`, parcel: view };
  }
  if (p.status === 'arrived') return { result: 'duplicate', message: `Parcel ${code} is already unloaded.`, parcel: view };
  db.prepare("UPDATE parcels SET status = 'arrived', updated_at = datetime('now') WHERE id = ?").run(p.id);
  logEvent(db, p, p.status === 'missing' ? 'found' : 'unloaded', { trip, city: p.to_city, user });
  const o = db.prepare('SELECT name FROM operators WHERE id = ?').get(p.operator_id);
  notifyContact(db, { phone: p.receiver_phone, kind: 'parcel', body: `MyTicket: Parcel ${code} has arrived in ${p.to_city}. Collect it at the ${o.name} office with your ID and your collection code.` });
  return { result: 'unloaded', message: `Unloaded: ${code} for ${p.to_city}. Receiver told by SMS.`, parcel: view };
}

/** Called when a trip changes status: parcels follow their bus, and parcels left behind raise an alert. */
export function parcelsFollowTrip(db, tripId, status) {
  const trip = tripInfo(db, tripId);
  const parcels = db.prepare("SELECT * FROM parcels WHERE trip_id = ? AND status IN ('received','loaded','in_transit')").all(tripId);
  for (const p of parcels) {
    if (status === 'departed' && p.status === 'loaded') {
      db.prepare("UPDATE parcels SET status = 'in_transit', updated_at = datetime('now') WHERE id = ?").run(p.id);
      logEvent(db, p, 'departed', { trip, city: p.from_city });
    } else if (status === 'departed' && p.status === 'received') {
      logEvent(db, p, 'alert', { trip, city: p.from_city, note: 'Bus left without this parcel (never scanned on). Put it on the next bus.' });
      db.prepare("UPDATE parcels SET last_alert = ? WHERE id = ?").run(LEFT_BEHIND, p.id);
      for (const ph of ownersOf(db, p.operator_id)) queue(db, { channel: 'sms', to: ph, kind: 'parcel_alert', body: `MyTicket: Parcel ${p.ref} was NOT loaded when bus ${trip.plate} left ${p.from_city}. Find it and put it on the next bus (Parcels → Move to another bus).` });
    } else if (status === 'arrived' && p.status === 'in_transit') {
      logEvent(db, p, 'bus_arrived', { trip, city: p.to_city, note: 'Waiting for the unload scan' });
    } else if (status === 'cancelled') {
      logEvent(db, p, 'alert', { trip, note: 'Bus cancelled. Move the parcel to another bus.' });
      for (const ph of ownersOf(db, p.operator_id)) queue(db, { channel: 'sms', to: ph, kind: 'parcel_alert', body: `MyTicket: Bus ${trip.plate} was cancelled with parcel ${p.ref} on it. Move it to another bus.` });
    }
  }
}

/** Collection: the secret code from the receiver's SMS, plus their name and ID. */
export function collectParcel(db, user, parcel, { code, name, id_number }) {
  if (parcel.status !== 'arrived') throw conflict(parcel.status === 'collected' ? 'This parcel was already collected.' : 'This parcel has not been unloaded here yet.');
  rateLimit(db, `collect:${parcel.id}`, 5, 3600, 'Too many wrong collection codes for this parcel. Ask the receiver to check their SMS.');
  if (!String(name || '').trim() || !String(id_number || '').trim()) throw bad('Enter the name and ID number of the person collecting.');
  if (!parcel.collection_hash || !safeEqual(parcel.collection_hash, collectHash(parcel.ref, code))) {
    logEvent(db, parcel, 'wrong_collection_code', { user, city: parcel.to_city });
    throw forbidden('Wrong collection code. Only the receiver has it (sent by SMS when the parcel was registered).');
  }
  const idMasked = String(id_number).trim().toUpperCase().replace(/^(.*)(.{4})$/, (_, a, b) => '*'.repeat(a.length) + b);
  db.prepare("UPDATE parcels SET status = 'collected', collected_by_name = ?, collected_id = ?, collected_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(String(name).trim(), idMasked, parcel.id);
  logEvent(db, parcel, 'collected', { user, city: parcel.to_city, note: `by ${String(name).trim()} (${idMasked})` });
  notifyContact(db, { phone: parcel.sender_phone, kind: 'parcel', body: `MyTicket: Parcel ${parcel.ref} was collected in ${parcel.to_city} by ${String(name).trim()}.` });
  return { ok: true };
}

/** Put a parcel on another bus (left behind, bus cancelled, found). The tracking code stays the same. */
export function reassignParcel(db, user, parcel, tripId) {
  if (!['received', 'missing', 'loaded'].includes(parcel.status)) throw conflict('Only parcels waiting at a station can move to another bus.');
  const trip = tripInfo(db, tripId);
  if (!trip || trip.operator_id !== parcel.operator_id) throw notFound('Departure not found.');
  if (['departed', 'arrived', 'cancelled'].includes(trip.status)) throw conflict('That bus has already left.');
  if (!routeServes(db, trip, parcel.from_city, parcel.to_city)) throw bad(`Bus ${trip.plate} does not go from ${parcel.from_city} to ${parcel.to_city}.`);
  db.prepare("UPDATE parcels SET trip_id = ?, status = 'received', last_alert = NULL, updated_at = datetime('now') WHERE id = ?").run(trip.id, parcel.id);
  logEvent(db, parcel, 'reassigned', { trip, user, city: parcel.from_city, note: `now on ${trip.plate} ${localDate(trip.depart_at)} ${localTime(trip.depart_at)}` });
  notifyContact(db, { phone: parcel.receiver_phone, kind: 'parcel', body: `MyTicket: Parcel ${parcel.ref} now travels on bus ${trip.plate}, departing ${localDate(trip.depart_at)} ${localTime(trip.depart_at)}. Track it: ${trackUrl(parcel.ref)}` });
  return { ok: true, plate: trip.plate };
}

/** Loss prevention, run by the sweep: not unloaded 2 h after the bus arrived → missing; uncollected reminders. */
export function parcelWatch(db) {
  const late = db.prepare(`SELECT p.*, b.plate FROM parcels p JOIN trips t ON t.id = p.trip_id JOIN buses b ON b.id = t.bus_id JOIN routes r ON r.id = t.route_id
    WHERE p.status = 'in_transit' AND (t.status = 'arrived' OR datetime(t.depart_at, '+' || (r.duration_min + t.delay_min + ?) || ' minutes') < datetime('now'))`).all(NOT_UNLOADED_MIN);
  for (const p of late) {
    db.prepare("UPDATE parcels SET status = 'missing', last_alert = 'missing', updated_at = datetime('now') WHERE id = ?").run(p.id);
    logEvent(db, p, 'alert', { trip: { id: p.trip_id, plate: p.plate }, city: p.to_city, note: 'Not unloaded 2 hours after the bus arrived' });
    for (const ph of ownersOf(db, p.operator_id)) queue(db, { channel: 'sms', to: ph, kind: 'parcel_alert', body: `MyTicket: Parcel ${p.ref} on bus ${p.plate} was not scanned off in ${p.to_city}. Check the bus and the ${p.to_city} office now.` });
  }
  const waiting = db.prepare(`SELECT * FROM parcels WHERE status = 'arrived' AND updated_at < datetime('now', ?) AND (last_alert IS NULL OR last_alert < datetime('now', '-3 days'))`).all(`-${UNCOLLECTED_DAYS} days`);
  for (const p of waiting) {
    db.prepare("UPDATE parcels SET last_alert = datetime('now') WHERE id = ?").run(p.id);
    notifyContact(db, { phone: p.receiver_phone, kind: 'parcel', body: `MyTicket: Reminder: parcel ${p.ref} is waiting for you in ${p.to_city}. Bring your ID and collection code.` });
  }
  return { missing: late.length, reminded: waiting.length };
}

/** Public tracking: status, history and the live bus. No names, phone numbers or ID numbers. */
export function trackParcel(db, code) {
  const p = db.prepare('SELECT p.*, o.name operator, o.emergency_phone FROM parcels p JOIN operators o ON o.id = p.operator_id WHERE p.ref = ?').get(String(code || '').trim().toUpperCase());
  if (!p) throw notFound('No parcel with that tracking code. Check the code on your receipt or SMS.');
  const trip = p.trip_id ? tripInfo(db, p.trip_id) : null;
  const events = db.prepare(`SELECT event, plate, city, note, created_at FROM parcel_events WHERE parcel_id = ? AND event NOT IN ('wrong_bus_scan','wrong_collection_code') ORDER BY id`).all(p.id)
    .map(e => ({ ...e, note: e.event === 'collected' ? 'Collected by the receiver' : e.note }));
  const moving = trip && ['loaded', 'in_transit', 'missing'].includes(p.status) && ['boarding', 'departed', 'delayed', 'arrived'].includes(trip.status);
  return {
    code: p.ref, status: p.status, from_city: p.from_city, to_city: p.to_city, pieces: p.pieces, weight_kg: p.weight_kg, description: p.description,
    operator: p.operator, operator_phone: p.emergency_phone, plate: trip?.plate ?? null, depart_at: trip?.depart_at ?? null, trip_status: trip?.status ?? null,
    events, live: moving ? tripPosition(db, trip.id) : null,
  };
}

export async function parcelLabel(db, p) {
  const trip = p.trip_id ? tripInfo(db, p.trip_id) : null;
  return { ...p, collection_hash: undefined, plate: trip?.plate, depart_at: trip?.depart_at, qr_svg: await QRCode.toString(parcelQr(p.ref), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
}
