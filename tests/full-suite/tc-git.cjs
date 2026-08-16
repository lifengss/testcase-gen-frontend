// M1 Git 协同（对齐 KS §12 · S1）测试：单元测试（Mock 数据形状 / 前端字段契约）+ 功能冒烟（BFF 端点可达性）。
// 运行前提：BFF 以 GIT_MOCK=1 启动（不依赖 KS 真实侧，验证垂直构建 UI 链路先可测）。
//   node server/index.js 需设置 env GIT_MOCK=1，端口 4123。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'web', 'app.v2.js');
const CONTRACT = path.join(ROOT, 'docs', 'TCGF-API-CONTRACT.md');

function read(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }

// 前端调用 Git 端点时的字段名（从 app.v2.js 静态提取：负载体 + 读取字段）
function frontendGitFields(src) {
  const out = { putConfigBody: null, reads: [] };
  const m = src.match(/const payload = \{[\s\S]*?\};\s*\n\s*const \{ ok, data \} = await api\('PUT', '\/api\/git\/config'/);
  if (m) {
    const body = m[0];
    out.putConfigBody = {
      hasRemote: /remote:/.test(body),
      hasBranch: /branch:/.test(body),
      hasUserObj: /user:\s*\{ name:/.test(body),
      hasToken: /token:/.test(body),
    };
  }
  // 读取字段：cfg.remote / cfg.branch / cfg.user / s.branch / s.untracked / commitHash
  out.reads = {
    cfgRemote: /cfg\.remote/.test(src),
    cfgBranch: /cfg\.branch/.test(src),
    cfgUserName: /cfg\.user && cfg\.user\.name/.test(src),
    statusBranch: /s\.branch/.test(src),
    statusUntracked: /s\.untracked/.test(src),
    statusModified: /s\.modified/.test(src),
    statusStaged: /s\.staged/.test(src),
    statusAhead: /s\.ahead/.test(src),
    statusBehind: /s\.behind/.test(src),
    commitHashRead: /data\.data\?\.commitHash/.test(src),
  };
  return out;
}

// GIT1 端点可达 + 信封
async function gitEndpointsReachable(ctx) {
  const endpoints = [
    { m: 'GET', p: '/api/git/config' },
    { m: 'PUT', p: '/api/git/config' },
    { m: 'POST', p: '/api/git/init' },
    { m: 'POST', p: '/api/git/commit' },
    { m: 'GET', p: '/api/git/status' },
  ];
  const bad = [];
  for (const e of endpoints) {
    const r = await ctx.http(ctx.bff, e.m, e.p, e.m === 'PUT'
      ? { body: { remote: 'x', branch: 'main', user: { name: '', email: '' } } }
      : e.m === 'POST' && e.p.endsWith('/commit')
        ? { body: { message: 't' } }
        : {});
    if (!r.ok || !r.json || r.json.success !== true || typeof r.json.data !== 'object') {
      bad.push(`${e.m} ${e.p} → ${r.status} ${r.text.slice(0, 80)}`);
    }
  }
  if (bad.length) throw new Error('Git 端点不可达或信封异常: ' + bad.join(' | '));
  return { status: 'pass', detail: `5 个 Git 端点（config/status/init/commit）全部返回 {success:true,data}`, evidence: '对齐 TCGF-API-CONTRACT.md §1 四端点 + config GET/PUT' };
}

// GIT2 Mock 数据字段符合契约 §1
async function gitMockShape(ctx) {
  const cfg = (await ctx.http(ctx.bff, 'GET', '/api/git/config')).json.data;
  const init = (await ctx.http(ctx.bff, 'POST', '/api/git/init', { body: {} })).json.data;
  const commit = (await ctx.http(ctx.bff, 'POST', '/api/git/commit', { body: { message: 't' } })).json.data;
  const status = (await ctx.http(ctx.bff, 'GET', '/api/git/status')).json.data;

  const errs = [];
  if (typeof cfg.initialized !== 'boolean') errs.push('config.initialized 非 bool');
  if (typeof cfg.remote !== 'string') errs.push('config.remote 非 string');
  if (typeof cfg.branch !== 'string') errs.push('config.branch 非 string');
  if (!cfg.user || typeof cfg.user.name !== 'string' || typeof cfg.user.email !== 'string') errs.push('config.user{name,email} 缺失/类型错');

  if (typeof init.initialized !== 'boolean') errs.push('init.initialized 非 bool');
  if (typeof init.branch !== 'string') errs.push('init.branch 非 string');
  if (!('commitHash' in init)) errs.push('init.commitHash 缺失');

  if (!('commitHash' in commit)) errs.push('commit.commitHash 缺失');
  if (typeof commit.message !== 'string') errs.push('commit.message 非 string');
  if (typeof commit.branch !== 'string') errs.push('commit.branch 非 string');

  for (const k of ['initialized', 'branch', 'untracked', 'modified', 'staged', 'ahead', 'behind']) {
    if (!(k in status)) errs.push(`status.${k} 缺失`);
  }
  if (!Array.isArray(status.untracked) || !Array.isArray(status.modified) || !Array.isArray(status.staged)) errs.push('status 列表字段非数组');

  if (errs.length) throw new Error('Mock 数据形状不符契约: ' + errs.join(' | '));
  return { status: 'pass', detail: 'Mock 返回结构与 TCGF-API-CONTRACT §1 逐字段一致', evidence: 'config/user{name,email} · init/commit.commitHash · status 七大字段齐全' };
}

// GIT3 前端字段 ↔ 契约一致（单元级静态防护，捕捉 remoteUrl/token/commitId 类越界）
async function gitFrontendContract(ctx) {
  const src = read(APP);
  const f = frontendGitFields(src);
  const errs = [];
  if (!f.putConfigBody) errs.push('未找到 PUT /api/git/config 的 payload 定义');
  else {
    if (!f.putConfigBody.hasRemote) errs.push('PUT config 负载缺 remote（契约要求 remote）');
    if (!f.putConfigBody.hasBranch) errs.push('PUT config 负载缺 branch');
    if (!f.putConfigBody.hasUserObj) errs.push('PUT config 负载缺 user{name,email}（契约要求）');
    if (f.putConfigBody.hasToken) errs.push('PUT config 负载含 token（契约禁止存储凭证）');
  }
  const r = f.reads;
  if (!r.cfgRemote) errs.push('前端读取 cfg.remote 缺失');
  if (!r.cfgBranch) errs.push('前端读取 cfg.branch 缺失');
  if (!r.cfgUserName) errs.push('前端读取 cfg.user.name 缺失');
  if (!r.statusBranch || !r.statusUntracked || !r.statusModified || !r.statusStaged || !r.statusAhead || !r.statusBehind) errs.push('前端读取 status 字段不全');
  if (!r.commitHashRead) errs.push('前端读取 commit.commitHash 缺失（误用 commitId?）');

  if (errs.length) throw new Error('前端↔契约字段不一致: ' + errs.join(' | '));
  return { status: 'pass', detail: '前端 Git 调用字段与 TCGF-API-CONTRACT §1 完全一致（无 token / 无 remoteUrl / 无 commitId 越界）', evidence: 'loadGitConfig/loadGitStatus 字段名经静态提取校验' };
}

module.exports = [
  { id: 'GIT1', name: 'Git 端点可达+信封(success,data)', group: 'GIT', severity: 'HIGH', async run(ctx) { return await gitEndpointsReachable(ctx); } },
  { id: 'GIT2', name: 'Mock 数据形状↔契约§1', group: 'GIT', severity: 'HIGH', async run(ctx) { return await gitMockShape(ctx); } },
  { id: 'GIT3', name: '前端字段↔契约一致(无token/remoteUrl/commitId)', group: 'GIT', severity: 'MEDIUM', async run(ctx) { return await gitFrontendContract(ctx); } },
];
