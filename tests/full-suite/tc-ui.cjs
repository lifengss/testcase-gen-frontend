// UI 层测试（jsdom 真实渲染冒烟）：在 Node 内用 jsdom 加载 web/index.html + web/app.v2.js，
// 桩接 fetch 返回可控响应，验证：页面初始化无 JS 异常、导航结构、状态栏真实反映连通性、
// KS 不可达时 UI 锁定（不显示假项目卡）、AI 平台状态真实渲染、视图切换可用。
// 这是 DOM 级冒烟测试（非像素/视觉），覆盖「UI 层面」的核心交互与我们的连通性修复。
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web');
const INDEX = path.join(WEB, 'index.html');
const APP = path.join(WEB, 'app.v2.js');

function makeResponse(obj) {
  const text = JSON.stringify(obj);
  const buf = Buffer.from(text, 'utf-8');
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    json: async () => obj,
    text: async () => text,
  };
}

function stubFetch({ ksReachable = true, aiReachable = true } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/api/health')) {
      return makeResponse({
        status: 'ok', service: 'testcase-gen-frontend',
        ks: 'http://localhost:3000', ksReachable,
        ksStatus: ksReachable ? 200 : null,
        ksError: ksReachable ? null : 'ECONNREFUSED',
      });
    }
    if (u.includes('/api/ai-status')) {
      if (!aiReachable) {
        return makeResponse({ success: true, data: { provider: 'codebuddy', configured: true, reachable: false, label: '自定义端点不可达' } });
      }
      return makeResponse({ success: true, data: { provider: 'codebuddy', configured: true, reachable: true, label: 'CodeBuddy CLI 可达' } });
    }
    if (u.includes('/api/ai-cli/status')) {
      return makeResponse({ success: true, data: { provider: 'codebuddy', name: 'CodeBuddy CLI', installed: true, loggedIn: false, status: 'not_logged_in', message: '未登录' } });
    }
    if (u.includes('/api/settings')) {
      return makeResponse({ success: true, data: { ks: { apiBase: 'http://localhost:3000' }, ai: { provider: 'codebuddy', useCustomModel: false, model: 'hy3', endpoint: '', apiKey: '', maxTurns: 8 }, ui: { theme: 'dark' } } });
    }
    if (u.includes('/api/projects')) {
      return makeResponse({ success: true, data: { defaultProject: 'testCaseGenerator', sharedBrain: 'shared', projects: [{ id: 'testCaseGenerator', name: '测试用例生成器', description: 'demo', brainPath: 'brains/testCaseGenerator' }] } });
    }
    // 其它端点（context / drafts / brain/pages / backflow / scopes / stats ...）统一返回安全空结构
    return makeResponse({ success: true, data: { items: [], total: 0, nodes: [], edges: [], pages: [], drafts: [], scopes: [], context: {} } });
  };
}

async function runScenario(opts) {
  const html = fs.readFileSync(INDEX, 'utf8');
  const appSrc = fs.readFileSync(APP, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:4123/' });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String((e.error && e.error.stack) || e.message)));
  window.onerror = (msg, src, line, col, err) => { errors.push(String((err && err.stack) || msg)); };
  window.fetch = stubFetch(opts);
  if (!window.crypto) window.crypto = {};
  if (!window.crypto.randomUUID) window.crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  window.TextDecoder = window.TextDecoder || TextDecoder;
  window.URLSearchParams = window.URLSearchParams || URLSearchParams;
  const evalErr = [];
  try { window.eval(appSrc); } catch (e) { evalErr.push(String(e.stack || e)); }
  await new Promise((r) => setTimeout(r, 500)); // 等 init 异步完成
  return { window, errors: errors.concat(evalErr) };
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const EXPECTED_VIEWS = ['projects', 'generator', 'review', 'backflow', 'commit', 'graph', 'retest', 'tutorial'];

// UI1 初始化与导航结构（happy path：KS 可达）
async function uiInit(ctx) {
  const { window, errors } = await runScenario({ ksReachable: true, aiReachable: true });
  assert(errors.length === 0, '初始化存在 JS 异常: ' + errors.join(' | '));
  const navs = window.document.querySelectorAll('.nav-item[data-view]');
  assert(navs.length >= 8, `导航项数量不足(${navs.length})，期望>=8`);
  const views = Array.from(navs).map((n) => n.getAttribute('data-view'));
  for (const v of EXPECTED_VIEWS) {
    assert(views.includes(v), `缺少导航视图: ${v}`);
  }
  assert(!!window.document.getElementById('ksStat'), '缺少 #ksStat 状态栏');
  assert(!!window.document.getElementById('aiStat'), '缺少 #aiStat 状态栏');
  assert(!!window.document.getElementById('setAiProvider'), '系统设置缺少 #setAiProvider 表单字段');
  // happy path：项目应已加载（证明 loadProjects 跑通且未假锁）
  const projTabs = window.document.getElementById('projTabs');
  const tabCount = projTabs ? projTabs.children.length : 0;
  assert(tabCount >= 1, 'KS 可达时项目标签未渲染（#projTabs 为空）');
  const ksTxt = window.document.getElementById('ksStat').textContent;
  assert(ksTxt.includes('已连接'), `KS 可达时状态栏应显示「已连接」，实际: ${ksTxt}`);
  assert(!window.document.getElementById('ksBlock'), 'KS 可达时不应显示 #ksBlock 锁定层');
  return { status: 'pass', navCount: navs.length, projTabs: tabCount, ksTxt, detail: `导航项 ${navs.length} 个、项目标签 ${tabCount} 个、状态栏「${ksTxt.trim()}」`, evidence: 'init 无 JS 异常，结构完整' };
}

// UI2 AI 平台状态真实渲染（可达 vs 不可达）
async function uiAi(ctx) {
  const up = await runScenario({ ksReachable: true, aiReachable: true });
  const aiUp = up.window.document.getElementById('aiStat');
  const ledUp = aiUp.querySelector('.led');
  assert(aiUp.textContent.includes('可达'), `AI 可达时应显示「可达」，实际: ${aiUp.textContent}`);
  assert(!(ledUp && ledUp.classList.contains('off')), 'AI 可达时指示灯不应为 off');

  const down = await runScenario({ ksReachable: true, aiReachable: false });
  const aiDown = down.window.document.getElementById('aiStat');
  const ledDown = aiDown.querySelector('.led');
  assert(/不可达|未启用/.test(aiDown.textContent), `AI 不可达时应显示「不可达/未启用」，实际: ${aiDown.textContent}`);
  assert(ledDown && ledDown.classList.contains('off'), 'AI 不可达时指示灯应为 off');
  return { status: 'pass', aiUpTxt: aiUp.textContent.trim(), aiDownTxt: aiDown.textContent.trim(), detail: `可达态「${aiUp.textContent.trim()}」/不可达态「${aiDown.textContent.trim()}」`, evidence: 'AI 状态真实反映探测结果（非虚假「已连接」）' };
}

// UI3 KS 不可达时 UI 锁定（不显示假项目卡、显示锁定层、导航锁定、仅设置可开）
async function uiKsLock(ctx) {
  const { window } = await runScenario({ ksReachable: false, aiReachable: true });
  const ksTxt = window.document.getElementById('ksStat').textContent;
  assert(ksTxt.includes('未正确配置'), `KS 不可达时状态栏应显示「未正确配置」，实际: ${ksTxt}`);
  const block = window.document.getElementById('ksBlock');
  assert(!!block, 'KS 不可达时应显示 #ksBlock 锁定覆盖层');
  const projTabs = window.document.getElementById('projTabs');
  const tabCount = projTabs ? projTabs.children.length : 0;
  assert(tabCount === 0, 'KS 不可达时不应渲染项目标签（避免假项目卡）');
  const navs = Array.from(window.document.querySelectorAll('.nav-item'));
  const gear = window.document.getElementById('gearNav');
  const gearLocked = gear && gear.classList.contains('locked');
  assert(!gearLocked, '系统设置齿轮不应被锁定');
  const otherLocked = navs.filter((n) => n.id !== 'gearNav' && n.classList.contains('locked'));
  assert(otherLocked.length > 0, 'KS 不可达时其它导航项应被锁定(locked)');
  return { status: 'pass', ksTxt, lockedNavs: otherLocked.length, blockShown: !!block, detail: `状态栏「${ksTxt.trim()}」、锁定导航 ${otherLocked.length} 个、覆盖层=${!!block}`, evidence: 'KS 不可达时 UI 锁定、无假项目卡' };
}

// UI4 视图切换（点击导航项切换 active 视图）
async function uiNav(ctx) {
  const { window, errors } = await runScenario({ ksReachable: true, aiReachable: true });
  assert(errors.length === 0, '初始化异常: ' + errors.join(' | '));
  const gen = window.document.querySelector('.nav-item[data-view="generator"]');
  assert(!!gen, '缺少 generator 导航项');
  gen.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert(gen.classList.contains('active'), '点击 generator 导航项后应变为 active');
  const view = window.document.querySelector('.view[data-view="generator"]') || window.document.getElementById('view-generator');
  assert(!!view, '缺少 generator 对应视图容器');
  return { status: 'pass', active: gen.classList.contains('active'), detail: `点击 generator 后 active=${gen.classList.contains('active')}`, evidence: '视图切换可用' };
}

module.exports = [
  { id: 'UI1', name: 'UI 初始化与导航结构', group: 'UI', severity: 'HIGH', async run(ctx) { return await uiInit(ctx); } },
  { id: 'UI2', name: 'AI 平台状态真实渲染(可达/不可达)', group: 'UI', severity: 'HIGH', async run(ctx) { return await uiAi(ctx); } },
  { id: 'UI3', name: 'KS 不可达时 UI 锁定(无假项目卡)', group: 'UI', severity: 'HIGH', async run(ctx) { return await uiKsLock(ctx); } },
  { id: 'UI4', name: '导航视图切换', group: 'UI', severity: 'MEDIUM', async run(ctx) { return await uiNav(ctx); } },
];
