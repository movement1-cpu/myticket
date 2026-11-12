import crypto from 'node:crypto';
import { t, langFor, LANGS } from '../i18n.js';
import { normPhone, networkOf, localDate, localTime, addDays, money } from '../util.js';
import { searchTrips } from './trips.js';
import { seatMap, holdSeats } from './seats.js';
import { priceLeg } from './pricing.js';
import { createBookings, startPayment } from './bookings.js';

/**
 * USSD menu (Africa's Talking style: every request carries the full input path, e.g. "1*2*1*3").
 * Stateless: the path is replayed on each request, so nothing is stored between screens.
 *
 *   1 Book: from city → to city → date → bus → seats → name & NRC per seat → confirm → mobile money prompt
 *   2 My tickets (upcoming, for this phone)
 *   3 Bus status by booking reference
 *   4 Language
 */
const PAGE = 6;
const MAX_SEATS = 4;
const NETWORK = { mtn: 'MTN MoMo', airtel: 'Airtel Money', zamtel: 'Zamtel Kwacha' };
const NRC = /^\d{6}\/\d{2}\/\d$/;

export async function handleUssd(db, { phoneNumber, text }) {
  const phone = normPhone(phoneNumber);
  const lang = langFor(db, { phone });
  const T = (k, v) => t(lang, k, v);
  const con = s => `CON ${s}`, end = s => `END ${s}`;
  const input = text ? String(text).split('*') : [];
  const next = () => input.shift();

  /** A numbered list with "0. More" paging. Returns the chosen item, or a screen to show. */
  function pick(title, items, label) {
    let page = 0;
    for (;;) {
      const v = next();
      const slice = items.slice(page * PAGE, page * PAGE + PAGE);
      if (v === undefined) {
        const more = items.length > (page + 1) * PAGE ? `\n${T('ussd.more')}` : '';
        return { screen: con(`${title}\n${slice.map((it, i) => `${page * PAGE + i + 1}. ${label(it)}`).join('\n')}${more}`) };
      }
      if (v === '0' && items.length > (page + 1) * PAGE) { page++; continue; }
      const it = items[Number(v) - 1];
      return it ? { item: it } : { screen: end(T('ussd.invalid')) };
    }
  }

  const top = next();
  if (top === undefined) return con(T('ussd.welcome'));

  if (top === '4') {
    const codes = Object.keys(LANGS);
    const v = next();
    if (v === undefined) return con(T('ussd.lang_menu'));
    const code = codes[Number(v) - 1];
    if (!code) return end(T('ussd.invalid'));
    db.prepare('INSERT INTO phone_prefs (phone, lang) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET lang = excluded.lang').run(phone, code);
    db.prepare("UPDATE users SET lang = ? WHERE phone = ? AND role = 'passenger'").run(code, phone);
    return end(t(code, 'ussd.lang_saved'));
  }

  if (top === '2') {
    const rows = db.prepare(`SELECT b.ref, ft.city f, tt.city tc, tr.depart_at, fs.offset_min, tr.delay_min,
        (SELECT GROUP_CONCAT(seat_no) FROM booking_seats WHERE booking_id = b.id AND active = 1) seats
      FROM bookings b JOIN trips tr ON tr.id = b.trip_id JOIN route_stops fs ON fs.id = b.from_stop_id JOIN terminals ft ON ft.id = fs.terminal_id
      JOIN route_stops ts ON ts.id = b.to_stop_id JOIN terminals tt ON tt.id = ts.terminal_id
      WHERE b.contact_phone = ? AND b.status IN ('confirmed','reserved') AND tr.depart_at > ? ORDER BY tr.depart_at LIMIT 3`).all(phone, new Date(Date.now() - 6 * 36e5).toISOString());
    if (!rows.length) return end(T('ussd.tickets_none'));
    return end(rows.map(r => { const at = new Date(new Date(r.depart_at).getTime() + (r.offset_min + r.delay_min) * 60000); return `${r.ref} ${r.f}-${r.tc} ${localDate(at).slice(5)} ${localTime(at)} #${r.seats}`; }).join('\n'));
  }

  if (top === '3') {
    const v = next();
    if (v === undefined) return con(T('ussd.status_ask'));
    const r = db.prepare(`SELECT b.ref, bu.plate, tr.status, tr.delay_min, tr.depart_at, fs.offset_min, te.name terminal FROM bookings b JOIN trips tr ON tr.id = b.trip_id
      JOIN buses bu ON bu.id = tr.bus_id JOIN route_stops fs ON fs.id = b.from_stop_id JOIN terminals te ON te.id = fs.terminal_id
      WHERE b.ref = ? AND b.contact_phone = ?`).get(v.trim().toUpperCase(), phone);
    if (!r) return end(T('ussd.not_found'));
    const at = new Date(new Date(r.depart_at).getTime() + (r.offset_min + r.delay_min) * 60000);
    return end(T('ussd.status', { ref: r.ref, plate: r.plate, status: T(`status.${r.status}`, { min: r.delay_min }), time: localTime(at), terminal: r.terminal }));
  }

  if (top !== '1') return end(T('ussd.invalid'));

  // ----- booking -----
  // Busiest towns first, so most callers find theirs without paging.
  const origins = db.prepare(`SELECT te.city FROM route_stops rs JOIN terminals te ON te.id = rs.terminal_id JOIN routes r ON r.id = rs.route_id
    JOIN operators o ON o.id = r.operator_id JOIN schedules s ON s.route_id = r.id AND s.active = 1
    WHERE rs.boarding = 1 AND r.active = 1 AND o.status = 'approved' GROUP BY te.city ORDER BY COUNT(*) DESC, te.city`).all().map(r => r.city);
  const from = pick(T('ussd.from'), origins, c => c);
  if (!from.item) return from.screen;
  const dests = db.prepare(`SELECT tz.city FROM route_stops a JOIN terminals ta ON ta.id = a.terminal_id JOIN route_stops z ON z.route_id = a.route_id AND z.seq > a.seq
    JOIN terminals tz ON tz.id = z.terminal_id JOIN routes r ON r.id = a.route_id JOIN operators o ON o.id = r.operator_id JOIN schedules s ON s.route_id = r.id AND s.active = 1
    WHERE ta.city = ? AND a.boarding = 1 AND z.dropping = 1 AND tz.city != ? AND r.active = 1 AND o.status = 'approved' GROUP BY tz.city ORDER BY COUNT(*) DESC, tz.city`).all(from.item, from.item).map(r => r.city);
  const to = pick(T('ussd.to'), dests, c => c);
  if (!to.item) return to.screen;

  const today = localDate();
  const d3 = addDays(today, 2);
  const dayName = new Date(d3 + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const dv = next();
  if (dv === undefined) return con(T('ussd.date', { d3: dayName }));
  if (!['1', '2', '3'].includes(dv)) return end(T('ussd.invalid'));
  const date = addDays(today, Number(dv) - 1);

  const trips = searchTrips(db, { from: from.item, to: to.item, date }).filter(x => x.seats_left > 0).sort((a, b) => a.depart_at.localeCompare(b.depart_at));
  if (!trips.length) return end(T('ussd.no_trips'));
  const trip = pick(T('ussd.pick_trip'), trips, x => `${localTime(x.depart_at)} ${x.operator.split(' ')[0]} K${Math.round(x.fare)}`);
  if (!trip.item) return trip.screen;

  const nv = next();
  if (nv === undefined) return con(T('ussd.seats').replace('6', String(MAX_SEATS)));
  const n = Number(nv);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEATS) return end(T('ussd.invalid'));

  const passengers = [];
  for (let i = 0; i < n; i++) {
    const name = next();
    if (name === undefined) return con(`${n > 1 ? `${i + 1}/${n} ` : ''}${T('ussd.name')}`);
    if (name.trim().length < 3) return end(T('ussd.invalid'));
    const id = next();
    if (id === undefined) return con(`${n > 1 ? `${i + 1}/${n} ` : ''}${T('ussd.id')}`);
    if (!NRC.test(id.trim())) return end(T('ussd.bad_nrc'));
    passengers.push({ name: name.trim(), id_type: 'NRC', id_number: id.trim() });
  }

  // Seats are assigned automatically: free, not women-only, front of the bus first.
  const seats = freeSeats(db, trip.item.trip_id, n);
  if (seats.length < n) return end(T('ussd.no_seats'));
  const network = networkOf(phone);
  const x = trip.item, board = x.boarding_points[0], drop = x.dropping_points.at(-1);
  const legPax = passengers.map((p, i) => ({ ...p, seat_no: seats[i], gender: 'X' }));
  const tripRow = db.prepare('SELECT tr.*, r.distance_km FROM trips tr JOIN routes r ON r.id = tr.route_id WHERE tr.id = ?').get(x.trip_id);
  const fromStop = db.prepare('SELECT * FROM route_stops WHERE id = ?').get(board.stop_id), toStop = db.prepare('SELECT * FROM route_stops WHERE id = ?').get(drop.stop_id);
  const price = priceLeg(db, { trip: tripRow, fromStop, toStop, passengers: legPax, promo: null });

  const cv = next();
  if (cv === undefined) {
    if (!network) return end(T('ussd.no_network'));
    return con(T('ussd.confirm', { n, from: from.item, to: to.item, date: localDate(x.depart_at).slice(5), time: localTime(x.depart_at), operator: x.operator.split(' ')[0],
      seats: seats.join(','), amount: `K${money(price.total).toFixed(2)}`, network: NETWORK[network] }));
  }
  if (cv !== '1') return end(T('ussd.cancelled'));
  if (!network) return end(T('ussd.no_network'));

  const hold = holdSeats(db, { tripId: x.trip_id, seats, token: crypto.randomUUID() });
  const r = createBookings(db, { legs: [{ trip_id: x.trip_id, hold_token: hold.hold_token, from_stop_id: board.stop_id, to_stop_id: drop.stop_id, passengers: legPax }],
    contact: { name: passengers[0].name, phone }, payment_method: network, channel: 'web', lang, source: 'ussd' });
  await startPayment(db, { group_ref: r.group_ref, method: network, msisdn: phone });
  return end(T('ussd.paying', { network: NETWORK[network], amount: `K${r.total.toFixed(2)}`, ref: r.bookings[0].ref }));
}

function freeSeats(db, tripId, n) {
  const m = seatMap(db, tripId);
  return m.decks.flatMap(d => d.rows.flat()).filter(s => s && s.status === 'available' && !s.female).slice(0, n).map(s => s.no);
}

/** Inbound SMS commands: STATUS <ref>, TICKETS, HELP. Returns the reply text. */
export async function handleSms(db, { from, text }) {
  const [cmd, arg] = String(text || '').trim().toUpperCase().split(/\s+/);
  const phone = normPhone(from);
  const strip = s => s.replace(/^(CON|END) /, '');
  if (cmd === 'STATUS' && arg) return strip(await handleUssd(db, { phoneNumber: phone, text: `3*${arg}` }));
  if (cmd === 'TICKETS') return strip(await handleUssd(db, { phoneNumber: phone, text: '2' }));
  return t(langFor(db, { phone }), 'sms.help');
}
