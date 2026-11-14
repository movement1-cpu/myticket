// Family view of a shared trip: where the bus is and when it arrives. No passenger details.
import { $, html, raw, api, time, day, pill, phoneFmt } from './core.js';

const token = new URLSearchParams(location.search).get('s') || '';
const el = $('#t');
let map = null, marker = null;

async function load() {
  try {
    const d = await api('/shared/' + encodeURIComponent(token));
    const dest = d.stops.find(s => s.city === d.to.city && !s.passed) || d.stops.at(-1);
    if (!map) {
      el.innerHTML = html`<div class="page">
        <div class="head"><div><h1>${d.from.city} → ${d.to.city}</h1><span class="muted">${d.operator} · bus ${d.plate}</span></div><span id="st"></span></div>
        <div class="kpis"><div class="kpi"><span class="label">Arrives at ${d.to.name}</span><b id="eta"></b><span class="small muted" id="src"></span></div></div>
        <div id="map" class="map"></div>
        <div class="card"><h3>Stops</h3><div id="stops" class="stoplist"></div></div>
        ${d.operator_phone ? html`<div class="notice">Worried? Call ${d.operator}'s 24-hour line: <b class="mono">${phoneFmt(d.operator_phone)}</b></div>` : ''}
        <p class="small muted" style="margin:0">This link stops working after the trip (${day(d.expires_at)} ${time(d.expires_at)}). The traveller can stop sharing at any time.</p></div>`;
      const L = window.L;
      map = L.map($('#map'), { scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(map);
      const pts = d.stops.map(s => [s.lat, s.lng]);
      L.polyline(pts, { color: '#146b3a', weight: 4, opacity: .7 }).addTo(map);
      map.fitBounds(pts, { padding: [30, 30] });
    }
    $('#st').innerHTML = String(pill(d.status));
    $('#eta').textContent = dest?.eta ? time(dest.eta) : dest ? `${time(dest.planned)} (planned)` : '—';
    $('#src').textContent = d.source === 'gps' ? `Live GPS, updated ${time(d.updated_at)}` : 'Estimated from the timetable';
    const icon = window.L.divIcon({ className: '', html: '<div style="background:#b8611c;color:#fff;border-radius:6px;padding:2px 6px;font:700 12px sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.4)">BUS</div>' });
    marker ? marker.setLatLng([d.position.lat, d.position.lng]) : (marker = window.L.marker([d.position.lat, d.position.lng], { icon }).addTo(map));
    $('#stops').innerHTML = d.stops.map(s => html`<div class="${s.passed ? 'passed' : ''}"><span class="dot"></span><span><b>${s.city}</b><br><span class="small muted">${s.terminal}</span></span>
      <span class="num small" style="text-align:right">${s.passed ? 'passed' : s.eta ? `ETA ${time(s.eta)}` : time(s.planned)}</span></div>`).join('');
  } catch (e) {
    el.innerHTML = html`<div class="page" style="max-width:520px;margin:0 auto"><div class="notice">${e.message}</div></div>`;
    clearInterval(timer);
  }
}
const timer = setInterval(load, 20000);
load();
