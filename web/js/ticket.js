import { $, html, raw, api, kwacha, dateTime, pill } from './core.js';

const q = new URLSearchParams(location.search);
const ref = q.get('ref'), k = q.get('k');
const el = $('#t');

async function load() {
  try {
    const t = await api(`/tickets/${encodeURIComponent(ref)}?k=${encodeURIComponent(k || '')}`);
    const seats = t.seats.filter(s => s.active);
    el.innerHTML = html`<div class="page">
      <article class="ticket">
        <div class="body">
          <div class="row" style="justify-content:space-between">${pill(t.status)}<span class="small muted">${t.operator_name}</span></div>
          <div class="route">${t.from_city} <span class="muted">→</span> ${t.to_city}</div>
          ${t.trip_status === 'delayed' ? html`<div class="notice">This bus is running about ${t.delay_min} minutes late.</div>` : ''}
          ${t.trip_status === 'cancelled' ? raw('<div class="notice bad">This trip was cancelled by the operator. A full refund is on its way.</div>') : ''}
          <div class="kv">
            <div><span class="label">Boarding</span><b>${dateTime(t.board_at)}</b><span class="small">${t.from_terminal} · <a href="https://www.google.com/maps?q=${t.from_lat},${t.from_lng}" target="_blank" rel="noopener">map</a></span></div>
            <div><span class="label">Arrival (planned)</span><b>${dateTime(t.arrive_at)}</b><span class="small">${t.to_terminal}</span></div>
            <div><span class="label">Bus</span><b>${t.class}</b><span class="mono">${t.plate}</span></div>
            <div><span class="label">Paid</span><b>${kwacha(t.total)}</b><span class="small muted">${t.payment_method || ''}</span></div>
          </div>
          <div class="tablewrap"><table><thead><tr><th>Seat</th><th>Passenger</th><th>ID</th><th></th></tr></thead><tbody>
            ${seats.map(s => html`<tr><td class="mono">${s.seat_no}</td><td>${s.passenger_name}${s.is_child ? ' (child)' : ''}</td><td class="mono">${s.id_type} ${s.id_number}</td><td>${s.boarded_at ? raw('<span class="pill ok">boarded</span>') : ''}</td></tr>`)}
          </tbody></table></div>
          <p class="small muted" style="margin:0">Be at the boarding point 30 minutes early with the ID above. The QR code works once at the gate.</p>
          <div class="row no-print">
            ${t.qr_svg ? html`<a class="btn" href="/api/tickets/${t.ref}/pdf?k=${k}">Download PDF</a>` : ''}
            ${['confirmed'].includes(t.status) ? html`<a class="btn ghost" href="/#/track/${t.trip_id}">Track bus</a>` : ''}
          </div>
        </div>
        <div class="stub">
          ${t.qr_svg ? raw(t.qr_svg) : raw('<div class="empty small">QR appears once payment is confirmed.</div>')}
          <span class="label">Booking reference</span><span class="mono" style="font-size:20px;font-weight:700">${t.ref}</span>
        </div>
      </article>
    </div>`;
  } catch (e) {
    el.innerHTML = html`<div class="notice bad">${e.message}</div>`;
  }
}
load();
setInterval(load, 60000); // pick up delays, boarding status and cancellations
