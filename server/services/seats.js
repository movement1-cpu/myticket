import crypto from 'node:crypto';
import { tx, setting } from '../db.js';
import { bad, conflict, notFound, addMinutes } from '../util.js';
import { seatChanged } from './events.js';

export const MAX_SEATS = 6;

export function layoutForTrip(db, tripId) {
  const l = db.prepare('SELECT l.* FROM trips t JOIN buses b ON b.id = t.bus_id JOIN layouts l ON l.id = b.layout_id WHERE t.id = ?').get(tripId);
  if (!l) throw notFound('Trip not found.');
  const spec = JSON.parse(l.spec);
  const seats = new Map();
  for (const d of spec.decks) for (const row of d.rows) for (const s of row) if (s) seats.set(s.no, s);
  return { ...l, spec, seats };
}

/** Seat map with live status: available | booked | locked (someone else checking out) | mine. */
export function seatMap(db, tripId, holdToken) {
  const layout = layoutForTrip(db, tripId);
  const now = new Date().toISOString();
  const booked = new Set(db.prepare('SELECT seat_no FROM booking_seats WHERE trip_id = ? AND active = 1').all(tripId).map(r => r.seat_no));
  const holds = db.prepare('SELECT seat_no, hold_token, expires_at FROM seat_holds WHERE trip_id = ? AND expires_at > ?').all(tripId, now);
  const held = new Map(holds.map(h => [h.seat_no, h]));
  const status = no => booked.has(no) ? 'booked' : held.has(no) ? (holdToken && held.get(no).hold_token === holdToken ? 'mine' : 'locked') : 'available';
  return {
    layout: layout.code, name: layout.name, capacity: layout.capacity,
    decks: layout.spec.decks.map(d => ({ name: d.name, cols: d.cols, rows: d.rows.map(r => r.map(s => s && { no: s.no, female: !!s.female, kind: s.kind || 'seat', status: status(s.no) })) })),
    my_hold_expires: holdToken ? holds.find(h => h.hold_token === holdToken)?.expires_at ?? null : null,
  };
}

/**
 * Lock seats for checkout. Replaces this token's previous selection on the trip.
 * Runs in BEGIN IMMEDIATE so concurrent requests are serialised; the seat_holds primary key
 * and the partial unique index on booking_seats are the final guard.
 */
export function holdSeats(db, { tripId, seats, token, userId }) {
  if (!Array.isArray(seats) || seats.length === 0) throw bad('Pick at least one seat.');
  if (seats.length > MAX_SEATS) throw bad(`You can book up to ${MAX_SEATS} seats at a time.`);
  if (new Set(seats).size !== seats.length) throw bad('The same seat was picked twice.');
  const layout = layoutForTrip(db, tripId);
  for (const s of seats) if (!layout.seats.has(String(s))) throw bad(`Seat ${s} does not exist on this bus.`);
  const trip = db.prepare('SELECT status, depart_at FROM trips WHERE id = ?').get(tripId);
  if (['departed', 'arrived', 'cancelled'].includes(trip.status)) throw conflict('This trip is no longer taking bookings.');

  token = token || crypto.randomUUID();
  const minutes = Number(setting(db, 'hold_minutes'));
  const expires = addMinutes(new Date(), minutes).toISOString();
  const now = new Date().toISOString();

  const result = tx(db, () => {
    db.prepare('DELETE FROM seat_holds WHERE trip_id = ? AND (expires_at <= ? OR hold_token = ?)').run(tripId, now, token);
    const isBooked = db.prepare('SELECT 1 FROM booking_seats WHERE trip_id = ? AND seat_no = ? AND active = 1');
    const ins = db.prepare('INSERT INTO seat_holds (trip_id, seat_no, hold_token, user_id, expires_at) VALUES (?,?,?,?,?)');
    for (const s of seats.map(String)) {
      if (isBooked.get(tripId, s)) throw conflict(`Seat ${s} was just booked by someone else. Pick another seat.`, 'seat_taken');
      try { ins.run(tripId, s, token, userId ?? null, expires); }
      catch (e) {
        if (String(e.message).includes('UNIQUE') || String(e.message).includes('PRIMARY')) throw conflict(`Seat ${s} is being booked by someone else right now. Pick another seat.`, 'seat_locked');
        throw e;
      }
    }
    return { hold_token: token, seats: seats.map(String), expires_at: expires, hold_minutes: minutes };
  });
  seatChanged(tripId);
  return result;
}

export function releaseHold(db, token) {
  const trips = db.prepare('SELECT DISTINCT trip_id FROM seat_holds WHERE hold_token = ?').all(token);
  db.prepare('DELETE FROM seat_holds WHERE hold_token = ?').run(token);
  trips.forEach(t => seatChanged(t.trip_id));
}
