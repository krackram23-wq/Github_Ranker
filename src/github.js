'use strict';

const API = 'https://api.github.com';

/** An error with an HTTP status and a stable machine-readable code. */
class UpstreamError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Thin GitHub REST client. Uses the server-side token when given,
 * so users never need to paste credentials into the browser.
 * `fetchImpl` is injectable for tests.
 */
function createGitHubClient({ token = null, fetchImpl = globalThis.fetch, baseUrl = API } = {}) {
  async function get(path) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'github-ranker',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetchImpl(baseUrl + path, { headers });

    if (res.status === 404) {
      throw new UpstreamError(404, 'GitHub user not found.', 'not_found');
    }
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const when = reset ? ` Resets at ${new Date(reset * 1000).toISOString()}.` : '';
      throw new UpstreamError(429, `GitHub rate limit reached.${when}`, 'rate_limited');
    }
    if (res.status === 401) {
      const hint = token ? ' Check the GITHUB_TOKEN value on the server.' : '';
      throw new UpstreamError(502, `GitHub rejected the request (401).${hint}`, 'upstream_auth');
    }
    if (!res.ok) {
      throw new UpstreamError(502, `GitHub API error (${res.status}).`, 'upstream_error');
    }
    return res.json();
  }

  /** Fetch a public user and their owned repos (first 100, most recently pushed). */
  async function fetchUserBundle(login) {
    const u = encodeURIComponent(login);
    const user = await get(`/users/${u}`);
    if (user.type !== 'User') {
      throw new UpstreamError(404, 'GitHub user not found.', 'not_found');
    }
    const repos = await get(`/users/${u}/repos?per_page=100&sort=pushed&type=owner`);
    return { user, repos };
  }

  return { fetchUserBundle };
}

module.exports = { createGitHubClient, UpstreamError };
