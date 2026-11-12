import { tx, setting } from '../db.js';
import { bad, conflict, notFound, normPhone, addMinutes, localTime, sign, safeEqual } from '../util.js';
import { config } from '../config.js';
import { seatMap } from './seats.js';
import { seatChanged } from './events.js';
import { notifyContact } from './notify.js';
import { t, langFor } from '../i18n.js';

/**
 * Waitlist for full buses.
 * - Anyone can join a trip's waitlist for 1–6 seats.
 * - When enough seats are free (cancellation, expired unpaid booking, released hold), the first person in line
 *   gets those seats HELD for `waitlist_offer_minutes` and an SMS link to pay. Nobody else can take them meanwhile.
 * - If they do not pay in time the offer expires and the next person is offered.
 */
export const offerKey = id => sign('wl.' + id).slice(0, 16);
export const offerUrl = id => `${config.baseUrl}/#/offer/${id}-${offerKey(id)}`;

export function joinWaitlist(db, { tripId, fromStopId, toStopId, seats, name, phone, user, lang }) {
  const trip = db.prepare("SELECT * FROM trips WHERE id = ? AND status IN ('scheduled','boarding','delayed')").get(tripId);
  if (!trip) throw notFound('This trip is not taking bookings.');
  seats = Number(seats);
  if (!Number.isInteger(seats) || seats < 1 || seats > 6) throw bad('Join the waitlist for 1 to 6 seats.');
  if (!String(name || '').trim()) throw bad('Enter your name.');
  const p = normPhone(phone);
  const st = id => db.prepare('SELECT * FROM route_stops WHERE id = ? AND route_id = ?').get(id, trip.route_id);
  const from = st(fromStopId), to = st(toStopId);
  if (!from || !to || to.seq <= from.seq) throw bad('Pick where you get on and off.');
  if (db.prepare("SELECT 1 FROM waitlist WHERE trip_id = ? AND phone = ? AND status IN ('waiting','offered')").get(trip.id, p)) throw conflict('This number is already on the waitlist for this bus.');
  const free = seatMap(db, trip.id).decks.flatMap(d => d.rows.flat()).filter(s => s && s.status === 'available').length;
  const queued = db.prepare("SELECT COUNT(*) n FROM waitlist WHERE trip_id = ? AND status = 'waiting'").get(trip.id).n;
  if (free >= seats && !queued) throw conflict(`${free} seat${free === 1 ? ' is' : 's are'} free on this bus. Book them now instead of waiting.`, 'seats_available');
  const language = langFor(db, { lang, user, phone: p });
  const row = db.prepare('INSERT INTO waitlist (trip_id, from_stop_id, to_stop_id, seats, contact_name, phone, lang, user_id) VALUES (?,?,?,?,?,?,?,?) RETURNING *')
    .get(trip.id, from.id, to.id, seats, String(name).trim(), p, language, user?.role === 'passenger' ? user.id : null);
  const position = db.prepare("SELECT COUNT(*) n FROM waitlist WHERE trip_id = ? AND status = 'waiting' AND id <= ?").get(trip.id, row.id).n;
  notifyContact(db, { phone: p, kind: 'waitlist', body: t(language, 'sms.waitlist_joined', { n: position, seats }) });
  processWaitlist(db, trip.id); // seats may already be free
  return { id: row.id, position, status: db.prepare('SELECT status FROM waitlist WHERE id = ?').get(row.id).status };
}

/** Expire stale offers and offer free seats to the next people in line. Returns the number of offers made. */
export function processWaitlist(db, tripId = null) {
  const now = new Date().toISOString();
  db.prepare("UPDATE waitlist SET status = 'expired' WHERE status = 'offered' AND offer_expires <= ?").run(now);
  db.prepare("UPDATE waitlist SET status = 'expired' WHERE status IN ('waiting','offered') AND trip_id IN (SELECT id FROM trips WHERE status IN ('departed','arrived','cancelled') OR depart_at <= ?)").run(now);
  const trips = tripId ? [{ trip_id: tripId }] : db.prepare("SELECT DISTINCT trip_id FROM waitlist WHERE status = 'waiting'").all();
  const minutes = Number(setting(db, 'waitlist_offer_minutes'));
  let offers = 0;
  for (const { trip_id } of trips) {
    for (;;) {
      const next = db.prepare("SELECT * FROM waitlist WHERE trip_id = ? AND status = 'waiting' ORDER BY id LIMIT 1").get(trip_id);
      if (!next) break;
      const made = tx(db, () => {
        db.prepare('DELETE FROM seat_holds WHERE trip_id = ? AND expires_at <= ?').run(trip_id, now);
        const free = seatMap(db, trip_id).decks.flatMap(d => d.rows.flat()).filter(s => s && s.status === 'available').map(s => s.no);
        if (free.length < next.seats) return false;
        // Prefer seats that are not women-only; use them only if needed.
        const layout = seatMap(db, trip_id).decks.flatMap(d => d.rows.flat()).filter(Boolean);
        const female = new Set(layout.filter(s => s.female).map(s => s.no));
        const pick = [...free.filter(s => !female.has(s)), ...free.filter(s => female.has(s))].slice(0, next.seats);
        const token = `wl-${next.id}-${crypto.randomUUID()}`;
        const expires = addMinutes(new Date(), minutes).toISOString();
        const ins = db.prepare('INSERT INTO seat_holds (trip_id, seat_no, hold_token, user_id, expires_at) VALUES (?,?,?,?,?)');
        for (const s of pick) ins.run(trip_id, s, token, next.user_id, expires);
        db.prepare("UPDATE waitlist SET status = 'offered', hold_token = ?, offer_expires = ? WHERE id = ?").run(token, expires, next.id);
        return { pick, expires };
      });
      if (!made) break;
      seatChanged(trip_id);
      notifyContact(db, { phone: next.phone, kind: 'waitlist_offer',
        body: t(next.lang, 'sms.waitlist_offer', { seats: made.pick.join(', '), time: localTime(made.expires), url: offerUrl(next.id) }) });
      offers++;
    }
  }
  return offers;
}

/** What the offer link shows: the trip, the held seats and the hold token to check out with. */
export function getOffer(db, id, key) {
  if (!safeEqual(key, offerKey(id))) throw notFound('This link is not valid.');
  const w = db.prepare('SELECT * FROM waitlist WHERE id = ?').get(id);
  if (!w) throw notFound('This link is not valid.');
  if (w.status === 'booked') throw conflict('You already booked these seats.');
  if (w.status !== 'offered' || w.offer_expires <= new Date().toISOString()) throw conflict('This offer has expired. The seats went to the next person on the waitlist.');
  const seats = db.prepare('SELECT seat_no FROM seat_holds WHERE hold_token = ? ORDER BY seat_no').all(w.hold_token).map(s => s.seat_no);
  return { id: w.id, trip_id: w.trip_id, from_stop_id: w.from_stop_id, to_stop_id: w.to_stop_id, seats, hold_token: w.hold_token, expires_at: w.offer_expires, contact_name: w.contact_name, phone: w.phone };
}

/** Called after a booking is created from a waitlist hold. */
export function markWaitlistBooked(db, holdToken) {
  if (holdToken?.startsWith('wl-')) db.prepare("UPDATE waitlist SET status = 'booked' WHERE hold_token = ?").run(holdToken);
}
