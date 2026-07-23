/* TestGen 前端业务逻辑 · 真实调用 BFF（testcase-gen-frontend/server） */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = { project: localStorage.getItem('tg_currentProject') || '' };
const LS_KEY = 'tg_currentProject';

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
  loadContext(); loadReview(); loadCommit(); loadBackflow();
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
$$('#scopeChips .chip-toggle').forEach(c => c.onclick = () => c.classList.toggle('on'));

// ---- 知识上下文（生成中心侧栏）----
async function loadContext() {
  const tc = await api('GET', '/api/brain/pages', { query: { category: 'test-cases', limit: 50 } });
  const tcList = asArray(tc.data);
  $('#ctxTC').textContent = tcList.length;
  const qr = await api('GET', '/api/brain/pages', { query: { category: 'quality-rules', limit: 50 } });
  $('#ctxSC').textContent = asArray(qr.data).length;
  const gd = await api('GET', '/api/graph-data');
  const graph = (gd.data && gd.data.data) || { nodes: [], edges: [] };
  $('#ctxND').textContent = (graph.nodes || []).length;
  const refs = $('#ctxRefs'); refs.innerHTML = '';
  tcList.slice(0, 8).forEach(p => { const d = document.createElement('div'); d.className = 'ref'; d.innerHTML = `<b>TC</b> · ${p.title}`; refs.appendChild(d); });
  renderMiniGraph(graph);
}
function renderMiniGraph(graph) {
  const c = $('#miniGraph'); if (!c) return;
  c.innerHTML = renderGraphSVG(graph, 280, 200);
}
function renderGraphSVG(graph, W, H) {
  const nodes = graph.nodes || []; const edges = graph.edges || [];
  if (!nodes.length) return '<svg viewBox="0 0 280 160"><text x="140" y="80" fill="#5E6B82" font-size="11" text-anchor="middle">暂无图谱数据</text></svg>';
  const R = 70, cx = W / 2, cy = H / 2 + 10;
  const pos = {};
  nodes.forEach((n, i) => { const a = (i / nodes.length) * Math.PI * 2; pos[n.id] = [cx + R * Math.cos(a), cy + R * Math.sin(a)]; });
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  edges.forEach(e => {
    const a = pos[e.source || e.from], b = pos[e.target || e.to];
    if (a && b) s += `<line class="edge" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`;
  });
  nodes.forEach(n => { const [x, y] = pos[n.id]; const acc = (n.type === 'core' || n.accent) ? ' acc' : '';
    s += `<circle class="node${acc}" cx="${x}" cy="${y}" r="14"/><text x="${x}" y="${y + 4}" fill="#E8EDF6" font-size="8" text-anchor="middle" font-family="monospace">${(n.label || n.id).slice(0, 6)}</text>`; });
  return s + '</svg>';
}

// ---- 生成（路径 A）----
$('#genBtn').onclick = async () => {
  const op = $('#genSeg button.on').dataset.t;
  const depth = $('#depthSeg button.on').dataset.t;
  const modules = $$('#scopeChips .chip-toggle.on').map(c => c.textContent);
  const framework = $('#fwSel').value.split(' ')[0];
  const note = $('#noteTa').value;
  $('#streamTag').textContent = op + ' · ' + pickProject();
  $('#streamBody').innerHTML = '<div style="color:var(--aurora-1);font-size:12px">▸ 采集知识上下文并调用 AI 平台生成<span class="cursor"></span></div>';
  const { ok, data } = await api('POST', '/api/generate', { body: { op, scope: { modules, depth }, constraints: { framework, note } } });
  if (!ok) { $('#streamBody').innerHTML = `<div class="tc" style="color:var(--danger)">生成失败：${data.error || ''}</div>`; toast('生成失败', 'err'); return; }
  const d = data.data || {};
  $('#streamMeta').textContent = `引擎 ${d.engine} · 用例 ${d.contextUsed?.testCases || 0} / 脚本 ${d.contextUsed?.qualityRules || 0} / 节点 ${d.contextUsed?.graphNodes || 0}`;
  $('#streamBody').innerHTML = `<div class="tc">${escapeHtml(d.content || '')}</div>`;
  toast('生成完成（' + d.engine + '）', 'ok');
  loadReview(); loadCommit();
};

// ---- 上传代码 / PRD（路径 B）----
$('#codeFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const form = new FormData(); form.append('file', f); form.append('type', 'code'); form.append('project', pickProject());
  const { ok, data } = await api('POST', '/api/source-upload', { form });
  if (ok) { toast('代码已上传并解析：' + ((data.data && data.data.summary) || ''), 'ok'); loadContext(); }
  else toast('上传失败：' + (data.error || ''), 'err');
};
$('#prdFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const title = $('#prdTitle').value || f.name;
  const form = new FormData(); form.append('file', f); form.append('type', 'prd'); form.append('project', pickProject()); form.append('note', title);
  const { ok } = await api('POST', '/api/source-upload', { form });
  if (ok) { toast('PRD 已上传：' + title, 'ok'); loadContext(); }
  else toast('上传失败', 'err');
};

// ---- 草稿审阅 / 入库看板 ----
function draftCard(d, withBatch) {
  const el = document.createElement('div'); el.className = 'draft';
  el.innerHTML = `<div class="top"><span class="title">${d.title || '(无标题)'}</span><span class="badge">${d.source || ''} · ${d.type || ''}</span></div>
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
  const R = Math.min(W, H) * 0.35;
  nodes.forEach((n, i) => {
    const a = (i / nodes.length) * Math.PI * 2;
    n.x = W/2 + R * Math.cos(a);
    n.y = H/2 + R * Math.sin(a);
  });
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
  setTimeout(() => fitView(graphState), 100);
}

function startSimulation(nodes, edges) {
  let running = true;
  const alpha = 0.3, alphaDecay = 0.02, alphaMin = 0.01;
  let currAlpha = alpha;
  function step() {
    if (!running || currAlpha < alphaMin) { graphState.simulation = null; return; }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.sqrt(dx*dx + dy*dy) || 1;
        const force = 8000 / (dist * dist);
        const fx = (dx / dist) * force * currAlpha;
        const fy = (dy / dist) * force * currAlpha;
        if (!a.fx) { a.vx -= fx; a.vy -= fy; }
        if (!b.fx) { b.vx += fx; b.vy += fy; }
      }
    }
    edges.forEach(e => {
      const a = nodes.find(n => n.id === e.source);
      const b = nodes.find(n => n.id === e.target);
      if (!a || !b) return;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx*dx + dy*dy) || 1;
      const force = (dist - 100) * 0.005 * currAlpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!a.fx) { a.vx += fx; a.vy += fy; }
      if (!b.fx) { b.vx -= fx; b.vy -= fy; }
    });
    const cx = graphState.width / 2, cy = graphState.height / 2;
    nodes.forEach(n => {
      if (n.fx) return;
      const dx = cx - n.x, dy = cy - n.y;
      n.vx += dx * 0.0005 * currAlpha;
      n.vy += dy * 0.0005 * currAlpha;
    });
    nodes.forEach(n => {
      if (n.fx) { n.x = n.fx; n.y = n.fy; }
      else { n.vx *= 0.5; n.vy *= 0.5; n.x += n.vx; n.y += n.vy; }
    });
    currAlpha -= alphaDecay;
    updateGraphView();
    graphState.simulation = requestAnimationFrame(step);
  }
  graphState.simulation = requestAnimationFrame(step);
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
    graphState.dragging.fx = x; graphState.dragging.fy = y;
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
// 兼容多种返回结构：data:[...] / data.data:[...] / data.data.drafts:[...] / data.data.items:[...]
function asArray(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.data)) return d.data;
  if (d && d.data && Array.isArray(d.data.drafts)) return d.data.drafts;
  if (d && d.data && Array.isArray(d.data.items)) return d.data.items;
  return [];
}

// ---- 初始化 ----
(async () => {
  const r = await api('GET', '/api/projects');
  window.__projects = (r.data && r.data.data && r.data.data.projects) || [];
  await loadProjects();
  await loadContext(); await loadReview(); await loadCommit(); await loadBackflow();
})();
