// Usage: node server/create-admin.js "Full Name" 0971234567 'a-long-password'
import { openDb } from './db.js';
import { hashPassword } from './auth.js';
import { normPhone } from './util.js';

const [name, phone, password] = process.argv.slice(2);
if (!name || !phone || !password || password.length < 12) {
  console.error('Usage: node server/create-admin.js "Full Name" 0971234567 \'password-of-12+-chars\'');
  process.exit(1);
}
const db = openDb();
db.prepare("INSERT INTO users (role, name, phone, password_hash) VALUES ('admin', ?, ?, ?)").run(name, normPhone(phone), hashPassword(password));
console.log('Admin created.');
