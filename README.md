# GitHub Profile Ranker

Score any public GitHub profile, see how it compares to others, and get concrete suggestions to improve.

## Features

- **Developer Score** (0-100) from five weighted categories, with a visible breakdown
- **Overview stats**: followers, repos, stars, forks, recent activity, account age
- **Language mix** weighted by repo size, and top repositories
- **Suggestions**: rule-based tips for bios, descriptions, topics, licenses, stale repos, and more
- **Percentile rank** against every profile analyzed on your server
- **Leaderboard** with a language filter
- **Compare** two profiles side by side
- **Score history** chart for each profile
- **Shareable card** (SVG) and **README badge** (SVG + Markdown snippet)
- SQLite caching, so repeat lookups don't use GitHub quota

## Project layout

```
github-ranker/
├── public/            Frontend (HTML, CSS, vanilla JS, no build step)
│   ├── index.html
│   └── app.js
├── src/
│   ├── server.js      Express app: routes, rate limiting, error handling
│   ├── scoring.js     Pure scoring and suggestion logic (no I/O)
│   ├── github.js      GitHub REST client (injectable fetch for tests)
│   ├── db.js          SQLite store: cache, analyses, history
│   └── svg.js         Badge and share-card rendering
├── test/              node:test suites (scoring unit tests, API integration tests)
├── Dockerfile
└── .env.example
```

## Quick start

Requires Node.js 22 or newer.

```bash
npm install
npm test          # 23 tests
npm start         # http://localhost:3000
```

Optional: set a GitHub token to raise the API limit from 60 to 5,000 requests per hour.

```bash
GITHUB_TOKEN=ghp_yourtoken npm start
```

The token is read on the server only. It is never sent to the browser.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `GITHUB_TOKEN` | unset | Server-side token for GitHub API calls |
| `DB_PATH` | `./data/ranker.db` | SQLite file location |
| `CACHE_TTL_HOURS` | `6` | How long GitHub data is reused before refetching |

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/analyze/:username` | Score a profile. Add `?refresh=1` to bypass the cache. |
| GET | `/api/compare?a=&b=` | Score two profiles and name the leader |
| GET | `/api/leaderboard?language=&limit=` | Top profiles, optionally filtered by primary language |
| POST | `/api/leaderboard/clear` | Clear all stored leaderboard profiles and snapshots |
| GET | `/api/history/:username` | Score snapshots over time |
| GET | `/api/card/:username.svg` | Shareable score card |
| GET | `/api/badge/:username.svg` | Small score badge for a README |
| GET | `/api/health` | Liveness check |

Errors use a consistent shape: `{ "error": "message", "code": "machine_code" }`. Codes include `invalid_username` (400), `not_found` (404), `rate_limited` (429), `upstream_error` and `upstream_auth` (502), and `internal` (500).

Rate limiting: 60 requests per minute per IP on `/api`.

## How scoring works

| Category | Weight | Signal |
|---|---|---|
| Activity | 25% | Share of own repos pushed in the last 180 days, plus volume |
| Impact | 30% | Log-scaled total stars and forks on own (non-fork) repos |
| Repo quality | 25% | Repos with descriptions, licenses, and topics; bio and website bonus |
| Community | 10% | Log-scaled followers |
| Consistency | 10% | Account age (capped at 8 years) and number of repos |

Forks are excluded from all repo metrics so forking popular projects doesn't inflate a score.

## Deployment

Docker:

```bash
docker build -t github-ranker .
docker run -p 3000:3000 -e GITHUB_TOKEN=ghp_yourtoken -v ranker-data:/app/data github-ranker
```

Any Node 22+ host works. Keep the `data/` directory on persistent storage, or the cache and history reset on each deploy.

## Known limits

- Only the first 100 repos (most recently pushed) are analyzed per profile.
- Scores are heuristics. Stars and followers can be gamed, so treat rankings as a rough signal.
- Percentiles reflect profiles analyzed on this server, not all of GitHub.
- Only public data is used.

## Roadmap

- Background refresh of stale profiles
- Organization profiles
- AI-written summary of a profile (Claude API)
- Automatic README generator
- Account sign-in with GitHub OAuth for private-repo opt-in
