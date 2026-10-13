'use strict';

const DAY = 24 * 60 * 60 * 1000;

/** A realistic-looking profile with one fork and one stale repo. */
function makeBundle(login = 'alice', now = Date.now()) {
  const ago = (days) => new Date(now - days * DAY).toISOString();
  return {
    user: {
      login,
      name: 'Alice Example',
      type: 'User',
      avatar_url: 'https://avatars.example/alice.png',
      html_url: `https://github.com/${login}`,
      bio: 'Builds developer tools',
      blog: 'https://alice.example',
      followers: 120,
      following: 15,
      public_repos: 5,
      created_at: ago(365 * 4),
    },
    repos: [
      {
        name: 'fast-cli', fork: false, html_url: `https://github.com/${login}/fast-cli`,
        description: 'A fast CLI', license: { key: 'mit' }, topics: ['cli'],
        language: 'TypeScript', size: 900, stargazers_count: 250, forks_count: 30, pushed_at: ago(3),
      },
      {
        name: 'pyparse', fork: false, html_url: `https://github.com/${login}/pyparse`,
        description: 'Parsing helpers', license: null, topics: [],
        language: 'Python', size: 300, stargazers_count: 40, forks_count: 4, pushed_at: ago(20),
      },
      {
        name: 'old-experiment', fork: false, html_url: `https://github.com/${login}/old-experiment`,
        description: null, license: null, topics: [],
        language: 'Python', size: 100, stargazers_count: 2, forks_count: 0, pushed_at: ago(900),
      },
      {
        name: 'some-upstream-fork', fork: true, html_url: `https://github.com/${login}/some-upstream-fork`,
        description: 'Forked', license: null, topics: [],
        language: 'Go', size: 5000, stargazers_count: 9000, forks_count: 9000, pushed_at: ago(1),
      },
      {
        name: 'dotfiles', fork: false, html_url: `https://github.com/${login}/dotfiles`,
        description: 'My setup', license: null, topics: ['shell'],
        language: 'Shell', size: 50, stargazers_count: 6, forks_count: 1, pushed_at: ago(60),
      },
    ],
  };
}

/** Fake GitHub client: counts calls and simulates a 404 for "ghost". */
function fakeGitHub(now) {
  const { UpstreamError } = require('../src/github');
  const client = {
    calls: 0,
    async fetchUserBundle(login) {
      client.calls += 1;
      if (login.toLowerCase() === 'ghost') {
        throw new UpstreamError(404, 'GitHub user not found.', 'not_found');
      }
      const bundle = makeBundle(login, now);
      return bundle;
    },
  };
  return client;
}

module.exports = { makeBundle, fakeGitHub, DAY };
