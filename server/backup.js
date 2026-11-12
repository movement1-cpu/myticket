// Database backups: a consistent snapshot via SQLite's VACUUM INTO (safe while the app is running),
// plus a copy of uploaded documents. Usage: npm run backup
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { localDate } from './util.js';

const NAME = /^myticket-(\d{4}-\d{2}-\d{2})T[\d-]+\.db$/;

export function backupNow(db, { daily = false } = {}) {
  if (!config.backupDir) return null;
  fs.mkdirSync(config.backupDir, { recursive: true });
  const today = localDate();
  if (daily && fs.readdirSync(config.backupDir).some(f => NAME.exec(f)?.[1] === today)) return null; // already have today's
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(config.backupDir, `myticket-${today}T${stamp.slice(11)}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  if (fs.existsSync(config.uploadDir)) fs.cpSync(config.uploadDir, path.join(config.backupDir, 'uploads'), { recursive: true, force: false, errorOnExist: false });
  return file;
}

/** Delete database snapshots older than BACKUP_KEEP_DAYS. Only touches files this module created. */
export function pruneBackups(keepDays = config.backupKeepDays) {
  if (!config.backupDir || !fs.existsSync(config.backupDir)) return 0;
  const cutoff = new Date(Date.now() - keepDays * 864e5).toISOString().slice(0, 10);
  let n = 0;
  for (const f of fs.readdirSync(config.backupDir)) {
    const m = NAME.exec(f);
    if (m && m[1] < cutoff) { fs.unlinkSync(path.join(config.backupDir, f)); n++; }
  }
  return n;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { openDb } = await import('./db.js');
  const file = backupNow(openDb());
  console.log(file ? `Backup written to ${file}` : 'Backups are disabled (BACKUP_DIR is empty).');
}
