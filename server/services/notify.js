import { config } from '../config.js';

/**
 * Notification outbox. Everything is written to the `notifications` table first, then a dispatcher
 * sends it. Channels without credentials are logged to the console (status 'sent' with provider 'log'
 * in last_error) so development works end to end.
 *
 *  SMS       – Africa's Talking (AT_USERNAME, AT_API_KEY, AT_SENDER_ID)
 *  WhatsApp  – Meta WhatsApp Cloud API (WA_TOKEN, WA_PHONE_NUMBER_ID). Business-initiated messages
 *              outside a 24h customer window need an approved template; plain text is used here.
 *  Email     – POST {to, subject, text} to EMAIL_WEBHOOK_URL (your mail service / relay).
 */
export function queue(db, { channel, to, subject = null, body, kind }) {
  if (!to) return;
  db.prepare('INSERT INTO notifications (channel, recipient, subject, body, kind) VALUES (?,?,?,?,?)').run(channel, String(to), subject, body, kind);
}

/** SMS + WhatsApp (+ email when given) for one message. */
export function notifyContact(db, { phone, email, subject, body, kind }) {
  queue(db, { channel: 'sms', to: phone, body, kind });
  queue(db, { channel: 'whatsapp', to: phone, body, kind });
  if (email) queue(db, { channel: 'email', to: email, subject, body, kind });
}

const providers = {
  async sms(n) {
    const c = config.notify.africastalking;
    if (!c) return 'log';
    const res = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: { apiKey: c.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: c.username, to: '+' + n.recipient, message: n.body, ...(c.from ? { from: c.from } : {}) }),
    });
    if (!res.ok) throw new Error(`Africa's Talking HTTP ${res.status}`);
    return 'africastalking';
  },
  async whatsapp(n) {
    const c = config.notify.whatsapp;
    if (!c) return 'log';
    const res = await fetch(`https://graph.facebook.com/v20.0/${c.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: n.recipient, type: 'text', text: { body: n.body } }),
    });
    if (!res.ok) throw new Error(`WhatsApp HTTP ${res.status}`);
    return 'whatsapp';
  },
  async email(n) {
    if (!config.notify.emailWebhook) return 'log';
    const res = await fetch(config.notify.emailWebhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: n.recipient, subject: n.subject || 'MyTicket', text: n.body }),
    });
    if (!res.ok) throw new Error(`Email webhook HTTP ${res.status}`);
    return 'email';
  },
};

export async function dispatch(db, { quiet = false } = {}) {
  const batch = db.prepare("SELECT * FROM notifications WHERE status = 'queued' AND attempts < 5 ORDER BY id LIMIT 50").all();
  for (const n of batch) {
    try {
      const via = await providers[n.channel](n);
      if (via === 'log' && !quiet) console.log(`[${n.channel} → ${n.recipient}] ${n.body}`);
      db.prepare("UPDATE notifications SET status='sent', sent_at=datetime('now'), attempts=attempts+1, last_error=? WHERE id=?").run(via === 'log' ? 'not sent: provider not configured (logged)' : null, n.id);
    } catch (e) {
      db.prepare("UPDATE notifications SET attempts=attempts+1, last_error=?, status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'queued' END WHERE id=?").run(String(e.message), n.id);
    }
  }
}
