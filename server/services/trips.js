import { isoWeekday, localToUtc, localDate, addMinutes, haversineKm, localTime } from '../util.js';

/** Create trip rows for every schedule that runs on `date`. Idempotent (UNIQUE schedule_id+service_date). */
export function ensureTrips(db, date) {
  const wd = String(isoWeekday(date));
  const schedules = db.prepare(`
    SELECT s.*, b.driver_id, b.conductor_id FROM schedules s
    JOIN operators o ON o.id = s.operator_id AND o.status = 'approved'
    JOIN buses b ON b.id = s.bus_id AND b.status = 'active'
    WHERE s.active = 1 AND s.start_date <= ? AND (s.end_date IS NULL OR s.end_date >= ?)
  `).all(date, date);
  const ins = db.prepare(`INSERT OR IGNORE INTO trips (schedule_id, operator_id, route_id, bus_id, service_date, depart_at, base_fare, driver_id, conductor_id)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const s of schedules) {
    if (s.one_off ? s.start_date !== date : !s.days.includes(wd)) continue;
    ins.run(s.id, s.operator_id, s.route_id, s.bus_id, date, localToUtc(date, s.depart_time), s.base_fare, s.driver_id, s.conductor_id);
  }
}

export function routeStops(db, routeId) {
  return db.prepare(`SELECT rs.*, t.city, t.name AS terminal, t.lat, t.lng, t.kind AS terminal_kind
    FROM route_stops rs JOIN terminals t ON t.id = rs.terminal_id WHERE rs.route_id = ? ORDER BY rs.seq`).all(routeId);
}

export function tripRow(db, tripId) {
  return db.prepare(`SELECT tr.*, r.name AS route_name, r.distance_km, r.duration_min,
      o.name AS operator_name, o.status AS operator_status,
      b.plate, b.class, b.amenities, b.layout_id, b.make_model, l.capacity, l.code AS layout_code
    FROM trips tr JOIN routes r ON r.id = tr.route_id JOIN operators o ON o.id = tr.operator_id
    JOIN buses b ON b.id = tr.bus_id JOIN layouts l ON l.id = b.layout_id WHERE tr.id = ?`).get(tripId);
}

export function seatsTaken(db, tripId) {
  const booked = db.prepare('SELECT COUNT(*) n FROM booking_seats WHERE trip_id = ? AND active = 1').get(tripId).n;
  const held = db.prepare("SELECT COUNT(*) n FROM seat_holds WHERE trip_id = ? AND expires_at > ?").get(tripId, new Date().toISOString()).n;
  return { booked, held };
}

const WINDOWS = { morning: [300, 720], afternoon: [720, 1020], night: [1020, 1740] }; // minutes local; night wraps to 05:00

/**
 * Find trips between two cities on a date. Supports boarding/alighting at intermediate stops.
 * Filters: operator_id[], class[], window[], min_price, max_price, amenities[] (all must match).
 */
export function searchTrips(db, { from, to, date, filters = {} }) {
  ensureTrips(db, date);
  const trips = db.prepare(`
    SELECT tr.id FROM trips tr
    JOIN operators o ON o.id = tr.operator_id AND o.status = 'approved'
    JOIN buses b ON b.id = tr.bus_id AND b.status = 'active'
    WHERE tr.service_date = ? AND tr.status != 'cancelled'
      AND EXISTS (SELECT 1 FROM route_stops a JOIN terminals ta ON ta.id = a.terminal_id
                  JOIN route_stops z ON z.route_id = a.route_id AND z.seq > a.seq JOIN terminals tz ON tz.id = z.terminal_id
                  WHERE a.route_id = tr.route_id AND ta.city = ? AND a.boarding = 1 AND tz.city = ? AND z.dropping = 1)
  `).all(date, from, to);

  const ratings = new Map(db.prepare(`SELECT operator_id, ROUND(AVG((cleanliness+punctuality+driver)/3.0),1) avg, COUNT(*) n FROM reviews GROUP BY operator_id`).all().map(r => [r.operator_id, r]));
  const now = Date.now();
  const out = [];
  for (const { id } of trips) {
    const t = tripRow(db, id);
    const stops = routeStops(db, t.route_id);
    const boarding = stops.filter(s => s.city === from && s.boarding);
    const lastDrop = Math.max(...stops.filter(s => s.city === to && s.dropping).map(s => s.seq));
    const board = boarding.filter(s => s.seq < lastDrop);
    const firstBoard = board[0];
    const dropping = stops.filter(s => s.city === to && s.dropping && s.seq > firstBoard.seq);
    const departAt = addMinutes(t.depart_at, firstBoard.offset_min + t.delay_min);
    if (departAt.getTime() < now) continue; // already left this city
    const arriveAt = addMinutes(t.depart_at, dropping[0].offset_min + t.delay_min);
    const { booked, held } = seatsTaken(db, id);
    const fare = segmentFare(t, firstBoard, dropping[0]);
    const amenities = JSON.parse(t.amenities);
    out.push({
      trip_id: id, operator_id: t.operator_id, operator: t.operator_name, rating: ratings.get(t.operator_id) || null,
      class: t.class, plate: t.plate, layout: t.layout_code, amenities, status: t.status, delay_min: t.delay_min,
      route: t.route_name, depart_at: departAt.toISOString(), arrive_at: arriveAt.toISOString(),
      depart_local: localTime(departAt), duration_min: dropping[0].offset_min - firstBoard.offset_min,
      fare, seats_left: t.capacity - booked - held, capacity: t.capacity,
      boarding_points: board.map(stopView(t)), dropping_points: dropping.map(stopView(t)),
    });
  }

  const f = filters;
  const mins = s => { const [h, m] = s.split(':').map(Number); const v = h * 60 + m; return v < 300 ? v + 1440 : v; };
  return out.filter(r =>
    (!f.operator_id?.length || f.operator_id.map(Number).includes(r.operator_id)) &&
    (!f.class?.length || f.class.includes(r.class)) &&
    (!f.window?.length || f.window.some(w => WINDOWS[w] && mins(r.depart_local) >= WINDOWS[w][0] && mins(r.depart_local) < WINDOWS[w][1])) &&
    (f.min_price == null || r.fare >= Number(f.min_price)) &&
    (f.max_price == null || r.fare <= Number(f.max_price)) &&
    (!f.amenities?.length || f.amenities.every(a => r.amenities.includes(a)))
  );
}

const stopView = t => s => ({
  stop_id: s.id, terminal: s.terminal, city: s.city, kind: s.terminal_kind, lat: s.lat, lng: s.lng,
  time: addMinutes(t.depart_at, s.offset_min + t.delay_min).toISOString(),
  map_url: `https://www.google.com/maps?q=${s.lat},${s.lng}`,
});

/** Fare for a segment: share of the full-route fare by distance, rounded to K5, never below 20% of base. */
export function segmentFare(trip, from, to) {
  const share = (to.km - from.km) / trip.distance_km;
  return Math.max(Math.round(trip.base_fare * 0.2 / 5) * 5, Math.round(trip.base_fare * share / 5) * 5);
}

/**
 * Where the bus is. Uses the conductor phone's GPS if it reported within 5 minutes,
 * otherwise estimates from the timetable (clearly labelled as estimated).
 */
export function tripPosition(db, tripId) {
  const t = tripRow(db, tripId);
  const stops = routeStops(db, t.route_id);
  const start = new Date(t.depart_at).getTime() + t.delay_min * 60000;
  const elapsed = (Date.now() - start) / 60000;
  const fresh = t.last_pos_at && Date.now() - new Date(t.last_pos_at).getTime() < 5 * 60000;
  let pos, source, kmDone;
  if (fresh) {
    pos = { lat: t.last_lat, lng: t.last_lng }; source = 'gps';
    // project onto the nearest stop to estimate progress
    let best = stops[0];
    for (const s of stops) if (haversineKm(pos, s) < haversineKm(pos, best)) best = s;
    kmDone = best.km;
  } else {
    source = 'timetable';
    if (['scheduled', 'boarding'].includes(t.status) || elapsed <= 0) { pos = { lat: stops[0].lat, lng: stops[0].lng }; kmDone = 0; }
    else if (t.status === 'arrived' || elapsed >= stops.at(-1).offset_min) { const s = stops.at(-1); pos = { lat: s.lat, lng: s.lng }; kmDone = s.km; }
    else {
      const i = stops.findIndex(s => s.offset_min > elapsed);
      const a = stops[i - 1], b = stops[i];
      const f = (elapsed - a.offset_min) / (b.offset_min - a.offset_min);
      pos = { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
      kmDone = a.km + (b.km - a.km) * f;
    }
  }
  const avgKmh = t.distance_km / (t.duration_min / 60);
  const eta = stops.map(s => {
    const planned = addMinutes(t.depart_at, s.offset_min + t.delay_min);
    let est = planned;
    if (t.status === 'departed' || t.status === 'delayed') {
      est = s.km <= kmDone ? null : new Date(Date.now() + ((s.km - kmDone) / avgKmh) * 3600000);
    }
    return { stop_id: s.id, city: s.city, terminal: s.terminal, lat: s.lat, lng: s.lng, planned: planned.toISOString(), eta: est?.toISOString() ?? null, passed: s.km <= kmDone && t.status !== 'scheduled' && t.status !== 'boarding' };
  });
  return { trip_id: t.id, status: t.status, delay_min: t.delay_min, plate: t.plate, operator: t.operator_name, position: pos, source, updated_at: fresh ? t.last_pos_at : new Date().toISOString(), stops: eta };
}

export function todayLocal() { return localDate(); }
