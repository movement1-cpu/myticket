// Cash accountability for station counters: shifts, a cash ledger, supervisor-approved voids, alerts.
import { tx } from '../db.js';
import { bad, conflict, forbidden, money, normPhone, HttpError } from '../util.js';
import { verifyPassword } from '../auth.js';
import { rateLimit } from '../security.js';
import { queue } from './notify.js';

const VARIANCE_ALERT = 50;   // K: a close with a bigger difference alerts the owner
const VOID_ALERT = 3;        // voids in one shift before the owner is alerted

export const openShift = (db, userId) => db.prepare("SELECT * FROM cash_shifts WHERE user_id = ? AND status = 'open'").get(userId);

/** Cash sales need an open shift: money must always land in someone's drawer. */
export function requireShift(db, user) {
  const s = openShift(db, user.id);
  if (!s) throw new HttpError(409, 'Open your cash shift first (Station terminal → Open shift), then take cash.', 'no_shift');
  return s;
}

export function recordCash(db, shiftId, { kind, amount, ref = null, bookingId = null, note = null }) {
  db.prepare('INSERT INTO cash_movements (shift_id, kind, amount, ref, booking_id, note) VALUES (?,?,?,?,?,?)').run(shiftId, kind, money(amount), ref, bookingId, note);
}

export function shiftSummary(db, shift) {
  const rows = db.prepare('SELECT kind, COUNT(*) n, COALESCE(SUM(amount), 0) total FROM cash_movements WHERE shift_id = ? GROUP BY kind').all(shift.id);
  const by = Object.fromEntries(rows.map(r => [r.kind, r]));
  const takings = rows.reduce((a, r) => a + r.total, 0);
  return { ...shift, by_kind: by, takings: money(takings), expected_cash: money(shift.opening_float + takings), voids: by.void?.n || 0 };
}

export function startShift(db, user, float) {
  const f = Number(float);
  if (!(f >= 0 && f <= 100000)) throw bad('Enter the cash you are starting with (the float), in kwacha.');
  if (openShift(db, user.id)) throw conflict('You already have an open shift.');
  return db.prepare('INSERT INTO cash_shifts (operator_id, user_id, opening_float) VALUES (?,?,?) RETURNING *').get(user.operator_id, user.id, money(f));
}

/** Close: compare counted cash with what the ledger says should be there. */
export function endShift(db, user, { counted_cash, notes }) {
  const s = openShift(db, user.id);
  if (!s) throw conflict('You have no open shift.');
  const counted = Number(counted_cash);
  if (!(counted >= 0)) throw bad('Count the cash in the drawer and enter the total.');
  const sum = shiftSummary(db, s);
  const variance = money(counted - sum.expected_cash);
  if (Math.abs(variance) > 0.009 && !String(notes || '').trim()) throw bad(`The count is ${variance > 0 ? 'over' : 'short'} by K${Math.abs(variance).toFixed(2)}. Explain the difference in the notes.`);
  db.prepare("UPDATE cash_shifts SET status = 'closed', closed_at = datetime('now'), expected_cash = ?, counted_cash = ?, variance = ?, notes = ? WHERE id = ?")
    .run(sum.expected_cash, counted, variance, String(notes || '').slice(0, 500) || null, s.id);
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)').run(user.id, 'shift_closed', 'cash_shift', String(s.id), `expected K${sum.expected_cash} counted K${counted} variance K${variance}`);
  if (Math.abs(variance) > VARIANCE_ALERT) alertOwners(db, user.operator_id, `MyTicket: ${user.name}'s cash shift closed ${variance > 0 ? 'OVER' : 'SHORT'} by K${Math.abs(variance).toFixed(2)} (expected K${sum.expected_cash.toFixed(2)}, counted K${counted.toFixed(2)}). See Cash & shifts.`);
  return { ...shiftSummary(db, db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(s.id)), counted_cash: counted, variance };
}

function alertOwners(db, operatorId, body) {
  for (const u of db.prepare("SELECT phone FROM users WHERE operator_id = ? AND role = 'operator' AND active = 1").all(operatorId)) queue(db, { channel: 'sms', to: u.phone, kind: 'cash_alert', body });
}

/** A supervisor (company owner with a PIN) approves a void at the counter. */
export function checkSupervisor(db, clerk, phone, pin) {
  rateLimit(db, `pin:${clerk.id}`, 5, 900, 'Too many wrong supervisor PINs.');
  let p;
  try { p = normPhone(phone); } catch { throw bad('Enter the supervisor\'s phone number.'); }
  const sup = db.prepare("SELECT * FROM users WHERE phone = ? AND operator_id = ? AND role = 'operator' AND active = 1 AND pin_hash IS NOT NULL").get(p, clerk.operator_id);
  if (!sup || !verifyPassword(String(pin || ''), sup.pin_hash)) throw forbidden('Supervisor phone or PIN is wrong.');
  return sup;
}

/**
 * Void a counter cash sale: full cash refund from the drawer, seats released, logged with the supervisor and reason.
 * Only for cash sales made today at this company's counter, before the bus leaves.
 */
export function voidSale(db, clerk, booking, { reason, supervisor }, cancelBooking) {
  if (!String(reason || '').trim()) throw bad('Give the reason for the void.');
  if (booking.operator_id !== clerk.operator_id) throw forbidden();
  if (!['counter', 'agent'].includes(booking.channel) || booking.payment_method !== 'cash') throw conflict('Only cash sales from the counter can be voided here. Passengers cancel online bookings themselves.');
  if (booking.status !== 'confirmed') throw conflict('This sale is not active.');
  if (db.prepare("SELECT 1 FROM bookings WHERE id = ? AND date(confirmed_at) < date('now')").get(booking.id)) throw conflict('Voids are for same-day mistakes. Use a normal cancellation for older sales.');
  const shift = requireShift(db, clerk);
  const result = cancelBooking(db, booking, { by: clerk, reason: `Void: ${reason}`, full: true });
  tx(db, () => {
    db.prepare("UPDATE refunds SET status = 'paid', paid_by = ?, paid_at = datetime('now'), reason = reason || ' (cash returned at the counter)' WHERE booking_id = ? AND status = 'pending'").run(clerk.id, booking.id);
    recordCash(db, shift.id, { kind: 'void', amount: -booking.total, ref: booking.ref, bookingId: booking.id, note: `${reason} · approved by ${supervisor.name}` });
    db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)').run(clerk.id, 'void_sale', 'booking', booking.ref, `K${booking.total} · ${reason} · supervisor ${supervisor.name}`);
  });
  const voids = db.prepare("SELECT COUNT(*) n FROM cash_movements WHERE shift_id = ? AND kind = 'void'").get(shift.id).n;
  if (voids === VOID_ALERT) alertOwners(db, clerk.operator_id, `MyTicket: ${clerk.name} has voided ${voids} sales in the current shift. Last: ${booking.ref} (${reason}). Check Cash & shifts.`);
  return { ...result, cash_returned: booking.total };
}
