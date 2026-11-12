import { localDate, addDays } from '../util.js';
import { setting } from '../db.js';
import { queue } from './notify.js';

const SOON_DAYS = 14;
const SOON_KM = 1000;

/** Add the route distance to each bus's odometer once its trip has run. Idempotent via trips.km_logged. */
export function logTripKm(db) {
  const done = db.prepare(`SELECT t.id, t.bus_id, r.distance_km FROM trips t JOIN routes r ON r.id = t.route_id
    WHERE t.km_logged = 0 AND t.status != 'cancelled'
      AND (t.status = 'arrived' OR datetime(t.depart_at, '+' || (r.duration_min + t.delay_min + 360) || ' minutes') < datetime('now'))`).all();
  for (const t of done) {
    db.prepare('UPDATE buses SET odometer_km = odometer_km + ? WHERE id = ?').run(t.distance_km, t.bus_id);
    db.prepare('UPDATE trips SET km_logged = 1 WHERE id = ?').run(t.id);
  }
  return done.length;
}

const DOCS = [['fitness_expiry', 'RTSA certificate of fitness'], ['insurance_expiry', 'insurance'], ['road_tax_expiry', 'road tax']];

/** Everything that is overdue, due soon or not recorded, worst first. */
export function dueItems(db, operatorId) {
  const today = localDate(), soon = addDays(today, SOON_DAYS);
  const items = [];
  const buses = db.prepare("SELECT * FROM buses WHERE operator_id = ? AND status != 'retired' ORDER BY plate").all(operatorId);
  for (const b of buses) {
    const left = Math.round(b.service_interval_km - (b.odometer_km - b.last_service_km));
    if (left <= 0) items.push({ severity: 'overdue', kind: 'service', bus_id: b.id, plate: b.plate, text: `${b.plate}: service overdue by ${(-left).toLocaleString('en')} km` });
    else if (left <= SOON_KM) items.push({ severity: 'soon', kind: 'service', bus_id: b.id, plate: b.plate, text: `${b.plate}: service due in ${left.toLocaleString('en')} km` });
    for (const [col, label] of DOCS) {
      const d = b[col];
      if (!d) items.push({ severity: 'missing', kind: col, bus_id: b.id, plate: b.plate, text: `${b.plate}: ${label} expiry date not recorded` });
      else if (d < today) items.push({ severity: 'overdue', kind: col, bus_id: b.id, plate: b.plate, date: d, text: `${b.plate}: ${label} expired on ${d}` });
      else if (d <= soon) items.push({ severity: 'soon', kind: col, bus_id: b.id, plate: b.plate, date: d, text: `${b.plate}: ${label} expires on ${d}` });
    }
  }
  const drivers = db.prepare("SELECT * FROM staff WHERE operator_id = ? AND role = 'driver' AND active = 1 ORDER BY name").all(operatorId);
  for (const s of drivers) {
    const d = s.licence_expiry;
    if (!d) items.push({ severity: 'missing', kind: 'licence', staff_id: s.id, text: `${s.name}: driving licence expiry not recorded` });
    else if (d < today) items.push({ severity: 'overdue', kind: 'licence', staff_id: s.id, date: d, text: `${s.name}: driving licence expired on ${d}` });
    else if (d <= soon) items.push({ severity: 'soon', kind: 'licence', staff_id: s.id, date: d, text: `${s.name}: driving licence expires on ${d}` });
  }
  const rank = { overdue: 0, soon: 1, missing: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Problems that should stop a bus or driver going out today (shown on the trips list). */
export function tripBlockers(db, trip) {
  const today = localDate();
  const out = [];
  const b = db.prepare('SELECT * FROM buses WHERE id = ?').get(trip.bus_id);
  for (const [col, label] of DOCS) if (b[col] && b[col] < today) out.push(`${label} expired`);
  if (b.service_interval_km - (b.odometer_km - b.last_service_km) <= 0) out.push('service overdue');
  const d = trip.driver_id && db.prepare('SELECT licence_expiry FROM staff WHERE id = ?').get(trip.driver_id);
  if (d?.licence_expiry && d.licence_expiry < today) out.push('driver licence expired');
  return out;
}

/** Once a day, SMS each company owner a summary of overdue and soon-due items. */
export function sendReminders(db) {
  const today = localDate();
  const ops = db.prepare("SELECT id, name, contact_phone FROM operators WHERE status = 'approved' AND contact_phone IS NOT NULL").all();
  let sent = 0;
  for (const o of ops) {
    const key = `maint_reminder_${o.id}`;
    if (setting(db, key) === today) continue;
    const urgent = dueItems(db, o.id).filter(i => i.severity !== 'missing');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, today);
    if (!urgent.length) continue;
    const overdue = urgent.filter(i => i.severity === 'overdue').length;
    const lines = urgent.slice(0, 4).map(i => i.text).join('; ');
    queue(db, { channel: 'sms', to: o.contact_phone, kind: 'maintenance',
      body: `MyTicket ${o.name}: ${overdue ? `${overdue} overdue, ` : ''}${urgent.length - overdue} due soon. ${lines}${urgent.length > 4 ? ` and ${urgent.length - 4} more` : ''}. See Maintenance in your portal.` });
    sent++;
  }
  return sent;
}
