import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myticket-test-'));
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { seedDemo, DEMO_PASSWORD, DEMO_TOTP_SECRET } = await import('../server/seed.js');
const { totp } = await import('../server/security.js');
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
async function login(phone) {
  const r = (await api('POST', '/api/auth/login', { body: { phone, password: DEMO_PASSWORD } })).body;
  if (r.mfa_required) {
    const v = await api('POST', '/api/auth/mfa/verify', { token: r.token, body: { method: 'totp', code: totp(DEMO_TOTP_SECRET) } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }
  return r.token;
}
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
  // Cash sales need an open cash shift.
  for (const k of ['clerk', 'operator', 'conductor']) await api('POST', '/api/counter/shift/open', { token: tokens[k], body: { opening_float: 200 } });
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

/* ---------------- v4: demand-based fares, waitlist, reminders, backups ---------------- */
test('demand-based fares: surcharge by occupancy, early-booking discount, search shows the live fare', async () => {
  const { adultFare } = await import('../server/services/pricing.js');
  const tripOf = id => db.prepare('SELECT tr.*, r.distance_km FROM trips tr JOIN routes r ON r.id = tr.route_id WHERE tr.id = ?').get(id);
  const res = (await api('GET', `/api/search?from=Lusaka&to=Kitwe&date=${addDays(localDate(), 5)}`)).body.outbound;
  const cbe = res.find(t => t.operator === 'Copperbelt Express');
  const trip = tripOf(cbe.trip_id);
  const stop = id => db.prepare('SELECT * FROM route_stops WHERE id = ?').get(id);
  const a = adultFare(db, trip, stop(cbe.boarding_points[0].stop_id), stop(cbe.dropping_points[0].stop_id));
  assert.equal(a.early, 10, '5 days ahead ≥ 3 → early discount');
  assert.equal(cbe.fare, a.fare, 'search shows the same fare checkout charges');
  // Fill the bus to 80%+ and the surcharge appears.
  const cap = db.prepare('SELECT l.capacity FROM buses b JOIN layouts l ON l.id = b.layout_id WHERE b.id = ?').get(trip.bus_id).capacity;
  const bk = db.prepare('SELECT id FROM bookings WHERE trip_id = ? LIMIT 1').get(trip.id)
    || db.prepare("INSERT INTO bookings (ref, group_ref, trip_id, operator_id, channel, status, from_stop_id, to_stop_id, contact_name, contact_phone, fare_total, booking_fee, total, commission) VALUES ('MTFILL01','GFILL',?,?,'counter','confirmed',?,?,'x','260960000000',0,0,0,0) RETURNING id").get(trip.id, trip.operator_id, cbe.boarding_points[0].stop_id, cbe.dropping_points[0].stop_id);
  const sold = db.prepare('SELECT COUNT(*) n FROM booking_seats WHERE trip_id = ? AND active = 1').get(trip.id).n;
  const taken = new Set(db.prepare('SELECT seat_no FROM booking_seats WHERE trip_id = ? AND active = 1').all(trip.id).map(r => r.seat_no));
  const ins = db.prepare("INSERT INTO booking_seats (booking_id, trip_id, seat_no, passenger_name, id_type, id_number, fare) VALUES (?,?,?,?,'NRC','111111/11/1',0)");
  let added = 0;
  for (let n = 1; n <= cap && sold + added < Math.ceil(cap * 0.8); n++) if (!taken.has(String(n))) { ins.run(bk.id, trip.id, String(n), 'Filler'); added++; }
  const b = adultFare(db, trip, stop(cbe.boarding_points[0].stop_id), stop(cbe.dropping_points[0].stop_id));
  assert.equal(b.demand, 20);
  assert.equal(b.fare, Math.max(5, Math.round(b.base * (1 + (b.peak + 20 - 10) / 100) / 5) * 5));
  const bad = await api('PUT', '/api/operator/profile', { token: tokens.operator, body: { dynamic_pricing: { enabled: true, tiers: [{ occupancy: 150, pct: 10 }] } } });
  assert.equal(bad.status, 400);
});

test('waitlist: full bus → join → cancellation frees a seat → first in line gets it held with a pay link', async () => {
  const { processWaitlist } = await import('../server/services/waitlist.js');
  const t = await firstTrip();
  // Fill every free seat with one counter booking.
  const free = (await api('GET', `/api/trips/${t.trip_id}/seats`)).body.decks.flatMap(d => d.rows.flat()).filter(s => s && s.status === 'available');
  const legs = [];
  for (let i = 0; i < free.length; i += 6) {
    const chunk = free.slice(i, i + 6);
    const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { token: tokens.clerk, body: { seats: chunk.map(s => s.no) } })).body;
    const r = await api('POST', '/api/counter/bookings', { token: tokens.clerk, body: { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id,
      passengers: chunk.map((s, k) => ({ ...pax([s.no])[0], gender: s.female ? 'F' : 'M', name: `Filler ${i + k}` })) }], contact: { name: 'Group', phone: '0955111000' }, payment_method: 'cash' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    legs.push(r.body.bookings[0].ref);
  }
  const early = await api('POST', `/api/trips/${t.trip_id}/waitlist`, { body: { seats: 2, name: 'Wait One', phone: '0961000001', from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id } });
  assert.equal(early.status, 201, JSON.stringify(early.body));
  assert.equal(early.body.position, 1);
  assert.equal(early.body.status, 'waiting');
  const second = (await api('POST', `/api/trips/${t.trip_id}/waitlist`, { body: { seats: 1, name: 'Wait Two', phone: '0961000002', from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id } })).body;
  assert.equal(second.position, 2);
  const dup = await api('POST', `/api/trips/${t.trip_id}/waitlist`, { body: { seats: 1, name: 'Again', phone: '0961000001', from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id } });
  assert.equal(dup.status, 409);

  // A group booking of 6 is cancelled by the operator → seats free → Wait One (2 seats) and Wait Two (1 seat) are offered.
  const { cancelBooking } = await import('../server/services/bookings.js');
  cancelBooking(db, db.prepare('SELECT * FROM bookings WHERE ref = ?').get(legs[0]), { by: null, reason: 'test' });
  const w1 = db.prepare("SELECT * FROM waitlist WHERE phone = '260961000001'").get();
  const w2 = db.prepare("SELECT * FROM waitlist WHERE phone = '260961000002'").get();
  assert.equal(w1.status, 'offered');
  assert.equal(w2.status, 'offered');
  const held = db.prepare('SELECT COUNT(*) n FROM seat_holds WHERE hold_token = ?').get(w1.hold_token).n;
  assert.equal(held, 2);
  const sms = db.prepare("SELECT body FROM notifications WHERE kind = 'waitlist_offer' AND recipient = '260961000001'").get().body;
  const link = sms.match(/#\/offer\/(\d+)-(\S+)/);
  assert.ok(link, sms);

  // The link gives the held seats; booking them marks the waitlist entry booked.
  const offer = (await api('GET', `/api/waitlist/offer/${link[1]}?k=${link[2]}`)).body;
  assert.equal(offer.seats.length, 2);
  assert.equal((await api('GET', `/api/waitlist/offer/${link[1]}?k=wrongkey`)).status, 404);
  const r = await api('POST', '/api/bookings', { body: { legs: [{ trip_id: t.trip_id, hold_token: offer.hold_token, from_stop_id: offer.from_stop_id, to_stop_id: offer.to_stop_id,
    passengers: offer.seats.map((s, k) => ({ ...pax([s])[0], gender: 'F', name: `Wait One ${k}` })) }], contact: { name: 'Wait One', phone: '0961000001' }, payment_method: 'mtn' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(db.prepare('SELECT status FROM waitlist WHERE id = ?').get(w1.id).status, 'booked');

  // An unanswered offer expires and its seats go to the next person.
  db.prepare("UPDATE waitlist SET offer_expires = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(w2.id);
  db.prepare("UPDATE seat_holds SET expires_at = '2000-01-01T00:00:00.000Z' WHERE hold_token = ?").run(w2.hold_token);
  processWaitlist(db);
  assert.equal(db.prepare('SELECT status FROM waitlist WHERE id = ?').get(w2.id).status, 'expired');
});

test('departure reminders: sent once, in the passenger\'s language, not for last-minute bookings', async () => {
  const { sendDepartureReminders } = await import('../server/services/reminders.js');
  const b = db.prepare(`SELECT b.id, b.ref FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE b.status = 'confirmed' AND b.reminded_at IS NULL AND t.depart_at > ? ORDER BY t.depart_at LIMIT 1`).get(new Date().toISOString());
  // Move that trip to 2 hours from now and pretend it was booked yesterday.
  const trip = db.prepare('SELECT trip_id FROM bookings WHERE id = ?').get(b.id).trip_id;
  db.prepare('UPDATE trips SET depart_at = ? WHERE id = ?').run(new Date(Date.now() + 2 * 36e5).toISOString(), trip);
  db.prepare("UPDATE bookings SET lang = 'nya', confirmed_at = datetime('now','-1 day') WHERE id = ?").run(b.id);
  const n1 = sendDepartureReminders(db), n2 = sendDepartureReminders(db);
  assert.ok(n1 >= 1);
  assert.equal(n2, 0);
  const sms = db.prepare("SELECT body FROM notifications WHERE kind = 'reminder' AND body LIKE ?").get(`%${b.ref}%`);
  assert.match(sms.body, /Chikumbutso/);
});

test('backups: snapshot is a working database; old snapshots are pruned; health endpoint checks the DB', async () => {
  const { config } = await import('../server/config.js');
  const { backupNow, pruneBackups } = await import('../server/backup.js');
  config.backupDir = path.join(tmp, 'backups');
  const file = backupNow(db);
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(file);
  assert.ok(copy.prepare('SELECT COUNT(*) n FROM bookings').get().n > 100);
  copy.close();
  assert.equal(backupNow(db, { daily: true }), null, 'only one nightly backup per day');
  fs.writeFileSync(path.join(config.backupDir, 'myticket-2000-01-01T00-00-00.db'), '');
  fs.writeFileSync(path.join(config.backupDir, 'keep-me.txt'), '');
  assert.equal(pruneBackups(14), 1);
  assert.ok(fs.existsSync(path.join(config.backupDir, 'keep-me.txt')), 'never deletes files it did not create');
  assert.equal((await api('GET', '/api/health')).body.ok, true);
});

/* ---------------- Security step 1: phone verification, password reset, persistent limits ---------------- */
test('register: guest bookings are linked only after the phone is verified', async () => {
  const phone = '0961474747';
  // A guest booking made with this number earlier
  const t = await firstTrip();
  const seats = await freeSeats(t.trip_id, 1);
  const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { body: { seats } })).body;
  const g = (await api('POST', '/api/bookings', { body: { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, passengers: pax(seats) }],
    contact: { name: 'Guest', phone }, payment_method: 'station' } })).body;
  const weak = await api('POST', '/api/auth/register', { body: { name: 'Someone', phone, password: 'password' } });
  assert.equal(weak.status, 400);
  const reg = await api('POST', '/api/auth/register', { body: { name: 'Someone', phone, password: 'a long passphrase' } });
  assert.equal(reg.status, 201);
  assert.match(reg.body.dev_code, /^\d{6}$/);
  const tok = reg.body.token;
  assert.equal((await api('GET', '/api/my/bookings', { token: tok })).body.length, 0, 'not linked before verification');
  const wrong = await api('POST', '/api/auth/verify-phone', { token: tok, body: { code: reg.body.dev_code === '000000' ? '111111' : '000000' } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /2 tries left/);
  const ok = await api('POST', '/api/auth/verify-phone', { token: tok, body: { code: reg.body.dev_code } });
  assert.equal(ok.body.linked_bookings, 1);
  assert.equal((await api('GET', '/api/my/bookings', { token: tok })).body[0].ref, g.bookings[0].ref);
  const reuse = await api('POST', '/api/auth/verify-phone', { token: tok, body: { code: reg.body.dev_code } });
  assert.equal(reuse.status, 400, 'codes work once');
});

test('password reset by SMS code: generic answer, 3 tries, signs out old sessions, SMS notice', async () => {
  const unknown = await api('POST', '/api/auth/otp', { body: { purpose: 'reset', phone: '0961999888' } });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.dev_code, undefined, 'no code for numbers without an account');
  const phone = '0961474747';
  const oldTok = (await api('POST', '/api/auth/login', { body: { phone, password: 'a long passphrase' } })).body.token;
  const r = await api('POST', '/api/auth/otp', { body: { purpose: 'reset', phone } });
  assert.equal(r.body.message, unknown.body.message, 'same answer whether or not the account exists');
  for (let i = 0; i < 3; i++) await api('POST', '/api/auth/password/reset', { body: { phone, code: '999999', password: 'another long phrase' } });
  const locked = await api('POST', '/api/auth/password/reset', { body: { phone, code: r.body.dev_code, password: 'another long phrase' } });
  assert.equal(locked.status, 400);
  assert.match(locked.body.error, /Too many wrong codes|expired/);
  const r2 = await api('POST', '/api/auth/otp', { body: { purpose: 'reset', phone } });
  const done = await api('POST', '/api/auth/password/reset', { body: { phone, code: r2.body.dev_code, password: 'another long phrase' } });
  assert.equal(done.status, 200);
  assert.equal((await api('GET', '/api/me', { token: oldTok })).status, 401, 'old sessions are signed out');
  assert.equal((await api('POST', '/api/auth/login', { body: { phone, password: 'another long phrase' } })).status, 200);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE kind = 'password_changed' AND recipient = '260961474747'").get());
  assert.equal((await api('POST', '/api/auth/otp', { body: { purpose: 'reset', phone } })).status, 200, 'third code');
  const fourth = await api('POST', '/api/auth/otp', { body: { purpose: 'reset', phone } });
  assert.equal(fourth.status, 429, 'at most 3 codes per 15 minutes');
});

test('login lockout survives a restart (stored in the database)', async () => {
  for (let i = 0; i < 8; i++) await api('POST', '/api/auth/login', { body: { phone: '0961222111', password: 'wrong-password' } });
  const blocked = await api('POST', '/api/auth/login', { body: { phone: '0961222111', password: 'wrong-password' } });
  assert.equal(blocked.status, 429);
  assert.ok(db.prepare("SELECT count FROM rate_limits WHERE key = 'login:260961222111'").get().count >= 8);
});

/* ---------------- Security step 2: sessions, two-step sign-in, devices ---------------- */
async function rawLogin(phone, password = DEMO_PASSWORD, headers = {}) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ phone, password }) });
  return { status: res.status, body: await res.json(), cookies: res.headers.getSetCookie() };
}

test('admin must pass a second step; a half-signed-in session can do nothing else', async () => {
  const r = await rawLogin('0950000001');
  assert.equal(r.body.mfa_required, true);
  assert.deepEqual(r.body.methods, ['totp', 'sms', 'recovery']);
  const blocked = await api('GET', '/api/admin/analytics', { token: r.body.token });
  assert.equal(blocked.status, 401);
  assert.equal(blocked.body.code, 'mfa_required');
  assert.equal((await api('POST', '/api/auth/mfa/verify', { token: r.body.token, body: { method: 'totp', code: '000000' } })).status, 400);
  // SMS fallback
  const sms = (await api('POST', '/api/auth/mfa/sms', { token: r.body.token })).body;
  const ok = await api('POST', '/api/auth/mfa/verify', { token: r.body.token, body: { method: 'sms', code: sms.dev_code } });
  assert.equal(ok.status, 200);
  assert.equal((await api('GET', '/api/admin/analytics', { token: r.body.token })).status, 200);
});

test('session cookie is HttpOnly + SameSite=Strict; cookie requests need the CSRF header', async () => {
  const r = await rawLogin('0971234567');
  const cookie = r.cookies.find(c => c.startsWith('mt_session='));
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const jar = r.cookies.map(c => c.split(';')[0]).join('; ');
  const get = await fetch(base + '/api/me', { headers: { cookie: jar } });
  assert.equal(get.status, 200);
  const noHeader = await fetch(base + '/api/auth/logout-all', { method: 'POST', headers: { cookie: jar } });
  assert.equal(noHeader.status, 403, 'cross-site style request blocked');
  const withHeader = await fetch(base + '/api/auth/logout-all', { method: 'POST', headers: { cookie: jar, 'x-mt-csrf': '1' } });
  assert.equal(withHeader.status, 200);
  assert.equal(r.body.token && db.prepare('SELECT COUNT(*) n FROM sessions WHERE id = ?').get(r.body.token).n, 0, 'only a hash of the token is stored');
});

test('authenticator app: setup, recovery codes (single use), sign out everywhere, new-device SMS', async () => {
  const tok = await login('0960000002'); // operator owner
  const setup = (await api('POST', '/api/auth/totp/setup', { token: tok })).body;
  assert.match(setup.uri, /^otpauth:\/\/totp\/MyTicket/);
  assert.match(setup.qr_svg, /<svg/);
  assert.equal((await api('POST', '/api/auth/totp/enable', { token: tok, body: { code: '123456' } })).status, 400);
  const en = (await api('POST', '/api/auth/totp/enable', { token: tok, body: { code: totp(setup.secret) } })).body;
  assert.equal(en.recovery_codes.length, 8);
  assert.ok(db.prepare("SELECT totp_secret FROM users WHERE phone = '260960000002'").get().totp_secret.startsWith('enc:v1:'), 'secret encrypted at rest');
  // Now the owner needs a second step; use a recovery code from a "new device"
  const r = await rawLogin('0960000002', DEMO_PASSWORD, { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0' });
  assert.equal(r.body.mfa_required, true);
  const used = await api('POST', '/api/auth/mfa/verify', { token: r.body.token, body: { method: 'recovery', code: en.recovery_codes[0] } });
  assert.equal(used.status, 200);
  const again = await rawLogin('0960000002');
  assert.equal((await api('POST', '/api/auth/mfa/verify', { token: again.body.token, body: { method: 'recovery', code: en.recovery_codes[0] } })).status, 400, 'recovery codes work once');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE kind = 'new_device' AND recipient = '260960000002'").get());
  const list = (await api('GET', '/api/auth/sessions', { token: r.body.token })).body;
  assert.ok(list.length >= 2 && list.some(s => s.current) && list.some(s => s.device === 'Chrome on Android'));
  const out = (await api('POST', '/api/auth/logout-all', { token: r.body.token })).body;
  assert.ok(out.signed_out >= 1);
  assert.equal((await api('GET', '/api/me', { token: tok })).status, 401, 'other devices signed out');
  assert.equal((await api('GET', '/api/me', { token: r.body.token })).status, 200, 'this device stays signed in');
  // Turn it off again so later tests sign in normally
  assert.equal((await api('POST', '/api/auth/totp/disable', { token: r.body.token, body: { password: DEMO_PASSWORD, code: totp(setup.secret) } })).status, 200);
  tokens.operator = r.body.token;
});

test('staff sessions end after 12 hours idle', async () => {
  const tok = await login('0960000003');
  db.prepare("UPDATE sessions SET last_seen = datetime('now', '-13 hours') WHERE user_id = (SELECT id FROM users WHERE phone = '260960000003')").run();
  assert.equal((await api('GET', '/api/me', { token: tok })).status, 401);
  tokens.clerk = await login('0960000003');
});

/* ---------------- Security step 3: maker-checker for money ---------------- */
test('payouts: approve by one admin, paid by another; never the same person', async () => {
  const admin2 = await login('0950000002');
  const req = (await api('POST', '/api/operator/settlements', { token: tokens.operator, body: { amount: 150 } })).body;
  assert.equal((await api('POST', `/api/admin/settlements/${req.id}`, { token: tokens.admin, body: { status: 'paid', note: 'TRX1' } })).status, 409, 'cannot skip approval');
  assert.equal((await api('POST', `/api/admin/settlements/${req.id}`, { token: tokens.admin, body: { status: 'approved' } })).status, 200);
  const same = await api('POST', `/api/admin/settlements/${req.id}`, { token: tokens.admin, body: { status: 'paid', note: 'TRX1' } });
  assert.equal(same.status, 403);
  assert.match(same.body.error, /different admin/);
  assert.equal((await api('POST', `/api/admin/settlements/${req.id}`, { token: admin2, body: { status: 'paid', note: 'ZANACO-TRX-889' } })).status, 200);
  const row = db.prepare('SELECT * FROM settlements WHERE id = ?').get(req.id);
  assert.notEqual(row.approved_by, row.paid_by);
});

test('refunds above the threshold need a second admin; the creator cannot mark them paid', async () => {
  const admin2 = await login('0950000002');
  const b = db.prepare("SELECT id, user_id, total FROM bookings WHERE status = 'completed' AND total > 600 AND user_id IS NOT NULL LIMIT 1").get();
  const d = db.prepare("INSERT INTO disputes (booking_id, user_id, category, description) VALUES (?,?,?,?) RETURNING id").get(b.id, b.user_id, 'service', 'Bus broke down').id;
  assert.equal((await api('POST', `/api/admin/disputes/${d}/resolve`, { token: tokens.admin, body: { resolution: 'Breakdown refund', refund_amount: 550 } })).status, 200);
  const ref = db.prepare('SELECT * FROM refunds WHERE reason LIKE ? ORDER BY id DESC').get(`Dispute #${d}:%`);
  assert.equal(ref.status, 'awaiting_approval');
  assert.equal((await api('POST', `/api/admin/refunds/${ref.id}`, { token: tokens.admin, body: { status: 'paid' } })).status, 409);
  assert.equal((await api('POST', `/api/admin/refunds/${ref.id}`, { token: tokens.admin, body: { status: 'approved' } })).status, 403, 'creator cannot approve');
  assert.equal((await api('POST', `/api/admin/refunds/${ref.id}`, { token: admin2, body: { status: 'approved' } })).status, 200);
  assert.equal((await api('POST', `/api/admin/refunds/${ref.id}`, { token: admin2, body: { status: 'paid' } })).status, 403, 'approver cannot pay');
  assert.equal((await api('POST', `/api/admin/refunds/${ref.id}`, { token: tokens.admin, body: { status: 'paid' } })).status, 403, 'creator cannot pay');
});

test('bank account change waits 48 h with SMS; payouts blocked meanwhile; applied by the sweep', async () => {
  const before = db.prepare('SELECT bank_account FROM operators WHERE id = 1').get().bank_account;
  const r = await api('PUT', '/api/operator/profile', { token: tokens.operator, body: { bank_name: 'FNB', bank_account: '62000000001', bank_branch: 'Lusaka' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.bank_change);
  assert.equal(db.prepare('SELECT bank_account FROM operators WHERE id = 1').get().bank_account, before, 'not changed yet');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE kind = 'bank_change' AND body LIKE '%ending 0001%'").get());
  const blocked = await api('POST', '/api/operator/settlements', { token: tokens.operator, body: { amount: 100 } });
  assert.equal(blocked.status, 409);
  db.prepare("UPDATE bank_changes SET effective_at = datetime('now', '-1 minute') WHERE status = 'pending'").run();
  sweep(db);
  assert.equal(db.prepare('SELECT bank_account FROM operators WHERE id = 1').get().bank_account, '62000000001');
  // A change can be cancelled before it takes effect
  await api('PUT', '/api/operator/profile', { token: tokens.operator, body: { bank_account: '99999999999' } });
  assert.equal((await api('POST', '/api/operator/bank-change/cancel', { token: tokens.operator })).status, 200);
  sweep(db);
  assert.equal(db.prepare('SELECT bank_account FROM operators WHERE id = 1').get().bank_account, '62000000001');
});

/* ---------------- Security step 4: ID numbers, retention, data rights ---------------- */
test('ID numbers: encrypted at rest, masked on tickets and in the field app, full only on the audited manifest', async () => {
  const t = await firstTrip();
  const seats = await freeSeats(t.trip_id, 1);
  const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { token: tokens.clerk, body: { seats } })).body;
  const r = (await api('POST', '/api/counter/bookings', { token: tokens.clerk, body: { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id,
    passengers: [{ seat_no: seats[0], name: 'Private Person', id_type: 'NRC', id_number: '987654/32/1', gender: 'M' }] }], contact: { name: 'P', phone: '0955123123' }, payment_method: 'cash' } })).body;
  const ref = r.bookings[0].ref;
  const row = db.prepare('SELECT id_number, id_hint FROM booking_seats WHERE booking_id = (SELECT id FROM bookings WHERE ref = ?)').get(ref);
  assert.ok(row.id_number.startsWith('enc:v1:'), 'stored encrypted');
  assert.ok(!row.id_number.includes('987654'));
  assert.equal(row.id_hint, '****54/32/1');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM booking_seats WHERE id_number NOT LIKE 'enc:v1:%' AND id_number != 'REMOVED' AND passenger_name != 'Filler'").get().n, 0, 'demo data encrypted too (Filler rows are raw test inserts)');
  const receipt = (await api('GET', `/api/counter/receipt/${ref}`, { token: tokens.clerk })).body;
  assert.equal(receipt.seats[0].id_number, '****54/32/1');
  const field = (await api('GET', `/api/agent/trips/${t.trip_id}/manifest`, { token: tokens.conductor })).body;
  assert.equal(field.seats.find(s => s.ref === ref).id_number, '****54/32/1', 'phones carry masked IDs only');
  const masked = (await api('GET', `/api/operator/trips/${t.trip_id}/manifest`, { token: tokens.clerk })).body;
  assert.equal(masked.passengers.find(p => p.ref === ref).id_number, '****54/32/1');
  const before = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'manifest_full_ids'").get().n;
  const full = (await api('GET', `/api/operator/trips/${t.trip_id}/manifest?full=1`, { token: tokens.clerk })).body;
  assert.equal(full.passengers.find(p => p.ref === ref).id_number, '987654/32/1');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'manifest_full_ids'").get().n, before + 1, 'viewing full IDs is logged');
  const csv = (await api('GET', `/api/operator/trips/${t.trip_id}/manifest?format=csv`, { token: tokens.clerk })).body;
  assert.match(csv, /987654\/32\/1/);
});

test('ID numbers are erased after the retention period', async () => {
  const old = db.prepare(`SELECT bs.id FROM booking_seats bs JOIN trips t ON t.id = bs.trip_id WHERE t.service_date < date('now', '-30 days') LIMIT 1`).get()
    || (() => { const s = db.prepare('SELECT bs.id, bs.trip_id FROM booking_seats bs LIMIT 1').get(); db.prepare("UPDATE trips SET service_date = date('now', '-40 days') WHERE id = ?").run(s.trip_id); return s; })();
  sweep(db);
  const row = db.prepare('SELECT id_number, id_hint FROM booking_seats WHERE id = ?').get(old.id);
  assert.equal(row.id_number, 'REMOVED');
  assert.ok(row.id_hint, 'masked hint kept for the records');
});

test('passenger can download their data and delete their account', async () => {
  const reg = (await api('POST', '/api/auth/register', { body: { name: 'Leaving User', phone: '0961313131', password: 'goodbye forever now' } })).body;
  await api('POST', '/api/auth/verify-phone', { token: reg.token, body: { code: reg.dev_code } });
  const data = (await api('GET', '/api/my/data', { token: reg.token })).body;
  assert.equal(data.account.name, 'Leaving User');
  assert.equal((await api('POST', '/api/my/account/delete', { token: reg.token, body: { password: 'wrong' } })).status, 400);
  assert.equal((await api('POST', '/api/my/account/delete', { token: reg.token, body: { password: 'goodbye forever now' } })).status, 200);
  assert.equal((await api('GET', '/api/me', { token: reg.token })).status, 401);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE phone = '260961313131'").get().n, 0, 'phone number removed');
  assert.equal((await api('POST', '/api/auth/register', { body: { name: 'Back Again', phone: '0961313131', password: 'a fresh start here' } })).status, 201, 'the number can register again');
});

/* ---------------- Security step 5: cash shifts, voids with supervisor PIN ---------------- */
test('cash shifts: no shift no cash; ledger is append-only; close compares counted cash and alerts on a big shortfall', async () => {
  const fresh = await login('0960000003'); // the clerk; close and reopen a shift for a clean count
  const cur = (await api('GET', '/api/counter/shift', { token: fresh })).body;
  if (cur) await api('POST', '/api/counter/shift/close', { token: fresh, body: { counted_cash: cur.expected_cash } });
  const t = await firstTrip('Lusaka', 'Kitwe', addDays(localDate(), 4)); // tomorrow's bus was filled by the waitlist test
  const sell = async () => {
    const seats = await freeSeats(t.trip_id, 1);
    const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { token: fresh, body: { seats } })).body;
    return api('POST', '/api/counter/bookings', { token: fresh, body: { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, passengers: pax(seats) }], contact: { name: 'W', phone: '0955202020' }, payment_method: 'cash' } });
  };
  const noShift = await sell();
  assert.equal(noShift.status, 409);
  assert.equal(noShift.body.code, 'no_shift');
  assert.equal((await api('POST', '/api/counter/shift/open', { token: fresh, body: { opening_float: 300 } })).status, 201);
  const r1 = await sell(), r2 = await sell();
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  const s1 = r1.body, s2 = r2.body;
  const shift = (await api('GET', '/api/counter/shift', { token: fresh })).body;
  assert.equal(shift.expected_cash, 300 + s1.total + s2.total);
  assert.throws(() => db.prepare('DELETE FROM cash_movements WHERE shift_id = ?').run(shift.id), /append-only/);
  assert.throws(() => db.prepare('UPDATE cash_movements SET amount = 0 WHERE shift_id = ?').run(shift.id), /append-only/);

  // Void needs the owner's supervisor PIN
  assert.equal((await api('PUT', '/api/operator/supervisor-pin', { token: tokens.operator, body: { password: DEMO_PASSWORD, pin: '1234' } })).status, 400, 'sequential PIN refused');
  assert.equal((await api('PUT', '/api/operator/supervisor-pin', { token: tokens.operator, body: { password: DEMO_PASSWORD, pin: '4826' } })).status, 200);
  const ref = s2.bookings[0].ref;
  const badPin = await api('POST', `/api/counter/void/${ref}`, { token: fresh, body: { reason: 'Wrong seat sold', supervisor_phone: '0960000002', supervisor_pin: '0000' } });
  assert.equal(badPin.status, 403);
  const ok = await api('POST', `/api/counter/void/${ref}`, { token: fresh, body: { reason: 'Wrong seat sold', supervisor_phone: '0960000002', supervisor_pin: '4826' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(db.prepare('SELECT status FROM bookings WHERE ref = ?').get(ref).status, 'cancelled');
  const after = (await api('GET', '/api/counter/shift', { token: fresh })).body;
  assert.equal(after.expected_cash, 300 + s1.total, 'void takes the cash back out of the drawer');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'void_sale' AND entity_id = ? AND detail LIKE '%Mwila Banda%'").get(ref));
  // Close K100 short without notes → refused; with notes → closes and texts the owner
  const short = after.expected_cash - 100;
  assert.equal((await api('POST', '/api/counter/shift/close', { token: fresh, body: { counted_cash: short } })).status, 400);
  const closed = (await api('POST', '/api/counter/shift/close', { token: fresh, body: { counted_cash: short, notes: 'Gave change twice' } })).body;
  assert.equal(closed.variance, -100);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE kind = 'cash_alert' AND body LIKE '%SHORT by K100.00%'").get());
  const list = (await api('GET', '/api/operator/shifts', { token: tokens.operator })).body;
  assert.ok(list.some(s => s.id === shift.id && s.variance === -100 && s.voids === 1));
  await api('POST', '/api/counter/shift/open', { token: fresh, body: { opening_float: 200 } });
  tokens.clerk = fresh;
});

/* ---------------- Security step 6: field app (server side) ---------------- */
test('owner can sign a staff member out of every device (lost phone); deactivating does too', async () => {
  const cond = await login('0970000004');
  const staff = (await api('GET', '/api/operator/staff', { token: tokens.operator })).body.find(s => s.login_phone === '260970000004');
  const r = await api('POST', `/api/operator/staff/${staff.id}/sign-out`, { token: tokens.operator });
  assert.ok(r.body.signed_out >= 1);
  assert.equal((await api('GET', '/api/agent/trips', { token: cond })).status, 401);
  assert.equal((await api('POST', `/api/operator/staff/${staff.id}/sign-out`, { token: tokens.clerk })).status, 403, 'only the owner');
  tokens.conductor = await login('0970000004');
  await api('POST', '/api/counter/shift/open', { token: tokens.conductor, body: { opening_float: 0 } });
});

/* ---------------- Security step 7: anti-abuse ---------------- */
test('anti-hoarding: one network can hold at most 12 seats at once; staff are exempt', async () => {
  db.prepare('DELETE FROM seat_holds').run();
  const d = addDays(localDate(), 6);
  const t = await firstTrip('Lusaka', 'Kitwe', d);
  const other = (await api('GET', `/api/search?from=Lusaka&to=Livingstone&date=${d}`)).body.outbound[0];
  const a = await freeSeats(t.trip_id, 6), b = await freeSeats(other.trip_id, 6);
  assert.equal((await api('POST', `/api/trips/${t.trip_id}/holds`, { body: { seats: a } })).status, 200);
  assert.equal((await api('POST', `/api/trips/${other.trip_id}/holds`, { body: { seats: b } })).status, 200);
  const third = await api('POST', `/api/trips/${other.trip_id}/holds`, { body: { seats: [ (await freeSeats(other.trip_id, 1))[0] ] } });
  assert.equal(third.status, 429);
  assert.equal(third.body.code, 'too_many_holds');
  const staff = await api('POST', `/api/trips/${other.trip_id}/holds`, { token: tokens.clerk, body: { seats: await freeSeats(other.trip_id, 1) } });
  assert.equal(staff.status, 200, 'station staff are not limited');
  db.prepare('DELETE FROM seat_holds').run();
});

test('a phone number can have at most 3 unpaid bookings', async () => {
  const d = addDays(localDate(), 6);
  const t = await firstTrip('Lusaka', 'Kitwe', d);
  const book = async () => {
    const seats = await freeSeats(t.trip_id, 1);
    const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { body: { seats } })).body;
    return api('POST', '/api/bookings', { body: { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, passengers: pax(seats) }],
      contact: { name: 'Hoarder', phone: '0961717171' }, payment_method: 'station' } });
  };
  for (let i = 0; i < 3; i++) assert.equal((await book()).status, 201);
  const fourth = await book();
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.code, 'too_many_unpaid');
  db.prepare('DELETE FROM seat_holds').run();
});

test('promo codes can be limited per phone number', async () => {
  const t = await firstTrip('Lusaka', 'Kitwe', addDays(localDate(), 6));
  const q = (phone) => api('POST', '/api/quote', { body: { trip_id: t.trip_id, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, promo_code: 'KWACHA10', phone } });
  assert.equal((await q('0961234567')).status, 400, 'this number already used KWACHA10 earlier in the tests');
  assert.match((await q('0961234567')).body.error, /once per phone/);
  assert.equal((await q('0961888777')).status, 200, 'a new number can still use it');
});

test('payment prompts to one number are rate-limited', async () => {
  for (let i = 0; i < 8; i++) db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('pay:msisdn:260961999999', strftime('%s','now'), 8) ON CONFLICT(key) DO UPDATE SET count = 8, window_start = strftime('%s','now')").run();
  const r = await api('POST', '/api/groups/GNOTHING/pay', { body: { method: 'mtn', msisdn: '0961999999' } });
  assert.equal(r.status, 429);
});

/* ---------------- Security step 8: idempotency ---------------- */
test('the same booking request sent twice (double tap / retry) creates one booking', async () => {
  const t = (await api('GET', `/api/search?from=Lusaka&to=Livingstone&date=${addDays(localDate(), 6)}`)).body.outbound[0];
  const seats = await freeSeats(t.trip_id, 1);
  const hold = (await api('POST', `/api/trips/${t.trip_id}/holds`, { body: { seats } })).body;
  const body = { legs: [{ trip_id: t.trip_id, hold_token: hold.hold_token, from_stop_id: t.boarding_points[0].stop_id, to_stop_id: t.dropping_points.at(-1).stop_id, passengers: pax(seats) }],
    contact: { name: 'Tapper', phone: '0961565656' }, payment_method: 'mtn' };
  const headers = { 'Idempotency-Key': 'test-key-booking-0001' };
  const [a, b] = await Promise.all([api('POST', '/api/bookings', { body, headers }), api('POST', '/api/bookings', { body, headers })]);
  const codes = [a.status, b.status].sort();
  assert.ok(codes[0] === 201 && (codes[1] === 201 || codes[1] === 409), `got ${codes}`);
  const replay = await api('POST', '/api/bookings', { body, headers });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(replay.body.group_ref, (a.status === 201 ? a : b).body.group_ref, 'same booking returned');
  assert.equal(db.prepare("SELECT COUNT(DISTINCT group_ref) n FROM bookings WHERE contact_phone = '260961565656'").get().n, 1);
  const other = await api('POST', '/api/bookings', { body: { ...body, contact: { name: 'Other', phone: '0961565657' } }, headers });
  assert.equal(other.status, 422, 'a key cannot be reused for a different request');
  // Paying twice with the same key starts one payment
  const g = replay.body.group_ref, ph = { 'Idempotency-Key': 'test-key-pay-0001' };
  const p1 = await api('POST', `/api/groups/${g}/pay`, { body: { method: 'mtn', msisdn: '0961565656' }, headers: ph });
  const p2 = await api('POST', `/api/groups/${g}/pay`, { body: { method: 'mtn', msisdn: '0961565656' }, headers: ph });
  assert.equal(p1.body.payment_id, p2.body.payment_id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE group_ref = ?').get(g).n, 1);
});

/* ---------------- Security step 9: tamper-evident audit log ---------------- */
test('audit log: hash-chained, edits and deletes refused, tampering detected', async () => {
  const v = (await api('GET', '/api/admin/audit/verify', { token: tokens.admin })).body;
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.ok(v.checked > 10);
  assert.throws(() => db.prepare("UPDATE audit_log SET detail = 'nothing to see' WHERE id = 1").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log WHERE id = 1').run(), /append-only/);
  // Someone with raw database access drops the guard and quietly edits an old entry: verification catches it.
  const target = db.prepare("SELECT id FROM audit_log WHERE action = 'void_sale' LIMIT 1").get()?.id || 2;
  db.exec('DROP TRIGGER audit_no_update');
  db.prepare("UPDATE audit_log SET detail = 'K0 · nothing happened' WHERE id = ?").run(target);
  const broken = (await api('GET', '/api/admin/audit/verify', { token: tokens.admin })).body;
  assert.equal(broken.ok, false);
  assert.equal(broken.broken_at, target);
  assert.match(broken.reason, /changed/);
});
