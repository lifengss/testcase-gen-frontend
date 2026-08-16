/* TestGen 前端业务逻辑 · 真实调用 BFF（testcase-gen-frontend/server） */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = { project: localStorage.getItem('tg_currentProject') || '', lastGenerated: '', scopeTree: [], funcTree: [] };
const LS_KEY = 'tg_currentProject';
let scopeMode = 'code';       // 'code' = 按业务模块（源自业务流依赖图谱）；'func' = 按功能模块
let funcAvailable = false;    // 是否已上传 PRD/需求列表，可抽取功能模块
// 测试范围（业务模块）勾选/展开状态
let explicit = new Set();
let expandedSet = new Set();
// 测试范围（功能模块）勾选/展开状态
let explicitFunc = new Set();
let expandedFunc = new Set();

function toast(msg, type = '') {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + type;
  setTimeout(() => (t.className = 'toast ' + type), 2600);
}
let defaultProject = 'default';
function pickProject() { return state.project || defaultProject; }

// ---- API 封装：自动注入当前 project ----
async function api(method, path, { query = {}, body, form } = {}) {
  const q = { ...query };
  if (!q.project && (method === 'GET')) q.project = pickProject();
  let url = path;
  if (Object.keys(q).length) url += '?' + new URLSearchParams(q).toString();
  const opts = { method, headers: {} };
  if (form) { opts.body = form; }
  else if (body) {
    const b = { ...body }; if (!b.project) b.project = pickProject();
    opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(b);
  }
  const r = await fetch(url, opts);
  // 强制按 UTF-8 解码响应字节：避免浏览器在「自动检测编码」下把正确的 UTF-8 当成 GBK 解码，
  // 导致中文显示为閿涳拷 这类乱码（mojibake）。源数据（BFF/KS）均为 UTF-8。
  const buf = await r.arrayBuffer();
  const text = new TextDecoder('utf-8').decode(buf);
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}

// 顶部状态芯片
// userChip：部署形态 / 用户身份。当前为单用户本地版（无鉴权），_user 留空 → 显示“单用户”占位；
//           V2 接入认证后由登录态填充用户名，本芯片即作为“当前用户”指示，不再是无意义的静态绿点。
let _user = '';
let _ksBase = '';
let summaryPid = '';
function renderUserChip() {
  const el = document.getElementById('userChip');
  if (!el) return;
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>本地 · ${_user || '单用户'}`;
}
// ksChip 已移除：连通性由底部状态栏 #ksStat 实测负责，顶部不再重复显示后端地址芯片。

// ---- 项目 ----
async function loadProjects() {
  // 真实连通检测（最先执行）：探测知识系统(KS)真实可达性。
  // 错误端口/地址时不应展示项目数据卡，也不应显示「已连接」。
  const ks = await api('GET', '/api/health');
  const ksOk = !!(ks.data && ks.data.ksReachable);
  state.ksOk = ksOk;
  $('#ksStat').innerHTML = `<span class="led${ksOk ? '' : ' off'}"></span>知识系统 ${ksOk ? '已连接' : '未正确配置'}`;
  applyKsLock();
  if (!ksOk) {
    // 知识库未连接：锁定功能入口，主区显示配置提示，仅「系统设置」可打开
    showKsBlock((ks.data && ks.data.ksError) || '');
    renderUserChip(); updateAiStatus();
    return;
  }
  hideKsBlock();

  const { data } = await api('GET', '/api/projects');
  const list = (data && data.data && data.data.projects) || [];
  const menu = $('#psMenu'); menu.innerHTML = '';
  list.forEach(p => {
    const el = document.createElement('div');
    el.className = 'ps-item' + (p.id === state.project ? ' on' : '');
    el.innerHTML = `<div class="t">${p.name}</div><div class="m">${p.id} · ${p.brainPath}</div>`;
    el.onclick = () => setProject(p.id, p.name);
    menu.appendChild(el);
  });
  // 始终同步当前项目（修复：刷新后 state.project 已预置，原逻辑仅在未命中时才调用 setProject，
  // 导致顶部项目提示栏 #psName 一直停在「加载中…」，而页面内容其实已载入）
  const cur = (state.project && list.find(p => p.id === state.project)) || list.find(p => p.id === 'testCaseGenerator') || list[0];
  if (cur) setProject(cur.id, cur.name);

  // 项目空间：标签 + 测试概要仪表盘
  window.__projects = list;
  if (!summaryPid) summaryPid = (state.project && list.some(p => p.id === state.project)) ? state.project : (list[0] && list[0].id);
  renderProjTabs();
  renderUserChip();
  updateAiStatus();
}

// 知识库未正确连接时：锁定侧栏功能入口（「系统设置」齿轮除外），仅保留设置可点
function applyKsLock() {
  $$('.nav-item').forEach(n => { if (n.id === 'gearNav') return; n.classList.toggle('locked', !state.ksOk); });
}
// 主区域覆盖层：提示用户先到系统设置修正知识库地址
function showKsBlock(err) {
  let el = document.getElementById('ksBlock');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ksBlock';
    el.className = 'ks-block';
    el.innerHTML = `<div class="ks-block-card">
      <div class="ks-block-icon">⚠</div>
      <h2>知识库未正确连接</h2>
      <p>当前配置的知识库地址不可达（端口或地址错误）。工作台功能已暂时锁定，请先在「系统设置」中填写正确的知识库地址（默认 <code>http://localhost:3000</code>）并测试连接。</p>
      <p class="ks-block-err"></p>
      <button class="btn btn-primary" id="ksBlockGo">前往系统设置</button>
    </div>`;
    const main = document.querySelector('.main');
    if (main) main.appendChild(el);
    const go = document.getElementById('ksBlockGo');
    if (go) go.onclick = () => { if (typeof openSettings === 'function') openSettings(); };
  }
  const errEl = el.querySelector('.ks-block-err');
  if (errEl) errEl.textContent = err ? ('探测详情：' + err) : '';
  el.style.display = 'flex';
}
function hideKsBlock() {
  const el = document.getElementById('ksBlock');
  if (el) el.style.display = 'none';
}
// AI 平台真实连通状态：调用 BFF /api/ai-status（探测 codebuddy CLI / openai endpoint），联动状态栏指示灯
async function updateAiStatus() {
  const el = document.getElementById('aiStat'); if (!el) return;
  const led = el.querySelector('.led');
  const setText = (txt) => {
    el.childNodes.forEach(n => { if (n.nodeType === 3) n.nodeValue = ''; });
    el.appendChild(document.createTextNode(txt));
  };
  try {
    const r = await api('GET', '/api/ai-status');
    const s = (r.data && r.data.data) || {};
    if (led) { led.classList.remove('off'); if (!s.reachable) led.classList.add('off'); }
    setText(' ' + (s.label ? ('AI 平台 · ' + s.label) : 'AI 平台'));
  } catch (e) {
    if (led) led.classList.add('off');
    setText(' AI 平台 · 检测失败');
  }
}
function setProject(id, name) {
  state.project = id; localStorage.setItem(LS_KEY, id);
  const p = (window.__projects || []).find(x => x.id === id);
  $('#psName').textContent = name || id; $('#psId').textContent = id;
  $('#sidePid').textContent = id; $('#footProj').textContent = '本地多项目 · 知识闭环 V1.0 · ' + id;
  $$('.ps-item').forEach(x => x.classList.toggle('on', x.querySelector('.m').textContent.startsWith(id)));
  summaryPid = id; renderProjTabs(); showProjectSummary(id);
  loadContext(); loadReview(); loadCommit(); loadBackflow(); loadScopes();
}

// 项目空间：标签栏（独立预览，点击仅展示该项目测试概要，不切换工作项目）
function renderProjTabs() {
  const tabs = $('#projTabs'); if (!tabs) return;
  const list = window.__projects || [];
  tabs.innerHTML = '';
  list.forEach(p => {
    const t = document.createElement('button');
    t.className = 'ptab' + (p.id === summaryPid ? ' on' : '');
    t.innerHTML = `<span class="ptab-name">${escapeHtml(p.name)}</span><span class="ptab-id">${escapeHtml(p.id)}</span>`;
    t.onclick = () => { summaryPid = p.id; renderProjTabs(); showProjectSummary(p.id); };
    tabs.appendChild(t);
  });
}
// 项目测试概要：需求数（project-wiki 中 uploadType=prd/requirement）、测试用例数、自动化脚本数、
// 质量规则数、缺陷经验数、知识页数；自动化覆盖率（分子=被脚本覆盖的用例数）为 V2 功能，本期显示「暂无数据」。
async function showProjectSummary(pid) {
  const box = $('#projSummary'); if (!box) return;
  box.innerHTML = '<div class="ps-loading">加载测试概要…</div>';
  const proj = (window.__projects || []).find(p => p.id === pid) || {};
  try {
    const [statsR, pagesR] = await Promise.all([
      api('GET', '/api/brain/stats', { query: { project: pid } }),
      api('GET', '/api/brain/pages', { query: { category: 'project-wiki', project: pid, limit: 1000 } })
    ]);
    const sb = (statsR && statsR.data) || {};
    const cats = sb.data || {};
    const cnt = (k) => (cats[k] && cats[k].count) || 0;
    const testCases = cnt('test-cases');
    const testScripts = cnt('test-scripts');
    const qualityRules = cnt('quality-rules');
    const defects = cnt('defect-experience');
    const wikiTotal = cnt('project-wiki');
    const pb = (pagesR && pagesR.data) || {};
    const pages = Array.isArray(pb.data) ? pb.data : [];
    const reqCount = pages.filter(p => { const ut = p.frontmatter && p.frontmatter.uploadType; return ut === 'prd' || ut === 'requirement'; }).length;
    // 自动化覆盖率：分子=被自动化脚本覆盖的测试用例数（V2 统计功能，本期无此数据）
    box.innerHTML = summaryHtml({ proj, reqCount, testCases, testScripts, qualityRules, defects, wikiTotal, coverage: '暂无数据' });
  } catch (e) {
    box.innerHTML = '<div class="ps-empty">暂无数据</div>';
  }
}
function summaryHtml(m) {
  const proj = m.proj || {};
  const tile = (label, value, sub, muted) => `
    <div class="stat-tile">
      <div class="stat-label">${label}</div>
      <div class="stat-value${muted ? ' muted' : ''}">${value}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
    </div>`;
  return `
    <div class="ps-meta">
      <div class="ps-title">${escapeHtml(proj.name || '—')}</div>
      <div class="ps-desc">${escapeHtml(proj.description || '暂无项目描述')}</div>
      <div class="ps-path">${escapeHtml(proj.brainPath || '')}</div>
    </div>
    <div class="stat-grid">
      ${tile('需求数', m.reqCount, 'PRD / 需求列表')}
      ${tile('测试用例数', m.testCases, 'test-cases')}
      ${tile('自动化脚本数', m.testScripts, 'test-scripts')}
      ${tile('自动化测试覆盖率', m.coverage, '覆盖用例 / 总用例 · V2 待接入', true)}
      ${tile('质量规则数', m.qualityRules, 'quality-rules')}
      ${tile('缺陷经验数', m.defects, 'defect-experience')}
      ${tile('知识页数', m.wikiTotal, 'project-wiki')}
    </div>`;
}

// ---- 导航 ----
$$('.nav-item').forEach(n => n.onclick = () => {
  // 知识库未正确连接时，锁定所有功能入口（系统设置齿轮除外）；点击其他入口提示并打开设置
  if (!state.ksOk && n.id !== 'gearNav') { toast('请先在系统设置中正确配置知识库', 'err'); if (typeof openSettings === 'function') openSettings(); return; }
  const view = n.dataset.view;
  $$('.nav-item').forEach(x => x.classList.remove('active'));
  $$('.view').forEach(v => v.classList.remove('active'));
  n.classList.add('active');
  if (view) { const tgt = $('#view-' + view); if (tgt) tgt.classList.add('active'); }
  if (view === 'graph') loadGraph();
  if (view === 'retest') loadRetest();
  if (view === 'git-config') loadGitConfig();
  if (view === 'git-status') loadGitStatus();
  if (view === 'tutorial') loadTutorial();
});
$('#psBtn').onclick = e => { e.stopPropagation(); $('#psMenu').classList.toggle('open'); };
document.addEventListener('click', () => $('#psMenu').classList.remove('open'));

// ---- 使用教程（版本化：大版本随系统，小版本独立） ----
let tutState = { manifest: null };
async function loadTutorial() {
  try {
    if (!tutState.manifest) {
      const res = await fetch('tutorial/manifest.json');
      if (!res.ok) throw new Error('manifest 加载失败 (' + res.status + ')');
      tutState.manifest = await res.json();
    }
    const m = tutState.manifest;
    const verEl = $('#tutVersion');
    if (verEl) verEl.textContent = `${m.title} · 教程 v${m.version}（随系统 v${m.systemVersion}）· 更新于 ${m.updatedAt}`;
    renderTutToc(m);
    openTutChapter(m.chapters[0] && m.chapters[0].id);
  } catch (e) {
    const c = $('#tutContent'); if (c) c.innerHTML = `<div class="ps-empty">教程加载失败：${escapeHtml(e.message)}</div>`;
  }
}
function renderTutToc(m) {
  const toc = $('#tutToc'); if (!toc) return;
  let html = '';
  m.chapters.forEach((ch, i) => {
    html += `<div class="tut-toc-h">第 ${i} 章</div>`;
    html += `<a data-ch="${ch.id}"><span class="n">${i}</span>${escapeHtml(ch.title)}</a>`;
  });
  toc.innerHTML = html;
  $$('#tutToc a').forEach(a => a.onclick = () => openTutChapter(a.dataset.ch));
}
async function openTutChapter(id) {
  const m = tutState.manifest; if (!m) return;
  const idx = m.chapters.findIndex(c => c.id === id);
  const ch = m.chapters[idx];
  $$('#tutToc a').forEach(a => a.classList.toggle('on', a.dataset.ch === id));
  const content = $('#tutContent');
  content.innerHTML = '<div class="ps-loading">正在加载…</div>';
  try {
    const res = await fetch(`tutorial/chapters/${id}.md`);
    if (!res.ok) throw new Error('章节加载失败 (' + res.status + ')');
    const md = await res.text();
    const body = renderTutorialMarkdown(md);
    const prev = idx > 0 ? m.chapters[idx - 1] : null;
    const next = idx < m.chapters.length - 1 ? m.chapters[idx + 1] : null;
    content.innerHTML = `<div class="md">${body}</div>` +
      `<div class="tut-nav">` +
      (prev ? `<a class="btn ghost" data-ch="${prev.id}">← ${escapeHtml(prev.title)}</a>` : `<span></span>`) +
      (next ? `<a class="btn ghost" data-ch="${next.id}">${escapeHtml(next.title)} →</a>` : `<span></span>`) +
      `</div>` +
      `<div class="tut-ver">教程 v${m.version} · 系统 v${m.systemVersion} · 更新于 ${m.updatedAt}</div>`;
    $$('#tutContent [data-ch]').forEach(a => a.onclick = () => openTutChapter(a.dataset.ch));
  } catch (e) {
    content.innerHTML = `<div class="ps-empty">${escapeHtml(e.message)}</div>`;
  }
}
// 教程 Markdown 渲染：在共享 renderMarkdown 之上单独处理图片 ![](url)，避免与链接混淆、并被 HTML 转义
function renderTutorialMarkdown(src) {
  const IMG = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;
  let out = '', last = 0, mt;
  while ((mt = IMG.exec(src)) !== null) {
    if (mt.index > last) out += renderMarkdown(src.slice(last, mt.index));
    const alt = mt[1], url = mt[2], cap = mt[3] || '';
    out += `<img class="tut-img" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"/>` + (cap ? `<div class="tut-cap">${escapeHtml(cap)}</div>` : '');
    last = IMG.lastIndex;
  }
  if (last < src.length) out += renderMarkdown(src.slice(last));
  return out;
}

// ---- 生成配置交互 ----
function bindSeg(id){ $$(`#${id} button`).forEach(b => b.onclick = () => { $$(`#${id} button`).forEach(x=>x.classList.remove('on')); b.classList.add('on'); }); }
bindSeg('genSeg'); bindSeg('depthSeg');
// 测试范围「全选」复选框（默认选中；取消则清空所有模块）
const selAllChk = $('#scopeSelectAll');
if (selAllChk) selAllChk.onchange = () => setScopeSelectAll(selAllChk.checked);
// 测试范围标签页：按代码模块 / 按功能模块
$$('#scopeTabs button').forEach(b => b.onclick = () => onScopeTab(b.dataset.t, b));
// 测试范围模块树：从业务流依赖图谱按业务域派生（业务模块）/ 从项目描述 Wiki 抽取（功能模块），可展开复选
async function loadScopes() {
  explicit = new Set(); expandedSet = new Set();
  const bg = await api('GET', '/api/business-graph');
  const g = (bg.data && bg.data.data) || { nodes: [], edges: [], domains: [] };
  const domains = g.domains || [];
  const domainName = id => (domains.find(d => d.id === id) || {}).name || id;
  const byDomain = {};
  (g.nodes || []).forEach(n => { const d = n.domain || 'DEFAULT'; (byDomain[d] = byDomain[d] || []).push(n); });
  let tree = Object.keys(byDomain).map(d => ({
    id: 'dom:' + d, label: domainName(d), type: 'domain',
    children: byDomain[d].map(n => ({ id: n.id, label: n.title || n.api || n.id, type: 'node' }))
  }));
  // 新项目（尚未生成业务图谱）无业务模块，保持空列表，不注入 Demo 示例模块以免误导
  if (!tree.length) tree = [];
  state.scopeTree = tree;
  setScopeSelectAll(true); // 默认全选：让 explicit 真正装入全部模块 id，且全选勾选框与数据层对齐
  loadWikiModules(); // 并行抽取功能模块
}
function isChecked(node, exp) { return node.children && node.children.length ? exp.has(node.id) || node.children.some(c => isChecked(c, exp)) : exp.has(node.id); }
function markAll(node, v, exp) { if (v) exp.add(node.id); else exp.delete(node.id); if (node.children) node.children.forEach(c => markAll(c, v, exp)); }
function onScopeToggle(node, check, exp) {
  markAll(node, check, exp); // 勾选父级联动所有子级；取消同理
  syncSelectAllChk();        // 同步「全选」复选框状态
  renderActiveScope();       // 子级联动父级由 isChecked 计算自动体现
}
// 同步「全选」复选框：代码模块与功能模块均被全选时才勾选
function syncSelectAllChk() {
  const chk = $('#scopeSelectAll'); if (!chk) return;
  const allCode = state.scopeTree.length === 0 || state.scopeTree.every(n => isChecked(n, explicit));
  const allFunc = state.funcTree.length === 0 || state.funcTree.every(n => isChecked(n, explicitFunc));
  chk.checked = allCode && allFunc;
}
// 一键全选 / 全不选
function setScopeSelectAll(on) {
  state.scopeTree.forEach(n => markAll(n, on, explicit));
  state.funcTree.forEach(n => markAll(n, on, explicitFunc));
  syncSelectAllChk(); // 全选/全不选后同步勾选框，保证「全选勾选框」与 explicit 数据层一致
  renderScopeTree(); renderFuncTree();
}
function renderActiveScope() { if (scopeMode === 'func') renderFuncTree(); else renderScopeTree(); }
function renderScopeNode(node, exp, expd, onToggle) {
  const wrap = document.createElement('div'); wrap.className = 'st-node';
  const row = document.createElement('div'); row.className = 'st-row';
  const hasKids = !!(node.children && node.children.length);
  const caret = document.createElement('span'); caret.className = 'st-caret' + (hasKids ? '' : ' st-leaf');
  caret.textContent = '▶';
  const box = document.createElement('input'); box.type = 'checkbox'; box.className = 'st-chk';
  box.checked = isChecked(node, exp);
  box.onchange = () => onToggle(node, box.checked);
  const label = document.createElement('span'); label.className = 'st-label'; label.textContent = node.label;
  label.onclick = () => { box.checked = !box.checked; onToggle(node, box.checked); };
  caret.onclick = () => {
    if (!hasKids) return;
    if (expd.has(node.id)) expd.delete(node.id); else expd.add(node.id);
    caret.classList.toggle('open'); kids.classList.toggle('open');
  };
  row.appendChild(caret); row.appendChild(box); row.appendChild(label);
  wrap.appendChild(row);
  let kids;
  if (hasKids) {
    kids = document.createElement('div'); kids.className = 'st-children' + (expd.has(node.id) ? ' open' : '');
    if (expd.has(node.id)) caret.classList.add('open');
    node.children.forEach(c => kids.appendChild(renderScopeNode(c, exp, expd, onToggle)));
    wrap.appendChild(kids);
  }
  return wrap;
}
function renderScopeTree() {
  const root = $('#scopeTree');
  root.innerHTML = '';
  if (!state.scopeTree.length) { root.innerHTML = '<div class="scope-hint">暂无业务模块，请先在「知识图谱」页生成业务流依赖图谱（上传 PRD/需求/API 文档后点击「生成业务图谱」）</div>'; return; }
  state.scopeTree.forEach(n => root.appendChild(renderScopeNode(n, explicit, expandedSet, (nd, c) => onScopeToggle(nd, c, explicit))));
}
function renderFuncTree() {
  const root = $('#funcTree');
  if (!root) return;
  root.innerHTML = '';
  if (!state.funcTree.length) { root.innerHTML = '<div class="scope-hint">请先上传 PRD 或需求列表</div>'; return; }
  state.funcTree.forEach(n => root.appendChild(renderScopeNode(n, explicitFunc, expandedFunc, (nd, c) => onScopeToggle(nd, c, explicitFunc))));
}
// 从项目描述 Wiki 抽取功能模块（需求列表优先，其次 PRD）；两者皆无则禁用「按功能模块」标签
async function loadWikiModules() {
  try {
    const r = await api('GET', '/api/wiki-modules');
    const d = r.data && r.data.data;
    if (r.ok && d && d.available && d.modules && d.modules.length) {
      state.funcTree = d.modules.map(m => ({ id: m.id, label: m.label, type: 'func', children: [] }));
      state.funcTree.forEach(n => markAll(n, true, explicitFunc));
      funcAvailable = true;
    } else { state.funcTree = []; funcAvailable = false; }
  } catch (_) { state.funcTree = []; funcAvailable = false; }
  updateScopeTabs();
  renderFuncTree();
}
function updateScopeTabs() {
  const btn = $('#scopeTabs button[data-t="func"]');
  if (btn) btn.classList.toggle('disabled', !funcAvailable);
}
function onScopeTab(t, btn) {
  if (t === 'func' && !funcAvailable) { toast('请先上传 PRD 或需求列表以抽取功能模块', 'err'); return; }
  scopeMode = t;
  $$('#scopeTabs button').forEach(x => x.classList.toggle('on', x === btn));
  $('#scopeTree').style.display = t === 'code' ? '' : 'none';
  $('#funcTree').style.display = t === 'func' ? '' : 'none';
}
function collectModules() {
  return state.scopeTree
    .filter(m => explicit.has(m.id) || (m.children && m.children.some(c => explicit.has(c.id))))
    .map(m => m.label);
}
function collectFuncModules() {
  return state.funcTree.filter(m => explicitFunc.has(m.id)).map(m => m.label);
}

// ---- 知识上下文（生成中心侧栏）----
async function loadContext() {
  // 知识库页面统计（按 brain 分类）：历史用例=test-cases，自动化脚本=test-scripts，二者分别计数
  const stats = await api('GET', '/api/brain/stats');
  // api() 把 JSON 体放在 stats.data；KS 体为 {success:true, data:{分类:{count}}}，故真实分类在 stats.data.data
  const st = (stats && stats.data && stats.data.data) || {};
  $('#ctxTC').textContent = (st['test-cases'] && st['test-cases'].count) || 0;
  $('#ctxSC').textContent = (st['test-scripts'] && st['test-scripts'].count) || 0;
  const bg = await api('GET', '/api/business-graph');
  const graph = normalizeGraph((bg.data && bg.data.data) || null);
  $('#ctxND').textContent = (graph.nodes || []).length;
  const refs = $('#ctxRefs'); refs.innerHTML = '<div class="ref muted">提交生成后展示检索命中</div>';
  renderMiniGraph(graph);
}
// 把检索命中渲染进侧栏「命中参考」，按 kind 分组（history/rule/wiki/dep）
function renderHits(hits) {
  const box = $('#ctxRefs'); if (!box) return;
  box.innerHTML = '';
  if (!hits || !hits.length) { box.innerHTML = '<div class="ref muted">本次检索无命中</div>'; return; }
  const labels = { history: '历史用例', rule: '质量门禁', wiki: '项目Wiki', dep: 'API文档', entity: 'GBrain实体' };
  const groups = {};
  hits.forEach(h => { (groups[h.kind] = groups[h.kind] || []).push(h); });
  Object.keys(labels).forEach(k => {
    const arr = groups[k]; if (!arr || !arr.length) return;
    const g = document.createElement('div'); g.className = 'ref-group'; g.textContent = labels[k] + '（' + arr.length + '）';
    box.appendChild(g);
    arr.forEach(h => {
      const d = document.createElement('div'); d.className = 'ref';
      d.innerHTML = `<b>${labels[k][0]}</b> · ${h.title} <span class="score">${h.score}</span>`;
      box.appendChild(d);
    });
  });
}
function renderMiniGraph(graph) {
  const c = $('#miniGraph'); if (!c) return;
  c.innerHTML = renderGraphSVG(graph, 280, 200);
}
function runForceLayout(nodes, edges, W, H) {
  // 与知识图谱页一致的力导向收敛布局（迭代结束时的快照），供 mini 图与全量图复用
  const work = nodes.map(n => ({ id: n.id, r: n.r || 12, x: 0, y: 0, vx: 0, vy: 0 }));
  const idx = new Map(); work.forEach(n => idx.set(n.id, n));
  // 确定性初始位置（基于 id 哈希的伪随机），保证同一图谱每次布局一致、可复现
  work.forEach(n => {
    let h = 2166136261 >>> 0;
    for (const ch of String(n.id)) h = (Math.imul(h, 16777619) ^ ch.charCodeAt(0)) >>> 0;
    const rng = () => { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return h / 4294967295; };
    const angle = rng() * 2 * Math.PI;
    const radius = Math.min(W, H) * 0.4 * Math.sqrt(rng());
    n.x = W / 2 + radius * Math.cos(angle);
    n.y = H / 2 + radius * Math.sin(angle);
  });
  const degree = new Map(); work.forEach(n => degree.set(n.id, 0));
  (edges || []).forEach(e => {
    if (idx.has(e.source)) degree.set(e.source, degree.get(e.source) + 1);
    if (idx.has(e.target)) degree.set(e.target, degree.get(e.target) + 1);
  });
  const temperature0 = 80, cooling = 0.97, repulsionCutoff = 200, baseRepulsion = 600, totalIter = 500, stepsPerFrame = 6;
  let temperature = temperature0, iter = 0;
  while (iter < totalIter) {
    for (let s = 0; s < stepsPerFrame && iter < totalIter; s++, iter++) {
      for (let a = 0; a < work.length; a++) {
        for (let b = a + 1; b < work.length; b++) {
          const na = work[a], nb = work[b];
          let dx = na.x - nb.x, dy = na.y - nb.y;
          let dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
          if (dist >= repulsionCutoff) continue;
          const decay = 1 - dist / repulsionCutoff;
          const degFactor = 1 / Math.sqrt((degree.get(na.id) || 1) + (degree.get(nb.id) || 1));
          const force = baseRepulsion * decay * decay * degFactor;
          const fx = (dx / dist) * force, fy = (dy / dist) * force;
          na.vx += fx; na.vy += fy; nb.vx -= fx; nb.vy -= fy;
        }
      }
      for (const e of edges) {
        const na = idx.get(e.source), nb = idx.get(e.target);
        if (!na || !nb) continue;
        let dx = nb.x - na.x, dy = nb.y - na.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
        const force = (dist - 100) * 0.01;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        na.vx += fx; na.vy += fy; nb.vx -= fx; nb.vy -= fy;
      }
      for (let a = 0; a < work.length; a++) {
        for (let b = a + 1; b < work.length; b++) {
          const na = work[a], nb = work[b];
          let dx = nb.x - na.x, dy = nb.y - na.y;
          let dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
          const minDist = na.r + nb.r + 6;
          if (dist < minDist) {
            const overlap = minDist - dist;
            const fx = (dx / dist) * overlap * 0.35, fy = (dy / dist) * overlap * 0.35;
            na.vx -= fx; na.vy -= fy; nb.vx += fx; nb.vy += fy;
          }
        }
      }
      for (const n of work) {
        n.vx *= 0.86; n.vy *= 0.86;
        const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (speed > temperature) { n.vx = (n.vx / speed) * temperature; n.vy = (n.vy / speed) * temperature; }
        n.x += n.vx; n.y += n.vy;
      }
    }
    temperature *= cooling;
  }
  return work;
}

function renderGraphSVG(graph, W, H) {
  const nodes = graph.nodes || []; const edges = graph.edges || [];
  if (!nodes.length) return '<svg viewBox="0 0 280 160"><text x="140" y="80" fill="#5E6B82" font-size="11" text-anchor="middle">暂无图谱数据</text></svg>';
  // 使用与知识图谱页一致的力导向收敛布局（迭代结束时的快照），而非初始环形
  const laid = runForceLayout(nodes, edges, W, H);
  const pos = new Map(laid.map(n => [n.id, n]));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  laid.forEach(n => { minX = Math.min(minX, n.x - n.r); minY = Math.min(minY, n.y - n.r); maxX = Math.max(maxX, n.x + n.r); maxY = Math.max(maxY, n.y + n.r); });
  const pad = 22, gw = maxX - minX + pad * 2, gh = maxY - minY + pad * 2;
  const scale = Math.min(W / gw, H / gh, 4);
  const ox = (W - (maxX + minX) * scale) / 2, oy = (H - (maxY + minY) * scale) / 2;
  const tx = x => ox + x * scale, ty = y => oy + y * scale;
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  edges.forEach(e => { const a = pos.get(e.source), b = pos.get(e.target); if (a && b) s += `<line class="edge" x1="${tx(a.x)}" y1="${ty(a.y)}" x2="${tx(b.x)}" y2="${ty(b.y)}"/>`; });
  nodes.forEach(n => { const p = pos.get(n.id); const acc = (n.type === 'core' || n.accent) ? ' acc' : ''; const x = tx(p.x), y = ty(p.y); s += `<circle class="node${acc}" cx="${x}" cy="${y}" r="6"/>`; });
  return s + '</svg>';
}

// ---- 生成（路径 A）----
$('#genBtn').onclick = async () => {
  const op = $('#genSeg button.on').dataset.t;
  const depth = $('#depthSeg button.on').dataset.t;
  const framework = $('#fwSel').value.split(' ')[0];
  const note = $('#noteTa').value;
  const scope = { depth };
  if (scopeMode === 'func') scope.functions = collectFuncModules();
  else scope.modules = collectModules();
  $('#streamTag').textContent = op + ' · ' + pickProject();
  $('#dlBtns').style.display = 'none';
  $('#streamBody').innerHTML = '<div style="color:var(--aurora-1);font-size:12px">▸ 采集知识上下文并调用 AI 平台生成<span class="cursor"></span></div>';
  const { ok, data } = await api('POST', '/api/generate', { body: { op, scope, constraints: { framework, note } } });
  if (!ok) { $('#streamBody').innerHTML = `<div class="tc" style="color:var(--danger)">生成失败：${data.error || ''}</div>`; toast('生成失败', 'err'); return; }
  const d = data.data || {};
  $('#streamMeta').textContent = `引擎 ${d.engine} · 知识库 ${d.contextUsed?.testCases || 0} 用例 · 命中 ${d.hits?.length || 0} 条`;
  state.lastGenerated = d.content || '';
  state.lastHits = d.hits || [];
  $('#streamBody').innerHTML = `<div class="md">${renderMarkdown(d.content || '')}</div>`;
  $('#dlBtns').style.display = 'inline-flex';
  renderHits(d.hits || []);
  toast('生成完成（' + d.engine + '）', 'ok');
  loadReview(); loadCommit();
};

// ---- 上传代码 / PRD（路径 B）----
$('#codeFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const form = new FormData(); form.append('file', f); form.append('type', 'code'); form.append('project', pickProject());
  const { ok, data } = await api('POST', '/api/source-upload', { form });
  if (ok) { toast('代码已上传并解析：' + ((data.data && data.data.summary) || ''), 'ok'); loadContext(); loadScopes(); }
  else toast('上传失败：' + (data.error || ''), 'err');
};
$('#prdFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const form = new FormData(); form.append('file', f); form.append('type', 'prd'); form.append('project', pickProject());
  const { ok, data } = await api('POST', '/api/source-upload', { form });
  if (ok) { toast('PRD 已上传并沉淀为项目 Wiki：' + ((data.data && data.data.slug) || f.name), 'ok'); loadContext(); loadWikiModules(); }
  else toast('上传失败', 'err');
};
$('#reqFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const form = new FormData(); form.append('file', f); form.append('type', 'requirement'); form.append('project', pickProject());
  const { ok, data } = await api('POST', '/api/source-upload', { form });
  if (ok) { toast('需求列表已上传并沉淀为项目 Wiki：' + ((data.data && data.data.slug) || f.name), 'ok'); loadContext(); loadWikiModules(); }
  else toast('上传失败', 'err');
};

// ---- 草稿审阅 / 入库看板 ----
function srcLabel(s) { return s === 'exec_backflow' ? '执行回流' : s === 'human_edit' ? '人工编辑' : (s || '草稿'); }
function draftCard(d, withBatch) {
  const el = document.createElement('div'); el.className = 'draft src-' + (d.source || 'other');
  const meta = d.metadata || {};
  let extra = '';
  // 执行回流草稿附带来源/类型/严重度等缺陷元信息，与人工编辑草稿在视觉上区分
  if (d.source === 'exec_backflow') {
    const bits = [];
    if (meta.failureType) bits.push('类型：' + meta.failureType);
    if (meta.fileName) bits.push('来源：' + meta.fileName);
    if (meta.severity) bits.push('严重度：' + meta.severity);
    if (bits.length) extra = `<div class="meta">${bits.map(b => `<span>${escapeHtml(b)}</span>`).join('')}</div>`;
  }
  el.innerHTML = `<div class="top"><span class="title">${d.title || '(无标题)'}</span><span class="badge badge-${d.source}">${srcLabel(d.source)} · ${d.type || ''}</span></div>
    ${extra}
    <div class="body">${escapeHtml((d.content || '').slice(0, 600))}</div>
    <div class="actions">
      <button class="act-btn commit" data-act="commit" data-tip="入库" aria-label="入库"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></button>
      <button class="act-btn del" data-act="del" data-tip="删除" aria-label="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>
    </div>`;
  el.querySelector('[data-act=commit]').onclick = () => commitOne(d.id);
  el.querySelector('[data-act=del]').onclick = () => delDraft(d.id);
  return el;
}
async function loadReview() {
  // 草稿审阅：仅展示人工编辑草稿（source=human_edit），采用与知识管理系统一致的表格 + 复选框 + 编辑/删除/入库
  const r = await api('GET', '/api/drafts', { query: { source: 'human_edit', limit: 200 } });
  const list = asArray(r.data);
  const box = $('#reviewList'); if (!box) return; box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="card"><div class="d">暂无人工编辑草稿</div></div>'; return; }
  const wrap = document.createElement('div'); wrap.className = 'dt-wrap';
  wrap.innerHTML = `
    <div class="toolbar">
      <label class="selall"><input type="checkbox" id="selAll"/> 全选</label>
      <button class="btn btn-sm btn-soft" data-act="batch-commit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg> 批量入库</button>
      <button class="btn btn-sm btn-ghost-danger" data-act="batch-delete">批量删除</button>
      <span class="cnt" id="selCnt"></span>
    </div>
    <table class="dt">
      <thead><tr><th></th><th>标题</th><th>类型</th><th>来源</th><th>状态</th><th>更新时间</th><th class="ops">操作</th></tr></thead>
      <tbody></tbody>
    </table>`;
  box.appendChild(wrap);
  const tb = wrap.querySelector('tbody');
  list.forEach(d => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="row-sel" value="${d.id}"/></td>
      <td>${escapeHtml(d.title || '(无标题)')}</td>
      <td>${escapeHtml(d.type || '')}</td>
      <td>${escapeHtml(d.source || '')}</td>
      <td>${escapeHtml(d.status || '')}</td>
      <td>${escapeHtml(String(d.updated_at || d.created_at || '').slice(0, 19).replace('T', ' '))}</td>
      <td class="ops">
        <div class="row-ops">
          <button class="act-btn edit" data-act="edit" data-id="${d.id}" data-tip="编辑" aria-label="编辑">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button class="act-btn commit" data-act="commit" data-id="${d.id}" data-tip="入库" aria-label="入库">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </button>
          <button class="act-btn del" data-act="del" data-id="${d.id}" data-tip="删除" aria-label="删除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </div>
      </td>`;
    tb.appendChild(tr);
  });
  const selAll = wrap.querySelector('#selAll');
  const rows = wrap.querySelectorAll('.row-sel');
  const syncCnt = () => { const n = wrap.querySelectorAll('.row-sel:checked').length; const c = wrap.querySelector('#selCnt'); if (c) c.textContent = n ? ('已选 ' + n + ' 项') : ''; };
  selAll.onchange = e => { rows.forEach(c => c.checked = e.target.checked); syncCnt(); };
  rows.forEach(c => c.onchange = syncCnt);
  wrap.querySelector('[data-act="batch-delete"]').onclick = () => batchDeleteDrafts(wrap);
  wrap.querySelector('[data-act="batch-commit"]').onclick = () => batchCommitDrafts(wrap);
  wrap.querySelectorAll('[data-act="edit"]').forEach(b => b.onclick = () => openDraftEdit(b.dataset.id));
  wrap.querySelectorAll('[data-act="commit"]').forEach(b => b.onclick = () => commitOne(b.dataset.id));
  wrap.querySelectorAll('[data-act="del"]').forEach(b => b.onclick = () => delDraft(b.dataset.id));
}
// 批量删除选中的草稿
async function batchDeleteDrafts(wrap) {
  const ids = [...wrap.querySelectorAll('.row-sel:checked')].map(c => c.value);
  if (!ids.length) { toast('请先勾选要删除的草稿', 'err'); return; }
  if (!confirm('确认删除 ' + ids.length + ' 条草稿？此操作不可恢复。')) return;
  let ok = 0;
  for (const id of ids) {
    try { await api('DELETE', '/api/drafts/' + id, { query: { project: pickProject() } }); ok++; }
    catch (e) { console.warn('删除草稿失败', id, e); }
  }
  toast('已删除 ' + ok + '/' + ids.length + ' 条', 'ok');
  loadReview(); loadCommit();
}
// 批量入库选中的草稿（仅提交勾选项，复用 KS 的 batch-commit 冲突/质量门控）
async function batchCommitDrafts(wrap) {
  const ids = [...wrap.querySelectorAll('.row-sel:checked')].map(c => c.value);
  if (!ids.length) { toast('请先勾选要入库的草稿', 'err'); return; }
  const btn = wrap.querySelector('[data-act="batch-commit"]');
  if (btn) { btn.disabled = true; btn.style.opacity = .6; }
  try {
    const { ok, data } = await api('POST', '/api/drafts/batch-commit', { body: { ids } });
    if (ok && data.data) {
      const c = data.data;
      const committed = (c.committed && c.committed.length) || 0;
      const rejected = (c.rejected && c.rejected.length) || 0;
      const conflicts = (c.conflicts && c.conflicts.length) || 0;
      toast(`批量入库完成：入库 ${committed} 条` + (conflicts ? `，冲突 ${conflicts} 条` : '') + (rejected ? `，拒绝 ${rejected} 条` : ''), rejected ? 'err' : 'ok');
      loadReview(); loadCommit(); loadContext();
    } else {
      toast('批量入库失败：' + (data.error || ''), 'err');
    }
  } catch (e) {
    toast('批量入库异常：' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}
// 编辑草稿：弹窗读写内容，保存走 PUT /api/drafts/:id
let _editDraftId = null;
function openDraftEdit(id) {
  _editDraftId = id;
  api('GET', '/api/drafts/' + id).then(r => {
    const d = (r.data && r.data.data) ? r.data.data : (r.data || {});
    const obj = Array.isArray(d) ? d[0] : d;
    document.getElementById('draftEditTitle').value = obj.title || '';
    document.getElementById('draftEditContent').value = obj.content || '';
    document.getElementById('draftEditModal').classList.add('open');
  }).catch(e => toast('读取草稿失败: ' + e.message, 'err'));
}
function bindDraftEditModal() {
  const modal = document.getElementById('draftEditModal');
  if (!modal) return;
  const close = () => modal.classList.remove('open');
  const closeBtn = modal.querySelector('.modal-close'); if (closeBtn) closeBtn.onclick = close;
  const cancelBtn = modal.querySelector('#draftEditCancel'); if (cancelBtn) cancelBtn.onclick = close;
  const saveBtn = modal.querySelector('#draftEditSave');
  if (saveBtn) saveBtn.onclick = async () => {
    if (!_editDraftId) return;
    const title = document.getElementById('draftEditTitle').value;
    const content = document.getElementById('draftEditContent').value;
    const { ok, error } = await api('PUT', '/api/drafts/' + _editDraftId, { body: { title, content } });
    if (ok) { toast('草稿已保存', 'ok'); close(); loadReview(); }
    else toast('保存失败: ' + (error || ''), 'err');
  };
}
async function loadCommit() {
  const r = await api('GET', '/api/drafts', { query: { limit: 200 } });
  const list = asArray(r.data);
  const box = $('#commitList'); box.innerHTML = '';
  list.forEach(d => box.appendChild(draftCard(d)));
  if (!list.length) box.innerHTML = '<div class="card"><div class="d">缓冲层暂无待入库草稿</div></div>';
  // 冲突检测
  const cd = await api('POST', '/api/conflicts/detect', { body: {} });
  const conflicts = (cd.data && cd.data.data && cd.data.data.conflicts) || [];
  $('#conflictStat').textContent = conflicts.length + ' 冲突';
  $('#sideStat').textContent = `缓冲 ${list.length} · 冲突 ${conflicts.length}`;
}
async function commitOne(id) {
  const { ok, data } = await api('POST', `/api/drafts/${id}/commit`, { body: {} });
  if (ok && data.data && data.data.success) { toast('已入库：' + (data.data.committedPage || id), 'ok'); loadCommit(); loadReview(); loadContext(); }
  else toast('入库失败：' + ((data.data && data.data.reason) || data.error || ''), 'err');
}
async function delDraft(id) {
  await api('DELETE', `/api/drafts/${id}`, { query: { project: pickProject() } });
  loadCommit(); loadReview();
}
$('#batchBtn').onclick = async () => {
  const { ok, data } = await api('POST', '/api/drafts/batch-commit', { body: {} });
  if (ok && data.data) {
    const c = data.data; toast(`批量入库：${c.committed?.length || 0} 条，冲突 ${c.conflicts?.length || 0}，拒绝 ${c.rejected?.length || 0}`, c.rejected?.length ? 'err' : 'ok');
    loadCommit(); loadReview(); loadContext();
  } else toast('批量入库失败：' + (data.error || ''), 'err');
};

// ---- 回测（测试报告存档与回溯）----
async function loadRetest() {
  // 回测报告沉淀为缺陷经验，统一从 defect-experience 分类读取
  const r = await api('GET', '/api/brain/pages', { query: { category: 'defect-experience' } });
  const list = asArray(r.data);
  const box = $('#retestList'); if (!box) return; box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="card"><div class="d">暂无测试报告，请上传 Markdown/JSON 测试报告</div></div>'; return; }
  list.forEach(p => {
    const el = document.createElement('div'); el.className = 'card';
    el.innerHTML = `<div class="h">${escapeHtml(p.title || p.slug || '')}</div><div class="d">${escapeHtml((p.content || '').slice(0, 240))}</div>`;
    box.appendChild(el);
  });
}
// ---- Git 协同（对齐 KS §12 · S1：config/status/init/commit）----
// 垂直构建：UI 直接消费 BFF 的 /api/git/*（BFF 在 KS 不可达或 GIT_MOCK=1 时回退契约一致假数据）。
async function loadGitConfig() {
  const box = $('#gitConfigBox'); if (!box) return;
  const { ok, data } = await api('GET', '/api/git/config');
  const cfg = (ok && data.data) || {};
  box.innerHTML = `
    <label class="fld"><span class="lbl">远端地址 (remote)</span>
      <input class="inp" id="gitRemote" value="${escapeHtml(cfg.remote || '')}" placeholder="https://…/repo.git" /></label>
    <label class="fld"><span class="lbl">分支 (branch)</span>
      <input class="inp" id="gitBranch" value="${escapeHtml(cfg.branch || 'main')}" placeholder="main" /></label>
    <label class="fld"><span class="lbl">用户名 (user.name)</span>
      <input class="inp" id="gitUserName" value="${escapeHtml((cfg.user && cfg.user.name) || '')}" placeholder="可选" /></label>
    <label class="fld"><span class="lbl">邮箱 (user.email)</span>
      <input class="inp" id="gitUserEmail" value="${escapeHtml((cfg.user && cfg.user.email) || '')}" placeholder="可选" /></label>
    ${cfg._mock ? '<div class="mock-tag">当前为 Mock 数据（KS 不可达或 GIT_MOCK=1）</div>' : ''}
  `;
}
$('#gitSaveCfgBtn').onclick = async () => {
  const msg = $('#gitCfgMsg'); if (!msg) return;
  const payload = {
    remote: $('#gitRemote')?.value?.trim() || '',
    branch: $('#gitBranch')?.value?.trim() || 'main',
    user: { name: $('#gitUserName')?.value?.trim() || '', email: $('#gitUserEmail')?.value?.trim() || '' },
  };
  const { ok, data } = await api('PUT', '/api/git/config', { body: payload });
  if (ok && data.success) { msg.textContent = '配置已保存'; msg.className = 'test-msg ok'; loadGitConfig(); }
  else msg.textContent = '保存失败：' + (data.error || JSON.stringify(data)); msg.className = 'test-msg err';
};
$('#gitInitBtn').onclick = async () => {
  const msg = $('#gitCfgMsg'); if (!msg) return;
  const { ok, data } = await api('POST', '/api/git/init', { body: {} });
  if (ok && data.success) { msg.textContent = '仓库已初始化：' + (data.data?.branch || 'main'); msg.className = 'test-msg ok'; }
  else msg.textContent = '初始化失败：' + (data.error || JSON.stringify(data)); msg.className = 'test-msg err';
};

async function loadGitStatus() {
  const box = $('#gitStatusBox'); if (!box) return;
  const { ok, data } = await api('GET', '/api/git/status');
  const s = (ok && data.data) || {};
  if (!s.initialized) {
    box.innerHTML = `<div class="d">仓库尚未初始化${s._mock ? '（Mock 数据）' : ''}。请先在「Git 配置」中初始化，或等待 KS 侧就绪。</div>`;
    return;
  }
  const section = (title, arr) => `<div class="git-sec"><div class="git-sec-h">${title}（${asArray(arr).length}）</div>${
    asArray(arr).length ? asArray(arr).map(x => `<div class="git-row">${escapeHtml(typeof x === 'string' ? x : (x.path || x.name || JSON.stringify(x)))}</div>`).join('') : '<div class="git-row dim">无</div>'
  }</div>`;
  box.innerHTML = `
    <div class="git-top">分支 <b>${escapeHtml(s.branch || 'main')}</b> · 领先 ${s.ahead || 0} · 落后 ${s.behind || 0}${s._mock ? ' · <span class="mock-tag">Mock</span>' : ''}</div>
    ${section('未跟踪', s.untracked)}
    ${section('已修改', s.modified)}
    ${section('已暂存', s.staged)}
  `;
}
$('#gitCommitBtn').onclick = async () => {
  const msg = $('#gitStatusMsg'); if (!msg) return;
  const cm = $('#gitCommitMsg'); const message = cm?.value?.trim() || '';
  if (!message) { msg.textContent = '请填写提交说明'; msg.className = 'test-msg err'; return; }
  const { ok, data } = await api('POST', '/api/git/commit', { body: { message } });
  if (ok && data.success) { msg.textContent = '提交成功：' + (data.data?.commitHash || ''); msg.className = 'test-msg ok'; if (cm) cm.value = ''; loadGitStatus(); }
  else msg.textContent = '提交失败：' + (data.error || JSON.stringify(data)); msg.className = 'test-msg err';
};

$('#retestFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const form = new FormData(); form.append('file', f); form.append('type', 'test-report'); form.append('project', pickProject());
  const { ok, data } = await api('POST', '/api/source-upload', { form });
  if (ok) { toast('测试报告已入库：' + ((data.data && data.data.slug) || f.name), 'ok'); loadRetest(); }
  else toast('上传失败：' + (data.error || ''), 'err');
};

// ---- 执行回流 ----
async function loadBackflow() {
  const r = await api('GET', '/api/drafts', { query: { source: 'exec_backflow', limit: 100 } });
  const list = asArray(r.data);
  const box = $('#backflowList'); box.innerHTML = '';
  list.forEach(d => box.appendChild(draftCard(d)));
  if (!list.length) box.innerHTML = '<div class="card"><div class="d">暂无执行回流缺陷草稿</div></div>';
}
$('#reportFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const content = await f.text();
  const { ok } = await api('POST', '/api/drafts', { body: { source: 'exec_backflow', type: 'defect_experience', title: '执行回流：' + f.name, content, metadata: { failureType: 'report_parse', fileName: f.name } } });
  if (ok) { toast('执行报告已解析并生成缺陷草稿', 'ok'); loadBackflow(); loadCommit(); }
  else toast('回流失败', 'err');
};

// ---- 交互式知识图谱 ----
const graphState = {
  svg: null, g: null, nodes: [], edges: [], simulation: null,
  transform: { x: 0, y: 0, k: 1 }, dragging: null, panning: false, panStart: null,
  width: 0, height: 0, container: null, nodeEls: [], edgeEls: []
};

function renderInteractiveGraph(container, graph) {
  container.innerHTML = '';
  graphState.container = container;
  // 控制按钮
  const controls = document.createElement('div');
  controls.style.cssText = 'position:absolute;top:12px;right:12px;display:flex;gap:8px;z-index:10;';
  controls.innerHTML = `<button class="btn btn-sm btn-ghost" onclick="resetGraphView()">⟲ 重置视图</button><button class="btn btn-sm btn-ghost" onclick="fitView(graphState)">⤢ 适配窗口</button>`;
  container.appendChild(controls);
  const nodes = (graph.nodes || []).map((n, i) => ({
    id: n.id || i, label: n.label || n.id, type: n.type, accent: n.accent,
    x: 0, y: 0, vx: 0, vy: 0, r: (n.type === 'core' || n.accent) ? 18 : 12
  }));
  const edges = (graph.edges || []).map(e => ({
    source: e.source || e.from, target: e.target || e.to
  })).filter(e => nodes.find(n => n.id === e.source) && nodes.find(n => n.id === e.target));
  if (!nodes.length) {
    container.innerHTML = '<div style="text-align:center;padding:80px 0;color:var(--text-3)">暂无图谱数据</div>';
    return;
  }
  const W = container.clientWidth || 800;
  const H = container.clientHeight || 500;
  graphState.width = W; graphState.height = H;
  // 初始位置在中心，由 startSimulation 重新随机散布（对齐知识系统模型）
  nodes.forEach(n => { n.x = W/2; n.y = H/2; });
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.display = 'block';
  svg.style.cursor = 'grab';
  container.appendChild(svg);
  graphState.svg = svg;
  const g = document.createElementNS(ns, 'g');
  svg.appendChild(g);
  graphState.g = g;
  const edgeEls = [];
  edges.forEach(e => {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('stroke', 'rgba(255,255,255,.16)');
    line.setAttribute('stroke-width', '1');
    g.appendChild(line);
    edgeEls.push({ el: line, source: e.source, target: e.target });
  });
  const nodeEls = [];
  nodes.forEach(n => {
    const ng = document.createElementNS(ns, 'g');
    ng.style.cursor = 'pointer';
    const circle = document.createElementNS(ns, 'circle');
    const isAcc = n.type === 'core' || n.accent;
    circle.setAttribute('r', n.r);
    circle.setAttribute('fill', isAcc ? 'rgba(168,85,247,.18)' : 'rgba(34,211,238,.14)');
    circle.setAttribute('stroke', isAcc ? '#A855F7' : '#22D3EE');
    circle.setAttribute('stroke-width', '1.2');
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('fill', '#E8EDF6');
    text.setAttribute('font-size', '10');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dy', '3.5');
    text.setAttribute('font-family', 'monospace');
    text.textContent = (n.label || n.id).slice(0, 8);
    ng.appendChild(circle);
    ng.appendChild(text);
    g.appendChild(ng);
    nodeEls.push({ el: ng, data: n });
    ng.addEventListener('mouseenter', () => showGraphTooltip(n, ng));
    ng.addEventListener('mouseleave', hideGraphTooltip);
  });
  graphState.nodes = nodes;
  graphState.edges = edges;
  graphState.nodeEls = nodeEls;
  graphState.edgeEls = edgeEls;
  startSimulation(nodes, edges);
  svg.addEventListener('wheel', zoomHandler, { passive: false });
  svg.addEventListener('mousedown', panStartHandler);
  window.addEventListener('mousemove', panMoveHandler);
  window.addEventListener('mouseup', panEndHandler);
  nodeEls.forEach(({ el, data }) => {
    el.addEventListener('mousedown', e => {
      e.stopPropagation();
      graphState.dragging = data;
      data.fx = data.x; data.fy = data.y;
    });
  });
  setTimeout(() => fitView(graphState), 50);
}

function startSimulation(nodes, edges) {
  const W = graphState.width || 800;
  const H = graphState.height || 500;
  // 使用力导向收敛布局（迭代结束时的快照），与生成中心 mini 图完全一致
  const laid = runForceLayout(nodes, edges, W, H);
  const map = new Map(laid.map(n => [n.id, n]));
  nodes.forEach(n => { const p = map.get(n.id); n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0; });
  updateGraphView();
  fitView(graphState);
}

function updateGraphView() {
  const { transform, nodeEls, edgeEls, nodes } = graphState;
  nodeEls.forEach(({ el, data }) => { el.setAttribute('transform', `translate(${data.x},${data.y})`); });
  edgeEls.forEach(({ el, source, target }) => {
    const a = nodes.find(n => n.id === source);
    const b = nodes.find(n => n.id === target);
    if (a && b) { el.setAttribute('x1', a.x); el.setAttribute('y1', a.y); el.setAttribute('x2', b.x); el.setAttribute('y2', b.y); }
  });
  if (graphState.g) {
    graphState.g.setAttribute('transform', `translate(${transform.x},${transform.y}) scale(${transform.k})`);
  }
}

function fitView(state) {
  const { nodes, svg } = state;
  if (!nodes.length || !svg) return;
  const rect = svg.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  state.width = W; state.height = H;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  nodes.forEach(n => {
    minX = Math.min(minX, n.x - n.r); minY = Math.min(minY, n.y - n.r);
    maxX = Math.max(maxX, n.x + n.r); maxY = Math.max(maxY, n.y + n.r);
  });
  const padding = 40;
  const graphW = maxX - minX + padding * 2;
  const graphH = maxY - minY + padding * 2;
  const scale = Math.min(W / graphW, H / graphH, 2);
  state.transform.k = scale;
  state.transform.x = (W - (maxX + minX) * scale) / 2;
  state.transform.y = (H - (maxY + minY) * scale) / 2;
  updateGraphView();
}

function zoomHandler(e) {
  e.preventDefault();
  const { transform, svg } = graphState;
  const rect = svg.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const newK = Math.max(0.1, Math.min(5, transform.k * delta));
  transform.x = mx - (mx - transform.x) * (newK / transform.k);
  transform.y = my - (my - transform.y) * (newK / transform.k);
  transform.k = newK;
  updateGraphView();
}

function panStartHandler(e) {
  if (e.button !== 0) return;
  graphState.panning = true;
  graphState.panStart = { x: e.clientX, y: e.clientY, tx: graphState.transform.x, ty: graphState.transform.y };
  graphState.svg.style.cursor = 'grabbing';
}

function panMoveHandler(e) {
  if (graphState.dragging) {
    const rect = graphState.svg.getBoundingClientRect();
    const x = (e.clientX - rect.left - graphState.transform.x) / graphState.transform.k;
    const y = (e.clientY - rect.top - graphState.transform.y) / graphState.transform.k;
    // 直接更新位置，确保模拟停止后拖拽仍生效
    graphState.dragging.x = x; graphState.dragging.y = y;
    graphState.dragging.fx = x; graphState.dragging.fy = y;
    updateGraphView();
    return;
  }
  if (!graphState.panning) return;
  const dx = e.clientX - graphState.panStart.x;
  const dy = e.clientY - graphState.panStart.y;
  graphState.transform.x = graphState.panStart.tx + dx;
  graphState.transform.y = graphState.panStart.ty + dy;
  updateGraphView();
}

function panEndHandler() {
  graphState.panning = false;
  graphState.panStart = null;
  if (graphState.svg) graphState.svg.style.cursor = 'grab';
  if (graphState.dragging) {
    graphState.dragging.fx = null; graphState.dragging.fy = null; graphState.dragging = null;
  }
}

function resetGraphView() { fitView(graphState); }

function showGraphTooltip(nodeData, nodeEl) {
  const container = graphState.container;
  if (!container) return;
  let tip = container.querySelector('.graph-tooltip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'graph-tooltip'; container.appendChild(tip); }
  tip.innerHTML = `<b>${escapeHtml(nodeData.label || nodeData.id)}</b><br/><span style="color:var(--text-3)">${escapeHtml(nodeData.type || 'node')}</span>`;
  tip.style.display = 'block';
  const rect = nodeEl.getBoundingClientRect();
  const cRect = container.getBoundingClientRect();
  tip.style.left = (rect.left - cRect.left + rect.width/2 - tip.offsetWidth/2) + 'px';
  tip.style.top = (rect.top - cRect.top - tip.offsetHeight - 8) + 'px';
}

function hideGraphTooltip() {
  const tip = graphState.container && graphState.container.querySelector('.graph-tooltip');
  if (tip) tip.style.display = 'none';
}

// 将 KS 业务流依赖图谱（nodes 用 title、edges 用 from/to）归一化为前端力导向所需结构（label/type、source/target）
function normalizeGraph(g) {
  if (!g) return { nodes: [], edges: [] };
  const nodes = (g.nodes || []).map(n => ({
    ...n,
    id: n.id,
    label: n.title || n.label || n.id,
    type: n.domain || n.type,
    accent: true,
  }));
  const edges = (g.edges || []).map(e => ({ source: e.source || e.from, target: e.target || e.to }));
  return { nodes, edges };
}

// ---- 知识图谱（全量）：业务流依赖图谱（取代代码图谱，黑盒测试不依赖源码）----
async function loadGraph() {
  const bg = await api('GET', '/api/business-graph');
  const raw = (bg.data && bg.data.data) || null;
  const wrap = $('#fullGraph');
  wrap.style.position = 'relative';
  wrap.style.minHeight = '520px';
  if (!raw || !raw.nodes || !raw.nodes.length) {
    wrap.innerHTML = '<div style="text-align:center;padding:80px 0;color:var(--text-3)">尚未生成业务图谱。点击右上角「生成业务图谱」基于项目 Wiki（PRD/需求/API 文档）生成；或在「导入」中上传相关资料后重生成。</div>';
    return;
  }
  renderInteractiveGraph(wrap, normalizeGraph(raw));
}

// 生成/重生成业务流依赖图谱（POST /api/business-graph，ai=true 走 AI 通道）
$('#genBizGraphBtn').onclick = async () => {
  const btn = $('#genBizGraphBtn');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '生成中…';
  try {
    const r = await api('POST', '/api/business-graph', { query: { project: pickProject() }, body: { ai: true } });
    if (r.ok) { toast('业务图谱生成完成', 'ok'); await loadGraph(); }
    else { toast('业务图谱生成失败', 'err'); }
  } catch (e) {
    toast('生成失败：' + (e && e.message ? e.message : e), 'err');
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
};

// ---- 新建项目 ----
$('#newProjBtn').onclick = async () => {
  const name = prompt('项目名称'); if (!name) return;
  const id = 'tg-' + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 5);
  const { ok } = await api('POST', '/api/projects', { body: { id, name, description: '新建测试项目' } });
  if (ok) { toast('已创建项目 ' + id, 'ok'); loadProjects(); }
  else toast('创建失败', 'err');
};

// ---- 工具 ----
function escapeHtml(s) { return (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// ---- Markdown 渲染（自包含，无外部依赖）----
function renderMarkdown(src) {
  if (!src || !src.trim()) return '<div class="empty">（无内容）</div>';
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const inline = (t) => {
    let s = esc(t);
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
    return s;
  };
  let html = ''; let i = 0;
  const isBlockStart = ln => /^(#{1,4}\s|>\s?|```|\s*[-*+]\s|\s*\d+\.\s|\-\-\-|\*\*\*|___)/.test(ln);
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`; continue;
    }
    let m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) { const lvl = m[1].length; html += `<h${lvl}>${inline(m[2])}</h${lvl}>`; i++; continue; }
    if (/^(\-\-\-|\*\*\*|___)\s*$/.test(line)) { html += '<hr/>'; i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      html += `<blockquote>${inline(buf.join(' '))}</blockquote>`; continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const parseRow = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const head = parseRow(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|')) { rows.push(parseRow(lines[i])); i++; }
      let t = '<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      rows.forEach(r => { t += '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>'; });
      html += t + '</tbody></table>'; continue;
    }
    if (/^(\s*)([-*+])\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^(\s*)([-*+])\s+/.test(lines[i])) { buf.push(lines[i].replace(/^(\s*)([-*+])\s+/, '')); i++; }
      html += '<ul>' + buf.map(c => `<li>${inline(c)}</li>`).join('') + '</ul>'; continue;
    }
    if (/^(\s*)\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^(\s*)\d+\.\s+/.test(lines[i])) { buf.push(lines[i].replace(/^(\s*)\d+\.\s+/, '')); i++; }
      html += '<ol>' + buf.map(c => `<li>${inline(c)}</li>`).join('') + '</ol>'; continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
    html += `<p>${inline(buf.join(' '))}</p>`;
  }
  return html;
}

// ---- 下载：Markdown / PDF ----
function downloadBlob(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function genFileName(ext) {
  const base = ($('#streamTag').textContent || 'testcases').replace(/[\s·]+/g, '_').replace(/[^\w.-]/g, '') || 'testcases';
  return base + '.' + ext;
}
$('#dlMd').onclick = () => {
  const c = state.lastGenerated || '';
  if (!c) { toast('暂无可下载内容', 'err'); return; }
  downloadBlob(genFileName('md'), c, 'text/markdown;charset=utf-8');
  toast('已下载 Markdown', 'ok');
};
// 按固定标记 ## TC-{序号} · {标题} 拆分测试用例条目
function splitTestCases(md) {
  const cases = [];
  const re = /^## TC-(\d{3})\s*·\s*(.+)$/gm;
  let m, lastIndex = 0, lastTitle = '', lastNum = '';
  while ((m = re.exec(md)) !== null) {
    if (lastTitle) {
      cases.push({ num: lastNum, title: lastTitle, content: md.slice(lastIndex, m.index).trim() });
    }
    lastIndex = m.index;
    lastNum = m[1];
    lastTitle = m[2].trim();
  }
  if (lastTitle) {
    cases.push({ num: lastNum, title: lastTitle, content: md.slice(lastIndex).trim() });
  }
  return cases;
}

// 模型生成结果落库：
// - gen_outline → 直接沉淀为项目 Wiki（PRD 类型）
// - gen_cases   → 按条拆分后批量保存为草稿（test_case）
// - gen_scripts → 单条保存为草稿（test_script）
$('#saveDraft').onclick = async () => {
  const c = state.lastGenerated || '';
  if (!c) { toast('暂无可保存内容，请先生成', 'err'); return; }
  const op = ($('#streamTag').textContent || 'gen_cases').split(' ')[0];
  const project = pickProject();

  // gen_outline：直接写入项目 Wiki（PRD 类型）
  if (op === 'gen_outline') {
    const { ok, data } = await api('POST', '/api/source-upload', {
      body: { type: 'prd', content: c, note: '测试用例大纲（模型生成）', project }
    });
    if (ok) { toast('用例大纲已沉淀为项目 Wiki：' + (data.data && data.data.slug || ''), 'ok'); loadContext(); }
    else toast('保存失败：' + (data.error || ''), 'err');
    return;
  }

  // gen_scripts：单条保存
  if (op === 'gen_scripts') {
    const { ok, data } = await api('POST', '/api/drafts', {
      body: {
        source: 'human_edit',
        type: 'test_script',
        title: '测试脚本（' + project + ' · 模型生成）',
        content: c,
        metadata: { origin: 'ai_generate', engine: ($('#streamMeta').textContent || '') }
      }
    });
    if (ok) { toast('已保存到草稿，可在「草稿审阅」中查看', 'ok'); loadReview(); loadCommit(); }
    else toast('保存失败：' + (data.error || ''), 'err');
    return;
  }

  // gen_cases：按条拆分后批量保存（当前逐条调用，后续可迁移到批量上传 API）
  const cases = splitTestCases(c);
  if (!cases.length) {
    // 未识别到固定标记，回退为单条保存（兼容旧格式或模板生成）
    const { ok, data } = await api('POST', '/api/drafts', {
      body: {
        source: 'human_edit',
        type: 'test_case',
        title: '测试用例（' + project + ' · 模型生成）',
        content: c,
        metadata: { origin: 'ai_generate', engine: ($('#streamMeta').textContent || '') }
      }
    });
    if (ok) { toast('已保存到草稿（未拆分，单条）', 'ok'); loadReview(); loadCommit(); }
    else toast('保存失败：' + (data.error || ''), 'err');
    return;
  }

  toast('正在保存 ' + cases.length + ' 条测试用例…', 'ok');
  const results = await Promise.all(cases.map(tc =>
    api('POST', '/api/drafts', {
      body: {
        source: 'human_edit',
        type: 'test_case',
        title: tc.title + '（' + project + '）',
        content: tc.content,
        metadata: { origin: 'ai_generate', engine: ($('#streamMeta').textContent || ''), tcNum: tc.num }
      }
    })
  ));
  const okCount = results.filter(r => r.ok).length;
  if (okCount === cases.length) {
    toast('全部 ' + cases.length + ' 条测试用例已保存到草稿', 'ok');
  } else {
    toast('保存完成：' + okCount + '/' + cases.length + ' 条成功', 'err');
  }
  loadReview(); loadCommit();
};
$('#dlPdf').onclick = () => {
  const c = state.lastGenerated || '';
  if (!c) { toast('暂无可下载内容', 'err'); return; }
  const title = $('#streamTag').textContent || 'testcases';
  const printHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,'Segoe UI',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;max-width:840px;margin:40px auto;padding:0 24px;color:#1a1a1a;line-height:1.7;font-size:14px}
h1,h2,h3,h4{border-bottom:1px solid #eee;padding-bottom:6px;margin:20px 0 10px}
pre{background:#f5f5f5;padding:12px 14px;border-radius:6px;overflow:auto}
code{background:#f0f0f0;padding:2px 5px;border-radius:4px;font-family:Consolas,monospace}
blockquote{border-left:3px solid #ccc;margin:0;padding-left:12px;color:#555}
table{border-collapse:collapse;width:100%;margin:12px 0}
th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
hr{border:none;border-top:1px solid #eee;margin:18px 0}
a{color:#1565c0}
</style></head><body>${renderMarkdown(c)}</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('浏览器拦截了弹窗，请允许后重试', 'err'); return; }
  w.document.open(); w.document.write(printHtml); w.document.close();
  setTimeout(() => { try { w.print(); } catch (e) {} }, 350);
  toast('已打开打印窗口，请选择「另存为 PDF」', 'ok');
};
// 兼容多种返回结构：data:[...] / data.data:[...] / data.data.drafts:[...] / data.data.items:[...]
function asArray(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.data)) return d.data;
  if (d && d.data && Array.isArray(d.data.drafts)) return d.data.drafts;
  if (d && d.data && Array.isArray(d.data.items)) return d.data.items;
  return [];
}

// ---- 设置模块（齿轮 + 弹窗）----
const gearBtn = document.getElementById('gearNav');
const settingsModal = document.getElementById('settingsModal');
const setKsApi = document.getElementById('setKsApi');
const setAiProvider = document.getElementById('setAiProvider');
const setAiEndpoint = document.getElementById('setAiEndpoint');
const setAiKey = document.getElementById('setAiKey');
const setAiModel = document.getElementById('setAiModel');
const setEndpointField = document.getElementById('setEndpointField');
const setKeyField = document.getElementById('setKeyField');
const setModelField = document.getElementById('setModelField');
const cbSourceWrap = document.getElementById('cbSourceWrap');
const cbModelField = document.getElementById('cbModelField');
const cbModel = document.getElementById('cbModel');
const cbBuiltin = document.getElementById('cbBuiltin');
const cbCustom = document.getElementById('cbCustom');
const setMaxTurnsField = document.getElementById('setMaxTurnsField');
const setMaxTurns = document.getElementById('setMaxTurns');
const setTestMsg = document.getElementById('setTestMsg');

// CodeBuddy 内置模型静态清单（与后端 BUILTIN_CODEBUDDY_MODELS 对齐；即使 API 失败也保证有可选项，不卡在「加载中…」）
const CB_BUILTIN = [
  { id: 'glm-5.2', label: 'glm-5.2（CodeBuddy 内置）' },
  { id: 'claude-sonnet-4', label: 'claude-sonnet-4（CodeBuddy 内置）' },
  { id: 'claude-opus-4', label: 'claude-opus-4（CodeBuddy 内置）' },
  { id: 'hy3', label: 'Hy3（CodeBuddy 内置）' },
];
// 同步填充内置模型下拉（确保当前已配置模型一定可见、被选中；不会停留在「加载中…」）
function ensureCbModelOptions(currentModel) {
  if (!cbModel) return;
  const opts = CB_BUILTIN.slice();
  if (currentModel && !opts.some((o) => o.id === currentModel)) {
    opts.push({ id: currentModel, label: currentModel + '（当前配置）' });
  }
  cbModel.innerHTML = opts.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)}</option>`).join('');
  if (currentModel) cbModel.value = currentModel;
}

// 按当前供应商与「模型来源」单选切换可见字段
function syncProviderUI() {
  const p = setAiProvider.value;
  const isCb = p === 'codebuddy';
  const isOpenAI = p === 'openai';
  cbSourceWrap.style.display = isCb ? '' : 'none';
  const custom = isCb && cbCustom.checked;
  cbModelField.style.display = (isCb && !custom) ? '' : 'none';
  // 显示内置模型下拉时立即用静态清单填充，避免「加载中…」残留
  if (isCb && !custom && cbModel && /加载中/.test(cbModel.textContent || '')) {
    ensureCbModelOptions(cbModel.value);
  }
  setEndpointField.style.display = (isOpenAI || (isCb && custom)) ? '' : 'none';
  setKeyField.style.display = (isOpenAI || (isCb && custom)) ? '' : 'none';
  setModelField.style.display = (isOpenAI || (isCb && custom)) ? '' : 'none';
  // maxTurns 仅对 CodeBuddy 通道有意义（agentic 多轮）；OpenAI 为单次调用不使用
  if (setMaxTurnsField) setMaxTurnsField.style.display = isCb ? '' : 'none';
  const note = document.getElementById('setAiNote');
  if (note) {
    if (isOpenAI) note.textContent = '直连你的 OpenAI 兼容服务（/v1/chat/completions）生成。';
    else if (isCb) note.textContent = custom
      ? 'Endpoint/Key 将注册为 CodeBuddy 自定义模型（写入 .codebuddy/models.json），生成时走你的自有模型。'
      : '使用 CodeBuddy 内置模型，无需填写 Endpoint；如需自有模型请选「自定义模型」。';
    else note.textContent = '仅本地模板兜底，不调用任何 AI。';
  }
}
// 从后端查询 CodeBuddy 可直接使用的模型清单（内置 + 已注册自定义），成功后用完整清单替换并保留当前选中项
async function loadCbModels(currentModel) {
  const model = currentModel || (cbModel && cbModel.value) || '';
  try {
    const { ok, data } = await api('GET', '/api/settings/codebuddy-models');
    if (ok && data && Array.isArray(data.models) && data.models.length) {
      const opts = data.models.slice();
      if (model && !opts.some((o) => o.id === model)) opts.unshift({ id: model, label: model + '（当前配置）' });
      cbModel.innerHTML = opts.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join('');
    }
  } catch (_) { /* 失败则保留静态清单（ensureCbModelOptions 已填充） */ }
  if (model) cbModel.value = model;
}
function fillSettings(cfg) {
  setKsApi.value = (cfg.ks && cfg.ks.apiBase) || '';
  setAiProvider.value = (cfg.ai && cfg.ai.provider) || 'openai';
  const useCustom = !!(cfg.ai && cfg.ai.useCustomModel);
  if (cbCustom) cbCustom.checked = useCustom;
  if (cbBuiltin) cbBuiltin.checked = !useCustom;
  setAiEndpoint.value = (cfg.ai && cfg.ai.endpoint) || '';
  setAiKey.value = (cfg.ai && cfg.ai.apiKey) || '';
  const model = (cfg.ai && cfg.ai.model) || '';
  setAiModel.value = model;
  if (setMaxTurns) setMaxTurns.value = (cfg.ai && cfg.ai.maxTurns) || 8;
  syncProviderUI();
  // 内置模型下拉：先同步填充静态清单并选中当前模型，再异步拉取完整清单（含已注册自定义） enrich
  if (setAiProvider.value === 'codebuddy' && !useCustom) {
    ensureCbModelOptions(model);
    loadCbModels(model);
  }
}
async function loadSettings() {
  const { ok, data } = await api('GET', '/api/settings');
  if (ok && data) {
    // api() 返回的是完整响应信封 {success,data:{ks,ai}}，fillSettings 需要的是内层 payload
    const payload = data.data && typeof data.data === 'object' ? data.data : data;
    fillSettings(payload);
    _ksBase = (payload.ks && payload.ks.apiBase) || '';
  }
}
// ---- AI CLI 登录态（设置弹窗内）----
async function loadAiCliStatus() {
  const badge = document.getElementById('aiCliBadge');
  const msg = document.getElementById('aiCliMsg');
  const loginBtn = document.getElementById('aiCliLogin');
  const stat = document.getElementById('aiCliStat');
  if (!badge) return;
  badge.textContent = '检测中…'; badge.style.background = '#3a4250'; badge.style.color = '#fff';
  if (loginBtn) loginBtn.style.display = 'none';
  try {
    const r = await api('GET', '/api/ai-cli/status');
    const outer = (r && r.data) || {};
    const d = outer.data || outer;
    if (!d || !d.status) { badge.textContent = '检测失败'; badge.style.background = '#b45309'; return; }
    const map = {
      logged_in: { t: '已登录', c: '#16a34a' },
      not_logged_in: { t: '未登录', c: '#dc2626' },
      not_installed: { t: 'CLI 未安装', c: '#b45309' },
    };
    const m = map[d.status] || { t: d.status, c: '#3a4250' };
    badge.textContent = m.t; badge.style.background = m.c;
    if (msg) msg.textContent = d.message || '';
    if (loginBtn) loginBtn.style.display = (d.status === 'logged_in') ? 'none' : '';
    if (stat) stat.textContent = '';
  } catch (e) {
    badge.textContent = '检测失败'; badge.style.background = '#b45309';
    if (stat) stat.textContent = '请求失败：' + (e && e.message ? e.message : e);
  }
}
async function aiCliLogin() {
  const stat = document.getElementById('aiCliStat');
  const loginBtn = document.getElementById('aiCliLogin');
  if (stat) stat.textContent = '正在打开浏览器登录…';
  if (loginBtn) loginBtn.disabled = true;
  try {
    const r = await api('POST', '/api/ai-cli/login', {});
    const outer = (r && r.data) || {};
    if (stat) stat.textContent = outer.message || outer.error || (r && r.ok ? '已触发登录' : '登录失败');
  } catch (e) {
    if (stat) stat.textContent = '请求失败：' + (e && e.message ? e.message : e);
  } finally {
    if (loginBtn) loginBtn.disabled = false;
    setTimeout(loadAiCliStatus, 1500);
  }
}

function openSettings() { loadSettings(); setTestMsg.textContent = ''; setTestMsg.className = 'test-msg'; settingsModal.classList.add('open'); loadAiCliStatus(); }
function closeSettings() { settingsModal.classList.remove('open'); }

if (gearBtn) gearBtn.addEventListener('click', openSettings);
const settingsClose = document.getElementById('settingsClose');
if (settingsClose) settingsClose.addEventListener('click', closeSettings);
if (settingsModal) settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
if (setAiProvider) setAiProvider.addEventListener('change', () => { syncProviderUI(); if (setAiProvider.value === 'codebuddy' && cbBuiltin.checked) loadCbModels(cbModel.value); });
const aiCliLoginBtn = document.getElementById('aiCliLogin');
if (aiCliLoginBtn) aiCliLoginBtn.addEventListener('click', aiCliLogin);
const aiCliRefreshBtn = document.getElementById('aiCliRefresh');
if (aiCliRefreshBtn) aiCliRefreshBtn.addEventListener('click', loadAiCliStatus);
if (cbBuiltin) cbBuiltin.addEventListener('change', () => { syncProviderUI(); if (cbBuiltin.checked) loadCbModels(cbModel.value); });
if (cbCustom) cbCustom.addEventListener('change', syncProviderUI);
const setTest = document.getElementById('setTest');
if (setTest) setTest.addEventListener('click', async () => {
  setTestMsg.innerHTML = '连接中…'; setTestMsg.className = 'test-msg';
  const p = setAiProvider.value;
  const useCustom = (p === 'codebuddy') && cbCustom.checked;
  const aiPayload = {
    provider: p,
    useCustomModel: useCustom,
    endpoint: (p === 'openai' || useCustom) ? setAiEndpoint.value.trim() : '',
    apiKey: (p === 'openai' || useCustom) ? setAiKey.value.trim() : '',
    model: (p === 'codebuddy') ? (useCustom ? setAiModel.value.trim() : cbModel.value) : setAiModel.value.trim(),
  };
  const { ok, data } = await api('POST', '/api/settings/test', { body: { ksApiBase: setKsApi.value.trim(), ai: aiPayload } });
  const body = data && data.data && typeof data.data === 'object' ? data.data : (data || {});
  const ks = body.ks || {};
  const ai = body.ai || {};
  const line = (good, okTxt, badTxt) => `<span class="${good ? 'ok' : 'err'}">${good ? '✓' : '✗'} ${good ? okTxt : badTxt}</span>`;
  const ksTxt = ks.reachable
    ? line(true, `KS 可达 (HTTP ${ks.status || ''}${ks.latencyMs != null ? ' · ' + ks.latencyMs + 'ms' : ''})`)
    : line(false, '', `KS 不可达：${ks.error || '无响应'}`);
  const aiTxt = ai.reachable
    ? line(true, `AI 平台可达 (${ai.label || ai.provider})`)
    : line(false, '', `AI 平台不可达：${(ai.label ? ai.label + ' · ' : '') + (ai.detail || '未配置')}`);
  setTestMsg.innerHTML = ksTxt + '<br>' + aiTxt;
  setTestMsg.className = 'test-msg';
});
const setSave = document.getElementById('setSave');
if (setSave) setSave.addEventListener('click', async () => {
  const p = setAiProvider.value;
  const useCustom = (p === 'codebuddy') && cbCustom.checked;
  const model = (p === 'codebuddy')
    ? (useCustom ? setAiModel.value.trim() : cbModel.value)
    : setAiModel.value.trim();
  const payload = {
    ks: { apiBase: setKsApi.value.trim() || 'http://localhost:3000' },
    ai: {
      provider: p,
      useCustomModel: useCustom,
      endpoint: (p === 'openai' || useCustom) ? setAiEndpoint.value.trim() : '',
      apiKey: (p === 'openai' || useCustom) ? setAiKey.value.trim() : '',
      model: model,
      maxTurns: parseInt((setMaxTurns && setMaxTurns.value), 10) || 8,
    },
  };
  const { ok, data } = await api('PUT', '/api/settings', { body: payload });
  if (ok && data) {
    const saved = data.data && typeof data.data === 'object' ? data.data : data;
    fillSettings(saved);
    _ksBase = (saved.ks && saved.ks.apiBase) || '';
    toast('设置已保存（即时生效，无需重启）', 'ok');
    closeSettings();
    // 保存后重检知识库连通性：若已修正则解除锁定并刷新各功能区；否则保持锁定提示
    await loadProjects();
    if (state.ksOk) {
      await loadContext(); await loadReview(); await loadCommit(); await loadBackflow(); await loadScopes();
    }
  } else {
    toast('保存失败', 'err');
  }
});

// ---- 初始化 ----
(async () => {
  await loadSettings();
  await loadProjects();
  bindDraftEditModal();
  // 知识库未连接时仅保留配置提示与「系统设置」，不加载各功能区（避免无意义的失败请求）
  if (state.ksOk) {
    await loadContext(); await loadReview(); await loadCommit(); await loadBackflow(); await loadScopes();
  }
})();
