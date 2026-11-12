// Conductor / station agent app. Works offline: the trip manifest (with each booking's QR payload)
// is stored on the phone, scans are checked locally and queued, and the queue syncs when back online.
import { $, $$, html, raw, api, auth, toast, busy, formData, time } from './core.js';

const app = $('#app');
const local = {
  get(k, d = null) { try { return JSON.parse(localStorage.getItem('mt.agent.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mt.agent.' + k, JSON.stringify(v)); } catch { toast('Phone storage is full. Sync and clear old trips.', true); } },
};
const queue = { all: () => local.get('queue', []), push: c => local.set('queue', [...queue.all(), c]), set: q => local.set('queue', q) };
let stopCamera = null, gpsWatch = null, gpsLast = 0;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
const setNet = () => { const n = $('#net'); const q = queue.all().length; n.textContent = navigator.onLine ? (q ? `Online · ${q} to sync` : 'Online') : `Offline${q ? ` · ${q} queued` : ''}`; n.className = 'net' + (navigator.onLine ? '' : ' off'); };
addEventListener('online', () => { setNet(); sync(); });
addEventListener('offline', setNet);
setInterval(() => navigator.onLine && queue.all().length && sync(), 30000);

$('#logout').addEventListener('click', () => { if (queue.all().length) return toast('Sync your scans before signing out.', true); auth.clear(); start(); });

async function sync() {
  const q = queue.all();
  if (!q.length || !navigator.onLine) return setNet();
  try {
    const r = await api('/agent/sync', { method: 'POST', body: { checkins: q } });
    const done = new Set(r.results.map(x => x.client_id));
    queue.set(queue.all().filter(c => !done.has(c.client_id)));
    const conflicts = r.results.filter(x => x.result !== 'boarded');
    if (conflicts.length) toast(`${conflicts.length} synced scan${conflicts.length > 1 ? 's were' : ' was'} rejected by the server: ${conflicts[0].message || conflicts[0].result}`, true);
    else toast(`Synced ${r.results.length} scan${r.results.length > 1 ? 's' : ''}.`);
  } catch (e) { if (e.status) toast(e.message, true); }
  setNet();
}

function start() {
  setNet();
  stopCamera?.(); stopCamera = null;
  const u = auth.user;
  $('#logout').hidden = !u;
  if (!u || !['conductor', 'clerk', 'operator'].includes(u.role)) return login();
  tripsView();
}

function login() {
  app.innerHTML = html`<div class="page"><h1>Sign in</h1><form class="card" id="f">
    <label class="field"><span>Mobile number</span><input name="phone" inputmode="tel" required></label>
    <label class="field"><span>Password</span><input name="password" type="password" required></label><button class="btn">Sign in</button></form>
    <p class="small muted">For conductors and station staff. Your company owner creates your login under Drivers & staff.</p></div>`;
  const f = $('#f');
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('button'), async () => {
    const r = await api('/auth/login', { method: 'POST', body: formData(f) });
    if (!['conductor', 'clerk', 'operator'].includes(r.user.role)) throw new Error('This app is for bus company staff.');
    auth.set(r.token, r.user); start();
  }); });
}

async function tripsView() {
  let list = local.get('trips');
  try { list = await api('/agent/trips'); local.set('trips', list); } catch (e) { if (e.status) return toast(e.message, true); }
  list = list || [];
  const saved = new Set(Object.keys(localStorage).filter(k => k.startsWith('mt.agent.manifest.')).map(k => Number(k.split('.').pop())));
  app.innerHTML = html`<div class="page"><div class="head"><h1>Today's trips</h1><button class="btn ghost sm" id="sync">Sync now</button></div>
    ${list.length ? list.map(t => html`<button class="card" data-trip="${t.id}" style="text-align:left;cursor:pointer;font:inherit;color:inherit${t.mine ? ';border-color:var(--brand);border-width:2px' : ''}">
      <div class="row" style="justify-content:space-between"><b style="font-size:18px">${t.depart_local} · ${t.route_name}</b><span class="pill ${t.status === 'departed' ? 'ok' : t.status === 'delayed' ? 'warn' : 'idle'}">${t.status}</span></div>
      <span class="small muted">${t.plate} · ${t.class} · ${t.boarded}/${t.booked} boarded${t.mine ? ' · your bus' : ''}${saved.has(t.id) ? ' · saved for offline' : ''}</span></button>`) : raw('<div class="empty">No trips today, or you are offline and nothing is saved.</div>')}
    ${auth.user.role !== 'clerk' ? raw('<a class="btn ghost" href="/#/op/counter">Sell a ticket to a walk-in passenger (needs internet)</a>') : ''}</div>`;
  $('#sync').addEventListener('click', e => busy(e.target, sync));
  app.addEventListener('click', e => { const b = e.target.closest('[data-trip]'); if (b) tripView(Number(b.dataset.trip)); }, { once: true });
}

async function tripView(id) {
  let m = local.get('manifest.' + id);
  try { m = await api(`/agent/trips/${id}/manifest`); local.set('manifest.' + id, m); }
  catch (e) { if (e.status) return toast(e.message, true); if (!m) return toast('You are offline and this trip was not saved on the phone.', true); }
  const boardedLocal = new Set(queue.all().filter(c => c.trip_id === id).map(c => c.ref));
  const isBoarded = s => s.boarded_at || boardedLocal.has(s.ref);
  const draw = () => {
    const total = m.seats.length, on = m.seats.filter(isBoarded).length;
    app.innerHTML = html`<div class="page">
      <div><button class="btn ghost sm" id="back">← Trips</button></div>
      <div class="head"><div><h2>${m.trip.depart_local} · ${m.trip.stops[0].city} → ${m.trip.stops.at(-1).city}</h2><span class="small muted">Manifest saved ${time(m.downloaded_at)} · works offline</span></div><b style="font-size:22px">${on}/${total}</b></div>
      <div class="card"><div id="res" class="result" hidden></div><video id="v" playsinline muted hidden></video>
        <div class="bigbtns"><button class="btn copper" id="cam">Scan QR code</button><button class="btn ghost" id="manual">Type reference</button></div></div>
      <div class="card"><h3>Trip status</h3><p class="small muted" style="margin:0">Passengers get an SMS for each change. Needs internet.</p>
        <div class="bigbtns"><button class="btn" data-st="boarding">Boarding</button><button class="btn" data-st="departed">Departed</button><button class="btn ghost" data-st="delayed">Delayed…</button><button class="btn ghost" data-st="arrived">Arrived</button></div>
        <label class="chip" style="justify-self:start"><input type="checkbox" id="gps" ${gpsWatch ? 'checked' : ''}>Share this phone's location for live tracking</label></div>
      <div class="card"><h3>Passengers</h3>${m.seats.map(s => html`<div class="pax"><span class="seatno">${s.seat_no}</span><span><b>${s.passenger_name}</b>${s.is_child ? ' (child)' : ''}<br><span class="small muted">${s.id_type} ${s.id_number} · to ${s.to_city} · ${s.ref}${s.status === 'reserved' ? ' · UNPAID' : ''}</span></span>
        <span>${isBoarded(s) ? raw('<span class="pill ok">on</span>') : ''}</span></div>`)}</div>
    </div>`;
    $('#back').addEventListener('click', () => { stopCamera?.(); tripsView(); });
    $('#cam').addEventListener('click', () => stopCamera ? (stopCamera(), stopCamera = null, $('#v').hidden = true) : camera(check));
    $('#manual').addEventListener('click', () => { const ref = window.prompt?.('Booking reference (MT…)'); if (ref) check(ref.trim().toUpperCase()); });
    $$('[data-st]').forEach(b => b.addEventListener('click', () => setStatus(b, id)));
    $('#gps').addEventListener('change', e => e.target.checked ? startGps(id) : stopGps());
  };
  const show = (cls, text) => { const r = $('#res'); r.hidden = false; r.className = 'result ' + cls; r.textContent = text; navigator.vibrate?.(cls === 'ok' ? 80 : [60, 60, 60]); };
  async function check(code) {
    const scanned_at = new Date().toISOString();
    const client_id = crypto.randomUUID();
    if (navigator.onLine) {
      try {
        const r = await api(`/agent/trips/${id}/scan`, { method: 'POST', body: { code, client_id, scanned_at } });
        if (r.result === 'boarded') { r.seats.forEach(s => { const x = m.seats.find(y => y.seat_no === s.seat_no); if (x) x.boarded_at = scanned_at; }); local.set('manifest.' + id, m); draw(); show('ok', `Board: seat ${r.seats.map(s => s.seat_no).join(', ')} · ${r.seats[0].passenger_name}. Check ${r.seats[0].id_type}.`); }
        else { draw(); show(r.result === 'duplicate' ? 'warn' : 'bad', r.message); }
        return;
      } catch (e) { if (e.status) { show('bad', e.message); return; } }
    }
    // Offline: verify against the saved manifest.
    const ref = code.startsWith('MT1|') ? Object.keys(m.codes).find(k => m.codes[k] === code) : (m.codes[code] ? code : null);
    if (!ref) { draw(); return show('bad', code.startsWith('MT1|') ? 'Not a ticket for this bus (or forged).' : `No booking ${code} on this bus.`); }
    const seats = m.seats.filter(s => s.ref === ref);
    if (seats[0]?.status === 'reserved') { draw(); return show('bad', `${ref} is not paid. Send them to the counter.`); }
    if (seats.every(isBoarded)) { draw(); return show('warn', `Already boarded: ${ref}.`); }
    queue.push({ client_id, trip_id: id, code, ref, scanned_at });
    boardedLocal.add(ref); setNet(); draw();
    show('ok', `Board (offline): seat ${seats.map(s => s.seat_no).join(', ')} · ${seats[0].passenger_name}. Check ${seats[0].id_type}.`);
  }
  draw();
}

async function setStatus(btn, id) {
  if (!navigator.onLine) return toast('You are offline. Status updates need internet so passengers get the SMS.', true);
  const status = btn.dataset.st;
  let delay_min;
  if (status === 'delayed') { delay_min = Number(window.prompt?.('Delay in minutes', '30')); if (!delay_min) return; }
  await busy(btn, async () => {
    const r = await api(`/agent/trips/${id}/status`, { method: 'POST', body: { status, delay_min } });
    toast(`Marked ${r.status}. ${r.notified} booking${r.notified === 1 ? '' : 's'} notified.`);
    if (status === 'departed' && !gpsWatch) startGps(id);
    if (status === 'arrived') stopGps();
  });
}

function startGps(id) {
  if (!navigator.geolocation) return toast('This phone cannot share location.', true);
  gpsWatch = navigator.geolocation.watchPosition(p => {
    if (Date.now() - gpsLast < 60000 || !navigator.onLine) return;
    gpsLast = Date.now();
    api(`/agent/trips/${id}/position`, { method: 'POST', body: { lat: p.coords.latitude, lng: p.coords.longitude } }).catch(() => {});
  }, () => toast('Location permission was refused. Passengers will see the timetable estimate.', true), { enableHighAccuracy: true, maximumAge: 30000 });
  toast('Sharing location every minute while this app is open.');
}
function stopGps() { if (gpsWatch != null) navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; }

async function camera(onCode) {
  const v = $('#v');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
  catch { return toast('Camera not available. Type the reference instead.', true); }
  v.hidden = false; v.srcObject = stream; await v.play();
  const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  let running = true, last = '', lastAt = 0;
  const loop = async () => {
    if (!running) return;
    let text = null;
    try {
      if (detector) text = (await detector.detect(v))[0]?.rawValue;
      else if (v.videoWidth) {
        canvas.width = v.videoWidth; canvas.height = v.videoHeight; ctx.drawImage(v, 0, 0);
        text = window.jsQR?.(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data;
      }
    } catch {}
    if (text && (text !== last || Date.now() - lastAt > 4000)) { last = text; lastAt = Date.now(); await onCode(text); }
    setTimeout(loop, 250);
  };
  loop();
  stopCamera = () => { running = false; stream.getTracks().forEach(t => t.stop()); };
}

start();
