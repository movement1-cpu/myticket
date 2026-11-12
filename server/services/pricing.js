import { setting } from '../db.js';
import { money, bad, localDate } from '../util.js';
import { segmentFare } from './trips.js';

export function operatorTerms(db, operatorId) {
  const o = db.prepare('SELECT commission_pct, booking_fee, refund_policy, reschedule_fee FROM operators WHERE id = ?').get(operatorId);
  return {
    commissionPct: o?.commission_pct ?? Number(setting(db, 'commission_pct')),
    bookingFee: o?.booking_fee ?? Number(setting(db, 'booking_fee')),
    refundPolicy: JSON.parse(o?.refund_policy || setting(db, 'refund_policy')),
    rescheduleFee: o?.reschedule_fee ?? 20,
  };
}

/** Look up a promo code valid for this operator today. Returns the rule or throws a clear error. */
export function findPromo(db, code, operatorId) {
  if (!code) return null;
  const r = db.prepare('SELECT * FROM pricing_rules WHERE kind = ? AND code = ?').get('promo', String(code).trim().toUpperCase());
  const today = localDate();
  if (!r || !r.active) throw bad(`Promo code ${code} is not valid.`, 'promo_code');
  if (r.operator_id && r.operator_id !== operatorId) throw bad(`Promo code ${code} does not apply to this bus company.`, 'promo_code');
  if ((r.start_date && today < r.start_date) || (r.end_date && today > r.end_date)) throw bad(`Promo code ${code} has expired.`, 'promo_code');
  if (r.max_uses != null && r.used >= r.max_uses) throw bad(`Promo code ${code} has been fully used.`, 'promo_code');
  return r;
}

/**
 * Price one leg.
 *   seat fare = segment fare × (1 + peak%) × (1 − child%) for child passengers
 *   discount  = promo% of fare total
 *   fee       = flat platform booking fee per leg (operator override or platform default)
 *   commission= platform % of (fare total − discount), deducted from the operator's payout
 */
export function priceLeg(db, { trip, fromStop, toStop, passengers, promo }) {
  const base = segmentFare(trip, fromStop, toStop);
  const rules = db.prepare(`SELECT * FROM pricing_rules WHERE operator_id = ? AND active = 1 AND kind IN ('peak','child')
      AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?)`).all(trip.operator_id, trip.service_date, trip.service_date);
  const peak = Math.max(0, ...rules.filter(r => r.kind === 'peak').map(r => r.pct));
  const child = Math.max(0, ...rules.filter(r => r.kind === 'child').map(r => r.pct));
  const adultFare = Math.round(base * (1 + peak / 100) / 5) * 5;
  const seatFares = passengers.map(p => money(p.is_child ? adultFare * (1 - child / 100) : adultFare));
  const fareTotal = money(seatFares.reduce((a, b) => a + b, 0));
  const discount = promo ? money(fareTotal * promo.pct / 100) : 0;
  const terms = operatorTerms(db, trip.operator_id);
  const commission = money((fareTotal - discount) * terms.commissionPct / 100);
  return {
    base, peak_pct: peak, child_pct: child, adult_fare: adultFare, seat_fares: seatFares,
    fare_total: fareTotal, discount, booking_fee: terms.bookingFee, commission,
    total: money(fareTotal - discount + terms.bookingFee),
  };
}

/** Refund owed on cancellation under the operator's policy. The booking fee is never refunded. */
export function refundQuote(db, booking, trip) {
  const terms = operatorTerms(db, booking.operator_id);
  const hours = (new Date(trip.depart_at).getTime() - Date.now()) / 36e5;
  const tier = terms.refundPolicy.find(t => hours >= t.hours) || { pct: 0 };
  const paid = booking.status === 'confirmed' ? money(booking.fare_total - booking.discount) : 0;
  return { hours_to_departure: Math.round(hours * 10) / 10, pct: tier.pct, amount: money(paid * tier.pct / 100), policy: terms.refundPolicy };
}
