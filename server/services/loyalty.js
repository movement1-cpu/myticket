import { setting } from '../db.js';
import { bad, money } from '../util.js';

/**
 * Loyalty points (platform-funded).
 *   Earn: floor(fare paid in cash × points_per_kwacha) when a trip is completed. Default: 1 point per K10.
 *   Spend: points × point_value off the fare at checkout, capped at loyalty_max_pct of the fare.
 *          Default: 100 points = K10, up to 50% of a fare.
 * The discount is paid by the platform, so the bus company still earns its full fare.
 * Points used on a booking that expires or is cancelled are given back.
 */
export function loyaltyTerms(db) {
  return {
    perKwacha: Number(setting(db, 'loyalty_points_per_kwacha')),
    pointValue: Number(setting(db, 'loyalty_point_value')),
    maxPct: Number(setting(db, 'loyalty_max_pct')),
  };
}

export const pointsBalance = (db, userId) =>
  db.prepare('SELECT COALESCE(SUM(points), 0) v FROM loyalty_ledger WHERE user_id = ?').get(userId).v;

/** How many points can go on a fare, and what they are worth. */
export function maxRedeemable(db, fare, balance) {
  const t = loyaltyTerms(db);
  if (!t.pointValue) return 0;
  return Math.max(0, Math.min(balance, Math.floor((fare * t.maxPct / 100) / t.pointValue)));
}

export function checkRedeem(db, user, points) {
  points = Number(points) || 0;
  if (!points) return 0;
  if (!Number.isInteger(points) || points < 0) throw bad('Points must be a whole number.');
  if (user?.role !== 'passenger') throw bad('Sign in as a passenger to use loyalty points.');
  const bal = pointsBalance(db, user.id);
  if (points > bal) throw bad(`You have ${bal} points.`);
  return points;
}

export const pointsValue = (db, points) => money(points * loyaltyTerms(db).pointValue);

export function restorePoints(db, booking, note) {
  if (!booking.points_used || !booking.user_id) return;
  db.prepare("INSERT INTO loyalty_ledger (user_id, booking_id, points, kind, note) VALUES (?,?,?,'restore',?)").run(booking.user_id, booking.id, booking.points_used, note);
}

/** Award points for completed trips that have not earned yet. Idempotent (unique index on earn rows). */
export function awardPoints(db) {
  const { perKwacha } = loyaltyTerms(db);
  if (!perKwacha) return 0;
  const rows = db.prepare(`SELECT b.id, b.user_id, b.ref, b.fare_total - b.discount - b.points_discount paid FROM bookings b
    WHERE b.status = 'completed' AND b.user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM loyalty_ledger l WHERE l.booking_id = b.id AND l.kind = 'earn')`).all();
  const ins = db.prepare("INSERT OR IGNORE INTO loyalty_ledger (user_id, booking_id, points, kind, note) VALUES (?,?,?,'earn',?)");
  let n = 0;
  for (const r of rows) {
    const pts = Math.floor(Math.max(0, r.paid) * perKwacha);
    ins.run(r.user_id, r.id, pts, `Trip ${r.ref}`);
    n++;
  }
  return n;
}
