'use strict';

const { LABELS } = require('./scoring');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function scoreColor(total) {
  if (total >= 75) return '#3fb950';
  if (total >= 50) return '#58a6ff';
  if (total >= 25) return '#d29922';
  return '#f85149';
}

/** Small "dev score 72/100" badge, sized for a README. */
function renderBadge(total) {
  const label = 'dev score';
  const value = `${total}/100`;
  const lw = 78;
  const vw = 66;
  const h = 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="${h}" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <rect width="${lw}" height="${h}" fill="#555" rx="3"/>
  <rect x="${lw}" width="${vw}" height="${h}" fill="${scoreColor(total)}" rx="3"/>
  <g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
    <text x="${lw / 2}" y="14">${esc(label)}</text>
    <text x="${lw + vw / 2}" y="14">${esc(value)}</text>
  </g>
</svg>`;
}

/** 600x320 shareable score card for a profile analysis. */
function renderCard(a) {
  const W = 600;
  const H = 320;
  const bars = Object.keys(a.scores)
    .map((k, i) => {
      const y = 170 + i * 26;
      const v = a.scores[k];
      return `
  <text x="40" y="${y + 10}" fill="#8b949e" font-size="13">${esc(LABELS[k])}</text>
  <rect x="200" y="${y}" width="300" height="10" rx="5" fill="#30363d"/>
  <rect x="200" y="${y}" width="${3 * v}" height="10" rx="5" fill="${scoreColor(v)}"/>
  <text x="515" y="${y + 10}" fill="#e6edf3" font-size="13">${v}</text>`;
    })
    .join('');

  const lang = a.primaryLanguage ? esc(a.primaryLanguage) : 'No language data';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
  <rect width="${W}" height="${H}" rx="14" fill="#0d1117" stroke="#30363d"/>
  <text x="40" y="60" fill="#e6edf3" font-size="24" font-weight="700">${esc(truncate(a.name, 40))}</text>
  <text x="40" y="84" fill="#8b949e" font-size="14">@${esc(a.login)} · ${lang}</text>
  <text x="40" y="112" fill="#8b949e" font-size="13">${esc(truncate(a.bio, 80))}</text>
  <text x="440" y="70" fill="#58a6ff" font-size="56" font-weight="700" text-anchor="middle">${a.total}</text>
  <text x="440" y="92" fill="#8b949e" font-size="14" text-anchor="middle">Developer Score /100</text>
  ${bars}
  <text x="40" y="${H - 18}" fill="#8b949e" font-size="12">${a.stats.followers} followers · ${a.stats.stars} stars · ${a.stats.ownRepos} repos</text>
</svg>`;
}

module.exports = { renderBadge, renderCard, esc };
