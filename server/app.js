import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { authenticate, requireRole } from './auth.js';
import { HttpError, notFound } from './util.js';
import publicRoutes from './routes/public.js';
import operatorRoutes from './routes/operator.js';
import agentRoutes from './routes/agent.js';
import adminRoutes from './routes/admin.js';

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
  app.use(authenticate(db));

  const api = express.Router();
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
  api.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  api.use((_req, _res, next) => next(notFound('Unknown API endpoint.')));
  app.use('/api', api);

  app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules/leaflet/dist'), { maxAge: '7d' }));
  app.use('/vendor/jsqr', express.static(path.join(root, 'node_modules/jsqr/dist'), { maxAge: '7d' }));
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
