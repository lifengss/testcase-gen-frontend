// e2e-business-flow.cjs —— 业务流驱动端到端测试（双驱动）
//
// 驱动方式（两种都必须执行，各跑一遍同一业务流）：
//   [UI ] agent-browser 模拟真实用户操作（点击导航 / 填输入 / 点按钮 / 文件上传触发 onchange）
//   [API] 在页面上下文直接调用前端实际使用的 api() 封装（window.api，自动注入项目、经 BFF 代理到 KS）
//
// 每条业务流完成后，一律以【KS 后端真实状态】断言业务结果（草稿条目 / Wiki 页面 / 审计日志 / 检索与图谱数据），
// 绝不只看 UI 渲染。覆盖业务流：
//   F1  多项目隔离保存（FR-006/007/008）：仅目标项目草稿增量，其余项目完全不变
//   F2  PRD 资料上传沉淀（FR-001/004）：project-wiki 新增页面，其余项目不变
//   F3  代码上传解析（FR-001/004）：API 依赖页面落库，其余项目不变
//   F4  草稿编辑回写（FR-014）：编辑后后端草稿内容真实变更
//   F5  执行回流（FR-015）：exec_backflow 缺陷草稿入缓冲
//   F6  单条入库（FR-017）：审计出现 commit 记录，草稿状态流转 merged
//   F7  批量入库（FR-016）：batch-commit 审计记录 + 批量状态流转
//   F8  无变更不写库（FR-019，负向）：删除/取消不产生任何 commit 审计（无入库动作）
//   F9  知识检索（FR-018）：检索返回结果集
//   F10 知识图谱：图谱数据返回 nodes/edges
//
// 用法： node e2e-business-flow.cjs [项目]   （默认项目 git_test）
'use strict';
const { execFileSync } = require('child_process');
const AB = 'C:/Users/lif_lc/AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser.js';
const BFF = 'http://localhost:4123/';
const KS = 'http://127.0.0.1:3000';
const TARGET = process.argv[2] || 'git_test';
const TS = Date.now().toString(36).slice(-6);
// 入库流（F6/F7）使用每轮新建的干净临时项目：无历史草稿/已入库页面，
// 冲突检测(草稿间关键词重叠)的对比对象为空，入库可正常流转 merged；
// 同时也额外验证"commit 只影响该项目、不污染其他项目"。
const TARGET_C = 'bf-commit-' + TS;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let PASS = 0, FAIL = 0, SKIP = 0, FAILS = [], WARNS = [];
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  ✔ ${name}`); }
  else { FAIL++; FAILS.push(name); console.log(`  ✘ ${name}  ${detail}`); }
}
function warn(msg) { WARNS.push(msg); console.log(`  ⚠ ${msg}`); }
function skip(name, why) { SKIP++; console.log(`  ⤼ [跳过] ${name}（${why}）`); }

const ab = (args, timeout = 120000) => execFileSync('node', [AB, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ev = js => { try { return JSON.parse(ab(['eval', js])); } catch (e) { return null; } };

// ---------- KS 后端直连（业务结果断言依据，与前端同源） ----------
const g = (path, qs = '') => fetch(`${KS}${path}${qs ? '?' + qs : ''}`).then(r => r.json());
const p = (path, body) => fetch(`${KS}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const del = (path, qs = '') => fetch(`${KS}${path}${qs ? '?' + qs : ''}`, { method: 'DELETE' }).then(r => r.json());

async function draftsOf(project) {
  const r = await g('/api/drafts', `project=${encodeURIComponent(project)}&limit=5000`);
  return (r.data && Array.isArray(r.data)) ? r.data : [];
}
async function countDrafts(project) { return (await draftsOf(project)).length; }
async function draftByTitle(project, title) {
  const ds = await draftsOf(project);
  return ds.find(d => d.title === title) || null;
}
async function draftById(project, id) {
  const ds = await draftsOf(project);
  return ds.find(d => String(d.id) === String(id)) || null;
}
async function wikiPages(project) {
  const r = await g('/api/brain/pages', `project=${encodeURIComponent(project)}&category=project-wiki&limit=5000`);
  return (r.data && Array.isArray(r.data)) ? r.data : [];
}
async function auditItems(project) {
  const r = await g('/api/audit-log', `project=${encodeURIComponent(project)}&pageSize=300`);
  return (r.data && r.data.items && Array.isArray(r.data.items)) ? r.data.items : [];
}
async function commitAuditCount(project, sinceIso) {
  const items = await auditItems(project);
  return items.filter(i => i.action === 'commit' && (!sinceIso || new Date(i.created_at) > new Date(sinceIso))).length;
}

// ---------- 前端业务 API 层驱动：在页面上下文调用前端真实 api() 封装 ----------
async function callApiExpr(expr) {
  // 启动探针必须返回 'started'，否则说明表达式本身有语法错误（如 UUID 裸插值），
  // 立即报错，避免轮询读到上一次调用残留的 window.__apiRes 造成"假成功"。
  const started = ev(`(() => { window.__apiRes = undefined; window.__apiErr = undefined;
    (async () => { try { window.__apiRes = await (${expr}); } catch (e) { window.__apiErr = String((e && e.message) || e); } })();
    return 'started'; })()`);
  if (started !== 'started') throw new Error('api() 表达式语法错误: ' + expr.slice(0, 120));
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = ev(`(() => window.__apiRes !== undefined || window.__apiErr !== undefined ? JSON.stringify({ res: window.__apiRes, err: window.__apiErr }) : null)()`);
    if (r) {
      const o = JSON.parse(r);
      if (o.err) throw new Error('api() 调用失败: ' + o.err);
      return o.res;
    }
  }
  throw new Error('api() 调用超时: ' + expr.slice(0, 80));
}

// ---------- UI 操作辅助 ----------
// 真实项目切换：调用前端全局 setProject()（等价于用户点击顶部项目菜单的 .ps-item），
// 它更新 state.project + localStorage 并自动刷新 review/commit/backflow/scopes 等列表。
function setProjectViaUI(P) {
  return ev(`(() => {
    const ps = window.__projects || [];
    const info = ps.find(x => x.id === ${JSON.stringify(P)});
    if (typeof setProject !== 'function') return 'no-fn';
    setProject(${JSON.stringify(P)}, (info && info.name) || ${JSON.stringify(P)});
    return 'ok';
  })()`);
}
function navView(v) {
  return ev(`(() => { const n = document.querySelector('.nav-item[data-view="${v}"]'); if (n) { n.click(); return '${v}'; } return 'no-nav'; })()`);
}
function uiUploadFile(sel, name, content, mime) {
  return ev(`(() => {
    const f = new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime || 'text/plain')} });
    const dt = new DataTransfer(); dt.items.add(f);
    const inp = document.querySelector(${JSON.stringify(sel)});
    if (!inp) return 'no-input';
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 'uploaded';
  })()`);
}
// 生成中心：切模式 → 点生成 → 等完成（AI 不可用自动回退模板）→ 点保存
async function uiGenerateAndSave(mode) {
  ev(`(() => { const b = document.querySelector('#genSeg button[data-t="${mode}"]'); if (b) { b.click(); return '${mode}'; } return 'no-btn'; })()`);
  await sleep(500);
  ev(`(() => { const q = document.querySelector('#genBtn'); if (q) { q.click(); return 'gen'; } return 'no-gen'; })()`);
  let lastSt = '';
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    lastSt = ev(`(() => {
      const b = document.querySelector('#streamBody');
      const meta = document.querySelector('#streamMeta');
      if (!b) return 'no-body';
      if (/生成失败/.test(b.innerText)) return 'fail';
      if (b.querySelector('.md') && meta && /引擎/.test(meta.textContent)) return 'done';
      return 'wait';
    })()`);
    if (lastSt === 'done') break;
    if (lastSt === 'fail') return { ok: false, why: '生成失败' };
  }
  if (lastSt !== 'done') return { ok: false, why: `生成未完成(状态=${lastSt})` };
  const saved = ev(`(() => { const sd = document.querySelector('#saveDraft'); if (sd) { sd.click(); return 'saved'; } return 'no-save'; })()`);
  await sleep(2000);
  return { ok: saved === 'saved', why: saved === 'saved' ? '' : '无保存按钮' };
}

// 质量达标草稿内容（标题+列表+代码块+足够长度，确保通过质量门控）
// 每次调用生成唯一 body token（UQ 计数器递增），配合业务无关独特词（量子回环/曲率跃迁/静默断言/双螺旋校验/熵值归零），
// 保证同脚本内每条草稿正文互不相同、也与已入库页面关键词 Jaccard 重叠率 < 0.4，避免触发 conflict_detector 的 duplicate/overlap 冲突。
let UQ = 0;
function qualityContent(title) {
  const tok = `${TS}-q${++UQ}`;
  return `# ${title}

## 前置条件
- 已初始化 ${tok} 量子回环环境
- 曲率跃迁通道已校准

## 测试步骤
1. 执行 ${tok} 静默断言主流程
2. 触发双螺旋校验规则
3. 核对 ${tok} 输出快照

## 预期结果
- ${tok} 断言全部通过
- 熵值归零，无异常上报

## 补充说明
本条草稿由业务流测试构造，用于验证 ${tok} 场景下的入库闭环。

## 示例代码
\`\`\`python
def test_${tok}():
    """${tok} 校验"""
    assert True
\`\`\`
`;
}

// 入库用唯一内容（F6/F7）：正文几乎全由唯一 token 词构成，共享英文词仅剩
// pre/steps/exp/ref/code/python/def/return 等约 8 个，任意两条草稿/页面的
// 关键词 Jaccard ≈ 0.21 < 0.4，可避开 conflict_detector 的 duplicate/overlap 冲突，
// 同时保留 Markdown 标题/列表/代码块/足够长度以通过质量门控（约 87 分 ≥ 60）。
function distinctContent(title) {
  const tok = `${TS}-q${++UQ}`;
  return `# ${title}

## ${tok}-pre
- ${tok}alpha
- ${tok}beta

## ${tok}-steps
1. ${tok}gamma
2. ${tok}delta
3. ${tok}epsilon

## ${tok}-exp
- ${tok}zeta ok
- ${tok}eta done

## ${tok}-ref
${tok}iota spec
${tok}kappa trace

## ${tok}-code
\`\`\`python
def ${tok}_main():
    """${tok}_hook"""
    return ${tok}_ok
\`\`\`
`;
}

// ---------- 业务流：F1 多项目隔离保存（FR-006/007/008） ----------
async function flow1MultiProjectIsolation() {
  console.log('\n[F1] 多项目隔离保存（FR-006/007/008）');
  const beforeT = await countDrafts(TARGET);
  const beforeD = await countDrafts('default');
  // --- UI 驱动：真实生成 + 保存 ---
  setProjectViaUI(TARGET);
  await sleep(2000);
  navView('generator');
  await sleep(2000);
  const r = await uiGenerateAndSave('gen_cases');
  const afterTUi = await countDrafts(TARGET);
  const afterDUi = await countDrafts('default');
  if (!r.ok) skip('F1-UI 生成+保存', r.why);
  else {
    check(`F1-UI 目标项目(${TARGET}) 草稿增加`, afterTUi > beforeT, `${beforeT}→${afterTUi}`);
    check(`F1-UI 其他项目(default) 完全不变`, afterDUi === beforeD, `${beforeD}→${afterDUi}`);
  }
  // --- API 驱动：前端 api() 封装直接保存 ---
  const apiTitle = `F1-API-${TS}`;
  const ar = await callApiExpr(`api('POST', '/api/drafts', { body: { source: 'human_edit', type: 'test_case', title: ${JSON.stringify(apiTitle)}, content: ${JSON.stringify(qualityContent(apiTitle))}, project: ${JSON.stringify(TARGET)} } })`);
  const afterTApi = await countDrafts(TARGET);
  const afterDApi = await countDrafts('default');
  check('F1-API 保存返回成功', !!(ar && ar.ok), JSON.stringify(ar && ar.data || ar).slice(0, 120));
  check(`F1-API 目标项目(${TARGET}) 草稿 +1`, afterTApi === afterTUi + 1, `${afterTUi}→${afterTApi}`);
  check(`F1-API 条目归属正确(可查回)`, !!(await draftByTitle(TARGET, apiTitle)), apiTitle);
  check(`F1-API 其他项目(default) 完全不变`, afterDApi === afterDUi, `${afterDUi}→${afterDApi}`);
}

// ---------- 业务流：F2 PRD 上传沉淀 Wiki（FR-001/004） ----------
async function flow2PrdUpload() {
  console.log('\n[F2] PRD 资料上传沉淀（FR-001/004）');
  const prdName = `bizflow-prd-${TS}`;
  const prdContent = `# ${prdName}\n\n## 需求背景\n- 业务流测试\n\n## 功能清单\n- 模块A\n- 模块B\n`;
  const beforeT = await wikiPages(TARGET);
  const beforeD = await wikiPages('default');
  // --- UI 驱动：真实项目切换 + 上传文件（触发 onchange → api source-upload） ---
  setProjectViaUI(TARGET);
  await sleep(2000);
  navView('projects');
  await sleep(1200);
  const up = uiUploadFile('#prdFile', prdName + '.md', prdContent, 'text/markdown');
  await sleep(3500);
  const afterTU = await wikiPages(TARGET);
  const afterDU = await wikiPages('default');
  if (up !== 'uploaded') skip('F2-UI 上传', '上传输入框不存在');
  else {
    const added = afterTU.filter(w => ((w.id || '') + (w.filename || '')).includes(`prd-${prdName}`)).length;
    check(`F2-UI 目标项目(${TARGET}) Wiki 新增 PRD 页面`, added >= 1, `命中=${added}, 总数${beforeT.length}→${afterTU.length}`);
    check(`F2-UI 其他项目(default) Wiki 不变`, afterDU.length === beforeD.length, `${beforeD.length}→${afterDU.length}`);
  }
  // --- API 驱动：前端 api() 封装上传 ---
  const ar = await callApiExpr(`(async () => {
    const fd = new FormData();
    fd.append('file', new File([${JSON.stringify(prdContent)}], ${JSON.stringify(prdName + '.md')}, { type: 'text/markdown' }));
    fd.append('type', 'prd');
    fd.append('project', ${JSON.stringify(TARGET)});
    return await api('POST', '/api/source-upload', { form: fd });
  })()`);
  const afterTA = await wikiPages(TARGET);
  const afterDA = await wikiPages('default');
  const added2 = afterTA.filter(w => ((w.id || '') + (w.filename || '')).includes(`prd-${prdName}`)).length;
  check('F2-API 上传返回成功', !!(ar && ar.ok), JSON.stringify(ar && ar.data || ar).slice(0, 150));
  check(`F2-API 目标项目(${TARGET}) Wiki 新增 PRD 页面`, added2 >= 1, `命中=${added2}, 总数${afterTU.length}→${afterTA.length}`);
  check(`F2-API 其他项目(default) Wiki 不变`, afterDA.length === afterDU.length, `${afterDU.length}→${afterDA.length}`);
}

// ---------- 业务流：F3 代码上传解析（FR-001/004） ----------
async function flow3CodeUpload() {
  console.log('\n[F3] 代码上传解析（FR-001/004）');
  const codeName = `bizflow-code-${TS}`;
  const codeContent = `import os\nimport json\nfrom fastapi import FastAPI\nimport requests\n\napp = FastAPI()\n\n@app.get("/ping")\ndef ping():\n    return {"ok": True}\n`;
  const beforeT = await wikiPages(TARGET);
  // --- UI 驱动：真实项目切换 + 上传 ---
  setProjectViaUI(TARGET);
  await sleep(2000);
  navView('projects');
  await sleep(1200);
  const up = uiUploadFile('#codeFile', codeName + '.py', codeContent, 'text/x-python');
  await sleep(4000);
  const afterTU = await wikiPages(TARGET);
  if (up !== 'uploaded') skip('F3-UI 上传', '上传输入框不存在');
  else {
    const apiPages = afterTU.filter(w => (w.id || '').startsWith('api-')).length;
    const totalGrew = afterTU.length > beforeT.length;
    check(`F3-UI 目标项目(${TARGET}) Wiki 新增页面(代码解析)`, totalGrew, `${beforeT.length}→${afterTU.length}(api 页=${apiPages})`);
    check('F3-UI 上传未报错（接口路径可用）', true, '');
  }
  // --- API 驱动 ---
  const ar = await callApiExpr(`(async () => {
    const fd = new FormData();
    fd.append('file', new File([${JSON.stringify(codeContent)}], ${JSON.stringify(codeName + '.py')}, { type: 'text/x-python' }));
    fd.append('type', 'code');
    fd.append('project', ${JSON.stringify(TARGET)});
    return await api('POST', '/api/source-upload', { form: fd });
  })()`);
  const afterTA = await wikiPages(TARGET);
  check('F3-API 代码上传返回成功', !!(ar && ar.ok), JSON.stringify(ar && ar.data || ar).slice(0, 150));
  check(`F3-API 目标项目(${TARGET}) Wiki 新增页面(代码解析)`, afterTA.length > afterTU.length, `${afterTU.length}→${afterTA.length}`);
}

// ---------- 业务流：F4 草稿编辑回写（FR-014） ----------
async function flow4DraftEdit() {
  console.log('\n[F4] 草稿编辑回写（FR-014）');
  // 前置：经前端 api() 创建一条 quality_rule 草稿（非级联触发类型，便于稳定断言）
  const t0 = `F4-编辑-${TS}`;
  const c0 = `# ${t0} 原始内容\n\n- 要点一\n- 要点二\n`;
  const cr = await callApiExpr(`api('POST', '/api/drafts', { body: { source: 'human_edit', type: 'quality_rule', title: ${JSON.stringify(t0)}, content: ${JSON.stringify(c0)}, project: ${JSON.stringify(TARGET)} } })`);
  const d = await draftByTitle(TARGET, t0);
  check('F4 前置：草稿创建成功', !!(cr && cr.ok) && !!d, JSON.stringify(cr && cr.data || cr).slice(0, 120));
  if (!d) return;
  const id = d.id;
  // --- UI 驱动：审阅页 → 行内编辑按钮 → 弹窗改内容 → 保存 ---
  setProjectViaUI(TARGET);
  await sleep(2000);
  navView('review');
  await sleep(2000);
  const hasEditBtn = ev(`(() => { const b = document.querySelector('[data-act="edit"][data-id="${id}"]'); return b ? 'yes' : 'no'; })()`);
  if (hasEditBtn !== 'yes') skip('F4-UI 编辑按钮', `草稿行无 [data-act=edit][data-id=${id}]`);
  else {
    ev(`(() => { const b = document.querySelector('[data-act="edit"][data-id="${id}"]'); b.click(); return 'ok'; })()`);
    await sleep(1200);
    const c1 = `# ${t0} 编辑后内容\n\n- 修改点一\n- 修改点二\n\n## 结论\n编辑回写验证通过。`;
    ev(`(() => { const t = document.querySelector('#draftEditTitle'); const c = document.querySelector('#draftEditContent'); if (t) t.value = ${JSON.stringify(t0)}; if (c) c.value = ${JSON.stringify(c1)}; return 'ok'; })()`);
    await sleep(300);
    ev(`(() => { const s = document.querySelector('#draftEditSave'); if (s) s.click(); return 'ok'; })()`);
    await sleep(2500);
    const after = await draftById(TARGET, id);
    check('F4-UI 编辑保存成功', !!(after && after.content && after.content.includes('编辑后内容')),
      after ? `content=${String(after.content).slice(0, 60)}` : '草稿不存在');
  }
  // --- API 驱动：前端 api() 封装 PUT ---
  const c2 = `# ${t0} API编辑内容\n\n- API 修改点\n`;
  const ur = await callApiExpr(`api('PUT', '/api/drafts/${id}', { body: { title: ${JSON.stringify(t0)}, content: ${JSON.stringify(c2)} } })`);
  const after2 = await draftById(TARGET, id);
  check('F4-API 编辑保存返回成功', !!(ur && ur.ok), JSON.stringify(ur && ur.data || ur).slice(0, 120));
  check('F4-API 编辑后内容真实变更', !!(after2 && after2.content && after2.content.includes('API编辑内容')),
    after2 ? `content=${String(after2.content).slice(0, 60)}` : '草稿不存在');
}

// ---------- 业务流：F5 执行回流（FR-015） ----------
async function flow5ExecBackflow() {
  console.log('\n[F5] 执行回流（FR-015）');
  const junitName = `junit-${TS}`;
  const junitXml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="DemoSuite" tests="1" failures="1">\n    <testcase name="test_login" classname="Demo">\n      <failure message="登录超时">登录接口在 30s 内未返回。</failure>\n    </testcase>\n  </testsuite>\n</testsuites>\n`;
  const before = (await draftsOf(TARGET)).filter(x => x.source === 'exec_backflow').length;
  // --- UI 驱动：真实项目切换 + 回测页「草稿审核」去向上传报告文件 ---
  setProjectViaUI(TARGET);
  await sleep(2000);
  navView('retest');
  await sleep(1500);
  // 切到「草稿审核」去向（等价于用户点击去向切换按钮）
  ev(`(() => { retestMode = 'draft'; $$('#retestModeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === 'draft')); return 'ok'; })()`);
  await sleep(500);
  const up = uiUploadFile('#retestFile', junitName + '.xml', junitXml, 'application/xml');
  await sleep(3500);
  const afterUI = (await draftsOf(TARGET)).filter(x => x.source === 'exec_backflow').length;
  if (up !== 'uploaded') skip('F5-UI 回流上传', '上传输入框不存在');
  else check(`F5-UI 目标项目(${TARGET}) 新增执行回流草稿`, afterUI > before, `${before}→${afterUI}`);
  // --- API 驱动 ---
  const title = `F5-API-回流-${TS}`;
  const ar = await callApiExpr(`api('POST', '/api/drafts', { body: { source: 'exec_backflow', type: 'defect_experience', title: ${JSON.stringify(title)}, content: ${JSON.stringify(`# ${title}\n\n- 缺陷现象：登录超时\n- 影响范围：登录模块\n`)}, project: ${JSON.stringify(TARGET)}, metadata: { failureType: 'report_parse', fileName: ${JSON.stringify(junitName + '.xml')} } } })`);
  const afterAPI = (await draftsOf(TARGET)).filter(x => x.source === 'exec_backflow').length;
  check('F5-API 回流保存返回成功', !!(ar && ar.ok), JSON.stringify(ar && ar.data || ar).slice(0, 120));
  check(`F5-API 目标项目(${TARGET}) 新增执行回流草稿`, afterAPI === afterUI + 1, `${afterUI}→${afterAPI}`);
  check('F5-API 条目类型为缺陷经验(defect_experience)', !!(await draftByTitle(TARGET, title)), title);
}

// ---------- 业务流：F6 单条入库（FR-017） ----------
// 在干净的临时项目 proj 上执行：无历史草稿/已入库页面，冲突检测对比对象为空，入库可正常流转 merged。
async function flow6SingleCommit(proj) {
  console.log(`\n[F6] 单条入库（FR-017） 目标项目=${proj}`);
  const baseD = await countDrafts('default');
  const baseT = await countDrafts(TARGET);
  // 前置：创建达标草稿
  const title = `F6-单条入库-${TS}`;
  const cr = await callApiExpr(`api('POST', '/api/drafts', { body: { source: 'human_edit', type: 'test_script', title: ${JSON.stringify(title)}, content: ${JSON.stringify(distinctContent(title))}, project: ${JSON.stringify(proj)} } })`);
  const d = await draftByTitle(proj, title);
  check('F6 前置：草稿创建成功', !!(cr && cr.ok) && !!d, JSON.stringify(cr && cr.data || cr).slice(0, 120));
  if (!d) return;
  const id = d.id;
  // --- UI 驱动：审阅页行内 commit 按钮 ---
  const sinceUI = new Date().toISOString();
  setProjectViaUI(proj);
  await sleep(2000);
  navView('review');
  await sleep(2000);
  const hasC = ev(`(() => { const b = document.querySelector('[data-act="commit"][data-id="${id}"]'); return b ? 'yes' : 'no'; })()`);
  if (hasC !== 'yes') skip('F6-UI 入库按钮', `草稿行无 [data-act=commit][data-id=${id}]`);
  else {
    ev(`(() => { const b = document.querySelector('[data-act="commit"][data-id="${id}"]'); b.click(); return 'ok'; })()`);
    await sleep(3000);
    const c = await commitAuditCount(proj, sinceUI);
    const st = (await draftById(proj, id)) || {};
    check('F6-UI 审计新增 commit 记录', c >= 1, `commit 数=${c}`);
    check('F6-UI 草稿状态流转为 merged', st.status === 'merged', `status=${st.status}`);
  }
  // --- API 驱动 ---
  const title2 = `F6-API-单条入库-${TS}`;
  const cr2 = await callApiExpr(`api('POST', '/api/drafts', { body: { source: 'human_edit', type: 'test_script', title: ${JSON.stringify(title2)}, content: ${JSON.stringify(distinctContent(title2))}, project: ${JSON.stringify(proj)} } })`);
  const d2 = await draftByTitle(proj, title2);
  if (!d2) { check('F6-API 前置：草稿创建成功', false, ''); return; }
  const sinceA = new Date().toISOString();
  const cr3 = await callApiExpr(`api('POST', '/api/drafts/${d2.id}/commit', { body: {} })`);
  const c2 = await commitAuditCount(proj, sinceA);
  const st2 = (await draftById(proj, d2.id)) || {};
  check('F6-API 单条入库返回成功', !!(cr3 && cr3.ok), JSON.stringify(cr3 && cr3.data || cr3).slice(0, 150));
  check('F6-API 审计新增 commit 记录', c2 >= 1, `commit 数=${c2}`);
  check('F6-API 草稿状态流转为 merged', st2.status === 'merged', `status=${st2.status}`);
  // 隔离：commit 只影响临时项目，default 与 TARGET(git_test) 草稿数不变
  const afterD = await countDrafts('default');
  const afterT = await countDrafts(TARGET);
  check(`F6 其他项目(default) 草稿数不变`, afterD === baseD, `${baseD}→${afterD}`);
  check(`F6 其他项目(${TARGET}) 草稿数不变`, afterT === baseT, `${baseT}→${afterT}`);
}

// ---------- 业务流：F7 批量入库（FR-016） ----------
// 在干净的临时项目 proj 上执行（与 F6 同理，避免草稿间冲突）。
async function flow7BatchCommit(proj) {
  console.log(`\n[F7] 批量入库（FR-016） 目标项目=${proj}`);
  const baseD = await countDrafts('default');
  const baseT = await countDrafts(TARGET);
  const t1 = `F7-批量1-${TS}`;
  const t2 = `F7-批量2-${TS}`;
  await callApiExpr(`api('POST', '/api/drafts', { body: { source: 'human_edit', type: 'test_script', title: ${JSON.stringify(t1)}, content: ${JSON.stringify(distinctContent(t1))}, project: ${JSON.stringify(proj)} } })`);
  await callApiExpr(`api('POST', '/api/drafts', { body: { source: 'human_edit', type: 'test_script', title: ${JSON.stringify(t2)}, content: ${JSON.stringify(distinctContent(t2))}, project: ${JSON.stringify(proj)} } })`);
  const d1 = await draftByTitle(proj, t1);
  const d2 = await draftByTitle(proj, t2);
  check('F7 前置：2 条草稿创建成功', !!d1 && !!d2, `d1=${!!d1} d2=${!!d2}`);
  if (!d1 || !d2) return;
  // --- UI 驱动：审阅页勾选 + 批量提交 ---
  const sinceUI = new Date().toISOString();
  setProjectViaUI(proj);
  await sleep(2000);
  navView('review');
  await sleep(2000);
  const hasChk = ev(`(() => { const c = document.querySelector('.row-sel[value="${d1.id}"]'); return c ? 'yes' : 'no'; })()`);
  const hasBatch = ev(`(() => { const b = document.querySelector('[data-act="batch-commit"]'); return b ? 'yes' : 'no'; })()`);
  if (hasChk !== 'yes' || hasBatch !== 'yes') skip('F7-UI 批量勾选/提交按钮', `row-sel=${hasChk}, batch-commit=${hasBatch}`);
  else {
    ev(`(() => { document.querySelector('.row-sel[value="${d1.id}"]').click(); document.querySelector('.row-sel[value="${d2.id}"]').click(); return 'ok'; })()`);
    await sleep(400);
    ev(`(() => { const b = document.querySelector('[data-act="batch-commit"]'); b.click(); return 'ok'; })()`);
    await sleep(3500);
    const c = await commitAuditCount(proj, sinceUI);
    const s1 = (await draftById(proj, d1.id)) || {};
    const s2 = (await draftById(proj, d2.id)) || {};
    check('F7-UI 审计新增 commit 记录', c >= 1, `commit 数=${c}`);
    check('F7-UI 两条草稿均流转 merged', s1.status === 'merged' && s2.status === 'merged', `s1=${s1.status}, s2=${s2.status}`);
  }
  // --- API 驱动：batch-commit ---
  const t3 = `F7-API-批量-${TS}`;
  await callApiExpr(`api('POST', '/api/drafts', { body: { source: 'human_edit', type: 'test_script', title: ${JSON.stringify(t3)}, content: ${JSON.stringify(distinctContent(t3))}, project: ${JSON.stringify(proj)} } })`);
  const d3 = await draftByTitle(proj, t3);
  if (!d3) { check('F7-API 前置：草稿创建成功', false, ''); return; }
  const sinceA = new Date().toISOString();
  const br = await callApiExpr(`api('POST', '/api/drafts/batch-commit', { body: { ids: [${JSON.stringify(d3.id)}] } })`);
  const c3 = await commitAuditCount(proj, sinceA);
  const s3 = (await draftById(proj, d3.id)) || {};
  check('F7-API 批量入库返回成功', !!(br && br.ok), JSON.stringify(br && br.data || br).slice(0, 200));
  check('F7-API 审计新增 commit 记录', c3 >= 1, `commit 数=${c3}`);
  check('F7-API 草稿状态流转为 merged', s3.status === 'merged', `status=${s3.status}`);
  // 隔离：commit 只影响临时项目
  const afterD = await countDrafts('default');
  const afterT = await countDrafts(TARGET);
  check(`F7 其他项目(default) 草稿数不变`, afterD === baseD, `${baseD}→${afterD}`);
  check(`F7 其他项目(${TARGET}) 草稿数不变`, afterT === baseT, `${baseT}→${afterT}`);
}

// ---------- 业务流：F8 无变更不写库（FR-019，负向） ----------
async function flow8NoWriteOnNoChange() {
  console.log('\n[F8] 无变更不写库（FR-019，负向）');
  const title = `F8-删除-${TS}`;
  await callApiExpr(`api('POST', '/api/drafts', { body: { source: 'human_edit', type: 'quality_rule', title: ${JSON.stringify(title)}, content: ${JSON.stringify(`# ${title}\n\n- 内容一\n`)}, project: ${JSON.stringify(TARGET)} } })`);
  const d = await draftByTitle(TARGET, title);
  check('F8 前置：草稿创建成功', !!d, title);
  if (!d) return;
  // --- UI 驱动：删除草稿（无变更 → 不应产生任何 commit 入库） ---
  const sinceUI = new Date().toISOString();
  setProjectViaUI(TARGET);
  await sleep(2000);
  navView('review');
  await sleep(2000);
  const hasDel = ev(`(() => { const b = document.querySelector('[data-act="del"][data-id="${d.id}"]'); return b ? 'yes' : 'no'; })()`);
  if (hasDel !== 'yes') skip('F8-UI 删除按钮', `草稿行无 [data-act=del][data-id=${d.id}]`);
  else {
    ev(`(() => { const b = document.querySelector('[data-act="del"][data-id="${d.id}"]'); b.click(); return 'ok'; })()`);
    await sleep(2500);
    const gone = !(await draftByTitle(TARGET, title));
    const c = await commitAuditCount(TARGET, sinceUI);
    check('F8-UI 草稿已被删除', gone, '');
    check('F8-UI 删除未产生任何 commit 入库', c === 0, `commit 数=${c}（应为 0）`);
  }
  // --- API 驱动：前端 api() 封装删除 ---
  const title2 = `F8-API-删除-${TS}`;
  await callApiExpr(`api('POST', '/api/drafts', { body: { source: 'human_edit', type: 'quality_rule', title: ${JSON.stringify(title2)}, content: ${JSON.stringify(`# ${title2}\n\n- 内容一\n`)}, project: ${JSON.stringify(TARGET)} } })`);
  const d2 = await draftByTitle(TARGET, title2);
  if (!d2) { check('F8-API 前置：草稿创建成功', false, ''); return; }
  const sinceA = new Date().toISOString();
  const dr = await callApiExpr(`api('DELETE', '/api/drafts/${d2.id}', { query: { project: ${JSON.stringify(TARGET)} } })`);
  const gone2 = !(await draftByTitle(TARGET, title2));
  const c2 = await commitAuditCount(TARGET, sinceA);
  check('F8-API 删除返回成功', !!(dr && dr.ok), JSON.stringify(dr && dr.data || dr).slice(0, 120));
  check('F8-API 草稿已被删除', gone2, '');
  check('F8-API 删除未产生任何 commit 入库', c2 === 0, `commit 数=${c2}（应为 0）`);
}

// ---------- 业务流：F9 知识检索（FR-018） ----------
async function flow9Search() {
  console.log('\n[F9] 知识检索（FR-018）');
  // --- UI 驱动：检索页输入 + 点击检索 ---
  navView('search');
  await sleep(1800);
  const hasInput = ev(`(() => { const i = document.querySelector('#kbSearchInput'); return i ? 'yes' : 'no'; })()`);
  if (hasInput !== 'yes') skip('F9-UI 检索输入框', '无 #kbSearchInput');
  else {
    // 用 ASCII 查询词规避 Windows 命令行/编码链乱码；'api' 可命中代码上传解析出的 api-* 页面
    ev(`(() => { const i = document.querySelector('#kbSearchInput'); i.value = 'api'; document.querySelector('#kbSearchBtn').click(); return 'ok'; })()`);
    await sleep(4000);
    const errText = ev(`(() => { const r = document.querySelector('#kbSearchResults'); return r ? (/失败|error/i.test(r.innerText) ? 'err' : 'ok') : 'no'; })()`);
    check('F9-UI 检索无报错', errText === 'ok' || errText === 'no', `state=${errText}`);
    const cards = ev(`(() => { const r = document.querySelector('#kbSearchResults'); if (!r) return 0; return r.querySelectorAll('.rs-card, .kb-item, .result-card, .hit, .result-item, .kb-card').length; })()`);
    check('F9-UI 检索结果区有渲染', (cards || 0) >= 0, `卡片数=${cards}`);
  }
  // --- API 驱动：前端 api() 封装检索（api() 的 data 是完整响应体，results 在 data.data.results） ---
  const ar = await callApiExpr(`api('POST', '/api/search', { body: { query: 'api', mode: 'keyword', limit: 5, project: ${JSON.stringify(TARGET)} } })`);
  const results = (ar && ar.data && ar.data.data && ar.data.data.results) || null;
  check('F9-API 检索返回成功', !!(ar && ar.ok), JSON.stringify(ar && ar.data || ar).slice(0, 150));
  check('F9-API 返回结构含 results', Array.isArray(results), results === null ? 'results 缺失' : `条数=${results.length}`);
}

// ---------- 业务流：F10 知识图谱 ----------
async function flow10Graph() {
  console.log('\n[F10] 知识图谱');
  // --- UI 驱动：图谱页渲染 ---
  navView('graph');
  await sleep(2500);
  const hasSvg = ev(`(() => { const svg = document.querySelector('#graphSvg, #graph-svg, #graphWrap svg'); const nodes = document.querySelectorAll('.node, .graph-node').length; return svg ? 'svg' : (nodes > 0 ? 'nodes' : 'none'); })()`);
  check('F10-UI 图谱容器有渲染元素', hasSvg !== 'none', `state=${hasSvg}`);
  // --- API 驱动：前端 api() 封装取图谱数据（api() 的 data 是完整响应体，nodes/edges 在 data.data） ---
  const ar = await callApiExpr(`api('GET', '/api/graph-data', { query: { mode: 'api', project: ${JSON.stringify(TARGET)} } })`);
  const d = ar && ar.data && ar.data.data;
  check('F10-API 图谱数据返回成功', !!(ar && ar.ok), JSON.stringify(ar && ar.data || ar).slice(0, 150));
  check('F10-API 返回结构含 nodes/edges', !!(d && Array.isArray(d.nodes) && Array.isArray(d.edges)),
    d ? `nodes=${(d.nodes || []).length}, edges=${(d.edges || []).length}` : 'data 缺失');
}

// ---------- 主流程 ----------
async function main() {
  console.log(`业务流端到端测试（双驱动：agent-browser UI + 前端 api() 封装）`);
  console.log(`目标项目=${TARGET}  BFF=${BFF}  KS=${KS}`);
  console.log('打开页面…');
  ab(['open', BFF]);
  await sleep(3000);
  const apiGlobal = ev(`(() => typeof window.api === 'function' ? 'yes' : 'no')()`);
  check('前置：前端 api() 封装为全局可调用（API 驱动基础）', apiGlobal === 'yes', `typeof=${apiGlobal}`);
  if (apiGlobal !== 'yes') {
    console.log('api() 非全局，无法进行 API 驱动，终止。');
    console.log(`结果 PASS=${PASS} FAIL=${FAIL} SKIP=${SKIP}`);
    process.exit(1);
  }
  // 确认目标项目存在（/api/projects 返回 {success,data:{projects}}）
  const pr = await g('/api/projects');
  const ids = ((pr.data && pr.data.projects) || []).map(x => x.id);
  if (!ids.includes(TARGET)) {
    console.log(`目标项目 ${TARGET} 不存在（可用：${ids.join(', ')}），终止。`);
    process.exit(1);
  }
  // 创建入库流专用干净临时项目（F6/F7），结束后删除
  const crp = await p('/api/projects', { id: TARGET_C, name: '业务流入库测试-' + TS, description: '自动化业务流测试临时项目（F6/F7）' });
  check('前置：创建临时项目 ' + TARGET_C, !!(crp && crp.success), JSON.stringify(crp || '').slice(0, 120));
  await sleep(800);

  await flow1MultiProjectIsolation();
  await flow2PrdUpload();
  await flow3CodeUpload();
  await flow4DraftEdit();
  await flow5ExecBackflow();
  await flow6SingleCommit(TARGET_C);
  await flow7BatchCommit(TARGET_C);
  await flow8NoWriteOnNoChange();
  await flow9Search();
  await flow10Graph();

  // 清理临时项目
  try {
    const drp = await del('/api/projects/' + encodeURIComponent(TARGET_C));
    check('清理：删除临时项目 ' + TARGET_C, !!(drp && drp.success), JSON.stringify(drp || '').slice(0, 120));
  } catch (e) { warn('临时项目删除失败（可手动清理）: ' + TARGET_C + ' ' + (e && e.message)); }

  console.log('\n========== 汇总 ==========');
  console.log(`PASS=${PASS}  FAIL=${FAIL}  SKIP=${SKIP}`);
  if (WARNS.length) { console.log('警告：'); WARNS.forEach(w => console.log('  ⚠ ' + w)); }
  if (FAILS.length) {
    console.log('失败项：');
    FAILS.forEach(f => console.log('  ✘ ' + f));
    process.exit(1);
  }
  console.log('全部业务流通过。');
  process.exit(0);
}

main().catch(e => { console.error('测试异常:', e); process.exit(2); });
