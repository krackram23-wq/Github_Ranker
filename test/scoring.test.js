'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeProfile, suggest, WEIGHTS } = require('../src/scoring');
const { makeBundle, DAY } = require('./fixtures');

const NOW = Date.parse('2026-10-12T12:00:00Z');

test('weights add up to 1', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('every category and the total stay within 0..100', () => {
  const a = analyzeProfile({ ...makeBundle('alice', NOW), now: NOW });
  for (const v of Object.values(a.scores)) {
    assert.ok(v >= 0 && v <= 100, `score ${v} out of range`);
  }
  assert.ok(a.total >= 0 && a.total <= 100);
});

test('forks are excluded from repo metrics', () => {
  const a = analyzeProfile({ ...makeBundle('alice', NOW), now: NOW });
  assert.equal(a.stats.ownRepos, 4, 'the Go fork must not count');
  assert.equal(a.stats.stars, 250 + 40 + 2 + 6, 'fork stars (9000) must not count');
  assert.equal(a.languages.some((l) => l.name === 'Go'), false);
  assert.equal(a.topRepos.some((r) => r.name === 'some-upstream-fork'), false);
});

test('stale repos are not counted as recent', () => {
  const a = analyzeProfile({ ...makeBundle('alice', NOW), now: NOW });
  // fast-cli (3d), pyparse (20d), dotfiles (60d) are recent; old-experiment (900d) is not.
  assert.equal(a.stats.recentRepos, 3);
});

test('language shares sum to about 100 and primary language is the largest', () => {
  const a = analyzeProfile({ ...makeBundle('alice', NOW), now: NOW });
  const total = a.languages.reduce((s, l) => s + l.share, 0);
  assert.ok(total >= 98 && total <= 102, `shares sum to ${total}`);
  assert.equal(a.primaryLanguage, 'TypeScript');
});

test('top repos are sorted by stars', () => {
  const a = analyzeProfile({ ...makeBundle('alice', NOW), now: NOW });
  const stars = a.topRepos.map((r) => r.stars);
  assert.deepEqual(stars, [...stars].sort((x, y) => y - x));
});

test('an empty profile scores low and does not crash', () => {
  const user = { login: 'nobody', created_at: new Date(NOW).toISOString(), followers: 0, public_repos: 0 };
  const a = analyzeProfile({ user, repos: [], now: NOW });
  assert.equal(a.stats.ownRepos, 0);
  assert.equal(a.primaryLanguage, null);
  assert.ok(a.total < 20, `expected a low score, got ${a.total}`);
  assert.ok(a.suggestions.some((s) => s.level === 'high'));
});

test('more stars and followers raise the score', () => {
  const base = makeBundle('alice', NOW);
  const strong = makeBundle('alice', NOW);
  strong.user.followers = 5000;
  strong.repos.forEach((r) => { r.stargazers_count *= 50; r.forks_count *= 20; });
  const low = analyzeProfile({ ...base, now: NOW });
  const high = analyzeProfile({ ...strong, now: NOW });
  assert.ok(high.total > low.total, `${high.total} should beat ${low.total}`);
  assert.ok(high.scores.impact > low.scores.impact);
  assert.ok(high.scores.community > low.scores.community);
});

test('account age is capped in the consistency score', () => {
  const young = makeBundle('alice', NOW);
  young.user.created_at = new Date(NOW - 1 * 365 * DAY).toISOString();
  const old = makeBundle('alice', NOW);
  old.user.created_at = new Date(NOW - 30 * 365 * DAY).toISOString();
  const a = analyzeProfile({ ...young, now: NOW });
  const b = analyzeProfile({ ...old, now: NOW });
  assert.ok(b.scores.consistency >= a.scores.consistency);
  assert.ok(b.stats.accountAgeYears > a.stats.accountAgeYears);
  assert.ok(b.scores.consistency <= 100);
});

test('suggestions flag a missing bio and missing licenses', () => {
  const bundle = makeBundle('alice', NOW);
  bundle.user.bio = null;
  const a = analyzeProfile({ ...bundle, now: NOW });
  assert.ok(a.suggestions.some((s) => /bio/i.test(s.text)));
  // The fixture has one licensed repo, so the LICENSE rule should not fire.
  assert.equal(a.suggestions.some((s) => /LICENSE/.test(s.text)), false);
});

test('a well-maintained profile gets the fallback suggestion', () => {
  const stats = {
    ownRepos: 5, recentRepos: 5, describedRepos: 5, licensedRepos: 5, taggedRepos: 5,
    stars: 500, followers: 200,
  };
  const out = suggest({ bio: 'hi', blog: 'x' }, stats, [{ name: 'Go' }, { name: 'Rust' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, 'low');
});

test('explanations cover all five categories with inputs and points', () => {
  const a = analyzeProfile({ ...makeBundle('alice', NOW), now: NOW });
  assert.equal(a.explanations.length, 5);
  for (const e of a.explanations) {
    assert.ok(e.label && e.inputs, `missing text for ${e.key}`);
    assert.equal(e.score, a.scores[e.key]);
    assert.ok(e.points >= 0 && e.points <= 100 * WEIGHTS[e.key] + 0.05);
  }
});

test('explanation points add up to the total within rounding', () => {
  const a = analyzeProfile({ ...makeBundle('alice', NOW), now: NOW });
  const sum = a.explanations.reduce((acc, e) => acc + e.points, 0);
  assert.ok(Math.abs(sum - a.total) <= 1, `points ${sum} vs total ${a.total}`);
});

test('explanations include the real counts from the profile', () => {
  const a = analyzeProfile({ ...makeBundle('alice', NOW), now: NOW });
  const impact = a.explanations.find((e) => e.key === 'impact');
  assert.match(impact.inputs, /298 stars/);
  assert.match(impact.inputs, /4 own repos/);
});
