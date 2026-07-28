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
const os = require('os');
const { execSync, spawn } = require('child_process');
const logger = require('./logger');

const PORT = Number(process.env.PORT || 4123);
// 运行时配置中心：以环境变量为种子，支持前端「设置」模块热修改（无需重启）
const cfg = require('./config');
// 多项目隔离统一默认项目：generate / source-upload / 代理透传均使用同一默认值，避免默认 project 不一致
const DEFAULT_PROJECT = process.env.DEFAULT_PROJECT || 'testCaseGenerator';

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// 请求日志（方法 / 路径 / 状态 / 耗时），写入 logs/app-*.log（保留 7 天）
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => logger.http(req, res, Date.now() - start, { ip: req.ip }));
  next();
});

const upload = multer({ dest: path.join(__dirname, '..', 'tmp') });
// 源数据上传用内存存储：直接拿到原始字节(req.file.buffer)，避免落盘 tmp 再读回带来的编码隐患
const memUpload = multer({ storage: multer.memoryStorage() });

// ---------------------------------------------------------------------------
// KS-Adapter：统一转发到知识系统
// ---------------------------------------------------------------------------
async function ksCall(method, apiPath, { query, body, form } = {}) {
  let url = cfg.get().ks.apiBase + apiPath;
  if (query) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) sp.set(k, v);
    // 多项目隔离：GET 缺省 project 时注入统一默认项目（与前端/后端默认值一致）
    if (method === 'GET' && !sp.has('project')) sp.set('project', DEFAULT_PROJECT);
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
app.post('/api/source-upload', memUpload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    if (req.file) {
      // 直接转发原始字节，绝不做字符串解码/重编码，避免 Latin-1/UTF-8 互转产生乱码
      const buf = req.file.buffer;
      // 关键：undici 序列化 multipart 时，若 filename 含非 ASCII 字节会损坏文件【内容】；
      // 因此文件 part 使用 ASCII 文件名，真实文件名经 filename 文本字段传递（busboy 对文本字段解码正常）
      const safeName = 'source-' + Date.now() + (path.extname(req.file.originalname) || '.bin');
      // req.file.originalname 被 busboy 误按 Latin-1 解码成乱码，这里还原回正确的 UTF-8 文件名
      let realName = req.file.originalname;
      try {
        const recovered = Buffer.from(req.file.originalname, 'latin1').toString('utf-8');
        if (/[\u4e00-\u9fa5]/.test(recovered)) realName = recovered;
      } catch (_) {}
      form.append('file', new Blob([buf], { type: req.file.mimetype || 'application/octet-stream' }), safeName);
      form.append('filename', realName);
    }
    if (req.body.content) form.append('content', req.body.content);
    form.append('type', req.body.type || (req.file ? 'code' : 'quality_rule'));
    form.append('project', req.body.project || DEFAULT_PROJECT);
    if (req.body.note) form.append('note', req.body.note);
    const { status, data } = await ksCall('POST', '/api/source-upload', { form });
    res.status(status).json(data);
  } catch (e) {
    res.status(502).json({ success: false, error: '上传代理失败: ' + e.message });
  }
});

// ---------------------------------------------------------------------------
// Context-Harvester：生成前只读采集知识上下文
// ---------------------------------------------------------------------------
async function harvestContext(project) {
  const stats = { testCases: 0, qualityRules: 0, wikiPages: 0, graphNodes: 0, graphEdges: 0, graphFlows: 0, searchHits: 0 };
  const titles = { testCases: [], qualityRules: [], wikiPages: [] };
  // 业务流程依赖图谱（业务侧唯一图谱来源）：黑盒测试拿不到源代码，故以 business-graph 取代代码图谱
  let graph = null;
  const safe = async (fn) => { try { return await fn(); } catch (e) { return null; } };

  // 权威计数取自 /api/brain/stats：按分类全量统计、私有+共享去重，不受分页 limit 截断，
  // 与侧栏“历史用例”及知识库概览口径完全一致。
  const bs = await safe(() => ksCall('GET', '/api/brain/stats', { query: { project } }));
  if (bs && bs.data && bs.data.data) {
    const d = bs.data.data;
    stats.testCases = (d['test-cases'] && d['test-cases'].count) || 0;
    stats.qualityRules = (d['quality-rules'] && d['quality-rules'].count) || 0;
    stats.wikiPages = (d['project-wiki'] && d['project-wiki'].count) || 0;
  }

  // 标题仅用于生成提示词展示，取前若干条即可（分页不计入总数）
  const tc = await safe(() => ksCall('GET', '/api/brain/pages', { query: { category: 'test-cases', project, limit: 50 } }));
  if (tc && tc.data && tc.data.data) titles.testCases = tc.data.data.map(p => p.title);

  const qr = await safe(() => ksCall('GET', '/api/brain/pages', { query: { category: 'quality-rules', project, limit: 50 } }));
  if (qr && qr.data && qr.data.data) titles.qualityRules = qr.data.data.map(p => p.title);

  const pw = await safe(() => ksCall('GET', '/api/brain/pages', { query: { category: 'project-wiki', project, limit: 50 } }));
  if (pw && pw.data && pw.data.data) titles.wikiPages = pw.data.data.map(p => p.title);

  // 业务流程依赖图谱：节点（API/业务步骤）+ 边 + 可测试业务流；data 可能为 null（尚未从 Wiki 生成）
  const bg = await safe(() => ksCall('GET', '/api/business-graph', { query: { project } }));
  if (bg && bg.data && bg.data.data) {
    graph = bg.data.data;
    stats.graphNodes = (graph.nodes || []).length;
    stats.graphEdges = (graph.edges || []).length;
    stats.graphFlows = (graph.flows || []).length;
  }

  return { stats, titles, graph };
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

  // 功能模块（PRD 派生）→ 精准召回 GBrain 实体 + 图谱关系，作为高优上下文
  let entityHits = [];
  if (scope.functions && scope.functions.length) {
    try {
      const er = await ksCall('GET', '/api/wiki/module-entities', { query: { project, modules: JSON.stringify(scope.functions) } });
      const ed = er && er.data && er.data.data;
      if (ed) {
        const toHit = (e, via) => ({
          kind: 'entity', category: 'entity', id: e.id,
          title: (via ? '↳ ' : '★ ') + e.name + (e.type ? '（' + e.type + '）' : ''),
          snippet: (e.definition ? e.definition + ' ' : '') +
            (e.relations && e.relations.length ? '关联：' + e.relations.map(r => r.target + '·' + r.type).join('、') : '') +
            (e.sourceSection ? '｜出处：' + e.sourceSection : ''),
          score: via ? 99 : 100, via: via || null,
        });
        entityHits = (ed.entities || []).map(e => toHit(e, null))
          .concat((ed.related || []).map(e => toHit(e, e.via)));
      }
    } catch (_) { entityHits = []; }
  }

  // 关键词检索：功能模块已由实体精准覆盖时，降低 limit 以减少冗余噪声
  const limit = (scope.functions && scope.functions.length && entityHits.length) ? 6 : 12;
  let results = [];
  try {
    const r = await ksCall('POST', '/api/search', { body: { query, mode: 'keyword', limit, project } });
    results = (r && r.data && r.data.data && Array.isArray(r.data.data.results)) ? r.data.data.results : [];
  } catch (e) { results = []; }
  const kwHits = results.map(h => {
    let kind = h.type || 'other';
    if (kind === 'project-wiki') {
      const p = (h.id || '').toLowerCase();
      kind = /api-/.test(p) ? 'dep' : 'wiki';
    } else if (kind === 'test-cases') kind = 'history';
    else if (kind === 'quality-rules') kind = 'rule';
    return { kind, category: h.type, id: h.id, title: h.title, path: h.id, score: h.score, snippet: h.snippet };
  });
  // 实体上下文置顶（高优），再接关键词命中
  return { query, hits: entityHits.concat(kwHits) };
}

// ---------------------------------------------------------------------------
// AI-Adapter：生成测试用例（路径 A）
// ---------------------------------------------------------------------------
function buildQuery(op, sourceRefs, scope, constraints, ctx, hits) {
  const opName = { gen_outline: '测试用例大纲', gen_cases: '测试用例条目', gen_scripts: '自动化测试脚本' }[op] || '测试用例';
  // 范围模块：代码模块已勾选则如实列出；否则若函数模块已选，则范围“由功能模块限定”（不再误报“全部/未限定”）；两者皆无才“未限定模块”
  const mods = (scope.modules && scope.modules.length)
    ? scope.modules.join(', ')
    : (scope.functions && scope.functions.length ? '由功能模块限定' : '未限定模块');
  const funcs = (scope.functions || []).join(', ') || '';
  const depth = scope.depth === 'full' ? '全量' : '冒烟';
  // 以检索命中（hits）作为真实上下文：命中条目的 snippet 直接喂给 AI，而非仅列标题
  const byKind = { history: [], rule: [], wiki: [], dep: [], entity: [] };
  (hits || []).forEach(h => { (byKind[h.kind] = byKind[h.kind] || []).push(h); });
  const ctxLines = [];
  const pushKind = (label, arr) => {
    arr.slice(0, 6).forEach(h => ctxLines.push(`- [${label}] ${h.title}（相关度 ${h.score}）：${(h.snippet || '').slice(0, 240)}`));
  };
  // 业务流程依赖图谱（最高优上下文）：黑盒测试基于对外 API/业务步骤与可测试场景，不依赖源代码
  let bizCtx = '';
  const g = ctx.graph;
  if (g && g.nodes && g.nodes.length) {
    const nodeLines = g.nodes.slice(0, 40).map(n =>
      `- ${n.api || ((n.method || '') + ' ' + (n.path || '')).trim() || n.id}｜${n.title || ''}（${n.role || ''}）：${(n.summary || '').slice(0, 160)}`);
    const flowLines = (g.flows || []).slice(0, 10).map(f =>
      `- ${f.name}：${(f.description || '').slice(0, 160)}（步骤：${(f.steps || []).join('→')}）`);
    bizCtx = `【业务流程依赖图谱（最高优上下文，请据此设计用例覆盖各业务流与 API 节点）】\n业务步骤/API 节点：\n${nodeLines.join('\n')}\n可测试业务流/场景：\n${flowLines.join('\n')}`;
  }
  // 实体上下文（GBrain 抽取 + 图谱关系）其次，再补关键词检索命中
  pushKind('GBrain实体', byKind.entity);
  pushKind('历史用例', byKind.history);
  pushKind('质量门禁', byKind.rule);
  pushKind('项目Wiki', byKind.wiki);
  pushKind('API文档', byKind.dep);
  const ctxBlock = ctxLines.length ? ctxLines.join('\n') : '（本次检索无命中，请基于通用测试经验生成）';
  let q = `请基于知识系统上下文，为项目【${sourceRefs.project || ''}】生成【${opName}】。\n` +
    `范围模块：${mods}${funcs ? '；功能模块：' + funcs : ''}；深度：${depth}；框架：${constraints.framework || 'pytest'}。\n` +
    `约束：${constraints.note || '覆盖主流程、异常分支与边界'}。\n` +
    `知识库规模概览：历史用例 ${ctx.stats.testCases} 条 / 质量规则 ${ctx.stats.qualityRules} 条 / 项目Wiki ${ctx.stats.wikiPages} 页 / 业务流图谱 ${ctx.stats.graphNodes} 节点 / ${ctx.stats.graphFlows} 业务流。\n` +
    (bizCtx ? bizCtx + '\n' : '') +
    `【本次检索命中的知识库条目（作为补充上下文）】\n${ctxBlock}`;
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
  logger.app('info', 'ai callAIProvider', {
    provider: c.ai.provider, model: c.ai.model,
    useCustomModel: !!c.ai.useCustomModel, op,
  });
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
    const r = await callCodeBuddy(sys + '\n\n' + query, {
      model: m,
      loadSettings: useCustom,
      maxTurns: c.ai.maxTurns,
    });
    logger.app('info', 'ai result', { provider: 'codebuddy', model: m, empty: !r });
    return r;
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

// 健康检查：除 BFF 自身外，真实探测知识系统(KS)可达性，避免「展示性虚假连通」
// （与 /api/settings/test 的 KS 探测保持一致，作为前端连通状态的单一数据源）
app.get('/api/health', async (req, res) => {
  const ksBase = cfg.get().ks.apiBase;
  let ksReachable = false, ksStatus = null, ksError = null;
  try {
    const r = await fetch(ksBase.replace(/\/$/, '') + '/api/health', { method: 'GET' });
    ksReachable = r.ok;
    ksStatus = r.status;
  } catch (e) {
    ksReachable = false;
    ksError = String(e.message || e).slice(0, 200);
  }
  res.json({ status: 'ok', service: 'testcase-gen-frontend', ks: ksBase, ksReachable, ksStatus, ksError });
});

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
    // 配置变更后立即失效 AI 连通缓存，使状态栏下次取用真实探测（避免改不可用配置仍显示「已连接」）
    _aiStatusCache = null;
    res.json({ success: true, data: next });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- 连通性探测辅助 ----
// CodeBuddy 通道：默认仅探测 CLI 是否安装可用（liveness）。
// 若用户配置了「自定义模型 + 自定义 endpoint」，则额外真实探测该 endpoint 可达性——
// 仅 CLI 在但自定义端点不通，仍视为「不可用配置」，避免状态栏虚假连通。
async function testCodeBuddy(ai) {
  let cliVer = null;
  try {
    const v = execSync('codebuddy --version', { timeout: 6000, windowsHide: true, encoding: 'utf8' });
    cliVer = String(v).trim().split('\n')[0].slice(0, 24);
  } catch (_) { cliVer = null; }
  const ep = (ai && ai.useCustomModel && ai.endpoint && ai.endpoint.trim()) ? ai.endpoint.trim() : '';
  if (!ep) {
    // 内置模型：CLI 可达即视为可用
    if (cliVer) return { provider: 'codebuddy', configured: true, reachable: true, label: 'CodeBuddy CLI 可达', detail: 'codebuddy ' + cliVer };
    return { provider: 'codebuddy', configured: false, reachable: false, label: 'CodeBuddy 不可达', detail: 'CLI 未安装或未登录' };
  }
  // 自定义 endpoint：必须真实可达才算连通（避免只因 CLI 在就报「已连接」）
  const apiKey = (ai.apiKey && ai.apiKey.trim()) || '';
  const model = (ai.model && ai.model.trim()) || 'gpt-4o-mini';
  const t0 = Date.now();
  try {
    const resp = await fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: 'ping' }, { role: 'user', content: 'hi' }], max_tokens: 5 }),
    });
    const latencyMs = Date.now() - t0;
    if (resp.ok) {
      const j = await resp.json().catch(() => ({}));
      const ok = !!(j.choices && j.choices[0] && j.choices[0].message);
      if (ok) return { provider: 'codebuddy', configured: true, reachable: true, label: 'CodeBuddy + 自定义端点可达', detail: `HTTP ${resp.status} · ${latencyMs}ms`, latencyMs };
      return { provider: 'codebuddy', configured: true, reachable: false, label: '自定义端点响应异常', detail: cliVer ? 'CLI 可达但端点响应缺少 choices' : '端点响应缺少 choices', latencyMs };
    }
    return { provider: 'codebuddy', configured: true, reachable: false, label: `自定义端点不可达 (HTTP ${resp.status})`, detail: (await resp.text().catch(() => '')).slice(0, 160), latencyMs };
  } catch (e) {
    return { provider: 'codebuddy', configured: true, reachable: false, label: '自定义端点不可达', detail: String(e.message || e).slice(0, 160), latencyMs: Date.now() - t0 };
  }
}
// OpenAI 兼容通道：发起一次极小 chat 请求（max_tokens=5），真实验证 endpoint 可达 + 鉴权有效
async function testOpenAI(ai) {
  const endpoint = (ai.endpoint || '').trim();
  const apiKey = (ai.apiKey || '').trim();
  const model = (ai.model || '').trim();
  if (!endpoint) return { provider: 'openai', configured: false, reachable: false, label: '未配置 Endpoint', detail: 'AI 平台未配置 API Endpoint' };
  const t0 = Date.now();
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: [{ role: 'system', content: 'ping' }, { role: 'user', content: 'hi' }], max_tokens: 5 }),
    });
    const latencyMs = Date.now() - t0;
    if (resp.ok) {
      const j = await resp.json().catch(() => ({}));
      const ok = !!(j.choices && j.choices[0] && j.choices[0].message);
      return { provider: 'openai', configured: true, reachable: ok, label: ok ? 'OpenAI 兼容可达' : 'OpenAI 响应异常', detail: ok ? `HTTP ${resp.status} · ${latencyMs}ms` : '响应缺少 choices 字段', latencyMs };
    }
    const txt = await resp.text().catch(() => '');
    return { provider: 'openai', configured: true, reachable: false, label: `OpenAI 不可达 (HTTP ${resp.status})`, detail: txt.slice(0, 160), latencyMs };
  } catch (e) {
    return { provider: 'openai', configured: true, reachable: false, label: 'OpenAI 不可达', detail: String(e.message || e).slice(0, 160), latencyMs: Date.now() - t0 };
  }
}
// 统一 AI 平台连通性判定（状态栏与测试连接共用，单一数据源）
async function checkAiStatus(aiCfg) {
  const provider = (aiCfg && aiCfg.provider) || 'none';
  if (provider === 'none') return { provider: 'none', configured: false, reachable: false, label: '未启用 AI 平台' };
  if (provider === 'codebuddy') return await testCodeBuddy(aiCfg);
  if (provider === 'openai') return await testOpenAI(aiCfg);
  return { provider, configured: true, reachable: false, label: provider, detail: '未知供应商' };
}

// ---------------------------------------------------------------------------
// AI CLI 登录态管理（默认 CodeBuddy CLI，预留多 provider 扩展）
// 设计：后端只负责"检测登录态"与"触发登录"（派生 CLI 打开浏览器 OAuth）。
//       凭证由 CodeBuddy CLI 自身持久化在用户配置目录，天然一次登录、后续免登。
// ---------------------------------------------------------------------------
const AI_CLI_PROVIDERS = {
  codebuddy: {
    id: 'codebuddy',
    name: 'CodeBuddy CLI',
    default: true,
    // 解析入口脚本（镜像 codebuddy-client.js 的 resolveCliScript）
    resolve: () => {
      if (process.env.CODEBUDDY_CODE_PATH) return process.env.CODEBUDDY_CODE_PATH;
      try {
        const groot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
        const p = path.join(groot, '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
        if (fs.existsSync(p)) return p;
      } catch (_) {}
      try {
        const w = execSync(process.platform === 'win32' ? 'where codebuddy' : 'command -v codebuddy', { encoding: 'utf-8' }).toString().trim().split(/\r?\n/)[0];
        if (w) return w;
      } catch (_) {}
      return 'codebuddy'; // PATH 兜底
    },
  },
};

// 候选的 codebuddy 登录令牌文件位置（不同版本/平台可能不同）——登录态兜底探测
function _codebuddyTokenCandidates() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [
    path.join(home, '.codebuddy', 'credentials.json'),
    path.join(home, '.codebuddy', 'auth.json'),
    path.join(home, '.codebuddy', 'session.json'),
    path.join(appData, 'CodeBuddy', 'credentials.json'),
    path.join(appData, 'codebuddy', 'credentials.json'),
    path.join(home, '.config', 'codebuddy', 'credentials.json'),
  ];
}
function _hasCodebuddyToken() {
  // 1) 旧路径兜底（部分版本把令牌写在这些位置）
  const legacy = _codebuddyTokenCandidates().some((c) => {
    try { return fs.existsSync(c) && fs.statSync(c).size > 0; } catch (_) { return false; }
  });
  if (legacy) return true;
  // 2) codebuddy 2.x：令牌与 IDE 扩展共享，写在
  //    %LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth/<产品>.<ts>.info
  //    内含有效 JWT（auth.expiresAt 为毫秒时间戳）。逐文件校验未过期即视为已登录。
  try {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const authDir = path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
    if (fs.existsSync(authDir)) {
      const infos = fs.readdirSync(authDir).filter((f) => f.endsWith('.info'));
      for (const f of infos) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(authDir, f), 'utf-8'));
          const exp = data && data.auth && data.auth.expiresAt;
          if (typeof exp === 'number' && exp > Date.now()) return true;
        } catch (_) { /* 忽略损坏文件 */ }
      }
    }
  } catch (_) {}
  return false;
}

// 启动 CLI：脚本为绝对 .js 路径时用 node 拉起；.cmd/.ps1/.bat/.exe 直接运行；PATH 兜底用 shell
function _spawnCli(script, args, opts) {
  if (script && script !== 'codebuddy' && fs.existsSync(script)) {
    const lower = script.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1') || lower.endsWith('.exe')) {
      return spawn(script, args, opts);
    }
    return spawn(process.execPath, [script, ...args], opts);
  }
  return spawn(script, args, Object.assign({ shell: true }, opts || {}));
}
// 运行 CLI 子命令并取合并输出（带超时）
function _runCli(script, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const cp = _spawnCli(script, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (d) => { out += d.toString(); };
    cp.stdout.on('data', onData);
    cp.stderr.on('data', onData);
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out }); };
    cp.on('close', finish);
    cp.on('error', () => finish(-1));
    const timer = setTimeout(() => { try { cp.kill(); } catch (_) {} finish(-2); }, timeoutMs || 20000);
  });
}

// 解析 CLI 脚本路径并判定是否"已安装"
async function _resolveAndCheckInstalled(prov) {
  const script = prov.resolve();
  if (script && script !== 'codebuddy') {
    return { script, installed: fs.existsSync(script) };
  }
  // PATH 兜底：用 --version 实测
  const v = await _runCli('codebuddy', ['--version'], 8000);
  return { script: 'codebuddy', installed: v.code === 0 && !/not recognized|not found|unknown command/i.test(v.out) };
}

// 检测某 provider 的 CLI 登录态（三态：not_installed / not_logged_in / logged_in）
async function checkAiCliStatus(provider) {
  const prov = AI_CLI_PROVIDERS[provider] || AI_CLI_PROVIDERS.codebuddy;
  const { script, installed } = await _resolveAndCheckInstalled(prov);
  if (!installed) {
    return { provider: prov.id, name: prov.name, installed: false, loggedIn: false, status: 'not_installed', message: '未检测到 CodeBuddy CLI，请先执行：npm i -g @tencent-ai/codebuddy-code' };
  }
  // 优先用官方 `auth status` 判定登录态
  const r = await _runCli(script, ['auth', 'status'], 20000);
  const o = (r.out || '').toLowerCase();
  let loggedIn = null;
  if (/(logged in|已登录|authenticated|登录有效|token.*valid|session.*valid)/.test(o)) loggedIn = true;
  else if (/(not logged|未登录|no (valid )?token|please log ?in|请登录|expired|unauthorized)/.test(o)) loggedIn = false;
  // 命令不支持 / 输出不明确时，用令牌文件存在性兜底
  if (loggedIn === null) loggedIn = _hasCodebuddyToken();
  const status = loggedIn ? 'logged_in' : 'not_logged_in';
  let message;
  if (loggedIn) message = '已登录，AI CLI 能力可用（一次登录，后续无需重复）';
  else message = (r.out && r.out.trim()) ? r.out.trim().slice(0, 200) : '未登录，请点击下方「登录」按钮在浏览器中完成授权';
  return { provider: prov.id, name: prov.name, installed: true, loggedIn, status, message };
}

// 触发登录：CodeBuddy 2.x 已无 `login` 子命令，登录须进入交互式 REPL 后用 `/login` 斜杠命令
// （会打开浏览器 OAuth）。因此这里派生一个「可见且持久」的交互式 CLI 窗口，由用户在窗口内输入
// /login 完成授权（一次性，令牌持久化在用户配置目录）。不再使用无头的 `codebuddy login`（已失效）。
function startAiCliLogin(provider) {
  const prov = AI_CLI_PROVIDERS[provider] || AI_CLI_PROVIDERS.codebuddy;
  return (async () => {
    const { script, installed } = await _resolveAndCheckInstalled(prov);
    if (!installed) return { success: false, error: '未检测到 CodeBuddy CLI，请先安装：npm i -g @tencent-ai/codebuddy-code' };
    try {
      let child;
      if (process.platform === 'win32') {
        // Windows：开一个持久 CMD 窗口跑 codebuddy REPL（/k 保持窗口，用户可输入 /login）
        child = spawn('cmd.exe', ['/k', 'codebuddy'], { detached: true, stdio: 'ignore', windowsHide: false });
      } else {
        // Linux/macOS：直接开交互式 REPL
        child = _spawnCli(script, [], { detached: true, stdio: 'ignore' });
      }
      child.unref();
      return { success: true, message: '已打开 CodeBuddy 交互窗口，请在窗口内输入 /login 完成浏览器授权（一次性，令牌将持久保存）' };
    } catch (e) {
      return { success: false, error: String((e && e.message) || e) };
    }
  })();
}

// 端点：AI CLI 登录态
app.get('/api/ai-cli/status', async (req, res) => {
  try {
    const s = await checkAiCliStatus((req.query && req.query.provider) || 'codebuddy');
    res.json({ success: true, data: s });
  } catch (e) {
    res.json({ success: false, error: String((e && e.message) || e) });
  }
});
// 端点：触发 AI CLI 登录（一次登录，后续免登）
app.post('/api/ai-cli/login', async (req, res) => {
  const r = await startAiCliLogin((req.body && req.body.provider) || 'codebuddy');
  res.json(r.success ? r : Object.assign({ success: false }, r));
});

// 测试连接：同时验证 KS API 可达性 与 AI 平台连通性
// 可选带 ksApiBase / ai 覆盖（来自设置表单，便于在保存前验证当前填写值）
app.post('/api/settings/test', async (req, res) => {
  const ksBase = (req.body && req.body.ksApiBase) || cfg.get().ks.apiBase;
  const aiOverride = (req.body && req.body.ai) || null;
  const aiCfg = aiOverride ? Object.assign({}, cfg.get().ai, aiOverride) : cfg.get().ai;
  // KS 探测
  const ksT0 = Date.now();
  let ks;
  try {
    const r = await fetch(ksBase.replace(/\/$/, '') + '/api/health', { method: 'GET' });
    ks = { reachable: r.ok, status: r.status, latencyMs: Date.now() - ksT0 };
  } catch (e) {
    ks = { reachable: false, error: String(e.message || e).slice(0, 160), latencyMs: Date.now() - ksT0 };
  }
  // AI 探测
  const ai = await checkAiStatus(aiCfg);
  res.json({ success: true, data: { ks, ai } });
});

// AI 平台真实连通状态（供前端状态栏指示，避免「已连接」展示性虚假连通）
// 30s 缓存，避免每次轮询都触发 CLI/网络探测
let _aiStatusCache = null;
let _aiStatusCacheAt = 0;
app.get('/api/ai-status', async (req, res) => {
  const now = Date.now();
  if (_aiStatusCache && now - _aiStatusCacheAt < 30 * 1000) {
    return res.json({ success: true, data: _aiStatusCache });
  }
  const out = await checkAiStatus(cfg.get().ai);
  _aiStatusCache = out;
  _aiStatusCacheAt = now;
  res.json({ success: true, data: out });
});

// 通配代理：将未单独声明的 /api/* 请求透传到知识系统，直接复用 KS /api/* 端点
// （覆盖 audit-log / stats / conflicts / brain 编辑与 promote 等尚未单独声明的端点）
// 注意：必须放在所有具体 /api 路由之后，避免抢占 /api/generate 等具体处理器
app.all('/api/*', async (req, res) => {
  try {
    let qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    // 多项目隔离：GET 代理若未显式带 project，注入统一默认 project（与前端/后端默认值一致）
    if (req.method === 'GET') {
      const params = new URLSearchParams(qs.replace(/^\?/, ''));
      if (!params.has('project')) { params.set('project', DEFAULT_PROJECT); qs = '?' + params.toString(); }
    }
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

// 全局错误处理器 + 进程级未捕获异常记录（纯落盘，不阻断行为）
app.use((err, req, res, next) => {
  logger.error(err, { path: req.path || req.url, method: req.method });
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: err.message || '服务器内部错误' });
});
process.on('uncaughtException', (e) => logger.error(e, { phase: 'uncaughtException' }));
process.on('unhandledRejection', (r) =>
  logger.error(r instanceof Error ? r : new Error(String(r)), { phase: 'unhandledRejection' }));

app.listen(PORT, () => {
  console.log(`[TestGen BFF] 监听 http://localhost:${PORT}  ·  知识系统 ${cfg.get().ks.apiBase}`);
});
