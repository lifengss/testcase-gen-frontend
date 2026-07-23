/* TestGen 前端业务逻辑 · 真实调用 BFF（testcase-gen-frontend/server） */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = { project: localStorage.getItem('tg_currentProject') || '', lastGenerated: '', scopeTree: [], funcTree: [] };
const LS_KEY = 'tg_currentProject';
let scopeMode = 'code';       // 'code' = 按代码模块；'func' = 按功能模块
let funcAvailable = false;    // 是否已上传 PRD/需求列表，可抽取功能模块
// 测试范围（代码模块）勾选/展开状态
let explicit = new Set();
let expandedSet = new Set();
// 测试范围（功能模块）勾选/展开状态
let explicitFunc = new Set();
let expandedFunc = new Set();

function toast(msg, type = '') {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + type;
  setTimeout(() => (t.className = 'toast ' + type), 2600);
}
function pickProject() { return state.project || 'default'; }

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
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}

// ---- 项目 ----
async function loadProjects() {
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
  if (!state.project || !list.find(p => p.id === state.project)) {
    const pref = list.find(p => p.id === 'testCaseGenerator') || list[0];
    if (pref) setProject(pref.id, pref.name);
  }
  // 项目空间卡片
  const grid = $('#projGrid'); grid.innerHTML = '';
  list.forEach(p => {
    const card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `<div class="k">${p.id}</div><div class="v" style="font-size:18px">${p.name}</div><div class="d">${p.brainPath}</div>`;
    card.onclick = () => setProject(p.id, p.name);
    grid.appendChild(card);
  });
  const ks = await api('GET', '/api/health');
  $('#ksChip').textContent = ks.ok ? '知识系统 已连接' : '知识系统 未连接';
  $('#ksStat').innerHTML = `<span class="led"></span>知识系统 ${ks.ok ? '已连接' : '断开'}`;
}
function setProject(id, name) {
  state.project = id; localStorage.setItem(LS_KEY, id);
  const p = (window.__projects || []).find(x => x.id === id);
  $('#psName').textContent = name || id; $('#psId').textContent = id;
  $('#sidePid').textContent = id; $('#footProj').textContent = '本地多项目 · 知识闭环 V1.0 · ' + id;
  $$('.ps-item').forEach(x => x.classList.toggle('on', x.querySelector('.m').textContent.startsWith(id)));
  loadContext(); loadReview(); loadCommit(); loadBackflow(); loadScopes();
}

// ---- 导航 ----
$$('.nav-item').forEach(n => n.onclick = () => {
  $$('.nav-item').forEach(x => x.classList.remove('active'));
  $$('.view').forEach(v => v.classList.remove('active'));
  n.classList.add('active');
  $('#view-' + n.dataset.view).classList.add('active');
  if (n.dataset.view === 'graph') loadGraph();
});
$('#psBtn').onclick = e => { e.stopPropagation(); $('#psMenu').classList.toggle('open'); };
document.addEventListener('click', () => $('#psMenu').classList.remove('open'));

// ---- 生成配置交互 ----
function bindSeg(id){ $$(`#${id} button`).forEach(b => b.onclick = () => { $$(`#${id} button`).forEach(x=>x.classList.remove('on')); b.classList.add('on'); }); }
bindSeg('genSeg'); bindSeg('depthSeg');
// 测试范围「全选」复选框（默认选中；取消则清空所有模块）
const selAllChk = $('#scopeSelectAll');
if (selAllChk) selAllChk.onchange = () => setScopeSelectAll(selAllChk.checked);
// 测试范围标签页：按代码模块 / 按功能模块
$$('#scopeTabs button').forEach(b => b.onclick = () => onScopeTab(b.dataset.t, b));
// 测试范围模块树：从图谱派生（代码模块）/ 从项目描述 Wiki 抽取（功能模块），可展开复选
async function loadScopes() {
  explicit = new Set(); expandedSet = new Set();
  const gd = await api('GET', '/api/graph-data');
  const nodes = (gd.data && gd.data.data && gd.data.data.nodes) || [];
  const modules = nodes.filter(n => n.type === 'module');
  let tree = modules.map(m => ({
    id: m.id, label: m.label.replace(/^api-/, ''), type: 'module',
    children: nodes.filter(n => n.type === 'function' && n.module === m.id)
      .map(f => ({ id: f.id, label: f.label, type: 'function' }))
  }));
  if (!tree.length) tree = ['auth', 'order', 'payment', 'inventory'].map(x => ({ id: x, label: x, type: 'module', children: [] }));
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
  if (!state.scopeTree.length) { root.innerHTML = '<div class="scope-hint">加载中…</div>'; return; }
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
  const st = (stats && stats.data) || {};
  $('#ctxTC').textContent = (st['test-cases'] && st['test-cases'].count) || 0;
  $('#ctxSC').textContent = (st['test-scripts'] && st['test-scripts'].count) || 0;
  const gd = await api('GET', '/api/graph-data');
  const graph = (gd.data && gd.data.data) || { nodes: [], edges: [] };
  $('#ctxND').textContent = (graph.nodes || []).length;
  const refs = $('#ctxRefs'); refs.innerHTML = '<div class="ref muted">提交生成后展示检索命中</div>';
  renderMiniGraph(graph);
}
// 把检索命中渲染进侧栏「命中参考」，按 kind 分组（history/rule/wiki/dep）
function renderHits(hits) {
  const box = $('#ctxRefs'); if (!box) return;
  box.innerHTML = '';
  if (!hits || !hits.length) { box.innerHTML = '<div class="ref muted">本次检索无命中</div>'; return; }
  const labels = { history: '历史用例', rule: '质量门禁', wiki: '项目Wiki', dep: '代码依赖' };
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
    <div class="actions"><button class="btn btn-ghost btn-sm" data-act="del">删除</button><button class="btn btn-primary btn-sm" data-act="commit">入库</button></div>`;
  el.querySelector('[data-act=commit]').onclick = () => commitOne(d.id);
  el.querySelector('[data-act=del]').onclick = () => delDraft(d.id);
  return el;
}
async function loadReview() {
  const r = await api('GET', '/api/drafts', { query: { source: 'human_edit', limit: 100 } });
  const list = asArray(r.data);
  const box = $('#reviewList'); box.innerHTML = '';
  (list.length ? list : []).forEach(d => box.appendChild(draftCard(d)));
  if (!list.length) box.innerHTML = '<div class="card"><div class="d">暂无人工编辑草稿</div></div>';
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
  const { ok } = await api('POST', '/api/drafts', { body: { source: 'exec_backflow', type: 'defect_rule', title: '执行回流：' + f.name, content, metadata: { failureType: 'report_parse', fileName: f.name } } });
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

// ---- 知识图谱（全量）----
async function loadGraph() {
  const gd = await api('GET', '/api/graph-data');
  const g = (gd.data && gd.data.data) || { nodes: [], edges: [] };
  const wrap = $('#fullGraph');
  wrap.style.position = 'relative';
  wrap.style.minHeight = '520px';
  renderInteractiveGraph(wrap, g);
}

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
    fillSettings(data);
    const ksChip = document.getElementById('ksChip');
    if (ksChip) ksChip.textContent = 'KS ' + ((data.ks && data.ks.apiBase) || '—');
  }
}
function openSettings() { loadSettings(); setTestMsg.textContent = ''; setTestMsg.className = 'test-msg'; settingsModal.classList.add('open'); }
function closeSettings() { settingsModal.classList.remove('open'); }

if (gearBtn) gearBtn.addEventListener('click', openSettings);
const settingsClose = document.getElementById('settingsClose');
if (settingsClose) settingsClose.addEventListener('click', closeSettings);
if (settingsModal) settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
if (setAiProvider) setAiProvider.addEventListener('change', () => { syncProviderUI(); if (setAiProvider.value === 'codebuddy' && cbBuiltin.checked) loadCbModels(cbModel.value); });
if (cbBuiltin) cbBuiltin.addEventListener('change', () => { syncProviderUI(); if (cbBuiltin.checked) loadCbModels(cbModel.value); });
if (cbCustom) cbCustom.addEventListener('change', syncProviderUI);
const setTest = document.getElementById('setTest');
if (setTest) setTest.addEventListener('click', async () => {
  setTestMsg.textContent = '连接中…'; setTestMsg.className = 'test-msg';
  const { ok, data } = await api('POST', '/api/settings/test', { body: { ksApiBase: setKsApi.value.trim() } });
  if (ok && data && data.reachable) { setTestMsg.textContent = '✓ KS 可达'; setTestMsg.className = 'test-msg ok'; }
  else { setTestMsg.textContent = '✗ ' + ((data && data.error) || '不可达'); setTestMsg.className = 'test-msg err'; }
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
    },
  };
  const { ok, data } = await api('PUT', '/api/settings', { body: payload });
  if (ok && data) {
    fillSettings(data);
    const ksChip = document.getElementById('ksChip');
    if (ksChip) ksChip.textContent = 'KS ' + ((data.ks && data.ks.apiBase) || '—');
    toast('设置已保存（即时生效，无需重启）', 'ok');
    closeSettings();
  } else {
    toast('保存失败', 'err');
  }
});

// ---- 初始化 ----
(async () => {
  await loadSettings();
  const r = await api('GET', '/api/projects');
  window.__projects = (r.data && r.data.data && r.data.data.projects) || [];
  await loadProjects();
  await loadContext(); await loadReview(); await loadCommit(); await loadBackflow(); await loadScopes();
})();
