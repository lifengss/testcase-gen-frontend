'use strict';
// 全量测试主运行器（整合版）：覆盖 A/B/C/D（接口+数据+展示）+ UI（jsdom 渲染）+ DOC（文档契约）。
// 复用 lib.cjs 的 Report/httpReq，报告写入 tests/full-suite/report/（文件名前缀 full-test-report-）。
const fs = require('fs');
const path = require('path');
const { httpReq, asArray, Report, logResult } = require('./lib.cjs');

const BASE_BFF = process.env.BFF_BASE || 'http://localhost:4123';
const BASE_KS = process.env.KS_BASE || 'http://localhost:3000';
const PROJECT = process.env.TEST_PROJECT || 'testCaseGenerator';

const CASES = [].concat(
  require('./tc-display.cjs'),
  require('./tc-draft-review.cjs'),
  require('./tc-data-consistency.cjs'),
  require('./tc-flow.cjs'),
  require('./tc-ui.cjs'),
  require('./tc-docs.cjs')
);

function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function buildMarkdown(rep) {
  const s = rep.summary();
  const lines = [];
  lines.push('# testcase-gen-frontend 全量测试报告（接口/UI/数据/文档）');
  lines.push('');
  lines.push(`- 生成时间：${rep.started}`);
  lines.push(`- 测试环境：BFF=${BASE_BFF}　KS=${BASE_KS}　Project=${PROJECT}`);
  lines.push(`- 用例总数：${s.total}　PASS=${s.pass}　FAIL=${s.fail}　WARN=${s.warn}　INFO=${s.info}`);
  lines.push('');
  lines.push('## 一、结论速览');
  lines.push('');
  const fails = rep.cases.filter((c) => c.status === 'fail');
  if (fails.length) {
    lines.push('### 🔴 必须修复项（FAIL）');
    for (const c of fails) lines.push(`- **[${c.id}] ${c.name}**（severity=${c.severity}）：${c.evidence}`);
  } else {
    lines.push('🔴 必须修复项：无');
  }
  lines.push('');
  const warns = rep.cases.filter((c) => c.status === 'warn');
  lines.push(`### 🟡 建议改进项（WARN）：${warns.length} 项`);
  for (const c of warns) lines.push(`- [${c.id}] ${c.name}（${c.severity}）：${c.evidence}`);
  lines.push('');
  lines.push('## 二、分组明细');
  lines.push('');
  const groups = {};
  for (const c of rep.cases) (groups[c.group] = groups[c.group] || []).push(c);
  for (const g of Object.keys(groups)) {
    lines.push(`### ${g}`);
    lines.push('');
    lines.push('| 编号 | 名称 | 严重度 | 结果 | 说明 | 证据 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const c of groups[g]) {
      const esc = (x) => String(x).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${c.id} | ${esc(c.name)} | ${c.severity} | ${c.status.toUpperCase()} | ${esc(c.detail)} | ${esc(c.evidence)} |`);
    }
    lines.push('');
  }
  lines.push('## 三、测试范围说明');
  lines.push('');
  lines.push('- **A 组（展示/虚假连通/冗余）**：静态读取前端源码，验证状态栏连通指示灯联动真实探测、重复 id、冗余变量、遗留旧文件。');
  lines.push('- **B 组（草稿审阅一致性）**：对比业务前端草稿审阅页与 KS 草稿审核页差异，验证后端编辑能力、列表透传、source 过滤。');
  lines.push('- **C 组（数据一致性）**：多项目隔离默认注入、知识库规模统计 BFF 与 KS 一致、中文 PRD 上传乱码回归。');
  lines.push('- **D 组（流程逻辑）**：生成链路不挂死、草稿入库闭环、编辑草稿闭环持久化。');
  lines.push('- **UI 组（jsdom 真实渲染冒烟）**：在 Node 内加载 index.html+app.v2.js 并桩接 fetch，验证初始化无 JS 异常、导航结构、状态栏真实反映连通性、KS 不可达时 UI 锁定（无假项目卡）、AI 状态真实渲染、视图切换。属 DOM 级冒烟（非像素/视觉）。');
  lines.push('- **DOC 组（文档/契约一致性）**：解析 server/index.js 路由、app.v2.js 前端调用、架构文档接口契约，校验 BFF 自有端点实现、前端调用路径一致（双重 /api）、文档↔代码可达性、响应信封。');
  lines.push('');
  lines.push('> 本报告由全量测试套件自动生成，脚本留存于 `tests/full-suite/`。');
  return lines.join('\n');
}

async function main() {
  console.log(`\n=== 全量测试（整合）开始 ===  BFF=${BASE_BFF}  KS=${BASE_KS}  PROJECT=${PROJECT}  用例=${CASES.length}\n`);
  const rep = new Report();
  rep.env = { BASE_BFF, BASE_KS, PROJECT };

  try {
    const hb = await httpReq(BASE_BFF, 'GET', '/api/health', { timeout: 8000 });
    const hk = await httpReq(BASE_KS, 'GET', '/api/projects', { timeout: 8000 });
    console.log(`BFF 健康: ${hb.status}　KS 健康: ${hk.status}`);
    if (!hb.ok) console.log('⚠ BFF 不可达，依赖 BFF 的用例可能失败');
    if (!hk.ok) console.log('⚠ KS 不可达，依赖 KS 的用例可能失败');
  } catch (e) {
    console.log('⚠ 健康检查异常: ' + e.message);
  }

  const ctx = { bff: BASE_BFF, ks: BASE_KS, PROJECT, http: httpReq, asArray };

  for (const tc of CASES) {
    try {
      const r = await tc.run(ctx);
      rep.add(Object.assign({ id: tc.id, name: tc.name, group: tc.group, severity: tc.severity }, r || { status: 'info' }));
    } catch (e) {
      rep.add({ id: tc.id, name: tc.name, group: tc.group, severity: tc.severity, status: 'fail', detail: '运行器兜底捕获异常', evidence: String(e.stack || e) });
    }
    logResult(rep.cases[rep.cases.length - 1]);
  }

  const s = rep.summary();
  console.log(`\n=== 测试结束 ===  PASS=${s.pass} FAIL=${s.fail} WARN=${s.warn} INFO=${s.info}  TOTAL=${s.total}\n`);

  const outDir = path.join(__dirname, 'report');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = ts();
  const mdPath = path.join(outDir, `full-test-report-${stamp}.md`);
  const jsonPath = path.join(outDir, `full-test-report-${stamp}.json`);
  fs.writeFileSync(mdPath, buildMarkdown(rep), 'utf-8');
  fs.writeFileSync(jsonPath, JSON.stringify({ started: rep.started, env: rep.env, summary: s, cases: rep.cases }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outDir, 'full-latest.json'), JSON.stringify({ md: mdPath, json: jsonPath, stamp }), 'utf-8');
  console.log('报告已生成:');
  console.log('  ' + mdPath);
  console.log('  ' + jsonPath);
  return s;
}

if (require.main === module) {
  main().then((s) => { process.exit(s.fail > 0 ? 1 : 0); }).catch((e) => { console.error(e); process.exit(2); });
}

module.exports = { main, buildMarkdown };
