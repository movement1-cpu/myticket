import { setting } from '../db.js';
import { money, bad, localDate } from '../util.js';
import { segmentFare } from './trips.js';
import { normLuggage, LUGGAGE_KINDS } from './luggage.js';

/** Demand-based pricing, set per company. Off by default. */
export const DEFAULT_DYNAMIC = { enabled: false, tiers: [{ occupancy: 60, pct: 10 }, { occupancy: 85, pct: 20 }], early_days: 14, early_pct: 10 };
export const DEFAULT_LUGGAGE_FEES = { bags: 0, sacks: 0, containers: 0, boxes: 0, crates: 0, other: 0, free_bags: 1 };

export function operatorTerms(db, operatorId) {
  const o = db.prepare('SELECT commission_pct, booking_fee, refund_policy, reschedule_fee, luggage_fees, dynamic_pricing FROM operators WHERE id = ?').get(operatorId);
  return {
    commissionPct: o?.commission_pct ?? Number(setting(db, 'commission_pct')),
    bookingFee: o?.booking_fee ?? Number(setting(db, 'booking_fee')),
    refundPolicy: JSON.parse(o?.refund_policy || setting(db, 'refund_policy')),
    rescheduleFee: o?.reschedule_fee ?? 20,
    luggageFees: { ...DEFAULT_LUGGAGE_FEES, ...JSON.parse(o?.luggage_fees || '{}') },
    dynamic: { ...DEFAULT_DYNAMIC, ...JSON.parse(o?.dynamic_pricing || '{}') },
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
 *   luggage   = per item, set by the operator (first `free_bags` bags per passenger free); goes to the
 *               operator in full, no commission
 */
/**
 * Adult fare for one seat right now: segment fare adjusted by
 *   peak surcharge (date rules) + demand surcharge (how full the bus is) − early-booking discount.
 */
export function adultFare(db, trip, fromStop, toStop) {
  const base = segmentFare(trip, fromStop, toStop);
  const rules = db.prepare(`SELECT * FROM pricing_rules WHERE operator_id = ? AND active = 1 AND kind IN ('peak','child')
      AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?)`).all(trip.operator_id, trip.service_date, trip.service_date);
  const peak = Math.max(0, ...rules.filter(r => r.kind === 'peak').map(r => r.pct));
  const child = Math.max(0, ...rules.filter(r => r.kind === 'child').map(r => r.pct));
  const dyn = operatorTerms(db, trip.operator_id).dynamic;
  let demand = 0, early = 0, occupancy = 0;
  if (dyn.enabled) {
    const cap = db.prepare('SELECT l.capacity FROM buses b JOIN layouts l ON l.id = b.layout_id WHERE b.id = ?').get(trip.bus_id)?.capacity || 1;
    const sold = db.prepare('SELECT COUNT(*) n FROM booking_seats WHERE trip_id = ? AND active = 1').get(trip.id).n;
    occupancy = Math.round(sold / cap * 100);
    demand = Math.max(0, ...dyn.tiers.filter(t => occupancy >= t.occupancy).map(t => t.pct));
    const daysAhead = Math.round((new Date(trip.service_date + 'T00:00:00Z') - new Date(localDate() + 'T00:00:00Z')) / 864e5);
    if (dyn.early_days && daysAhead >= dyn.early_days) early = dyn.early_pct;
  }
  const fare = Math.max(5, Math.round(base * (1 + (peak + demand - early) / 100) / 5) * 5);
  return { base, fare, peak, demand, early, child, occupancy };
}

export function priceLeg(db, { trip, fromStop, toStop, passengers, promo }) {
  const a = adultFare(db, trip, fromStop, toStop);
  const { base, peak, child } = a;
  const adultFare_ = a.fare;
  const seatFares = passengers.map(p => money(p.is_child ? adultFare_ * (1 - child / 100) : adultFare_));
  const fareTotal = money(seatFares.reduce((a, b) => a + b, 0));
  const discount = promo ? money(fareTotal * promo.pct / 100) : 0;
  const terms = operatorTerms(db, trip.operator_id);
  const commission = money((fareTotal - discount) * terms.commissionPct / 100);
  const luggageFees = passengers.map((p, i) => luggageCharge(terms.luggageFees, Array.isArray(p._lug) ? p._lug : normLuggage(p.luggage, `passenger ${i + 1}`)));
  const luggageFee = money(luggageFees.reduce((a, b) => a + b, 0));
  return {
    base, peak_pct: peak, child_pct: child, demand_pct: a.demand, early_pct: a.early, occupancy: a.occupancy, adult_fare: adultFare_, seat_fares: seatFares,
    fare_total: fareTotal, discount, booking_fee: terms.bookingFee, commission,
    luggage_fee: luggageFee, luggage_fees: luggageFees, luggage_rates: terms.luggageFees,
    total: money(fareTotal - discount + luggageFee + terms.bookingFee),
  };
}

/** Luggage charge for one passenger. counts = [bags, sacks, containers, boxes, crates, other, note]. */
export function luggageCharge(rates, counts) {
  return money(LUGGAGE_KINDS.reduce((sum, [k], i) => {
    const n = Math.max(0, (counts[i] || 0) - (k === 'bags' ? (rates.free_bags || 0) : 0));
    return sum + n * (Number(rates[k]) || 0);
  }, 0));
}

/** Refund owed on cancellation under the operator's policy. The booking fee is never refunded. */
export function refundQuote(db, booking, trip) {
  const terms = operatorTerms(db, booking.operator_id);
  const hours = (new Date(trip.depart_at).getTime() - Date.now()) / 36e5;
  const tier = terms.refundPolicy.find(t => hours >= t.hours) || { pct: 0 };
  const confirmed = booking.status === 'confirmed';
  const farePaid = confirmed ? Math.max(0, booking.fare_total - booking.discount - (booking.points_discount || 0)) : 0;
  const luggage = confirmed ? (booking.luggage_fee || 0) : 0;
  return { hours_to_departure: Math.round(hours * 10) / 10, pct: tier.pct, amount: money(farePaid * tier.pct / 100 + luggage), luggage_refund: luggage,
    points_restored: booking.points_used || 0, policy: terms.refundPolicy };
}
