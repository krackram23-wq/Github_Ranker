'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+, no native build

/**
 * SQLite persistence:
 *  - github_cache: raw GitHub payloads, so repeat lookups don't burn API quota
 *  - analyses:     latest score per profile, the source for ranking and leaderboards
 *  - history:      score snapshots over time, for growth charts
 */
function createStore(file = ':memory:') {
  if (file !== ':memory:') {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (err) {
      if (err.code === 'EROFS') {
        file = path.join(require('node:os').tmpdir(), 'ranker.db');
      } else {
        throw err;
      }
    }
  }
  let db;
  try {
    db = new DatabaseSync(file);
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  } catch (err) {
    if (err.code === 'EROFS' || (err.message && err.message.includes('readonly'))) {
      file = path.join(require('node:os').tmpdir(), 'ranker.db');
      db = new DatabaseSync(file);
    } else {
      throw err;
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS github_cache (
      login      TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analyses (
      login            TEXT PRIMARY KEY,
      display_login    TEXT NOT NULL,
      name             TEXT NOT NULL,
      avatar_url       TEXT NOT NULL,
      total            INTEGER NOT NULL,
      primary_language TEXT,
      payload          TEXT NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_analyses_total ON analyses (total DESC, login);
    CREATE INDEX IF NOT EXISTS idx_analyses_lang  ON analyses (primary_language, total DESC);
    CREATE TABLE IF NOT EXISTS history (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT NOT NULL,
      total INTEGER NOT NULL,
      at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_login ON history (login, at);
    CREATE TABLE IF NOT EXISTS ai_summaries (
      login      TEXT PRIMARY KEY,
      text       TEXT NOT NULL,
      provider   TEXT NOT NULL,
      model      TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  const q = {
    getCache: db.prepare('SELECT data, fetched_at FROM github_cache WHERE login = ?'),
    putCache: db.prepare(`
      INSERT INTO github_cache (login, data, fetched_at) VALUES (@login, @data, @fetched_at)
      ON CONFLICT(login) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`),
    upsertAnalysis: db.prepare(`
      INSERT INTO analyses (login, display_login, name, avatar_url, total, primary_language, payload, updated_at)
      VALUES (@login, @display_login, @name, @avatar_url, @total, @primary_language, @payload, @updated_at)
      ON CONFLICT(login) DO UPDATE SET
        display_login = excluded.display_login, name = excluded.name,
        avatar_url = excluded.avatar_url, total = excluded.total,
        primary_language = excluded.primary_language, payload = excluded.payload,
        updated_at = excluded.updated_at`),
    getAnalysis: db.prepare('SELECT payload FROM analyses WHERE login = ?'),
    countAnalyses: db.prepare('SELECT COUNT(*) AS c FROM analyses'),
    countBelow: db.prepare('SELECT COUNT(*) AS c FROM analyses WHERE total < ?'),
    leaderboardAll: db.prepare(`
      SELECT display_login, name, avatar_url, total, primary_language FROM analyses
      ORDER BY total DESC, login ASC LIMIT ?`),
    leaderboardLang: db.prepare(`
      SELECT display_login, name, avatar_url, total, primary_language FROM analyses
      WHERE primary_language = ? ORDER BY total DESC, login ASC LIMIT ?`),
    addHistory: db.prepare('INSERT INTO history (login, total, at) VALUES (?, ?, ?)'),
    getSummary: db.prepare('SELECT text, provider, model, created_at FROM ai_summaries WHERE login = ?'),
    putSummary: db.prepare(`
      INSERT INTO ai_summaries (login, text, provider, model, created_at) VALUES (@login, @text, @provider, @model, @created_at)
      ON CONFLICT(login) DO UPDATE SET text = excluded.text, provider = excluded.provider, model = excluded.model, created_at = excluded.created_at`),
    getHistory: db.prepare('SELECT total, at FROM history WHERE login = ? ORDER BY at ASC LIMIT 200'),
  };

  return {
    getCache(login) {
      const row = q.getCache.get(login);
      return row ? { data: JSON.parse(row.data), fetchedAt: row.fetched_at } : null;
    },
    putCache(login, data) {
      q.putCache.run({ login, data: JSON.stringify(data), fetched_at: Date.now() });
    },
    saveAnalysis(key, a) {
      q.upsertAnalysis.run({
        login: key,
        display_login: a.login,
        name: a.name,
        avatar_url: a.avatarUrl,
        total: a.total,
        primary_language: a.primaryLanguage,
        payload: JSON.stringify(a),
        updated_at: Date.now(),
      });
    },
    getAnalysis(key) {
      const row = q.getAnalysis.get(key);
      return row ? JSON.parse(row.payload) : null;
    },
    countAnalyses: () => q.countAnalyses.get().c,
    countBelow: (total) => q.countBelow.get(total).c,
    leaderboard({ language = null, limit = 20 } = {}) {
      const rows = language
        ? q.leaderboardLang.all(language, limit)
        : q.leaderboardAll.all(limit);
      return rows.map((r) => ({
        login: r.display_login,
        name: r.name,
        avatarUrl: r.avatar_url,
        total: r.total,
        primaryLanguage: r.primary_language,
      }));
    },
    addHistory(key, total) {
      q.addHistory.run(key, total, Date.now());
    },
    getHistory(key) {
      return q.getHistory.all(key).map((r) => ({ total: r.total, at: r.at }));
    },
    getSummary(key) {
      const r = q.getSummary.get(key);
      return r ? { text: r.text, provider: r.provider, model: r.model, createdAt: r.created_at } : null;
    },
    putSummary(key, { text, provider, model }) {
      q.putSummary.run({ login: key, text, provider, model, created_at: Date.now() });
    },
    clearLeaderboard() {
      db.exec('DELETE FROM analyses; DELETE FROM history;');
    },
    close() {
      db.close();
    },
  };
}

module.exports = { createStore };
