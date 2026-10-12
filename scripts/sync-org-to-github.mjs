#!/usr/bin/env node
/**
 * 把 CNB 组织下所有公开仓库镜像到 GitHub 同名仓库。
 *
 * 为什么自己写而不用 git-sync 插件：git-sync 一次只能同步一个仓库，
 * 而目标仓库在 GitHub 侧并不存在，需要先建仓；建仓 + 逐个仓库同步 + 单仓失败不拖垮整体，
 * 这些编排逻辑插件给不了，只能放在脚本里。
 *
 * 权限说明：定时任务的 CNB_TOKEN 默认只能访问当前仓库，跨仓枚举会被 CNB 拒绝并在
 * 第一步整体报错。需要在「组织设置 → 仓库管控」开启「允许定时任务跨仓操作」，
 * 或改用手动触发按钮执行（手动触发不受该限制）。
 *
 * 用法：
 *   node scripts/sync-org-to-github.mjs [--org xindu.site] [--owner carolcoral]
 *                                      [--only a,b] [--skip a,b] [--dry-run]
 *   --dry-run 只枚举与报告，不建仓不推送，也不需要 GITHUB_TOKEN。
 * 环境变量：
 *   CNB_TOKEN        CNB 临时令牌，用于枚举组织仓库（本仓库公开仓库无需鉴权）
 *   CNB_WEB_PROTOCOL / CNB_WEB_HOST   CNB 访问地址，默认 https://cnb.cool
 *   GITHUB_TOKEN     GitHub PAT，需 repo 权限（私有仓库镜像时还需 workflow 权限）
 *   GIT_USERNAME     推送时显示的用户名，默认 cnb-ci
 *   GIT_EMAIL        推送时显示的邮箱，默认 cnb-ci@cnb.cool
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const exec = (bin, args, opts = {}) =>
  run(bin, args, { maxBuffer: 64 * 1024 * 1024, ...opts }).then((r) => r.stdout.trim());

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const list = (name) =>
  flag(name, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const ORG = flag('org', 'xindu.site');
const OWNER = flag('owner', 'carolcoral');
const ONLY = list('only');
const SKIP = list('skip');
const DRY_RUN = argv.includes('--dry-run');

const CNB_TOKEN = process.env.CNB_TOKEN || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GIT_USER = process.env.GIT_USERNAME || 'cnb-ci';
const GIT_EMAIL = process.env.GIT_EMAIL || 'cnb-ci@cnb.cool';
const CNB_HOST = `${process.env.CNB_WEB_PROTOCOL || 'https'}://${process.env.CNB_WEB_HOST || 'cnb.cool'}`;
const CNB_API = process.env.CNB_API_ENDPOINT || 'https://api.cnb.cool';
const GH_API = 'https://api.github.com';

if (!GITHUB_TOKEN && !DRY_RUN) {
  console.error('缺少 GITHUB_TOKEN，无法创建/推送 GitHub 仓库');
  process.exit(1);
}
// 令牌进 URL 会被 git 记录，用完清掉，避免残留到日志
const redact = (s) => s.replaceAll(GITHUB_TOKEN, '***').replaceAll(CNB_TOKEN, '***');
const log = (...args) => console.log(...args.map((a) => (typeof a === 'string' ? redact(a) : a)));

async function gh(path, init = {}) {
  const res = await fetch(`${GH_API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${GITHUB_TOKEN}`,
      'user-agent': `${OWNER}-cnb-org-sync`,
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  });
  return { res, body: res.status === 204 ? null : await res.json().catch(() => null) };
}

/** 列出组织下所有公开（含归档）仓库 */
async function listPublicRepos() {
  const headers = { accept: 'application/vnd.cnb.api+json' };
  if (CNB_TOKEN) headers.authorization = `Bearer ${CNB_TOKEN}`;
  const found = [];
  for (let page = 1; page <= 20; page++) {
    const url = `${CNB_API}/${ORG}/-/repos?visibility=public&page=${page}&page_size=100`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`枚举组织仓库失败：${res.status} ${await res.text()}`);
    const data = await res.json();
    found.push(...data);
    if (data.length < 100) break;
  }
  return found.map((r) => ({
    name: r.name,
    path: r.path,
    archived: r.status === 1 || r.archived === true,
    forkOf: r.forked_from_repo?.path || '',
  }));
}

/** GitHub 侧确保同名仓库存在：已存在则直接复用（原地更新），不存在才建仓 */
async function ensureGitHubRepo(name, cnbPath) {
  const { res, body } = await gh(`/repos/${OWNER}/${name}`);
  if (res.status === 200) return { created: false, defaultBranch: body.default_branch };
  if (res.status !== 404) throw new Error(`查询 ${name} 失败：${res.status}`);

  if (DRY_RUN) {
    log(`  [dry-run] 将创建 GitHub 仓库 ${OWNER}/${name}`);
    return { created: true, defaultBranch: 'main' };
  }
  const created = await gh('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: `${cnbPath} 的 GitHub 镜像（CNB 自动同步）`.replace(' 的', ' 的'),
      homepage: `${CNB_HOST}/${cnbPath}`,
      has_issues: true,
      has_wiki: false,
      auto_init: true,
    }),
  });
  if (created.res.status !== 201) {
    throw new Error(`创建 ${OWNER}/${name} 失败：${created.res.status} ${JSON.stringify(created.body)}`);
  }
  log(`  已创建 GitHub 仓库 ${OWNER}/${name}`);
  return { created: true, defaultBranch: created.body.default_branch || 'main' };
}

/**
 * 镜像单个仓库：拉取 CNB 的 *全部* refs（分支+标签+PR），整体推到 GitHub。
 * 用 --mirror 而非 checkout：镜像要的是完整历史与标签，
 * 且强制推送会覆盖 GitHub 侧 auto_init 产生的 README 提交，符合「以 CNB 为准」的语义。
 *
 * 同名仓库的处理：GitHub 侧若已存在同名仓库（手工建的、或上一轮同步留下的），
 * 直接原地更新，不重复建仓。但 --mirror 会删除远端多余 refs，
 * 当 GitHub 的默认分支不在本次推送内容里时（例如它停在 auto_init 的 master，
 * 而源仓库默认分支是 main），git 会报「deletion of the current branch prohibited」而整体失败。
 * 所以：默认分支不一致时，先把源默认分支推上去、把 GitHub 默认分支切过去，再做全量镜像。
 */
async function mirrorRepo({ name, path, archived = false }, workdir, ghDefaultBranch) {
  const dir = join(workdir, name);
  const cnbRemote = `${CNB_HOST}/${path}.git`;
  const ghRemote = `https://x-access-token:${GITHUB_TOKEN}@github.com/${OWNER}/${name}.git`;

  await exec('git', ['clone', '--mirror', '--quiet', cnbRemote, dir]);
  // 源仓库的默认分支：镜像克隆会保留 HEAD 指向
  const srcDefault = (await exec('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD']).catch(() => '')) || 'main';

  if (DRY_RUN) {
    const note = ghDefaultBranch && ghDefaultBranch !== srcDefault ? `（默认分支 ${ghDefaultBranch} → ${srcDefault}）` : '';
    log(`  [dry-run] 将强制推送到 ${OWNER}/${name}${note}`);
    return { pushed: true };
  }

  await exec('git', ['-C', dir, 'config', 'user.name', GIT_USER]);
  await exec('git', ['-C', dir, 'config', 'user.email', GIT_EMAIL]);

  // 已存在同名仓库且默认分支与源不一致：先对齐默认分支，否则 mirror 会卡在删不掉旧默认分支
  if (ghDefaultBranch && ghDefaultBranch !== srcDefault) {
    log(`  默认分支对齐：${ghDefaultBranch} → ${srcDefault}`);
    await exec('git', ['-C', dir, 'push', '--quiet', ghRemote, `refs/heads/${srcDefault}:refs/heads/${srcDefault}`]);
    const { res } = await gh(`/repos/${OWNER}/${name}`, {
      method: 'PATCH',
      body: JSON.stringify({ default_branch: srcDefault }),
    });
    if (!res.ok) throw new Error(`切换默认分支到 ${srcDefault} 失败：${res.status}`);
  }

  const out = await exec('git', ['-C', dir, 'push', '--mirror', '--quiet', ghRemote]);
  if (out) log(out);

  // 归档仓库在 GitHub 侧同样置为只读，避免误改
  const { res } = await gh(`/repos/${OWNER}/${name}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived }),
  });
  if (!res.ok) log(`  警告：设置 archived=${archived} 失败：${res.status}`);
  return { pushed: true };
}

const repos = (await listPublicRepos())
  .filter((r) => (ONLY.length ? ONLY.includes(r.name) : true))
  .filter((r) => !SKIP.includes(r.name))
  .sort((a, b) => a.name.localeCompare(b.name));

log(`组织 ${ORG} 下共 ${repos.length} 个公开仓库待同步到 github.com/${OWNER}`);

const workdir = await mkdtemp(join(tmpdir(), 'cnb-org-sync-'));
const results = [];
try {
  for (const repo of repos) {
    log(`\n▶ ${repo.path}${repo.archived ? '（归档）' : ''}${repo.forkOf ? `（fork 自 ${repo.forkOf}）` : ''}`);
    try {
      const { defaultBranch } = await ensureGitHubRepo(repo.name, repo.path);
      await mirrorRepo(repo, workdir, defaultBranch);
      log('  完成');
      results.push({ name: repo.name, ok: true });
    } catch (err) {
      // 单仓失败不中断整体：组织里任何一个仓库出错都不该让其余仓库停摆
      log(`  失败：${err.message}`);
      results.push({ name: repo.name, ok: false, error: redact(err.message) });
    }
  }
} finally {
  await rm(workdir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
log(`\n同步结束：成功 ${results.length - failed.length}/${results.length}`);
for (const f of failed) log(`  ✗ ${f.name}：${f.error}`);
process.exit(failed.length ? 1 : 0);
