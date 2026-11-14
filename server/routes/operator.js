import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tx, setting } from '../db.js';
import { config } from '../config.js';
import { requireRole, requireApprovedOperator, hashPassword, revokeAllSessions } from '../auth.js';
import { bad, notFound, conflict, forbidden, required, normPhone, isDate, isTime, ref, uniqueRef, money, localDate, localTime, addDays } from '../util.js';
import { ensureTrips, routeStops } from '../services/trips.js';
import { createBookings, settleAtCounter, cancelBooking, groupBookings } from '../services/bookings.js';
import { openShift, requireShift, recordCash, shiftSummary, startShift, endShift, checkSupervisor, voidSale } from '../services/cash.js';
import { verifyPassword, hashPassword as hashPin } from '../auth.js';
import { operatorTerms, DEFAULT_LUGGAGE_FEES } from '../services/pricing.js';
import { dueItems, tripBlockers } from '../services/maintenance.js';
import { notifyContact, queue } from '../services/notify.js';
import { ticketData, qrSvg } from '../services/tickets.js';
import { luggageOf, LUGGAGE_KINDS } from '../services/luggage.js';
import { decrypt } from '../security.js';

const CLASSES = ['Luxury', 'Semi-Luxury', 'VIP Sleeper', 'Express', 'Standard'];
const AMENITIES = ['Wi-Fi', 'AC', 'USB Charging', 'Toilet', 'Reclining Seats', 'TV', 'Refreshments', 'Blanket'];
const MIME = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

/** Save a base64 upload ({filename, mime, data}) after checking type and size. */
export function saveUpload(file) {
  if (!file?.data || !file?.mime || !MIME[file.mime]) throw bad('Upload a PDF, JPG, PNG or WebP file.');
  const buf = Buffer.from(String(file.data).replace(/^data:[^,]+,/, ''), 'base64');
  if (buf.length > 5 * 1024 * 1024) throw bad('Files must be 5 MB or smaller.');
  const sig = buf.subarray(0, 4).toString('hex');
  const okSig = { 'application/pdf': '25504446', 'image/png': '89504e47', 'image/jpeg': 'ffd8ff', 'image/webp': '52494646' }[file.mime];
  if (!sig.startsWith(okSig)) throw bad('The file content does not match its type.');
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const stored = crypto.randomUUID() + MIME[file.mime];
  fs.writeFileSync(path.join(config.uploadDir, stored), buf);
  return { stored, size: buf.length, filename: String(file.filename || 'upload').slice(0, 200) };
}

/** Validate an operator's luggage price list. Returns JSON or null (unchanged). */
function luggageFeesBody(v) {
  if (v == null) return null;
  const out = {};
  for (const k of Object.keys(DEFAULT_LUGGAGE_FEES)) {
    const n = Number(v[k] ?? DEFAULT_LUGGAGE_FEES[k]);
    if (!(n >= 0 && n <= (k === 'free_bags' ? 10 : 1000))) throw bad(k === 'free_bags' ? 'Free bags per passenger must be 0–10.' : `Luggage price for ${k} must be between K0 and K1000.`);
    out[k] = k === 'free_bags' ? Math.floor(n) : Math.round(n * 100) / 100;
  }
  return JSON.stringify(out);
}

/** Validate demand-based pricing settings. Returns JSON or null (unchanged). */
function dynamicBody(v) {
  if (v == null) return null;
  const tiers = (Array.isArray(v.tiers) ? v.tiers : []).map(t => ({ occupancy: Number(t.occupancy), pct: Number(t.pct) }))
    .filter(t => t.occupancy || t.pct).sort((a, b) => a.occupancy - b.occupancy);
  if (tiers.length > 5) throw bad('Use at most 5 demand levels.');
  for (const t of tiers) {
    if (!(t.occupancy >= 1 && t.occupancy <= 100)) throw bad('"When the bus is X% full" must be between 1 and 100.');
    if (!(t.pct >= 0 && t.pct <= 50)) throw bad('Demand surcharges must be between 0% and 50%.');
  }
  const earlyDays = Number(v.early_days) || 0, earlyPct = Number(v.early_pct) || 0;
  if (!(earlyDays >= 0 && earlyDays <= 180) || !(earlyPct >= 0 && earlyPct <= 50)) throw bad('Early booking: up to 180 days ahead and up to 50% off.');
  return JSON.stringify({ enabled: !!v.enabled, tiers, early_days: earlyDays, early_pct: earlyPct });
}

export default function operatorRoutes(db) {
  const r = Router();
  const owner = [requireRole('operator')];
  const ownerOps = [requireRole('operator'), requireApprovedOperator];
  const desk = [requireRole('operator', 'clerk', 'conductor'), requireApprovedOperator]; // station staff
  const mine = (table, id, opId) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND operator_id = ?`).get(id, opId);
    if (!row) throw notFound();
    return row;
  };
  const audit = (req, action, entity, id, detail) => db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)').run(req.user.id, action, entity, String(id), detail ?? null);

  /* ---------- company profile & verification ---------- */
  r.get('/operator/profile', requireRole('operator', 'clerk', 'conductor'), (req, res) => {
    const o = db.prepare('SELECT * FROM operators WHERE id = ?').get(req.operatorId);
    const docs = db.prepare("SELECT id, kind, filename, status, expires_on, uploaded_at FROM documents WHERE operator_id = ? AND owner_type = 'operator' ORDER BY id DESC").all(req.operatorId);
    const bank_change = db.prepare("SELECT bank_name, bank_account, bank_branch, effective_at, requested_at FROM bank_changes WHERE operator_id = ? AND status = 'pending'").get(req.operatorId) || null;
    res.json({ ...o, terms: operatorTerms(db, req.operatorId), documents: docs, amenities: AMENITIES, classes: CLASSES, bank_change });
  });
  r.put('/operator/profile', ...owner, (req, res) => {
    const b = req.body;
    if (b.refund_policy) {
      const p = b.refund_policy;
      if (!Array.isArray(p) || !p.every(t => t.hours >= 0 && t.pct >= 0 && t.pct <= 100)) throw bad('Refund tiers need hours ≥ 0 and a percentage between 0 and 100.');
    }
    db.prepare(`UPDATE operators SET contact_email = COALESCE(?, contact_email), pacra_no = COALESCE(?, pacra_no), tpin = COALESCE(?, tpin),
      refund_policy = COALESCE(?, refund_policy), reschedule_fee = COALESCE(?, reschedule_fee), luggage_fees = COALESCE(?, luggage_fees), dynamic_pricing = COALESCE(?, dynamic_pricing) WHERE id = ?`)
      .run(b.contact_email ?? null, b.pacra_no ?? null, b.tpin ?? null,
        b.refund_policy ? JSON.stringify([...b.refund_policy].sort((x, y) => y.hours - x.hours)) : null, b.reschedule_fee ?? null, luggageFeesBody(b.luggage_fees), dynamicBody(b.dynamic_pricing), req.operatorId);
    // Bank details never change straight away (payout hijacking): the new account is used after a wait, and the owner is told by SMS.
    let bank_change = null;
    const o = db.prepare('SELECT * FROM operators WHERE id = ?').get(req.operatorId);
    const nb = { name: (b.bank_name ?? o.bank_name ?? '').trim(), account: (b.bank_account ?? o.bank_account ?? '').replace(/\s/g, ''), branch: (b.bank_branch ?? o.bank_branch ?? '').trim() };
    if ((b.bank_name !== undefined || b.bank_account !== undefined || b.bank_branch !== undefined) && (nb.name !== (o.bank_name || '') || nb.account !== (o.bank_account || '') || nb.branch !== (o.bank_branch || ''))) {
      if (!nb.name || !/^\d{6,20}$/.test(nb.account)) throw bad('Enter the bank name and an account number of 6 to 20 digits.');
      if (!o.bank_account) {
        db.prepare('UPDATE operators SET bank_name = ?, bank_account = ?, bank_branch = ? WHERE id = ?').run(nb.name, nb.account, nb.branch || null, o.id); // first time: nothing to hijack
      } else {
        const hours = Number(setting(db, 'bank_change_hours'));
        db.prepare("UPDATE bank_changes SET status = 'cancelled', cancelled_by = ? WHERE operator_id = ? AND status = 'pending'").run(req.user.id, o.id);
        bank_change = db.prepare("INSERT INTO bank_changes (operator_id, bank_name, bank_account, bank_branch, requested_by, effective_at) VALUES (?,?,?,?,?, datetime('now', ?)) RETURNING *")
          .get(o.id, nb.name, nb.account, nb.branch || null, req.user.id, `+${hours} hours`);
        const owners = db.prepare("SELECT phone FROM users WHERE operator_id = ? AND role = 'operator' AND active = 1").all(o.id).map(u => u.phone);
        for (const ph of new Set([...owners, o.contact_phone].filter(Boolean))) {
          queue(db, { channel: 'sms', to: ph, kind: 'bank_change', body: `MyTicket ${o.name}: payouts will go to ${nb.name} account ending ${nb.account.slice(-4)} from ${bank_change.effective_at.slice(0, 16)}. If you did not ask for this, cancel it in Company & verification and contact MyTicket now.` });
        }
      }
    }
    audit(req, 'update', 'operator', req.operatorId, bank_change ? `bank change requested, effective ${bank_change.effective_at}` : null);
    res.json({ ok: true, bank_change });
  });
  r.post('/operator/bank-change/cancel', ...owner, (req, res) => {
    const row = db.prepare("UPDATE bank_changes SET status = 'cancelled', cancelled_by = ? WHERE operator_id = ? AND status = 'pending' RETURNING id").get(req.user.id, req.operatorId);
    if (!row) throw conflict('There is no pending bank change.');
    audit(req, 'bank_change_cancelled', 'operator', req.operatorId);
    res.json({ ok: true });
  });
  r.post('/operator/documents', ...owner, (req, res) => {
    const kind = req.body.kind;
    if (!['pacra', 'rtsa_licence', 'tax_clearance', 'other'].includes(kind)) throw bad('Choose the document type: PACRA, RTSA licence or tax clearance.');
    const f = saveUpload(req.body.file);
    const d = db.prepare(`INSERT INTO documents (operator_id, owner_type, owner_id, kind, filename, stored_name, mime, size, expires_on) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`)
      .get(req.operatorId, 'operator', req.operatorId, kind, f.filename, f.stored, req.body.file.mime, f.size, isDate(req.body.expires_on) ? req.body.expires_on : null);
    res.status(201).json(d);
  });

  /* ---------- maintenance & compliance ---------- */
  r.get('/operator/maintenance', ...owner, (req, res) => {
    const buses = db.prepare(`SELECT id, plate, class, status, odometer_km, service_interval_km, last_service_km, last_service_date, fitness_expiry, insurance_expiry, road_tax_expiry
      FROM buses WHERE operator_id = ? AND status != 'retired' ORDER BY plate`).all(req.operatorId)
      .map(b => ({ ...b, km_to_service: Math.round(b.service_interval_km - (b.odometer_km - b.last_service_km)) }));
    const drivers = db.prepare("SELECT id, name, licence_no, licence_expiry FROM staff WHERE operator_id = ? AND role = 'driver' AND active = 1 ORDER BY name").all(req.operatorId);
    const log = db.prepare(`SELECT m.*, b.plate FROM maintenance_log m JOIN buses b ON b.id = m.bus_id WHERE m.operator_id = ? ORDER BY m.done_on DESC, m.id DESC LIMIT 100`).all(req.operatorId);
    res.json({ due: dueItems(db, req.operatorId), buses, drivers, log });
  });
  r.put('/operator/buses/:id/compliance', ...owner, (req, res) => {
    const b = mine('buses', req.params.id, req.operatorId);
    const d = k => { const v = req.body[k]; if (v === undefined) return b[k]; if (v && !isDate(v)) throw bad('Dates must be YYYY-MM-DD.'); return v || null; };
    const interval = req.body.service_interval_km === undefined ? b.service_interval_km : Number(req.body.service_interval_km);
    if (!(interval >= 1000 && interval <= 100000)) throw bad('Service interval should be between 1,000 and 100,000 km.');
    const odo = req.body.odometer_km === undefined ? b.odometer_km : Number(req.body.odometer_km);
    if (!(odo >= 0)) throw bad('Enter the odometer reading in km.');
    db.prepare('UPDATE buses SET fitness_expiry = ?, insurance_expiry = ?, road_tax_expiry = ?, service_interval_km = ?, odometer_km = ? WHERE id = ?')
      .run(d('fitness_expiry'), d('insurance_expiry'), d('road_tax_expiry'), interval, odo, b.id);
    audit(req, 'compliance', 'bus', b.id, JSON.stringify(req.body));
    res.json({ ok: true });
  });
  r.post('/operator/maintenance', ...owner, (req, res) => {
    required(req.body, ['bus_id', 'kind', 'done_on']);
    const b = mine('buses', req.body.bus_id, req.operatorId);
    if (!['service', 'repair', 'tyres', 'inspection', 'other'].includes(req.body.kind)) throw bad('Choose what was done.');
    if (!isDate(req.body.done_on) || req.body.done_on > localDate()) throw bad('Enter the date the work was done (not in the future).');
    const km = req.body.odometer_km === undefined || req.body.odometer_km === '' ? b.odometer_km : Number(req.body.odometer_km);
    if (!(km >= 0)) throw bad('Enter the odometer reading in km.');
    const row = tx(db, () => {
      const m = db.prepare('INSERT INTO maintenance_log (operator_id, bus_id, done_on, odometer_km, kind, cost, notes, created_by) VALUES (?,?,?,?,?,?,?,?) RETURNING *')
        .get(req.operatorId, b.id, req.body.done_on, km, req.body.kind, req.body.cost ? Number(req.body.cost) : null, String(req.body.notes || '').slice(0, 500) || null, req.user.id);
      db.prepare('UPDATE buses SET odometer_km = MAX(odometer_km, ?) WHERE id = ?').run(km, b.id);
      if (req.body.kind === 'service') db.prepare('UPDATE buses SET last_service_km = ?, last_service_date = ? WHERE id = ?').run(km, req.body.done_on, b.id);
      if (req.body.kind === 'inspection' && isDate(req.body.fitness_expiry)) db.prepare('UPDATE buses SET fitness_expiry = ? WHERE id = ?').run(req.body.fitness_expiry, b.id);
      return m;
    });
    res.status(201).json(row);
  });

  /* ---------- staff ---------- */
  r.get('/operator/staff', ...owner, (req, res) => {
    res.json(db.prepare('SELECT s.*, u.phone AS login_phone FROM staff s LEFT JOIN users u ON u.id = s.user_id WHERE s.operator_id = ? ORDER BY s.role, s.name').all(req.operatorId));
  });
  r.post('/operator/staff', ...owner, (req, res) => {
    required(req.body, ['name', 'phone', 'role']);
    const { name, role, licence_no, password } = req.body;
    if (!['driver', 'conductor', 'clerk'].includes(role)) throw bad('Role must be driver, conductor or clerk.');
    if (role === 'driver' && !licence_no) throw bad('Enter the driver’s licence number.');
    const phone = normPhone(req.body.phone);
    const s = tx(db, () => {
      let userId = null;
      if (role !== 'driver') { // conductors and clerks get a login for the field app / counter
        if (!password || password.length < 8) throw bad('Set a password of at least 8 characters for the staff login.');
        if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw conflict('That phone number already has an account.');
        userId = db.prepare('INSERT INTO users (role, name, phone, password_hash, operator_id) VALUES (?,?,?,?,?) RETURNING id').get(role, name.trim(), phone, hashPassword(password), req.operatorId).id;
      }
      return db.prepare('INSERT INTO staff (operator_id, user_id, name, phone, role, licence_no) VALUES (?,?,?,?,?,?) RETURNING *').get(req.operatorId, userId, name.trim(), phone, role, licence_no || null);
    });
    res.status(201).json(s);
  });
  /** Lost or stolen phone: end every session of this staff member. The field app erases its data when it next connects. */
  r.post('/operator/staff/:id/sign-out', ...owner, (req, res) => {
    const st = mine('staff', req.params.id, req.operatorId);
    if (!st.user_id) throw bad('This person has no login.');
    const n = revokeAllSessions(db, st.user_id);
    audit(req, 'staff_signed_out', 'user', st.user_id, `${n} sessions`);
    res.json({ ok: true, signed_out: n });
  });
  r.put('/operator/staff/:id', ...owner, (req, res) => {
    const s = mine('staff', req.params.id, req.operatorId);
    const active = req.body.active === undefined ? s.active : req.body.active ? 1 : 0;
    if (req.body.licence_expiry && !isDate(req.body.licence_expiry)) throw bad('Licence expiry must be a date.');
    db.prepare('UPDATE staff SET name = ?, licence_no = ?, active = ?, licence_expiry = ? WHERE id = ?')
      .run(req.body.name || s.name, req.body.licence_no ?? s.licence_no, active, req.body.licence_expiry === undefined ? s.licence_expiry : (req.body.licence_expiry || null), s.id);
    if (s.user_id) { db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active, s.user_id); if (!active) revokeAllSessions(db, s.user_id); }
    res.json({ ok: true });
  });

  /* ---------- fleet ---------- */
  r.get('/layouts', requireRole('operator', 'admin'), (_req, res) => res.json(db.prepare('SELECT id, code, name, capacity, spec FROM layouts ORDER BY capacity').all().map(l => ({ ...l, spec: JSON.parse(l.spec) }))));
  r.get('/operator/buses', ...desk, (req, res) => {
    const rows = db.prepare(`SELECT b.*, l.name layout_name, l.capacity, d.name driver_name, c.name conductor_name FROM buses b JOIN layouts l ON l.id = b.layout_id
      LEFT JOIN staff d ON d.id = b.driver_id LEFT JOIN staff c ON c.id = b.conductor_id WHERE b.operator_id = ? ORDER BY b.plate`).all(req.operatorId);
    const photos = db.prepare("SELECT id, filename FROM documents WHERE owner_type = 'bus' AND owner_id = ?");
    res.json(rows.map(b => ({ ...b, amenities: JSON.parse(b.amenities), photos: photos.all(b.id) })));
  });
  const busBody = (req, b = {}) => {
    const v = { ...b, ...req.body };
    required(v, ['plate', 'class', 'layout_id']);
    if (!CLASSES.includes(v.class)) throw bad('Choose a bus class.');
    if (!db.prepare('SELECT 1 FROM layouts WHERE id = ?').get(v.layout_id)) throw bad('Choose a seat layout.');
    const amen = (Array.isArray(v.amenities) ? v.amenities : JSON.parse(v.amenities || '[]')).filter(a => AMENITIES.includes(a));
    const staffOk = (id, role) => { if (id && !db.prepare('SELECT 1 FROM staff WHERE id = ? AND operator_id = ? AND role = ? AND active = 1').get(id, req.operatorId, role)) throw bad(`That ${role} is not on your staff list.`); return id || null; };
    if (!['active', 'maintenance', 'retired'].includes(v.status || 'active')) throw bad('Unknown bus status.');
    return [String(v.plate).toUpperCase().replace(/\s+/g, ' ').trim(), v.chassis_no || null, v.engine_no || null, v.make_model || null, v.class, Number(v.layout_id), JSON.stringify(amen),
      v.status || 'active', staffOk(v.driver_id, 'driver'), staffOk(v.conductor_id, 'conductor')];
  };
  r.post('/operator/buses', ...owner, (req, res) => {
    try {
      const b = db.prepare(`INSERT INTO buses (plate, chassis_no, engine_no, make_model, class, layout_id, amenities, status, driver_id, conductor_id, operator_id) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(...busBody(req), req.operatorId);
      res.status(201).json(b);
    } catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict('A bus with this plate number is already registered.'); throw e; }
  });
  r.put('/operator/buses/:id', ...owner, (req, res) => {
    const b = mine('buses', req.params.id, req.operatorId);
    const v = busBody(req, b);
    if (v[5] !== b.layout_id && db.prepare("SELECT 1 FROM booking_seats bs JOIN trips t ON t.id = bs.trip_id WHERE t.bus_id = ? AND bs.active = 1 AND t.depart_at > ?").get(b.id, new Date().toISOString()))
      throw conflict('This bus has passengers booked on upcoming trips, so its seat layout cannot change. Assign a different bus to those trips first.');
    db.prepare(`UPDATE buses SET plate=?, chassis_no=?, engine_no=?, make_model=?, class=?, layout_id=?, amenities=?, status=?, driver_id=?, conductor_id=? WHERE id=?`).run(...v, b.id);
    // Crew changes apply to this bus's upcoming trips.
    db.prepare("UPDATE trips SET driver_id = ?, conductor_id = ? WHERE bus_id = ? AND status = 'scheduled'").run(v[8], v[9], b.id);
    audit(req, 'update', 'bus', b.id);
    res.json({ ok: true });
  });
  r.post('/operator/buses/:id/photos', ...owner, (req, res) => {
    const b = mine('buses', req.params.id, req.operatorId);
    const f = saveUpload(req.body.file);
    if (!req.body.file.mime.startsWith('image/')) throw bad('Bus photos must be images.');
    res.status(201).json(db.prepare(`INSERT INTO documents (operator_id, owner_type, owner_id, kind, filename, stored_name, mime, size) VALUES (?,?,?,?,?,?,?,?) RETURNING id`)
      .get(req.operatorId, 'bus', b.id, 'bus_photo', f.filename, f.stored, req.body.file.mime, f.size));
  });

  /* ---------- terminals & routes ---------- */
  r.get('/terminals', requireRole('operator', 'clerk', 'conductor', 'admin'), (_req, res) => res.json(db.prepare('SELECT * FROM terminals ORDER BY city, name').all()));
  r.post('/terminals', ...ownerOps, (req, res) => {
    required(req.body, ['city', 'name', 'lat', 'lng']);
    const lat = Number(req.body.lat), lng = Number(req.body.lng);
    if (!(lat > -19 && lat < -8 && lng > 21 && lng < 34)) throw bad('Coordinates should be inside Zambia (lat −8 to −19, lng 21 to 34). Copy them from Google Maps.');
    try {
      res.status(201).json(db.prepare('INSERT INTO terminals (city, name, lat, lng, kind) VALUES (?,?,?,?,?) RETURNING *').get(req.body.city.trim(), req.body.name.trim(), lat, lng, req.body.kind === 'roadside' ? 'roadside' : 'terminal'));
    } catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict('That stop already exists.'); throw e; }
  });
  r.get('/operator/routes', ...desk, (req, res) => {
    res.json(db.prepare('SELECT * FROM routes WHERE operator_id = ? ORDER BY name').all(req.operatorId).map(rt => ({ ...rt, stops: routeStops(db, rt.id) })));
  });
  /** Route builder: stops in order with minutes and km from the first stop. */
  const saveRoute = (req, routeId) => {
    const { stops } = req.body;
    if (!Array.isArray(stops) || stops.length < 2) throw bad('A route needs at least an origin and a destination.');
    stops.forEach((s, i) => {
      if (!db.prepare('SELECT 1 FROM terminals WHERE id = ?').get(s.terminal_id)) throw bad(`Stop ${i + 1}: choose a terminal.`);
      if (i === 0 && (Number(s.offset_min) !== 0 || Number(s.km) !== 0)) throw bad('The first stop is the start: 0 minutes and 0 km.');
      if (i > 0 && (Number(s.offset_min) <= Number(stops[i - 1].offset_min) || Number(s.km) <= Number(stops[i - 1].km))) throw bad(`Stop ${i + 1} must be later and further than stop ${i}.`);
    });
    const last = stops.at(-1);
    const names = stops.map(s => db.prepare('SELECT city FROM terminals WHERE id = ?').get(s.terminal_id).city);
    const name = req.body.name?.trim() || `${names[0]} – ${names.at(-1)}`;
    return tx(db, () => {
      if (routeId) {
        if (db.prepare("SELECT 1 FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE t.route_id = ? AND b.status IN ('confirmed','reserved','pending_payment')").get(routeId))
          throw conflict('This route has active bookings. Create a new route instead and move schedules to it.');
        db.prepare('UPDATE routes SET name = ?, distance_km = ?, duration_min = ? WHERE id = ?').run(name, Number(last.km), Number(last.offset_min), routeId);
        db.prepare('DELETE FROM route_stops WHERE route_id = ?').run(routeId);
      } else {
        routeId = db.prepare('INSERT INTO routes (operator_id, name, distance_km, duration_min) VALUES (?,?,?,?) RETURNING id').get(req.operatorId, name, Number(last.km), Number(last.offset_min)).id;
      }
      const ins = db.prepare('INSERT INTO route_stops (route_id, seq, terminal_id, offset_min, km, boarding, dropping) VALUES (?,?,?,?,?,?,?)');
      stops.forEach((s, i) => ins.run(routeId, i + 1, s.terminal_id, Number(s.offset_min), Number(s.km), i === stops.length - 1 ? 0 : s.boarding === false ? 0 : 1, i === 0 ? 0 : s.dropping === false ? 0 : 1));
      return { id: routeId };
    });
  };
  r.post('/operator/routes', ...ownerOps, (req, res) => res.status(201).json(saveRoute(req)));
  r.put('/operator/routes/:id', ...ownerOps, (req, res) => { mine('routes', req.params.id, req.operatorId); res.json(saveRoute(req, Number(req.params.id))); });

  /* ---------- timetable ---------- */
  r.get('/operator/schedules', ...desk, (req, res) => {
    res.json(db.prepare(`SELECT s.*, r.name route_name, b.plate, b.class FROM schedules s JOIN routes r ON r.id = s.route_id JOIN buses b ON b.id = s.bus_id
      WHERE s.operator_id = ? ORDER BY s.active DESC, r.name, s.depart_time`).all(req.operatorId));
  });
  const scheduleBody = (req, cur = {}) => {
    const v = { ...cur, ...req.body };
    required(v, ['route_id', 'bus_id', 'depart_time', 'start_date', 'base_fare']);
    mine('routes', v.route_id, req.operatorId); mine('buses', v.bus_id, req.operatorId);
    if (!isTime(v.depart_time)) throw bad('Departure time must be HH:MM.');
    if (!isDate(v.start_date) || (v.end_date && !isDate(v.end_date))) throw bad('Dates must be YYYY-MM-DD.');
    const days = String(v.days ?? '1234567').replace(/[^1-7]/g, '');
    if (!v.one_off && !days) throw bad('Pick at least one day of the week.');
    if (!(Number(v.base_fare) > 0)) throw bad('Enter the full-route fare in kwacha.');
    return [Number(v.route_id), Number(v.bus_id), v.depart_time, days || '1234567', v.start_date, v.one_off ? v.start_date : (v.end_date || null), v.one_off ? 1 : 0, Number(v.base_fare), v.active === false || v.active === 0 ? 0 : 1];
  };
  r.post('/operator/schedules', ...ownerOps, (req, res) => {
    res.status(201).json(db.prepare(`INSERT INTO schedules (route_id, bus_id, depart_time, days, start_date, end_date, one_off, base_fare, active, operator_id) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(...scheduleBody(req), req.operatorId));
  });
  r.put('/operator/schedules/:id', ...ownerOps, (req, res) => {
    const s = mine('schedules', req.params.id, req.operatorId);
    db.prepare('UPDATE schedules SET route_id=?, bus_id=?, depart_time=?, days=?, start_date=?, end_date=?, one_off=?, base_fare=?, active=? WHERE id=?').run(...scheduleBody(req, s), s.id);
    // Upcoming trips without bookings follow the new fare; trips with bookings keep what passengers paid for.
    db.prepare(`UPDATE trips SET base_fare = ? WHERE schedule_id = ? AND status = 'scheduled' AND depart_at > ? AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.trip_id = trips.id)`).run(Number(req.body.base_fare ?? s.base_fare), s.id, new Date().toISOString());
    res.json({ ok: true });
  });

  /* ---------- trips ---------- */
  r.get('/operator/trips', ...desk, (req, res) => {
    const date = isDate(req.query.date) ? req.query.date : localDate();
    ensureTrips(db, date);
    const rows = db.prepare(`SELECT t.*, r.name route_name, b.plate, b.class, l.capacity, d.name driver_name, c.name conductor_name,
        (SELECT COUNT(*) FROM booking_seats bs WHERE bs.trip_id = t.id AND bs.active = 1) booked,
        (SELECT COUNT(*) FROM booking_seats bs WHERE bs.trip_id = t.id AND bs.active = 1 AND bs.boarded_at IS NOT NULL) boarded,
        (SELECT COALESCE(SUM(seats), 0) FROM waitlist w WHERE w.trip_id = t.id AND w.status IN ('waiting','offered')) waiting
      FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id JOIN layouts l ON l.id = b.layout_id
      LEFT JOIN staff d ON d.id = t.driver_id LEFT JOIN staff c ON c.id = t.conductor_id
      WHERE t.operator_id = ? AND t.service_date = ? ORDER BY t.depart_at`).all(req.operatorId, date);
    res.json(rows.map(t => ({ ...t, depart_local: localTime(t.depart_at), blockers: tripBlockers(db, t) })));
  });
  r.put('/operator/trips/:id/crew', ...ownerOps, (req, res) => {
    const t = mine('trips', req.params.id, req.operatorId);
    const chk = (id, role) => { if (id && !db.prepare('SELECT 1 FROM staff WHERE id=? AND operator_id=? AND role=?').get(id, req.operatorId, role)) throw bad(`Choose a ${role} from your staff.`); return id || null; };
    db.prepare('UPDATE trips SET driver_id = ?, conductor_id = ? WHERE id = ?').run(chk(req.body.driver_id, 'driver'), chk(req.body.conductor_id, 'conductor'), t.id);
    res.json({ ok: true });
  });

  /** Passenger manifest for police / border checkpoints. ?format=csv for a download. */
  r.get('/operator/trips/:id/manifest', ...desk, (req, res) => {
    const t = mine('trips', req.params.id, req.operatorId);
    // Full ID numbers only for the official manifest (print / CSV / "show full IDs"), and every viewing is logged.
    const full = req.query.format === 'csv' || req.query.full === '1';
    const rows = db.prepare(`SELECT bs.seat_no, bs.passenger_name, bs.id_type, bs.id_number id_enc, bs.id_hint, bs.gender, bs.is_child, b.contact_phone, b.ref, b.status, b.channel,
        ft.city from_city, ft.name from_stop, tt.city to_city, tt.name to_stop, bs.boarded_at,
        bs.lug_bags, bs.lug_sacks, bs.lug_containers, bs.lug_boxes, bs.lug_crates, bs.lug_other, bs.lug_note
      FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
      JOIN route_stops fs ON fs.id = b.from_stop_id JOIN terminals ft ON ft.id = fs.terminal_id
      JOIN route_stops ts ON ts.id = b.to_stop_id JOIN terminals tt ON tt.id = ts.terminal_id
      WHERE bs.trip_id = ? AND bs.active = 1 AND b.status IN ('confirmed','completed','reserved') ORDER BY CAST(bs.seat_no AS INTEGER), bs.seat_no`).all(t.id)
      .map(({ id_enc, ...r }) => ({ ...r, id_number: full ? (id_enc === 'REMOVED' ? 'removed after retention period' : decrypt(id_enc)) : (r.id_hint || ''), luggage: luggageOf(r) }));
    if (full) audit(req, req.query.format === 'csv' ? 'manifest_csv' : 'manifest_full_ids', 'trip', t.id, `${rows.length} passengers`);
    const luggage_totals = Object.fromEntries(LUGGAGE_KINDS.map(([k]) => [k, rows.reduce((a, r) => a + r.luggage.items[k], 0)]));
    if (req.query.format === 'csv') {
      const head = ['Seat', 'Passenger', 'ID type', 'ID number', 'Gender', 'Child', 'Phone', 'Booking', 'Status', 'From', 'To', 'Boarded', 'Luggage',
        ...LUGGAGE_KINDS.map(([k]) => k[0].toUpperCase() + k.slice(1)), 'Luggage note'];
      const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [head, ...rows.map(r => [r.seat_no, r.passenger_name, r.id_type, r.id_number, r.gender, r.is_child ? 'Y' : '', r.contact_phone, r.ref, r.status, `${r.from_stop}, ${r.from_city}`, `${r.to_stop}, ${r.to_city}`, r.boarded_at ? 'Y' : '',
        r.luggage.has ? 'Yes' : 'No', ...LUGGAGE_KINDS.map(([k]) => r.luggage.items[k] || ''), r.lug_note || '']),
        ['TOTAL', `${rows.length} passengers`, '', '', '', '', '', '', '', '', '', '', `${rows.filter(r => r.luggage.has).length} with luggage`, ...LUGGAGE_KINDS.map(([k]) => luggage_totals[k]), '']].map(r => r.map(q).join(',')).join('\r\n');
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="manifest-trip-${t.id}-${t.service_date}.csv"` });
      return res.send('﻿' + csv);
    }
    const trip = db.prepare(`SELECT t.*, r.name route_name, b.plate, d.name driver_name, d.licence_no, c.name conductor_name, o.name operator_name FROM trips t JOIN routes r ON r.id=t.route_id
      JOIN buses b ON b.id=t.bus_id JOIN operators o ON o.id=t.operator_id LEFT JOIN staff d ON d.id=t.driver_id LEFT JOIN staff c ON c.id=t.conductor_id WHERE t.id=?`).get(t.id);
    res.json({ trip: { ...trip, depart_local: `${localDate(trip.depart_at)} ${localTime(trip.depart_at)}` }, passengers: rows, luggage_totals });
  });

  /* ---------- walk-in / counter sales (same live seat inventory) ---------- */
  r.post('/counter/bookings', ...desk, (req, res) => {
    for (const leg of req.body.legs || []) mine('trips', leg.trip_id, req.operatorId);
    const method = req.body.payment_method === 'station' ? 'station' : 'cash';
    const shift = method === 'cash' ? requireShift(db, req.user) : null;
    const r = createBookings(db, { ...req.body, payment_method: method, user: req.user, channel: req.user.role === 'conductor' ? 'agent' : 'counter' });
    if (shift) for (const b of r.bookings) recordCash(db, shift.id, { kind: 'sale', amount: b.total, ref: b.ref, bookingId: db.prepare('SELECT id FROM bookings WHERE ref = ?').get(b.ref).id });
    res.status(201).json(r);
  });
  /* ---------- cash shifts ---------- */
  r.get('/counter/shift', ...desk, (req, res) => {
    const s = openShift(db, req.user.id);
    res.json(s ? { ...shiftSummary(db, s), movements: db.prepare('SELECT kind, amount, ref, note, created_at FROM cash_movements WHERE shift_id = ? ORDER BY id DESC LIMIT 50').all(s.id) } : null);
  });
  r.post('/counter/shift/open', ...desk, (req, res) => res.status(201).json(startShift(db, req.user, req.body.opening_float)));
  r.post('/counter/shift/close', ...desk, (req, res) => res.json(endShift(db, req.user, req.body)));
  r.post('/counter/void/:ref', ...desk, (req, res) => {
    const b = db.prepare('SELECT * FROM bookings WHERE ref = ? AND operator_id = ?').get(String(req.params.ref).toUpperCase(), req.operatorId);
    if (!b) throw notFound('No booking with that reference for your company.');
    const supervisor = checkSupervisor(db, req.user, req.body.supervisor_phone, req.body.supervisor_pin);
    res.json(voidSale(db, req.user, b, { reason: req.body.reason, supervisor }, cancelBooking));
  });
  r.get('/operator/shifts', ...owner, (req, res) => {
    const rows = db.prepare(`SELECT s.*, u.name clerk FROM cash_shifts s JOIN users u ON u.id = s.user_id WHERE s.operator_id = ? ORDER BY s.id DESC LIMIT 100`).all(req.operatorId);
    res.json(rows.map(s => ({ ...shiftSummary(db, s), clerk: s.clerk })));
  });
  r.get('/operator/shifts/:id', ...owner, (req, res) => {
    const s = mine('cash_shifts', req.params.id, req.operatorId);
    res.json({ ...shiftSummary(db, s), movements: db.prepare('SELECT * FROM cash_movements WHERE shift_id = ? ORDER BY id').all(s.id) });
  });
  /** The owner's supervisor PIN (4–6 digits) approves voids at the counter. */
  r.put('/operator/supervisor-pin', ...owner, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(req.body.password, u.password_hash)) throw bad('Your password is wrong.');
    const pin = String(req.body.pin || '');
    if (!/^\d{4,6}$/.test(pin) || /^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) throw bad('Use 4 to 6 digits that are not all the same or in a row.');
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(pin), u.id);
    audit(req, 'supervisor_pin_set', 'user', u.id);
    res.json({ ok: true });
  });
  r.get('/counter/lookup/:ref', ...desk, (req, res) => {
    const q = req.params.ref.toUpperCase();
    const b = db.prepare('SELECT * FROM bookings WHERE (ref = ? OR group_ref = ?) AND operator_id = ?').get(q, q, req.operatorId);
    if (!b) throw notFound('No booking with that reference for your company.');
    res.json({ group_ref: b.group_ref, bookings: groupBookings(db, b.group_ref).map(x => ticketData(db, x.ref)) });
  });
  r.post('/counter/settle/:group', ...desk, (req, res) => {
    const shift = requireShift(db, req.user);
    const r = settleAtCounter(db, req.params.group, req.user);
    recordCash(db, shift.id, { kind: 'settle', amount: r.amount, ref: req.params.group });
    res.json(r);
  });
  /** Everything a thermal printer ticket needs, including the QR code as SVG. */
  r.get('/counter/receipt/:ref', ...desk, async (req, res) => {
    const t = ticketData(db, req.params.ref);
    if (!t || t.operator_id !== req.operatorId) throw notFound();
    res.json({ ...t, qr_svg: ['confirmed', 'completed'].includes(t.status) ? await qrSvg(t.ref) : null, printed_by: req.user.name, printed_at: new Date().toISOString() });
  });

  /* ---------- pricing ---------- */
  r.get('/operator/pricing', ...owner, (req, res) => res.json(db.prepare('SELECT * FROM pricing_rules WHERE operator_id = ? ORDER BY kind, id DESC').all(req.operatorId)));
  r.post('/operator/pricing', ...ownerOps, (req, res) => {
    const b = req.body;
    required(b, ['kind', 'name', 'pct']);
    if (!['peak', 'child', 'promo'].includes(b.kind)) throw bad('Rule type must be peak, child or promo.');
    const pct = Number(b.pct);
    if (!(pct > 0 && pct <= (b.kind === 'peak' ? 100 : 90))) throw bad(b.kind === 'peak' ? 'Peak surcharge must be between 1% and 100%.' : 'Discounts must be between 1% and 90%.');
    if (b.kind === 'peak' && (!isDate(b.start_date) || !isDate(b.end_date))) throw bad('Peak pricing needs a start and end date.');
    const code = b.kind === 'promo' ? String(b.code || '').trim().toUpperCase() : null;
    if (b.kind === 'promo' && !/^[A-Z0-9]{4,16}$/.test(code)) throw bad('Promo codes are 4–16 letters or digits.');
    try {
      res.status(201).json(db.prepare(`INSERT INTO pricing_rules (operator_id, kind, name, pct, code, start_date, end_date, max_uses) VALUES (?,?,?,?,?,?,?,?) RETURNING *`)
        .get(req.operatorId, b.kind, b.name.trim(), pct, code, b.start_date || null, b.end_date || null, b.max_uses ? Number(b.max_uses) : null));
    } catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict('That promo code is already in use.'); throw e; }
  });
  r.put('/operator/pricing/:id', ...ownerOps, (req, res) => {
    const p = mine('pricing_rules', req.params.id, req.operatorId);
    db.prepare('UPDATE pricing_rules SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, p.id);
    res.json({ ok: true });
  });

  /* ---------- parcels ---------- */
  r.get('/operator/parcels', ...desk, (req, res) => {
    res.json(db.prepare(`SELECT p.*, t.service_date, t.depart_at, b.plate FROM parcels p LEFT JOIN trips t ON t.id = p.trip_id LEFT JOIN buses b ON b.id = t.bus_id
      WHERE p.operator_id = ? ORDER BY p.id DESC LIMIT 200`).all(req.operatorId));
  });
  r.post('/operator/parcels', ...desk, (req, res) => {
    const b = req.body;
    required(b, ['from_city', 'to_city', 'sender_name', 'sender_phone', 'receiver_name', 'receiver_phone', 'description', 'weight_kg', 'fee']);
    if (b.trip_id) mine('trips', b.trip_id, req.operatorId);
    const shift = Number(b.fee) > 0 ? requireShift(db, req.user) : null;
    const p = db.prepare(`INSERT INTO parcels (ref, operator_id, trip_id, from_city, to_city, sender_name, sender_phone, receiver_name, receiver_phone, description, weight_kg, fee, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`).get(uniqueRef(db, 'parcels', 'ref', 'PC', 6), req.operatorId, b.trip_id || null, b.from_city, b.to_city, b.sender_name.trim(), normPhone(b.sender_phone),
      b.receiver_name.trim(), normPhone(b.receiver_phone), b.description.trim(), Number(b.weight_kg), Number(b.fee), req.user.id);
    if (shift) recordCash(db, shift.id, { kind: 'parcel', amount: p.fee, ref: p.ref });
    notifyContact(db, { phone: p.receiver_phone, kind: 'parcel', body: `MyTicket: Parcel ${p.ref} from ${p.sender_name} is on its way to ${p.to_city} with ${req.user.operator_name}. Collect with your ID and this reference.` });
    res.status(201).json(p);
  });
  r.put('/operator/parcels/:id', ...desk, (req, res) => {
    const p = mine('parcels', req.params.id, req.operatorId);
    const st = req.body.status;
    if (!['received', 'loaded', 'in_transit', 'arrived', 'collected', 'cancelled'].includes(st)) throw bad('Unknown parcel status.');
    db.prepare("UPDATE parcels SET status = ?, trip_id = COALESCE(?, trip_id), updated_at = datetime('now') WHERE id = ?").run(st, req.body.trip_id || null, p.id);
    if (st === 'arrived') notifyContact(db, { phone: p.receiver_phone, kind: 'parcel', body: `MyTicket: Parcel ${p.ref} has arrived in ${p.to_city}. Collect it at the ${req.user.operator_name} office with your ID.` });
    res.json({ ok: true });
  });

  /* ---------- reviews ---------- */
  r.get('/operator/reviews', ...owner, (req, res) => {
    res.json({
      summary: db.prepare('SELECT COUNT(*) n, ROUND(AVG(cleanliness),2) cleanliness, ROUND(AVG(punctuality),2) punctuality, ROUND(AVG(driver),2) driver FROM reviews WHERE operator_id = ?').get(req.operatorId),
      recent: db.prepare(`SELECT rv.*, b.ref, b.contact_name, t.service_date, rt.name route_name FROM reviews rv JOIN bookings b ON b.id = rv.booking_id JOIN trips t ON t.id = rv.trip_id JOIN routes rt ON rt.id = t.route_id
        WHERE rv.operator_id = ? ORDER BY rv.id DESC LIMIT 50`).all(req.operatorId),
    });
  });

  /* ---------- finance ---------- */
  r.get('/operator/finance', ...owner, (req, res) => {
    const op = req.operatorId;
    const days = Math.min(Number(req.query.days) || 30, 366);
    const since = addDays(localDate(), -days + 1);
    const daily = db.prepare(`SELECT t.service_date day, COUNT(DISTINCT b.id) bookings, SUM(b.fare_total - b.discount) gross, SUM(b.commission) commission,
        (SELECT COUNT(*) FROM booking_seats bs JOIN bookings bb ON bb.id = bs.booking_id WHERE bb.operator_id = ? AND bs.active = 1 AND bs.trip_id IN (SELECT id FROM trips WHERE service_date = t.service_date AND operator_id = ?)) seats
      FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE b.operator_id = ? AND b.status IN ('confirmed','completed') AND t.service_date >= ? AND t.service_date <= ? GROUP BY t.service_date ORDER BY day`).all(op, op, op, since, localDate());
    const routes = db.prepare(`SELECT r.name, COUNT(DISTINCT t.id) trips, SUM(l.capacity) capacity_sum,
        (SELECT COUNT(*) FROM booking_seats bs JOIN trips t2 ON t2.id = bs.trip_id WHERE t2.route_id = r.id AND bs.active = 1 AND t2.service_date >= ? AND t2.service_date <= ?) seats
      FROM routes r JOIN trips t ON t.route_id = r.id JOIN buses b ON b.id = t.bus_id JOIN layouts l ON l.id = b.layout_id
      WHERE r.operator_id = ? AND t.service_date >= ? AND t.service_date <= ? AND t.status != 'cancelled' GROUP BY r.id ORDER BY seats DESC`).all(since, localDate(), op, since, localDate());
    res.json({ days, daily, routes: routes.map(r => ({ ...r, occupancy: r.capacity_sum ? Math.round(r.seats / r.capacity_sum * 100) : 0 })), balance: balance(db, op),
      settlements: db.prepare('SELECT * FROM settlements WHERE operator_id = ? ORDER BY id DESC LIMIT 50').all(op) });
  });
  r.post('/operator/settlements', ...ownerOps, (req, res) => {
    const o = db.prepare('SELECT * FROM operators WHERE id = ?').get(req.operatorId);
    if (!o.bank_account) throw bad('Add your company bank account in Company profile before withdrawing.');
    if (db.prepare("SELECT 1 FROM bank_changes WHERE operator_id = ? AND status = 'pending'").get(o.id)) throw conflict('Your bank account change has not taken effect yet. You can withdraw once it has.');
    const bal = balance(db, req.operatorId);
    const amount = money(Number(req.body.amount));
    if (!(amount >= 100)) throw bad('The minimum withdrawal is K100.');
    if (amount > bal.available) throw bad(`You can withdraw up to K${bal.available.toFixed(2)} right now.`);
    res.status(201).json(db.prepare('INSERT INTO settlements (operator_id, amount, bank_snapshot, requested_by) VALUES (?,?,?,?) RETURNING *').get(req.operatorId, amount, `${o.bank_name} ${o.bank_account} ${o.bank_branch || ''}`.trim(), req.user.id));
  });

  return r;
}

/**
 * Operator balance (kwacha).
 *   earned    = completed trips: fare − promo discount − platform commission + luggage charges
 *             + cancelled paid bookings: what the operator keeps after the refund
 *   pending   = confirmed bookings on trips that have not run yet (withdrawable once completed)
 *   available = earned − withdrawals requested or paid
 * On a reschedule the old booking keeps its fare (as a cancelled, paid booking) and the new booking only
 * counts the new money, so the fare is never counted twice.
 */
export function balance(db, operatorId) {
  const sum = status => db.prepare(`SELECT COALESCE(SUM(fare_total - discount - commission + luggage_fee), 0) v FROM bookings WHERE operator_id = ? AND status = ?`).get(operatorId, status).v;
  const kept = db.prepare(`SELECT COALESCE(SUM(MAX(0, b.fare_total - b.discount - b.commission + b.luggage_fee
      - MIN(b.fare_total - b.discount + b.luggage_fee, COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.booking_id = b.id), 0)))), 0) v
    FROM bookings b WHERE b.operator_id = ? AND b.status = 'cancelled' AND b.confirmed_at IS NOT NULL`).get(operatorId).v;
  const withdrawn = db.prepare("SELECT COALESCE(SUM(amount), 0) v FROM settlements WHERE operator_id = ? AND status IN ('requested','paid')").get(operatorId).v;
  const earned = sum('completed') + kept;
  return { earned: money(earned), pending: money(sum('confirmed')), withdrawn: money(withdrawn), available: money(earned - withdrawn) };
}
