'use strict';

// AI profile summaries via any OpenAI-compatible chat API.
// Providers are selected by environment variables; keys are never written to disk.

const PROVIDERS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/free',
    keyEnv: ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_1', 'OPENROUTER_API_KEY_2'],
  },
  nvidia: {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.2-11b-vision-instruct',
    keyEnv: ['NVIDIA_API_KEY'],
  },
};

/** Pick the first configured provider, or the one named in AI_PROVIDER. */
function loadAiConfig(env = process.env) {
  const order = env.AI_PROVIDER ? [env.AI_PROVIDER] : Object.keys(PROVIDERS);
  for (const name of order) {
    const p = PROVIDERS[name];
    if (!p) continue;
    const apiKey = p.keyEnv.map((k) => env[k]).find(Boolean);
    if (apiKey) {
      return {
        provider: name,
        apiKey,
        baseUrl: env.AI_BASE_URL || p.baseUrl,
        model: env.AI_MODEL || p.defaultModel,
      };
    }
  }
  return null;
}

/** Build the prompt from analysis data only (public profile facts, no raw repo dumps). */
function buildPrompt(a) {
  const langs = a.languages.slice(0, 5).map((l) => `${l.name} ${l.share}%`).join(', ') || 'none detected';
  const top = a.topRepos.slice(0, 3).map((r) => `${r.name} (${r.stars} stars)`).join(', ') || 'none';
  const tips = a.suggestions.map((s) => `- ${s.text}`).join('\n');
  return [
    'You are reviewing a public GitHub profile for its owner. Be specific, encouraging, and honest.',
    'Write 4 short paragraphs: (1) overall impression, (2) strongest signals, (3) the two most useful improvements, (4) one concrete next step for the next 30 days.',
    'Do not invent facts. Only use the data below.',
    '',
    `Login: ${a.login}`,
    `Developer Score: ${a.total}/100`,
    `Category scores: ${Object.entries(a.scores).map(([k, v]) => `${a.labels[k]} ${v}`).join(', ')}`,
    `Own repos: ${a.stats.ownRepos}; pushed in last 6 months: ${a.stats.recentRepos}`,
    `Total stars: ${a.stats.stars}; followers: ${a.stats.followers}; account age: ${a.stats.accountAgeYears} years`,
    `Languages: ${langs}`,
    `Top repos: ${top}`,
    `Rule-based suggestions already generated:\n${tips}`,
  ].join('\n');
}

/**
 * Returns { summarize(analysis) -> string }.
 * `fetchImpl` is injectable for tests.
 */
function createSummarizer(config, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  async function summarize(analysis) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.4,
          max_tokens: 600,
          reasoning: { effort: 'none' },
          messages: [{ role: 'user', content: buildPrompt(analysis) }],
        }),
      });
      if (!res.ok) {
        let detail = '';
        if (typeof res.json === 'function') {
          try {
            const errBody = await res.json();
            detail = errBody?.error?.message || errBody?.detail || '';
          } catch (_) {}
        }
        const msg = detail ? `AI provider returned ${res.status}: ${detail}` : `AI provider returned ${res.status}.`;
        const err = new Error(msg);
        err.status = 502;
        err.code = 'ai_upstream_error';
        throw err;
      }
      const body = await res.json();
      const text = (body?.choices?.[0]?.message?.content || body?.choices?.[0]?.message?.reasoning)?.trim();
      if (!text) {
        const err = new Error('AI provider returned an empty response.');
        err.status = 502;
        err.code = 'ai_upstream_error';
        throw err;
      }
      return text;
    } catch (e) {
      if (e.name === 'AbortError') {
        const err = new Error('AI provider timed out.');
        err.status = 504;
        err.code = 'ai_timeout';
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  return { summarize, provider: config.provider, model: config.model };
}

module.exports = { loadAiConfig, createSummarizer, buildPrompt, PROVIDERS };
