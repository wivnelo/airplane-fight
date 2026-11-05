const express = require('express');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { LeaderboardStore, RequestError, RULESET } = require('./store');

function identity(req) {
  // Do not trust caller-supplied forwarding headers. No proxy trust is enabled.
  const raw = `${req.socket.remoteAddress || 'unknown'}|${req.get('user-agent') || ''}|${req.get('accept-language') || ''}`;
  const digest = createHash('sha256').update(raw).digest('hex');
  return { fingerprint: digest.slice(0, 32), displayName: `飞行员-${digest.slice(0, 8).toUpperCase()}` };
}

function createApp({ dataDir = process.env.DATA_DIR || path.join(__dirname, 'data'),
  allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
  rateLimit = 120, rateWindowMs = 60000 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  let store;
  try { store = new LeaderboardStore(dataDir); }
  catch (error) { console.error('[storage] unavailable:', error.code || error.name); }
  app.locals.close = () => store?.close();

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin) {
      if (origin !== `${req.protocol}://${req.get('host')}` && !allowedOrigins.includes(origin))
        return res.status(403).json({ error: 'origin not allowed' });
      res.set('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  const buckets = new Map();
  app.use('/api', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const now = Date.now();
    // Bound both per-IP traffic and rate-limiter memory; forwarded headers cannot reset it.
    for (const [key, value] of buckets) if (value.until <= now) buckets.delete(key);
    const key = req.socket.remoteAddress || 'unknown';
    if (!buckets.has(key)) {
      if (buckets.size >= 10000) return res.status(429).json({ error: 'server busy; retry later' });
      buckets.set(key, { count: 0, until: now + rateWindowMs });
    }
    const bucket = buckets.get(key);
    if (++bucket.count > rateLimit) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.until - now) / 1000))));
      return res.status(429).json({ error: 'too many requests' });
    }
    next();
  });
  app.use(express.json({ limit: '8kb', inflate: false }));
  function requireStore() {
    if (!store) throw new RequestError(503, 'leaderboard storage unavailable');
    return store;
  }
  app.get('/health', (req, res, next) => {
    try { requireStore().health(); res.json({ ok: true, storage: 'ready', ruleset: RULESET }); }
    catch (error) { next(error); }
  });
  app.get('/api/leaderboard', (req, res) => res.json({ entries: requireStore().list() }));
  app.post('/api/runs', (req, res) => res.status(201).json(requireStore().createRun(identity(req))));
  app.post('/api/leaderboard', (req, res) => {
    const { score, durationMs, runId, token } = req.body || {};
    if (!Number.isSafeInteger(score) || score < 0 || !Number.isSafeInteger(durationMs) || durationMs < 0 ||
        typeof runId !== 'string' || !/^[0-9a-f-]{36}$/.test(runId) ||
        typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token))
      throw new RequestError(400, 'integer score/durationMs and run credentials required');
    const result = requireStore().submit({ score, durationMs, runId, token }, identity(req));
    res.status(result.duplicate ? 200 : 201).json(result);
  });
  app.use(express.static(path.join(__dirname, '..', 'frontend')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof RequestError ? error.status :
      error.type === 'entity.too.large' ? 413 :
      error.type === 'entity.parse.failed' ? 400 :
      error.type === 'encoding.unsupported' ? 415 : 503;
    if (status === 503) console.error('[request] storage failure:', error.code || error.name);
    res.status(status).json({ error: status === 503 ? 'leaderboard storage unavailable' :
      error instanceof RequestError ? error.message : 'invalid request body' });
  });
  return app;
}
if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT || 3000;
  const server = app.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`Game and leaderboard listening on port ${server.address().port}`);
  });
  const stop = () => server.close(() => { app.locals.close(); });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
module.exports = { createApp };
