/**
 * TestGen 前端业务系统 · 后端编排层（BFF）
 * ----------------------------------------------------------
 * 角色：知识系统（test-knowledge-system）的「业务侧」前端后端。
 *  - KS-Adapter：代理知识系统 REST API（项目/上传/草稿/冲突/质量/入库/检索/图谱）
 *  - AI-Adapter：生成测试用例大纲/条目/脚本，上下文来自知识系统（路径 A）
 *  - Writeback-Orchestrator：草稿写入与双通路入库编排（路径 B）
 * 不重建 AI harness / 知识存储，所有正式知识落库均经知识系统。
 */
'use strict';
try { require('dotenv').config(); } catch (_) {} // 可选：若存在 .env 则自动加载
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const PORT = Number(process.env.PORT || 4123);
// 运行时配置中心：以环境变量为种子，支持前端「设置」模块热修改（无需重启）
const cfg = require('./config');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: path.join(__dirname, '..', 'tmp') });

// ---------------------------------------------------------------------------
// KS-Adapter：统一转发到知识系统
// ---------------------------------------------------------------------------
async function ksCall(method, apiPath, { query, body, form } = {}) {
  let url = cfg.get().ks.apiBase + apiPath;
  if (query) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) sp.set(k, v);
    if ([...sp.keys()].length) url += '?' + sp.toString();
  }
  const opts = { method, headers: {} };
  if (form) {
    opts.body = form; // FormData
  } else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

// 简单透传代理（自动携带 project）
function proxy(method, apiPath) {
  return async (req, res) => {
    try {
      // 将 :param 占位符替换为实际路径参数，避免把字面量 ':id'/':category' 透传给知识系统
      const resolvedPath = apiPath.replace(/:([A-Za-z_]+)/g, (_, name) =>
        (req.params && req.params[name] !== undefined) ? encodeURIComponent(req.params[name]) : ':' + name
      );
      let form;
      if (method === 'POST' && req.is('multipart/form-data')) {
        // 由专门处理器处理；此处仅处理 JSON/query 透传
      }
      const { status, data } = await ksCall(method, resolvedPath, {
        query: req.method === 'GET' ? req.query : undefined,
        body: req.method !== 'GET' ? req.body : undefined,
      });
      res.status(status).json(data);
    } catch (e) {
      res.status(502).json({ success: false, error: 'KS 代理失败: ' + e.message });
    }
  };
}

// 项目
app.get('/api/projects', proxy('GET', '/api/projects'));
app.post('/api/projects', proxy('POST', '/api/projects'));
app.delete('/api/projects/:id', proxy('DELETE', '/api/projects/:id'));

// 知识读取
app.get('/api/brain/pages', proxy('GET', '/api/brain/pages'));
app.get('/api/brain/pages/:category/:id', proxy('GET', '/api/brain/pages/:category/:id'));
app.get('/api/graph-data', proxy('GET', '/api/graph-data'));
app.post('/api/search', proxy('POST', '/api/search'));

// 草稿 / 冲突 / 质量 / 入库（回写编排，路径 B）
app.get('/api/drafts', proxy('GET', '/api/drafts'));
app.get('/api/drafts/:id', proxy('GET', '/api/drafts/:id'));
app.post('/api/drafts', proxy('POST', '/api/drafts'));
app.put('/api/drafts/:id/status', proxy('PUT', '/api/drafts/:id/status'));
app.delete('/api/drafts/:id', proxy('DELETE', '/api/drafts/:id'));
app.delete('/api/drafts', proxy('DELETE', '/api/drafts'));
app.post('/api/conflicts/detect', proxy('POST', '/api/conflicts/detect'));
app.post('/api/quality-gate/check', proxy('POST', '/api/quality-gate/check'));
app.post('/api/drafts/:id/commit', proxy('POST', '/api/drafts/:id/commit'));
app.post('/api/drafts/batch-commit', proxy('POST', '/api/drafts/batch-commit'));

// 源数据上传：接收 multipart，转发给知识系统
app.post('/api/source-upload', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    if (req.file) {
      const buf = fs.readFileSync(req.file.path);
      form.append('file', new Blob([buf], { type: req.file.mimetype || 'application/octet-stream' }), req.file.originalname);
    }
    if (req.body.content) form.append('content', req.body.content);
    form.append('type', req.body.type || (req.file ? 'code' : 'quality_rule'));
    form.append('project', req.body.project || 'default');
    if (req.body.note) form.append('note', req.body.note);
    const { status, data } = await ksCall('POST', '/api/source-upload', { form });
    res.status(status).json(data);
  } catch (e) {
    res.status(502).json({ success: false, error: '上传代理失败: ' + e.message });
  } finally {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
  }
});

// ---------------------------------------------------------------------------
// Context-Harvester：生成前只读采集知识上下文
// ---------------------------------------------------------------------------
async function harvestContext(project) {
  const stats = { testCases: 0, qualityRules: 0, wikiPages: 0, graphNodes: 0, graphEdges: 0, searchHits: 0 };
  const titles = { testCases: [], qualityRules: [], wikiPages: [] };
  const safe = async (fn) => { try { return await fn(); } catch (e) { return null; } };

  const tc = await safe(() => ksCall('GET', '/api/brain/pages', { query: { category: 'test-cases', project, limit: 50 } }));
  if (tc && tc.data && tc.data.data) { stats.testCases = tc.data.data.length; titles.testCases = tc.data.data.map(p => p.title); }

  const qr = await safe(() => ksCall('GET', '/api/brain/pages', { query: { category: 'quality-rules', project, limit: 50 } }));
  if (qr && qr.data && qr.data.data) { stats.qualityRules = qr.data.data.length; titles.qualityRules = qr.data.data.map(p => p.title); }

  const pw = await safe(() => ksCall('GET', '/api/brain/pages', { query: { category: 'project-wiki', project, limit: 50 } }));
  if (pw && pw.data && pw.data.data) { stats.wikiPages = pw.data.data.length; titles.wikiPages = pw.data.data.map(p => p.title); }

  const gd = await safe(() => ksCall('GET', '/api/graph-data', { query: { project } }));
  if (gd && gd.data && gd.data.data) { stats.graphNodes = (gd.data.data.nodes || []).length; stats.graphEdges = (gd.data.data.edges || []).length; }

  return { stats, titles };
}

// 请求驱动检索：根据本次生成请求（scope/constraints/op）在知识库检索命中条目，
// 命中内容（snippet）将作为真实上下文喂给 AI，命中列表回前端展示在侧栏。
async function retrieveHits(project, op, scope, constraints) {
  const opName = { gen_outline: '测试用例大纲', gen_cases: '测试用例', gen_scripts: '自动化测试脚本' }[op] || '测试用例';
  const parts = [];
  if (scope.modules && scope.modules.length) parts.push(scope.modules.join(' '));
  if (scope.functions && scope.functions.length) parts.push(scope.functions.join(' '));
  if (constraints && constraints.note) parts.push(constraints.note);
  parts.push(opName);
  const query = parts.join(' ') || opName;
  let results = [];
  try {
    const r = await ksCall('POST', '/api/search', { body: { query, mode: 'keyword', limit: 12, project } });
    results = (r && r.data && r.data.data && Array.isArray(r.data.data.results)) ? r.data.data.results : [];
  } catch (e) { results = []; }
  const hits = results.map(h => {
    let kind = h.type || 'other';
    if (kind === 'project-wiki') {
      const p = (h.id || '').toLowerCase();
      kind = /api-/.test(p) ? 'dep' : 'wiki';
    } else if (kind === 'test-cases') kind = 'history';
    else if (kind === 'quality-rules') kind = 'rule';
    return { kind, category: h.type, id: h.id, title: h.title, path: h.id, score: h.score, snippet: h.snippet };
  });
  return { query, hits };
}

// ---------------------------------------------------------------------------
// AI-Adapter：生成测试用例（路径 A）
// ---------------------------------------------------------------------------
function buildQuery(op, sourceRefs, scope, constraints, ctx, hits) {
  const opName = { gen_outline: '测试用例大纲', gen_cases: '测试用例条目', gen_scripts: '自动化测试脚本' }[op] || '测试用例';
  const mods = (scope.modules && scope.modules.length) ? scope.modules.join(', ') : '未限定模块';
  const funcs = (scope.functions || []).join(', ') || '';
  const depth = scope.depth === 'full' ? '全量' : '冒烟';
  // 以检索命中（hits）作为真实上下文：命中条目的 snippet 直接喂给 AI，而非仅列标题
  const byKind = { history: [], rule: [], wiki: [], dep: [] };
  (hits || []).forEach(h => { (byKind[h.kind] = byKind[h.kind] || []).push(h); });
  const ctxLines = [];
  const pushKind = (label, arr) => {
    arr.slice(0, 5).forEach(h => ctxLines.push(`- [${label}] ${h.title}（相关度 ${h.score}）：${(h.snippet || '').slice(0, 200)}`));
  };
  pushKind('历史用例', byKind.history);
  pushKind('质量门禁', byKind.rule);
  pushKind('项目Wiki', byKind.wiki);
  pushKind('代码依赖', byKind.dep);
  const ctxBlock = ctxLines.length ? ctxLines.join('\n') : '（本次检索无命中，请基于通用测试经验生成）';
  let q = `请基于知识系统上下文，为项目【${sourceRefs.project || ''}】生成【${opName}】。\n` +
    `范围模块：${mods}${funcs ? '；功能模块：' + funcs : ''}；深度：${depth}；框架：${constraints.framework || 'pytest'}。\n` +
    `约束：${constraints.note || '覆盖主流程、异常分支与边界'}。\n` +
    `知识库规模概览：历史用例 ${ctx.stats.testCases} 条 / 质量规则 ${ctx.stats.qualityRules} 条 / 项目Wiki ${ctx.stats.wikiPages} 页 / API图谱 ${ctx.stats.graphNodes} 节点。\n` +
    `【本次检索命中的知识库条目（作为生成上下文，请优先参考）】\n${ctxBlock}`;
  // gen_cases 固定标记约束：要求每条测试用例以 ## TC-{序号} · {标题} 作为分隔，便于业务端拆分入库
  if (op === 'gen_cases') {
    q += '\n\n【格式约束】每条测试用例必须以如下固定标记开头，且序号连续递增：\n' +
      '## TC-001 · {用例标题}\n' +
      '（后续接步骤、预期结果等正文）\n' +
      '## TC-002 · {用例标题}\n' +
      '……\n' +
      '严禁省略该标记，严禁把多条测试用例合并到同一个标题下。';
  }
  return q;
}

// 本地模板生成器（AI 平台/知识系统生成器均不可用时的 V1.0 兜底，保证链路可演示）
function templateGenerate(op, scope, ctx, project) {
  const mods = (scope.modules && scope.modules.length) ? scope.modules : ['core'];
  const head = `# ${op === 'gen_outline' ? '测试用例大纲' : op === 'gen_cases' ? '测试用例条目' : '自动化测试脚本'}（模板生成 · ${project}）\n`;
  if (op === 'gen_scripts') {
    const cases = mods.map(m =>
      `def test_${m}_happy_path():\n    """基于知识库上下文生成：${ctx.titles.testCases[0] || m}"""\n    # arrange\n    # act\n    # assert\n    assert True\n`).join('\n');
    return head + '```python\n' + cases + '```\n';
  }
  const items = mods.map((m, i) =>
    `## TC-${String(i + 1).padStart(3, '0')} · ${m} 主流程\n- 步骤：构造请求 → 执行 → 断言\n- 参考：${ctx.titles.testCases[i] || '（无）'}\n`).join('\n');
  return head + items + '\n';
}

// OpenAI 兼容通道：豆包/火山方舟、腾讯 TokenHub、codebuddy2api 等 REST 端点
async function callOpenAI(op, query, constraints) {
  const c = cfg.get();
  if (!c.ai.endpoint) return null;
  const sysLines = [
    '你是测试用例生成专家。',
    '请使用 Markdown 结构输出：#/## 标题、- 列表、``` 代码块，确保可被知识库质量门控收录。',
  ];
  if (op === 'gen_cases') {
    sysLines.push('');
    sysLines.push('【关键格式约束】生成测试用例条目时，每条用例必须以固定标记开头：');
    sysLines.push('## TC-{三位序号} · {用例标题}');
    sysLines.push('例如：## TC-001 · 用户登录成功');
    sysLines.push('序号必须连续递增，严禁合并多条用例到同一标记下。');
  }
  const system = sysLines.join('\n');
  const resp = await fetch(c.ai.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.ai.apiKey },
    body: JSON.stringify({
      model: c.ai.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: query }],
    }),
  });
  const j = await resp.json();
  return j.choices?.[0]?.message?.content || null;
}

// CodeBuddy 通道：调用全局 codebuddy CLI（见 codebuddy-client.js，跨平台、绕开 SDK 的 Windows 传输缺陷）
const { callCodeBuddy } = require('./codebuddy-client');

async function callAIProvider(op, query, constraints) {
  const c = cfg.get();
  if (c.ai.provider === 'codebuddy') {
    const sysLines = [
      '你是测试用例生成专家，服务于知识管理系统的自动化测试用例生成流程。',
      '请严格按以下 Markdown 结构输出，确保能被知识库质量门控收录：',
      '1) 使用 # 或 ## 作为章节标题；',
      '2) 使用 - 无序列表组织步骤与要点；',
      '3) 用 ``` 代码块包裹示例代码并标注语言（如 python）；',
      '4) 直接输出测试用例内容，不要任何额外解释或寒暄。',
    ];
    if (op === 'gen_cases') {
      sysLines.push('');
      sysLines.push('【关键格式约束】生成测试用例条目时，每条用例必须以固定标记开头：');
      sysLines.push('## TC-{三位序号} · {用例标题}');
      sysLines.push('例如：## TC-001 · 用户登录成功');
      sysLines.push('序号必须连续递增，严禁合并多条用例到同一标记下。');
    }
    const sys = sysLines.join('\n');
    // 模型：内置模型直接按 id 使用；自定义模型（useCustomModel 且配了 endpoint）走 .codebuddy/models.json 解析自有 endpoint。
    const m = (c.ai.model && c.ai.model !== 'gpt-4o-mini') ? c.ai.model : 'claude-sonnet-4';
    const useCustom = !!c.ai.useCustomModel && !!(c.ai.endpoint && c.ai.model);
    return callCodeBuddy(sys + '\n\n' + query, {
      model: m,
      loadSettings: useCustom,
    });
  }
  if (c.ai.provider === 'openai') return callOpenAI(op, query, constraints);
  return null; // none 或未识别：跳过真实 AI
}

app.post('/api/generate', async (req, res) => {
  try {
    const { op, project = 'testCaseGenerator', sourceRefs = {}, scope = {}, constraints = {} } = req.body || {};
    if (!['gen_outline', 'gen_cases', 'gen_scripts'].includes(op)) {
      return res.status(400).json({ success: false, error: 'op 必须为 gen_outline/gen_cases/gen_scripts' });
    }
    const ctx = await harvestContext(project);
    const { query: hitQuery, hits } = await retrieveHits(project, op, scope, constraints);
    const query = buildQuery(op, { ...sourceRefs, project }, scope, constraints, ctx, hits);

    let content = null, engine = 'template';
    const provider = cfg.get().ai.provider;
    // 1) 优先真实 AI 平台（provider 可配置：openai / codebuddy / none）
    if (provider !== 'none') {
      try { content = await callAIProvider(op, query, constraints); engine = 'ai-' + provider; } catch (_) {}
    }
    // 2) 回退知识系统内置生成器
    if (!content) {
      try {
        const r = await ksCall('POST', '/api/generate-cases', { body: { query, limit: constraints.limit || 6 } });
        if (r.data && r.data.success && r.data.data) { content = JSON.stringify(r.data.data, null, 2); engine = 'ks-generator'; }
      } catch (_) {}
    }
    // 3) 回退本地模板
    if (!content) content = templateGenerate(op, scope, ctx, project);

    res.json({
      success: true,
      data: {
        kind: op.replace('gen_', ''),
        project,
        content,
        engine,
        contextUsed: { ...ctx.stats, searchHits: hits.length },
        hitQuery,
        hits,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: '生成失败: ' + e.message });
  }
});

// 健康检查
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'testcase-gen-frontend', ks: cfg.get().ks.apiBase }));

// 当 CodeBuddy 通道配置了自定义模型（endpoint+model）时，将其注册为 CodeBuddy 自定义模型：
// 写入 .codebuddy/models.json（harness 仍用 CodeBuddy，模型走自有 endpoint/apiKey），
// 并设为 settings.local.json 的默认模型，供 codebuddy-client 的 project,local 加载解析。
function syncCodeBuddyCustomModel(ai) {
  if (!ai || ai.provider !== 'codebuddy') return;
  const modelId = (ai.model || '').trim();
  const url = (ai.endpoint || '').trim();
  if (!modelId || !url) return; // 无自定义模型信息则不写，保留用户已有的 models.json/settings.local.json
  try {
    const cbDir = path.join(__dirname, '..', '.codebuddy');
    fs.mkdirSync(cbDir, { recursive: true });
    const modelsPath = path.join(cbDir, 'models.json');
    let models = { models: [], availableModels: [] };
    try { if (fs.existsSync(modelsPath)) models = JSON.parse(fs.readFileSync(modelsPath, 'utf8')); } catch (_) {}
    if (!Array.isArray(models.models)) models.models = [];
    if (!Array.isArray(models.availableModels)) models.availableModels = [];
    const entry = {
      id: modelId,
      name: ai.model,
      vendor: 'OpenAI',
      apiKey: (ai.apiKey || '').trim(),
      url,
      maxInputTokens: 128000,
      maxOutputTokens: 8192,
      supportsToolCall: true,
      supportsImages: false,
    };
    const idx = models.models.findIndex((m) => m.id === modelId);
    if (idx >= 0) models.models[idx] = entry; else models.models.push(entry);
    if (!models.availableModels.includes(modelId)) models.availableModels.push(modelId);
    fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2), 'utf8');

    const settingsPath = path.join(cbDir, 'settings.local.json');
    let settings = {};
    try { if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (_) {}
    settings.model = modelId;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    console.warn('[settings] 写入 .codebuddy 自定义模型失败：', e.message);
  }
}

// 读取当前配置（前端「设置」模块用）
app.get('/api/settings', (req, res) => {
  res.json({ success: true, data: cfg.get() });
});

// CodeBuddy 可直接使用的模型清单：内置默认清单（真实内置模型，见 `codebuddy --help` 的
// Currently supported 行，当前为 glm-5.2；claude-* / hy3 为常用别名）+ 解析 CLI 动态列出的
// 已注册自定义模型（custom-local:*）+ .codebuddy/models.json 的 availableModels。
const BUILTIN_CODEBUDDY_MODELS = [
  { id: 'glm-5.2', label: 'glm-5.2（CodeBuddy 内置）' },
  { id: 'claude-sonnet-4', label: 'claude-sonnet-4（CodeBuddy 内置）' },
  { id: 'claude-opus-4', label: 'claude-opus-4（CodeBuddy 内置）' },
  { id: 'hy3', label: 'Hy3（CodeBuddy 内置）' },
];
// 非阻塞缓存：codebuddy --help 在 Windows 上可能较慢，解析结果缓存 5 分钟，避免每次请求都阻塞事件循环
let _cbHelpCache = null;
let _cbHelpCacheAt = 0;
function parseCodeBuddyCliModels() {
  const now = Date.now();
  if (_cbHelpCache && now - _cbHelpCacheAt < 5 * 60 * 1000) return _cbHelpCache;
  const list = [];
  try {
    const out = execSync('codebuddy --help', { encoding: 'utf8', timeout: 8000, windowsHide: true, env: process.env });
    const mm = out.match(/Currently supported:\s*\(([^)]*)\)/);
    if (mm) mm[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => {
      const id = s.replace(/^custom-local:/, '');
      if (id && !/^custom-local:/.test(s) && !list.some((m) => m.id === id)) {
        list.push({ id, label: id + '（CodeBuddy 内置）', builtin: true });
      }
    });
  } catch (_) { /* codebuddy 查询失败则返回空，由内置清单兜底 */ }
  _cbHelpCache = list;
  _cbHelpCacheAt = now;
  return list;
}
app.get('/api/settings/codebuddy-models', (req, res) => {
  const models = [];
  const seen = new Set();
  BUILTIN_CODEBUDDY_MODELS.forEach((m) => { models.push({ id: m.id, label: m.label, builtin: true }); seen.add(m.id); });
  // 1) 解析 codebuddy --help 的 Currently supported 行（CLI 动态列出的内置模型，可能补充别名）
  try {
    parseCodeBuddyCliModels().forEach((m) => { if (!seen.has(m.id)) { models.push(m); seen.add(m.id); } });
  } catch (_) {}
  // 2) 读取 .codebuddy/models.json 的 availableModels（已注册自定义模型）
  try {
    const mp = path.join(__dirname, '..', '.codebuddy', 'models.json');
    if (fs.existsSync(mp)) {
      const j = JSON.parse(fs.readFileSync(mp, 'utf8'));
      (j.availableModels || []).forEach((id) => {
        if (id && !seen.has(id)) { models.push({ id, label: id + '（已注册自定义）', builtin: false }); seen.add(id); }
      });
    }
  } catch (_) {}
  res.json({ success: true, data: { models } });
});

// 更新配置：热修改，立即生效，持久化到 data/config.json（无需重启）
app.put('/api/settings', (req, res) => {
  try {
    const next = cfg.set(req.body || {});
    // CodeBuddy 通道：若配置了自定义模型 endpoint，则同步注册到 .codebuddy/models.json
    syncCodeBuddyCustomModel(next.ai);
    res.json({ success: true, data: next });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 测试连接：验证 KS API 可达性（可选带 ksApiBase 覆盖）
app.post('/api/settings/test', async (req, res) => {
  const base = (req.body && req.body.ksApiBase) || cfg.get().ks.apiBase;
  try {
    const r = await fetch(base.replace(/\/$/, '') + '/api/health', { method: 'GET' });
    const j = await r.json().catch(() => ({}));
    res.json({ success: r.ok, reachable: r.ok, status: r.status, data: j });
  } catch (e) {
    res.json({ success: false, reachable: false, error: e.message });
  }
});

// 通配代理：将未单独声明的 /api/* 请求透传到知识系统，直接复用 KS /api/* 端点
// （覆盖 audit-log / stats / conflicts / brain 编辑与 promote 等尚未单独声明的端点）
// 注意：必须放在所有具体 /api 路由之后，避免抢占 /api/generate 等具体处理器
app.all('/api/*', async (req, res) => {
  try {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const url = cfg.get().ks.apiBase + req.path + qs;
    const body = ['GET', 'HEAD'].includes(req.method) || !req.body
      ? undefined
      : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    const r = await fetch(url, {
      method: req.method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body,
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ success: false, error: 'KS 代理失败: ' + e.message });
  }
});

// 静态前端（开发期禁用缓存，避免浏览器加载旧版）
app.use(express.static(path.join(__dirname, '..', 'web'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

app.listen(PORT, () => {
  console.log(`[TestGen BFF] 监听 http://localhost:${PORT}  ·  知识系统 ${cfg.get().ks.apiBase}`);
});
