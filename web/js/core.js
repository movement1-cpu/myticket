// Shared helpers: API client, auth state, templating, formatting, modals, toasts.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);
/** Already-escaped HTML. Converts to a string wherever a string is expected (innerHTML, join, `${}`). */
class SafeHtml { constructor(s) { this.s = s; } toString() { return this.s; } }
/** Tagged template that escapes interpolations. Nested html`` results and raw() pass through unescaped. */
export function html(strings, ...vals) {
  return new SafeHtml(strings.reduce((out, s, i) => out + s + (i < vals.length ? fmtVal(vals[i]) : ''), ''));
}
export const raw = s => new SafeHtml(String(s ?? ''));
function fmtVal(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(fmtVal).join('');
  if (v instanceof SafeHtml) return v.s;
  return esc(v);
}

/* ---------- auth ---------- */
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
// The session itself lives in an HttpOnly cookie that scripts cannot read. Only the (non-secret) profile is cached here.
export const auth = {
  get token() { return null; },
  get user() { return store.get('mt.user'); },
  set(_token, user) { store.set('mt.token', null); store.set('mt.user', user); },
  clear() { store.set('mt.token', null); store.set('mt.user', null); },
};

/* ---------- API ---------- */
export class ApiError extends Error { constructor(status, body) { super(body?.error || `Request failed (${status})`); this.status = status; this.code = body?.code; } }
export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    // X-MT-CSRF: the server refuses cookie-authenticated changes without it (other sites cannot add it).
    headers: { 'X-MT-CSRF': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.blob();
  if (res.status === 401 && auth.user && !path.startsWith('/auth/') && path !== '/me' && !location.pathname.startsWith('/agent')) {
    if (data?.code === 'mfa_required') location.hash = '#/login';
    else { auth.clear(); sessionStorage.setItem('mt.next', location.hash); location.hash = '#/login'; }
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
/** Download a protected file (manifest CSV, PDF ticket, document) with the auth header. */
export async function download(path, filename) {
  const blob = await api(path);
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export async function openBlob(path) {
  const blob = await api(path);
  window.open(URL.createObjectURL(blob), '_blank', 'noopener');
}

/* ---------- formatting (Africa/Lusaka) ---------- */
const TZ = 'Africa/Lusaka';
export const kwacha = n => 'K' + Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const kw0 = n => 'K' + Math.round(Number(n || 0)).toLocaleString('en-ZM');
export const time = iso => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
export const day = iso => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
export const dayOf = date => new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export const dateTime = iso => `${day(iso)} ${time(iso)}`;
export const dur = m => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
export const plusDays = (date, n) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const phoneFmt = p => p ? `0${String(p).slice(3, 5)} ${String(p).slice(5, 8)} ${String(p).slice(8)}` : '';

const STATUS = {
  confirmed: 'ok', completed: 'idle', reserved: 'warn', pending_payment: 'warn', cancelled: 'bad', expired: 'idle',
  scheduled: 'idle', boarding: 'info', departed: 'ok', delayed: 'warn', arrived: 'idle',
  approved: 'ok', pending: 'warn', suspended: 'bad', rejected: 'bad', verified: 'ok', submitted: 'warn',
  open: 'warn', resolved: 'ok', requested: 'warn', paid: 'ok', failed: 'bad', success: 'ok', initiated: 'info',
  active: 'ok', maintenance: 'warn', retired: 'idle', overdue: 'bad', soon: 'warn', 'not set': 'idle', received: 'info', loaded: 'info', in_transit: 'info', collected: 'ok', sent: 'ok', queued: 'warn',
};
export const pill = s => html`<span class="pill ${STATUS[s] || 'idle'}">${String(s).replace(/_/g, ' ')}</span>`;

/* ---------- UI ---------- */
export function toast(msg, bad = false) {
  const t = Object.assign(document.createElement('div'), { className: 'toast' + (bad ? ' bad' : ''), textContent: msg });
  t.setAttribute('role', 'status');
  document.body.append(t);
  setTimeout(() => t.remove(), bad ? 5000 : 3000);
}
export function modal(content, { wide = false } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${content}</div>`;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(ov);
  ov.querySelector('input, select, textarea, button')?.focus();
  return { el: ov.firstElementChild, close };
}
// Errors already shown to the person (toast) are not "unhandled".
addEventListener('unhandledrejection', e => { if (e.reason?.shown) e.preventDefault(); });

/** Run an async action from a button: disable it, show errors as a toast. */
export async function busy(btn, fn) {
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try { return await fn(); }
  catch (e) { toast(e.message, true); try { e.shown = true; } catch {} throw e; }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}
export const formData = form => Object.fromEntries(new FormData(form).entries());
export const fileToUpload = file => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res({ filename: file.name, mime: file.type, data: String(r.result) });
  r.onerror = rej;
  r.readAsDataURL(file);
});

/** Tiny bar chart. data: [{label, value, tip}] */
export function bars(data, { fmt = v => v } = {}) {
  if (!data.length) return '<div class="empty">No data in this period yet.</div>';
  const max = Math.max(...data.map(d => d.value), 1);
  return `<div class="bars">${data.map(d => `<div style="height:${(d.value / max) * 100}%" data-tip="${esc(d.label)}: ${esc(fmt(d.value))}"></div>`).join('')}</div>
    <div class="axis"><span>${esc(data[0].label)}</span><span>max ${esc(fmt(max))}</span><span>${esc(data.at(-1).label)}</span></div>`;
}
export const meter = pct => `<div class="row" style="gap:8px;align-items:center;flex-wrap:nowrap"><div class="meter" style="flex:1"><i style="width:${Math.min(100, pct)}%"></i></div><span class="num small">${Math.round(pct)}%</span></div>`;
