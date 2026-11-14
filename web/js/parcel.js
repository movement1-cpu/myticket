// Public parcel tracking: status, history, and the bus live on a map while it carries the parcel.
import { $, html, raw, api, time, day, pill, phoneFmt } from './core.js';

const f = $('#f'), out = $('#out');
const STEPS = [['registered', 'Received at the office'], ['loaded', 'Loaded on the bus'], ['departed', 'On the way'], ['unloaded', 'Arrived, ready to collect'], ['collected', 'Collected']];
const LABEL = { registered: 'Received at the office', loaded: 'Loaded on the bus', departed: 'Bus departed', bus_arrived: 'Bus arrived', unloaded: 'Unloaded at the destination office',
  found: 'Found and unloaded', collected: 'Collected by the receiver', reassigned: 'Moved to another bus', alert: 'Needs attention', cancelled: 'Cancelled' };
let map = null, marker = null, timer = null;

f.addEventListener('submit', e => { e.preventDefault(); const c = f.c.value.trim().toUpperCase(); history.replaceState(null, '', `?c=${encodeURIComponent(c)}`); show(c); });

async function show(code) {
  clearInterval(timer);
  try {
    const p = await api('/parcels/track/' + encodeURIComponent(code));
    const done = new Set(p.events.map(e => e.event === 'found' ? 'unloaded' : e.event));
    out.innerHTML = html`<div class="page">
      <div class="card"><div class="head"><div><span class="label">Tracking code</span><div class="mono" style="font-size:20px;font-weight:700">${p.code}</div></div>${pill(p.status === 'in_transit' ? 'departed' : p.status === 'missing' ? 'delayed' : p.status)}</div>
        <div class="kv"><div><span class="label">From → To</span><b>${p.from_city} → ${p.to_city}</b></div><div><span class="label">Bus</span><b class="mono">${p.plate || '—'}</b><span class="small">${p.depart_at ? `${day(p.depart_at)} ${time(p.depart_at)}` : ''}</span></div>
          <div><span class="label">Pieces</span><b>${p.pieces} · ${p.weight_kg} kg</b></div><div><span class="label">Company</span><b>${p.operator}</b></div></div>
        <div class="row" style="gap:4px">${STEPS.map(([k, l]) => html`<span class="tag" style="${done.has(k) ? 'background:var(--brand);color:var(--brand-ink);border-color:var(--brand)' : ''}">${done.has(k) ? '✓ ' : ''}${l}</span>`)}</div>
        ${p.status === 'missing' ? html`<div class="notice">The company is checking where this parcel is. They have been alerted.${p.operator_phone ? html` You can call them on <b class="mono">${phoneFmt(p.operator_phone)}</b>.` : ''}</div>` : ''}
        ${p.status === 'arrived' ? raw('<div class="notice ok">Ready to collect. Bring your ID and the collection code from your SMS.</div>') : ''}</div>
      ${p.live ? html`<div class="card"><div class="head"><h3>Where the bus is now</h3><span class="small muted" id="src"></span></div><div id="map" class="map" style="height:320px"></div></div>` : ''}
      <div class="card"><h3>History</h3><div class="tablewrap"><table><tbody>${p.events.slice().reverse().map(e => html`<tr><td class="small num">${day(e.created_at.replace(' ', 'T') + 'Z')} ${time(e.created_at.replace(' ', 'T') + 'Z')}</td>
        <td><b>${LABEL[e.event] || e.event}</b>${e.note ? html`<div class="small muted">${e.note}</div>` : ''}</td><td class="small">${e.city || ''}${e.plate ? html` · <span class="mono">${e.plate}</span>` : ''}</td></tr>`)}</tbody></table></div></div>
    </div>`;
    map = null; marker = null;
    if (p.live) { drawMap(p.live); timer = setInterval(async () => { try { const n = await api('/parcels/track/' + encodeURIComponent(code)); if (n.live) drawMap(n.live); } catch {} }, 30000); }
  } catch (e) {
    out.innerHTML = html`<div class="notice bad">${e.message}</div>`;
  }
}

function drawMap(live) {
  const L = window.L;
  if (!L || !$('#map')) return;
  if (!map) {
    map = L.map($('#map'), { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(map);
    const pts = live.stops.map(s => [s.lat, s.lng]);
    L.polyline(pts, { color: '#146b3a', weight: 4, opacity: .7 }).addTo(map);
    map.fitBounds(pts, { padding: [24, 24] });
  }
  const icon = L.divIcon({ className: '', html: `<div style="background:#b8611c;color:#fff;border-radius:6px;padding:2px 6px;font:700 12px sans-serif;white-space:nowrap">${live.plate}</div>` });
  marker ? marker.setLatLng([live.position.lat, live.position.lng]) : (marker = L.marker([live.position.lat, live.position.lng], { icon }).addTo(map));
  $('#src').textContent = live.source === 'gps' ? `Live GPS, ${time(live.updated_at)}` : 'Estimated from the timetable';
}

const c = new URLSearchParams(location.search).get('c');
if (c) { f.c.value = c; show(c.toUpperCase()); }
