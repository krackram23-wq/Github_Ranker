'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString();

const LANG_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#a5d6ff'];
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

function setStatus(msg, isError = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('err', isError);
}

function checkLogin(value) {
  const v = value.trim();
  if (!LOGIN_RE.test(v)) throw new Error('Enter a valid GitHub username (letters, digits, hyphens).');
  return v;
}

// ---------- Toast ----------

function showToast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ---------- Single profile ----------

let lastAnalysis = null;

function renderAnalysis(a) {
  lastAnalysis = a;
  $('#result').classList.remove('hidden');
  $('#avatar').src = a.avatarUrl;
  $('#name').textContent = a.name;
  $('#login').href = a.profileUrl;
  $('#login').textContent = `@${a.login}`;
  $('#meta').textContent = `${fmt(a.stats.followers)} followers · ${a.stats.accountAgeYears} yrs on GitHub`;
  $('#bio').textContent = a.bio;
  $('#total').textContent = a.total;

  $('#explain').innerHTML = a.explanations.map((e) => `
    <tr>
      <td>${esc(e.label)}</td>
      <td>${e.score}/100</td>
      <td>+${e.points}</td>
      <td>${esc(e.inputs)}</td>
    </tr>`).join('');
  const tips = a.explanations.filter((e) => e.tip).map((e) => `<li class="med">${esc(e.label)}: ${esc(e.tip)}</li>`);
  $('#explainTips').innerHTML = tips.length ? tips.join('') : '<li class="low">No category is holding back the score.</li>';

  $('#breakdown').innerHTML = Object.keys(a.weights).map((k) => `
    <div class="row"><span>${esc(a.labels[k])} <span class="muted">(${Math.round(a.weights[k] * 100)}%)</span></span><b>${a.scores[k]}</b></div>
    <div class="bar"><i style="width:${a.scores[k]}%"></i></div>`).join('');

  $('#rank').textContent = a.percentile === null
    ? `Percentile ranking unlocks after 5 profiles are analyzed (${a.analyzedCount}/5 so far).`
    : `Higher than ${a.percentile}% of the ${a.analyzedCount} profiles analyzed so far.`;

  const origin = location.origin;
  $('#card').src = `${origin}/api/card/${encodeURIComponent(a.login)}.svg`;
  const badgeUrl = `${origin}/api/badge/${encodeURIComponent(a.login)}.svg`;
  const profileUrl = `${origin}/?u=${encodeURIComponent(a.login)}`;
  $('#badgeSnippet').textContent = `[![GitHub Ranker score](${badgeUrl})](${profileUrl})`;

  // Social share links
  const shareText = `I scored ${a.total}/100 on GitHub Profile Ranker! Check out your own score:`;
  $('#shareX').href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(profileUrl)}`;
  $('#shareLinkedIn').href = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(profileUrl)}`;

  const s = a.stats;
  $('#stats').innerHTML = [
    ['Followers', fmt(s.followers)],
    ['Public repos', fmt(s.publicRepos)],
    ['Own repos (no forks)', fmt(s.ownRepos)],
    ['Total stars', fmt(s.stars)],
    ['Total forks', fmt(s.forks)],
    ['Pushed in 6 months', `${s.recentRepos} / ${s.ownRepos}`],
  ].map(([label, value]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');

  const total = a.languages.reduce((sum, l) => sum + l.share, 0) || 1;
  $('#langBar').innerHTML = a.languages.map((l, i) =>
    `<i style="width:${(l.share / total) * 100}%;background:${LANG_COLORS[i % LANG_COLORS.length]}"></i>`).join('');
  $('#langLegend').innerHTML = a.languages.length
    ? a.languages.slice(0, 8).map((l, i) =>
        `<span><i class="dot" style="background:${LANG_COLORS[i % LANG_COLORS.length]}"></i>${esc(l.name)} ${l.share}%</span>`).join('')
    : '<span>No language data in public repos.</span>';

  $('#repos').innerHTML = a.topRepos.length
    ? a.topRepos.map((r) => `
      <tr>
        <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a></td>
        <td>${esc(r.language || '-')}</td>
        <td>${fmt(r.stars)}</td>
        <td>${fmt(r.forks)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="muted">No public repos.</td></tr>';

  $('#tips').innerHTML = a.suggestions.map((t) => `<li class="${esc(t.level)}">${esc(t.text)}</li>`).join('');

  // Reset README generator
  $('#readmeOutput').classList.add('hidden');
}

async function renderHistory(login) {
  const { points } = await api(`/api/history/${encodeURIComponent(login)}`);
  const el = $('#history');
  if (points.length < 2) {
    el.textContent = points.length
      ? `First snapshot: ${points[0].total}/100. Analyze again later to see growth.`
      : 'No history yet.';
    return;
  }
  const W = 600, H = 60, pad = 6;
  const min = Math.min(...points.map((p) => p.total));
  const max = Math.max(...points.map((p) => p.total));
  const span = Math.max(max - min, 1);
  const coords = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (W - pad * 2);
    const y = H - pad - ((p.total - min) / span) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  el.innerHTML = `
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Score history">
      <polyline fill="none" stroke="#58a6ff" stroke-width="2" points="${coords.join(' ')}"/>
    </svg>
    <div class="muted">${points.length} snapshots · first ${points[0].total}, latest ${points[points.length - 1].total}</div>`;
}

async function analyze(rawLogin) {
  let login;
  try { login = checkLogin(rawLogin); } catch (e) { setStatus(e.message, true); return; }
  const btn = $('#go');
  btn.disabled = true;
  setStatus('Fetching profile and scoring...');
  try {
    const a = await api(`/api/analyze/${encodeURIComponent(login)}`);
    renderAnalysis(a);
    history.replaceState(null, '', `?u=${encodeURIComponent(a.login)}`);
    setStatus(a.cached ? 'Loaded from cache (refreshes every 6 hours).' : '');
    await renderHistory(a.login);
    loadAiSection(a.login);
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    btn.disabled = false;
    loadLeaderboard();
  }
}

// ---------- Compare ----------

function compareCard(p, isWinner) {
  const rows = Object.keys(p.weights).map((k) => `
    <div class="row"><span>${esc(p.labels[k])}</span><b>${p.scores[k]}</b></div>
    <div class="bar"><i style="width:${p.scores[k]}%"></i></div>`).join('');
  return `
    <div class="card" style="margin-top:0">
      <div class="profile">
        <img class="avatar" style="width:48px;height:48px" src="${esc(p.avatarUrl)}" alt="">
        <div><b>${esc(p.name)}</b><div class="muted">@${esc(p.login)}</div></div>
      </div>
      <div style="font-size:40px;font-weight:700;color:var(--accent);margin:12px 0 4px">${p.total}<small class="muted" style="font-size:16px">/100</small></div>
      ${isWinner ? '<div class="winner">Higher score</div>' : ''}
      <div style="margin-top:10px">${rows}</div>
      <div class="muted">${fmt(p.stats.followers)} followers · ${fmt(p.stats.stars)} stars · ${p.stats.ownRepos} repos</div>
    </div>`;
}

async function compare(rawA, rawB) {
  let a, b;
  try { a = checkLogin(rawA); b = checkLogin(rawB); } catch (e) { setStatus(e.message, true); return; }
  setStatus('Comparing...');
  try {
    const { a: pa, b: pb, winner } = await api(`/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
    const box = $('#compareResult');
    box.classList.remove('hidden');
    box.innerHTML = `<div class="two">${compareCard(pa, winner === pa.login)}${compareCard(pb, winner === pb.login)}</div>
      <div class="muted" style="margin-top:8px">${winner ? `${esc(winner)} leads on overall score.` : 'Tie on overall score.'}</div>`;
    setStatus('');
  } catch (e) {
    setStatus(e.message, true);
  }
}

// ---------- Leaderboard ----------

async function loadLeaderboard() {
  const language = $('#langFilter').value;
  const qs = language ? `?language=${encodeURIComponent(language)}` : '';
  try {
    const { entries, analyzedCount } = await api(`/api/leaderboard${qs}`);
    $('#boardMeta').textContent = `${analyzedCount} profiles analyzed`;
    $('#board').innerHTML = entries.length
      ? entries.map((e) => `
        <li>
          <img src="${esc(e.avatarUrl)}" alt="">
          <a href="?u=${encodeURIComponent(e.login)}">${esc(e.login)}</a>
          <span class="muted">${esc(e.primaryLanguage || '')}</span>
          <b style="margin-left:auto">${e.total}/100</b>
        </li>`).join('')
      : '<li class="muted">No profiles yet for this filter. Analyze one to start the board.</li>';
  } catch (e) {
    $('#board').innerHTML = `<li class="err">${esc(e.message)}</li>`;
  }
}

// ---------- AI summary ----------

let aiEnabled = null;

async function loadAiSection(login) {
  const box = $('#aiBox');
  const btn = $('#aiBtn');
  if (aiEnabled === null) {
    try { aiEnabled = (await api('/api/config')).aiEnabled; } catch { aiEnabled = false; }
  }
  box.style.whiteSpace = 'normal';
  if (!aiEnabled) {
    box.textContent = 'AI summaries are not enabled on this server.';
    btn.classList.add('hidden');
    return;
  }
  box.textContent = 'Get a plain-language review of this profile, written by an AI model.';
  btn.classList.remove('hidden');
  btn.onclick = async () => {
    btn.disabled = true;
    box.textContent = 'Writing summary...';
    try {
      const r = await api(`/api/summary/${encodeURIComponent(login)}`);
      box.style.whiteSpace = 'pre-wrap';
      box.style.color = 'var(--text)';
      box.textContent = r.text;
    } catch (e) {
      box.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------- PNG Download ----------

$('#downloadPng').addEventListener('click', async () => {
  if (!lastAnalysis) return;
  const btn = $('#downloadPng');
  btn.disabled = true;
  try {
    const svgUrl = `${location.origin}/api/card/${encodeURIComponent(lastAnalysis.login)}.svg`;
    const svgText = await fetch(svgUrl).then((r) => r.text());
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 640;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    ctx.drawImage(img, 0, 0, 1200, 640);
    URL.revokeObjectURL(url);
    const pngUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `github-ranker-${lastAnalysis.login}.png`;
    link.href = pngUrl;
    link.click();
    showToast('PNG downloaded!');
  } catch (e) {
    showToast('Failed to download PNG');
  } finally {
    btn.disabled = false;
  }
});

// ---------- Copy Badge ----------

$('#copyBadge').addEventListener('click', async () => {
  const text = $('#badgeSnippet').textContent;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Badge markdown copied!');
  } catch {
    showToast('Copy failed – try selecting manually');
  }
});

// ---------- README Generator ----------

$('#genReadme').addEventListener('click', () => {
  const a = lastAnalysis;
  if (!a) return;
  const origin = location.origin;
  const badgeUrl = `${origin}/api/badge/${encodeURIComponent(a.login)}.svg`;
  const cardUrl = `${origin}/api/card/${encodeURIComponent(a.login)}.svg`;
  const profileUrl = `${origin}/?u=${encodeURIComponent(a.login)}`;
  const langs = a.languages.slice(0, 5).map((l) => l.name).join(', ') || 'Various';
  const topRepos = a.topRepos.slice(0, 3);

  let readme = `## 📊 GitHub Profile Score\n\n`;
  readme += `[![GitHub Ranker score](${badgeUrl})](${profileUrl})\n\n`;
  readme += `> Scored **${a.total}/100** on [GitHub Profile Ranker](${profileUrl})\n\n`;
  readme += `### 🏆 Score Breakdown\n\n`;
  readme += `| Category | Score |\n`;
  readme += `|----------|-------|\n`;
  for (const k of Object.keys(a.weights)) {
    readme += `| ${a.labels[k]} | ${a.scores[k]}/100 |\n`;
  }
  readme += `\n### 💻 Top Languages\n\n`;
  readme += `${langs}\n\n`;
  if (topRepos.length) {
    readme += `### ⭐ Featured Repositories\n\n`;
    for (const r of topRepos) {
      readme += `- [**${r.name}**](${r.url}) – ${r.language || 'N/A'} · ⭐ ${r.stars} · 🍴 ${r.forks}\n`;
    }
    readme += `\n`;
  }
  readme += `### 📈 Stats\n\n`;
  readme += `- **${fmt(a.stats.followers)}** followers\n`;
  readme += `- **${fmt(a.stats.stars)}** total stars\n`;
  readme += `- **${a.stats.ownRepos}** original repos\n\n`;
  readme += `![Score card](${cardUrl})\n\n`;
  readme += `---\n*Generated by [GitHub Profile Ranker](${origin})*\n`;

  $('#readmeText').value = readme;
  $('#readmeOutput').classList.remove('hidden');
});

$('#copyReadme').addEventListener('click', async () => {
  const text = $('#readmeText').value;
  try {
    await navigator.clipboard.writeText(text);
    showToast('README copied to clipboard!');
  } catch {
    showToast('Copy failed – try selecting manually');
  }
});

$('#downloadReadme').addEventListener('click', () => {
  const text = $('#readmeText').value;
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = 'github-profile-readme.md';
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
  showToast('README downloaded!');
});

// ---------- Wiring ----------

$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  analyze($('#username').value);
});

$('#compareForm').addEventListener('submit', (e) => {
  e.preventDefault();
  compare($('#compareA').value, $('#compareB').value);
});

$('#langFilter').addEventListener('change', loadLeaderboard);

const clearBtn = $('#clearBoardBtn');
if (clearBtn) {
  clearBtn.addEventListener('click', async () => {
    const ok = window.confirm('Are you sure you want to clear all leaderboard entries? This cannot be undone.');
    if (!ok) return;
    clearBtn.disabled = true;
    try {
      const res = await fetch('/api/leaderboard/clear', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to clear leaderboard.');
      }
      setStatus('Leaderboard cleared.');
      await loadLeaderboard();
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      clearBtn.disabled = false;
    }
  });
}

loadLeaderboard();
const initial = new URLSearchParams(location.search).get('u');
if (initial) {
  $('#username').value = initial;
  analyze(initial);
}
