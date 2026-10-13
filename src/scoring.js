'use strict';

// Pure scoring logic. No I/O, so it is easy to test and shared by the API.

const DAY = 24 * 60 * 60 * 1000;
const STALE_DAYS = 180;

const WEIGHTS = {
  activity: 0.25,
  impact: 0.3,
  quality: 0.25,
  community: 0.1,
  consistency: 0.1,
};

const LABELS = {
  activity: 'Activity',
  impact: 'Impact',
  quality: 'Repo quality',
  community: 'Community',
  consistency: 'Consistency',
};

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * Turn a GitHub user + repo list into a scored analysis.
 * Forks are excluded from every repo-level metric.
 */
function analyzeProfile({ user, repos, now = Date.now() }) {
  const own = (repos || []).filter((r) => !r.fork);
  const n = own.length;

  const stars = sum(own.map((r) => r.stargazers_count || 0));
  const forks = sum(own.map((r) => r.forks_count || 0));
  const recent = own.filter((r) => now - Date.parse(r.pushed_at) < STALE_DAYS * DAY).length;
  const described = own.filter((r) => r.description).length;
  const licensed = own.filter((r) => r.license).length;
  const tagged = own.filter((r) => Array.isArray(r.topics) && r.topics.length > 0).length;
  const ageYears = Math.max(0, (now - Date.parse(user.created_at)) / (365 * DAY));
  const followers = user.followers || 0;

  // Language share is weighted by repo size, with a minimum of 1 KB per repo.
  const langWeights = {};
  for (const r of own) {
    if (r.language) {
      langWeights[r.language] = (langWeights[r.language] || 0) + Math.max(r.size || 0, 1);
    }
  }
  const langTotal = sum(Object.values(langWeights));
  const languages = Object.entries(langWeights)
    .sort((a, b) => b[1] - a[1])
    .map(([name, w]) => ({ name, share: Math.round((w / langTotal) * 100) }));
  const primaryLanguage = languages.length ? languages[0].name : null;

  const hygiene = n ? (described + licensed + tagged) / (3 * n) : 0;

  const scores = {
    activity: clamp((n ? recent / n : 0) * 60 + Math.min(recent, 10) * 4),
    impact: clamp(Math.log10(stars + 1) * 25 + Math.log10(forks + 1) * 10),
    quality: clamp(hygiene * 80 + (user.bio ? 10 : 0) + (user.blog ? 10 : 0)),
    community: clamp(Math.log10(followers + 1) * 33),
    consistency: clamp(Math.min(ageYears, 8) * 10 + Math.min(n, 20) * 1.5),
  };

  const total = clamp(sum(Object.entries(WEIGHTS).map(([k, w]) => scores[k] * w)));

  const yesNo = (v) => (v ? 'yes' : 'no');
  const explanations = [
    {
      key: 'activity',
      label: LABELS.activity,
      score: scores.activity,
      points: Math.round(scores.activity * WEIGHTS.activity * 10) / 10,
      inputs: `${recent} of ${n} own repos were pushed in the last 6 months`,
      tip: recent / Math.max(n, 1) < 0.5 ? 'Push updates to more of your repos to raise this score.' : null,
    },
    {
      key: 'impact',
      label: LABELS.impact,
      score: scores.impact,
      points: Math.round(scores.impact * WEIGHTS.impact * 10) / 10,
      inputs: `${stars} stars and ${forks} forks across ${n} own repos (forks of other projects excluded)`,
      tip: stars < 10 ? 'Stars grow from real use: write clear READMEs and share projects where people look for them.' : null,
    },
    {
      key: 'quality',
      label: LABELS.quality,
      score: scores.quality,
      points: Math.round(scores.quality * WEIGHTS.quality * 10) / 10,
      inputs: `${described} of ${n} repos have a description, ${licensed} have a license, ${tagged} have topics; bio: ${yesNo(user.bio)}, website: ${yesNo(user.blog)}`,
      tip: described < n || licensed < n ? 'Describe, license, and tag each repo to raise this score.' : null,
    },
    {
      key: 'community',
      label: LABELS.community,
      score: scores.community,
      points: Math.round(scores.community * WEIGHTS.community * 10) / 10,
      inputs: `${followers} followers`,
      tip: followers < 100 ? 'Followers come from sharing work and engaging in discussions.' : null,
    },
    {
      key: 'consistency',
      label: LABELS.consistency,
      score: scores.consistency,
      points: Math.round(scores.consistency * WEIGHTS.consistency * 10) / 10,
      inputs: `${Math.round(ageYears * 10) / 10} years on GitHub and ${n} own repos (age is capped at 8 years)`,
      tip: n < 20 ? 'Keep building steadily; consistency rewards sustained work over time.' : null,
    },
  ];

  const stats = {
    publicRepos: user.public_repos || 0,
    ownRepos: n,
    stars,
    forks,
    recentRepos: recent,
    describedRepos: described,
    licensedRepos: licensed,
    taggedRepos: tagged,
    followers,
    following: user.following || 0,
    accountAgeYears: Math.round(ageYears * 10) / 10,
  };

  const topRepos = [...own]
    .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
    .slice(0, 5)
    .map((r) => ({
      name: r.name,
      url: r.html_url,
      language: r.language || null,
      stars: r.stargazers_count || 0,
      forks: r.forks_count || 0,
    }));

  return {
    login: user.login,
    name: user.name || user.login,
    avatarUrl: user.avatar_url || '',
    profileUrl: user.html_url || `https://github.com/${user.login}`,
    bio: user.bio || '',
    total,
    scores,
    weights: WEIGHTS,
    labels: LABELS,
    stats,
    languages,
    primaryLanguage,
    topRepos,
    suggestions: suggest(user, stats, languages),
    explanations,
  };
}

/** Rule-based suggestions, ordered roughly by impact. */
function suggest(user, s, languages) {
  const out = [];
  const add = (level, text) => out.push({ level, text });

  if (s.ownRepos < 3) add('high', `Publish at least 3 public projects. You currently have ${s.ownRepos}.`);
  if (s.ownRepos && s.recentRepos / s.ownRepos < 0.3) {
    add('high', 'Most repos have had no pushes in 6+ months. Update, archive, or mark them as inactive.');
  }
  if (!user.bio) add('med', 'Add a bio to your profile so visitors know what you build.');
  if (s.ownRepos - s.describedRepos > 0) {
    add('med', `Add descriptions to ${s.ownRepos - s.describedRepos} repo(s) that have none.`);
  }
  if (s.ownRepos && s.taggedRepos < s.ownRepos / 2) {
    add('med', 'Add topics to your repos so they show up in GitHub search.');
  }
  if (s.ownRepos && s.licensedRepos === 0) add('med', 'Add a LICENSE file to your main projects.');
  if (!user.blog) add('low', 'Link a website or portfolio on your profile.');
  if (s.stars < 10) add('low', 'Pin your best 6 repos on your profile and share them where your audience is.');
  if (s.followers < 10) add('low', 'Write about or share a project to attract followers.');
  if (s.ownRepos >= 3 && languages.length <= 1) {
    add('low', 'Try a second language in a small project to widen your skill profile.');
  }
  if (out.length === 0) {
    add('low', 'Solid profile. Keep the activity going and consider contributing to open source.');
  }
  return out;
}

module.exports = { analyzeProfile, suggest, WEIGHTS, LABELS, clamp };
