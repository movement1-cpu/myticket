import { setting } from '../db.js';
import { addMinutes, localTime, localDate } from '../util.js';
import { notifyContact } from './notify.js';
import { t } from '../i18n.js';

/**
 * SMS + WhatsApp reminder `reminder_hours` before each passenger's boarding time.
 * Runs every few minutes; bookings.reminded_at makes it send once. Bookings made inside the window are skipped
 * (they just got their ticket).
 */
export function sendDepartureReminders(db) {
  const hours = Number(setting(db, 'reminder_hours'));
  if (!hours) return 0;
  const now = new Date();
  const until = addMinutes(now, hours * 60).toISOString();
  const rows = db.prepare(`SELECT b.*, tr.depart_at, tr.delay_min, fs.offset_min, te.name terminal, te.city from_city, tt.city to_city, bu.plate,
      (SELECT GROUP_CONCAT(seat_no, ', ') FROM booking_seats WHERE booking_id = b.id AND active = 1) seats
    FROM bookings b JOIN trips tr ON tr.id = b.trip_id JOIN buses bu ON bu.id = tr.bus_id
    JOIN route_stops fs ON fs.id = b.from_stop_id JOIN terminals te ON te.id = fs.terminal_id
    JOIN route_stops ts ON ts.id = b.to_stop_id JOIN terminals tt ON tt.id = ts.terminal_id
    WHERE b.status = 'confirmed' AND b.reminded_at IS NULL AND tr.status IN ('scheduled','boarding','delayed')
      AND tr.depart_at > ? AND tr.depart_at <= ?`).all(now.toISOString(), until);
  let n = 0;
  for (const b of rows) {
    const at = addMinutes(b.depart_at, b.offset_min + b.delay_min);
    if (at < now) continue;
    const bookedLate = new Date(b.confirmed_at || b.created_at) > addMinutes(at, -hours * 60);
    db.prepare("UPDATE bookings SET reminded_at = datetime('now') WHERE id = ?").run(b.id);
    if (bookedLate) continue;
    notifyContact(db, { phone: b.contact_phone, email: b.contact_email, kind: 'reminder', subject: `Your bus leaves at ${localTime(at)}`,
      body: t(b.lang, 'sms.reminder', { from: b.from_city, to: b.to_city, date: localDate(at), time: localTime(at), terminal: b.terminal, plate: b.plate, seats: b.seats, ref: b.ref }) });
    n++;
  }
  return n;
}
