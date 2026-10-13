'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/server');
const { createStore } = require('../src/db');
const { fakeGitHub } = require('./fixtures');

const NOW = Date.now();

async function start(overrides = {}) {
  const store = createStore(':memory:');
  const github = fakeGitHub(NOW);
  const app = createApp({ store, github, rateLimitMax: 1000, ...overrides });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    store,
    github,
    close: () => new Promise((resolve) => { server.close(resolve); store.close(); }),
  };
}

const json = async (res) => ({ status: res.status, body: await res.json() });

test('analyze returns a score and caches the GitHub response', async () => {
  const ctx = await start();
  try {
    const first = await json(await fetch(`${ctx.base}/api/analyze/alice`));
    assert.equal(first.status, 200);
    assert.equal(first.body.login, 'alice');
    assert.ok(first.body.total >= 0 && first.body.total <= 100);
    assert.equal(first.body.cached, false);
    assert.equal(ctx.github.calls, 1);

    const second = await json(await fetch(`${ctx.base}/api/analyze/ALICE`));
    assert.equal(second.body.cached, true, 'second lookup should come from cache');
    assert.equal(ctx.github.calls, 1, 'GitHub should not be called again');
  } finally {
    await ctx.close();
  }
});

test('refresh=1 bypasses the cache', async () => {
  const ctx = await start();
  try {
    await fetch(`${ctx.base}/api/analyze/alice`);
    await fetch(`${ctx.base}/api/analyze/alice?refresh=1`);
    assert.equal(ctx.github.calls, 2);
  } finally {
    await ctx.close();
  }
});

test('invalid usernames are rejected before reaching GitHub', async () => {
  const ctx = await start();
  try {
    for (const bad of ['-leading', 'trailing-', 'has space', 'x'.repeat(40), 'a_b']) {
      const { status, body } = await json(await fetch(`${ctx.base}/api/analyze/${encodeURIComponent(bad)}`));
      assert.equal(status, 400, `expected 400 for ${bad}`);
      assert.equal(body.code, 'invalid_username');
    }
    assert.equal(ctx.github.calls, 0);
  } finally {
    await ctx.close();
  }
});

test('unknown GitHub users return 404 with a code', async () => {
  const ctx = await start();
  try {
    const { status, body } = await json(await fetch(`${ctx.base}/api/analyze/ghost`));
    assert.equal(status, 404);
    assert.equal(body.code, 'not_found');
  } finally {
    await ctx.close();
  }
});

test('percentile is null until enough profiles are stored', async () => {
  const ctx = await start({ minForPercentile: 3 });
  try {
    const one = await json(await fetch(`${ctx.base}/api/analyze/alice`));
    assert.equal(one.body.percentile, null);
    await fetch(`${ctx.base}/api/analyze/bob`);
    const third = await json(await fetch(`${ctx.base}/api/analyze/carol`));
    assert.equal(typeof third.body.percentile, 'number');
    assert.ok(third.body.percentile >= 0 && third.body.percentile <= 100);
    assert.equal(third.body.analyzedCount, 3);
  } finally {
    await ctx.close();
  }
});

test('leaderboard is ordered by score and can filter by language', async () => {
  const ctx = await start();
  try {
    await fetch(`${ctx.base}/api/analyze/alice`);
    await fetch(`${ctx.base}/api/analyze/bob`);
    const all = await json(await fetch(`${ctx.base}/api/leaderboard`));
    assert.equal(all.status, 200);
    assert.equal(all.body.entries.length, 2);
    const totals = all.body.entries.map((e) => e.total);
    assert.deepEqual(totals, [...totals].sort((a, b) => b - a));

    const ts = await json(await fetch(`${ctx.base}/api/leaderboard?language=TypeScript`));
    assert.equal(ts.body.entries.length, 2);
    const none = await json(await fetch(`${ctx.base}/api/leaderboard?language=COBOL`));
    assert.equal(none.body.entries.length, 0);
  } finally {
    await ctx.close();
  }
});

test('compare returns both profiles and a winner', async () => {
  const ctx = await start();
  try {
    const { status, body } = await json(await fetch(`${ctx.base}/api/compare?a=alice&b=bob`));
    assert.equal(status, 200);
    assert.equal(body.a.login, 'alice');
    assert.equal(body.b.login, 'bob');
    assert.ok(body.winner === null || ['alice', 'bob'].includes(body.winner));
  } finally {
    await ctx.close();
  }
});

test('history records one point per fresh analysis', async () => {
  const ctx = await start();
  try {
    await fetch(`${ctx.base}/api/analyze/alice`);
    await fetch(`${ctx.base}/api/analyze/alice`); // cached: no new point
    await fetch(`${ctx.base}/api/analyze/alice?refresh=1`); // fresh: new point
    const { body } = await json(await fetch(`${ctx.base}/api/history/alice`));
    assert.equal(body.points.length, 2);
    assert.equal(typeof body.points[0].total, 'number');
  } finally {
    await ctx.close();
  }
});

test('badge and card endpoints return SVG', async () => {
  const ctx = await start();
  try {
    const badge = await fetch(`${ctx.base}/api/badge/alice.svg`);
    assert.equal(badge.status, 200);
    assert.match(badge.headers.get('content-type'), /image\/svg\+xml/);
    const badgeText = await badge.text();
    assert.match(badgeText, /dev score/);
    assert.match(badgeText, /\/100/);

    const card = await fetch(`${ctx.base}/api/card/alice.svg`);
    assert.equal(card.status, 200);
    const cardText = await card.text();
    assert.match(cardText, /Developer Score/);
    assert.match(cardText, /Alice Example/);
  } finally {
    await ctx.close();
  }
});

test('SVG output escapes user-provided text', async () => {
  const ctx = await start();
  try {
    // Inject a bio containing markup via the fake client's bundle.
    const original = ctx.github.fetchUserBundle;
    ctx.github.fetchUserBundle = async (login) => {
      const b = await original(login);
      b.user.bio = '<script>alert(1)</script>';
      return b;
    };
    const card = await (await fetch(`${ctx.base}/api/card/evil.svg`)).text();
    assert.equal(card.includes('<script>'), false);
    assert.match(card, /&lt;script&gt;/);
  } finally {
    await ctx.close();
  }
});

test('unknown API routes return JSON 404', async () => {
  const ctx = await start();
  try {
    const { status, body } = await json(await fetch(`${ctx.base}/api/nope`));
    assert.equal(status, 404);
    assert.equal(body.code, 'not_found');
  } finally {
    await ctx.close();
  }
});

test('health endpoint responds', async () => {
  const ctx = await start();
  try {
    const { status, body } = await json(await fetch(`${ctx.base}/api/health`));
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  } finally {
    await ctx.close();
  }
});

test('leaderboard clear endpoint empties entries and count', async () => {
  const ctx = await start();
  try {
    await fetch(`${ctx.base}/api/analyze/alice`);
    await fetch(`${ctx.base}/api/analyze/bob`);
    const before = await json(await fetch(`${ctx.base}/api/leaderboard`));
    assert.equal(before.body.entries.length, 2);
    assert.equal(before.body.analyzedCount, 2);

    const clearRes = await json(await fetch(`${ctx.base}/api/leaderboard/clear`, { method: 'POST' }));
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.body.ok, true);

    const after = await json(await fetch(`${ctx.base}/api/leaderboard`));
    assert.equal(after.status, 200);
    assert.equal(after.body.entries.length, 0);
    assert.equal(after.body.analyzedCount, 0);
  } finally {
    await ctx.close();
  }
});
