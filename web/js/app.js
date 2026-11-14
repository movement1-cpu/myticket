import { $, html, raw, api, auth, toast, busy, formData, modal, download } from './core.js';
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
  $('#nav').innerHTML = [...links, u ? html`<a href="#/security" class="small" title="Password, two-step sign-in and devices" style="opacity:.85">${u.name.split(' (')[0]} · Security</a><button id="logout">${t('nav.signout')}</button>` : link('#/login', t('nav.signin'))].join('');
  $('#lang')?.addEventListener('change', e => {
    setLang(e.target.value);
    document.documentElement.lang = e.target.value;
    if (auth.user) api('/me', { method: 'PUT', body: { lang: e.target.value } }).catch(() => {}); // SMS in the same language
    route();
  });
  $('#logout')?.addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); auth.clear(); location.hash = '#/'; toast('Signed out.'); });
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
  [/^#\/security$/, (_m, v) => securityPage(v)],
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
// The cached profile may be stale (signed out elsewhere, session expired): check once on load.
if (auth.user) api('/me').then(u => auth.set(null, { ...auth.user, ...u })).catch(e => { if (e.status === 401) auth.clear(); }).finally(route); else route();

/* ---------- auth pages ---------- */
function afterLogin({ user }) {
  auth.set(null, user);
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
        ['Passenger', '0971234567'], ['Bus owner (Zambezi Coaches)', '0960000002'], ['Station clerk', '0960000003'], ['Conductor', '0970000004'], ['Platform admin (two-step)', '0950000001'], ['Second admin (approver)', '0950000002'], ['Owner awaiting approval', '0960000020'],
      ].map(([r, p]) => `<button type="button" class="btn ghost sm" data-demo="${p}" style="justify-content:space-between"><span>${r}</span><span class="mono">${p}</span></button>`).join(''))}</div>
    </details>
  </div>`;
  const f = $('#f', app);
  f.addEventListener('submit', e => { e.preventDefault(); busy(f.querySelector('button'), async () => {
    const r = await api('/auth/login', { method: 'POST', body: formData(f) });
    if (r.mfa_required) secondStep(app, r); else afterLogin(r);
  }); });
  app.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', () => { f.phone.value = b.dataset.demo; f.password.value = 'demo1234'; f.requestSubmit(); }));
}

/** Second sign-in step: authenticator code, SMS code or a recovery code. */
function secondStep(app, r) {
  const label = { totp: 'Authenticator app', sms: 'SMS code', recovery: 'Recovery code' };
  app.innerHTML = html`<div class="page" style="max-width:420px;margin:0 auto"><h1>Confirm it's you</h1>
    <p class="muted" style="margin:0">${r.user.name.split(' (')[0]}, enter a code to finish signing in.</p>
    <form class="card" id="m">
      <div class="chips">${r.methods.map((m, i) => html`<label class="chip"><input type="radio" name="method" value="${m}" ${i ? '' : 'checked'}>${label[m]}</label>`)}</div>
      <div id="smsrow" hidden><button type="button" class="btn ghost sm" id="send">Send me a code by SMS</button> <span class="small muted" id="sent"></span></div>
      <label class="field"><span>Code</span><input name="code" autocomplete="one-time-code" maxlength="12" required></label>
      <button class="btn">Continue</button></form>
    <p class="small muted">Lost your phone? Use a recovery code, or ask another platform admin to help.</p></div>`;
  const m = $('#m', app);
  const sync = () => { $('#smsrow', app).hidden = m.method.value !== 'sms'; m.code.inputMode = m.method.value === 'recovery' ? 'text' : 'numeric'; };
  m.addEventListener('change', sync); sync();
  $('#send', app).addEventListener('click', e => busy(e.target, async () => {
    const s = await api('/auth/mfa/sms', { method: 'POST' });
    $('#sent', app).textContent = `Sent to ${s.sent_to}${s.dev_code ? ` (development code: ${s.dev_code})` : ''}`;
  }));
  m.addEventListener('submit', e => { e.preventDefault(); busy(m.querySelector('.btn:not(.sm)'), async () => {
    const v = await api('/auth/mfa/verify', { method: 'POST', body: formData(m) });
    afterLogin({ user: v.user });
  }); });
  m.code.focus();
}

/** Account security: password, authenticator app, recovery codes, signed-in devices. */
async function securityPage(app) {
  if (!auth.user) { location.hash = '#/login'; return; }
  const [sec, sessions] = await Promise.all([api('/auth/security'), api('/auth/sessions')]);
  app.innerHTML = html`<div class="page" style="max-width:760px;margin:0 auto">
    <h1>Security</h1>
    ${sec.phone_verified ? '' : html`<a class="notice" href="#/verify" style="color:inherit;display:block">Your phone number is not confirmed yet. <b>Confirm it</b></a>`}
    <section class="card"><h3>Two-step sign-in</h3>
      ${sec.totp_enabled ? html`<p style="margin:0"><span class="pill ok">On</span> Authenticator app. ${sec.recovery_codes_left} recovery code${sec.recovery_codes_left === 1 ? '' : 's'} left.</p>
          <form id="off" class="row"><label class="field"><span>Password</span><input type="password" name="password" required autocomplete="current-password"></label>
          <label class="field"><span>Authenticator code</span><input name="code" inputmode="numeric" maxlength="6" required></label><button class="btn danger">Turn off</button></form>`
        : html`<p class="muted" style="margin:0">${sec.mfa_required ? 'Your account always needs a second step. Right now that is an SMS code. An authenticator app is safer: it works without signal and cannot be intercepted.' : 'Add an authenticator app (Google Authenticator, Microsoft Authenticator…). Then signing in needs your password and a code from your phone.'}</p>
          <div><button class="btn" id="setup">Set up an authenticator app</button></div><div id="enroll"></div>`}
    </section>
    <form class="card" id="pw"><h3>Change password</h3><div class="grid2">
      <label class="field"><span>Current password</span><input type="password" name="current_password" autocomplete="current-password" required></label>
      <label class="field"><span>New password (8+ characters)</span><input type="password" name="password" minlength="8" autocomplete="new-password" required></label></div>
      <p class="small muted" style="margin:0">Your other devices are signed out and you get an SMS.</p><div><button class="btn">Change password</button></div></form>
    ${auth.user.role === 'passenger' ? html`<section class="card"><h3>Your data</h3>
      <p class="small muted" style="margin:0">Download everything we hold about you. ID numbers are stored encrypted and erased 30 days after each trip.</p>
      <div class="row"><button class="btn ghost" id="export">Download my data</button><button class="btn danger" id="del">Delete my account</button></div></section>` : ''}
    <section class="card"><div class="head"><h3>Signed-in devices</h3><button class="btn danger sm" id="all">Sign out everywhere else</button></div>
      <div class="tablewrap"><table><tbody>${sessions.map(x => html`<tr><td><b>${x.device}</b>${x.current ? raw(' <span class="pill ok">this device</span>') : ''}<br><span class="small muted">${x.ip || ''}</span></td>
        <td class="small">Signed in ${x.created_at.slice(0, 16)}<br>Last active ${x.last_seen.slice(0, 16)}</td><td>${x.current ? '' : html`<button class="btn ghost sm" data-out="${x.id}">Sign out</button>`}</td></tr>`)}</tbody></table></div></section>
  </div>`;
  const reload = () => securityPage(app);
  $('#export', app)?.addEventListener('click', e => busy(e.target, () => download('/my/data', 'myticket-my-data.json')));
  $('#del', app)?.addEventListener('click', () => {
    const m = modal(html`<h2>Delete your account?</h2><p style="margin:0">Your name, phone number, email and ID numbers are removed. Trip and payment records stay without your name, because bus companies and the tax authority need them. You cannot undo this.</p>
      <form id="df" class="page" style="gap:10px"><label class="field"><span>Your password</span><input type="password" name="password" required autocomplete="current-password"></label>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Keep my account</button><button class="btn danger">Delete my account</button></div></form>`);
    const f = $('#df', m.el);
    f.addEventListener('submit', ev => { ev.preventDefault(); busy(f.querySelector('.danger'), async () => { await api('/my/account/delete', { method: 'POST', body: formData(f) }); m.close(); auth.clear(); toast('Your account was deleted.'); location.hash = '#/'; }); });
  });
  $('#setup', app)?.addEventListener('click', e => busy(e.target, async () => {
    const s = await api('/auth/totp/setup', { method: 'POST' });
    $('#enroll', app).innerHTML = html`<div class="grid2" style="align-items:center"><div style="background:#fff;border-radius:8px;padding:8px;max-width:220px">${raw(s.qr_svg)}</div>
      <div class="page" style="gap:8px"><p class="small" style="margin:0">1. Scan this code with your authenticator app, or type the key: <span class="mono" style="word-break:break-all">${s.secret}</span></p>
      <form id="en" class="page" style="gap:8px"><label class="field"><span>2. Enter the 6-digit code it shows</span><input name="code" inputmode="numeric" maxlength="6" required></label><button class="btn">Turn on</button></form></div></div>`;
    const en = $('#en', app);
    en.addEventListener('submit', ev => { ev.preventDefault(); busy(en.querySelector('button'), async () => {
      const r = await api('/auth/totp/enable', { method: 'POST', body: formData(en) });
      $('#enroll', app).innerHTML = html`<div class="notice ok"><b>Two-step sign-in is on.</b> Save these recovery codes somewhere safe (paper is fine). Each works once if you lose your phone. They are not shown again.
        <div class="mono" style="display:grid;grid-template-columns:repeat(4,auto);gap:6px 16px;margin-top:8px">${r.recovery_codes.map(c => html`<span>${c}</span>`)}</div>
        <div style="margin-top:8px"><button class="btn sm" id="done">I saved them</button></div></div>`;
      $('#done', app).addEventListener('click', reload);
    }); });
  }));
  const off = $('#off', app);
  off?.addEventListener('submit', e => { e.preventDefault(); busy(off.querySelector('button'), async () => { await api('/auth/totp/disable', { method: 'POST', body: formData(off) }); toast('Authenticator app turned off.'); reload(); }); });
  const pw = $('#pw', app);
  pw.addEventListener('submit', e => { e.preventDefault(); busy(pw.querySelector('button'), async () => { await api('/auth/password/change', { method: 'POST', body: formData(pw) }); toast('Password changed. Other devices were signed out.'); reload(); }); });
  $('#all', app).addEventListener('click', e => busy(e.target, async () => { const r = await api('/auth/logout-all', { method: 'POST' }); toast(`Signed out ${r.signed_out} other session${r.signed_out === 1 ? '' : 's'}.`); reload(); }));
  app.addEventListener('click', e => { const b = e.target.closest('[data-out]'); if (b) busy(b, async () => { await api('/auth/sessions/' + b.dataset.out, { method: 'DELETE' }); reload(); }); });
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
    auth.set(null, { ...u, phone_verified: 1 });
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
