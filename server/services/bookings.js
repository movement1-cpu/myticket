import { tx, setting } from '../db.js';
import { bad, conflict, notFound, forbidden, ref, money, addMinutes, normPhone, networkOf, localTime, localDate } from '../util.js';
import { config } from '../config.js';
import { layoutForTrip } from './seats.js';
import { priceLeg, findPromo, refundQuote, operatorTerms } from './pricing.js';
import { seatChanged } from './events.js';
import { notifyContact } from './notify.js';
import { ticketUrl } from './tickets.js';
import { providers } from './payments/providers.js';

const cur = n => `K${Number(n).toFixed(2)}`;
const PAY_METHODS = ['mtn', 'airtel', 'zamtel', 'card', 'station', 'cash'];

function tripForBooking(db, tripId) {
  const t = db.prepare(`SELECT tr.*, r.distance_km, r.name AS route_name FROM trips tr JOIN routes r ON r.id = tr.route_id
    JOIN operators o ON o.id = tr.operator_id WHERE tr.id = ? AND o.status = 'approved'`).get(tripId);
  if (!t) throw notFound('Trip not found.');
  return t;
}
function stop(db, routeId, stopId) {
  const s = db.prepare('SELECT rs.*, t.city, t.name AS terminal FROM route_stops rs JOIN terminals t ON t.id = rs.terminal_id WHERE rs.id = ? AND rs.route_id = ?').get(stopId, routeId);
  if (!s) throw bad('Pick a boarding and dropping point on this route.');
  return s;
}

function validatePassengers(passengers, layout) {
  if (!Array.isArray(passengers) || !passengers.length) throw bad('Add passenger details for each seat.');
  for (const [i, p] of passengers.entries()) {
    const label = `passenger ${i + 1}`;
    if (!p.name?.trim()) throw bad(`Enter a name for ${label}.`);
    if (!['NRC', 'Passport', 'Other'].includes(p.id_type)) throw bad(`Choose an ID type for ${label}.`);
    if (!p.id_number?.trim()) throw bad(`Enter the ${p.id_type} number for ${label}. It is required for the passenger manifest.`);
    if (p.id_type === 'NRC' && !/^\d{6}\/\d{2}\/\d$/.test(p.id_number.trim())) throw bad(`NRC for ${label} should look like 123456/78/1.`);
    const seat = layout.seats.get(String(p.seat_no));
    if (!seat) throw bad(`Seat ${p.seat_no} does not exist on this bus.`);
    if (seat.female && p.gender !== 'F') throw bad(`Seat ${p.seat_no} is reserved for women. Change the passenger or the seat.`);
  }
}

/**
 * Turn held seats into bookings. One call can create an outbound and a return leg that share a group_ref
 * and are paid together.
 *  channel web     → pending_payment (expires with the hold) or reserved (pay at station, 30 min)
 *  channel counter/agent with cash → confirmed immediately
 */
export function createBookings(db, { legs, contact, promo_code, payment_method, user, channel = 'web' }) {
  if (!Array.isArray(legs) || legs.length < 1 || legs.length > 2) throw bad('A booking has one or two legs (outbound and return).');
  if (!PAY_METHODS.includes(payment_method)) throw bad('Choose a payment method.');
  if (payment_method === 'cash' && channel === 'web') throw bad('Cash is only accepted at the station counter.');
  if (!contact?.name?.trim()) throw bad('Enter a contact name.');
  const phone = normPhone(contact.phone);
  const email = contact.email?.trim() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email address or leave it blank.');

  const groupRef = ref('G', 8);
  const now = new Date();
  const reserveMin = Number(setting(db, 'reserve_minutes'));
  const out = tx(db, () => {
    const created = [];
    for (const leg of legs) {
      const trip = tripForBooking(db, leg.trip_id);
      if (['departed', 'arrived', 'cancelled'].includes(trip.status)) throw conflict('This trip is no longer taking bookings.');
      const from = stop(db, trip.route_id, leg.from_stop_id), to = stop(db, trip.route_id, leg.to_stop_id);
      if (to.seq <= from.seq) throw bad('The dropping point must come after the boarding point.');
      const layout = layoutForTrip(db, trip.id);
      validatePassengers(leg.passengers, layout);

      // The caller must hold exactly these seats, and the hold must still be live.
      const holds = db.prepare('SELECT seat_no, expires_at FROM seat_holds WHERE trip_id = ? AND hold_token = ?').all(trip.id, leg.hold_token || '');
      const seatNos = leg.passengers.map(p => String(p.seat_no));
      const heldNos = new Set(holds.filter(h => h.expires_at > now.toISOString()).map(h => h.seat_no));
      if (seatNos.some(s => !heldNos.has(s))) throw conflict('Your seat selection expired. Pick your seats again.', 'hold_expired');

      const promo = findPromo(db, promo_code, trip.operator_id);
      const price = priceLeg(db, { trip, fromStop: from, toStop: to, passengers: leg.passengers, promo });
      const status = payment_method === 'cash' ? 'confirmed' : payment_method === 'station' ? 'reserved' : 'pending_payment';
      const expires = status === 'confirmed' ? null
        : status === 'reserved' ? addMinutes(now, reserveMin).toISOString()
        : addMinutes(now, Number(setting(db, 'hold_minutes'))).toISOString();
      if (status === 'reserved' && addMinutes(now, reserveMin) > new Date(trip.depart_at)) throw bad('Pay-at-station is not available this close to departure. Pay by mobile money or card.');
      const bookingRef = ref('MT', 6);
      const b = db.prepare(`INSERT INTO bookings (ref, group_ref, user_id, created_by, trip_id, operator_id, channel, status, from_stop_id, to_stop_id,
          contact_name, contact_phone, contact_email, fare_total, discount, booking_fee, total, commission, promo_code, payment_method, expires_at, confirmed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
        bookingRef, groupRef, user?.role === 'passenger' ? user.id : null, user?.id ?? null, trip.id, trip.operator_id, channel, status, from.id, to.id,
        contact.name.trim(), phone, email, price.fare_total, price.discount, price.booking_fee, price.total, price.commission,
        promo?.code ?? null, payment_method, expires, status === 'confirmed' ? now.toISOString() : null);
      const insSeat = db.prepare(`INSERT INTO booking_seats (booking_id, trip_id, seat_no, passenger_name, id_type, id_number, gender, is_child, fare) VALUES (?,?,?,?,?,?,?,?,?)`);
      leg.passengers.forEach((p, i) => {
        try { insSeat.run(b.id, trip.id, String(p.seat_no), p.name.trim(), p.id_type, p.id_number.trim().toUpperCase(), p.gender || null, p.is_child ? 1 : 0, price.seat_fares[i]); }
        catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict(`Seat ${p.seat_no} is already booked.`, 'seat_taken'); throw e; }
      });
      db.prepare('DELETE FROM seat_holds WHERE trip_id = ? AND hold_token = ?').run(trip.id, leg.hold_token);
      if (promo) db.prepare('UPDATE pricing_rules SET used = used + 1 WHERE id = ?').run(promo.id);
      created.push({ ref: bookingRef, trip_id: trip.id, status, total: price.total, expires_at: expires, price });
    }
    return created;
  });
  out.forEach(b => seatChanged(b.trip_id));
  const total = money(out.reduce((a, b) => a + b.total, 0));
  if (out[0].status === 'confirmed') sendTickets(db, groupRef);
  if (out[0].status === 'reserved') {
    notifyContact(db, { phone, email, kind: 'reserved', subject: 'Seat reserved',
      body: `MyTicket: Seats reserved, ref ${out.map(b => b.ref).join(' + ')}. Pay ${cur(total)} at the ${groupStation(db, groupRef)} counter by ${localTime(out[0].expires_at)} or the reservation is released.` });
  }
  return { group_ref: groupRef, total, bookings: out };
}

function groupStation(db, groupRef) {
  return db.prepare(`SELECT o.name FROM bookings b JOIN operators o ON o.id = b.operator_id WHERE b.group_ref = ? LIMIT 1`).get(groupRef)?.name;
}

export function groupBookings(db, groupRef) {
  return db.prepare('SELECT * FROM bookings WHERE group_ref = ? ORDER BY id').all(groupRef);
}

/** Start a payment for every unpaid booking in the group. */
export async function startPayment(db, { group_ref, method, msisdn, cardOutcome }) {
  const bookings = groupBookings(db, group_ref);
  if (!bookings.length) throw notFound('Booking not found.');
  const unpaid = bookings.filter(b => ['pending_payment', 'reserved'].includes(b.status));
  if (!unpaid.length) {
    if (bookings.every(b => b.status === 'confirmed')) throw conflict('This booking is already paid.');
    throw conflict('This booking expired before payment. Search again to pick seats.', 'expired');
  }
  if (!['mtn', 'airtel', 'zamtel', 'card'].includes(method)) throw bad('Choose MTN MoMo, Airtel Money, Zamtel Kwacha or card.');
  let num = null;
  if (method !== 'card') {
    num = normPhone(msisdn);
    const net = networkOf(num);
    if (net && net !== method) throw bad(`That number is on ${net.toUpperCase()}. Pick ${net.toUpperCase()} as the payment method or use a ${method.toUpperCase()} number.`);
  }
  const pending = db.prepare("SELECT id FROM payments WHERE group_ref = ? AND status = 'initiated'").get(group_ref);
  if (pending) throw conflict('A payment for this booking is already waiting for approval on your phone.', 'payment_pending');

  const amount = money(unpaid.reduce((a, b) => a + b.total, 0));
  // Give the customer time to approve the prompt: extend the hold a little while a payment is in flight.
  db.prepare("UPDATE bookings SET expires_at = MAX(expires_at, ?) WHERE group_ref = ? AND status = 'pending_payment'").run(addMinutes(new Date(), 5).toISOString(), group_ref);
  const p = providers[method];
  const r = await p.initiate({ amount, currency: config.currency, msisdn: num, reference: group_ref, cardOutcome });
  const row = db.prepare(`INSERT INTO payments (group_ref, provider, msisdn, amount, status, provider_ref, failure_reason) VALUES (?,?,?,?,?,?,?) RETURNING id`)
    .get(group_ref, method, num, amount, r.status, r.providerRef, r.reason ?? null);
  db.prepare('UPDATE bookings SET payment_method = ? WHERE group_ref = ?').run(method, group_ref);
  return { payment_id: row.id, status: r.status, amount, redirect_url: r.redirectUrl, sandbox: !!p.sandbox, reason: r.reason };
}

/** Ask the provider for the latest status and settle the booking. Safe to call repeatedly. */
export async function checkPayment(db, paymentId) {
  const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!pay) throw notFound('Payment not found.');
  if (pay.status !== 'initiated') return pay;
  const r = await providers[pay.provider].check(pay.provider_ref);
  if (r.status === 'success') {
    const ok = tx(db, () => {
      const still = db.prepare("SELECT COUNT(*) n FROM bookings WHERE group_ref = ? AND status IN ('pending_payment','reserved')").get(pay.group_ref).n;
      db.prepare("UPDATE payments SET status='success', updated_at=datetime('now') WHERE id=?").run(pay.id);
      if (!still) return false;
      db.prepare("UPDATE bookings SET status='confirmed', confirmed_at=datetime('now'), expires_at=NULL WHERE group_ref=? AND status IN ('pending_payment','reserved')").run(pay.group_ref);
      return true;
    });
    if (ok) sendTickets(db, pay.group_ref);
    else {
      // Money arrived after the seats were released: refund automatically and open a dispute record for the admin.
      const b = groupBookings(db, pay.group_ref)[0];
      db.prepare("INSERT INTO refunds (booking_id, amount, reason) VALUES (?,?,?)").run(b.id, pay.amount, 'Payment received after booking expired');
      db.prepare("INSERT INTO disputes (booking_id, user_id, category, description) VALUES (?,?,?,?)").run(b.id, b.user_id, 'payment_failed', `Payment ${pay.provider_ref} of ${cur(pay.amount)} succeeded after the seat hold expired. Automatic refund queued.`);
    }
  } else if (r.status === 'failed') {
    db.prepare("UPDATE payments SET status='failed', failure_reason=?, updated_at=datetime('now') WHERE id=?").run(r.reason || 'Payment failed', pay.id);
  }
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
}

/** Counter clerk takes cash for a pay-at-station reservation. */
export function settleAtCounter(db, groupRef, clerk) {
  const bookings = groupBookings(db, groupRef).filter(b => b.status === 'reserved');
  if (!bookings.length) throw conflict('Nothing to pay on this reference. It may be paid already or expired.');
  if (bookings.some(b => b.operator_id !== clerk.operator_id)) throw forbidden('This reservation belongs to another bus company.');
  const amount = money(bookings.reduce((a, b) => a + b.total, 0));
  tx(db, () => {
    db.prepare("INSERT INTO payments (group_ref, provider, amount, status, provider_ref) VALUES (?,?,?,?,?)").run(groupRef, 'cash', amount, 'success', `CASH-${clerk.id}-${Date.now()}`);
    db.prepare("UPDATE bookings SET status='confirmed', confirmed_at=datetime('now'), expires_at=NULL, payment_method='cash' WHERE group_ref=? AND status='reserved'").run(groupRef);
  });
  sendTickets(db, groupRef);
  return { group_ref: groupRef, amount };
}

export function sendTickets(db, groupRef) {
  for (const b of groupBookings(db, groupRef).filter(b => b.status === 'confirmed')) {
    const t = db.prepare(`SELECT tr.depart_at, tr.delay_min, rs.offset_min, te.name terminal, te.city, (SELECT city FROM terminals WHERE id = (SELECT terminal_id FROM route_stops WHERE id = ?)) to_city
      FROM trips tr JOIN route_stops rs ON rs.id = ? JOIN terminals te ON te.id = rs.terminal_id WHERE tr.id = ?`).get(b.to_stop_id, b.from_stop_id, b.trip_id);
    const seats = db.prepare('SELECT seat_no FROM booking_seats WHERE booking_id = ? AND active = 1').all(b.id).map(s => s.seat_no).join(', ');
    const at = addMinutes(t.depart_at, t.offset_min + t.delay_min);
    notifyContact(db, { phone: b.contact_phone, email: b.contact_email, kind: 'ticket', subject: `Your ticket ${b.ref}`,
      body: `MyTicket: Booking ${b.ref} confirmed. ${t.city} to ${t.to_city}, ${localDate(at)} ${localTime(at)}, seat ${seats}. Board at ${t.terminal}. Ticket and QR code: ${ticketUrl(b.ref)}` });
  }
}

/** Cancel one booking. `full` = 100% refund including fee (used when the operator cancels the trip). */
export function cancelBooking(db, booking, { by, reason, full = false }) {
  if (!['pending_payment', 'reserved', 'confirmed'].includes(booking.status)) throw conflict('This booking cannot be cancelled.');
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(booking.trip_id);
  if (!full && ['departed', 'arrived'].includes(trip.status)) throw conflict('The bus has already left. Contact support if something went wrong.');
  const q = refundQuote(db, booking, trip);
  const amount = full && booking.status === 'confirmed' ? booking.total : q.amount;
  tx(db, () => {
    db.prepare("UPDATE bookings SET status='cancelled', cancelled_at=datetime('now'), expires_at=NULL WHERE id=?").run(booking.id);
    db.prepare('UPDATE booking_seats SET active = 0 WHERE booking_id = ?').run(booking.id);
    if (amount > 0) db.prepare('INSERT INTO refunds (booking_id, amount, reason) VALUES (?,?,?)').run(booking.id, amount, reason);
    db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)').run(by?.id ?? null, 'cancel', 'booking', booking.ref, reason);
  });
  seatChanged(booking.trip_id);
  notifyContact(db, { phone: booking.contact_phone, email: booking.contact_email, kind: 'cancelled', subject: `Booking ${booking.ref} cancelled`,
    body: `MyTicket: Booking ${booking.ref} is cancelled.${amount > 0 ? ` Refund of ${cur(amount)} goes back to your ${booking.payment_method === 'card' ? 'card' : 'mobile money wallet'} within 3 working days.` : ''}` });
  return { ref: booking.ref, refund: amount, pct: full ? 100 : q.pct };
}

/**
 * Move a confirmed booking to another trip of the same company and route.
 * The fare already paid becomes credit; the passenger pays the reschedule fee plus any fare difference.
 * Leftover credit is refunded.
 */
export function rescheduleBooking(db, booking, { trip_id, hold_token, seats, user }) {
  if (booking.status !== 'confirmed') throw conflict('Only paid bookings can be rescheduled.');
  const oldTrip = db.prepare('SELECT * FROM trips WHERE id = ?').get(booking.trip_id);
  if (new Date(oldTrip.depart_at) - Date.now() < 3 * 36e5) throw conflict('Changes close 3 hours before departure.');
  const newTrip = tripForBooking(db, trip_id);
  if (newTrip.operator_id !== booking.operator_id || newTrip.route_id !== oldTrip.route_id) throw bad('You can only move to another departure of the same company on the same route.');
  if (newTrip.id === oldTrip.id) throw bad('Pick a different departure.');
  const oldSeats = db.prepare('SELECT * FROM booking_seats WHERE booking_id = ? AND active = 1 ORDER BY id').all(booking.id);
  if (!Array.isArray(seats) || seats.length !== oldSeats.length) throw bad(`Pick ${oldSeats.length} seat${oldSeats.length > 1 ? 's' : ''} on the new bus.`);
  const from = stop(db, newTrip.route_id, booking.from_stop_id), to = stop(db, newTrip.route_id, booking.to_stop_id);
  const passengers = oldSeats.map((s, i) => ({ seat_no: seats[i], name: s.passenger_name, id_type: s.id_type, id_number: s.id_number, gender: s.gender, is_child: !!s.is_child }));
  validatePassengers(passengers, layoutForTrip(db, newTrip.id));
  const terms = operatorTerms(db, booking.operator_id);
  const price = priceLeg(db, { trip: newTrip, fromStop: from, toStop: to, passengers, promo: null });
  const credit = money(booking.fare_total - booking.discount);
  const applied = Math.min(credit, price.fare_total);
  const leftover = money(credit - applied);
  const total = money(price.fare_total - applied + terms.rescheduleFee);
  const now = new Date();
  const newRef = ref('MT', 6);
  const result = tx(db, () => {
    const heldNos = new Set(db.prepare('SELECT seat_no FROM seat_holds WHERE trip_id = ? AND hold_token = ? AND expires_at > ?').all(newTrip.id, hold_token || '', now.toISOString()).map(h => h.seat_no));
    if (seats.some(s => !heldNos.has(String(s)))) throw conflict('Your seat selection expired. Pick your seats again.', 'hold_expired');
    const status = total > 0 ? 'pending_payment' : 'confirmed';
    const b = db.prepare(`INSERT INTO bookings (ref, group_ref, user_id, created_by, trip_id, operator_id, channel, status, from_stop_id, to_stop_id, contact_name, contact_phone, contact_email,
        fare_total, discount, booking_fee, total, commission, payment_method, expires_at, rescheduled_from, confirmed_at)
      VALUES (?,?,?,?,?,?,'web',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(newRef, ref('G', 8), booking.user_id, user?.id ?? null, newTrip.id, newTrip.operator_id, status,
      from.id, to.id, booking.contact_name, booking.contact_phone, booking.contact_email, price.fare_total, applied, terms.rescheduleFee, total,
      money((price.fare_total) * terms.commissionPct / 100), booking.payment_method, status === 'confirmed' ? null : addMinutes(now, Number(setting(db, 'hold_minutes'))).toISOString(),
      booking.id, status === 'confirmed' ? now.toISOString() : null);
    const ins = db.prepare('INSERT INTO booking_seats (booking_id, trip_id, seat_no, passenger_name, id_type, id_number, gender, is_child, fare) VALUES (?,?,?,?,?,?,?,?,?)');
    passengers.forEach((p, i) => ins.run(b.id, newTrip.id, String(p.seat_no), p.name, p.id_type, p.id_number, p.gender, p.is_child ? 1 : 0, price.seat_fares[i]));
    db.prepare('DELETE FROM seat_holds WHERE trip_id = ? AND hold_token = ?').run(newTrip.id, hold_token);
    // Old booking: release seats now. Its fare becomes credit, so the commission on it is reversed.
    db.prepare("UPDATE bookings SET status='cancelled', cancelled_at=datetime('now'), commission=0 WHERE id=?").run(booking.id);
    db.prepare('UPDATE booking_seats SET active = 0 WHERE booking_id = ?').run(booking.id);
    if (leftover > 0) db.prepare('INSERT INTO refunds (booking_id, amount, reason) VALUES (?,?,?)').run(booking.id, leftover, `Rescheduled to ${newRef}: unused fare`);
    return { ref: newRef, status, total, credit_applied: applied, refund: leftover, reschedule_fee: terms.rescheduleFee };
  });
  seatChanged(oldTrip.id); seatChanged(newTrip.id);
  const g = db.prepare('SELECT group_ref FROM bookings WHERE ref = ?').get(newRef).group_ref;
  if (result.status === 'confirmed') sendTickets(db, g);
  return { ...result, group_ref: g };
}

/** Housekeeping: release expired holds and unpaid bookings, complete finished trips. */
export function sweep(db) {
  const now = new Date().toISOString();
  const expired = db.prepare("SELECT id, trip_id FROM bookings WHERE status IN ('pending_payment','reserved') AND expires_at <= ?").all(now);
  const holdTrips = db.prepare('SELECT DISTINCT trip_id FROM seat_holds WHERE expires_at <= ?').all(now);
  if (expired.length || holdTrips.length) {
    tx(db, () => {
      db.prepare('DELETE FROM seat_holds WHERE expires_at <= ?').run(now);
      for (const b of expired) {
        // Do not expire a booking whose payment is still being approved on the phone.
        const inFlight = db.prepare("SELECT 1 FROM payments p JOIN bookings b ON b.group_ref = p.group_ref WHERE b.id = ? AND p.status = 'initiated' AND p.created_at > datetime('now','-10 minutes')").get(b.id);
        if (inFlight) continue;
        db.prepare("UPDATE bookings SET status='expired' WHERE id=?").run(b.id);
        db.prepare('UPDATE booking_seats SET active = 0 WHERE booking_id = ?').run(b.id);
      }
    });
    new Set([...expired.map(b => b.trip_id), ...holdTrips.map(h => h.trip_id)]).forEach(seatChanged);
  }
  db.prepare(`UPDATE bookings SET status='completed' WHERE status='confirmed' AND trip_id IN (
      SELECT tr.id FROM trips tr JOIN routes r ON r.id = tr.route_id
      WHERE tr.status = 'arrived' OR datetime(tr.depart_at, '+' || (r.duration_min + tr.delay_min + 360) || ' minutes') < datetime('now'))`).run();
}
