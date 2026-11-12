// Thermal ticket printing for station terminals.
// /print.html?ref=MT…&w=58|80&tags=1&each=1&auto=1
//   w     paper width in mm (58 or 80)
//   tags  also print one luggage tag per item
//   each  one ticket slip per passenger instead of one per booking
//   auto  open the print dialog as soon as it is ready (used from the counter's hidden frame)
// Tip: start Chrome with --kiosk-printing on the counter PC to print straight to the default printer with no dialog.
import { $, html, raw, api, kwacha, time, day } from './core.js';

const q = new URLSearchParams(location.search);
const width = q.get('w') === '80' ? 80 : 58;
const printable = width === 80 ? 72 : 48;
document.documentElement.style.setProperty('--w', `${printable}mm`);
const page = document.createElement('style');
page.textContent = `@page { size: ${width}mm auto; margin: 0 ${(width - printable) / 2}mm; }`;
document.head.append(page);

const yr = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lusaka' });

function ticketSlip(t, seats, copy) {
  const fare = seats.reduce((a, s) => a + s.fare, 0);
  const whole = seats.length === t.seats.filter(s => s.active).length;
  return html`<section class="slip">
    <div class="c co">${t.operator_name}</div>
    <div class="c small">Bus ticket${copy ? ` · ${copy}` : ''}</div>
    <hr class="rule solid">
    <div class="c big">${t.from_city.toUpperCase()} → ${t.to_city.toUpperCase()}</div>
    <hr class="rule">
    <div class="kv"><span>Date</span><b>${day(t.board_at)} ${yr(t.board_at).split(' ').at(-1)}</b></div>
    <div class="kv"><span>Departs</span><b class="big">${time(t.board_at)}</b></div>
    <div class="kv"><span>Board at</span><b>${t.from_terminal}</b></div>
    <div class="kv"><span>Get off</span><b>${t.to_terminal}</b></div>
    <div class="kv"><span>Bus</span><b>${t.plate}</b></div>
    <div class="kv"><span>Class</span><b>${t.class}</b></div>
    <hr class="rule">
    ${seats.map(s => html`<div class="seat">SEAT ${s.seat_no}</div><div>${s.passenger_name}${s.is_child ? ' (child)' : ''}</div><div class="small">${s.id_type} ${s.id_number}</div>
      <div>Luggage: ${s.luggage.has ? s.luggage.text : 'none'}</div><div class="kv small"><span>Fare</span><span>${kwacha(s.fare)}</span></div><hr class="rule">`)}
    ${whole ? html`<div class="kv"><span>Fares</span><b>${kwacha(t.fare_total)}</b></div>
      ${t.discount ? html`<div class="kv"><span>Discount</span><b>-${kwacha(t.discount)}</b></div>` : ''}
      <div class="kv"><span>Booking fee</span><b>${kwacha(t.booking_fee)}</b></div>
      <div class="kv big"><span>TOTAL</span><span>${kwacha(t.total)}</span></div>` : html`<div class="kv"><span>This passenger</span><b>${kwacha(fare)}</b></div>`}
    ${t.status === 'reserved' ? html`<div class="unpaid">NOT PAID<br>Pay at the counter before ${time(t.expires_at)} or the seat is released</div>`
      : html`<div class="kv"><span>Paid by</span><b>${(t.payment_method || '').toUpperCase()}</b></div>`}
    <hr class="rule">
    ${t.qr_svg ? html`<div class="qr">${raw(t.qr_svg)}</div>` : ''}
    <div class="c">REF</div><div class="c huge">${t.ref}</div>
    <hr class="rule">
    <div class="small">Sold by ${t.issuer || t.printed_by} · printed ${day(t.printed_at)} ${time(t.printed_at)}</div>
    <div class="small">Be at the bus 30 min early with this ID. Show this ticket when boarding. Track your bus: SMS link sent to your phone.</div>
  </section>`;
}

const ONE = { bags: 'BAG', sacks: 'SACK', containers: 'CONTAINER', boxes: 'BOX', crates: 'CRATE' };

function luggageTags(t) {
  const out = [];
  for (const s of t.seats.filter(x => x.active && x.luggage.has)) {
    const items = Object.entries(s.luggage.items).flatMap(([k, n]) => Array.from({ length: n }, () => k));
    items.forEach((k, i) => out.push(html`<section class="slip"><div class="tag">
      <div class="c small">LUGGAGE TAG · ${t.operator_name}</div>
      <div class="c huge">${t.ref}</div>
      <div class="c big">SEAT ${s.seat_no}</div>
      <hr class="rule">
      <div>${s.passenger_name}</div>
      <div>${t.from_city} → ${t.to_city}</div>
      <div>${day(t.board_at)} ${time(t.board_at)} · ${t.plate}</div>
      <hr class="rule">
      <div class="c big">${k === 'other' ? (s.luggage.note || 'Other item').toUpperCase() : ONE[k]} ${i + 1} OF ${items.length}</div>
    </div></section>`));
  }
  return out;
}

async function run() {
  const el = $('#slips');
  try {
    const t = await api('/counter/receipt/' + encodeURIComponent(q.get('ref')));
    const seats = t.seats.filter(s => s.active);
    const slips = q.get('each') === '1' && seats.length > 1
      ? seats.map((s, i) => ticketSlip(t, [s], `passenger ${i + 1} of ${seats.length}`))
      : [ticketSlip(t, seats)];
    if (q.get('tags') === '1') slips.push(...luggageTags(t));
    el.innerHTML = slips.join('');
    if (q.get('auto') === '1') setTimeout(() => window.print(), 150);
  } catch (e) {
    el.innerHTML = html`<p class="screen-only">Could not load the ticket: ${e.message}</p>`;
  }
}
$('#again').addEventListener('click', () => window.print());
$('#close').addEventListener('click', () => window.close());
run();
