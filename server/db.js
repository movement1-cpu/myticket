import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS operators (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended','rejected')),
  rtsa_verified INTEGER NOT NULL DEFAULT 0,
  pacra_no TEXT, tpin TEXT,
  contact_phone TEXT, contact_email TEXT,
  bank_name TEXT, bank_account TEXT, bank_branch TEXT,
  commission_pct REAL,          -- NULL = platform default
  booking_fee REAL,             -- NULL = platform default (flat, charged to passenger)
  refund_policy TEXT,           -- JSON [{hours,pct}] sorted desc; NULL = platform default
  reschedule_fee REAL NOT NULL DEFAULT 20,
  status_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('passenger','clerk','conductor','operator','admin')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  operator_id INTEGER REFERENCES operators(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('operator','bus')),
  owner_id INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- pacra | rtsa_licence | tax_clearance | bus_photo | other
  filename TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','rejected')),
  expires_on TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS terminals (
  id INTEGER PRIMARY KEY,
  city TEXT NOT NULL, name TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'terminal' CHECK (kind IN ('terminal','roadside')),
  UNIQUE (city, name)
);

CREATE TABLE IF NOT EXISTS layouts (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  spec TEXT NOT NULL,           -- JSON {decks:[{name, rows:[[{no,female?}|null]]}]}
  capacity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL, phone TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('driver','conductor','clerk')),
  licence_no TEXT, active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS buses (
  id INTEGER PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  plate TEXT NOT NULL UNIQUE,
  chassis_no TEXT, engine_no TEXT, make_model TEXT,
  class TEXT NOT NULL CHECK (class IN ('Luxury','Semi-Luxury','VIP Sleeper','Express','Standard')),
  layout_id INTEGER NOT NULL REFERENCES layouts(id),
  amenities TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','retired')),
  driver_id INTEGER REFERENCES staff(id),
  conductor_id INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  name TEXT NOT NULL,
  distance_km REAL NOT NULL, duration_min INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS route_stops (
  id INTEGER PRIMARY KEY,
  route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  terminal_id INTEGER NOT NULL REFERENCES terminals(id),
  offset_min INTEGER NOT NULL,      -- minutes after departure from first stop
  km REAL NOT NULL,                 -- distance from first stop
  boarding INTEGER NOT NULL DEFAULT 1, dropping INTEGER NOT NULL DEFAULT 1,
  UNIQUE (route_id, seq)
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  route_id INTEGER NOT NULL REFERENCES routes(id),
  bus_id INTEGER NOT NULL REFERENCES buses(id),
  depart_time TEXT NOT NULL,        -- HH:MM local (Africa/Lusaka)
  days TEXT NOT NULL DEFAULT '1234567', -- ISO weekdays 1=Mon..7=Sun
  start_date TEXT NOT NULL, end_date TEXT,
  one_off INTEGER NOT NULL DEFAULT 0,   -- 1 = runs only on start_date (holiday trip)
  base_fare REAL NOT NULL,              -- full-route fare, ZMW
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id),
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  route_id INTEGER NOT NULL REFERENCES routes(id),
  bus_id INTEGER NOT NULL REFERENCES buses(id),
  service_date TEXT NOT NULL,
  depart_at TEXT NOT NULL,          -- UTC ISO
  base_fare REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','boarding','departed','delayed','arrived','cancelled')),
  delay_min INTEGER NOT NULL DEFAULT 0,
  driver_id INTEGER REFERENCES staff(id), conductor_id INTEGER REFERENCES staff(id),
  last_lat REAL, last_lng REAL, last_pos_at TEXT,
  UNIQUE (schedule_id, service_date)
);

CREATE TABLE IF NOT EXISTS pricing_rules (
  id INTEGER PRIMARY KEY,
  operator_id INTEGER REFERENCES operators(id),  -- NULL = platform-wide (promo codes only)
  kind TEXT NOT NULL CHECK (kind IN ('peak','child','promo')),
  name TEXT NOT NULL,
  pct REAL NOT NULL,               -- peak: +pct surcharge; child/promo: -pct discount
  code TEXT,                       -- promo only, uppercase
  start_date TEXT, end_date TEXT,
  max_uses INTEGER, used INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_promo_code ON pricing_rules(code) WHERE code IS NOT NULL;

-- Short-lived seat locks taken while a passenger checks out. PK makes a seat holdable by one token only.
CREATE TABLE IF NOT EXISTS seat_holds (
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  seat_no TEXT NOT NULL,
  hold_token TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (trip_id, seat_no)
);
CREATE INDEX IF NOT EXISTS ix_holds_token ON seat_holds(hold_token);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  group_ref TEXT NOT NULL,          -- outbound + return legs share one group (one payment)
  user_id INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  channel TEXT NOT NULL CHECK (channel IN ('web','counter','agent')),
  status TEXT NOT NULL CHECK (status IN ('pending_payment','reserved','confirmed','cancelled','expired','completed')),
  from_stop_id INTEGER NOT NULL REFERENCES route_stops(id),
  to_stop_id INTEGER NOT NULL REFERENCES route_stops(id),
  contact_name TEXT NOT NULL, contact_phone TEXT NOT NULL, contact_email TEXT,
  fare_total REAL NOT NULL,         -- sum of seat fares after peak/child/promo
  discount REAL NOT NULL DEFAULT 0, -- promo + reschedule credit
  booking_fee REAL NOT NULL,
  total REAL NOT NULL,              -- what the passenger pays
  commission REAL NOT NULL,         -- platform's cut of fare_total
  promo_code TEXT,
  payment_method TEXT,
  expires_at TEXT,
  rescheduled_from INTEGER REFERENCES bookings(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT, cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_bookings_group ON bookings(group_ref);
CREATE INDEX IF NOT EXISTS ix_bookings_trip ON bookings(trip_id);

CREATE TABLE IF NOT EXISTS booking_seats (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  seat_no TEXT NOT NULL,
  passenger_name TEXT NOT NULL,
  id_type TEXT NOT NULL CHECK (id_type IN ('NRC','Passport','Other')),
  id_number TEXT NOT NULL,
  gender TEXT CHECK (gender IN ('F','M','X')),
  is_child INTEGER NOT NULL DEFAULT 0,
  fare REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  boarded_at TEXT, boarded_by INTEGER REFERENCES users(id),
  lug_bags INTEGER NOT NULL DEFAULT 0, lug_sacks INTEGER NOT NULL DEFAULT 0, lug_containers INTEGER NOT NULL DEFAULT 0,
  lug_boxes INTEGER NOT NULL DEFAULT 0, lug_crates INTEGER NOT NULL DEFAULT 0, lug_other INTEGER NOT NULL DEFAULT 0, lug_note TEXT
);
-- The hard guarantee against double booking: one active seat per trip.
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_seat ON booking_seats(trip_id, seat_no) WHERE active = 1;

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  group_ref TEXT NOT NULL,
  provider TEXT NOT NULL,
  msisdn TEXT,
  amount REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('initiated','success','failed','refunded')),
  provider_ref TEXT, failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  amount REAL NOT NULL, reason TEXT NOT NULL,
  -- awaiting_approval: an admin decided it and it is above the threshold; a second admin must approve.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('awaiting_approval','pending','paid','failed')),
  created_by INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id), approved_at TEXT,
  paid_by INTEGER REFERENCES users(id), paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  cleanliness INTEGER NOT NULL CHECK (cleanliness BETWEEN 1 AND 5),
  punctuality INTEGER NOT NULL CHECK (punctuality BETWEEN 1 AND 5),
  driver INTEGER NOT NULL CHECK (driver BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS parcels (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  trip_id INTEGER REFERENCES trips(id),
  from_city TEXT NOT NULL, to_city TEXT NOT NULL,
  sender_name TEXT NOT NULL, sender_phone TEXT NOT NULL,
  receiver_name TEXT NOT NULL, receiver_phone TEXT NOT NULL,
  description TEXT NOT NULL, weight_kg REAL NOT NULL, fee REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','loaded','in_transit','arrived','collected','cancelled')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,   -- generated on the device; makes offline sync idempotent
  booking_seat_id INTEGER REFERENCES booking_seats(id),
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  agent_id INTEGER NOT NULL REFERENCES users(id),
  scanned_at TEXT NOT NULL, synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  result TEXT NOT NULL              -- boarded | duplicate | invalid
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('sms','whatsapp','email')),
  recipient TEXT NOT NULL, subject TEXT, body TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT
);

CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  amount REAL NOT NULL,
  -- requested → approved (admin A) → paid (admin B, never A) | rejected
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','paid','rejected')),
  bank_snapshot TEXT, note TEXT,
  requested_by INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id), approved_at TEXT,
  paid_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), processed_at TEXT
);

-- Bank account changes take effect after a 48-hour wait, with an SMS to the owner, so a hijacked
-- account cannot redirect payouts at once.
CREATE TABLE IF NOT EXISTS bank_changes (
  id INTEGER PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  bank_name TEXT NOT NULL, bank_account TEXT NOT NULL, bank_branch TEXT,
  requested_by INTEGER REFERENCES users(id),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')), effective_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','cancelled')),
  cancelled_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id),
  user_id INTEGER REFERENCES users(id),
  category TEXT NOT NULL CHECK (category IN ('payment_failed','trip_cancelled','refund','service','other')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
  resolution TEXT, refund_amount REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  booking_id INTEGER REFERENCES bookings(id),
  points INTEGER NOT NULL,          -- + earned / restored, − redeemed / reversed
  kind TEXT NOT NULL CHECK (kind IN ('earn','redeem','restore','adjust')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_loyalty_earn ON loyalty_ledger(booking_id) WHERE kind = 'earn';

CREATE TABLE IF NOT EXISTS maintenance_log (
  id INTEGER PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  bus_id INTEGER NOT NULL REFERENCES buses(id),
  done_on TEXT NOT NULL, odometer_km REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('service','repair','tyres','inspection','other')),
  cost REAL, notes TEXT, created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- People waiting for seats on a full bus. When seats free up, the first in line gets them held (status 'offered').
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  from_stop_id INTEGER NOT NULL REFERENCES route_stops(id),
  to_stop_id INTEGER NOT NULL REFERENCES route_stops(id),
  seats INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 6),
  contact_name TEXT NOT NULL, phone TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'en',
  user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','booked','expired','cancelled')),
  hold_token TEXT, offer_expires TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_waitlist_trip ON waitlist(trip_id, status);

-- Security: persistent rate limits, one-time SMS codes.
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_otp_phone ON otp_codes(phone, purpose);

-- Sessions: only a hash of the token is stored. Revocable one by one or all at once.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                -- sha256(token)
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  idle_minutes INTEGER NOT NULL,
  ip TEXT, user_agent TEXT, device_id TEXT,
  mfa_pending INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS known_devices (
  user_id INTEGER NOT NULL REFERENCES users(id), device_id TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')), user_agent TEXT,
  PRIMARY KEY (user_id, device_id)
);
CREATE TABLE IF NOT EXISTS recovery_codes (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), code_hash TEXT NOT NULL, used_at TEXT
);

-- Language preference for phone numbers without an account (USSD / SMS users).
CREATE TABLE IF NOT EXISTS phone_prefs (phone TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT 'en');

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const DEFAULT_SETTINGS = {
  booking_fee: '5',             // ZMW per booking, charged to passenger
  commission_pct: '8',          // % of fare kept by platform
  hold_minutes: '10',           // seat lock during checkout
  reserve_minutes: '30',        // pay-at-station hold
  mfa_operator_required: '0',
  refund_approval_threshold: '500', // refunds an admin decides above this (K) need a second admin's approval
  bank_change_hours: '48',          // wait before a new bank account is used for payouts      // 1 = bus company owners must use two-step sign-in too (admins always must)
  reminder_hours: '3',              // SMS reminder this many hours before departure (0 = off)
  waitlist_offer_minutes: '30',     // how long freed seats are held for the next person on the waitlist
  loyalty_points_per_kwacha: '0.1', // 1 point per K10 of fare on completed trips
  loyalty_point_value: '0.1',       // 1 point = K0.10 when redeemed (so 100 points = K10)
  loyalty_max_pct: '50',            // points can pay at most this % of a fare
  refund_policy: JSON.stringify([{ hours: 48, pct: 90 }, { hours: 24, pct: 75 }, { hours: 6, pct: 50 }, { hours: 0, pct: 0 }]),
};

export function openDb(file = config.dbFile) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

/**
 * SQLite cannot change a CHECK constraint in place. If an existing table's definition lacks `marker`,
 * rebuild it from the current SCHEMA definition and copy the rows across (columns in common).
 */
function rebuild(db, table, marker) {
  const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql || '';
  if (cur.includes(marker)) return;
  const def = SCHEMA.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0];
  const oldCols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
  try {
    db.exec(def.replace(`CREATE TABLE IF NOT EXISTS ${table} (`, `CREATE TABLE ${table}__new (`));
    const newCols = new Set(db.prepare(`PRAGMA table_info(${table}__new)`).all().map(c => c.name));
    const cols = oldCols.filter(c => newCols.has(c)).join(', ');
    db.exec(`INSERT INTO ${table}__new (${cols}) SELECT ${cols} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}__new RENAME TO ${table}; COMMIT`);
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
}

/** Additive migrations for databases created by earlier versions. */
function migrate(db) {
  rebuild(db, 'refunds', "'awaiting_approval'");
  rebuild(db, 'settlements', "'approved'");
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  const add = (table, col, def) => { if (!has(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
  for (const c of ['lug_bags', 'lug_sacks', 'lug_containers', 'lug_boxes', 'lug_crates', 'lug_other']) add('booking_seats', c, 'INTEGER NOT NULL DEFAULT 0');
  add('booking_seats', 'lug_note', 'TEXT');
  // v3: luggage charges, loyalty points, languages, maintenance
  add('operators', 'luggage_fees', 'TEXT');
  add('bookings', 'luggage_fee', 'REAL NOT NULL DEFAULT 0');
  add('bookings', 'points_used', 'INTEGER NOT NULL DEFAULT 0');
  add('bookings', 'points_discount', 'REAL NOT NULL DEFAULT 0');
  add('bookings', 'lang', "TEXT NOT NULL DEFAULT 'en'");
  add('bookings', 'source', 'TEXT'); // 'ussd' for basic-phone bookings
  add('users', 'lang', "TEXT NOT NULL DEFAULT 'en'");
  add('buses', 'odometer_km', 'REAL NOT NULL DEFAULT 0');
  add('buses', 'service_interval_km', 'INTEGER NOT NULL DEFAULT 10000');
  add('buses', 'last_service_km', 'REAL NOT NULL DEFAULT 0');
  add('buses', 'last_service_date', 'TEXT');
  add('buses', 'fitness_expiry', 'TEXT');
  add('buses', 'insurance_expiry', 'TEXT');
  add('buses', 'road_tax_expiry', 'TEXT');
  add('staff', 'licence_expiry', 'TEXT');
  add('trips', 'km_logged', 'INTEGER NOT NULL DEFAULT 0');
  // v4: departure reminders, demand-based pricing
  add('bookings', 'reminded_at', 'TEXT');
  add('operators', 'dynamic_pricing', 'TEXT');
  // v5 security
  add('users', 'phone_verified', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'password_changed_at', 'TEXT');
  add('users', 'totp_secret', 'TEXT');          // encrypted
  add('users', 'totp_pending_secret', 'TEXT');  // encrypted, during setup
  add('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'admin_scope', "TEXT NOT NULL DEFAULT 'full'");
}

/** Run fn inside a write transaction. BEGIN IMMEDIATE serialises writers, so check-then-insert is safe. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function setting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}
