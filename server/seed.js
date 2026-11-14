// Demo data for development. Company names are fictional. Run directly: npm run seed:demo (resets the dev DB).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './db.js';
import { config } from './config.js';
import { hashPassword } from './auth.js';
import { encrypt, protectStoredIds } from './security.js';
import { ensureTrips } from './services/trips.js';
import { priceLeg } from './services/pricing.js';
import { localDate, addDays, ref, uniqueRef, isoWeekday } from './util.js';

export const DEMO_PASSWORD = 'demo1234';
// Development only: the demo admins' authenticator secret, so the demo and the tests can complete two-step sign-in.
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export const DEMO_USERS = [
  { role: 'admin', name: 'Platform Admin', phone: '260950000001' },
  { role: 'admin', name: 'Finance Admin (second approver)', phone: '260950000002' },
  { role: 'operator', name: 'Mwila Banda (Zambezi Coaches owner)', phone: '260960000002', op: 'Zambezi Coaches' },
  { role: 'clerk', name: 'Chanda Phiri (counter clerk)', phone: '260960000003', op: 'Zambezi Coaches' },
  { role: 'conductor', name: 'Mutale Zulu (conductor)', phone: '260970000004', op: 'Zambezi Coaches' },
  { role: 'passenger', name: 'Natasha Mwale', phone: '260971234567', email: 'natasha@example.com' },
  { role: 'operator', name: 'Kelvin Tembo (Copperbelt Express owner)', phone: '260960000010', op: 'Copperbelt Express' },
  { role: 'operator', name: 'Grace Lungu (Luangwa Liner owner)', phone: '260960000020', op: 'Luangwa Liner' },
];

function layouts() {
  const seats = (rows, pattern, start = 1, female = []) => {
    let n = start;
    return Array.from({ length: rows }, () => pattern.map(c => c ? { no: String(n), ...(female.includes(n++) ? { female: true } : {}) } : null));
  };
  const berths = (prefix) => Array.from({ length: 5 }, (_, r) => [{ no: `${prefix}${r * 3 + 1}`, kind: 'berth' }, null, { no: `${prefix}${r * 3 + 2}`, kind: 'berth' }, { no: `${prefix}${r * 3 + 3}`, kind: 'berth' }]);
  return [
    { code: '2x2-60', name: 'Standard 2+2, 60 seats', spec: { decks: [{ name: 'Main deck', cols: 5, rows: seats(15, [1, 1, 0, 1, 1], 1, [1, 2]) }] }, capacity: 60 },
    { code: '2x2-48', name: 'Luxury 2+2, 48 seats', spec: { decks: [{ name: 'Main deck', cols: 5, rows: seats(12, [1, 1, 0, 1, 1], 1, [1, 2]) }] }, capacity: 48 },
    { code: '2x1-36', name: 'VIP 2+1, 36 seats', spec: { decks: [{ name: 'Main deck', cols: 4, rows: seats(12, [1, 1, 0, 1], 1, [1, 2]) }] }, capacity: 36 },
    { code: 'sleeper-30', name: 'VIP Sleeper, lower + upper deck, 30 berths', spec: { decks: [{ name: 'Lower deck', cols: 4, rows: berths('L') }, { name: 'Upper deck', cols: 4, rows: berths('U') }] }, capacity: 30 },
  ];
}

const TERMINALS = [
  ['Lusaka', 'Intercity Bus Terminus', -15.4246, 28.2810, 'terminal'],
  ['Lusaka', 'Kabangwe, Great North Rd', -15.3290, 28.3020, 'roadside'],
  ['Lusaka', 'Makeni, Kafue Rd', -15.4720, 28.2560, 'roadside'],
  ['Kabwe', 'Kabwe Bus Station', -14.4430, 28.4460, 'terminal'],
  ['Kapiri Mposhi', 'Kapiri Turn-off', -13.9670, 28.6700, 'roadside'],
  ['Ndola', 'Broadway Bus Station', -12.9650, 28.6330, 'terminal'],
  ['Kitwe', 'Kitwe Main Bus Station', -12.8130, 28.2135, 'terminal'],
  ['Kitwe', 'Freedom Park', -12.8040, 28.2300, 'roadside'],
  ['Mazabuka', 'Mazabuka Bus Stop', -15.8560, 27.7480, 'terminal'],
  ['Monze', 'Monze Bus Stop', -16.2770, 27.4790, 'terminal'],
  ['Choma', 'Choma Bus Station', -16.8130, 26.9840, 'terminal'],
  ['Livingstone', 'Livingstone Bus Station', -17.8510, 25.8580, 'terminal'],
  ['Petauke', 'Petauke Bus Stop', -14.2440, 31.3240, 'roadside'],
  ['Chipata', 'Chipata Bus Station', -13.6400, 32.6430, 'terminal'],
];

// [terminal name, minutes, km]
const ROUTES = {
  north: [['Intercity Bus Terminus', 0, 0], ['Kabangwe, Great North Rd', 25, 12], ['Kabwe Bus Station', 140, 140], ['Kapiri Turn-off', 190, 200], ['Broadway Bus Station', 285, 320], ['Kitwe Main Bus Station', 330, 370]],
  south: [['Intercity Bus Terminus', 0, 0], ['Makeni, Kafue Rd', 20, 9], ['Mazabuka Bus Stop', 110, 125], ['Monze Bus Stop', 160, 185], ['Choma Bus Station', 240, 285], ['Livingstone Bus Station', 390, 475]],
  east: [['Intercity Bus Terminus', 0, 0], ['Petauke Bus Stop', 330, 400], ['Chipata Bus Station', 480, 570]],
};
const reverse = stops => { const tot = stops.at(-1); return [...stops].reverse().map(([n, m, k]) => [n, tot[1] - m, tot[2] - k]); };

function rng(seed) { let a = seed; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function seedDemo(db) {
  const rand = rng(42);
  const pick = a => a[Math.floor(rand() * a.length)];
  const today = localDate();
  const pdf = Buffer.from('%PDF-1.4\n% demo verification document\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  fs.mkdirSync(config.uploadDir, { recursive: true });

  tx(db, () => {
    const L = {};
    for (const l of layouts()) L[l.code] = db.prepare('INSERT INTO layouts (code, name, spec, capacity) VALUES (?,?,?,?) RETURNING id').get(l.code, l.name, JSON.stringify(l.spec), l.capacity).id;
    const T = {};
    for (const [city, name, lat, lng, kind] of TERMINALS) T[name] = db.prepare('INSERT INTO terminals (city, name, lat, lng, kind) VALUES (?,?,?,?,?) RETURNING id').get(city, name, lat, lng, kind).id;

    const ops = {};
    const mkOp = (name, status, extra = {}) => ops[name] = db.prepare(`INSERT INTO operators (name, status, rtsa_verified, pacra_no, tpin, contact_phone, contact_email, bank_name, bank_account, bank_branch)
      VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(name, status, status === 'approved' ? 1 : 0, ...[extra.pacra, extra.tpin, extra.phone, extra.email, extra.bank, extra.acct, extra.branch].map(v => v ?? null)).id;
    mkOp('Zambezi Coaches', 'approved', { pacra: '120190012345', tpin: '1002345678', phone: '260960000002', email: 'ops@zambezi.example', bank: 'Zanaco', acct: '0123456789012', branch: 'Cairo Road' });
    mkOp('Copperbelt Express', 'approved', { pacra: '120170054321', tpin: '1009876543', phone: '260960000010', bank: 'Stanbic', acct: '9100001234567', branch: 'Kitwe' });
    mkOp('Luangwa Liner', 'pending', { pacra: '120240077777', phone: '260960000020' });

    const doc = (opId, kind) => {
      const stored = crypto.randomUUID() + '.pdf';
      fs.writeFileSync(path.join(config.uploadDir, stored), pdf);
      db.prepare(`INSERT INTO documents (operator_id, owner_type, owner_id, kind, filename, stored_name, mime, size, status, expires_on) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(opId, 'operator', opId, kind, `${kind}.pdf`, stored, 'application/pdf', pdf.length, opId === ops['Luangwa Liner'] ? 'submitted' : 'verified', addDays(today, 300));
    };
    for (const k of ['pacra', 'rtsa_licence', 'tax_clearance']) { doc(ops['Zambezi Coaches'], k); doc(ops['Copperbelt Express'], k); }
    doc(ops['Luangwa Liner'], 'pacra'); doc(ops['Luangwa Liner'], 'rtsa_licence');

    const users = {};
    for (const u of DEMO_USERS) users[u.phone] = db.prepare('INSERT INTO users (role, name, phone, email, password_hash, operator_id) VALUES (?,?,?,?,?,?) RETURNING id')
      .get(u.role, u.name, u.phone, u.email || null, hashPassword(DEMO_PASSWORD), u.op ? ops[u.op] : null).id;

    const staff = (op, name, phone, role, userId = null, lic = null) => db.prepare('INSERT INTO staff (operator_id, user_id, name, phone, role, licence_no) VALUES (?,?,?,?,?,?) RETURNING id').get(ops[op], userId, name, phone, role, lic).id;
    const Z = 'Zambezi Coaches', C = 'Copperbelt Express';
    const zCond = staff(Z, 'Mutale Zulu', '260970000004', 'conductor', users['260970000004']);
    staff(Z, 'Chanda Phiri', '260960000003', 'clerk', users['260960000003']);
    const zDrivers = ['Joseph Mumba', 'Peter Sakala', 'Moses Chilufya', 'Brian Mulenga'].map((n, i) => staff(Z, n, `26097100000${i}`, 'driver', null, `ZM-DL-${40210 + i}`));
    const zCond2 = staff(Z, 'Esther Kunda', '260971000010', 'conductor');
    const cDrivers = ['Henry Ngoma', 'Daniel Bwalya'].map((n, i) => staff(C, n, `26097200000${i}`, 'driver', null, `ZM-DL-${51100 + i}`));
    const cCond = staff(C, 'Ruth Mwansa', '260972000010', 'conductor');

    const bus = (op, plate, cls, layout, amen, driver, cond, model) => db.prepare(`INSERT INTO buses (operator_id, plate, chassis_no, engine_no, make_model, class, layout_id, amenities, driver_id, conductor_id)
      VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(ops[op], plate, 'CH' + plate.replace(/\W/g, ''), 'EN' + plate.replace(/\W/g, '').slice(-4), model, cls, L[layout], JSON.stringify(amen), driver, cond).id;
    const B = {
      zLux: bus(Z, 'BAZ 4521', 'Luxury', '2x2-48', ['AC', 'Wi-Fi', 'USB Charging', 'Toilet', 'Reclining Seats'], zDrivers[0], zCond, 'Yutong ZK6122'),
      zStd: bus(Z, 'ALB 7734', 'Standard', '2x2-60', ['Reclining Seats'], zDrivers[1], zCond2, 'Higer KLQ6128'),
      zVip: bus(Z, 'BCD 1180', 'VIP Sleeper', 'sleeper-30', ['AC', 'Wi-Fi', 'USB Charging', 'Toilet', 'Blanket', 'Refreshments'], zDrivers[2], zCond2, 'Yutong ZK6127 Sleeper'),
      zSemi: bus(Z, 'BAX 9902', 'Semi-Luxury', '2x1-36', ['AC', 'USB Charging', 'Reclining Seats'], zDrivers[3], zCond, 'Golden Dragon XML6127'),
      cExp: bus(C, 'ACE 3310', 'Express', '2x2-48', ['AC', 'USB Charging', 'Reclining Seats'], cDrivers[0], cCond, 'Scania Touring'),
      cStd: bus(C, 'BBC 6618', 'Standard', '2x2-60', ['Reclining Seats', 'TV'], cDrivers[1], null, 'Higer KLQ6128'),
    };

    const mkRoute = (op, stops) => {
      const last = stops.at(-1);
      const city = n => TERMINALS.find(t => t[1] === n)[0];
      const id = db.prepare('INSERT INTO routes (operator_id, name, distance_km, duration_min) VALUES (?,?,?,?) RETURNING id').get(ops[op], `${city(stops[0][0])} – ${city(last[0])}`, last[2], last[1]).id;
      stops.forEach(([n, m, k], i) => db.prepare('INSERT INTO route_stops (route_id, seq, terminal_id, offset_min, km, boarding, dropping) VALUES (?,?,?,?,?,?,?)').run(id, i + 1, T[n], m, k, i < stops.length - 1 ? 1 : 0, i > 0 ? 1 : 0));
      return id;
    };
    const R = {
      zN: mkRoute(Z, ROUTES.north), zNr: mkRoute(Z, reverse(ROUTES.north)), zS: mkRoute(Z, ROUTES.south), zSr: mkRoute(Z, reverse(ROUTES.south)),
      cN: mkRoute(C, ROUTES.north), cNr: mkRoute(C, reverse(ROUTES.north)), cE: mkRoute(C, ROUTES.east), cEr: mkRoute(C, reverse(ROUTES.east)),
    };
    const start = addDays(today, -45);
    const sched = (op, route, busId, time, fare, days = '1234567') => db.prepare('INSERT INTO schedules (operator_id, route_id, bus_id, depart_time, days, start_date, base_fare) VALUES (?,?,?,?,?,?,?)').run(ops[op], route, busId, time, days, start, fare);
    sched(Z, R.zN, B.zLux, '06:00', 300); sched(Z, R.zNr, B.zLux, '14:30', 300);
    sched(Z, R.zN, B.zStd, '13:00', 230); sched(Z, R.zNr, B.zStd, '05:30', 230);
    sched(Z, R.zS, B.zSemi, '07:30', 380); sched(Z, R.zSr, B.zSemi, '15:00', 380);
    sched(Z, R.zS, B.zVip, '21:00', 520, '1357'); sched(Z, R.zSr, B.zVip, '21:00', 520, '246');
    sched(C, R.cN, B.cExp, '08:30', 280); sched(C, R.cNr, B.cExp, '16:30', 280);
    sched(C, R.cE, B.cStd, '05:30', 320); sched(C, R.cEr, B.cStd, '06:00', 320, '246');

    db.prepare("INSERT INTO pricing_rules (operator_id, kind, name, pct) VALUES (?, 'child', 'Children under 12', 50)").run(ops[Z]);
    db.prepare("INSERT INTO pricing_rules (operator_id, kind, name, pct) VALUES (?, 'child', 'Children under 12', 40)").run(ops[C]);
    const year = today.slice(0, 4);
    db.prepare("INSERT INTO pricing_rules (operator_id, kind, name, pct, start_date, end_date) VALUES (?, 'peak', 'Christmas & New Year', 20, ?, ?)").run(ops[Z], `${year}-12-18`, `${Number(year) + 1}-01-05`);
    db.prepare("INSERT INTO pricing_rules (operator_id, kind, name, pct, code, max_uses) VALUES (?, 'promo', 'Zambezi loyalty', 15, 'ZAMBEZI15', 200)").run(ops[Z]);
    db.prepare("INSERT INTO pricing_rules (operator_id, kind, name, pct, code, max_uses, per_phone_limit) VALUES (NULL, 'promo', 'Platform launch', 10, 'KWACHA10', 500, 1)").run();

    // Extra passengers for analytics
    const names = ['Mwansa Chileshe', 'Bupe Mulenga', 'Thandiwe Banda', 'Chipo Daka', 'Kunda Musonda', 'Lubasi Imasiku', 'Mapalo Ngoma', 'Chisomo Phiri', 'Inonge Mwiinga', 'Kalaba Mutale', 'Taonga Lungu', 'Mubanga Kapata'];
    const pax = names.map((n, i) => db.prepare("INSERT INTO users (role, name, phone, password_hash, created_at) VALUES ('passenger',?,?,?,?) RETURNING id, name, phone")
      .get(n, `26096${String(5000000 + i * 7919).padStart(7, '0')}`, hashPassword(crypto.randomBytes(8).toString('hex')), addDays(today, -Math.floor(rand() * 40)) + ' 10:00:00'));

    // Past and upcoming bookings so dashboards, manifests and My trips have content.
    const insB = db.prepare(`INSERT INTO bookings (ref, group_ref, user_id, created_by, trip_id, operator_id, channel, status, from_stop_id, to_stop_id, contact_name, contact_phone, contact_email,
      fare_total, discount, booking_fee, total, commission, payment_method, confirmed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`);
    const insS0 = db.prepare(`INSERT INTO booking_seats (booking_id, trip_id, seat_no, passenger_name, id_type, id_number, gender, is_child, fare, boarded_at,
      lug_bags, lug_sacks, lug_containers, lug_boxes, lug_crates, lug_other, lug_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // Typical intercity luggage: most carry a bag, some carry sacks of mealie meal, containers, boxes or crates.
    const lug = () => rand() < 0.25 ? [0, 0, 0, 0, 0, 0, null] : [1 + Math.floor(rand() * 2), rand() < 0.2 ? 1 + Math.floor(rand() * 2) : 0, rand() < 0.1 ? 1 : 0, rand() < 0.15 ? 1 : 0, rand() < 0.05 ? 1 : 0, 0, null];
    const insS = { run: (...a) => insS0.run(...a, ...lug()) };
    const nrc = () => `${String(100000 + Math.floor(rand() * 899999))}/${String(10 + Math.floor(rand() * 80))}/1`;
    for (let d = -30; d <= 3; d++) {
      const date = addDays(today, d);
      ensureTrips(db, date);
      const trips = db.prepare(`SELECT t.*, r.distance_km, l.spec FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id JOIN layouts l ON l.id = b.layout_id WHERE t.service_date = ?`).all(date);
      for (const t of trips) {
        if (d < 0) db.prepare("UPDATE trips SET status = 'arrived' WHERE id = ?").run(t.id);
        const stops = db.prepare('SELECT * FROM route_stops WHERE route_id = ? ORDER BY seq').all(t.route_id);
        const seatNos = JSON.parse(t.spec).decks.flatMap(dk => dk.rows.flat().filter(Boolean)).filter(s => !s.female).map(s => s.no);
        const weekend = [5, 7].includes(isoWeekday(date));
        const fill = (d < 0 ? 0.45 : 0.25) + rand() * 0.3 + (weekend ? 0.15 : 0);
        let i = 0;
        while (i < seatNos.length * fill) {
          const n = 1 + Math.floor(rand() * 3);
          const seats = seatNos.slice(i, i + n); i += n;
          if (!seats.length) break;
          const p = pick(pax);
          const from = stops[0], to = rand() < 0.75 ? stops.at(-1) : stops[Math.max(1, stops.length - 2)];
          const passengers = seats.map((s, k) => ({ is_child: k > 0 && rand() < 0.2 }));
          const price = priceLeg(db, { trip: t, fromStop: from, toStop: to, passengers, promo: null });
          const channel = rand() < 0.3 ? 'counter' : 'web';
          const method = channel === 'counter' ? 'cash' : pick(['mtn', 'mtn', 'airtel', 'airtel', 'zamtel', 'card']);
          const created = `${addDays(date, -1 - Math.floor(rand() * 5))} 12:00:00`;
          const b = insB.get(uniqueRef(db, 'bookings', 'ref', 'MT', 6), uniqueRef(db, 'bookings', 'group_ref', 'G', 8), channel === 'web' ? p.id : null, channel === 'web' ? p.id : users['260960000003'], t.id, t.operator_id, channel, d < 0 ? 'completed' : 'confirmed',
            from.id, to.id, p.name, p.phone, null, price.fare_total, 0, price.booking_fee, price.total, price.commission, method, created, created);
          seats.forEach((s, k) => insS.run(b.id, t.id, s, k === 0 ? p.name : pick(names), 'NRC', nrc(), pick(['F', 'M']), passengers[k].is_child ? 1 : 0, price.seat_fares[k], d < 0 ? t.depart_at : null));
          db.prepare("INSERT INTO payments (group_ref, provider, amount, status, provider_ref, created_at) SELECT group_ref, ?, total, 'success', ?, created_at FROM bookings WHERE id = ?").run(method, `SEED-${b.id}`, b.id);
          if (d < 0 && rand() < 0.25) db.prepare('INSERT INTO reviews (booking_id, operator_id, trip_id, cleanliness, punctuality, driver, comment) VALUES (?,?,?,?,?,?,?)')
            .run(b.id, t.operator_id, t.id, 3 + Math.floor(rand() * 3), 2 + Math.floor(rand() * 4), 3 + Math.floor(rand() * 3), pick([null, 'Comfortable seats, left on time.', 'AC was not working for the first hour.', 'Driver was careful on the Kafue road.', 'Clean bus, friendly conductor.']));
        }
      }
    }

    // The demo passenger: an upcoming trip, a completed one to rate, and an open case.
    const nat = users['260971234567'];
    const mine = (date, routeId, seats, status) => {
      const t = db.prepare(`SELECT t.*, r.distance_km FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.route_id = ? AND t.service_date = ? ORDER BY t.depart_at LIMIT 1`).get(routeId, date);
      const stops = db.prepare('SELECT * FROM route_stops WHERE route_id = ? ORDER BY seq').all(routeId);
      const free = seats.filter(s => !db.prepare('SELECT 1 FROM booking_seats WHERE trip_id = ? AND seat_no = ? AND active = 1').get(t.id, s));
      const price = priceLeg(db, { trip: t, fromStop: stops[0], toStop: stops.at(-1), passengers: free.map(() => ({})), promo: null });
      const b = insB.get(uniqueRef(db, 'bookings', 'ref', 'MT', 6), uniqueRef(db, 'bookings', 'group_ref', 'G', 8), nat, nat, t.id, t.operator_id, 'web', status, stops[0].id, stops.at(-1).id, 'Natasha Mwale', '260971234567', 'natasha@example.com',
        price.fare_total, 0, price.booking_fee, price.total, price.commission, 'mtn', `${addDays(date, -3)} 09:00:00`, `${addDays(date, -3)} 09:00:00`);
      free.forEach((s, k) => insS.run(b.id, t.id, s, k ? 'Kabwe Mwale' : 'Natasha Mwale', 'NRC', k ? '334455/10/1' : '221133/11/1', k ? 'M' : 'F', 0, price.seat_fares[k], status === 'completed' ? t.depart_at : null));
      db.prepare("INSERT INTO payments (group_ref, provider, msisdn, amount, status, provider_ref) SELECT group_ref, 'mtn', '260961234567', total, 'success', 'SEED' FROM bookings WHERE id = ?").run(b.id);
      return b.id;
    };
    mine(addDays(today, 2), R.zN, ['46', '47'], 'confirmed');
    const done = mine(addDays(today, -6), R.zS, ['20'], 'completed');
    db.prepare("INSERT INTO disputes (booking_id, user_id, category, description) VALUES (?,?,?,?)").run(done, nat, 'service', 'The bus left Lusaka 90 minutes late and nobody told us why. I would like a partial refund.');
    db.prepare("INSERT INTO disputes (user_id, category, description) VALUES (?,?,?)").run(pax[3].id, 'payment_failed', 'Airtel deducted K255 but I got no ticket. Transaction ID MP2411.1830.C51723.');

    db.prepare("INSERT INTO parcels (ref, operator_id, from_city, to_city, sender_name, sender_phone, receiver_name, receiver_phone, description, weight_kg, fee, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run('PCDEMO1', ops[Z], 'Lusaka', 'Kitwe', 'Joyce Mbewe', '260977111222', 'Paul Mbewe', '260966333444', 'Box of school books', 12, 80, 'received');
    db.prepare("INSERT INTO settlements (operator_id, amount, bank_snapshot, created_at) VALUES (?, 15000, 'Stanbic 9100001234567 Kitwe', datetime('now','-1 day'))").run(ops[C]);

    // Luggage prices: Zambezi charges for bulky items (first bag free); Copperbelt Express carries luggage free.
    db.prepare('UPDATE operators SET luggage_fees = ? WHERE id = ?').run(JSON.stringify({ bags: 10, sacks: 20, containers: 15, boxes: 10, crates: 30, other: 25, free_bags: 1 }), ops[Z]);
    // Demand-based fares: Copperbelt Express raises prices as buses fill and rewards early booking.
    db.prepare('UPDATE operators SET dynamic_pricing = ? WHERE id = ?').run(JSON.stringify({ enabled: true, tiers: [{ occupancy: 50, pct: 10 }, { occupancy: 80, pct: 20 }], early_days: 3, early_pct: 10 }), ops[C]);

    // Mileage, service history and document expiry dates (some due soon or overdue, to show reminders).
    const busUp = (id, odo, lastSvc, interval, fit, ins, tax) => db.prepare(`UPDATE buses SET odometer_km = ?, last_service_km = ?, last_service_date = ?, service_interval_km = ?,
      fitness_expiry = ?, insurance_expiry = ?, road_tax_expiry = ? WHERE id = ?`).run(odo, lastSvc, addDays(today, -40), interval, fit, ins, tax, id);
    busUp(B.zLux, 182340, 172900, 10000, addDays(today, 120), addDays(today, 200), addDays(today, 9));   // service in 560 km, road tax in 9 days
    busUp(B.zStd, 241880, 230500, 10000, addDays(today, -3), addDays(today, 90), addDays(today, 150));   // service overdue, fitness expired
    busUp(B.zVip, 98770, 95000, 15000, addDays(today, 200), addDays(today, 12), addDays(today, 200));    // insurance in 12 days
    busUp(B.zSemi, 132050, 125000, 10000, addDays(today, 60), addDays(today, 300), addDays(today, 60));
    busUp(B.cExp, 77300, 70000, 10000, addDays(today, 150), addDays(today, 150), addDays(today, 150));
    busUp(B.cStd, 301220, 295000, 10000, addDays(today, 30), addDays(today, 30), addDays(today, 30));
    db.prepare("UPDATE staff SET licence_expiry = ? WHERE role = 'driver' AND operator_id = ?").run(addDays(today, 400), ops[Z]);
    db.prepare("UPDATE staff SET licence_expiry = ? WHERE name = 'Peter Sakala'").run(addDays(today, 6));
    db.prepare("UPDATE staff SET licence_expiry = ? WHERE operator_id = ? AND role = 'driver'").run(addDays(today, 500), ops[C]);
    db.prepare("INSERT INTO maintenance_log (operator_id, bus_id, done_on, odometer_km, kind, cost, notes) VALUES (?,?,?,?,?,?,?)").run(ops[Z], B.zLux, addDays(today, -40), 172900, 'service', 4800, 'Oil, filters, brake pads');
    db.prepare("INSERT INTO maintenance_log (operator_id, bus_id, done_on, odometer_km, kind, cost, notes) VALUES (?,?,?,?,?,?,?)").run(ops[Z], B.zSemi, addDays(today, -12), 131200, 'tyres', 9600, '2 front tyres');
    db.prepare("UPDATE trips SET km_logged = 1 WHERE service_date < ?").run(today); // seeded odometers already include past trips

    // Loyalty: the demo passenger has points to spend.
    db.prepare("INSERT INTO loyalty_ledger (user_id, points, kind, note) VALUES (?, 250, 'adjust', 'Welcome bonus')").run(nat);
    db.prepare('UPDATE users SET phone_verified = 1').run(); // demo accounts count as verified
    db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE role = 'admin'").run(encrypt(DEMO_TOTP_SECRET));
  });
  protectStoredIds(db); // encrypt the demo ID numbers like real ones
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (config.isProd) { console.error('Refusing to load demo data in production.'); process.exit(1); }
  for (const f of [config.dbFile, config.dbFile + '-wal', config.dbFile + '-shm']) fs.rmSync(f, { force: true });
  const db = openDb();
  seedDemo(db);
  console.log(`Demo data loaded into ${config.dbFile}. Password for all demo logins: ${DEMO_PASSWORD}`);
}
