import { $, $$, html, raw, esc, api, auth, toast, modal, busy, formData, fileToUpload, kwacha, kw0, time, day, dayOf, dateTime, today, plusDays, pill, download, openBlob, bars, meter, phoneFmt } from './core.js';
import { seatPicker } from './seatmap.js';
import { luggageFields, bindLuggage, readLuggage, KINDS } from './luggage.js';

const SECTIONS = [
  ['dashboard', 'Dashboard', ['operator']],
  ['trips', 'Trips & manifests', ['operator', 'clerk', 'conductor']],
  ['counter', 'Station terminal', ['operator', 'clerk', 'conductor']],
  ['parcels', 'Parcels', ['operator', 'clerk']],
  ['fleet', 'Fleet', ['operator']],
  ['staff', 'Drivers & staff', ['operator']],
  ['maintenance', 'Maintenance', ['operator']],
  ['routes', 'Routes & stops', ['operator']],
  ['schedules', 'Timetable', ['operator']],
  ['pricing', 'Fares & promos', ['operator']],
  ['reviews', 'Reviews', ['operator']],
  ['finance', 'Revenue & payouts', ['operator']],
  ['cash', 'Cash & shifts', ['operator']],
  ['company', 'Company & verification', ['operator']],
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export async function render(app, section, arg) {
  const u = auth.user;
  const allowed = SECTIONS.filter(s => s[2].includes(u.role));
  if (!allowed.some(s => s[0] === section)) { location.hash = `#/op/${allowed[0][0]}`; return; }
  app.innerHTML = html`<div class="shell">
    <nav class="side no-print" aria-label="Company sections"><span class="label">${u.operator_name}</span>
      ${allowed.map(([k, l]) => html`<a href="#/op/${k}" class="${k === section ? 'on' : ''}">${l}</a>`)}
      ${u.role !== 'clerk' ? raw('<a href="/agent.html">Open field app ↗</a>') : ''}</nav>
    <div class="main" id="main"><div class="empty"><span class="spinner"></span></div></div></div>`;
  const main = $('#main', app);
  if (u.operator_status && u.operator_status !== 'approved' && section !== 'company') {
    main.innerHTML = html`<div class="notice">${u.operator_status === 'suspended' ? 'This company is suspended. Contact the platform team.' : 'Your company is awaiting verification. Upload your documents under Company & verification.'}</div>`;
    return;
  }
  try { return await VIEWS[section](main, arg); }
  catch (e) { main.innerHTML = html`<div class="notice bad">${e.message}</div>`; }
}

/* ---------- dashboard ---------- */
async function dashboard(main) {
  const [fin, trips, maint] = await Promise.all([api('/operator/finance?days=30'), api('/operator/trips?date=' + today()), api('/operator/maintenance')]);
  const urgent = maint.due.filter(d => d.severity !== 'missing');
  const sold = trips.reduce((a, t) => a + t.booked, 0), cap = trips.reduce((a, t) => a + t.capacity, 0);
  const gross = fin.daily.reduce((a, d) => a + d.gross, 0), net = fin.daily.reduce((a, d) => a + d.gross - d.commission, 0);
  main.innerHTML = html`<div class="head"><h1>Today, ${dayOf(today())}</h1><a class="btn" href="#/op/counter">Sell a ticket</a></div>
    ${urgent.length ? html`<a class="notice ${urgent.some(d => d.severity === 'overdue') ? 'bad' : ''}" href="#/op/maintenance" style="color:inherit;text-decoration:none;display:block"><b>Maintenance: ${urgent.length} item${urgent.length > 1 ? 's' : ''} need attention.</b> ${urgent.slice(0, 3).map(d => d.text).join(' · ')}${urgent.length > 3 ? ' …' : ''}</a>` : ''}
    <div class="kpis">
      <div class="kpi"><span class="label">Departures today</span><b>${trips.length}</b><span class="small muted">${trips.filter(t => t.status === 'departed').length} on the road</span></div>
      <div class="kpi"><span class="label">Seats sold today</span><b>${sold}</b><span class="small muted">${cap ? Math.round(sold / cap * 100) : 0}% of ${cap}</span></div>
      <div class="kpi"><span class="label">Fares, last 30 days</span><b>${kw0(gross)}</b><span class="small muted">${kw0(net)} after commission</span></div>
      <div class="kpi"><span class="label">Available to withdraw</span><b>${kw0(fin.balance.available)}</b><span class="small muted">${kw0(fin.balance.pending)} on upcoming trips</span></div>
    </div>
    <div class="card"><h3>Daily fares, last 30 days</h3>${raw(bars(fin.daily.map(d => ({ label: dayOf(d.day), value: d.gross })), { fmt: kw0 }))}</div>
    <div class="card"><h3>Today's departures</h3>${tripTable(trips, true)}</div>
    <div class="card"><h3>Occupancy by route, 30 days</h3><div class="tablewrap"><table><thead><tr><th>Route</th><th class="r">Trips</th><th>Full</th></tr></thead><tbody>
        ${fin.routes.map(r => html`<tr><td>${r.name}</td><td class="r num">${r.trips}</td><td style="min-width:140px">${raw(meter(r.occupancy))}</td></tr>`)}</tbody></table></div></div>`;
}
function tripTable(trips, compact = false) {
  if (!trips.length) return '<div class="empty">No departures on this date.</div>';
  return html`<div class="tablewrap"><table><thead><tr><th>Time</th><th>Route</th><th>Bus</th>${compact ? '' : raw('<th>Crew</th>')}<th class="r">Booked</th><th class="r">Boarded</th><th>Status</th>${compact ? '' : raw('<th></th>')}</tr></thead><tbody>
    ${trips.map(t => html`<tr><td class="num"><b>${t.depart_local}</b>${t.delay_min ? html`<br><span class="small" style="color:var(--warn)">+${t.delay_min} min</span>` : ''}</td><td>${t.route_name}</td><td><span class="mono">${t.plate}</span><br><span class="small muted">${t.class}</span>${t.blockers?.length ? html`<br><span class="pill bad" title="Fix before departure">${t.blockers.join(', ')}</span>` : ''}</td>
      ${compact ? '' : html`<td class="small">${t.driver_name || raw('<span style="color:var(--bad)">No driver</span>')}<br>${t.conductor_name || raw('<span class="muted">No conductor</span>')}</td>`}
      <td class="r num">${t.booked}/${t.capacity}${t.waiting ? html`<br><span class="small" style="color:var(--warn)">+${t.waiting} waiting</span>` : ''}</td><td class="r num">${t.boarded}</td><td>${pill(t.status)}</td>
      ${compact ? '' : html`<td><div class="row" style="gap:4px;flex-wrap:nowrap"><button class="btn sm" data-manifest="${t.id}">Manifest</button><button class="btn ghost sm" data-status="${t.id}">Status</button>${auth.user.role === 'operator' ? html`<button class="btn ghost sm" data-crew="${t.id}">Crew</button>` : ''}</div></td>`}</tr>`)}
  </tbody></table></div>`;
}

/* ---------- trips & manifests ---------- */
async function trips(main, date = today()) {
  const list = await api('/operator/trips?date=' + date);
  main.innerHTML = html`<div class="head"><h1>Trips</h1><div class="row"><button class="btn ghost sm" id="prev">←</button><input type="date" id="d" value="${date}" style="width:auto"><button class="btn ghost sm" id="next">→</button></div></div>${raw(tripTable(list))}<div id="manifest"></div>`;
  const go = d => trips(main, d);
  $('#d', main).addEventListener('change', e => go(e.target.value));
  $('#prev', main).addEventListener('click', () => go(plusDays(date, -1)));
  $('#next', main).addEventListener('click', () => go(plusDays(date, 1)));
  main.addEventListener('click', async e => {
    const m = e.target.closest('[data-manifest]'), s = e.target.closest('[data-status]'), c = e.target.closest('[data-crew]');
    if (m) showManifest(main, Number(m.dataset.manifest));
    if (s) statusDialog(list.find(t => t.id === Number(s.dataset.status)), () => go(date));
    if (c) crewDialog(list.find(t => t.id === Number(c.dataset.crew)), () => go(date));
  });
}
async function showManifest(main, id, full = false) {
  const { trip, passengers, luggage_totals } = await api(`/operator/trips/${id}/manifest${full ? '?full=1' : ''}`);
  const lugTotal = Object.values(luggage_totals).reduce((a, b) => a + b, 0);
  const box = $('#manifest', main);
  box.innerHTML = html`<div class="card">
    <div class="head"><div><h2>Passenger manifest</h2><span class="muted">${trip.operator_name} · ${trip.route_name} · ${trip.depart_local} · ${trip.plate}</span></div>
      <div class="row no-print">${full ? raw('<span class="pill warn">Full ID numbers shown · this viewing is logged</span>') : raw('<button class="btn ghost sm" id="fullids">Show full IDs for checkpoint</button>')}<button class="btn ghost sm" id="csv">Download CSV</button><button class="btn sm" id="print">Print</button></div></div>
    <div class="grid3 small"><div><span class="label">Driver</span><br>${trip.driver_name || '—'} ${trip.licence_no ? `(${trip.licence_no})` : ''}</div><div><span class="label">Conductor</span><br>${trip.conductor_name || '—'}</div><div><span class="label">Passengers</span><br>${passengers.length} (${passengers.filter(p => p.boarded_at).length} boarded)</div></div>
    <div class="notice ok small"><b>Luggage in the hold: ${lugTotal} item${lugTotal === 1 ? '' : 's'}</b> from ${passengers.filter(p => p.luggage.has).length} passenger${passengers.filter(p => p.luggage.has).length === 1 ? '' : 's'} ·
      ${KINDS.filter(([k]) => luggage_totals[k]).map(([k, l]) => `${luggage_totals[k]} ${l.toLowerCase()}`).join(', ') || 'none'}</div>
    <div class="tablewrap"><table><thead><tr><th>Seat</th><th>Passenger</th><th>ID</th><th>Phone</th><th>From → To</th><th>Luggage</th><th>Booking</th><th>Boarded</th></tr></thead><tbody>
      ${passengers.map(p => html`<tr><td class="mono">${p.seat_no}</td><td>${p.passenger_name}${p.is_child ? ' (child)' : ''}${p.gender ? ` · ${p.gender}` : ''}</td><td class="mono">${p.id_type} ${p.id_number}</td><td class="num">${phoneFmt(p.contact_phone)}</td>
        <td class="small">${p.from_city} → ${p.to_city}</td><td class="small">${p.luggage.has ? p.luggage.text : '—'}</td><td class="mono">${p.ref}${p.status === 'reserved' ? raw(' <span class="pill warn">unpaid</span>') : ''}</td><td>${p.boarded_at ? '✓' : ''}</td></tr>`)}
    </tbody></table></div></div>`;
  $('#csv', box).addEventListener('click', e => busy(e.target, () => download(`/operator/trips/${id}/manifest?format=csv`, `manifest-${trip.service_date}-${trip.plate.replace(/\s/g, '')}.csv`)));
  $('#fullids', box)?.addEventListener('click', () => showManifest(main, id, true));
  // Printing is for police and border checkpoints, so it uses full ID numbers (logged).
  $('#print', box).addEventListener('click', async () => { if (!full) { await showManifest(main, id, true); } setTimeout(() => window.print(), 300); });
  if (!full) box.scrollIntoView({ behavior: 'smooth' });
}
function statusDialog(t, done) {
  const next = { scheduled: ['boarding', 'delayed', 'cancelled'], boarding: ['departed', 'delayed', 'cancelled'], delayed: ['boarding', 'departed', 'delayed', 'cancelled'], departed: ['arrived', 'delayed'] }[t.status] || [];
  const m = modal(html`<h2>${t.route_name}, ${t.depart_local}</h2><p class="muted" style="margin:0">Passengers get an SMS and WhatsApp message for each change.${auth.user.role === 'operator' ? ' Cancelling refunds every passenger in full.' : ''}</p>
    ${next.length ? html`<form id="sf" class="page" style="gap:10px"><div class="chips">${next.filter(s => s !== 'cancelled' || auth.user.role === 'operator').map((s, i) => html`<label class="chip"><input type="radio" name="status" value="${s}" ${i ? '' : 'checked'}>${s}</label>`)}</div>
      <label class="field" style="max-width:200px"><span>Delay in minutes (for delayed)</span><input name="delay_min" type="number" min="0" max="1440" value="30"></label>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Close</button><button class="btn">Update and notify</button></div></form>` : raw('<div class="empty">This trip is finished.</div>')}`);
  const f = $('#sf', m.el);
  f?.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { const r = await api(`/agent/trips/${t.id}/status`, { method: 'POST', body: formData(f) }); m.close(); toast(`Marked ${r.status}. ${r.notified} booking${r.notified === 1 ? '' : 's'} notified${r.refunded ? `, ${r.refunded} refunded` : ''}.`); done(); }); });
}
async function crewDialog(t, done) {
  const staff = await api('/operator/staff');
  const opts = (role, cur) => html`<option value="">—</option>${staff.filter(s => s.role === role && s.active).map(s => html`<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${s.name}</option>`)}`;
  const m = modal(html`<h2>Crew for ${t.route_name}, ${t.depart_local}</h2><form id="cf" class="grid2"><label class="field"><span>Driver</span><select name="driver_id">${opts('driver', t.driver_id)}</select></label>
    <label class="field"><span>Conductor</span><select name="conductor_id">${opts('conductor', t.conductor_id)}</select></label><div></div><div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save</button></div></form>`);
  const f = $('#cf', m.el);
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { const v = formData(f); await api(`/operator/trips/${t.id}/crew`, { method: 'PUT', body: { driver_id: Number(v.driver_id) || null, conductor_id: Number(v.conductor_id) || null } }); m.close(); toast('Crew saved.'); done(); }); });
}

/* ---------- station terminal: counter / walk-in sales on the same live seat inventory ---------- */
const PRINTER_KEY = 'mt.printer';
const printer = {
  get() { try { return { w: '58', auto: true, tags: true, each: false, ...JSON.parse(localStorage.getItem(PRINTER_KEY)) }; } catch { return { w: '58', auto: true, tags: true, each: false }; } },
  set(v) { try { localStorage.setItem(PRINTER_KEY, JSON.stringify(v)); } catch {} },
};
/** Print a ticket on the thermal printer through a hidden frame (no pop-up window needed). */
export function printTicket(ref, opts = printer.get()) {
  const qs = new URLSearchParams({ ref, w: opts.w, tags: opts.tags ? '1' : '0', each: opts.each ? '1' : '0', auto: '1' });
  const f = document.createElement('iframe');
  f.title = 'Ticket print';
  f.style.cssText = 'position:fixed;left:-10000px;top:0;width:80mm;height:200mm;border:0';
  f.src = '/print.html?' + qs;
  document.body.append(f);
  setTimeout(() => f.remove(), 120000);
  try { localStorage.setItem('mt.lastPrinted', ref); } catch {}
}

async function counter(main) {
  let picker = null, trip = null, stops = [];
  const date = today();
  const pr = printer.get();
  let last = null; try { last = localStorage.getItem('mt.lastPrinted'); } catch {}
  main.innerHTML = html`<div class="head"><h1>Station terminal</h1>
      <div class="row">${last ? html`<button class="btn ghost" id="reprint">Reprint ${last}</button>` : ''}</div></div>
    <details class="card" id="pset"><summary><b>Ticket printer</b> <span class="small muted">· ${pr.w} mm paper${pr.auto ? ' · prints after each sale' : ''}${pr.tags ? ' · luggage tags' : ''}</span></summary>
      <div class="row">
        <label class="field" style="max-width:200px"><span>Paper roll</span><select id="pw"><option value="58" ${pr.w === '58' ? 'selected' : ''}>58 mm (small)</option><option value="80" ${pr.w === '80' ? 'selected' : ''}>80 mm (wide)</option></select></label>
        <label class="chip"><input type="checkbox" id="pauto" ${pr.auto ? 'checked' : ''}>Print automatically after each sale</label>
        <label class="chip"><input type="checkbox" id="ptags" ${pr.tags ? 'checked' : ''}>Print a tag for each luggage item</label>
        <label class="chip"><input type="checkbox" id="peach" ${pr.each ? 'checked' : ''}>One slip per passenger</label>
      </div>
      <p class="small muted" style="margin:0">Set the thermal printer as this computer's default printer. To print without the print dialog every time, start Chrome with <span class="mono">--kiosk-printing</span>.</p></details>
    <div class="card" id="shiftbar"></div>
    <div class="card"><h3>Collect payment for a reservation or reprint a ticket</h3><form id="lk" class="row"><label class="field" style="max-width:260px"><span>Booking reference</span><input name="ref" placeholder="MTXXXXXX" style="text-transform:uppercase" required></label><button class="btn ghost">Look up</button></form><div id="lkres"></div></div>
    <div class="card"><h3>Sell to a walk-in passenger</h3>
      <div class="row"><label class="field" style="max-width:180px"><span>Date</span><input type="date" id="cd" value="${date}" min="${date}"></label><label class="field"><span>Departure</span><select id="ct"></select></label></div>
      <div id="sale"></div></div>`;
  const drawShift = async () => {
    const sh = await api('/counter/shift');
    const bar = $('#shiftbar', main);
    if (!sh) {
      bar.innerHTML = html`<div class="head"><div><h3>Cash shift</h3><span class="small muted">Open your shift before taking cash. Count the cash in your drawer first.</span></div>
        <form id="openf" class="row"><label class="field" style="max-width:180px"><span>Starting cash (float), K</span><input name="opening_float" type="number" min="0" step="0.5" required></label><button class="btn">Open shift</button></form></div>`;
      const f = $('#openf', bar);
      f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('button'), async () => { await api('/counter/shift/open', { method: 'POST', body: formData(f) }); toast('Shift open.'); drawShift(); }); });
      return;
    }
    bar.innerHTML = html`<div class="head"><div><h3>Cash shift <span class="pill ok">open</span></h3><span class="small muted">Since ${sh.opened_at.slice(11, 16)} · float ${kwacha(sh.opening_float)}${sh.voids ? ` · ${sh.voids} void${sh.voids > 1 ? 's' : ''}` : ''}</span></div>
      <div class="row" style="align-items:center"><div style="text-align:right"><span class="label">Cash that should be in the drawer</span><div style="font:800 22px var(--f-display)">${kwacha(sh.expected_cash)}</div></div><button class="btn ghost" id="closeshift">Close shift</button></div></div>`;
    $('#closeshift', bar).addEventListener('click', () => {
      const m = modal(html`<h2>Close your shift</h2><p style="margin:0">Count all the cash in the drawer, including the float.</p><form id="cf" class="page" style="gap:10px">
        <label class="field"><span>Cash counted (K)</span><input name="counted_cash" type="number" min="0" step="0.5" required></label>
        <label class="field"><span>Notes (required if the count is different)</span><input name="notes" maxlength="500"></label>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Close shift</button></div></form>`);
      const f = $('#cf', m.el);
      f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => {
        const r = await api('/counter/shift/close', { method: 'POST', body: formData(f) });
        m.el.innerHTML = html`<h2>Shift closed</h2><div class="receipt" style="font-family:var(--f-mono);display:grid;gap:4px">
          <div class="sumrow"><span>Float</span><span>${kwacha(r.opening_float)}</span></div>
          ${Object.entries(r.by_kind).map(([k, v]) => html`<div class="sumrow"><span>${{ sale: 'Ticket sales', settle: 'Reservations paid', parcel: 'Parcel fees', void: 'Voids' }[k]} (${v.n})</span><span>${kwacha(v.total)}</span></div>`)}
          <div class="sumrow total"><span>Expected</span><span>${kwacha(r.expected_cash)}</span></div><div class="sumrow"><span>Counted</span><span>${kwacha(r.counted_cash)}</span></div>
          <div class="sumrow" style="font-weight:800;color:${r.variance ? 'var(--bad)' : 'var(--ok)'}"><span>Difference</span><span>${r.variance > 0 ? '+' : ''}${kwacha(r.variance)}</span></div></div>
          <div class="row no-print" style="justify-content:flex-end"><button class="btn ghost" data-close>Done</button><button class="btn" id="pz">Print</button></div>`;
        $('#pz', m.el).addEventListener('click', () => window.print());
        drawShift();
      }); });
    });
  };
  drawShift();
  const savePrinter = () => { printer.set({ w: $('#pw', main).value, auto: $('#pauto', main).checked, tags: $('#ptags', main).checked, each: $('#peach', main).checked }); toast('Printer settings saved on this computer.'); };
  ['#pw', '#pauto', '#ptags', '#peach'].forEach(id => $(id, main).addEventListener('change', savePrinter));
  $('#reprint', main)?.addEventListener('click', () => { printTicket(last); toast(`Printing ${last}…`); });

  const loadTrips = async () => {
    const list = (await api('/operator/trips?date=' + $('#cd', main).value)).filter(t => !['departed', 'arrived', 'cancelled'].includes(t.status));
    $('#ct', main).innerHTML = '<option value="">Choose a departure</option>' + list.map(t => html`<option value="${t.id}">${t.depart_local} · ${t.route_name} · ${t.plate} · ${t.capacity - t.booked} free</option>`).join('');
  };
  $('#cd', main).addEventListener('change', loadTrips);
  $('#ct', main).addEventListener('change', async e => {
    picker?.destroy();
    if (!e.target.value) { $('#sale', main).innerHTML = ''; return; }
    trip = await api('/trips/' + e.target.value);
    stops = trip.stops;
    $('#sale', main).innerHTML = html`<div class="booking"><div><div class="small muted" style="margin-bottom:6px">${trip.plate} · ${trip.class}. Seats sold here show as booked on the bus and online straight away.</div><div id="smap"></div></div>
      <form id="sf" class="page" style="gap:10px" autocomplete="off">
      <div class="grid2"><label class="field"><span>Boarding</span><select name="from">${stops.filter(s => s.boarding).map(s => html`<option value="${s.id}">${s.city} · ${s.terminal}</option>`)}</select></label>
        <label class="field"><span>Dropping</span><select name="to">${stops.filter(s => s.dropping).reverse().map(s => html`<option value="${s.id}">${s.city} · ${s.terminal}</option>`)}</select></label></div>
      <div id="pax" class="page" style="gap:10px"><div class="empty small">Tap seats on the bus map.</div></div>
      <div class="grid2"><label class="field"><span>Phone for SMS ticket</span><input name="phone" inputmode="tel" required></label><label class="field"><span>Payment</span><select name="pm"><option value="cash">Cash now</option><option value="station">Reserve, pay later at this counter</option></select></label></div>
      <div id="q"></div><button class="btn copper" disabled id="sell">Sell and print ticket</button></form></div>`;
    const f = $('#sf', main);
    const quote = async () => {
      const seats = picker?.seats || [];
      $('#sell', main).disabled = !seats.length;
      if (!seats.length) { $('#q', main).innerHTML = ''; return; }
      const v = formData(f);
      const q = await api('/quote', { method: 'POST', body: { trip_id: trip.id, from_stop_id: Number(v.from), to_stop_id: Number(v.to), passengers: seats.map((_, i) => ({ is_child: !!v['child' + i], luggage: readLuggage(v, i) })) } }).catch(err => { $('#q', main).innerHTML = html`<div class="notice bad small">${err.message}</div>`; return null; });
      if (q) $('#q', main).innerHTML = html`<div class="sumrow total"><span>Collect</span><span class="num">${kwacha(q.total)}</span></div>
        <div class="small muted">Fares ${kwacha(q.fare_total)}${q.luggage_fee ? ` + luggage ${kwacha(q.luggage_fee)}` : ''} + booking fee ${kwacha(q.booking_fee)}</div>`;
    };
    picker = seatPicker($('#smap', main), { tripId: trip.id, onChange: h => {
      const prev = formData(f);
      $('#pax', main).innerHTML = h.seats.length ? h.seats.map((s, i) => html`<div class="card" style="padding:10px;gap:8px">
        <div class="row" style="align-items:center;flex-wrap:nowrap"><span class="seatno" style="min-width:54px">${s}</span><input name="name${i}" placeholder="Passenger full name" value="${prev['name' + i] || ''}" required aria-label="Passenger name, seat ${s}"></div>
        <div class="row" style="align-items:center">
          <select name="idt${i}" aria-label="ID type" style="flex:0 0 110px">${['NRC', 'Passport', 'Other'].map(t => html`<option ${prev['idt' + i] === t ? 'selected' : ''}>${t}</option>`)}</select>
          <input name="idn${i}" placeholder="ID number" value="${prev['idn' + i] || ''}" required aria-label="ID number" style="flex:1 1 140px">
          <select name="g${i}" aria-label="Gender" style="flex:0 0 110px">${[['M', 'Male'], ['F', 'Female'], ['X', 'Other']].map(([g, l]) => html`<option value="${g}" ${prev['g' + i] === g ? 'selected' : ''}>${l}</option>`)}</select>
          <label class="chip"><input type="checkbox" name="child${i}" ${prev['child' + i] ? 'checked' : ''}>Child</label></div>
        ${luggageFields(i, prev)}</div>`).join('') : '<div class="empty small">Tap seats on the bus map.</div>';
      quote();
    } });
    let qt = null;
    const requote = () => { clearTimeout(qt); qt = setTimeout(quote, 250); };
    bindLuggage(f, requote);
    f.addEventListener('change', requote);
    f.addEventListener('submit', ev => {
      ev.preventDefault();
      const v = formData(f);
      busy($('#sell', main), async () => {
        const r = await api('/counter/bookings', { method: 'POST', body: { payment_method: v.pm, contact: { name: v.name0, phone: v.phone },
          legs: [{ trip_id: trip.id, hold_token: picker.token, from_stop_id: Number(v.from), to_stop_id: Number(v.to),
            passengers: picker.seats.map((s, i) => ({ seat_no: s, name: v['name' + i], id_type: v['idt' + i], id_number: v['idn' + i], gender: v['g' + i], is_child: !!v['child' + i], luggage: readLuggage(v, i) })) }] } });
        const ref = r.bookings[0].ref;
        toast(v.pm === 'cash' ? `Sold ${ref}. Collect ${kwacha(r.total)}.` : `Reserved ${ref}. Collect ${kwacha(r.total)} before it expires.`);
        if (printer.get().auto) printTicket(ref); else receipt(ref);
        drawShift();
        $('#ct', main).dispatchEvent(new Event('change'));
        loadTrips().then(() => { $('#ct', main).value = String(trip.id); });
      });
    });
  });
  const lk = $('#lk', main);
  lk.addEventListener('submit', e => { e.preventDefault(); busy(lk.querySelector('button'), async () => {
    const r = await api('/counter/lookup/' + encodeURIComponent(lk.ref.value.trim()));
    const due = r.bookings.filter(b => b.status === 'reserved').reduce((a, b) => a + b.total, 0);
    $('#lkres', main).innerHTML = html`<div class="tablewrap"><table><tbody>${r.bookings.map(b => html`<tr><td class="mono">${b.ref}</td><td>${b.from_city} → ${b.to_city}<br><span class="small muted">${dateTime(b.board_at)}</span></td>
        <td>${b.seats.filter(s => s.active).map(s => html`<div>${s.seat_no} ${s.passenger_name} <span class="small muted">· ${s.luggage.text}</span></div>`)}</td><td>${pill(b.status)}</td><td class="r">${kwacha(b.total)}</td>
        <td><div class="row" style="gap:4px;flex-wrap:nowrap">${['confirmed', 'reserved', 'completed'].includes(b.status) ? html`<button class="btn ghost sm" data-print="${b.ref}">Print</button>` : ''}${b.status === 'confirmed' && b.payment_method === 'cash' && b.channel !== 'web' ? html`<button class="btn danger sm" data-void="${b.ref}">Void</button>` : ''}</div></td></tr>`)}</tbody></table></div>
      ${due ? html`<button class="btn copper" id="settle">Take ${kwacha(due)} cash, confirm and print</button>` : ''}`;
    $('#settle', main)?.addEventListener('click', ev => busy(ev.target, async () => { await api('/counter/settle/' + r.group_ref, { method: 'POST' }); toast('Paid. Ticket sent by SMS.'); r.bookings.forEach(b => printTicket(b.ref)); lk.requestSubmit(); }));
  }); });
  main.addEventListener('click', e => {
    const b = e.target.closest('[data-print]'); if (b) { printTicket(b.dataset.print); toast(`Printing ${b.dataset.print}…`); }
    const v = e.target.closest('[data-void]');
    if (v) {
      const m = modal(html`<h2>Void ${v.dataset.void}</h2><p style="margin:0">Give the passenger all their cash back from your drawer. A supervisor must approve with their PIN. Voids are logged, and the owner is alerted after several in one shift.</p>
        <form id="vf" class="page" style="gap:10px"><label class="field"><span>Reason</span><input name="reason" required maxlength="200" placeholder="e.g. sold the wrong date"></label>
          <div class="grid2"><label class="field"><span>Supervisor's phone</span><input name="supervisor_phone" inputmode="tel" required></label><label class="field"><span>Supervisor PIN</span><input name="supervisor_pin" type="password" inputmode="numeric" maxlength="6" required autocomplete="off"></label></div>
          <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn danger">Void and return cash</button></div></form>`);
      const f = $('#vf', m.el);
      f.addEventListener('submit', ev => { ev.preventDefault(); busy(f.querySelector('.danger'), async () => {
        const r = await api('/counter/void/' + v.dataset.void, { method: 'POST', body: formData(f) });
        m.close(); toast(`Voided. Give back ${kwacha(r.cash_returned)} in cash.`); drawShift(); $('#lk', main).requestSubmit();
      }); });
    }
  });
  await loadTrips();
  return () => picker?.destroy();
}
/** Preview the thermal ticket on screen with a print button (used when automatic printing is off). */
function receipt(ref) {
  const pr = printer.get();
  const qs = new URLSearchParams({ ref, w: pr.w, tags: pr.tags ? '1' : '0', each: pr.each ? '1' : '0' });
  const m = modal(html`<div class="head"><h2>Ticket ${ref}</h2><button class="btn ghost sm" data-close>Close</button></div>
    <iframe src="/print.html?${qs}" title="Ticket preview" style="width:100%;height:60vh;border:1px solid var(--line);border-radius:8px;background:#fff"></iframe>
    <div class="row" style="justify-content:flex-end"><button class="btn" id="pr">Print</button></div>`);
  $('#pr', m.el).addEventListener('click', () => { printTicket(ref); });
}

/* ---------- fleet ---------- */
async function fleet(main) {
  const [buses, layouts, staff, profile] = await Promise.all([api('/operator/buses'), api('/layouts'), api('/operator/staff'), api('/operator/profile')]);
  main.innerHTML = html`<div class="head"><h1>Fleet</h1><button class="btn" id="add">Add bus</button></div>
    <div class="tablewrap"><table><thead><tr><th>Plate</th><th>Class & layout</th><th>Amenities</th><th>Crew</th><th>Status</th><th></th></tr></thead><tbody>
      ${buses.map(b => html`<tr><td><b class="mono">${b.plate}</b><br><span class="small muted">${b.make_model || ''}</span></td><td>${b.class}<br><span class="small muted">${b.layout_name}</span></td>
        <td class="small">${b.amenities.join(', ')}</td><td class="small">${b.driver_name || '—'}<br>${b.conductor_name || '—'}</td><td>${pill(b.status)}</td>
        <td><div class="row" style="gap:4px;flex-wrap:nowrap"><button class="btn ghost sm" data-edit="${b.id}">Edit</button><label class="btn ghost sm">Photo<input type="file" accept="image/*" data-photo="${b.id}" hidden></label></div>${b.photos.length ? html`<span class="small muted">${b.photos.length} photo${b.photos.length > 1 ? 's' : ''}</span>` : ''}</td></tr>`)}
    </tbody></table></div>`;
  const form = (b = {}) => {
    const m = modal(html`<h2>${b.id ? 'Edit ' + b.plate : 'Add a bus'}</h2><form id="bf" class="page" style="gap:10px">
      <div class="grid3"><label class="field"><span>Plate number</span><input name="plate" value="${b.plate || ''}" required></label><label class="field"><span>Make & model</span><input name="make_model" value="${b.make_model || ''}"></label>
        <label class="field"><span>Status</span><select name="status">${['active', 'maintenance', 'retired'].map(s => html`<option ${b.status === s ? 'selected' : ''}>${s}</option>`)}</select></label>
        <label class="field"><span>Chassis number</span><input name="chassis_no" value="${b.chassis_no || ''}"></label><label class="field"><span>Engine number</span><input name="engine_no" value="${b.engine_no || ''}"></label>
        <label class="field"><span>Class</span><select name="class">${profile.classes.map(c => html`<option ${b.class === c ? 'selected' : ''}>${c}</option>`)}</select></label></div>
      <label class="field"><span>Seat layout</span><select name="layout_id">${layouts.map(l => html`<option value="${l.id}" ${b.layout_id === l.id ? 'selected' : ''}>${l.name}</option>`)}</select></label>
      <div class="field"><span>Amenities</span><div class="chips">${profile.amenities.map(a => html`<label class="chip"><input type="checkbox" name="am" value="${a}" ${b.amenities?.includes(a) ? 'checked' : ''}>${a}</label>`)}</div></div>
      <div class="grid2"><label class="field"><span>Default driver</span><select name="driver_id"><option value="">—</option>${staff.filter(s => s.role === 'driver' && s.active).map(s => html`<option value="${s.id}" ${b.driver_id === s.id ? 'selected' : ''}>${s.name}</option>`)}</select></label>
        <label class="field"><span>Default conductor</span><select name="conductor_id"><option value="">—</option>${staff.filter(s => s.role === 'conductor' && s.active).map(s => html`<option value="${s.id}" ${b.conductor_id === s.id ? 'selected' : ''}>${s.name}</option>`)}</select></label></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save bus</button></div></form>`, { wide: true });
    const f = $('#bf', m.el);
    f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => {
      const v = formData(f);
      const body = { ...v, layout_id: Number(v.layout_id), driver_id: Number(v.driver_id) || null, conductor_id: Number(v.conductor_id) || null, amenities: $$('[name=am]:checked', f).map(i => i.value) };
      await api(b.id ? `/operator/buses/${b.id}` : '/operator/buses', { method: b.id ? 'PUT' : 'POST', body });
      m.close(); toast('Bus saved.'); fleet(main);
    }); });
  };
  $('#add', main).addEventListener('click', () => form());
  main.addEventListener('click', e => { const b = e.target.closest('[data-edit]'); if (b) form(buses.find(x => x.id === Number(b.dataset.edit))); });
  main.addEventListener('change', async e => {
    const i = e.target.closest('[data-photo]'); if (!i?.files[0]) return;
    try { await api(`/operator/buses/${i.dataset.photo}/photos`, { method: 'POST', body: { file: await fileToUpload(i.files[0]) } }); toast('Photo uploaded.'); fleet(main); } catch (err) { toast(err.message, true); }
  });
}

/* ---------- staff ---------- */
async function staffView(main) {
  const list = await api('/operator/staff');
  main.innerHTML = html`<div class="head"><h1>Drivers & staff</h1><button class="btn" id="add">Add person</button></div>
    <div class="tablewrap"><table><thead><tr><th>Name</th><th>Role</th><th>Phone</th><th>Licence</th><th>Login</th><th></th></tr></thead><tbody>
      ${list.map(s => html`<tr style="${s.active ? '' : 'opacity:.55'}"><td><b>${s.name}</b></td><td>${s.role}</td><td class="num">${phoneFmt(s.phone)}</td><td class="mono">${s.licence_no || ''}</td><td class="small">${s.login_phone ? 'Field app / counter' : '—'}</td>
        <td><button class="btn ghost sm" data-toggle="${s.id}" data-active="${s.active}">${s.active ? 'Deactivate' : 'Reactivate'}</button></td></tr>`)}
    </tbody></table></div>`;
  $('#add', main).addEventListener('click', () => {
    const m = modal(html`<h2>Add staff</h2><form id="sf" class="page" style="gap:10px"><div class="grid2">
      <label class="field"><span>Full name</span><input name="name" required></label><label class="field"><span>Mobile number</span><input name="phone" inputmode="tel" required></label>
      <label class="field"><span>Role</span><select name="role" id="role"><option value="driver">Driver</option><option value="conductor">Conductor (field app login)</option><option value="clerk">Station clerk (counter login)</option></select></label>
      <label class="field" id="lic"><span>Driver's licence no.</span><input name="licence_no"></label>
      <label class="field" id="pw" hidden><span>Login password (8+ characters)</span><input name="password" type="password" minlength="8" autocomplete="new-password"></label></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Add</button></div></form>`);
    const f = $('#sf', m.el);
    const sync = () => { $('#lic', f).hidden = f.role.value !== 'driver'; $('#pw', f).hidden = f.role.value === 'driver'; };
    f.role.addEventListener('change', sync); sync();
    f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { await api('/operator/staff', { method: 'POST', body: formData(f) }); m.close(); toast('Added.'); staffView(main); }); });
  });
  main.addEventListener('click', e => { const b = e.target.closest('[data-toggle]'); if (b) busy(b, async () => { await api('/operator/staff/' + b.dataset.toggle, { method: 'PUT', body: { active: b.dataset.active !== '1' } }); staffView(main); }); });
}

/* ---------- maintenance & compliance ---------- */
async function maintenance(main) {
  const m = await api('/operator/maintenance');
  const sev = { overdue: 'bad', soon: 'warn', missing: 'idle' };
  const dateCell = d => !d ? raw('<span class="pill idle">not set</span>') : d < today() ? html`<span class="pill bad">${d}</span>` : d <= plusDays(today(), 14) ? html`<span class="pill warn">${d}</span>` : html`<span class="small">${d}</span>`;
  main.innerHTML = html`<div class="head"><h1>Maintenance</h1><button class="btn" id="log">Record work done</button></div>
    <p class="small muted" style="margin:0">Mileage goes up automatically by the route distance after every trip. You get an SMS each morning when something is overdue or due within 14 days or 1,000 km.</p>
    <div class="card"><h3>Needs attention (${m.due.length})</h3>${m.due.length ? html`<div class="page" style="gap:6px">${m.due.map(d => html`<div class="row" style="align-items:center">${pill(d.severity === 'missing' ? 'not set' : d.severity)}<span>${d.text}</span></div>`)}</div>`
      : raw('<div class="empty small">All buses and drivers are up to date.</div>')}</div>
    <div class="card"><h3>Buses</h3><div class="tablewrap"><table><thead><tr><th>Bus</th><th class="r">Odometer</th><th class="r">Next service</th><th>Fitness (RTSA)</th><th>Insurance</th><th>Road tax</th><th></th></tr></thead><tbody>
      ${m.buses.map(b => html`<tr><td><b class="mono">${b.plate}</b><br><span class="small muted">${b.class}${b.last_service_date ? ` · serviced ${b.last_service_date}` : ''}</span></td>
        <td class="r num">${Math.round(b.odometer_km).toLocaleString()} km</td>
        <td class="r num">${b.km_to_service <= 0 ? html`<span class="pill bad">${(-b.km_to_service).toLocaleString()} km overdue</span>` : b.km_to_service <= 1000 ? html`<span class="pill warn">in ${b.km_to_service.toLocaleString()} km</span>` : `in ${b.km_to_service.toLocaleString()} km`}<br><span class="small muted">every ${b.service_interval_km.toLocaleString()} km</span></td>
        <td>${dateCell(b.fitness_expiry)}</td><td>${dateCell(b.insurance_expiry)}</td><td>${dateCell(b.road_tax_expiry)}</td>
        <td><button class="btn ghost sm" data-bus="${b.id}">Edit</button></td></tr>`)}</tbody></table></div></div>
    <div class="card"><h3>Driver licences</h3><div class="tablewrap"><table><thead><tr><th>Driver</th><th>Licence no.</th><th>Expires</th><th></th></tr></thead><tbody>
      ${m.drivers.map(d => html`<tr><td>${d.name}</td><td class="mono">${d.licence_no || ''}</td><td>${dateCell(d.licence_expiry)}</td><td><button class="btn ghost sm" data-driver="${d.id}">Edit</button></td></tr>`)}</tbody></table></div></div>
    <div class="card"><h3>Work log</h3>${m.log.length ? html`<div class="tablewrap"><table><thead><tr><th>Date</th><th>Bus</th><th>Work</th><th class="r">Odometer</th><th class="r">Cost</th><th>Notes</th></tr></thead><tbody>
      ${m.log.map(l => html`<tr><td class="small">${l.done_on}</td><td class="mono">${l.plate}</td><td>${l.kind}</td><td class="r num">${Math.round(l.odometer_km).toLocaleString()}</td><td class="r num">${l.cost ? kwacha(l.cost) : ''}</td><td class="small">${l.notes || ''}</td></tr>`)}</tbody></table></div>` : raw('<div class="empty small">Nothing recorded yet.</div>')}</div>`;
  const reload = () => maintenance(main);
  $('#log', main).addEventListener('click', () => {
    const mo = modal(html`<h2>Record work done</h2><form id="mf" class="grid2">
      <label class="field"><span>Bus</span><select name="bus_id">${m.buses.map(b => html`<option value="${b.id}">${b.plate}</option>`)}</select></label>
      <label class="field"><span>Work</span><select name="kind"><option value="service">Full service (resets the service counter)</option><option value="repair">Repair</option><option value="tyres">Tyres</option><option value="inspection">RTSA inspection</option><option value="other">Other</option></select></label>
      <label class="field"><span>Date</span><input type="date" name="done_on" value="${today()}" max="${today()}" required></label>
      <label class="field"><span>Odometer (km, optional)</span><input type="number" name="odometer_km" min="0" placeholder="Current reading"></label>
      <label class="field"><span>Cost (K, optional)</span><input type="number" name="cost" min="0" step="0.01"></label>
      <label class="field" id="fit" hidden><span>New fitness certificate expiry</span><input type="date" name="fitness_expiry"></label>
      <label class="field" style="grid-column:1/-1"><span>Notes</span><input name="notes" maxlength="500"></label>
      <div class="row" style="justify-content:flex-end;grid-column:1/-1"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save</button></div></form>`, { wide: true });
    const f = $('#mf', mo.el);
    f.kind.addEventListener('change', () => { $('#fit', f).hidden = f.kind.value !== 'inspection'; });
    f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { await api('/operator/maintenance', { method: 'POST', body: formData(f) }); mo.close(); toast('Saved.'); reload(); }); });
  });
  main.addEventListener('click', e => {
    const b = e.target.closest('[data-bus]'), d = e.target.closest('[data-driver]');
    if (b) {
      const bus = m.buses.find(x => x.id === Number(b.dataset.bus));
      const mo = modal(html`<h2>${bus.plate}</h2><form id="cf" class="grid2">
        <label class="field"><span>RTSA certificate of fitness expires</span><input type="date" name="fitness_expiry" value="${bus.fitness_expiry || ''}"></label>
        <label class="field"><span>Insurance expires</span><input type="date" name="insurance_expiry" value="${bus.insurance_expiry || ''}"></label>
        <label class="field"><span>Road tax expires</span><input type="date" name="road_tax_expiry" value="${bus.road_tax_expiry || ''}"></label>
        <label class="field"><span>Service every (km)</span><input type="number" name="service_interval_km" min="1000" step="500" value="${bus.service_interval_km}"></label>
        <label class="field"><span>Odometer correction (km)</span><input type="number" name="odometer_km" min="0" value="${Math.round(bus.odometer_km)}"></label>
        <div class="row" style="justify-content:flex-end;align-self:end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save</button></div></form>`);
      const f = $('#cf', mo.el);
      f.addEventListener('submit', ev => { ev.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { await api(`/operator/buses/${bus.id}/compliance`, { method: 'PUT', body: formData(f) }); mo.close(); toast('Saved.'); reload(); }); });
    }
    if (d) {
      const dr = m.drivers.find(x => x.id === Number(d.dataset.driver));
      const mo = modal(html`<h2>${dr.name}</h2><form id="df" class="grid2"><label class="field"><span>Licence number</span><input name="licence_no" value="${dr.licence_no || ''}"></label>
        <label class="field"><span>Licence expires</span><input type="date" name="licence_expiry" value="${dr.licence_expiry || ''}"></label>
        <div></div><div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save</button></div></form>`);
      const f = $('#df', mo.el);
      f.addEventListener('submit', ev => { ev.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { await api(`/operator/staff/${dr.id}`, { method: 'PUT', body: formData(f) }); mo.close(); toast('Saved.'); reload(); }); });
    }
  });
}

/* ---------- routes & terminals ---------- */
async function routes(main) {
  const [list, terminals] = await Promise.all([api('/operator/routes'), api('/terminals')]);
  main.innerHTML = html`<div class="head"><h1>Routes & stops</h1><div class="row"><button class="btn ghost" id="term">Add a stop location</button><button class="btn" id="add">Build a route</button></div></div>
    ${list.map(r => html`<div class="card"><div class="head"><h3>${r.name}</h3><span class="muted small">${r.distance_km} km · ${Math.floor(r.duration_min / 60)}h ${r.duration_min % 60}m</span></div>
      <div class="tablewrap"><table><thead><tr><th>#</th><th>Stop</th><th class="r">+min</th><th class="r">km</th><th>Pick-up</th><th>Drop-off</th><th></th></tr></thead><tbody>${r.stops.map(s => html`<tr><td>${s.seq}</td><td><b>${s.city}</b> · ${s.terminal} ${s.terminal_kind === 'roadside' ? raw('<span class="tag">roadside</span>') : ''}</td>
        <td class="r num">${s.offset_min}</td><td class="r num">${s.km}</td><td>${s.boarding ? '✓' : ''}</td><td>${s.dropping ? '✓' : ''}</td><td><a href="https://www.google.com/maps?q=${s.lat},${s.lng}" target="_blank" rel="noopener">map</a></td></tr>`)}</tbody></table></div>
      <div><button class="btn ghost sm" data-edit="${r.id}">Edit route</button></div></div>`)}
    ${list.length ? '' : raw('<div class="empty">No routes yet. Build your first route from your stops.</div>')}`;
  const builder = (r = null) => {
    const stops = r ? r.stops.map(s => ({ terminal_id: s.terminal_id, offset_min: s.offset_min, km: s.km })) : [{ terminal_id: '', offset_min: 0, km: 0 }, { terminal_id: '', offset_min: '', km: '' }];
    const m = modal(html`<h2>${r ? 'Edit ' + r.name : 'Build a route'}</h2><p class="small muted" style="margin:0">List stops in travel order. Minutes and km count from the first stop. Fares for part of the route are worked out from the km.</p>
      <form id="rf" class="page" style="gap:10px"><label class="field"><span>Route name (optional)</span><input name="name" value="${r?.name || ''}"></label><div id="rows" class="page" style="gap:6px"></div>
      <div><button type="button" class="btn ghost sm" id="more">Add stop</button></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save route</button></div></form>`, { wide: true });
    const draw = () => { $('#rows', m.el).innerHTML = stops.map((s, i) => html`<div class="row" style="flex-wrap:nowrap"><span class="seatno" style="width:34px">${i + 1}</span>
      <select data-i="${i}" data-k="terminal_id" style="flex:3"><option value="">Choose stop</option>${terminals.map(t => html`<option value="${t.id}" ${t.id === Number(s.terminal_id) ? 'selected' : ''}>${t.city} · ${t.name}</option>`)}</select>
      <input data-i="${i}" data-k="offset_min" type="number" min="0" placeholder="min" value="${s.offset_min}" style="flex:1" aria-label="Minutes from start">
      <input data-i="${i}" data-k="km" type="number" min="0" step="0.1" placeholder="km" value="${s.km}" style="flex:1" aria-label="Kilometres from start">
      <button type="button" class="btn danger sm" data-del="${i}" ${stops.length <= 2 ? 'disabled' : ''}>×</button></div>`).join(''); };
    draw();
    m.el.addEventListener('input', e => { const i = e.target.dataset.i; if (i != null) stops[i][e.target.dataset.k] = e.target.value; });
    m.el.addEventListener('click', e => { const d = e.target.closest('[data-del]'); if (d) { stops.splice(Number(d.dataset.del), 1); draw(); } });
    $('#more', m.el).addEventListener('click', () => { stops.push({ terminal_id: '', offset_min: '', km: '' }); draw(); });
    const f = $('#rf', m.el);
    f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost):not(.sm)'), async () => {
      await api(r ? `/operator/routes/${r.id}` : '/operator/routes', { method: r ? 'PUT' : 'POST', body: { name: f.name.value, stops: stops.map(s => ({ terminal_id: Number(s.terminal_id), offset_min: Number(s.offset_min), km: Number(s.km) })) } });
      m.close(); toast('Route saved.'); routes(main);
    }); });
  };
  $('#add', main).addEventListener('click', () => builder());
  main.addEventListener('click', e => { const b = e.target.closest('[data-edit]'); if (b) builder(list.find(r => r.id === Number(b.dataset.edit))); });
  $('#term', main).addEventListener('click', () => {
    const m = modal(html`<h2>Add a stop location</h2><p class="small muted" style="margin:0">In Google Maps, long-press the exact pick-up spot and copy the coordinates.</p><form id="tf" class="grid2">
      <label class="field"><span>Town / city</span><input name="city" required></label><label class="field"><span>Stop name</span><input name="name" placeholder="e.g. Kafue Bridge turn-off" required></label>
      <label class="field"><span>Latitude</span><input name="lat" inputmode="decimal" placeholder="-15.4246" required></label><label class="field"><span>Longitude</span><input name="lng" inputmode="decimal" placeholder="28.2810" required></label>
      <label class="field"><span>Type</span><select name="kind"><option value="terminal">Bus station / terminal</option><option value="roadside">Roadside stop</option></select></label>
      <div class="row" style="justify-content:flex-end;align-self:end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Add stop</button></div></form>`);
    const f = $('#tf', m.el);
    f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { await api('/terminals', { method: 'POST', body: formData(f) }); m.close(); toast('Stop added.'); routes(main); }); });
  });
}

/* ---------- timetable ---------- */
async function schedules(main) {
  const [list, routesL, buses] = await Promise.all([api('/operator/schedules'), api('/operator/routes'), api('/operator/buses')]);
  main.innerHTML = html`<div class="head"><h1>Timetable</h1><button class="btn" id="add">Add departure</button></div>
    <div class="tablewrap"><table><thead><tr><th>Departs</th><th>Route</th><th>Bus</th><th>Runs</th><th class="r">Full fare</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map(s => html`<tr style="${s.active ? '' : 'opacity:.55'}"><td class="num"><b>${s.depart_time}</b></td><td>${s.route_name}</td><td><span class="mono">${s.plate}</span><br><span class="small muted">${s.class}</span></td>
        <td class="small">${s.one_off ? `One-off on ${dayOf(s.start_date)}` : s.days === '1234567' ? 'Daily' : s.days.split('').map(d => DAYS[d - 1]).join(', ')}${!s.one_off && s.end_date ? ` until ${dayOf(s.end_date)}` : ''}</td>
        <td class="r num">${kw0(s.base_fare)}</td><td>${pill(s.active ? 'active' : 'retired')}</td><td><button class="btn ghost sm" data-edit="${s.id}">Edit</button></td></tr>`)}
    </tbody></table></div>`;
  const form = (s = {}) => {
    const m = modal(html`<h2>${s.id ? 'Edit departure' : 'Add a departure'}</h2><form id="sf" class="page" style="gap:10px"><div class="grid2">
      <label class="field"><span>Route</span><select name="route_id">${routesL.map(r => html`<option value="${r.id}" ${s.route_id === r.id ? 'selected' : ''}>${r.name}</option>`)}</select></label>
      <label class="field"><span>Bus</span><select name="bus_id">${buses.filter(b => b.status !== 'retired').map(b => html`<option value="${b.id}" ${s.bus_id === b.id ? 'selected' : ''}>${b.plate} · ${b.class}</option>`)}</select></label>
      <label class="field"><span>Departure time</span><input type="time" name="depart_time" value="${s.depart_time || '07:00'}" required></label>
      <label class="field"><span>Full-route fare (K)</span><input type="number" name="base_fare" min="1" value="${s.base_fare || ''}" required></label>
      <label class="field"><span>Starts</span><input type="date" name="start_date" value="${s.start_date || today()}" required></label>
      <label class="field"><span>Ends (optional)</span><input type="date" name="end_date" value="${s.one_off ? '' : s.end_date || ''}"></label></div>
      <label class="chip" style="justify-self:start"><input type="checkbox" name="one_off" ${s.one_off ? 'checked' : ''}>One-off trip on the start date (holiday extra)</label>
      <div class="field" id="days"><span>Runs on</span><div class="chips">${DAYS.map((d, i) => html`<label class="chip"><input type="checkbox" name="d" value="${i + 1}" ${(s.days || '1234567').includes(String(i + 1)) ? 'checked' : ''}>${d}</label>`)}</div></div>
      ${s.id ? html`<label class="chip" style="justify-self:start"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}>Active</label>` : ''}
      <p class="small muted" style="margin:0">Fare changes apply to departures with no bookings yet. Passengers who already paid keep their fare.</p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save</button></div></form>`, { wide: true });
    const f = $('#sf', m.el);
    const sync = () => { $('#days', f).hidden = f.one_off.checked; };
    f.one_off.addEventListener('change', sync); sync();
    f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => {
      const v = formData(f);
      const body = { ...v, route_id: Number(v.route_id), bus_id: Number(v.bus_id), base_fare: Number(v.base_fare), one_off: !!v.one_off, days: $$('[name=d]:checked', f).map(i => i.value).join(''), end_date: v.end_date || null, active: s.id ? !!v.active : true };
      await api(s.id ? `/operator/schedules/${s.id}` : '/operator/schedules', { method: s.id ? 'PUT' : 'POST', body });
      m.close(); toast('Timetable saved.'); schedules(main);
    }); });
  };
  $('#add', main).addEventListener('click', () => form());
  main.addEventListener('click', e => { const b = e.target.closest('[data-edit]'); if (b) form(list.find(s => s.id === Number(b.dataset.edit))); });
}

/* ---------- pricing ---------- */
async function pricing(main) {
  const [list, profile] = await Promise.all([api('/operator/pricing'), api('/operator/profile')]);
  const dyn = profile.terms.dynamic;
  const tiers = [...dyn.tiers, {}, {}].slice(0, Math.max(3, dyn.tiers.length));
  const label = { peak: 'Peak surcharge', child: 'Child discount', promo: 'Promo code' };
  main.innerHTML = html`<div class="head"><h1>Fares & promos</h1><button class="btn" id="add">Add rule</button></div>
    <form class="card" id="dyn"><div class="head"><h3>Demand-based fares</h3><label class="chip"><input type="checkbox" name="enabled" ${dyn.enabled ? 'checked' : ''}>On</label></div>
      <p class="small muted" style="margin:0">Raise the fare as a bus fills up and reward people who book early. The price is fixed when the passenger books; search results always show the current price.</p>
      <div class="grid3">${tiers.map((t, i) => html`<div class="row" style="flex-wrap:nowrap;align-items:center"><span class="small">When</span><input name="occ${i}" type="number" min="1" max="100" value="${t.occupancy ?? ''}" style="max-width:80px" aria-label="Percent full">
        <span class="small">% full, add</span><input name="pct${i}" type="number" min="0" max="50" value="${t.pct ?? ''}" style="max-width:70px" aria-label="Surcharge percent"><span class="small">%</span></div>`)}</div>
      <div class="row" style="align-items:center"><span class="small">Booked at least</span><input name="early_days" type="number" min="0" max="180" value="${dyn.early_days}" style="max-width:80px" aria-label="Days ahead">
        <span class="small">days ahead: take off</span><input name="early_pct" type="number" min="0" max="50" value="${dyn.early_pct}" style="max-width:70px" aria-label="Early discount percent"><span class="small">%</span></div>
      <div><button class="btn">Save demand-based fares</button></div></form>
    <p class="muted" style="margin:0">Base fares are set per departure in the Timetable. These rules adjust them: peak surcharges for date ranges, a discount for children, and promo codes.</p>
    <div class="tablewrap"><table><thead><tr><th>Type</th><th>Name</th><th class="r">%</th><th>Code</th><th>Dates</th><th>Used</th><th></th></tr></thead><tbody>
      ${list.map(p => html`<tr style="${p.active ? '' : 'opacity:.55'}"><td>${label[p.kind]}</td><td>${p.name}</td><td class="r num">${p.kind === 'peak' ? '+' : '−'}${p.pct}</td><td class="mono">${p.code || ''}</td>
        <td class="small">${p.start_date ? `${dayOf(p.start_date)} – ${dayOf(p.end_date)}` : 'Always'}</td><td class="num">${p.kind === 'promo' ? `${p.used}${p.max_uses ? ' / ' + p.max_uses : ''}` : ''}</td>
        <td><button class="btn ghost sm" data-toggle="${p.id}" data-active="${p.active}">${p.active ? 'Turn off' : 'Turn on'}</button></td></tr>`)}
    </tbody></table></div>`;
  const df = $('#dyn', main);
  df.addEventListener('submit', e => { e.preventDefault(); busy(df.querySelector('.btn'), async () => {
    const v = formData(df);
    const body = { enabled: !!v.enabled, early_days: Number(v.early_days), early_pct: Number(v.early_pct), tiers: tiers.map((_, i) => ({ occupancy: Number(v['occ' + i]), pct: Number(v['pct' + i]) })).filter(t => t.occupancy) };
    await api('/operator/profile', { method: 'PUT', body: { dynamic_pricing: body } });
    toast(body.enabled ? 'Demand-based fares are on.' : 'Demand-based fares are off.');
  }); });
  $('#add', main).addEventListener('click', () => {
    const m = modal(html`<h2>Add a fare rule</h2><form id="pf" class="grid2">
      <label class="field"><span>Type</span><select name="kind"><option value="peak">Peak / holiday surcharge</option><option value="child">Child discount</option><option value="promo">Promo code</option></select></label>
      <label class="field"><span>Name</span><input name="name" placeholder="Independence weekend" required></label>
      <label class="field"><span>Percent</span><input name="pct" type="number" min="1" max="100" required></label>
      <label class="field" data-for="promo"><span>Code</span><input name="code" style="text-transform:uppercase"></label>
      <label class="field" data-for="peak promo"><span>From</span><input name="start_date" type="date"></label>
      <label class="field" data-for="peak promo"><span>To</span><input name="end_date" type="date"></label>
      <label class="field" data-for="promo"><span>Maximum uses</span><input name="max_uses" type="number" min="1"></label>
      <div class="row" style="justify-content:flex-end;align-self:end;grid-column:1/-1"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save rule</button></div></form>`);
    const f = $('#pf', m.el);
    const sync = () => $$('[data-for]', f).forEach(el => { el.hidden = !el.dataset.for.split(' ').includes(f.kind.value); });
    f.kind.addEventListener('change', sync); sync();
    f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { await api('/operator/pricing', { method: 'POST', body: formData(f) }); m.close(); toast('Rule saved.'); pricing(main); }); });
  });
  main.addEventListener('click', e => { const b = e.target.closest('[data-toggle]'); if (b) busy(b, async () => { await api('/operator/pricing/' + b.dataset.toggle, { method: 'PUT', body: { active: b.dataset.active !== '1' } }); pricing(main); }); });
}

/* ---------- parcels ---------- */
async function parcels(main) {
  const [list, cities, tripsToday] = await Promise.all([api('/operator/parcels'), api('/cities'), api('/operator/trips?date=' + today())]);
  const next = { received: 'loaded', loaded: 'in_transit', in_transit: 'arrived', arrived: 'collected' };
  main.innerHTML = html`<div class="head"><h1>Parcels</h1><button class="btn" id="add">Register parcel</button></div>
    <div class="tablewrap"><table><thead><tr><th>Ref</th><th>Route</th><th>Sender → Receiver</th><th>Item</th><th class="r">Fee</th><th>Bus</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map(p => html`<tr><td class="mono">${p.ref}</td><td>${p.from_city} → ${p.to_city}</td><td class="small">${p.sender_name} (${phoneFmt(p.sender_phone)})<br>${p.receiver_name} (${phoneFmt(p.receiver_phone)})</td>
        <td class="small">${p.description}<br>${p.weight_kg} kg</td><td class="r num">${kwacha(p.fee)}</td><td class="small mono">${p.plate ? `${p.plate} ${time(p.depart_at)}` : '—'}</td><td>${pill(p.status)}</td>
        <td>${next[p.status] ? html`<button class="btn ghost sm" data-adv="${p.id}" data-to="${next[p.status]}">Mark ${next[p.status].replace('_', ' ')}</button>` : ''}</td></tr>`)}
    </tbody></table></div>`;
  $('#add', main).addEventListener('click', () => {
    const opt = cities.map(c => html`<option>${c}</option>`).join('');
    const m = modal(html`<h2>Register a parcel</h2><form id="pf" class="grid2">
      <label class="field"><span>From</span><select name="from_city">${raw(opt)}</select></label><label class="field"><span>To</span><select name="to_city">${raw(opt)}</select></label>
      <label class="field"><span>Sender name</span><input name="sender_name" required></label><label class="field"><span>Sender phone</span><input name="sender_phone" inputmode="tel" required></label>
      <label class="field"><span>Receiver name</span><input name="receiver_name" required></label><label class="field"><span>Receiver phone (gets SMS)</span><input name="receiver_phone" inputmode="tel" required></label>
      <label class="field"><span>Description</span><input name="description" required></label><label class="field"><span>Weight (kg)</span><input name="weight_kg" type="number" step="0.1" min="0.1" required></label>
      <label class="field"><span>Fee (K)</span><input name="fee" type="number" min="0" required></label>
      <label class="field"><span>Load on (optional)</span><select name="trip_id"><option value="">Not yet assigned</option>${tripsToday.map(t => html`<option value="${t.id}">${t.depart_local} · ${t.route_name} · ${t.plate}</option>`)}</select></label>
      <div class="row" style="justify-content:flex-end;grid-column:1/-1"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Register</button></div></form>`, { wide: true });
    const f = $('#pf', m.el);
    f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { const v = formData(f); const p = await api('/operator/parcels', { method: 'POST', body: { ...v, trip_id: Number(v.trip_id) || null } }); m.close(); toast(`Parcel ${p.ref} registered. Receiver notified by SMS.`); parcels(main); }); });
  });
  main.addEventListener('click', e => { const b = e.target.closest('[data-adv]'); if (b) busy(b, async () => { await api('/operator/parcels/' + b.dataset.adv, { method: 'PUT', body: { status: b.dataset.to } }); parcels(main); }); });
}

/* ---------- reviews ---------- */
async function reviews(main) {
  const r = await api('/operator/reviews');
  const s = r.summary;
  main.innerHTML = html`<div class="head"><h1>Reviews</h1><span class="muted">${s.n} ratings</span></div>
    <div class="kpis">${[['Cleanliness', s.cleanliness], ['Punctuality', s.punctuality], ['Driver behaviour', s.driver]].map(([l, v]) => html`<div class="kpi"><span class="label">${l}</span><b>${v ?? '—'} <span class="stars" style="font-size:18px">★</span></b></div>`)}</div>
    <div class="tablewrap"><table><thead><tr><th>Date</th><th>Route</th><th>Clean</th><th>On time</th><th>Driver</th><th>Comment</th></tr></thead><tbody>
      ${r.recent.map(x => html`<tr><td class="small">${dayOf(x.service_date)}</td><td class="small">${x.route_name}</td><td>${x.cleanliness}★</td><td>${x.punctuality}★</td><td>${x.driver}★</td><td>${x.comment || ''}</td></tr>`)}</tbody></table></div>`;
}

/* ---------- finance ---------- */
async function finance(main, days = 30) {
  const f = await api('/operator/finance?days=' + days);
  const gross = f.daily.reduce((a, d) => a + d.gross, 0), comm = f.daily.reduce((a, d) => a + d.commission, 0);
  main.innerHTML = html`<div class="head"><h1>Revenue & payouts</h1><select id="days" style="width:auto">${[7, 30, 90, 365].map(d => html`<option value="${d}" ${d === days ? 'selected' : ''}>Last ${d} days</option>`)}</select></div>
    <div class="kpis">
      <div class="kpi"><span class="label">Fares sold</span><b>${kw0(gross)}</b><span class="small muted">${f.daily.reduce((a, d) => a + d.bookings, 0)} bookings</span></div>
      <div class="kpi"><span class="label">Platform commission</span><b>${kw0(comm)}</b><span class="small muted">deducted from payouts</span></div>
      <div class="kpi"><span class="label">Available to withdraw</span><b>${kw0(f.balance.available)}</b><span class="small muted">earned on completed trips</span></div>
      <div class="kpi"><span class="label">Pending</span><b>${kw0(f.balance.pending)}</b><span class="small muted">released after each trip runs</span></div>
    </div>
    <div class="card"><h3>Daily fares</h3>${raw(bars(f.daily.map(d => ({ label: dayOf(d.day), value: d.gross })), { fmt: kw0 }))}</div>
    <div class="grid2">
      <div class="card"><h3>Withdraw to bank</h3><form id="wf" class="row"><label class="field"><span>Amount (K)</span><input name="amount" type="number" min="100" max="${Math.floor(f.balance.available)}" required></label><button class="btn">Request payout</button></form>
        <p class="small muted" style="margin:0">Paid to the bank account in Company & verification, usually the next working day.</p></div>
      <div class="card"><h3>Payout history</h3>${f.settlements.length ? html`<div class="tablewrap"><table><tbody>${f.settlements.map(s => html`<tr><td class="small">${s.created_at.slice(0, 10)}</td><td class="r num">${kwacha(s.amount)}</td><td>${pill(s.status)}</td><td class="small muted">${s.note || ''}</td></tr>`)}</tbody></table></div>` : raw('<div class="empty small">No payouts yet.</div>')}</div>
    </div>
    <div class="card"><h3>Occupancy by route</h3><div class="tablewrap"><table><thead><tr><th>Route</th><th class="r">Trips</th><th class="r">Seats sold</th><th>Full</th></tr></thead><tbody>${f.routes.map(r => html`<tr><td>${r.name}</td><td class="r num">${r.trips}</td><td class="r num">${r.seats}</td><td style="min-width:160px">${raw(meter(r.occupancy))}</td></tr>`)}</tbody></table></div></div>`;
  $('#days', main).addEventListener('change', e => finance(main, Number(e.target.value)));
  const wf = $('#wf', main);
  wf.addEventListener('submit', e => { e.preventDefault(); busy(wf.querySelector('button'), async () => { await api('/operator/settlements', { method: 'POST', body: { amount: Number(wf.amount.value) } }); toast('Payout requested.'); finance(main, days); }); });
}

/* ---------- cash & shifts ---------- */
async function cash(main) {
  const list = await api('/operator/shifts');
  main.innerHTML = html`<div class="head"><h1>Cash & shifts</h1></div>
    <p class="small muted" style="margin:0">Every counter shift starts with a counted float and ends with a counted drawer. Sales cannot be deleted, only voided with your supervisor PIN.</p>
    <form class="card" id="pinf"><h3>Your supervisor PIN</h3><p class="small muted" style="margin:0">Clerks ask you for it to void a sale. Do not share it. Use 4–6 digits, not 1234 or 0000.</p>
      <div class="row"><label class="field" style="max-width:220px"><span>Your password</span><input type="password" name="password" required autocomplete="current-password"></label>
      <label class="field" style="max-width:160px"><span>New PIN</span><input type="password" name="pin" inputmode="numeric" maxlength="6" required autocomplete="new-password"></label><button class="btn">Save PIN</button></div></form>
    <div class="tablewrap"><table><thead><tr><th>Clerk</th><th>Opened</th><th>Closed</th><th class="r">Float</th><th class="r">Takings</th><th class="r">Expected</th><th class="r">Counted</th><th class="r">Difference</th><th class="r">Voids</th><th></th></tr></thead><tbody>
      ${list.map(sh => html`<tr><td>${sh.clerk}</td><td class="small">${sh.opened_at.slice(0, 16)}</td><td class="small">${sh.closed_at ? sh.closed_at.slice(0, 16) : raw('<span class="pill ok">open</span>')}</td>
        <td class="r num">${kwacha(sh.opening_float)}</td><td class="r num">${kwacha(sh.takings)}</td><td class="r num">${kwacha(sh.expected_cash)}</td><td class="r num">${sh.counted_cash != null ? kwacha(sh.counted_cash) : ''}</td>
        <td class="r num">${sh.variance == null ? '' : Math.abs(sh.variance) < 0.01 ? raw('<span class="pill ok">exact</span>') : html`<span class="pill ${Math.abs(sh.variance) > 50 ? 'bad' : 'warn'}">${sh.variance > 0 ? '+' : ''}${kwacha(sh.variance)}</span>`}</td>
        <td class="r num">${sh.voids ? html`<span style="color:${sh.voids >= 3 ? 'var(--bad)' : 'inherit'}">${sh.voids}</span>` : ''}</td><td><button class="btn ghost sm" data-sh="${sh.id}">Details</button></td></tr>`)}</tbody></table></div>`;
  const pf = $('#pinf', main);
  pf.addEventListener('submit', e => { e.preventDefault(); busy(pf.querySelector('button'), async () => { await api('/operator/supervisor-pin', { method: 'PUT', body: formData(pf) }); pf.reset(); toast('Supervisor PIN saved.'); }); });
  main.addEventListener('click', async e => {
    const b = e.target.closest('[data-sh]'); if (!b) return;
    const d = await api('/operator/shifts/' + b.dataset.sh);
    modal(html`<div class="head"><h2>Shift: ${list.find(x => x.id === d.id).clerk}</h2><button class="btn ghost sm" data-close>Close</button></div>${d.notes ? html`<div class="notice">${d.notes}</div>` : ''}
      <div class="tablewrap"><table><tbody>${d.movements.map(mv => html`<tr><td class="small">${mv.created_at.slice(11, 16)}</td><td>${mv.kind}</td><td class="mono small">${mv.ref || ''}</td><td class="r num" style="color:${mv.amount < 0 ? 'var(--bad)' : 'inherit'}">${kwacha(mv.amount)}</td><td class="small">${mv.note || ''}</td></tr>`)}</tbody></table></div>`, { wide: true });
  });
}

/* ---------- company ---------- */
async function company(main) {
  const p = await api('/operator/profile');
  const need = [['pacra', 'PACRA certificate of incorporation'], ['rtsa_licence', 'RTSA road service licence'], ['tax_clearance', 'ZRA tax clearance certificate']];
  main.innerHTML = html`<div class="head"><h1>${p.name}</h1>${pill(p.status)}</div>
    ${p.status_note ? html`<div class="notice">${p.status_note}</div>` : ''}
    <div class="card"><h3>Verification documents</h3><p class="small muted" style="margin:0">PDF, JPG or PNG, up to 5 MB each. The platform team checks them before your buses can be booked.</p>
      <div class="tablewrap"><table><tbody>${need.map(([k, l]) => { const d = p.documents.find(x => x.kind === k); return html`<tr><td><b>${l}</b></td>
        <td>${d ? html`${pill(d.status)} <a href="#" data-doc="${d.id}">${d.filename}</a>${d.expires_on ? html` <span class="small muted">expires ${dayOf(d.expires_on)}</span>` : ''}` : raw('<span class="pill bad">missing</span>')}</td>
        <td><label class="btn ghost sm">Upload<input type="file" accept="application/pdf,image/*" data-up="${k}" hidden></label></td></tr>`; })}</tbody></table></div></div>
    <form class="card" id="pf"><h3>Company details & bank account</h3><div class="grid3">
      <label class="field"><span>PACRA no.</span><input name="pacra_no" value="${p.pacra_no || ''}"></label><label class="field"><span>ZRA TPIN</span><input name="tpin" value="${p.tpin || ''}"></label>
      <label class="field"><span>Contact email</span><input name="contact_email" type="email" value="${p.contact_email || ''}"></label>
      <label class="field"><span>Bank</span><input name="bank_name" value="${p.bank_name || ''}"></label><label class="field"><span>Account number</span><input name="bank_account" value="${p.bank_account || ''}"></label>
      <label class="field"><span>Branch</span><input name="bank_branch" value="${p.bank_branch || ''}"></label></div>
      ${p.bank_change ? html`<div class="notice"><b>Bank account change waiting:</b> payouts will go to ${p.bank_change.bank_name} account ending ${p.bank_change.bank_account.slice(-4)} from ${p.bank_change.effective_at.slice(0, 16)}. Withdrawals are paused until then. <button type="button" class="btn danger sm" id="cancelbank">Cancel this change</button></div>`
        : raw('<p class="small muted" style="margin:0">For your protection, a new bank account takes effect 48 hours after you save it, and the owner gets an SMS.</p>')}
      <h3>Cancellation policy</h3><p class="small muted" style="margin:0">Refund percentage of the fare by how early the passenger cancels.</p>
      <div id="tiers" class="page" style="gap:6px">${p.terms.refundPolicy.map((t, i) => html`<div class="row" style="flex-wrap:nowrap"><input name="h${i}" type="number" min="0" value="${t.hours}" style="max-width:110px" aria-label="Hours before"><span class="small muted">hours or more before departure →</span><input name="p${i}" type="number" min="0" max="100" value="${t.pct}" style="max-width:90px" aria-label="Refund percent"><span class="small muted">% refund</span></div>`)}</div>
      <label class="field" style="max-width:220px"><span>Date/time change fee (K)</span><input name="reschedule_fee" type="number" min="0" value="${p.reschedule_fee}"></label>
      <h3>Luggage prices</h3><p class="small muted" style="margin:0">Charged per item and added to the ticket. Put 0 for items you carry free. The luggage charge goes to you in full (no commission).</p>
      <div class="grid4">${KINDS.map(([k, l]) => html`<label class="field"><span>${l} (K each)</span><input name="lf_${k}" type="number" min="0" step="0.5" value="${p.terms.luggageFees[k]}"></label>`)}
        <label class="field"><span>Free bags per passenger</span><input name="lf_free_bags" type="number" min="0" max="10" value="${p.terms.luggageFees.free_bags}"></label></div>
      <div class="small muted">Your commission: ${p.terms.commissionPct}% of fares · Booking fee charged to passengers: ${kwacha(p.terms.bookingFee)}</div>
      <div><button class="btn">Save</button></div></form>`;
  main.addEventListener('change', async e => {
    const i = e.target.closest('[data-up]'); if (!i?.files[0]) return;
    try { await api('/operator/documents', { method: 'POST', body: { kind: i.dataset.up, file: await fileToUpload(i.files[0]) } }); toast('Uploaded. The platform team will verify it.'); company(main); } catch (err) { toast(err.message, true); }
  });
  main.addEventListener('click', e => { const d = e.target.closest('[data-doc]'); if (d) { e.preventDefault(); openBlob('/documents/' + d.dataset.doc).catch(err => toast(err.message, true)); } });
  $('#cancelbank', main)?.addEventListener('click', e => busy(e.target, async () => { await api('/operator/bank-change/cancel', { method: 'POST' }); toast('Bank change cancelled.'); company(main); }));
  const f = $('#pf', main);
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('button:not(.sm)'), async () => {
    const v = formData(f);
    const refund_policy = p.terms.refundPolicy.map((_, i) => ({ hours: Number(v['h' + i]), pct: Number(v['p' + i]) }));
    const luggage_fees = Object.fromEntries([...KINDS.map(([k]) => k), 'free_bags'].map(k => [k, Number(v['lf_' + k]) || 0]));
    const r = await api('/operator/profile', { method: 'PUT', body: { ...v, refund_policy, reschedule_fee: Number(v.reschedule_fee), luggage_fees } });
    toast(r.bank_change ? `Saved. The new bank account takes effect on ${r.bank_change.effective_at.slice(0, 16)}.` : 'Saved.');
    if (r.bank_change) company(main);
  }); });
}

const VIEWS = { cash, dashboard, trips, counter, fleet, staff: staffView, maintenance, routes, schedules, pricing, parcels, reviews, finance, company };
