/**
 * 种子脚本：将本系统搭建过程中生成的测试用例与自动化测试脚本
 * 作为 human_edit 草稿写入 testCaseGenerator 项目，再批量入库到知识库。
 * 运行：node server/seed-testcases.js  （需 BFF 在 4123 监听）
 */
'use strict';
const PROJECT = 'testCaseGenerator';
const BASE = process.env.BFF_BASE || 'http://localhost:4123';

const cases = [
  {
    type: 'test_case',
    title: 'KS-Adapter 转发 /api/projects 正确注入 project',
    content: `# KS-Adapter 转发 /api/projects 正确注入 project

## 背景
业务前端所有请求需携带当前项目，KS-Adapter 必须将其透传到知识系统。

## 步骤
- 设置 localStorage['tg_currentProject'] = testCaseGenerator
- 调用 GET /api/projects
- 断言返回列表中包含 testCaseGenerator

## 预期
- 响应状态码 200
- data.projects 至少 1 项且存在 id=testCaseGenerator
- BFF 日志显示 project=testCaseGenerator 已透传

\`\`\`json
{ "expect": { "status": 200, "hasProject": "testCaseGenerator" } }
\`\`\``,
    metadata: { module: 'bff', generatedFrom: 'build' },
  },
  {
    type: 'test_case',
    title: 'source-upload 代码上传复用 knowledge-system API',
    content: `# source-upload 代码上传复用 knowledge-system API

## 背景
需求1：上传待测代码并自动生成项目 ID，实际经知识系统 /api/source-upload 完成。

## 步骤
- 新建项目获得 id（tg- 前缀）
- 选择代码压缩包，点击上传
- 断言知识系统 brains/<id>/ 出现解析结果

## 预期
- 调用 POST /api/projects 建项目
- 调用 POST /api/source-upload(type=code) 上传
- B3 API 图谱被刷新

\`\`\`text
POST /api/source-upload { file, type=code, project=testCaseGenerator }
\`\`\``,
    metadata: { module: 'upload', generatedFrom: 'build' },
  },
  {
    type: 'test_case',
    title: 'Context-Harvester 并发采集超时不影响生成',
    content: `# Context-Harvester 并发采集超时不影响生成

## 背景
生成前需只读采集 test-cases / quality-rules / graph-data / search，任一失败应降级。

## 步骤
- 关闭知识系统某检索端点
- 触发生成
- 断言仍返回内容（engine=template 或 ks-generator）

## 预期
- harvestContext 单项失败被 try/catch 吞掉
- stats 中失败项记为 0，不阻断主流程
- 前端显示降级提示而非报错

\`\`\`js
const safe = async (fn) => { try { return await fn(); } catch { return null; } };
\`\`\``,
    metadata: { module: 'generator', generatedFrom: 'build' },
  },
  {
    type: 'test_case',
    title: 'generate 路径A 三级回退（AI平台→KS生成器→模板）',
    content: `# generate 路径A 三级回退（AI平台→KS生成器→模板）

## 背景
需求4：生成经 AI 平台；未配置时回退知识系统生成器，再回退本地模板，保证链路可演示。

## 步骤
- 不配置 AI_ENDPOINT，调用 POST /api/generate {op:gen_cases}
- 断言返回 engine 字段为 ks-generator 或 template
- 断言 content 非空且含结构化用例

## 预期
- 优先真实 AI 平台（若配置）
- 次选知识系统 /api/generate-cases
- 兜底模板生成，engine=template

\`\`\`json
{ "engine": "template|ks-generator|ai-platform" }
\`\`\``,
    metadata: { module: 'generator', generatedFrom: 'build' },
  },
  {
    type: 'test_case',
    title: 'Writeback-Orchestrator 批量入库双通路',
    content: `# Writeback-Orchestrator 批量入库双通路

## 背景
需求5：编辑/回流草稿经冲突检测+质量门控后写 D1~D4，清空缓存并刷新 B3。

## 步骤
- 创建多条 human_edit 草稿
- 调用 POST /api/drafts/batch-commit
- 断言 brains/testCaseGenerator/test-cases/ 新增对应 .md

## 预期
- conflicts/detect 无冲突
- quality-gate 通过（结构化 Markdown ≥60）
- 缓冲层草稿清空，图谱增量刷新

\`\`\`bash
curl -X POST localhost:4123/api/drafts/batch-commit -d '{"project":"testCaseGenerator"}'
\`\`\``,
    metadata: { module: 'writeback', generatedFrom: 'build' },
  },
];

const scripts = [
  {
    type: 'test_script',
    title: 'test_ks_adapter.py',
    content: `# 自动化测试脚本：test_ks_adapter.py

\`\`\`python
import os, requests

BASE = os.getenv("BFF_BASE", "http://localhost:4123")

def test_projects_include_testCaseGenerator():
    r = requests.get(BASE + "/api/projects", params={"project": "testCaseGenerator"})
    assert r.status_code == 200
    ids = [p["id"] for p in r.json()["data"]["projects"]]
    assert "testCaseGenerator" in ids

def test_generate_returns_content():
    r = requests.post(BASE + "/api/generate", json={
        "op": "gen_cases", "project": "testCaseGenerator",
        "scope": {"modules": ["bff"], "depth": "smoke"},
        "constraints": {"framework": "pytest"}})
    assert r.status_code == 200
    assert r.json()["data"]["content"]
\`\`\``,
    metadata: { module: 'bff', framework: 'pytest', generatedFrom: 'build' },
  },
  {
    type: 'test_script',
    title: 'test_writeback.py',
    content: `# 自动化测试脚本：test_writeback.py

\`\`\`python
import os, requests

BASE = os.getenv("BFF_BASE", "http://localhost:4123")
PROJECT = "testCaseGenerator"

def _add_draft(title, content, type_):
    return requests.post(BASE + "/api/drafts", json={
        "project": PROJECT, "source": "human_edit", "type": type_,
        "title": title, "content": content, "metadata": {"generatedFrom": "test"}}).json()["data"]["id"]

def test_batch_commit_writes_test_cases():
    cid = _add_draft("草稿A", "# 用例A\\n\\n- 步骤1\\n- 步骤2\\n\\n\`\`\`json\\n{}\\n\`\`\`", "test_case")
    r = requests.post(BASE + "/api/drafts/batch-commit", json={"project": PROJECT})
    assert r.status_code == 200
    assert r.json()["data"]["committed"]
\`\`\``,
    metadata: { module: 'writeback', framework: 'pytest', generatedFrom: 'build' },
  },
  {
    type: 'test_script',
    title: 'test_generator_flow.spec.js',
    content: `# 自动化测试脚本：test_generator_flow.spec.js

\`\`\`js
describe('Generator flow', () => {
  it('injects project into context harvest', async () => {
    const r = await fetch('http://localhost:4123/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'gen_outline', project: 'testCaseGenerator' }),
    });
    const j = await r.json();
    expect(j.success).toBe(true);
    expect(j.data.project).toBe('testCaseGenerator');
  });
});
\`\`\``,
    metadata: { module: 'generator', framework: 'jest', generatedFrom: 'build' },
  },
];

async function main() {
  const items = [...cases, ...scripts];
  const ids = [];
  for (const it of items) {
    const r = await fetch(BASE + '/api/drafts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: PROJECT, source: 'human_edit', ...it }),
    });
    const j = await r.json();
    if (j.data && j.data.id) { ids.push(j.data.id); console.log('草稿已建:', it.title, j.data.id); }
    else { console.log('草稿失败:', it.title, JSON.stringify(j)); }
  }
  console.log(`\n共创建 ${ids.length} 条草稿，准备批量入库…`);
  const cr = await fetch(BASE + '/api/drafts/batch-commit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: PROJECT, draftIds: ids }),
  });
  const cj = await cr.json();
  console.log('批量入库结果:', JSON.stringify(cj.data || cj, null, 2));
}
main().catch(e => { console.error('SEED ERROR:', e); process.exit(1); });
