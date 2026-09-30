#!/usr/bin/env node
/**
 * 抓取 GitHub 公开数据，渲染为自包含 SVG。
 *
 * 为什么不用 github-readme-stats / vercel 卡片：
 * CNB 的 img-src CSP 白名单只放行 *.cnb.cool 等少数域名，
 * Vercel 卡片既不在白名单内、直连又超时，必然裂图。
 * 这里把数据落成仓库内的 SVG，README 引 cnb.cool 的 raw 地址，稳定且可缓存。
 *
 * 用法：
 *   node scripts/gen-stats.mjs [--out assets/github-stats.svg]
 * 环境变量：
 *   GITHUB_USER   默认 carolcoral
 *   GITHUB_TOKEN  可选；设置后走认证请求（限流 5000/h），否则匿名（60/h，共享 IP 容易打满）
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const USER = process.env.GITHUB_USER || 'carolcoral';
const TOKEN = process.env.GITHUB_TOKEN || '';
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx > -1 ? argv[outIdx + 1] : 'assets/github-stats.svg';

const API = 'https://api.github.com';
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': `${USER}-stats-svg`,
  'x-github-api-version': '2022-11-28',
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

async function api(path) {
  const res = await fetch(`${API}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`);
  return res.json();
}

async function collect() {
  const user = await api(`/users/${USER}`);
  // 拉全部公开仓库（分页），用于聚合 star / fork / 语言
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const chunk = await api(`/users/${USER}/repos?per_page=100&page=${page}&sort=updated`);
    repos.push(...chunk);
    if (chunk.length < 100) break;
  }
  const stars = repos.reduce((n, r) => n + (r.stargazers_count || 0), 0);
  const forks = repos.reduce((n, r) => n + (r.forks_count || 0), 0);
  const langs = {};
  for (const r of repos) if (r.language) langs[r.language] = (langs[r.language] || 0) + 1;
  const topLangs = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    name: user.name || user.login,
    login: user.login,
    avatar: user.avatar_url,
    repos: user.public_repos,
    followers: user.followers,
    stars,
    forks,
    topLangs,
    updated: new Date().toISOString().slice(0, 10),
  };
}

const PALETTE = ['#22d3ee', '#3b82f6', '#a855f7', '#f472b6', '#34d399', '#ffd166'];
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function render(d) {
  const W = 860, H = 300, PAD = 26;
  const cards = [
    ['Stars', d.stars, '#ffd166'],
    ['Forks', d.forks, '#3b82f6'],
    ['Repos', d.repos, '#34d399'],
    ['Followers', d.followers, '#ef476f'],
  ];
  const cw = (W - PAD * 2 - 18 * 3) / 4;
  const cardsSvg = cards
    .map(([label, val, color], i) => {
      const x = PAD + i * (cw + 18), y = 78;
      return `<g>
    <rect x="${x.toFixed(1)}" y="${y}" width="${cw.toFixed(1)}" height="72" rx="10" fill="#111a30" stroke="#1e2a4a"/>
    <text x="${(x + cw / 2).toFixed(1)}" y="${y + 32}" fill="${color}" font-size="24" font-weight="700" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${esc(val)}</text>
    <text x="${(x + cw / 2).toFixed(1)}" y="${y + 55}" fill="#94a3b8" font-size="12" text-anchor="middle" font-family="system-ui,-apple-system,'PingFang SC',sans-serif" letter-spacing="1">${esc(label)}</text>
  </g>`;
    })
    .join('\n  ');

  const total = d.topLangs.reduce((n, [, c]) => n + c, 0) || 1;
  const barW = W - PAD * 2;
  let acc = 0;
  const bar = d.topLangs
    .map(([name, count], i) => {
      const w = (count / total) * barW;
      const seg = `<rect x="${(PAD + acc).toFixed(1)}" y="196" width="${w.toFixed(1)}" height="10" fill="${PALETTE[i % PALETTE.length]}"/>`;
      acc += w;
      return seg;
    })
    .join('\n  ');

  let lx = PAD;
  const legend = d.topLangs
    .map(([name, count], i) => {
      const label = `${name} ${Math.round((count / total) * 100)}%`;
      const w = label.length * 6.6 + 22;
      const seg = `<circle cx="${(lx + 5).toFixed(1)}" cy="232" r="5" fill="${PALETTE[i % PALETTE.length]}"/>
    <text x="${(lx + 16).toFixed(1)}" y="236" fill="#cbd5e1" font-size="12" font-family="system-ui,-apple-system,'PingFang SC',sans-serif">${esc(label)}</text>`;
      lx += w + 14;
      return seg;
    })
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub stats for ${esc(d.login)}">
  <title>GitHub Stats · ${esc(d.login)}</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1020"/>
      <stop offset="100%" stop-color="#0f1730"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="14" fill="url(#bg)" stroke="#1e2a4a"/>

  <circle cx="${PAD + 22}" cy="44" r="22" fill="#1e2a4a" stroke="#3b82f6"/>
  <text x="${PAD + 22}" y="52" fill="#22d3ee" font-size="20" font-weight="700" text-anchor="middle" font-family="ui-monospace,monospace">${esc((d.login[0] || '?').toUpperCase())}</text>
  <text x="${PAD + 56}" y="40" fill="#e2e8f0" font-size="18" font-weight="700" font-family="system-ui,-apple-system,'PingFang SC',sans-serif">${esc(d.name)} <tspan fill="#64748b" font-weight="400">@${esc(d.login)}</tspan></text>
  <text x="${PAD + 56}" y="60" fill="#64748b" font-size="12" font-family="ui-monospace,monospace">Build · Mirror · Share</text>
  <text x="${W - PAD}" y="40" fill="#475569" font-size="11" text-anchor="end" font-family="ui-monospace,monospace">updated ${esc(d.updated)}</text>

  ${cardsSvg}

  <text x="${PAD}" y="186" fill="#94a3b8" font-size="12" font-family="system-ui,-apple-system,'PingFang SC',sans-serif" letter-spacing="1">TOP LANGUAGES</text>
  ${bar}
  ${legend}
</svg>
`;
}

const data = await collect();
const svg = render(data);
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, svg, 'utf8');
console.log(`wrote ${OUT} (${svg.length} bytes) · stars=${data.stars} forks=${data.forks} repos=${data.repos}`);
