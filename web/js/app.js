import { $, html, raw, api, auth, toast, busy, formData } from './core.js';
import * as passenger from './passenger.js';
import * as operator from './operator.js';
import * as admin from './admin.js';
import { t, getLang, setLang, LANGS } from './i18n.js';

const app = $('#app');
let cleanup = null;

const PORTAL_HOME = { admin: '#/admin/overview', operator: '#/op/dashboard', clerk: '#/op/counter', conductor: '#/op/trips', passenger: '#/' };

function nav() {
  const u = auth.user;
  const here = location.hash || '#/';
  const link = (href, label) => html`<a href="${href}" class="${here.startsWith(href) && href !== '#/' || here === href ? 'on' : ''}">${label}</a>`;
  let links = [];
  if (!u || u.role === 'passenger') links = [link('#/', t('nav.search')), u ? link('#/trips', t('nav.trips')) : '', link('#/find', t('nav.find')),
    html`<select id="lang" aria-label="${t('lang')}" style="width:auto;padding:4px 6px;background:transparent;color:inherit;border-color:rgba(255,255,255,.4)">${Object.entries(LANGS).map(([k, v]) => html`<option value="${k}" ${getLang() === k ? 'selected' : ''} style="color:#000">${v}</option>`)}</select>`];
  else if (u.role === 'admin') links = [link('#/admin/overview', 'Admin')];
  else links = [link(PORTAL_HOME[u.role], u.operator_name || 'Company'), u.role !== 'clerk' ? html`<a href="/agent.html">Field app</a>` : ''];
  $('#nav').innerHTML = [...links, u ? html`<span class="small" style="opacity:.8;padding:0 6px">${u.name.split(' (')[0]}</span><button id="logout">${t('nav.signout')}</button>` : link('#/login', t('nav.signin'))].join('');
  $('#lang')?.addEventListener('change', e => {
    setLang(e.target.value);
    document.documentElement.lang = e.target.value;
    if (auth.user) api('/me', { method: 'PUT', body: { lang: e.target.value } }).catch(() => {}); // SMS in the same language
    route();
  });
  $('#logout')?.addEventListener('click', () => { auth.clear(); location.hash = '#/'; toast('Signed out.'); });
}

const routes = [
  [/^#\/?$/, (_m, v) => passenger.home(v)],
  [/^#\/search\?(.*)$/, (m, v) => passenger.results(v, new URLSearchParams(m[1]))],
  [/^#\/seats$/, (_m, v) => passenger.seats(v)],
  [/^#\/checkout$/, (_m, v) => passenger.checkout(v)],
  [/^#\/pay\/(\w+)$/, (m, v) => passenger.pay(v, m[1])],
  [/^#\/trips$/, (_m, v) => passenger.myTrips(v)],
  [/^#\/find$/, (_m, v) => passenger.find(v)],
  [/^#\/offer\/(\d+-[\w-]+)$/, (m, v) => passenger.offer(v, m[1])],
  [/^#\/track\/(\d+)$/, (m, v) => passenger.track(v, Number(m[1]))],
  [/^#\/reschedule\/(\w+)$/, (m, v) => passenger.reschedule(v, m[1])],
  [/^#\/login$/, (_m, v) => loginPage(v)],
  [/^#\/register$/, (_m, v) => registerPage(v)],
  [/^#\/join$/, (_m, v) => joinPage(v)],
  [/^#\/forgot$/, (_m, v) => forgotPage(v)],
  [/^#\/verify$/, (_m, v) => verifyPage(v)],
  [/^#\/op\/(\w+)(?:\/(.*))?$/, (m, v) => operator.render(v, m[1], m[2])],
  [/^#\/admin\/(\w+)$/, (m, v) => admin.render(v, m[1])],
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
      // Each navigation renders into its own container, so a slow, older screen can never draw over a newer one.
      const view = document.createElement('div');
      app.replaceChildren(view);
      try { const c = await fn(m, view) || null; if (view.isConnected) cleanup = c; else c?.(); }
      catch (e) { if (view.isConnected) view.innerHTML = html`<div class="notice bad">${e.message}</div>`; console.error(e); }
      window.scrollTo(0, 0);
      return;
    }
  }
  app.replaceChildren(); app.innerHTML = '<div class="empty">Page not found. <a href="#/">Search buses</a></div>';
}
addEventListener('hashchange', route);
route();

/* ---------- auth pages ---------- */
function afterLogin({ token, user }) {
  auth.set(token, user);
  if (user.role === 'passenger' && user.lang && user.lang !== 'en') setLang(user.lang);
  const next = sessionStorage.getItem('mt.next');
  sessionStorage.removeItem('mt.next');
  location.hash = next || PORTAL_HOME[user.role];
  toast(`Signed in as ${user.name.split(' (')[0]}.`);
}

function loginPage(app) {
  app.innerHTML = html`<div class="page" style="max-width:420px;margin:0 auto">
    <h1>Sign in</h1>
    <form class="card" id="f">
      <label class="field"><span>Mobile number</span><input name="phone" inputmode="tel" autocomplete="tel" placeholder="0971 234 567" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn">Sign in</button>
      <p class="small muted" style="margin:0"><a href="#/forgot">Forgot your password?</a> · New here? <a href="#/register">Create a passenger account</a> · Bus company? <a href="#/join">Register your company</a></p>
    </form>
    <details class="card flat"><summary class="small">Demo accounts (development data, password <span class="mono">demo1234</span>)</summary>
      <div class="small" style="display:grid;gap:4px">${raw([
        ['Passenger', '0971234567'], ['Bus owner (Zambezi Coaches)', '0960000002'], ['Station clerk', '0960000003'], ['Conductor', '0970000004'], ['Platform admin', '0950000001'], ['Owner awaiting approval', '0960000020'],
      ].map(([r, p]) => `<button type="button" class="btn ghost sm" data-demo="${p}" style="justify-content:space-between"><span>${r}</span><span class="mono">${p}</span></button>`).join(''))}</div>
    </details>
  </div>`;
  const f = $('#f', app);
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('button'), async () => afterLogin(await api('/auth/login', { method: 'POST', body: formData(f) }))); });
  app.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', () => { f.phone.value = b.dataset.demo; f.password.value = 'demo1234'; f.requestSubmit(); }));
}

function registerPage(app) {
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
  const f = $('#f', app);
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('button'), async () => {
    const r = await api('/auth/register', { method: 'POST', body: { ...formData(f), lang: getLang() } });
    auth.set(r.token, r.user);
    if (r.dev_code) sessionStorage.setItem('mt.devcode', r.dev_code);
    location.hash = '#/verify';
  }); });
}

/** Confirm the phone number with the SMS code. Earlier guest bookings on this number are added afterwards. */
function verifyPage(app) {
  const u = auth.user;
  if (!u) { location.hash = '#/login'; return; }
  const dev = sessionStorage.getItem('mt.devcode'); sessionStorage.removeItem('mt.devcode');
  app.innerHTML = html`<div class="page" style="max-width:420px;margin:0 auto"><h1>Confirm your phone</h1>
    <p class="muted" style="margin:0">We sent a 6-digit code by SMS to 0${u.phone.slice(3)}. It expires in 5 minutes.</p>
    ${dev ? html`<div class="notice small">Development mode (no real SMS): the code is <b class="mono">${dev}</b></div>` : ''}
    <form class="card" id="f"><label class="field"><span>Code</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
      <button class="btn">Confirm</button><button type="button" class="btn ghost" id="resend">Send a new code</button><a href="${PORTAL_HOME[u.role]}" class="small">Do this later</a></form></div>`;
  const f = $('#f', app);
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('.btn'), async () => {
    const r = await api('/auth/verify-phone', { method: 'POST', body: formData(f) });
    auth.set(auth.token, { ...u, phone_verified: 1 });
    toast(r.linked_bookings ? `Phone confirmed. ${r.linked_bookings} earlier booking(s) added to My trips.` : 'Phone confirmed.');
    location.hash = PORTAL_HOME[u.role];
  }); });
  $('#resend', app).addEventListener('click', e => busy(e.target, async () => { const r = await api('/auth/otp', { method: 'POST', body: { purpose: 'verify' } }); toast(r.dev_code ? `New code (development): ${r.dev_code}` : 'New code sent.'); }));
}

/** Password reset by SMS code. */
function forgotPage(app) {
  app.innerHTML = html`<div class="page" style="max-width:420px;margin:0 auto"><h1>Reset your password</h1>
    <form class="card" id="a"><label class="field"><span>Mobile number</span><input name="phone" inputmode="tel" autocomplete="tel" required></label><button class="btn">Send me a code</button></form>
    <form class="card" id="b" hidden><p class="small muted" style="margin:0" id="msg"></p>
      <label class="field"><span>Code from the SMS</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
      <label class="field"><span>New password (8+ characters)</span><input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
      <button class="btn">Set new password</button></form></div>`;
  const a = $('#a', app), b = $('#b', app);
  a.addEventListener('submit', e => { e.preventDefault(); busy(a.querySelector('button'), async () => {
    const r = await api('/auth/otp', { method: 'POST', body: { purpose: 'reset', phone: a.phone.value } });
    b.hidden = false; $('#msg', app).textContent = r.message + (r.dev_code ? ` (Development code: ${r.dev_code})` : '');
    b.code.focus();
  }); });
  b.addEventListener('submit', e => { e.preventDefault(); busy(b.querySelector('button'), async () => {
    await api('/auth/password/reset', { method: 'POST', body: { phone: a.phone.value, ...formData(b) } });
    auth.clear(); toast('Password changed. Every device was signed out. Sign in with the new password.'); location.hash = '#/login';
  }); });
}

function joinPage(app) {
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
  const f = $('#f', app);
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('button'), async () => {
    const r = await api('/auth/register-operator', { method: 'POST', body: formData(f) });
    auth.set(r.token, r.user);
    if (r.dev_code) sessionStorage.setItem('mt.devcode', r.dev_code);
    location.hash = '#/verify';
  }); });
}
