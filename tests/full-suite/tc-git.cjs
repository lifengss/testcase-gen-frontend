// Git 协同（对齐 KS §12 · S1 + S2 完整阶段）测试：单元测试（Mock 数据形状 / 前端字段契约）+ 功能冒烟（BFF 端点可达性）。
// 运行前提：BFF 端口 4123。
//   GIT1-3：S1，BFF 以 GIT_MOCK=1 启动时走 Mock（不依赖 KS）。
//   GIT4  ：S2，需 KS 真实侧运行（3000）；KS 不可达时该用例标记 skip 而非失败。
//   node server/index.js 端口 4123；KS node api/server.js 端口 3000。
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
    commitHashRead: /(d\.commitHash|data\.data\?\.commitHash)/.test(src),
    hasConflictRead: /s\.hasConflict/.test(src),
    conflictPathRead: /conflict-content/.test(src) && /query:\s*\{\s*path/.test(src),
    resolveStrategy: /resolve-conflict/.test(src) && /strategy/.test(src),
  };
  return out;
}

// GIT1 端点可达 + 信封
async function gitEndpointsReachable(ctx) {
  // 前提自适应：S1 用例设计前提是 BFF 以 GIT_MOCK=1 启动（Mock 数据契约）。
  // 真实模式下 BFF 代理 KS 真实 git 仓库——KS 业务拒绝（如 commit 无可提交内容
  // 返回 400 {success:false,error}）属正常结构化响应（同 GIT4 注释），此时只校验
  // 端点可达 + 结构化信封（success 布尔存在），不强制 success:true。
  // 探测辅助：try/catch + 60s 超时 + 最多 2 次重试。
  // 完整套件下（前面 D1 真实 kimi 生成等耗时用例之后）KS 可能短暂繁忙，
  // fetch 可能抛 AbortError（异常而非返回），必须在 try/catch 内重试。
  async function probe(m, p, body) {
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await ctx.http(ctx.bff, m, p, Object.assign({ timeout: 60000 }, body));
        if (r.json) return r;
        lastErr = new Error(`无结构化 JSON（status=${r.status} ${r.text.slice(0, 60)}）`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
    throw lastErr || new Error('probe 失败');
  }

  let cfgProbe = null;
  try { cfgProbe = await probe('GET', '/api/git/config', {}); }
  catch (e) { throw new Error('Git /api/git/config 探测失败: ' + String(e.stack || e)); }
  const isMock = cfgProbe.json && cfgProbe.json.data && cfgProbe.json.data._mock === true;

  const endpoints = [
    { m: 'GET', p: '/api/git/config' },
    { m: 'PUT', p: '/api/git/config', body: { remote: 'x', branch: 'main', user: { name: '', email: '' } } },
    { m: 'POST', p: '/api/git/init' },
    { m: 'POST', p: '/api/git/commit', body: { message: 't' } },
    { m: 'GET', p: '/api/git/status' },
  ];
  const bad = [];
  for (const e of endpoints) {
    let r = null;
    try { r = await probe(e.m, e.p, e.body ? { body: e.body } : {}); }
    catch (err) { bad.push(`${e.m} ${e.p} → ${err.message}`); continue; }
    if (isMock) {
      // Mock 模式：严格契约，5 端点必须 {success:true,data:object}
      if (r.json.success !== true || typeof r.json.data !== 'object') {
        bad.push(`${e.m} ${e.p} → ${r.status} ${r.text.slice(0, 80)}`);
      }
    } else {
      // 真实模式：只验结构化信封（success 布尔），业务拒绝不算失败
      if (typeof r.json.success !== 'boolean') {
        bad.push(`${e.m} ${e.p} → 信封缺 success 布尔（status=${r.status} ${r.text.slice(0, 80)}）`);
      }
    }
  }
  if (bad.length) throw new Error('Git 端点不可达或信封异常: ' + bad.join(' | '));
  return { status: 'pass', detail: isMock
      ? '5 个 Git 端点（config/status/init/commit）全部返回 {success:true,data}'
      : '5 个 Git 端点经 BFF 可达且返回结构化信封（success 布尔；KS 业务拒绝不视为失败）',
    evidence: '对齐 TCGF-API-CONTRACT.md §1 四端点 + config GET/PUT' };
}

// GIT2 Mock 数据字段符合契约 §1
async function gitMockShape(ctx) {
  // 前提：本用例仅在 BFF 以 GIT_MOCK=1 启动（返回 data._mock=true 的假数据）时
  // 才有意义。真实模式下 BFF 代理 KS 真实数据（/api/git/commit 可能返回
  // {success:false,error} 业务拒绝信封，data 为 undefined），此时按 mock 形状
  // 断言必然失败——故探测 _mock 标记，非 mock 模式则 skip（由 GIT_MOCK 专项验证）。
  const cfgProbe = await ctx.http(ctx.bff, 'GET', '/api/git/config');
  const cfgProbeData = cfgProbe.json && cfgProbe.json.data;
  if (!cfgProbeData || cfgProbeData._mock !== true) {
    return { status: 'skip', detail: 'BFF 非 GIT_MOCK 模式（代理 KS 真实数据），Mock 形状契约用例跳过，需 GIT_MOCK=1 专项运行', evidence: `config.data._mock=${cfgProbeData && cfgProbeData._mock}` };
  }

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
  if (!r.hasConflictRead) errs.push('前端读取 status.hasConflict 缺失（S2 冲突展示）');
  if (!r.conflictPathRead) errs.push('前端读取 conflict-content path 查询缺失（S2）');
  if (!r.resolveStrategy) errs.push('前端 resolve-conflict 调用缺 strategy（S2）');

  if (errs.length) throw new Error('前端↔契约字段不一致: ' + errs.join(' | '));
  return { status: 'pass', detail: '前端 Git 调用字段与 TCGF-API-CONTRACT §1 完全一致（S1+S2，无 token/remoteUrl/commitId 越界，含冲突/分支）', evidence: 'loadGitConfig/loadGitStatus/loadGitConflicts/openConflictContent 字段名经静态提取校验' };
}

// GIT4 S2 真实联调（经 BFF 代理到 KS；KS 未运行则 skip）
async function gitS2Real(ctx) {
  // 先探测 KS 经 BFF 是否可达：打一个只读 S2 端点 branches
  const probe = await ctx.http(ctx.bff, 'GET', '/api/git/branches');
  if (!probe.ok || probe.json == null || (probe.status >= 500) || (probe.json && probe.json.success === false && /ECONNREFUSED|fetch failed|connect/.test(String(probe.json.error || '')))) {
    return { status: 'skip', detail: 'KS 未运行或不可达，跳过 S2 真实联调（请启动 KS :3000 后重跑）', evidence: `branches 探测: ${probe.status} ${String(probe.text).slice(0, 80)}` };
  }
  const checks = [
    { m: 'GET', p: '/api/git/branches', shape: (d) => Array.isArray(d.data.locals) && typeof d.data.current === 'string', name: 'branches' },
    { m: 'GET', p: '/api/git/log?limit=5', shape: (d) => Array.isArray(d.data.commits), name: 'log' },
    { m: 'GET', p: '/api/git/diff', shape: (d) => Array.isArray(d.data.files), name: 'diff' },
  ];
  const bad = [];
  for (const c of checks) {
    const r = await ctx.http(ctx.bff, c.m, c.p);
    if (!r.ok || !r.json || r.json.success !== true) { bad.push(`${c.m} ${c.p} → ${r.status}`); continue; }
    try { if (!c.shape(r.json)) bad.push(`${c.name} 形状不符`); } catch (e) { bad.push(`${c.name} 形状异常 ${e.message}`); }
  }
  // push/pull/fetch 是写操作，仅验证端点可达且返回业务信封（含 success 字段）；
  // KS 业务拒绝（如落后需先 pull）返回 HTTP 400 + {success:false,error}，属正常结构化响应，不算失败
  for (const a of ['push', 'pull', 'fetch']) {
    const r = await ctx.http(ctx.bff, 'POST', '/api/git/' + a, { body: {} });
    if (!r.json || typeof r.json.success !== 'boolean') { bad.push(`POST /api/git/${a} 无结构化信封（status=${r.status}）`); }
  }
  if (bad.length) throw new Error('S2 真实联调异常: ' + bad.join(' | '));
  return { status: 'pass', detail: 'S2 经 BFF 代理真实联调通过（branches/log/diff 形状对；push/pull/fetch 端点可达）', evidence: 'KS §12 S2 端点经 BFF :4123 验证' };
}

module.exports = [
  { id: 'GIT1', name: 'Git 端点可达+信封(success,data)', group: 'GIT', severity: 'HIGH', async run(ctx) { return await gitEndpointsReachable(ctx); } },
  { id: 'GIT2', name: 'Mock 数据形状↔契约§1', group: 'GIT', severity: 'HIGH', async run(ctx) { return await gitMockShape(ctx); } },
  { id: 'GIT3', name: '前端字段↔契约一致(无token/remoteUrl/commitId)', group: 'GIT', severity: 'MEDIUM', async run(ctx) { return await gitFrontendContract(ctx); } },
  { id: 'GIT4', name: 'Git S2 经 BFF 真实联调(KS)', group: 'GIT', severity: 'HIGH', async run(ctx) { return await gitS2Real(ctx); } },
];
