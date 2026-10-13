'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadAiConfig, createSummarizer, buildPrompt } = require('../src/ai');
const { analyzeProfile } = require('../src/scoring');
const { makeBundle, fakeGitHub } = require('./fixtures');
const { createApp } = require('../src/server');
const { createStore } = require('../src/db');

const NOW = Date.now();
const sample = analyzeProfile({ ...makeBundle('alice', NOW), now: NOW });

test('no AI key means AI is off', () => {
  assert.equal(loadAiConfig({}), null);
});

test('OpenRouter is picked up from any of its key variables', () => {
  const cfg = loadAiConfig({ OPENROUTER_API_KEY_2: 'sk-test' });
  assert.equal(cfg.provider, 'openrouter');
  assert.equal(cfg.apiKey, 'sk-test');
  assert.match(cfg.baseUrl, /openrouter\.ai/);
});

test('NVIDIA is used when only its key is set', () => {
  const cfg = loadAiConfig({ NVIDIA_API_KEY: 'nvapi-test' });
  assert.equal(cfg.provider, 'nvidia');
  assert.match(cfg.baseUrl, /integrate\.api\.nvidia\.com/);
});

test('AI_PROVIDER and AI_MODEL override the defaults', () => {
  const cfg = loadAiConfig({
    OPENROUTER_API_KEY: 'a',
    NVIDIA_API_KEY: 'b',
    AI_PROVIDER: 'nvidia',
    AI_MODEL: 'custom/model',
  });
  assert.equal(cfg.provider, 'nvidia');
  assert.equal(cfg.model, 'custom/model');
});

test('the prompt contains public analysis data and never an API key', () => {
  const prompt = buildPrompt(sample);
  assert.match(prompt, /Developer Score: \d+\/100/);
  assert.match(prompt, /Login: alice/);
  assert.equal(/sk-|nvapi-/.test(prompt), false);
});

test('summarize sends the right request and returns the model text', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '  Great profile.  ' } }] }) };
  };
  const s = createSummarizer(
    { provider: 'openrouter', apiKey: 'sk-secret', baseUrl: 'https://example.test/v1', model: 'm1' },
    { fetchImpl },
  );
  const text = await s.summarize(sample);
  assert.equal(text, 'Great profile.');
  assert.equal(seen.url, 'https://example.test/v1/chat/completions');
  assert.equal(seen.opts.headers.Authorization, 'Bearer sk-secret');
  assert.equal(seen.body.model, 'm1');
  assert.equal(seen.body.messages[0].role, 'user');
});

test('a provider error becomes a 502 with a code', async () => {
  const s = createSummarizer(
    { provider: 'nvidia', apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'm' },
    { fetchImpl: async () => ({ ok: false, status: 401 }) },
  );
  await assert.rejects(() => s.summarize(sample), (e) => e.status === 502 && e.code === 'ai_upstream_error');
});

test('an empty model response is treated as an error', async () => {
  const s = createSummarizer(
    { provider: 'nvidia', apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'm' },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [] }) }) },
  );
  await assert.rejects(() => s.summarize(sample), (e) => e.code === 'ai_upstream_error');
});

test('a slow provider times out with a 504', async () => {
  const s = createSummarizer(
    { provider: 'nvidia', apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'm' },
    {
      timeoutMs: 20,
      fetchImpl: (url, opts) => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    },
  );
  await assert.rejects(() => s.summarize(sample), (e) => e.status === 504 && e.code === 'ai_timeout');
});

test('summary route: 503 when AI is not configured', async () => {
  const store = createStore(':memory:');
  const app = createApp({ store, github: fakeGitHub(NOW), rateLimitMax: 1000 });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/summary/alice`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'ai_not_configured');
    const cfg = await (await fetch(`http://127.0.0.1:${server.address().port}/api/config`)).json();
    assert.equal(cfg.aiEnabled, false);
  } finally {
    server.close();
    store.close();
  }
});

test('summary route: generates once, then serves from cache', async () => {
  const store = createStore(':memory:');
  let calls = 0;
  const summarizer = {
    provider: 'nvidia',
    model: 'm',
    summarize: async () => { calls += 1; return 'A fine profile.'; },
  };
  const app = createApp({ store, github: fakeGitHub(NOW), summarizer, rateLimitMax: 1000 });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await (await fetch(`${base}/api/summary/alice`)).json();
    assert.equal(first.text, 'A fine profile.');
    assert.equal(first.cached, false);
    const second = await (await fetch(`${base}/api/summary/alice`)).json();
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.aiEnabled, true);
    assert.equal(cfg.aiProvider, 'nvidia');
  } finally {
    server.close();
    store.close();
  }
});
