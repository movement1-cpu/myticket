import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myticket-test-'));
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { seedDemo, DEMO_PASSWORD } = await import('../server/seed.js');
const { sweep } = await import('../server/services/bookings.js');
const { localDate, addDays } = await import('../server/util.js');

let db, server, base;
const tokens = {};

async function api(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
}
const login = async phone => (await api('POST', '/api/auth/login', { body: { phone, password: DEMO_PASSWORD } })).body.token;
const tomorrow = () => addDays(localDate(), 1);

async function firstTrip(from = 'Lusaka', to = 'Kitwe', date = tomorrow()) {
  const r = await api('GET', `/api/search?from=${from}&to=${to}&date=${date}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.outbound.find(t => t.operator === 'Zambezi Coaches' && t.class === 'Luxury');
}
async function freeSeats(tripId, n) {
  const m = (await api('GET', `/api/trips/${tripId}/seats`)).body;
  return m.decks.flatMap(d => d.rows.flat()).filter(s => s && s.status === 'available' && !s.female).slice(-n).map(s => s.no);
}
const pax = seats => seats.map((s, i) => ({ seat_no: s, name: `Test Passenger ${i}`, id_type: 'NRC', id_number: `12345${i}/10/1`, gender: 'M' }));

before(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  server = createApp(db).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.admin = await login('0950000001');
  tokens.operator = await login('0960000002');
  tokens.clerk = await login('0960000003');
  tokens.conductor = await login('0970000004');
  tokens.passenger = await login('0971234567');
  tokens.otherOperator = await login('0960000010');
  tokens.pendingOperator = await login('0960000020');
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('search finds trips with boarding points and fares', async () => {
  const t = await firstTrip();
  assert.ok(t, 'expected a Zambezi luxury trip');
  assert.ok(t.boarding_points.length >= 2, 'Lusaka has a terminal and a roadside stop');
  assert.match(t.boarding_points[0].map_url, /google\.com\/maps\?q=-15/);
  assert.ok(t.fare > 0);
  const mid = await api('GET', `/api/search?from=Kabwe&to=Ndola&date=${tomorrow()}`);
  assert.ok(mid.body.outbound.length > 0, 'intermediate segments are bookable');
  assert.ok(mid.body.outbound[0].fare < t.fare, 'shorter segment is cheaper');
});

test('filters narrow results', async () => {
  const all = (await api('GET', `/api/search?from=Lusaka&to=Kitwe&date=${tomorrow()}`)).body.outbound;
  const wifi = (await api('GET', `/api/search?from=Lusaka&to=Kitwe&date=${tomorrow()}&amenities=Wi-Fi`)).body.outbound;
  const morning = (await api('GET', `/api/search?from=Lusaka&to=Kitwe&date=${tomorrow()}&window=morning`)).body.outbound;
  assert.ok(wifi.length < all.length && wifi.every(t => t.amenities.includes('Wi-Fi')));
  assert.ok(morning.every(t => t.depart_local >= '05:00' && t.depart_local < '12:00'));
});

test('concurrent holds on the same seat: exactly one wins', async () => {
  const t = await firstTrip();
  const [seat] = await freeSeats(t.trip_id, 1);
  const results = await Promise.all(Array.from({ length: 10 }, () => api('POST', `/api/trips/${t.trip_id}/holds`, { body: { seats: [seat] } })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.ok(results.filter(r => r.status === 409).every(r => r.body.code === 'seat_locked'));
  const winner = results.find(r => r.status === 200).body.hold_token;
  const map = (await api('GET', `/api/trips/${t.trip_id}/seats`, { headers: { 'x-hold-token': winner } })).body;
  assert.equal(map.decks.flatMap(d => d.rows.flat()).find(s => s?.no === seat).status, 'mine');
  await api('DELETE', `/api/holds/${winner}`);
});

test('women-only seats reject male passengers', async () => {
  const t = await firstTrip();
  const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { body: { seats: ['1'] } })).body;
  const r = await api('POST', '/api/bookings', { body: { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, passengers: pax(['1']) }],
    contact: { name: 'X', phone: '0961112223' }, payment_method: 'mtn' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /reserved for women/);
  await api('DELETE', `/api/holds/${hold.hold_token}`);
});

let paidRef;
test('book → pay with MTN sandbox → confirmed with ticket and QR', async () => {
  const t = await firstTrip();
  const seats = await freeSeats(t.trip_id, 2);
  const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { token: tokens.passenger, body: { seats } })).body;
  const b = await api('POST', '/api/bookings', { token: tokens.passenger, body: {
    legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, passengers: [...pax(seats.slice(0, 1)), { ...pax(seats.slice(1))[0], is_child: true }] }],
    contact: { name: 'Natasha Mwale', phone: '0961234567' }, payment_method: 'mtn', promo_code: 'kwacha10' } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const price = b.body.bookings[0].price;
  assert.equal(price.child_pct, 50);
  assert.equal(price.seat_fares[1], price.seat_fares[0] / 2);
  assert.ok(price.discount > 0, 'promo applied');
  assert.equal(b.body.total, price.fare_total - price.discount + price.booking_fee);

  const wrongNet = await api('POST', `/api/groups/${b.body.group_ref}/pay`, { body: { method: 'mtn', msisdn: '0971234567' } });
  assert.equal(wrongNet.status, 400, 'Airtel number cannot pay with MTN');

  const pay = await api('POST', `/api/groups/${b.body.group_ref}/pay`, { body: { method: 'mtn', msisdn: '0961234567' } });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.sandbox, true);
  let p = (await api('GET', `/api/payments/${pay.body.payment_id}`)).body;
  assert.equal(p.status, 'initiated');
  await new Promise(r => setTimeout(r, 3100));
  p = (await api('GET', `/api/payments/${pay.body.payment_id}`)).body;
  assert.equal(p.status, 'success');
  paidRef = b.body.bookings[0].ref;
  const ticket = await api('GET', `/api/tickets/${paidRef}`, { token: tokens.passenger });
  assert.equal(ticket.body.status, 'confirmed');
  assert.match(ticket.body.qr_svg, /<svg/);
  const pdf = await fetch(`${base}/api/tickets/${paidRef}/pdf`, { headers: { Authorization: `Bearer ${tokens.passenger}` } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE kind = 'ticket' AND body LIKE ?").get(`%${paidRef}%`).n, 2, 'SMS + WhatsApp queued');
  const anon = await api('GET', `/api/tickets/${paidRef}`);
  assert.equal(anon.status, 403, 'ticket needs the signed link or the owner');
});

test('failed mobile money payment leaves the booking payable', async () => {
  const t = await firstTrip();
  const seats = await freeSeats(t.trip_id, 1);
  const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { body: { seats } })).body;
  const b = (await api('POST', '/api/bookings', { body: { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, passengers: pax(seats) }],
    contact: { name: 'Guest', phone: '0771230000' }, payment_method: 'airtel' } })).body;
  const pay = (await api('POST', `/api/groups/${b.group_ref}/pay`, { body: { method: 'airtel', msisdn: '0771230000' } })).body;
  await new Promise(r => setTimeout(r, 3100));
  const p = (await api('GET', `/api/payments/${pay.payment_id}`)).body;
  assert.equal(p.status, 'failed');
  assert.match(p.reason, /Insufficient/);
  const g = (await api('GET', `/api/groups/${b.group_ref}`)).body;
  assert.equal(g.bookings[0].status, 'pending_payment');
});

test('expired unpaid bookings release their seats', async () => {
  const t = await firstTrip();
  const seats = await freeSeats(t.trip_id, 1);
  const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { body: { seats } })).body;
  const b = (await api('POST', '/api/bookings', { body: { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, passengers: pax(seats) }],
    contact: { name: 'Guest', phone: '0961110000' }, payment_method: 'station' } })).body;
  assert.equal(b.bookings[0].status, 'reserved');
  db.prepare("UPDATE bookings SET expires_at = '2000-01-01T00:00:00.000Z' WHERE group_ref = ?").run(b.group_ref);
  sweep(db);
  const map = (await api('GET', `/api/trips/${t.trip_id}/seats`)).body;
  assert.equal(map.decks.flatMap(d => d.rows.flat()).find(s => s?.no === seats[0]).status, 'available');
});

test('round trip: two legs, one payment group', async () => {
  const ret = addDays(localDate(), 3);
  const s = (await api('GET', `/api/search?from=Lusaka&to=Livingstone&date=${tomorrow()}&return_date=${ret}`)).body;
  assert.ok(s.outbound.length && s.return.length);
  const legs = [];
  for (const t of [s.outbound[0], s.return[0]]) {
    const seats = await freeSeats(t.trip_id, 1);
    const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { body: { seats } })).body;
    legs.push({ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, passengers: pax(seats) });
  }
  const b = await api('POST', '/api/bookings', { body: { legs, contact: { name: 'Round Trip', phone: '0961114444' }, payment_method: 'card' } });
  assert.equal(b.status, 201);
  assert.equal(b.body.bookings.length, 2);
  const pay = (await api('POST', `/api/groups/${b.body.group_ref}/pay`, { body: { method: 'card' } })).body;
  assert.match(pay.redirect_url, /pay-card/);
  assert.equal(pay.amount, b.body.total);
});

test('RBAC: roles and company scoping', async () => {
  assert.equal((await api('GET', '/api/admin/analytics', { token: tokens.operator })).status, 403);
  assert.equal((await api('GET', '/api/admin/analytics', { token: tokens.passenger })).status, 403);
  assert.equal((await api('GET', '/api/admin/analytics')).status, 401);
  assert.equal((await api('GET', '/api/operator/finance', { token: tokens.clerk })).status, 403, 'clerks cannot see company finances');
  assert.equal((await api('POST', '/api/operator/buses', { token: tokens.conductor, body: {} })).status, 403);
  const trips = (await api('GET', `/api/operator/trips?date=${tomorrow()}`, { token: tokens.operator })).body;
  const other = await api('GET', `/api/operator/trips/${trips[0].id}/manifest`, { token: tokens.otherOperator });
  assert.equal(other.status, 404, 'another company cannot read this manifest');
  const pending = await api('GET', '/api/operator/trips', { token: tokens.pendingOperator });
  assert.equal(pending.status, 403);
  assert.match(pending.body.error, /awaiting approval/);
  assert.equal((await api('GET', '/api/my/bookings', { token: tokens.operator })).status, 403);
});

test('conductor scan: valid once, duplicate after, forged code rejected', async () => {
  const b = db.prepare('SELECT trip_id FROM bookings WHERE ref = ?').get(paidRef);
  const t = (await api('GET', `/api/tickets/${paidRef}`, { token: tokens.passenger })).body;
  const first = await api('POST', `/api/agent/trips/${b.trip_id}/scan`, { token: tokens.conductor, body: { code: t.qr } });
  assert.equal(first.body.result, 'boarded');
  assert.equal(first.body.seats.length, 2);
  const again = await api('POST', `/api/agent/trips/${b.trip_id}/scan`, { token: tokens.conductor, body: { code: t.qr } });
  assert.equal(again.body.result, 'duplicate');
  const forged = await api('POST', `/api/agent/trips/${b.trip_id}/scan`, { token: tokens.conductor, body: { code: `MT1|${paidRef}|AAAAAAAAAAAAAAAA` } });
  assert.equal(forged.body.result, 'invalid');
});

test('offline sync is idempotent', async () => {
  const row = db.prepare(`SELECT b.ref, b.trip_id FROM bookings b JOIN booking_seats bs ON bs.booking_id = b.id JOIN trips t ON t.id = b.trip_id
    WHERE b.status = 'confirmed' AND b.operator_id = 1 AND bs.boarded_at IS NULL AND t.service_date >= ? LIMIT 1`).get(localDate());
  const manifest = (await api('GET', `/api/agent/trips/${row.trip_id}/manifest`, { token: tokens.conductor })).body;
  const code = manifest.codes[row.ref];
  assert.ok(code, 'manifest carries QR payloads for offline checks');
  const batch = { checkins: [{ client_id: 'dev1-0001', trip_id: row.trip_id, code, scanned_at: new Date().toISOString() }] };
  const a = (await api('POST', '/api/agent/sync', { token: tokens.conductor, body: batch })).body;
  const b = (await api('POST', '/api/agent/sync', { token: tokens.conductor, body: batch })).body;
  assert.equal(a.results[0].result, 'boarded');
  assert.equal(b.results[0].result, 'boarded');
  assert.equal(b.results[0].duplicate_sync, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM checkins WHERE client_id = 'dev1-0001'").get().n, 1);
});

test('counter cash sale is confirmed and uses the same seat inventory', async () => {
  const t = await firstTrip();
  const seats = await freeSeats(t.trip_id, 1);
  const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { token: tokens.clerk, body: { seats } })).body;
  const r = await api('POST', '/api/counter/bookings', { token: tokens.clerk, body: { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, passengers: pax(seats) }],
    contact: { name: 'Walk-in', phone: '0955000111' }, payment_method: 'cash' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.bookings[0].status, 'confirmed');
  const again = await api('POST', `/api/trips/${t.trip_id}/holds`, { body: { seats } });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'seat_taken');
});

test('cancel applies the refund policy; trip cancellation refunds in full', async () => {
  const quote = (await api('GET', `/api/my/bookings/${paidRef}/refund-quote`, { token: tokens.passenger })).body;
  assert.equal(quote.pct, quote.hours_to_departure >= 24 ? (quote.hours_to_departure >= 48 ? 90 : 75) : quote.pct);
  const mine = (await api('GET', '/api/my/bookings', { token: tokens.passenger })).body.find(b => b.status === 'confirmed' && b.ref !== paidRef);
  const c = await api('POST', `/api/my/bookings/${mine.ref}/cancel`, { token: tokens.passenger });
  assert.equal(c.status, 200);
  assert.equal(c.body.refund, Math.round((mine.fare_total - mine.discount) * c.body.pct) / 100);

  const trips = (await api('GET', `/api/operator/trips?date=${addDays(localDate(), 3)}`, { token: tokens.operator })).body.filter(t => t.booked > 0);
  const st = await api('POST', `/api/agent/trips/${trips[0].id}/status`, { token: tokens.operator, body: { status: 'cancelled' } });
  assert.equal(st.status, 200);
  assert.ok(st.body.refunded > 0);
  const full = db.prepare(`SELECT b.total, r.amount FROM bookings b JOIN refunds r ON r.booking_id = b.id WHERE b.trip_id = ? AND b.status = 'cancelled' LIMIT 1`).get(trips[0].id);
  assert.equal(full.amount, full.total);
  const byConductor = await api('POST', `/api/agent/trips/${trips[1]?.id ?? trips[0].id}/status`, { token: tokens.conductor, body: { status: 'cancelled' } });
  assert.equal(byConductor.status, 409);
});

test('reschedule moves seats and charges fee plus difference', async () => {
  const b = db.prepare('SELECT * FROM bookings WHERE ref = ?').get(paidRef);
  const alts = (await api('GET', `/api/my/bookings/${paidRef}/alternatives?date=${addDays(localDate(), 2)}`, { token: tokens.passenger })).body;
  assert.ok(alts.length);
  const target = alts[0];
  const seats = await freeSeats(target.id, 2);
  const hold = (await api('POST', `/api/trips/${target.id}/holds`, { token: tokens.passenger, body: { seats } })).body;
  const r = await api('POST', `/api/my/bookings/${paidRef}/reschedule`, { token: tokens.passenger, body: { trip_id: target.id, hold_token: hold.hold_token, seats } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reschedule_fee, 20);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(b.id).status, 'cancelled');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM booking_seats WHERE booking_id = ? AND active = 1').get(b.id).n, 0);
});

test('admin: approve needs documents; commission override; broadcast; analytics', async () => {
  const ops = (await api('GET', '/api/admin/operators', { token: tokens.admin })).body;
  const pending = ops.find(o => o.status === 'pending');
  const r = await api('POST', `/api/admin/operators/${pending.id}/status`, { token: tokens.admin, body: { status: 'approved' } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /tax_clearance/);
  assert.equal((await api('PUT', `/api/admin/operators/${ops[0].id}/terms`, { token: tokens.admin, body: { commission_pct: 6, booking_fee: 4 } })).status, 200);
  const bc = (await api('POST', '/api/admin/broadcast', { token: tokens.admin, body: { audience: 'all_passengers', message: 'Holiday sale: 10% off with KWACHA10', channels: ['sms'] } })).body;
  assert.ok(bc.recipients > 5);
  const a = (await api('GET', '/api/admin/analytics', { token: tokens.admin })).body;
  assert.ok(a.totals.gmv > 0 && a.routes.length && a.operators.length);
});

test('operator: finance balance and settlement limits', async () => {
  const f = (await api('GET', '/api/operator/finance', { token: tokens.operator })).body;
  assert.ok(f.balance.available > 0);
  const tooMuch = await api('POST', '/api/operator/settlements', { token: tokens.operator, body: { amount: f.balance.available + 1 } });
  assert.equal(tooMuch.status, 400);
  const ok = await api('POST', '/api/operator/settlements', { token: tokens.operator, body: { amount: 100 } });
  assert.equal(ok.status, 201);
  const csv = await api('GET', `/api/operator/trips/${db.prepare('SELECT trip_id FROM bookings WHERE operator_id = 1 AND status = ? LIMIT 1').get('confirmed').trip_id}/manifest?format=csv`, { token: tokens.clerk });
  assert.match(csv.body, /"Seat","Passenger".*"ID number"/);
});

test('luggage: counter sale records counts; manifest, CSV, receipt and field app show it', async () => {
  const t = await firstTrip();
  const seats = await freeSeats(t.trip_id, 2);
  const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { token: tokens.clerk, body: { seats } })).body;
  const passengers = pax(seats);
  passengers[0].luggage = { has: true, bags: 2, sacks: 1, containers: 0, boxes: 1, crates: 0, other: 0 };
  passengers[1].luggage = { has: false };
  const r = await api('POST', '/api/counter/bookings', { token: tokens.clerk, body: { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, passengers }],
    contact: { name: 'Walk-in', phone: '0955000222' }, payment_method: 'cash' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ref = r.body.bookings[0].ref;

  const receipt = (await api('GET', `/api/counter/receipt/${ref}`, { token: tokens.clerk })).body;
  assert.match(receipt.qr_svg, /<svg/, 'thermal ticket gets a QR code');
  assert.equal(receipt.issuer, 'Chanda Phiri (counter clerk)');
  const s0 = receipt.seats.find(s => s.seat_no === seats[0]);
  assert.equal(s0.luggage.text, '2 bags, 1 sack, 1 box');
  assert.equal(s0.luggage.total, 4);
  assert.equal(receipt.seats.find(s => s.seat_no === seats[1]).luggage.has, false);

  const man = (await api('GET', `/api/operator/trips/${t.trip_id}/manifest`, { token: tokens.clerk })).body;
  assert.ok(man.luggage_totals.bags >= 2 && man.luggage_totals.boxes >= 1);
  const csv = (await api('GET', `/api/operator/trips/${t.trip_id}/manifest?format=csv`, { token: tokens.clerk })).body;
  assert.match(csv, /"Luggage","Bags","Sacks","Containers","Boxes","Crates","Other","Luggage note"/);
  assert.match(csv, /"TOTAL"/);

  const field = (await api('GET', `/api/agent/trips/${t.trip_id}/manifest`, { token: tokens.conductor })).body;
  assert.ok(field.layout.decks.length, 'field app gets the bus layout for the bus view');
  const onBus = field.seats.find(s => s.seat_no === seats[0]);
  assert.equal(onBus.channel, 'counter', 'a seat sold at the station shows on the bus straight away');
  assert.equal(onBus.luggage.total, 4);
});

test('luggage validation', async () => {
  const t = await firstTrip();
  const seats = await freeSeats(t.trip_id, 1);
  const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { token: tokens.clerk, body: { seats } })).body;
  const sell = luggage => api('POST', '/api/counter/bookings', { token: tokens.clerk, body: { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id,
    passengers: [{ ...pax(seats)[0], luggage }] }], contact: { name: 'X', phone: '0955000333' }, payment_method: 'cash' } });
  let r = await sell({ has: true, bags: 0 });
  assert.equal(r.status, 400); assert.match(r.body.error, /how many bags/);
  r = await sell({ has: true, other: 1 });
  assert.equal(r.status, 400); assert.match(r.body.error, /describe the "other"/);
  r = await sell({ has: true, crates: 99 });
  assert.equal(r.status, 400);
  r = await sell({ has: true, other: 1, note: 'Bicycle' });
  assert.equal(r.status, 201);
});

test('older databases gain the luggage columns on start-up', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(tmp, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE booking_seats (id INTEGER PRIMARY KEY, booking_id INTEGER, trip_id INTEGER, seat_no TEXT, passenger_name TEXT, id_type TEXT, id_number TEXT, gender TEXT,
    is_child INTEGER DEFAULT 0, fare REAL, active INTEGER DEFAULT 1, boarded_at TEXT, boarded_by INTEGER)`);
  old.close();
  const upgraded = openDb(file);
  const cols = upgraded.prepare('PRAGMA table_info(booking_seats)').all().map(c => c.name);
  for (const c of ['lug_bags', 'lug_sacks', 'lug_containers', 'lug_boxes', 'lug_crates', 'lug_other', 'lug_note']) assert.ok(cols.includes(c), c);
  upgraded.close();
});

/* ---------------- v3: luggage charges, loyalty, USSD/SMS, maintenance, languages ---------------- */
const ussd = async (text, phone = '0961234567') => {
  const res = await fetch(base + '/api/ussd', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ sessionId: 's1', serviceCode: '*384*123#', phoneNumber: phone, text }) });
  return res.text();
};
const optionFor = (screen, label) => screen.split('\n').find(l => l.endsWith(`. ${label}`) || l.includes(`. ${label}`))?.split('.')[0];

test('luggage charges: operator price list, first bag free, no commission on luggage', async () => {
  const t = await firstTrip(); // Zambezi: bags K10 (1 free), sacks K20, crates K30
  const q = (await api('POST', '/api/quote', { body: { trip_id: t.trip_id, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id,
    passengers: [{ luggage: { has: true, bags: 2, sacks: 1, crates: 1 } }, { luggage: { has: true, bags: 1 } }] } })).body;
  assert.equal(q.luggage_fees[0], 10 + 20 + 30);
  assert.equal(q.luggage_fees[1], 0, 'first bag free');
  assert.equal(q.luggage_fee, 60);
  assert.equal(q.total, q.fare_total - q.discount + 60 + q.booking_fee);
  const pct = db.prepare('SELECT commission_pct FROM operators WHERE id = ?').get(t.operator_id).commission_pct ?? 8;
  assert.equal(q.commission, Math.round((q.fare_total - q.discount) * pct) / 100, 'commission only on the fare, not luggage');
  const bad = await api('PUT', '/api/operator/profile', { token: tokens.operator, body: { luggage_fees: { sacks: -5 } } });
  assert.equal(bad.status, 400);
});

test('loyalty: spend points at checkout, capped, restored on cancel; staff cannot redeem', async () => {
  const before = (await api('GET', '/api/my/points', { token: tokens.passenger })).body;
  assert.ok(before.balance >= 250);
  const t = await firstTrip();
  const seats = await freeSeats(t.trip_id, 1);
  const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { token: tokens.passenger, body: { seats } })).body;
  const r = await api('POST', '/api/bookings', { token: tokens.passenger, body: { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, passengers: pax(seats) }],
    contact: { name: 'Natasha Mwale', phone: '0971234567' }, payment_method: 'airtel', redeem_points: before.balance } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const b = r.body.bookings[0];
  const cap = Math.floor((b.price.fare_total - b.price.discount) * 0.5 / 0.1);
  assert.equal(b.points_used, Math.min(before.balance, cap));
  assert.equal(b.points_discount, Math.round(b.points_used * 0.1 * 100) / 100);
  assert.equal(b.total, Math.round((b.price.total - b.points_discount) * 100) / 100);
  const mid = (await api('GET', '/api/my/points', { token: tokens.passenger })).body;
  assert.equal(mid.balance, before.balance - b.points_used);
  await api('POST', `/api/my/bookings/${b.ref}/cancel`, { token: tokens.passenger });
  const after = (await api('GET', '/api/my/points', { token: tokens.passenger })).body;
  assert.equal(after.balance, before.balance, 'points given back on cancel');

  const too = await api('POST', '/api/bookings', { token: tokens.passenger, body: { legs: [], contact: { name: 'x', phone: '0971234567' }, payment_method: 'mtn', redeem_points: 999999 } });
  assert.equal(too.status, 400);
});

test('loyalty: completed trips earn points once', async () => {
  const { awardPoints } = await import('../server/services/loyalty.js');
  awardPoints(db);
  const n1 = db.prepare("SELECT COUNT(*) n FROM loyalty_ledger WHERE kind = 'earn'").get().n;
  awardPoints(db);
  const n2 = db.prepare("SELECT COUNT(*) n FROM loyalty_ledger WHERE kind = 'earn'").get().n;
  assert.ok(n1 > 0);
  assert.equal(n1, n2, 'idempotent');
  const row = db.prepare(`SELECT l.points, b.fare_total - b.discount - b.points_discount paid FROM loyalty_ledger l JOIN bookings b ON b.id = l.booking_id WHERE l.kind = 'earn' LIMIT 1`).get();
  assert.equal(row.points, Math.floor(row.paid * 0.1));
});

test('USSD: book a seat from a basic phone, pay by mobile money, check status', async () => {
  assert.match(await ussd(''), /^CON MyTicket\n1\. Book a bus/);
  const from = await ussd('1');
  const lusaka = optionFor(from, 'Lusaka');
  assert.ok(lusaka, from);
  const to = await ussd(`1*${lusaka}`);
  const kitwe = optionFor(to, 'Kitwe');
  assert.ok(kitwe, to);
  assert.match(await ussd(`1*${lusaka}*${kitwe}`), /1\. Today\n2\. Tomorrow/);
  const trips = await ussd(`1*${lusaka}*${kitwe}*2`);
  assert.match(trips, /Pick a bus:\n1\. \d\d:\d\d /);
  const p = `1*${lusaka}*${kitwe}*2*1*1*Joseph Banda`;
  assert.match(await ussd(p), /NRC number/);
  assert.match(await ussd(`${p}*12345`), /^END NRC should look like/);
  const confirm = await ussd(`${p}*123456/78/1`);
  assert.match(confirm, /^CON 1 seat\(s\) Lusaka-Kitwe[\s\S]*1\. Pay with MTN MoMo/);
  const done = await ussd(`${p}*123456/78/1*1`);
  assert.match(done, /^END Approve the MTN MoMo prompt/);
  const ref = done.match(/MT[A-Z0-9]{6}/)[0];
  const b = db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
  assert.equal(b.source, 'ussd');
  assert.equal(b.contact_phone, '260961234567');
  assert.equal(db.prepare("SELECT provider FROM payments WHERE group_ref = ?").get(b.group_ref).provider, 'mtn');
  assert.match(await ussd(`3*${ref}`), new RegExp(`^END ${ref}: bus`));
  assert.match(await ussd(`3*${ref}`, '0971111111'), /not found/, 'other phones cannot look it up');
});

test('USSD + SMS in the caller\'s language', async () => {
  assert.match(await ussd('4*3', '0962223333'), /^END Chilankhulo chasungidwa/);
  assert.match(await ussd('', '0962223333'), /Gulani tikiti/);
  const { handleSms } = await import('../server/services/ussd.js');
  assert.match(await handleSms(db, { from: '+260962223333', text: 'help' }), /MyTicket SMS|STATUS/);
  const res = await fetch(base + '/api/sms/inbound', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ from: '+260962223333', text: 'TICKETS' }) });
  assert.equal(res.status, 200);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE kind = 'sms_reply' AND recipient = '260962223333'").get());
});

test('booking language sets the SMS language', async () => {
  const t = await firstTrip();
  const seats = await freeSeats(t.trip_id, 1);
  const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { token: tokens.clerk, body: { seats } })).body;
  const r = await api('POST', '/api/counter/bookings', { token: tokens.clerk, body: { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, passengers: pax(seats) }],
    contact: { name: 'Mwila', phone: '0966000111' }, payment_method: 'cash', lang: 'bem' } });
  const sms = db.prepare("SELECT body FROM notifications WHERE kind = 'ticket' AND recipient = '260966000111' AND channel = 'sms'").get();
  assert.match(sms.body, /Ukubukisha .* kwasuminishiwa/);
  assert.match(sms.body, new RegExp(r.body.bookings[0].ref));
});

test('maintenance: due items, trip warnings, service resets counter, km logged, daily SMS once', async () => {
  const m = (await api('GET', '/api/operator/maintenance', { token: tokens.operator })).body;
  const std = m.buses.find(b => b.plate === 'ALB 7734');
  assert.ok(std.km_to_service <= 0);
  assert.ok(m.due.some(d => d.plate === 'ALB 7734' && d.kind === 'service' && d.severity === 'overdue'));
  assert.ok(m.due.some(d => d.kind === 'fitness_expiry' && d.severity === 'overdue'));
  assert.ok(m.due.some(d => d.kind === 'licence' && d.severity === 'soon'));
  const trips = (await api('GET', `/api/operator/trips?date=${tomorrow()}`, { token: tokens.operator })).body;
  assert.ok(trips.find(t => t.plate === 'ALB 7734').blockers.includes('service overdue'));

  const svc = await api('POST', '/api/operator/maintenance', { token: tokens.operator, body: { bus_id: std.id, kind: 'service', done_on: localDate(), cost: 5000 } });
  assert.equal(svc.status, 201);
  const after = (await api('GET', '/api/operator/maintenance', { token: tokens.operator })).body.buses.find(b => b.id === std.id);
  assert.equal(after.km_to_service, std.service_interval_km);
  assert.equal((await api('POST', '/api/operator/maintenance', { token: tokens.clerk, body: { bus_id: std.id, kind: 'service', done_on: localDate() } })).status, 403);

  const { logTripKm, sendReminders } = await import('../server/services/maintenance.js');
  const trip = db.prepare("SELECT t.id, t.bus_id, r.distance_km FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.km_logged = 0 AND t.status != 'cancelled' LIMIT 1").get();
  const odo = db.prepare('SELECT odometer_km FROM buses WHERE id = ?').get(trip.bus_id).odometer_km;
  db.prepare("UPDATE trips SET status = 'arrived' WHERE id = ?").run(trip.id);
  logTripKm(db); logTripKm(db);
  assert.equal(db.prepare('SELECT odometer_km FROM buses WHERE id = ?').get(trip.bus_id).odometer_km, odo + trip.distance_km);

  db.prepare("DELETE FROM settings WHERE key LIKE 'maint_reminder_%'").run();
  const first = sendReminders(db), second = sendReminders(db);
  assert.ok(first >= 1);
  assert.equal(second, 0, 'one SMS per company per day');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE kind = 'maintenance' AND body LIKE '%overdue%'").get());
});
