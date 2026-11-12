import { $, $$, html, raw, esc, api, auth, toast, modal, busy, formData, kwacha, kw0, time, day, dayOf, dateTime, dur, today, plusDays, pill, download } from './core.js';
import { seatPicker, countdown } from './seatmap.js';

/* ---------- cart (survives reloads during checkout) ---------- */
const cart = {
  get() { try { return JSON.parse(sessionStorage.getItem('mt.cart')) || null; } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem('mt.cart', JSON.stringify(v)) : sessionStorage.removeItem('mt.cart'); } catch {} },
};
const AMENITY_ICON = { 'Wi-Fi': 'Wi-Fi', AC: 'AC', 'USB Charging': 'USB', Toilet: 'WC', 'Reclining Seats': 'Recliner', TV: 'TV', Refreshments: 'Snacks', Blanket: 'Blanket' };

/* ---------- home / search ---------- */
export async function home(app) {
  const cities = await api('/cities');
  const last = (() => { try { return JSON.parse(localStorage.getItem('mt.lastSearch')); } catch { return null; } })();
  app.innerHTML = html`<div class="page">
    <section class="hero">
      <h1>Bus tickets across Zambia</h1>
      ${searchForm(cities, last || { from: 'Lusaka', to: 'Kitwe', date: plusDays(today(), 1) })}
    </section>
    <section class="grid3">
      <div class="card"><h3>Pay the way you already do</h3><p class="muted" style="margin:0">MTN MoMo, Airtel Money, Zamtel Kwacha, Visa or Mastercard. Or reserve now and pay cash at the station within 30 minutes.</p></div>
      <div class="card"><h3>Your seat is locked while you pay</h3><p class="muted" style="margin:0">Pick a seat and nobody else can take it for 10 minutes. The map updates live as others book.</p></div>
      <div class="card"><h3>Ticket by SMS and WhatsApp</h3><p class="muted" style="margin:0">Show the QR code at the gate. Track your bus live and get told if it is delayed.</p></div>
    </section>
    <section class="card"><h3>Popular routes</h3><div class="chips">${[['Lusaka', 'Kitwe'], ['Lusaka', 'Livingstone'], ['Lusaka', 'Chipata'], ['Kitwe', 'Lusaka'], ['Lusaka', 'Ndola'], ['Kabwe', 'Kitwe']].map(([a, b]) =>
      html`<a class="chip" href="#/search?from=${a}&to=${b}&date=${plusDays(today(), 1)}">${a} → ${b}</a>`)}</div></section>
  </div>`;
  bindSearch(app);
}

function searchForm(cities, v) {
  const opts = sel => cities.map(c => html`<option ${c === sel ? 'selected' : ''}>${c}</option>`);
  return html`<form id="search" autocomplete="off">
    <label class="field"><span>From</span><select name="from">${opts(v.from)}</select></label>
    <button type="button" class="swap" id="swap" aria-label="Swap origin and destination">⇄</button>
    <label class="field"><span>To</span><select name="to">${opts(v.to)}</select></label>
    <label class="field wide"><span>Travel date</span><input type="date" name="date" min="${today()}" value="${v.date && v.date >= today() ? v.date : plusDays(today(), 1)}" required></label>
    <label class="field wide"><span>Return (optional)</span><input type="date" name="return_date" min="${today()}" value="${v.return_date || ''}"></label>
    <button class="btn copper wide">Search buses</button>
  </form>`;
}
function bindSearch(root) {
  const f = $('#search', root);
  $('#swap', root).addEventListener('click', () => { const a = f.from.value; f.from.value = f.to.value; f.to.value = a; });
  f.addEventListener('submit', e => {
    e.preventDefault();
    const v = formData(f);
    if (v.from === v.to) return toast('Pick two different cities.', true);
    if (v.return_date && v.return_date < v.date) return toast('The return date must be on or after the travel date.', true);
    try { localStorage.setItem('mt.lastSearch', JSON.stringify(v)); } catch {}
    const q = new URLSearchParams(Object.entries(v).filter(([, x]) => x));
    location.hash = '#/search?' + q;
  });
}

/* ---------- results with filters ---------- */
export async function results(app, params) {
  const p = Object.fromEntries(params);
  const [cities, filters, data] = await Promise.all([api('/cities'), api('/filters'), api('/search?' + params)]);
  const picked = cart.get()?.search?.key === params.toString() ? cart.get().legs.map(l => l.trip.trip_id) : [];
  const has = (k, v) => (params.get(k) || '').split(',').includes(String(v));
  const chip = (k, v, label) => html`<label class="chip"><input type="checkbox" data-f="${k}" value="${v}" ${has(k, v) ? 'checked' : ''}>${label}</label>`;

  app.innerHTML = html`<div class="page">
    <section class="hero" style="padding:16px">${searchForm(cities, p)}</section>
    <div class="results">
      <aside class="filters" aria-label="Filters">
        <div class="card"><span class="label">Departure</span><div class="chips">${chip('window', 'morning', 'Morning 05–12')}${chip('window', 'afternoon', 'Afternoon 12–17')}${chip('window', 'night', 'Evening & night')}</div></div>
        <div class="card"><span class="label">Bus type</span><div class="chips">${filters.classes.map(c => chip('class', c, c))}</div></div>
        <div class="card"><span class="label">Bus company</span><div class="chips">${filters.operators.map(o => chip('operator', o.id, o.name))}</div></div>
        <div class="card"><span class="label">Amenities</span><div class="chips">${filters.amenities.map(a => chip('amenities', a, a))}</div></div>
        <div class="card"><span class="label">Price (K)</span><div class="row"><input type="number" min="0" placeholder="Min" id="minp" value="${p.min_price || ''}"><input type="number" min="0" placeholder="Max" id="maxp" value="${p.max_price || ''}"></div></div>
      </aside>
      <div class="main">
        <div class="head"><div class="small muted">Sort by</div>
          <select id="sort" style="width:auto">${[['depart', 'Departure time'], ['price', 'Lowest fare'], ['rating', 'Best rated'], ['seats', 'Most seats left']].map(([v, l]) => html`<option value="${v}" ${p.sort === v ? 'selected' : ''}>${l}</option>`)}</select></div>
        ${legSection('Outbound', p.from, p.to, p.date, data.outbound, 0, picked)}
        ${data.return ? legSection('Return', p.to, p.from, p.return_date, data.return, 1, picked) : ''}
        <div class="card" id="go" ${data.return ? '' : 'hidden'}><div class="row" style="justify-content:space-between;align-items:center"><span id="gotext" class="muted">Pick an outbound and a return bus.</span><button class="btn copper" id="gobtn" disabled>Choose seats</button></div></div>
      </div>
    </div>
  </div>`;
  bindSearch(app);

  const setParam = (k, v) => { v ? params.set(k, v) : params.delete(k); location.hash = '#/search?' + params; };
  $$('[data-f]', app).forEach(i => i.addEventListener('change', () => setParam(i.dataset.f, $$(`[data-f="${i.dataset.f}"]:checked`, app).map(x => x.value).join(','))));
  $('#sort', app).addEventListener('change', e => setParam('sort', e.target.value));
  ['minp', 'maxp'].forEach(id => $('#' + id, app).addEventListener('change', e => setParam(id === 'minp' ? 'min_price' : 'max_price', e.target.value)));

  const choice = [null, null];
  const all = [data.outbound, data.return || []];
  picked.forEach((id, i) => { choice[i] = all[i].find(t => t.trip_id === id) || null; });
  const update = () => {
    $$('.trip', app).forEach(el => el.classList.toggle('picked', choice[el.dataset.leg]?.trip_id === Number(el.dataset.trip)));
    if (data.return) {
      const ok = choice[0] && choice[1];
      $('#gobtn', app).disabled = !ok;
      $('#gotext', app).textContent = ok ? `${time(choice[0].depart_at)} out, ${time(choice[1].depart_at)} back · from ${kw0(choice[0].fare + choice[1].fare)} per person` : 'Pick an outbound and a return bus.';
    }
  };
  const start = () => {
    cart.set({ search: { key: params.toString(), ...p }, legs: choice.filter(Boolean).map(t => ({ trip: t, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, hold: null })) });
    location.hash = '#/seats';
  };
  app.addEventListener('click', e => {
    const b = e.target.closest('[data-pick]');
    if (b) {
      const leg = Number(b.dataset.leg);
      choice[leg] = all[leg].find(t => t.trip_id === Number(b.dataset.pick));
      if (!data.return) return start();
      update();
      if (leg === 0 && !choice[1]) $('#leg1')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    const s = e.target.closest('[data-stops]');
    if (s) showStops(all[s.dataset.leg].find(t => t.trip_id === Number(s.dataset.stops)));
  });
  $('#gobtn', app)?.addEventListener('click', start);
  update();
}

function legSection(title, from, to, date, trips, leg, picked) {
  return html`<section class="page" style="gap:10px" id="leg${leg}">
    <div class="head"><h2>${title}: ${from} → ${to}</h2><span class="muted">${dayOf(date)} · ${trips.length} bus${trips.length === 1 ? '' : 'es'}</span></div>
    ${trips.length ? trips.map(t => tripCard(t, leg)) : raw('<div class="empty">No buses match. Clear some filters or try another date.</div>')}
  </section>`;
}
function tripCard(t, leg) {
  const low = t.seats_left <= 8;
  return html`<article class="trip" data-trip="${t.trip_id}" data-leg="${leg}">
    <div style="display:grid;gap:3px;min-width:0">
      <b>${t.operator}</b>
      <span class="small muted">${t.class} · ${t.plate}${t.rating ? raw(` · <span class="stars">★ ${t.rating.avg}</span> <span class="muted">(${t.rating.n})</span>`) : ''}</span>
      <div class="chips" style="gap:4px">${t.amenities.map(a => html`<span class="tag">${AMENITY_ICON[a] || a}</span>`)}</div>
      ${t.status === 'delayed' ? raw(`<span class="pill warn">Delayed ${t.delay_min} min</span>`) : ''}
    </div>
    <div class="leg">
      <div><div class="t">${time(t.depart_at)}</div><div class="small muted">${t.boarding_points[0].terminal}</div></div>
      <div class="line">${dur(t.duration_min)}<br><button class="btn ghost sm" data-stops="${t.trip_id}" data-leg="${leg}" type="button">Stops & map</button></div>
      <div style="text-align:right"><div class="t">${time(t.arrive_at)}</div><div class="small muted">${t.dropping_points.at(-1).terminal}</div></div>
    </div>
    <div class="fare"><b class="num">${kw0(t.fare)}</b><div class="small ${low ? '' : 'muted'}" style="${low ? 'color:var(--bad);font-weight:600' : ''}">${t.seats_left} of ${t.capacity} seats left</div></div>
    <button class="btn" data-pick="${t.trip_id}" data-leg="${leg}" ${t.seats_left > 0 ? '' : 'disabled'}>${t.seats_left > 0 ? 'Select' : 'Full'}</button>
  </article>`;
}
function showStops(t) {
  const row = (s, kind) => html`<tr><td>${kind}</td><td><b>${s.terminal}</b>, ${s.city} ${s.kind === 'roadside' ? raw('<span class="tag">roadside</span>') : ''}</td><td class="num">${time(s.time)}</td><td><a href="${s.map_url}" target="_blank" rel="noopener">Map</a></td></tr>`;
  modal(html`<div class="head"><h2>${t.operator} · ${time(t.depart_at)}</h2><button class="btn ghost sm" data-close>Close</button></div>
    <div class="tablewrap"><table><thead><tr><th>Type</th><th>Stop</th><th>Time</th><th></th></tr></thead><tbody>
      ${t.boarding_points.map(s => row(s, 'Pick-up'))}${t.dropping_points.map(s => row(s, 'Drop-off'))}</tbody></table></div>`);
}

/* ---------- seat selection ---------- */
export async function seats(app) {
  const c = cart.get();
  if (!c?.legs?.length) { location.hash = '#/'; return; }
  const pickers = [];
  const quotes = [];
  app.innerHTML = html`<div class="page">
    <div class="head"><div><a href="#/search?${c.search.key}" class="small">← Back to results</a><h1>Choose your seats</h1></div>
      <div class="card" style="padding:8px 12px;gap:0"><span class="label">Seats held for</span><span class="timer" id="timer">--:--</span></div></div>
    ${c.legs.map((l, i) => html`<section class="booking" data-leg="${i}">
      <div class="card"><div class="head"><h2>${c.legs.length > 1 ? (i ? 'Return: ' : 'Outbound: ') : ''}${l.trip.boarding_points[0].city} → ${l.trip.dropping_points[0].city}</h2>
        <span class="muted">${day(l.trip.depart_at)} · ${l.trip.operator} · ${l.trip.class}</span></div><div id="map${i}"></div></div>
      <div class="card">
        <label class="field"><span>Boarding point</span><select id="from${i}">${l.trip.boarding_points.map(s => html`<option value="${s.stop_id}" ${s.stop_id === l.from_stop_id ? 'selected' : ''}>${time(s.time)} · ${s.terminal}, ${s.city}</option>`)}</select></label>
        <a class="small" id="fromMap${i}" target="_blank" rel="noopener">Open pick-up point in Google Maps</a>
        <label class="field"><span>Dropping point</span><select id="to${i}">${l.trip.dropping_points.map(s => html`<option value="${s.stop_id}" ${s.stop_id === l.to_stop_id ? 'selected' : ''}>${time(s.time)} · ${s.terminal}, ${s.city}</option>`)}</select></label>
        <div id="sum${i}"></div>
      </div>
    </section>`)}
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center"><span id="hint" class="muted"></span><button class="btn copper" id="next" disabled>Continue to passenger details</button></div></div>
  </div>`;

  const timer = countdown($('#timer', app), null, () => { toast('Your seat hold expired. Pick your seats again.', true); });
  const refresh = async i => {
    const l = c.legs[i];
    const bp = l.trip.boarding_points.find(s => s.stop_id === l.from_stop_id);
    $('#fromMap' + i, app).href = bp.map_url;
    const n = l.hold?.seats?.length || 0;
    try {
      quotes[i] = n ? await api('/quote', { method: 'POST', body: { trip_id: l.trip.trip_id, from_stop_id: l.from_stop_id, to_stop_id: l.to_stop_id, passengers: Array(n).fill({}) } }) : null;
    } catch (e) { toast(e.message, true); quotes[i] = null; }
    const q = quotes[i];
    $('#sum' + i, app).innerHTML = html`<div class="sumrow"><span class="label">Seats</span><span class="mono">${l.hold?.seats?.join(', ') || 'Tap seats on the map'}</span></div>
      ${q ? html`<div class="sumrow"><span>${n} × ${kw0(q.adult_fare)}${q.peak_pct ? raw(` <span class="tag">peak +${q.peak_pct}%</span>`) : ''}</span><span class="num">${kwacha(q.fare_total)}</span></div>
      <div class="sumrow small muted"><span>Child discount (${q.child_pct}%) is applied on the next step</span><span></span></div>` : ''}`;
    const counts = c.legs.map(x => x.hold?.seats?.length || 0);
    const ok = counts[0] > 0 && counts.every(x => x === counts[0]);
    $('#next', app).disabled = !ok;
    $('#hint', app).textContent = !counts[0] ? 'Pick at least one seat.' : ok ? `${counts[0]} passenger${counts[0] > 1 ? 's' : ''}` : `Pick ${counts[0]} seat${counts[0] > 1 ? 's' : ''} on the return bus too.`;
    const exp = c.legs.map(x => x.hold?.expires_at).filter(Boolean).sort()[0] || null;
    timer.set(exp);
    cart.set(c);
  };
  c.legs.forEach((l, i) => {
    pickers[i] = seatPicker($('#map' + i, app), { tripId: l.trip.trip_id, hold: l.hold, max: i ? (c.legs[0].hold?.seats?.length || 6) : 6,
      onChange: h => { l.hold = { token: h.token, seats: h.seats, expires_at: h.expires_at }; refresh(i); } });
    $('#from' + i, app).addEventListener('change', e => { l.from_stop_id = Number(e.target.value); refresh(i); });
    $('#to' + i, app).addEventListener('change', e => { l.to_stop_id = Number(e.target.value); refresh(i); });
    refresh(i);
  });
  $('#next', app).addEventListener('click', () => { cart.set(c); location.hash = '#/checkout'; });
  return () => { pickers.forEach(p => p.destroy()); timer.stop(); };
}

/* ---------- checkout ---------- */
export async function checkout(app) {
  const c = cart.get();
  if (!c?.legs?.[0]?.hold?.seats?.length) { location.hash = '#/seats'; return; }
  const u = auth.user;
  const seats = c.legs[0].hold.seats;
  const female = new Set();
  for (const [i, l] of c.legs.entries()) {
    const m = await api(`/trips/${l.trip.trip_id}/seats`, { headers: { 'x-hold-token': l.hold.token } });
    const flat = m.decks.flatMap(d => d.rows.flat()).filter(Boolean);
    if (l.hold.seats.some(s => flat.find(x => x.no === s)?.status !== 'mine')) { toast('Your seat hold expired. Pick your seats again.', true); location.hash = '#/seats'; return; }
    l.hold.seats.forEach((s, k) => { if (flat.find(x => x.no === s)?.female) female.add(k); });
    c.legs[i].hold.expires_at = m.my_hold_expires;
  }
  const saved = c.form || {};
  app.innerHTML = html`<div class="page">
    <div class="head"><div><a href="#/seats" class="small">← Change seats</a><h1>Passenger details</h1></div>
      <div class="card" style="padding:8px 12px;gap:0"><span class="label">Seats held for</span><span class="timer" id="timer"></span></div></div>
    <form id="co" class="page" novalidate>
      <section class="card"><h3>Travellers</h3><p class="small muted" style="margin:0">Names and ID numbers go on the passenger manifest checked by police and at borders. Bring the same ID.</p>
        ${seats.map((s, i) => html`<div class="paxrow">
          <span class="seatno" title="Seat">${s}${c.legs[1] ? raw(`<br><span class="small">${esc(c.legs[1].hold.seats[i])}</span>`) : ''}</span>
          <label class="field"><span>Full name</span><input name="name${i}" value="${saved['name' + i] ?? (i === 0 && u?.role === 'passenger' ? u.name : '')}" required></label>
          <label class="field"><span>ID type</span><select name="idt${i}">${['NRC', 'Passport', 'Other'].map(t => html`<option ${saved['idt' + i] === t ? 'selected' : ''}>${t}</option>`)}</select></label>
          <label class="field"><span>ID number</span><input name="idn${i}" value="${saved['idn' + i] || ''}" placeholder="123456/78/1" required></label>
          <label class="field"><span>Gender${female.has(i) ? ' (women-only seat)' : ''}</span><select name="g${i}">${[['F', 'Female'], ['M', 'Male'], ['X', 'Prefer not to say']].map(([v, l]) => html`<option value="${v}" ${(saved['g' + i] || (female.has(i) ? 'F' : 'M')) === v ? 'selected' : ''}>${l}</option>`)}</select></label>
          <label class="chip" style="align-self:center"><input type="checkbox" name="child${i}" ${saved['child' + i] ? 'checked' : ''}>Child under 12</label>
        </div>`)}
      </section>
      <section class="card"><h3>Contact for tickets and alerts</h3>
        <div class="grid3">
          <label class="field"><span>Name</span><input name="cname" value="${saved.cname ?? (u?.role === 'passenger' ? u.name : '')}" required></label>
          <label class="field"><span>Mobile number (SMS + WhatsApp)</span><input name="cphone" inputmode="tel" value="${saved.cphone ?? (u?.role === 'passenger' ? '0' + u.phone.slice(3) : '')}" placeholder="0971 234 567" required></label>
          <label class="field"><span>Email (optional)</span><input name="cemail" type="email" value="${saved.cemail ?? (u?.email || '')}"></label>
        </div>
        ${u ? '' : raw('<p class="small muted" style="margin:0">Booking as a guest. <a href="#/login" id="signin">Sign in</a> to keep the trip in My trips.</p>')}
      </section>
      <section class="card"><h3>Payment</h3>
        <div class="paymethods">
          ${[['mtn', 'MTN MoMo', 'Approve on your phone'], ['airtel', 'Airtel Money', 'Approve on your phone'], ['zamtel', 'Zamtel Kwacha', 'Approve on your phone'], ['card', 'Visa / Mastercard', 'Secure card page'], ['station', 'Pay at the station', 'Seats held 30 minutes']]
            .map(([v, l, d]) => html`<label class="paymethod"><input type="radio" name="pm" value="${v}" ${(saved.pm || 'mtn') === v ? 'checked' : ''}><b>${l}</b><span class="small muted">${d}</span></label>`)}
        </div>
        <div class="row"><label class="field" style="max-width:240px"><span>Promo code</span><input name="promo" value="${saved.promo || ''}" style="text-transform:uppercase"></label><button type="button" class="btn ghost" id="applyPromo">Apply</button></div>
        <div id="price"></div>
      </section>
      <div class="row" style="justify-content:flex-end"><button class="btn copper" id="book">Confirm booking</button></div>
    </form>
  </div>`;
  const f = $('#co', app);
  const timer = countdown($('#timer', app), c.legs.map(l => l.hold.expires_at).sort()[0], () => { toast('Your seat hold expired. Pick your seats again.', true); location.hash = '#/seats'; });
  const passengers = (i, v) => seats.map((_, k) => ({ seat_no: c.legs[i].hold.seats[k], name: v['name' + k], id_type: v['idt' + k], id_number: v['idn' + k], gender: v['g' + k], is_child: !!v['child' + k] }));
  let promoOk = '';
  const price = async () => {
    const v = formData(f);
    c.form = v; cart.set(c);
    try {
      const qs = await Promise.all(c.legs.map((l, i) => api('/quote', { method: 'POST', body: { trip_id: l.trip.trip_id, from_stop_id: l.from_stop_id, to_stop_id: l.to_stop_id, passengers: passengers(i, v), promo_code: promoOk || undefined } })));
      const fare = qs.reduce((a, q) => a + q.fare_total, 0), disc = qs.reduce((a, q) => a + q.discount, 0), fee = qs.reduce((a, q) => a + q.booking_fee, 0);
      $('#price', app).innerHTML = html`<div class="sumrow"><span>Fares${qs.some(q => q.child_pct && passengers(0, v).some(p => p.is_child)) ? ` (children ${qs[0].child_pct}% off)` : ''}</span><span class="num">${kwacha(fare)}</span></div>
        ${disc ? html`<div class="sumrow" style="color:var(--ok)"><span>Promo ${promoOk}</span><span class="num">−${kwacha(disc)}</span></div>` : ''}
        <div class="sumrow"><span>Booking fee</span><span class="num">${kwacha(fee)}</span></div>
        <div class="sumrow total"><span>Total</span><span class="num">${kwacha(fare - disc + fee)}</span></div>`;
    } catch (e) { $('#price', app).innerHTML = html`<div class="notice bad">${e.message}</div>`; if (promoOk) promoOk = ''; }
  };
  f.addEventListener('change', price);
  $('#applyPromo', app).addEventListener('click', () => { promoOk = f.promo.value.trim().toUpperCase(); price().then(() => promoOk && toast(`Promo ${promoOk} checked.`)); });
  $('#signin', app)?.addEventListener('click', () => sessionStorage.setItem('mt.next', '#/checkout'));
  f.addEventListener('submit', e => {
    e.preventDefault();
    const v = formData(f);
    busy($('#book', app), async () => {
      const r = await api('/bookings', { method: 'POST', body: {
        legs: c.legs.map((l, i) => ({ trip_id: l.trip.trip_id, hold_token: l.hold.token, from_stop_id: l.from_stop_id, to_stop_id: l.to_stop_id, passengers: passengers(i, v) })),
        contact: { name: v.cname, phone: v.cphone, email: v.cemail }, promo_code: v.promo || undefined, payment_method: v.pm } });
      cart.set(null);
      try { sessionStorage.setItem('mt.pay.' + r.group_ref, JSON.stringify({ method: v.pm, phone: v.cphone })); } catch {}
      location.hash = '#/pay/' + r.group_ref;
    }).catch(err => { if (err.code === 'hold_expired') location.hash = '#/seats'; });
  });
  price();
  return () => timer.stop();
}

/* ---------- payment ---------- */
export async function pay(app, group) {
  let pref = {};
  try { pref = JSON.parse(sessionStorage.getItem('mt.pay.' + group)) || {}; } catch {}
  let poll = null, timer = null;
  const draw = async () => {
    const g = await api('/groups/' + group);
    const total = g.bookings.reduce((a, b) => a + (['pending_payment', 'reserved'].includes(b.status) ? b.total : 0), 0);
    const st = g.bookings[0].status;
    const lastFail = g.payments.find(p => p.status === 'failed');
    if (st === 'confirmed' || st === 'completed') {
      app.innerHTML = html`<div class="page" style="max-width:720px;margin:0 auto">
        <div class="notice ok"><h2>Booking confirmed</h2><p style="margin:4px 0 0">Your e-ticket is on its way by SMS and WhatsApp${pref.email ? ' and email' : ''}. Show the QR code at the gate.</p></div>
        ${g.bookings.map(b => html`<div class="card"><div class="row" style="justify-content:space-between;align-items:center"><div><span class="label">Booking</span><div class="mono" style="font-size:18px">${b.ref}</div></div>
          <a class="btn" href="${b.ticket}" target="_blank" rel="noopener">Open ticket & QR</a></div></div>`)}
        <div class="row">${auth.user ? raw('<a class="btn ghost" href="#/trips">Go to My trips</a>') : raw('<a class="btn ghost" href="#/register">Create an account to manage this trip</a>')}<a class="btn ghost" href="#/">Book another trip</a></div>
      </div>`;
      return true;
    }
    if (st === 'expired' || st === 'cancelled') {
      app.innerHTML = html`<div class="page" style="max-width:640px;margin:0 auto"><div class="notice bad"><h2>This booking ${st === 'expired' ? 'expired' : 'was cancelled'}</h2><p style="margin:4px 0 0">The seats were released. If money left your wallet, it is refunded automatically within 3 working days.</p></div><a class="btn" href="#/">Search again</a></div>`;
      return true;
    }
    const pending = g.payments.find(p => p.status === 'initiated');
    app.innerHTML = html`<div class="page" style="max-width:640px;margin:0 auto">
      <div class="head"><h1>Pay ${kwacha(total)}</h1><div class="card" style="padding:8px 12px;gap:0"><span class="label">${st === 'reserved' ? 'Reserved until' : 'Seats held for'}</span><span class="timer" id="timer"></span></div></div>
      <div class="card"><span class="label">Booking reference${g.bookings.length > 1 ? 's' : ''}</span><div class="mono" style="font-size:18px">${g.bookings.map(b => b.ref).join(' + ')}</div></div>
      ${st === 'reserved' ? html`<div class="notice"><b>Pay cash at the bus company counter</b> before the timer runs out and give them reference <span class="mono">${g.bookings[0].ref}</span>. Or pay now by mobile money or card below.</div>` : ''}
      ${lastFail && !pending ? html`<div class="notice bad">Payment failed: ${lastFail.failure_reason}. Try again or use another method.</div>` : ''}
      ${pending ? html`<div class="card" style="justify-items:center;text-align:center"><span class="spinner"></span><h3>Check your phone</h3>
        <p class="muted" style="margin:0">${pending.provider === 'card' ? 'Complete the payment on the card page.' : `Enter your ${pending.provider.toUpperCase()} PIN on the prompt to approve ${kwacha(pending.amount)}.`} This page updates by itself.</p></div>`
      : html`<form class="card" id="pf">
        <div class="paymethods">${[['mtn', 'MTN MoMo'], ['airtel', 'Airtel Money'], ['zamtel', 'Zamtel Kwacha'], ['card', 'Visa / Mastercard']].map(([v, l]) =>
          html`<label class="paymethod"><input type="radio" name="method" value="${v}" ${(pref.method === v || (!['mtn', 'airtel', 'zamtel', 'card'].includes(pref.method) && v === 'mtn')) ? 'checked' : ''}><b>${l}</b></label>`)}</div>
        <label class="field" id="msisdnf"><span>Mobile money number</span><input name="msisdn" inputmode="tel" value="${pref.phone || ''}" placeholder="096 123 4567"></label>
        <p class="small muted" style="margin:0" id="sbx"></p>
        <button class="btn copper">Pay ${kwacha(total)}</button>
      </form>`}
    </div>`;
    const exp = g.bookings.map(b => b.expires_at).filter(Boolean).sort()[0];
    timer?.stop(); timer = countdown($('#timer', app), exp, () => setTimeout(draw, 25000));
    const pf = $('#pf', app);
    if (pf) {
      const sync = () => { $('#msisdnf', app).hidden = pf.method.value === 'card'; };
      pf.addEventListener('change', sync); sync();
      pf.addEventListener('submit', e => {
        e.preventDefault();
        busy(pf.querySelector('button'), async () => {
          const v = formData(pf);
          const r = await api(`/groups/${group}/pay`, { method: 'POST', body: v });
          if (r.sandbox) toast('Sandbox payment: no real money moves. Numbers ending 0000 or 1111 simulate a failure.');
          if (r.redirect_url) { location.href = `${r.redirect_url}&group=${group}&pid=${r.payment_id}`; return; }
          await draw();
        });
      });
    }
    if (pending) watch(pending.id);
    return false;
  };
  let watching = null;
  const watch = id => {
    if (watching === id) return;
    watching = id;
    clearInterval(poll);
    poll = setInterval(async () => {
      const p = await api('/payments/' + id).catch(() => null);
      if (p && p.status !== 'initiated') {
        clearInterval(poll); watching = null;
        if (p.status === 'failed') toast(`Payment failed: ${p.reason}`, true);
        draw();
      }
    }, 2000);
  };
  await draw();
  return () => { clearInterval(poll); timer?.stop(); };
}

/* ---------- find a booking (guests) ---------- */
export function find(app) {
  app.innerHTML = html`<div class="page" style="max-width:460px;margin:0 auto"><h1>Find a booking</h1>
    <form class="card" id="f"><label class="field"><span>Booking reference</span><input name="ref" placeholder="MTXXXXXX" style="text-transform:uppercase" required></label>
      <label class="field"><span>Mobile number used to book</span><input name="phone" inputmode="tel" required></label><button class="btn">Find my ticket</button></form></div>`;
  const f = $('#f', app);
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('button'), async () => {
    const r = await api('/lookup', { method: 'POST', body: formData(f) });
    if (['pending_payment', 'reserved'].includes(r.status)) location.hash = '#/pay/' + r.group_ref; else location.href = r.url;
  }); });
}

/* ---------- my trips ---------- */
export async function myTrips(app) {
  if (!auth.user) { sessionStorage.setItem('mt.next', '#/trips'); location.hash = '#/login'; return; }
  const [list, disputes] = await Promise.all([api('/my/bookings'), api('/my/disputes')]);
  const up = list.filter(b => b.upcoming), past = list.filter(b => !b.upcoming);
  app.innerHTML = html`<div class="page">
    <div class="head"><h1>My trips</h1><a class="btn" href="#/">Book a trip</a></div>
    <h2>Upcoming</h2>${up.length ? up.map(ticketCard) : raw('<div class="empty">No upcoming trips.</div>')}
    <h2>Past and cancelled</h2>${past.length ? past.map(ticketCard) : raw('<div class="empty">Nothing here yet.</div>')}
    <h2>Help requests</h2>
    ${disputes.length ? html`<div class="tablewrap"><table><thead><tr><th>#</th><th>Booking</th><th>Issue</th><th>Status</th><th>Answer</th></tr></thead><tbody>${disputes.map(d => html`<tr><td>${d.id}</td><td class="mono">${d.ref || '—'}</td><td>${d.description}</td><td>${pill(d.status)}</td><td>${d.resolution || ''}${d.refund_amount ? ` Refund ${kwacha(d.refund_amount)}` : ''}</td></tr>`)}</tbody></table></div>` : raw('<div class="empty">No help requests.</div>')}
    <div><button class="btn ghost" data-act="dispute">Report a problem</button></div>
  </div>`;
  app.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const ref = b.dataset.ref, t = list.find(x => x.ref === ref);
    if (b.dataset.act === 'pdf') busy(b, () => download(`/tickets/${ref}/pdf`, `ticket-${ref}.pdf`));
    if (b.dataset.act === 'cancel') cancelFlow(t, () => myTrips(app));
    if (b.dataset.act === 'rate') rateFlow(t, () => myTrips(app));
    if (b.dataset.act === 'dispute') disputeFlow(ref, list, () => myTrips(app));
  });
}
function ticketCard(t) {
  const active = t.seats.filter(s => s.active);
  const canChange = t.status === 'confirmed' && new Date(t.board_at) - Date.now() > 3 * 36e5;
  return html`<article class="ticket">
    <div class="body">
      <div class="row" style="justify-content:space-between">${pill(t.status)}<span class="small muted">${t.operator_name} · ${t.class} · ${t.plate}</span></div>
      <div class="route">${t.from_city} <span class="muted">→</span> ${t.to_city}</div>
      <div class="kv">
        <div><span class="label">Boarding</span><b>${dateTime(t.board_at)}</b><span class="small">${t.from_terminal}</span></div>
        <div><span class="label">Arrival (planned)</span><b>${dateTime(t.arrive_at)}</b><span class="small">${t.to_terminal}</span></div>
        <div><span class="label">Paid</span><b class="num">${kwacha(t.total)}</b><span class="small muted">${t.payment_method || ''}</span></div>
      </div>
      <div class="small">${(active.length ? active : t.seats).map(s => html`<span class="mono">${s.seat_no}</span> ${s.passenger_name}${s.boarded_at ? ' ✓ boarded' : ''} · `)}</div>
      ${t.trip_status === 'delayed' ? html`<div class="notice">Running about ${t.delay_min} minutes late.</div>` : ''}
      <div class="row">
        ${['confirmed', 'completed'].includes(t.status) ? html`<a class="btn sm" href="${t.url}" target="_blank" rel="noopener">Ticket & QR</a><button class="btn ghost sm" data-act="pdf" data-ref="${t.ref}">Download PDF</button>` : ''}
        ${t.status === 'confirmed' ? html`<a class="btn ghost sm" href="#/track/${t.trip_id}">Track bus</a>` : ''}
        ${canChange ? html`<a class="btn ghost sm" href="#/reschedule/${t.ref}">Change date or time</a>` : ''}
        ${['confirmed', 'reserved', 'pending_payment'].includes(t.status) ? html`<button class="btn danger sm" data-act="cancel" data-ref="${t.ref}">Cancel</button>` : ''}
        ${['pending_payment', 'reserved'].includes(t.status) ? html`<a class="btn copper sm" href="#/pay/${t.group_ref}">Pay now</a>` : ''}
        ${t.status === 'completed' && !t.review ? html`<button class="btn copper sm" data-act="rate" data-ref="${t.ref}">Rate this trip</button>` : ''}
        ${t.review ? html`<span class="small muted">You rated: cleanliness ${t.review.cleanliness}★, punctuality ${t.review.punctuality}★, driver ${t.review.driver}★</span>` : ''}
      </div>
    </div>
    <div class="stub"><span class="label">Booking</span><span class="mono" style="font-size:17px;font-weight:700">${t.ref}</span><span class="label">Seats</span><span class="mono">${active.map(s => s.seat_no).join(' ') || '—'}</span></div>
  </article>`;
}
async function cancelFlow(t, done) {
  const q = await api(`/my/bookings/${t.ref}/refund-quote`);
  const m = modal(html`<h2>Cancel ${t.ref}?</h2>
    <p style="margin:0">${t.from_city} → ${t.to_city}, ${dateTime(t.board_at)}. Departure is ${q.hours_to_departure} hours away, so ${t.operator_name}'s policy gives a <b>${q.pct}%</b> refund of the fare. The booking fee is not refunded.</p>
    <div class="tablewrap"><table><thead><tr><th>Cancel at least</th><th>Refund</th></tr></thead><tbody>${q.policy.map(p => html`<tr><td>${p.hours} hours before</td><td>${p.pct}%</td></tr>`)}</tbody></table></div>
    <div class="sumrow total"><span>Refund to your ${t.payment_method === 'card' ? 'card' : 'wallet'}</span><span class="num">${kwacha(q.amount)}</span></div>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Keep booking</button><button class="btn danger" id="yes">Cancel and refund ${kwacha(q.amount)}</button></div>`);
  $('#yes', m.el).addEventListener('click', e => busy(e.target, async () => { const r = await api(`/my/bookings/${t.ref}/cancel`, { method: 'POST' }); m.close(); toast(`Cancelled. Refund ${kwacha(r.refund)} started.`); done(); }));
}
function rateFlow(t, done) {
  const stars = name => html`<label class="field"><span>${name[0].toUpperCase() + name.slice(1)}</span><select name="${name}">${[5, 4, 3, 2, 1].map(n => html`<option value="${n}">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</option>`)}</select></label>`;
  const m = modal(html`<h2>Rate ${t.operator_name}</h2><form id="rf" class="page" style="gap:10px"><div class="grid3">${stars('cleanliness')}${stars('punctuality')}${stars('driver')}</div>
    <label class="field"><span>Comment (optional)</span><textarea name="comment" maxlength="1000"></textarea></label>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Later</button><button class="btn">Send rating</button></div></form>`);
  const f = $('#rf', m.el);
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { await api(`/my/bookings/${t.ref}/review`, { method: 'POST', body: formData(f) }); m.close(); toast('Thanks for rating.'); done(); }); });
}
function disputeFlow(ref, list, done) {
  const m = modal(html`<h2>Report a problem</h2><form id="df" class="page" style="gap:10px">
    <label class="field"><span>Booking</span><select name="ref"><option value="">Not about a specific booking</option>${list.map(b => html`<option value="${b.ref}" ${b.ref === ref ? 'selected' : ''}>${b.ref} · ${b.from_city} → ${b.to_city} · ${day(b.board_at)}</option>`)}</select></label>
    <label class="field"><span>What happened</span><select name="category"><option value="payment_failed">Money was taken but I got no ticket</option><option value="refund">My refund has not arrived</option><option value="trip_cancelled">The bus did not run</option><option value="service">Problem during the trip</option><option value="other">Something else</option></select></label>
    <label class="field"><span>Details (include transaction IDs from your SMS)</span><textarea name="description" required maxlength="2000"></textarea></label>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Close</button><button class="btn">Send</button></div></form>`);
  const f = $('#df', m.el);
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn:not(.ghost)'), async () => { await api('/my/disputes', { method: 'POST', body: formData(f) }); m.close(); toast('Sent. We reply by SMS, usually within one working day.'); done(); }); });
}

/* ---------- reschedule ---------- */
export async function reschedule(app, ref) {
  const list = await api('/my/bookings');
  const b = list.find(x => x.ref === ref);
  if (!b) { app.innerHTML = '<div class="empty">Booking not found.</div>'; return; }
  const n = b.seats.filter(s => s.active).length;
  let picker = null;
  app.innerHTML = html`<div class="page" style="max-width:900px">
    <div><a href="#/trips" class="small">← My trips</a><h1>Change ${ref}</h1></div>
    <div class="notice">Your fare of ${kwacha(b.fare_total - b.discount)} becomes credit. You pay the change fee plus any difference; if the new bus is cheaper, the rest is refunded.</div>
    <div class="card"><div class="row"><label class="field" style="max-width:220px"><span>New date</span><input type="date" id="d" min="${today()}" value="${b.service_date}"></label></div><div id="alts"></div></div>
    <div id="pick"></div>
  </div>`;
  const loadAlts = async () => {
    const alts = await api(`/my/bookings/${ref}/alternatives?date=${$('#d', app).value}`);
    $('#alts', app).innerHTML = alts.length ? html`<div class="chips">${alts.map(a => html`<button class="chip" data-trip="${a.id}">${time(a.depart_at)} · ${a.class} · ${a.plate}</button>`)}</div>` : raw('<div class="empty">No other departures on this date. Try another day.</div>');
  };
  $('#d', app).addEventListener('change', loadAlts);
  $('#alts', app).addEventListener('click', e => {
    const c = e.target.closest('[data-trip]'); if (!c) return;
    picker?.destroy();
    const tripId = Number(c.dataset.trip);
    $('#pick', app).innerHTML = html`<div class="card"><h3>Pick ${n} seat${n > 1 ? 's' : ''}</h3><div id="map"></div><div class="row" style="justify-content:flex-end"><button class="btn copper" id="go" disabled>Move my booking</button></div></div>`;
    picker = seatPicker($('#map', app), { tripId, max: n, onChange: h => { $('#go', app).disabled = h.seats.length !== n; } });
    $('#go', app).addEventListener('click', ev => busy(ev.target, async () => {
      const r = await api(`/my/bookings/${ref}/reschedule`, { method: 'POST', body: { trip_id: tripId, hold_token: picker.token, seats: picker.seats } });
      toast(r.status === 'confirmed' ? `Moved. New booking ${r.ref}.${r.refund ? ` ${kwacha(r.refund)} refunded.` : ''}` : `Pay ${kwacha(r.total)} to confirm the change.`);
      location.hash = r.status === 'confirmed' ? '#/trips' : '#/pay/' + r.group_ref;
    }));
  });
  loadAlts();
  return () => picker?.destroy();
}

/* ---------- live tracking ---------- */
export async function track(app, tripId) {
  app.innerHTML = html`<div class="page"><div class="head"><div><a href="#/trips" class="small">← My trips</a><h1 id="title">Live bus tracking</h1></div><span id="src" class="small muted"></span></div>
    <div class="booking" style="grid-template-columns:minmax(0,2fr) minmax(260px,1fr)"><div id="map" class="map"></div><div class="card"><h3>Stops</h3><div id="stops" class="stoplist"></div></div></div></div>`;
  const L = window.L;
  const map = L.map($('#map', app), { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(map);
  let marker = null, fitted = false;
  const draw = async () => {
    const d = await api(`/trips/${tripId}/track`);
    $('#title', app).textContent = `${d.operator} · ${d.plate}`;
    $('#src', app).innerHTML = html`${pill(d.status)} ${d.source === 'gps' ? `Live GPS, updated ${time(d.updated_at)}` : 'Estimated from the timetable (no GPS signal yet)'}${d.delay_min ? ` · ${d.delay_min} min late` : ''}`;
    if (!fitted) {
      const pts = d.stops.map(s => [s.lat, s.lng]);
      L.polyline(pts, { color: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#146b3a', weight: 4, opacity: .7 }).addTo(map);
      d.stops.forEach(s => L.circleMarker([s.lat, s.lng], { radius: 5 }).addTo(map).bindTooltip(`${s.terminal}, ${s.city}`));
      map.fitBounds(pts, { padding: [30, 30] }); fitted = true;
    }
    const icon = L.divIcon({ className: '', html: '<div style="background:#b8611c;color:#fff;border-radius:6px;padding:2px 6px;font:700 12px sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.4)">BUS</div>' });
    marker ? marker.setLatLng([d.position.lat, d.position.lng]) : (marker = L.marker([d.position.lat, d.position.lng], { icon }).addTo(map));
    $('#stops', app).innerHTML = d.stops.map(s => html`<div class="${s.passed ? 'passed' : ''}"><span class="dot"></span><span><b>${s.city}</b><br><span class="small muted">${s.terminal}</span></span>
      <span class="num small" style="text-align:right">${s.passed ? 'passed' : s.eta ? `ETA ${time(s.eta)}` : time(s.planned)}<br><span class="muted">planned ${time(s.planned)}</span></span></div>`).join('');
  };
  await draw();
  const h = setInterval(() => draw().catch(() => {}), 15000);
  return () => { clearInterval(h); map.remove(); };
}
