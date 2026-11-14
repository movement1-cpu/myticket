import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { authenticate, requireRole } from './auth.js';
import { idempotent } from './security.js';
import { HttpError, notFound } from './util.js';
import publicRoutes from './routes/public.js';
import accountRoutes from './routes/account.js';
import operatorRoutes from './routes/operator.js';
import agentRoutes from './routes/agent.js';
import adminRoutes from './routes/admin.js';
import { handleUssd, handleSms } from './services/ussd.js';
import { queue } from './services/notify.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(self), geolocation=(self)',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://*.tile.openstreetmap.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'",
    });
    next();
  });
  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' })); // USSD / SMS gateway callbacks
  app.use(authenticate(db));

  const api = express.Router();
  // Money-moving endpoints: a retried or double-tapped request with the same Idempotency-Key is answered once.
  const once = idempotent(db);
  for (const path of ['/bookings', '/groups/:group/pay', '/counter/bookings', '/counter/settle/:group', '/counter/void/:ref',
    '/my/bookings/:ref/reschedule', '/my/bookings/:ref/cancel', '/operator/settlements', '/trips/:id/waitlist']) api.post(path, once);
  api.use(accountRoutes(db));
  api.use(publicRoutes(db));
  api.use(operatorRoutes(db));
  api.use(agentRoutes(db));
  api.use(adminRoutes(db));

  /** Uploaded verification documents and bus photos: owner company or admin only. */
  api.get('/documents/:id', requireRole('operator', 'admin'), (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!d || (req.user.role !== 'admin' && d.operator_id !== req.operatorId)) throw notFound();
    res.set('Content-Type', d.mime).set('Content-Disposition', `inline; filename="${d.filename.replace(/"/g, '')}"`);
    res.sendFile(path.join(config.uploadDir, d.stored_name));
  });
  /**
   * USSD and inbound SMS gateways (Africa's Talking format). Gateways do not sign requests, so in production
   * set USSD_SECRET and register the callback URL with ?key=<secret>.
   */
  const gatewayKey = (req) => {
    if (config.ussdSecret && req.query.key !== config.ussdSecret) throw new HttpError(403, 'Bad gateway key.');
  };
  api.post('/ussd', async (req, res) => {
    gatewayKey(req);
    let reply;
    try { reply = await handleUssd(db, { phoneNumber: req.body.phoneNumber, text: req.body.text || '' }); }
    catch (e) { reply = `END ${e instanceof HttpError ? e.message : 'Something went wrong. Please try again.'}`; if (!(e instanceof HttpError)) console.error(e); }
    res.type('text/plain').send(reply);
  });
  api.post('/sms/inbound', async (req, res) => {
    gatewayKey(req);
    try { const reply = await handleSms(db, { from: req.body.from, text: req.body.text }); queue(db, { channel: 'sms', to: String(req.body.from).replace(/\D/g, ''), body: reply, kind: 'sms_reply' }); }
    catch (e) { if (!(e instanceof HttpError)) console.error(e); }
    res.json({ ok: true });
  });
  /** For load balancers and uptime monitors: checks the database too. */
  api.get('/health', (_req, res) => {
    const ok = db.prepare('SELECT 1 ok').get()?.ok === 1;
    res.status(ok ? 200 : 503).json({ ok, time: new Date().toISOString() });
  });
  api.use((_req, _res, next) => next(notFound('Unknown API endpoint.')));
  app.use('/api', api);

  app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules/leaflet/dist'), { maxAge: '7d' }));
  app.use('/vendor/jsqr', express.static(path.join(root, 'node_modules/jsqr/dist'), { maxAge: '7d' }));
  if (config.isProd) app.get('/ussd.html', (_req, res) => res.status(404).end()); // simulator is for development only
  app.use(express.static(path.join(root, 'web'), { extensions: ['html'] }));

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The upload is too large. Files must be 5 MB or smaller.' });
    if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'The request was not valid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
  });
  return app;
}

export const webRoot = path.join(root, 'web');
export const hasWeb = () => fs.existsSync(webRoot);
