import crypto from 'node:crypto';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const bad = (msg, code) => new HttpError(400, msg, code);
export const notFound = (what = 'Not found.') => new HttpError(404, what);
export const forbidden = (msg = 'You do not have access to this.') => new HttpError(403, msg);
export const conflict = (msg, code) => new HttpError(409, msg, code);

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function ref(prefix = '', len = 6) {
  const bytes = crypto.randomBytes(len);
  return prefix + Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}

export const money = n => Math.round(n * 100) / 100;
export const nowIso = () => new Date().toISOString();
export const addMinutes = (d, m) => new Date(new Date(d).getTime() + m * 60000);

function parseOffset(s) { const m = /([+-])(\d\d):(\d\d)/.exec(s); return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]); }
/** Local (Africa/Lusaka) date string YYYY-MM-DD. */
export function localDate(d = new Date()) {
  return new Date(new Date(d).getTime() + parseOffset(config.timezoneOffset) * 60000).toISOString().slice(0, 10);
}
export function localTime(d) {
  return new Date(new Date(d).getTime() + parseOffset(config.timezoneOffset) * 60000).toISOString().slice(11, 16);
}
export function localToUtc(date, time) {
  return new Date(`${date}T${time}:00${config.timezoneOffset}`).toISOString();
}
/** ISO weekday 1=Mon..7=Sun for YYYY-MM-DD */
export function isoWeekday(date) { const d = new Date(date + 'T12:00:00Z').getUTCDay(); return d === 0 ? 7 : d; }
export function addDays(date, n) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

export function sign(data) {
  return crypto.createHmac('sha256', config.secret).update(data).digest('base64url');
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Normalise a Zambian mobile number to 2609XXXXXXXX / 2607XXXXXXXX. Accepts 09…, 9…, +260…, 260… */
export function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  let n = d;
  if (d.startsWith('0') && d.length === 10) n = '260' + d.slice(1);
  else if (d.length === 9) n = '260' + d;
  if (!/^260[79]\d{8}$/.test(n)) throw bad('Enter a Zambian mobile number, for example 0971234567.', 'phone');
  return n;
}
/** Mobile money network for a Zambian number, by prefix. */
export function networkOf(msisdn) {
  const p = msisdn.slice(3, 5);
  if (['96', '76'].includes(p)) return 'mtn';
  if (['97', '77'].includes(p)) return 'airtel';
  if (['95', '75'].includes(p)) return 'zamtel';
  return null;
}

export function haversineKm(a, b) {
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function required(body, fields) {
  for (const f of fields) {
    const v = body?.[f];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) throw bad(`Missing ${f.replace(/_/g, ' ')}.`, f);
  }
}
export function int(v, name = 'Value') {
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${name} must be a whole number.`);
  return n;
}
export const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
export const isTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
