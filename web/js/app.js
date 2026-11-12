import { $, html, raw, api, auth, toast, busy, formData } from './core.js';
import * as passenger from './passenger.js';
import * as operator from './operator.js';
import * as admin from './admin.js';

const app = $('#app');
let cleanup = null;

const PORTAL_HOME = { admin: '#/admin/overview', operator: '#/op/dashboard', clerk: '#/op/counter', conductor: '#/op/trips', passenger: '#/' };

function nav() {
  const u = auth.user;
  const here = location.hash || '#/';
  const link = (href, label) => html`<a href="${href}" class="${here.startsWith(href) && href !== '#/' || here === href ? 'on' : ''}">${label}</a>`;
  let links = [];
  if (!u || u.role === 'passenger') links = [link('#/', 'Search buses'), u ? link('#/trips', 'My trips') : '', link('#/find', 'Find a booking')];
  else if (u.role === 'admin') links = [link('#/admin/overview', 'Admin')];
  else links = [link(PORTAL_HOME[u.role], u.operator_name || 'Company'), u.role !== 'clerk' ? html`<a href="/agent.html">Field app</a>` : ''];
  $('#nav').innerHTML = [...links, u ? html`<span class="small" style="opacity:.8;padding:0 6px">${u.name.split(' (')[0]}</span><button id="logout">Sign out</button>` : link('#/login', 'Sign in')].join('');
  $('#logout')?.addEventListener('click', () => { auth.clear(); location.hash = '#/'; toast('Signed out.'); });
}

const routes = [
  [/^#\/?$/, () => passenger.home(app)],
  [/^#\/search\?(.*)$/, m => passenger.results(app, new URLSearchParams(m[1]))],
  [/^#\/seats$/, () => passenger.seats(app)],
  [/^#\/checkout$/, () => passenger.checkout(app)],
  [/^#\/pay\/(\w+)$/, m => passenger.pay(app, m[1])],
  [/^#\/trips$/, () => passenger.myTrips(app)],
  [/^#\/find$/, () => passenger.find(app)],
  [/^#\/track\/(\d+)$/, m => passenger.track(app, Number(m[1]))],
  [/^#\/reschedule\/(\w+)$/, m => passenger.reschedule(app, m[1])],
  [/^#\/login$/, () => loginPage()],
  [/^#\/register$/, () => registerPage()],
  [/^#\/join$/, () => joinPage()],
  [/^#\/op\/(\w+)(?:\/(.*))?$/, m => operator.render(app, m[1], m[2])],
  [/^#\/admin\/(\w+)$/, m => admin.render(app, m[1])],
];

async function route() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  nav();
  const h = location.hash || '#/';
  const u = auth.user;
  // Staff land in their portal; passengers cannot open staff pages.
  if (u && u.role !== 'passenger' && (h === '#/' || h === '#')) { location.replace(PORTAL_HOME[u.role]); return; }
  if (h.startsWith('#/admin') && u?.role !== 'admin') { location.hash = '#/login'; return; }
  if (h.startsWith('#/op') && !['operator', 'clerk', 'conductor'].includes(u?.role)) { location.hash = '#/login'; return; }
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) {
      try { cleanup = await fn(m) || null; }
      catch (e) { app.innerHTML = html`<div class="notice bad">${e.message}</div>`; console.error(e); }
      window.scrollTo(0, 0);
      return;
    }
  }
  app.innerHTML = '<div class="empty">Page not found. <a href="#/">Search buses</a></div>';
}
addEventListener('hashchange', route);
route();

/* ---------- auth pages ---------- */
function afterLogin({ token, user }) {
  auth.set(token, user);
  const next = sessionStorage.getItem('mt.next');
  sessionStorage.removeItem('mt.next');
  location.hash = next || PORTAL_HOME[user.role];
  toast(`Signed in as ${user.name.split(' (')[0]}.`);
}

function loginPage() {
  app.innerHTML = html`<div class="page" style="max-width:420px;margin:0 auto">
    <h1>Sign in</h1>
    <form class="card" id="f">
      <label class="field"><span>Mobile number</span><input name="phone" inputmode="tel" autocomplete="tel" placeholder="0971 234 567" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn">Sign in</button>
      <p class="small muted" style="margin:0">New here? <a href="#/register">Create a passenger account</a> · Bus company? <a href="#/join">Register your company</a></p>
    </form>
    <details class="card flat"><summary class="small">Demo accounts (development data, password <span class="mono">demo1234</span>)</summary>
      <div class="small" style="display:grid;gap:4px">${raw([
        ['Passenger', '0971234567'], ['Bus owner (Zambezi Coaches)', '0960000002'], ['Station clerk', '0960000003'], ['Conductor', '0970000004'], ['Platform admin', '0950000001'], ['Owner awaiting approval', '0960000020'],
      ].map(([r, p]) => `<button type="button" class="btn ghost sm" data-demo="${p}" style="justify-content:space-between"><span>${r}</span><span class="mono">${p}</span></button>`).join(''))}</div>
    </details>
  </div>`;
  const f = $('#f');
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('button'), async () => afterLogin(await api('/auth/login', { method: 'POST', body: formData(f) }))); });
  app.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', () => { f.phone.value = b.dataset.demo; f.password.value = 'demo1234'; f.requestSubmit(); }));
}

function registerPage() {
  app.innerHTML = html`<div class="page" style="max-width:460px;margin:0 auto">
    <h1>Create an account</h1>
    <p class="muted" style="margin:0">See your trips in one place, reschedule and get refunds without calling anyone. Earlier bookings made with this number appear automatically.</p>
    <form class="card" id="f">
      <label class="field"><span>Full name</span><input name="name" autocomplete="name" required></label>
      <label class="field"><span>Mobile number</span><input name="phone" inputmode="tel" autocomplete="tel" placeholder="0971 234 567" required></label>
      <label class="field"><span>Email (optional, for e-tickets)</span><input name="email" type="email" autocomplete="email"></label>
      <label class="field"><span>Password (8+ characters)</span><input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
      <button class="btn">Create account</button>
    </form>
  </div>`;
  const f = $('#f');
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('button'), async () => afterLogin(await api('/auth/register', { method: 'POST', body: formData(f) }))); });
}

function joinPage() {
  app.innerHTML = html`<div class="page" style="max-width:560px;margin:0 auto">
    <h1>Sell your bus seats on MyTicket</h1>
    <p class="muted" style="margin:0">Register your company, then upload your PACRA certificate, RTSA road service licence and ZRA tax clearance. We verify them before your buses go live, usually within two working days.</p>
    <form class="card" id="f">
      <div class="grid2">
        <label class="field"><span>Company name</span><input name="company_name" required></label>
        <label class="field"><span>PACRA registration no.</span><input name="pacra_no"></label>
        <label class="field"><span>ZRA TPIN</span><input name="tpin" inputmode="numeric"></label>
        <label class="field"><span>Company email</span><input name="email" type="email"></label>
        <label class="field"><span>Your name</span><input name="name" required></label>
        <label class="field"><span>Your mobile number</span><input name="phone" inputmode="tel" required></label>
      </div>
      <label class="field"><span>Password (8+ characters)</span><input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
      <button class="btn">Register company</button>
    </form>
  </div>`;
  const f = $('#f');
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('button'), async () => { afterLogin(await api('/auth/register-operator', { method: 'POST', body: formData(f) })); location.hash = '#/op/company'; }); });
}
