import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';
import { sign, safeEqual, localTime, localDate } from '../util.js';
import { config } from '../config.js';
import { luggageOf, LUGGAGE_SQL } from './luggage.js';

/** QR payload: MT1|<booking ref>|<signature>. The signature stops forged tickets; the DB stops reuse. */
export const ticketKey = ref => sign('qr.' + ref).slice(0, 16);
export const qrPayload = ref => `MT1|${ref}|${ticketKey(ref)}`;
export const ticketUrl = ref => `${config.baseUrl}/ticket.html?ref=${ref}&k=${ticketKey(ref)}`;

export function parseQr(text) {
  const [v, ref, k] = String(text || '').trim().split('|');
  if (v !== 'MT1' || !ref || !k || !safeEqual(k, ticketKey(ref))) return null;
  return ref;
}
export const validKey = (ref, k) => !!k && safeEqual(k, ticketKey(ref));

export function ticketData(db, ref) {
  const b = db.prepare(`SELECT b.*, tr.depart_at, tr.status AS trip_status, tr.delay_min, tr.service_date, bu.plate, bu.class,
      o.name AS operator_name, o.contact_phone AS operator_phone,
      fs.offset_min AS from_offset, ft.city AS from_city, ft.name AS from_terminal, ft.lat AS from_lat, ft.lng AS from_lng,
      ts.offset_min AS to_offset, tt.city AS to_city, tt.name AS to_terminal
    FROM bookings b JOIN trips tr ON tr.id = b.trip_id JOIN buses bu ON bu.id = tr.bus_id JOIN operators o ON o.id = b.operator_id
    JOIN route_stops fs ON fs.id = b.from_stop_id JOIN terminals ft ON ft.id = fs.terminal_id
    JOIN route_stops ts ON ts.id = b.to_stop_id JOIN terminals tt ON tt.id = ts.terminal_id
    WHERE b.ref = ?`).get(ref);
  if (!b) return null;
  const board = new Date(new Date(b.depart_at).getTime() + (b.from_offset + b.delay_min) * 60000);
  const arrive = new Date(new Date(b.depart_at).getTime() + (b.to_offset + b.delay_min) * 60000);
  const seats = db.prepare(`SELECT id, seat_no, passenger_name, id_type, id_number, gender, is_child, fare, boarded_at, active, ${LUGGAGE_SQL} FROM booking_seats WHERE booking_id = ? ORDER BY seat_no`).all(b.id)
    .map(s => ({ ...s, luggage: luggageOf(s) }));
  const issuer = b.channel !== 'web' && b.created_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(b.created_by)?.name : null;
  return { ...b, board_at: board.toISOString(), arrive_at: arrive.toISOString(), board_local: `${localDate(board)} ${localTime(board)}`, arrive_local: `${localDate(arrive)} ${localTime(arrive)}`, seats, issuer, qr: qrPayload(ref), url: ticketUrl(ref) };
}

export const qrSvg = ref => QRCode.toString(qrPayload(ref), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });

export async function ticketPdf(t) {
  const png = await QRCode.toBuffer(t.qr, { margin: 1, width: 300, errorCorrectionLevel: 'M' });
  const doc = new PDFDocument({ size: 'A5', margin: 36 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(r => doc.on('end', () => r(Buffer.concat(chunks))));
  const cur = config.currency === 'ZMW' ? 'K' : config.currency + ' ';
  doc.fontSize(9).fillColor('#555').text('MYTICKET E-TICKET', { characterSpacing: 1.5 });
  doc.moveDown(0.3).fontSize(20).fillColor('#000').text(`${t.from_city} → ${t.to_city}`);
  doc.fontSize(11).text(`${t.operator_name} · ${t.class} · ${t.plate}`);
  doc.moveDown(0.6);
  const row = (k, v) => { doc.fontSize(8).fillColor('#666').text(k.toUpperCase()); doc.fontSize(12).fillColor('#000').text(v).moveDown(0.3); };
  row('Booking reference', t.ref);
  row('Status', t.status.replace('_', ' '));
  row('Boarding', `${t.from_terminal}, ${t.from_city} — ${t.board_local}`);
  row('Arrival (planned)', `${t.to_terminal}, ${t.to_city} — ${t.arrive_local}`);
  row('Passengers', t.seats.filter(s => s.active).map(s => `Seat ${s.seat_no}: ${s.passenger_name} (${s.id_type} ${s.id_number})\n   Luggage: ${s.luggage.text}`).join('\n'));
  row('Paid', `${cur}${t.total.toFixed(2)} via ${t.payment_method || '—'}`);
  doc.image(png, doc.page.width - 36 - 130, 90, { width: 130 });
  doc.moveDown(1).fontSize(8).fillColor('#666').text('Show this QR code at the boarding gate. Arrive 30 minutes before departure with the ID listed above. Each code can be scanned once.');
  doc.end();
  return done;
}
