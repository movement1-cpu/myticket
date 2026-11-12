import { openDb } from './db.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { sweep } from './services/bookings.js';
import { dispatch } from './services/notify.js';
import { seedDemo } from './seed.js';
import { sendReminders } from './services/maintenance.js';

const db = openDb();
const empty = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
if (empty && !config.isProd) {
  seedDemo(db);
  console.log('Empty database: loaded demo data (see README for demo logins).');
}
if (empty && config.isProd) console.log('Empty database. Create the first admin with: node server/create-admin.js');

const app = createApp(db);
app.listen(config.port, () => console.log(`MyTicket running on ${config.baseUrl}`));

// Background jobs: release expired seat holds and unpaid bookings, send queued SMS/WhatsApp/email.
setInterval(() => { try { sweep(db); } catch (e) { console.error('sweep', e); } }, 20_000);
setInterval(() => dispatch(db).catch(e => console.error('dispatch', e)), 5_000);
// Daily maintenance / document-expiry SMS to each bus company owner (checked hourly, sent once a day).
setInterval(() => { try { sendReminders(db); } catch (e) { console.error('reminders', e); } }, 3_600_000);
setTimeout(() => { try { sendReminders(db); } catch (e) { console.error('reminders', e); } }, 30_000);
