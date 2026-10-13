'use strict';

const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');

const { analyzeProfile } = require('./scoring');
const { createGitHubClient } = require('./github');
const { createStore } = require('./db');
const { renderBadge, renderCard } = require('./svg');
const { loadAiConfig, createSummarizer } = require('./ai');

const SUMMARY_TTL_MS = 24 * 60 * 60 * 1000;

const HOUR = 60 * 60 * 1000;
const MIN_FOR_PERCENTILE = 5;

// GitHub login rules: letters, digits, single hyphens, no leading/trailing hyphen, max 39.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validLogin(value) {
  if (typeof value !== 'string' || !LOGIN_RE.test(value)) {
    throw new HttpError(400, 'Enter a valid GitHub username (letters, digits, hyphens).', 'invalid_username');
  }
  return value;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function createApp({
  store,
  github,
  summarizer = null,
  cacheTtlMs = 6 * HOUR,
  minForPercentile = MIN_FOR_PERCENTILE,
  rateLimitMax = 60,
  publicDir = path.join(__dirname, '..', 'public'),
}) {
  const app = express();
  app.disable('x-powered-by');

  app.use(express.static(publicDir));
  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: rateLimitMax,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many requests. Slow down and try again shortly.', code: 'rate_limited_local' },
    }),
  );

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  function computePercentile(total) {
    const count = store.countAnalyses();
    if (count < minForPercentile) return null;
    return Math.round((store.countBelow(total) / count) * 100);
  }

  /** Fetch (or reuse cached) GitHub data, score it, persist the result. */
  async function getAnalysis(login, { refresh = false } = {}) {
    const key = login.toLowerCase();
    let bundle;
    let fresh = false;

    const cached = store.getCache(key);
    if (!refresh && cached && Date.now() - cached.fetchedAt < cacheTtlMs) {
      bundle = cached.data;
    } else {
      bundle = await github.fetchUserBundle(login);
      store.putCache(key, bundle);
      fresh = true;
    }

    const analysis = analyzeProfile(bundle);
    if (fresh) {
      store.saveAnalysis(key, analysis);
      store.addHistory(key, analysis.total);
    }

    return {
      ...analysis,
      percentile: computePercentile(analysis.total),
      analyzedCount: store.countAnalyses(),
      cached: !fresh,
    };
  }

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get(
    '/api/analyze/:username',
    wrap(async (req, res) => {
      const login = validLogin(req.params.username);
      const refresh = req.query.refresh === '1';
      res.json(await getAnalysis(login, { refresh }));
    }),
  );

  app.get(
    '/api/compare',
    wrap(async (req, res) => {
      const a = validLogin(req.query.a);
      const b = validLogin(req.query.b);
      const [ra, rb] = await Promise.all([getAnalysis(a), getAnalysis(b)]);
      let winner = null;
      if (ra.total > rb.total) winner = ra.login;
      else if (rb.total > ra.total) winner = rb.login;
      res.json({ a: ra, b: rb, winner });
    }),
  );

  app.get('/api/leaderboard', (req, res) => {
    const language =
      typeof req.query.language === 'string' && req.query.language.trim()
        ? req.query.language.trim().slice(0, 40)
        : null;
    const limit = clampInt(req.query.limit, 1, 100, 20);
    res.json({
      language,
      entries: store.leaderboard({ language, limit }),
      analyzedCount: store.countAnalyses(),
    });
  });

  const handleClearLeaderboard = wrap(async (req, res) => {
    store.clearLeaderboard();
    res.json({ ok: true, message: 'Leaderboard cleared.' });
  });
  app.post('/api/leaderboard/clear', handleClearLeaderboard);
  app.delete('/api/leaderboard', handleClearLeaderboard);

  app.get(
    '/api/history/:username',
    wrap(async (req, res) => {
      const login = validLogin(req.params.username);
      res.json({ login, points: store.getHistory(login.toLowerCase()) });
    }),
  );

  // Regex route so "/api/card/<name>.svg" and "/api/badge/<name>.svg" both work.
  app.get(
    /^\/api\/(card|badge)\/([^/]+)\.svg$/,
    wrap(async (req, res) => {
      const kind = req.params[0];
      const login = validLogin(req.params[1]);
      const a = await getAnalysis(login);
      res.type('image/svg+xml');
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(kind === 'card' ? renderCard(a) : renderBadge(a.total));
    }),
  );

  app.get('/api/config', (req, res) => {
    res.json({ aiEnabled: Boolean(summarizer), aiProvider: summarizer ? summarizer.provider : null, aiModel: summarizer ? summarizer.model : null });
  });

  app.get(
    '/api/summary/:username',
    wrap(async (req, res) => {
      if (!summarizer) {
        throw new HttpError(503, 'AI summaries are not configured on this server.', 'ai_not_configured');
      }
      const login = validLogin(req.params.username);
      const key = login.toLowerCase();
      const refresh = req.query.refresh === '1';
      const cached = store.getSummary(key);
      if (!refresh && cached && Date.now() - cached.createdAt < SUMMARY_TTL_MS) {
        return res.json({ login, ...cached, cached: true });
      }
      const analysis = await getAnalysis(login);
      const text = await summarizer.summarize(analysis);
      store.putSummary(key, { text, provider: summarizer.provider, model: summarizer.model });
      res.json({ login, text, provider: summarizer.provider, model: summarizer.model, createdAt: Date.now(), cached: false });
    }),
  );

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Unknown API route.', code: 'not_found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.status && err.status < 500) {
      return res.status(err.status).json({ error: err.message, code: err.code || 'bad_request' });
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code || 'upstream_error' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal server error.', code: 'internal' });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ranker.db');
  const store = createStore(dbPath);
  const github = createGitHubClient({ token: process.env.GITHUB_TOKEN || null });
  const cacheTtlMs = (Number(process.env.CACHE_TTL_HOURS) || 6) * HOUR;

  const aiConfig = loadAiConfig();
  const summarizer = aiConfig ? createSummarizer(aiConfig) : null;

  createApp({ store, github, cacheTtlMs, summarizer }).listen(port, () => {
    console.log(`GitHub Ranker running at http://localhost:${port}`);
    console.log(`Database: ${dbPath}`);
    console.log(process.env.GITHUB_TOKEN ? 'Using GITHUB_TOKEN.' : 'No GITHUB_TOKEN set (60 GitHub requests/hour).');
    console.log(summarizer ? `AI summaries: ${summarizer.provider} (${summarizer.model})` : 'AI summaries: off (no AI key set).');
  });
}

module.exports = { createApp, HttpError, validLogin };
