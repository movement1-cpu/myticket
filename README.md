# MyTicket

Bus ticket booking and fleet management for intercity coaches in Zambia. One Node.js app serves four portals:

| Portal | Who | Where |
|---|---|---|
| Passenger web app | Travellers, guests | `/` |
| Operator portal | Bus company owners, station clerks | `/#/op/…` |
| Field app (installable, works offline) | Conductors, gate agents | `/agent.html` |
| Admin portal | Platform owner | `/#/admin/…` |

## Run it

Requires Node.js 22.13 or newer (uses the built-in `node:sqlite`). No build step.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000. An empty development database is filled with demo data on first start. All demo logins use the password `demo1234`:

| Role | Phone |
|---|---|
| Passenger | 0971234567 |
| Bus owner (Zambezi Coaches) | 0960000002 |
| Station clerk | 0960000003 |
| Conductor | 0970000004 |
| Platform admin | 0950000001 |
| Owner awaiting approval (Luangwa Liner) | 0960000020 |

Company names in the demo data are fictional. Reset the demo database with `npm run seed:demo`.

```bash
npm test
```

## What is in it

**Passengers**
- Search by city and date, with an optional return date (both legs are paid in one payment).
- Filter by company, bus class, departure window, price range and amenities. Sort by time, fare, rating or seats left.
- Boarding and dropping points, including roadside stops, with times and Google Maps links. Passengers can board or get off at intermediate towns; the fare is pro-rated by distance.
- Live seat map for 2+2, 2+1 VIP and two-deck sleeper layouts. Seats show as available, booked, locked by someone paying, or women-only. The map updates through server-sent events.
- Fares are worked out on the server: base fare, peak surcharge, child discount, promo code and booking fee.
- Passenger details include the NRC, passport or other ID number for the manifest.
- Payment by MTN MoMo, Airtel Money, Zamtel Kwacha or card. Pay-at-station reservations hold the seats for 30 minutes.
- E-ticket page with a signed QR code and a PDF download. The ticket link goes out by SMS, WhatsApp and email.
- My trips: upcoming and past trips, cancellation with the refund worked out from the company's policy, and self-service date changes. Rescheduling turns the old fare into credit; the passenger pays the change fee plus any difference, or gets the leftover refunded.
- Live tracking on a map, with an ETA for each stop. It uses the conductor's GPS when available and otherwise estimates from the timetable, and says which.
- Ratings for cleanliness, punctuality and the driver after a completed trip. Passengers can report a problem, and guests can look up a booking by reference and phone number.

**Bus operators**
- Company sign-up with PACRA, RTSA and ZRA tax clearance uploads (PDF/JPG/PNG, file type checked by content, 5 MB limit). Nothing is bookable until the admin approves the company.
- Fleet management: plate, chassis and engine numbers, class, seat layout template, amenities, photos, status, and a default driver and conductor.
- Drivers, conductors and clerks. Conductors and clerks get their own logins.
- Route builder (ordered stops with minutes and km from the start) and new stop locations with coordinates.
- Timetable: recurring departures by weekday with start and end dates, plus one-off holiday trips. Fare changes only affect departures nobody has booked yet.
- Pricing rules: peak and holiday surcharges, child discount, promo codes with usage limits.
- Trips by day, with crew assignment, status changes and a passenger manifest you can print or download as CSV.
- **Station terminal**: clerks sell walk-in tickets on the same live seat inventory as online sales, for cash or a pay-later reservation. A seat sold at the counter shows as booked straight away on the website and on the conductor's phone (the field app refreshes every 15 seconds).
- **Thermal ticket printing** on 58 mm or 80 mm receipt printers: route, departure, boarding point, bus, each passenger's seat, ID and luggage, totals, QR code and reference. Options (saved per computer): print automatically after each sale, one slip per passenger, and **a luggage tag for every item** ("BAG 1 OF 3"). Reprint any ticket by reference. Set the printer as the computer's default; start Chrome with `--kiosk-printing` to skip the print dialog.
- **Luggage per passenger**: Yes/No, then how many bags, sacks, containers, boxes, crates and other items (with a description for "other"). Recorded at the counter and online. It appears on the ticket, the manifest (with totals for the luggage hold), the CSV and the field app.
- Parcel register with status updates and SMS to the receiver.
- Revenue dashboard, occupancy by route, reviews, a balance (earned, pending, available) and payout requests to the company's bank account.

**Conductors and agents** (`/agent.html`, installable)
- Scan QR codes with the camera (BarcodeDetector, falling back to jsQR) or type a booking reference. Each ticket boards once; repeat scans show "Already boarded".
- Offline mode: the trip manifest, including each booking's QR payload, is saved on the phone. Scans are checked locally and queued, then synced on reconnect. Sync is idempotent, keyed on a device-generated ID.
- Bus view: the seat layout with each seat empty, being paid for, sold, an unpaid reservation, or boarded, plus a luggage count per seat and the total for the hold. Tap a seat for the passenger's details. New sales from the station or online appear within 15 seconds.
- Trip status (Boarding, Departed, Delayed, Arrived) sends an SMS and WhatsApp message to every booked passenger.
- Shares the phone's GPS position every minute for live tracking.

**Platform admin**
- Approve, suspend or reject companies; verify or reject each document. Approval is blocked while a required document is missing, unless overridden.
- Booking fee and commission rate, globally and per company. Also the seat-lock and reservation durations.
- Complaints and disputes with refunds, failed payments, a refund payout queue and operator payout approvals.
- Analytics: GMV, platform revenue, bookings, passenger growth, top routes, per-company figures, monthly seasonality, sales channels and payment success rates.
- Platform-wide promo codes, bulk SMS and WhatsApp (to all passengers, passengers travelling through a town, one trip, or all companies), the notification outbox and an audit log.

**Basic phones (USSD and SMS)**
- Dial the USSD code (set `USSD_CODE`, e.g. `*384*123#`) on any phone to book. The menu goes: town → destination → today, tomorrow or the day after → bus → number of seats (up to 4) → name and NRC for each passenger → confirm. Seats are assigned automatically, and payment is a mobile money prompt on the same number (MTN, Airtel or Zamtel, detected from the number). Towns are listed busiest first, with paging.
- The same menu has: my upcoming tickets, bus status by booking reference (only for the number that booked), and language.
- SMS commands to your inbound number: `STATUS MT4K9P2Q`, `TICKETS`, `HELP`.
- Gateway callbacks follow the Africa's Talking format: `POST /api/ussd` and `POST /api/sms/inbound`. In production set `USSD_SECRET` and register the URLs with `?key=<secret>`.
- Development simulator at `/ussd.html` (disabled in production).

**Loyalty points**
- Passengers earn 1 point per K10 of fare once a trip is completed, and spend them at checkout (100 points = K10, up to 50% of a fare). The admin sets all three numbers.
- The platform pays for points, so bus companies still receive their full fare. Points come back if the booking is cancelled or expires unpaid. The balance and history are in My trips.

**Luggage charges**
- Each company sets a price per bag, sack, container, box, crate and other item, and how many bags ride free (default 1). The charge is added to the ticket total and printed on the ticket. It goes to the company in full, with no commission, and is fully refunded if the booking is cancelled.

**Maintenance and compliance**
- The odometer goes up by the route distance after each trip. You can record a service, repair, tyres or an RTSA inspection with cost and notes; a service resets the counter.
- Expiry dates for the RTSA certificate of fitness, insurance, road tax and driver licences.
- The Maintenance page lists what is overdue, due within 14 days or 1,000 km, or not recorded. The dashboard shows an alert, and each affected trip gets a red warning. The company owner gets one SMS summary a day.

**Languages**
- The passenger website, SMS messages and the USSD menu are available in English, Ichibemba, Chinyanja and Chitonga. The choice is remembered on the account, on the booking (so trip alerts arrive in the same language) and per phone number for USSD.
- **The Bemba, Nyanja and Tonga texts are draft translations. Have native speakers review `web/js/i18n.js` and `server/i18n.js` before launch.** Staff and admin screens are English only.

## How the important parts work

**No double booking.** Two layers:
1. `seat_holds` has a primary key on `(trip_id, seat_no)`. Holds are taken inside `BEGIN IMMEDIATE`, so concurrent requests are serialised and only one can hold a seat. The hold lasts 10 minutes and the admin can set it between 5 and 15.
2. `booking_seats` has a partial unique index on `(trip_id, seat_no) WHERE active = 1`. Even a bug elsewhere cannot sell the same seat twice.

Unpaid bookings expire, and their seats are released by a sweep that runs every 20 seconds. A booking is not expired while a mobile money prompt is still waiting for approval. If a payment succeeds after the hold has expired, a refund and a dispute record are created automatically. The test suite fires 10 concurrent holds at one seat and checks that exactly one succeeds.

**Roles (RBAC).** Every API route declares which roles may call it (`server/auth.js`). Company staff are scoped to their own company in every query. Clerks cannot see finances, conductors cannot edit the fleet or cancel trips, and companies that are pending or suspended are locked out of operations. The tests cover cross-company access and role denials.

**Tickets.** The QR payload is `MT1|<ref>|<HMAC>`, signed with `APP_SECRET`. A forged code fails the check. Each seat's `boarded_at` stops a ticket being used twice.

**Money.** Passengers pay fare − discount + booking fee. The platform keeps the booking fee and commission % × (fare − discount). Operators can withdraw what they earned on completed trips, plus what they keep from cancellations under their refund policy, minus payouts already requested.

## Going to production

These parts run in **sandbox** until you configure them. The app says so in the UI and API responses (`sandbox: true`).

| Area | Status | To go live |
|---|---|---|
| MTN MoMo | Collection API adapter implemented (`requesttopay`, status polling, callback re-verification) | Set `MTN_MOMO_*` variables from your MoMo developer and partner onboarding |
| Airtel Money | Collections adapter implemented (USSD push, status check) | Set `AIRTEL_*`. Check the endpoint paths against the API version in your Airtel contract |
| Zamtel Kwacha, Visa/Mastercard | Sandbox only. The card flow is a stand-in for a hosted checkout page, so card data never reaches this server | Add an adapter for your aggregator in `server/services/payments/providers.js` with the same `initiate`/`check` interface |
| SMS | Africa's Talking adapter | Set `AT_USERNAME`, `AT_API_KEY` and an approved `AT_SENDER_ID` |
| WhatsApp | WhatsApp Cloud API adapter (text messages) | Set `WA_TOKEN`, `WA_PHONE_NUMBER_ID`. Messages outside the 24-hour customer window need approved templates |
| Email | Posts to a webhook | Set `EMAIL_WEBHOOK_URL` to your mail relay |
| USSD & inbound SMS | Menu and SMS commands implemented (Africa's Talking request format) | Rent a USSD code and inbound number from Africa's Talking or your aggregator. Point them at `/api/ussd?key=…` and `/api/sms/inbound?key=…` and set `USSD_SECRET` and `USSD_CODE` |
| Translations | Drafts | Native-speaker review of Bemba, Nyanja and Tonga |
| Refund and operator payouts | Tracked and approved in the admin portal, then **paid out manually** | Wire up the providers' disbursement APIs if you want them automatic |
| Maps | OpenStreetMap tiles via Leaflet | Fine to start with. For heavy traffic use a paid tile provider (OSM's tile servers have a usage policy) |

Checklist:
- Set `NODE_ENV=production`, a long random `APP_SECRET`, `BASE_URL` (used in SMS ticket links) and `PORT`. The app refuses to start in production without `APP_SECRET`.
- Create the first admin: `node server/create-admin.js "Full Name" 0971234567 'a-password-of-12+-chars'`.
- Run behind HTTPS (nginx or Caddy). The camera and GPS in the field app only work over HTTPS.
- Back up `data/` (the SQLite database and uploads). SQLite in WAL mode handles a single server comfortably. To run several app servers, move to PostgreSQL and replace the in-process seat-change pub/sub (`server/services/events.js`) with Redis.
- Login is rate-limited in memory. Put a proxy-level rate limit in front for production.

Environment variables are listed in `.env.example`.

## Layout

```
server/
  index.js              start-up, background jobs (expiry sweep, notification dispatch)
  app.js                Express app, security headers, static files
  db.js                 schema (SQLite) and defaults
  auth.js               passwords (scrypt), signed tokens, role checks
  routes/public.js      search, seats, booking, payments, tickets, passenger self-service
  routes/operator.js    company portal and counter sales
  routes/agent.js       field app: manifest, scan, offline sync, trip status, GPS
  routes/admin.js       governance, fees, disputes, payouts, analytics, broadcasts
  services/             trips, seats, pricing, bookings, payments, notifications, tickets
  seed.js               demo data
web/                    no-build frontend (ES modules)
test/api.test.js        end-to-end API tests
```
