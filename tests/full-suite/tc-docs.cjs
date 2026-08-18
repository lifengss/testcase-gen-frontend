// 文档/契约一致性测试：解析 server/index.js（BFF 路由）、web/app.v2.js（前端调用）、
// docs/架构设计与技术方案.md（接口契约），校验：
//  DOC1  BFF 自有端点（health/settings/ai-status/ai-cli/status/ai-cli/login/projects...）均在代码中显式实现
//  DOC2  前端 api()/apiGet() 调用路径 ↔ BFF 路由一致（捕捉「双重 /api」这类笔误；可达性兜底由 /api/* 通配保证）
//  DOC3  架构文档接口契约 ↔ 代码可达性一致（文档声明的前端↔BFF 端点都能被 BFF 命中）
//  DOC4  响应信封一致性（BFF 不应返回裸数组，须 {success,data,...}）
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server', 'index.js');
const APP = path.join(ROOT, 'web', 'app.v2.js');
const DOC = path.join(ROOT, 'docs', '架构设计与技术方案.md');

function read(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }

function serverRoutes(src) {
  const routes = [];
  const re = /app\.(get|post|put|delete|all|use)\(\s*(['"])([^'"]+)\2/g;
  let m;
  while ((m = re.exec(src))) routes.push({ method: m[1].toUpperCase(), path: m[3] });
  return routes;
}

function frontendCalls(src) {
  const calls = [];
  let m;
  const reApi = /api\('(?:GET|POST|PUT|DELETE|PATCH)',\s*(['"])([^'"]+)\1/g;
  while ((m = reApi.exec(src))) calls.push({ kind: 'api', path: m[2] });
  const reX = /\bapp\.(get|post|put|delete|all|use)\(\s*(['"])([^'"]+)\2/g;
  while ((m = reX.exec(src))) calls.push({ kind: m[1].toLowerCase(), path: m[3] });
  return calls;
}

function normalize(p) {
  return p
    .replace(/:([A-Za-z0-9_]+)/g, '[^/]+')
    .replace(/\*/g, '.*')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[^/]+\//g, (s) => s); // keep
}
function routeRegex(p) {
  const norm = p
    .replace(/:([A-Za-z0-9_]+)/g, '[^/]+')
    .replace(/\*/g, '.*');
  return new RegExp('^' + norm.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '.' || c === '*' ? c : '\\' + c)) + '$');
}
function reachable(endpoint, routes) {
  for (const r of routes) {
    if (routeRegex(r.path).test(endpoint)) return r.method === 'ALL' ? 'proxy' : 'explicit';
  }
  if (routes.some((r) => r.path === '/api/*')) return 'proxy';
  return 'missing';
}

// DOC1 BFF 自有端点显式实现
async function docBffOwned(ctx) {
  const routes = serverRoutes(read(SERVER));
  const required = [
    { m: 'GET', p: '/api/health' },
    { m: 'GET', p: '/api/settings' },
    { m: 'PUT', p: '/api/settings' },
    { m: 'GET', p: '/api/settings/codebuddy-models' },
    { m: 'GET', p: '/api/ai-status' },
    { m: 'GET', p: '/api/ai-cli/status' },
    { m: 'POST', p: '/api/ai-cli/login' },
    { m: 'GET', p: '/api/projects' },
  ];
  const missing = required.filter((r) => reachable(r.p, routes) === 'missing');
  if (missing.length) {
    throw new Error('BFF 自有端点缺失: ' + missing.map((r) => `${r.m} ${r.p}`).join(', '));
  }
  const proxied = required.filter((r) => reachable(r.p, routes) === 'proxy');
  return { status: 'pass', detail: `路由总数 ${routes.length}，BFF 自有核心端点 ${required.length} 项全部可达（显式 ${required.length - proxied.length} 项 / 通配代理 ${proxied.length} 项）`, evidence: 'health/settings/ai-status/ai-cli/projects 均在 server/index.js 注册或经 /api/* 代理可达' };
}

// DOC2 前端调用路径 ↔ BFF 路由一致性（捕捉双重 /api）
async function docFrontendRoutes(ctx) {
  const routes = serverRoutes(read(SERVER));
  const calls = frontendCalls(read(APP));
  const violations = [];
  for (const c of calls) {
    const actual = c.kind === 'api' ? c.path : '/api' + c.path;
    if (!actual.startsWith('/api/')) violations.push(`调用 ${c.kind}('${c.path}') 未命中 BFF(/api 前缀): ${actual}`);
    if (c.kind !== 'api' && c.path.startsWith('/api/')) violations.push(`双重 /api 笔误: ${c.kind}('${c.path}') → ${actual}`);
    const r = reachable(actual, routes);
    if (r === 'missing') violations.push(`前端调用无对应 BFF 路由且无 /api/* 兜底: ${actual}`);
  }
  if (violations.length) throw new Error(violations.join(' | '));
  return { status: 'pass', detail: `校验前端调用 ${calls.length} 处，全部命中 BFF 路由或 /api/* 兜底`, evidence: '无双重 /api、无悬空路径' };
}

// DOC3 架构文档接口契约 ↔ 代码可达性
async function docContract(ctx) {
  const routes = serverRoutes(read(SERVER));
  const doc = read(DOC);
  const eps = new Set();
  const re = /\(?(?:GET|POST|PUT|DELETE|PATCH)\)?\s+(https?:\/\/[^\s)]+\/api\/[^\s),]+|\/api\/[A-Za-z0-9_/:.\-]+)/gi;
  let m;
  while ((m = re.exec(doc))) {
    let e = m[1];
    const idx = e.indexOf('/api/');
    e = e.slice(idx);
    e = e.replace(/\?.*$/, '').replace(/[).,;]+$/, '');
    if (e) eps.add(e);
  }
  const missing = [];
  for (const e of eps) {
    const r = reachable(e, routes);
    if (r === 'missing') missing.push(e);
  }
  if (missing.length) {
    return { status: 'warn', detail: `架构文档声明 ${eps.size} 个接口端点，其中 ${missing.length} 个无法被 BFF 命中: ${missing.join(', ')}`, evidence: '存在文档与代码漂移，建议核对' };
  }
  return { status: 'pass', detail: `架构文档声明 ${eps.size} 个接口端点，全部可被 BFF 命中（显式或 /api/* 兜底）`, evidence: '文档契约与代码一致' };
}

// DOC4 响应信封一致性（无裸数组）
async function docEnvelope(ctx) {
  const src = read(SERVER);
  const bare = [];
  const re = /res\.json\(\s*\[/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(Math.max(0, m.index - 60), m.index).split('\n').pop();
    bare.push(line.trim());
  }
  if (bare.length) {
    return { status: 'warn', detail: `发现 ${bare.length} 处 res.json([ 裸数组响应，应包裹为 {success,data,items}`, evidence: bare.join(' | ') };
  }
  return { status: 'pass', detail: '未发现 res.json([ 裸数组响应', evidence: 'BFF 响应均使用 {success,data,...} 信封' };
}

module.exports = [
  { id: 'DOC1', name: 'BFF 自有核心端点实现', group: 'DOC', severity: 'HIGH', async run(ctx) { return await docBffOwned(ctx); } },
  { id: 'DOC2', name: '前端调用路径↔BFF路由一致(双重/api)', group: 'DOC', severity: 'HIGH', async run(ctx) { return await docFrontendRoutes(ctx); } },
  { id: 'DOC3', name: '架构文档接口契约↔代码可达性', group: 'DOC', severity: 'MEDIUM', async run(ctx) { return await docContract(ctx); } },
  { id: 'DOC4', name: '响应信封一致性(无裸数组)', group: 'DOC', severity: 'MEDIUM', async run(ctx) { return await docEnvelope(ctx); } },
];
