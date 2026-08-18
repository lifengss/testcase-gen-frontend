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
  return async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || (u.startsWith('POST') || u.startsWith('PUT') || u.startsWith('DELETE') ? u.split(' ')[0] : 'GET');
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
    if (u.includes('/api/git/config')) {
      if (String(method).toUpperCase() === 'PUT') {
        return makeResponse({ success: true, data: { initialized: true, remote: 'https://x/repo.git', branch: 'main', user: { name: 'M1', email: 'm1@x' } } });
      }
      return makeResponse({ success: true, data: { initialized: true, remote: 'https://x/repo.git', branch: 'main', user: { name: 'M1', email: 'm1@x' }, _mock: true } });
    }
    if (u.includes('/api/git/init')) {
      return makeResponse({ success: true, data: { initialized: true, branch: 'main', commitHash: null } });
    }
    if (u.includes('/api/git/commit')) {
      return makeResponse({ success: true, data: { commitHash: 'mockabc', message: 't', branch: 'main' } });
    }
    if (u.includes('/api/git/status')) {
      return makeResponse({ success: true, data: { initialized: true, branch: 'main', untracked: ['a.md'], modified: [], staged: [], conflicts: ['quality-rules/x.md'], hasConflict: true, ahead: 1, behind: 0, _mock: true } });
    }
    if (u.includes('/api/git/branches')) {
      return makeResponse({ success: true, data: { current: 'main', locals: ['main', 'dev'], remotes: ['origin/main'] } });
    }
    if (u.includes('/api/git/log')) {
      return makeResponse({ success: true, data: { branch: 'main', commits: [{ hash: 'abc', fullHash: 'abc123', author: 'a', email: 'a@x', date: '2026-08-16', message: 'init' }] } });
    }
    if (u.includes('/api/git/diff')) {
      return makeResponse({ success: true, data: { files: [{ path: 'a.md', additions: 2, deletions: 1, hunks: ['@@ -1,2 +1,3 @@'] }] } });
    }
    if (u.includes('/api/git/conflict-content')) {
      return makeResponse({ success: true, data: { path: 'quality-rules/x.md', filename: 'x.md', category: 'quality-rules', title: 'X', content: '<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs' } });
    }
    if (u.includes('/api/git/resolve-conflict')) {
      return makeResponse({ success: true, data: { path: 'quality-rules/x.md', strategy: 'ours' } });
    }
    if (u.includes('/api/git/switch-branch')) {
      return makeResponse({ success: true, data: { branch: 'dev', switched: true } });
    }
    if (u.includes('/api/git/push') || u.includes('/api/git/pull') || u.includes('/api/git/fetch')) {
      return makeResponse({ success: true, data: { success: true, branch: 'main', ahead: 0, behind: 0, output: 'ok' } });
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

// v2 导航：Git 协同为单一视图（配置并入「系统设置 → Git 协同」卡），另有 search 检索页
const EXPECTED_VIEWS = ['projects', 'generator', 'review', 'commit', 'search', 'graph', 'retest', 'git', 'tutorial'];

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

// UI5 Git 协同视图（M1 垂直构建·从 UI 触发）：点击导航加载 git-config/git-status，验证渲染与交互绑定
async function uiGit(ctx) {
  // 用可计数 fetch 桩，验证点击「保存配置」「提交」确实触发了 api 调用
  const calls = [];
  const baseStub = stubFetch({ ksReachable: true, aiReachable: true });
  const countingStub = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return baseStub(url, opts);
  };
  const html = fs.readFileSync(INDEX, 'utf8');
  const appSrc = fs.readFileSync(APP, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:4123/' });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String((e.error && e.error.stack) || e.message)));
  window.onerror = (msg, src, line, col, err) => { errors.push(String((err && err.stack) || msg)); };
  window.fetch = countingStub;
  if (!window.crypto) window.crypto = {};
  if (!window.crypto.randomUUID) window.crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  window.TextDecoder = window.TextDecoder || TextDecoder;
  window.URLSearchParams = window.URLSearchParams || URLSearchParams;
  const before = calls.length;
  try { window.eval(appSrc); } catch (e) { errors.push(String(e.stack || e)); }
  await new Promise((r) => setTimeout(r, 400));
  assert(errors.length === 0, '初始化异常: ' + errors.join(' | '));

  // 容器存在性：v2 为单一 #view-git 容器（配置并入「系统设置 → Git 协同」卡）
  assert(!!window.document.getElementById('view-git'), '缺少 #view-git 容器');
  assert(!!window.document.getElementById('gitStatusBox'), '缺少 #gitStatusBox');

  // 从 UI 点击 git 导航 → showGit → loadGitStatus + loadGitConflicts
  const gitNav = window.document.querySelector('.nav-item[data-view="git"]');
  assert(!!gitNav, '缺少 git 导航项');
  gitNav.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const stBox = window.document.getElementById('gitStatusBox');
  assert(!!stBox && /未跟踪/.test(stBox.innerHTML), 'git 视图未渲染文件状态');
  assert(/a\.md/.test(stBox.innerHTML), 'git 状态未渲染 Mock 未跟踪文件 a.md');

  // 配置表单在「系统设置 → Git 协同」卡：点击 #gitSettingsBtn 打开设置并定位 Git 卡
  const cfgBtn = window.document.getElementById('gitSettingsBtn');
  assert(!!cfgBtn, '缺少 #gitSettingsBtn 仓库配置按钮');
  cfgBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const remoteInp = window.document.getElementById('gitRemoteUrl');
  const branchInp = window.document.getElementById('gitBranch');
  assert(!!remoteInp && !!branchInp, 'git 配置卡缺 remote/branch 字段');
  assert(remoteInp.value.includes('https://'), 'git 配置卡未填充远端地址（loadGitConfig 未生效）');
  assert(branchInp.value === 'main', 'git 配置卡未填充分支（loadGitConfig 未生效）');

  // 点击「保存配置」→ 触发 PUT /api/git/config
  const saveCallsBefore = calls.filter((c) => c.url.includes('/api/git/config') && c.method === 'PUT').length;
  window.document.getElementById('gitSaveCfgBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const saveCallsAfter = calls.filter((c) => c.url.includes('/api/git/config') && c.method === 'PUT').length;
  assert(saveCallsAfter > saveCallsBefore, '点击「保存配置」未触发 PUT /api/git/config 请求');

  // 填提交说明 → 点击「提交」→ 触发 POST /api/git/commit
  const cm = window.document.getElementById('gitCommitMsg');
  if (cm) cm.value = 'M1 demo commit';
  const commitBefore = calls.filter((c) => c.url.includes('/api/git/commit') && c.method === 'POST').length;
  window.document.getElementById('gitCommitBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const commitAfter = calls.filter((c) => c.url.includes('/api/git/commit') && c.method === 'POST').length;
  assert(commitAfter > commitBefore, '填写提交说明后点击「提交」未触发 POST /api/git/commit');

  return { status: 'pass', detail: 'UI 触发 git 视图加载、配置卡填充与保存、提交均正常绑定并调用对应端点', evidence: `fetch 调用 ${calls.length - before} 次，含 PUT config / POST commit` };
}

// UI6 Git S2 功能（从 UI 触发）：状态页同步按钮 / 分支 / 冲突页解决
async function uiGitS2(ctx) {
  const baseStub = stubFetch({ ksReachable: true, aiReachable: true });
  const calls = [];
  const countingStub = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return baseStub(url, opts);
  };
  const html = fs.readFileSync(INDEX, 'utf8');
  const appSrc = fs.readFileSync(APP, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:4123/' });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String((e.error && e.error.stack) || e.message)));
  window.onerror = (msg, src, line, col, err) => { errors.push(String((err && err.stack) || msg)); };
  window.fetch = countingStub;
  if (!window.crypto) window.crypto = {};
  if (!window.crypto.randomUUID) window.crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  window.TextDecoder = window.TextDecoder || TextDecoder;
  window.URLSearchParams = window.URLSearchParams || URLSearchParams;
  const before = calls.length;
  try { window.eval(appSrc); } catch (e) { errors.push(String(e.stack || e)); }
  await new Promise((r) => setTimeout(r, 400));
  assert(errors.length === 0, '初始化异常: ' + errors.join(' | '));

  // 进入 git 视图，验证冲突块渲染（S2 status.hasConflict）——冲突处理整合在 git 页内
  window.document.querySelector('.nav-item[data-view="git"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const stBox = window.document.getElementById('gitStatusBox');
  assert(!!stBox && /合并冲突/.test(stBox.innerHTML), 'git 视图未渲染合并冲突块（S2 hasConflict）');

  // 点击同步按钮 → 触发 POST /api/git/push|pull|fetch
  for (const [btn, ep] of [['gitPushBtn', 'push'], ['gitPullBtn', 'pull'], ['gitFetchBtn', 'fetch']]) {
    const b = window.document.getElementById(btn);
    assert(!!b, `缺少 ${btn} 按钮`);
    const n = calls.filter((c) => c.url.includes('/api/git/' + ep) && c.method === 'POST').length;
    b.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const m = calls.filter((c) => c.url.includes('/api/git/' + ep) && c.method === 'POST').length;
    assert(m > n, `${btn} 未触发 POST /api/git/${ep}`);
  }

  // 分支按钮 → 加载 branches，点击本地分支触发 switch-branch
  window.document.getElementById('gitBranchesBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const brBox = window.document.getElementById('gitBranchesBox');
  assert(!!brBox && /本地分支/.test(brBox.innerHTML), '分支面板未渲染本地分支');
  const switchCallsBefore = calls.filter((c) => c.url.includes('/api/git/switch-branch')).length;
  const branchRow = brBox.querySelector('.git-branch-item[data-branch]');
  assert(!!branchRow, '分支列表无可选分支行');
  branchRow.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  assert(calls.filter((c) => c.url.includes('/api/git/switch-branch')).length > switchCallsBefore, '点击分支未触发 switch-branch');

  // 冲突处理在 git 页内：#gitConflictList（showGit 已加载）→ 打开内容 → 解决(ours)
  const cl = window.document.getElementById('gitConflictList');
  assert(!!cl, '缺少 #gitConflictList');
  const cRow = cl.querySelector('.git-file[data-conflict]');
  assert(!!cRow, '冲突列表无冲突文件行');
  cRow.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const ed = window.document.getElementById('gitConflictEditor');
  assert(!!ed && /git-conflict-edit/.test(ed.innerHTML), '冲突编辑器未渲染（textarea）');
  const resolveBefore = calls.filter((c) => c.url.includes('/api/git/resolve-conflict')).length;
  const oursBtn = ed.querySelector('button[data-str="ours"]');
  assert(!!oursBtn, '冲突编辑器缺 ours 解决按钮');
  oursBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  assert(calls.filter((c) => c.url.includes('/api/git/resolve-conflict')).length > resolveBefore, '点击 ours 未触发 resolve-conflict');

  return { status: 'pass', detail: 'UI 触发 Git S2：状态冲突块 / push·pull·fetch / 分支切换 / 冲突查看与解决均正常', evidence: `fetch 调用 ${calls.length - before} 次，覆盖 S2 全操作` };
}

module.exports = [
  { id: 'UI1', name: 'UI 初始化与导航结构', group: 'UI', severity: 'HIGH', async run(ctx) { return await uiInit(ctx); } },
  { id: 'UI2', name: 'AI 平台状态真实渲染(可达/不可达)', group: 'UI', severity: 'HIGH', async run(ctx) { return await uiAi(ctx); } },
  { id: 'UI3', name: 'KS 不可达时 UI 锁定(无假项目卡)', group: 'UI', severity: 'HIGH', async run(ctx) { return await uiKsLock(ctx); } },
  { id: 'UI4', name: '导航视图切换', group: 'UI', severity: 'MEDIUM', async run(ctx) { return await uiNav(ctx); } },
  { id: 'UI5', name: 'Git 视图从 UI 触发(加载/保存/提交)', group: 'UI', severity: 'HIGH', async run(ctx) { return await uiGit(ctx); } },
  { id: 'UI6', name: 'Git S2 从 UI 触发(冲突/同步/分支)', group: 'UI', severity: 'HIGH', async run(ctx) { return await uiGitS2(ctx); } },
];
