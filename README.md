# testcase-gen-frontend

AI 测试用例自动生成系统的**前端业务系统**：承载"自动化测试用例生成"的用户交互与业务编排，定位为知识管理系统（`test-knowledge-system`）之上的**业务侧**实现。本系统不重建 AI harness / 知识存储，只负责意图编排与展示。

## 架构概览

采用 **三层 prompt 分离** 与 **两条对接路径**：

- **三层 prompt 分离**（换 AI 平台只改 AI-Adapter）
  1. 业务意图（本系统）
  2. 执行模板（AI 平台）
  3. 知识上下文（`test-knowledge-system`）
- **两条对接路径**
  - **路径 A（生成）**：经 AI 平台生成用例 / 脚本，落草稿缓冲层。
  - **路径 B（上传 / 确认）**：直连知识系统 REST（默认 `:3000`）入库、检索、图谱。

BFF（`server/index.js`，Express，默认 `:4123`）同时充当 KS-Adapter，直接复用知识系统的 `/api/*` 端点。

## 目录结构

```
testcase-gen-frontend/
├── server/                 # BFF + AI-Adapter（Express）
│   ├── index.js            # 服务入口：生成编排 + KS 代理透传
│   ├── config.js           # 配置读取
│   ├── codebuddy-client.js # CodeBuddy 通道（Windows 适配）
│   └── seed-testcases.js   # 草稿/知识库种子数据
├── web/                    # 前端（静态资源，Express 直接托管）
│   ├── index.html          # 生成中心页面
│   └── app.v2.js           # 主逻辑（生成/草稿/知识上下文/系统设置）
├── docs/                   # 架构设计 / 需求 / 开发计划
├── wiki/                   # Karpathy LLM Wiki（项目知识沉淀）
├── e2e-consistency-test.cjs# 与知识系统全量 E2E 一致性测试
├── .env.example            # 环境变量模板
└── package.json
```

## 环境要求

- Node.js >= 18
- 一个运行中的 `test-knowledge-system` 实例（默认 `http://localhost:3000`）

## 快速开始

```bash
npm install
cp .env.example .env      # 按需编辑 .env
npm start                 # 启动 BFF，监听 :4123
```

前端访问 http://localhost:4123

## 配置（`.env`）

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | BFF 端口 | `4123` |
| `KS_API_BASE` | 知识系统基址（路径 B） | `http://localhost:3000` |
| `AI_PROVIDER` | `openai` / `codebuddy` / `none` | `codebuddy` |
| `AI_MODEL` | 模型名（codebuddy 缺省 `claude-sonnet-4`） | — |
| `AI_ENDPOINT` / `AI_API_KEY` | OpenAI 兼容通道（provider=openai 生效） | — |
| `CODEBUDDY_API_KEY` | CodeBuddy 通道密钥 | — |
| `CODEBUDDY_INTERNET_ENVIRONMENT` | 国内版填 `internal`，国际版留空 | — |

> `AI_PROVIDER=none` 时强制走本地模板兜底（离线 / 演示）。

## 测试用例 vs 自动化脚本

系统在知识库中是**两个独立分类**：

- **测试用例** `test_case` → `test-cases/`（"测什么、怎么测"）
- **自动化脚本** `test_script` → `test-scripts/`（"可执行代码实现"，如 pytest/JUnit）

前端「知识上下文」卡片分别统计两者数量（取自 `GET /api/brain/stats`）。

## 开发脚本

```bash
npm run seed    # 写入种子草稿 / 知识库数据
```

## 一致性验证

```bash
# 需同时运行 BFF(:4123) 与 知识系统(:3000)
node e2e-consistency-test.cjs
```

## 测试与质量门禁

本仓库内置分层自动化测试，建议提交前运行：

```bash
# 1) 接口 + 数据一致性全量套件（A/B/C/D 组，需 BFF:4123 与 KS:3000 在线）
node tests/full-suite/run-all.cjs

# 2) 综合全量套件（叠加 UI 层 jsdom 渲染冒烟 + 文档契约一致性，需 BFF:4123 与 KS:3000 在线）
node tests/full-suite/run-all-comprehensive.cjs
```

- 覆盖：UI 层（导航/状态栏真实连通/视图切换）、接口层（BFF↔KS 草稿透传、编辑入库闭环、多项目隔离、中文上传无乱码）、数据层（配置/响应信封/落盘一致性）、文档层（路由↔前端调用↔架构文档契约一致、无裸数组响应、无双重 /api 笔误）。
- 报告：运行产物位于 `tests/full-suite/report/`（已 gitignore）。
- 端到端：另见 `e2e-consistency-test.cjs`（校验前后端知识库页面逐字节一致）。

## 版本与发布

当前正式版本见 `package.json` 的 `version`；发版以 `git tag vX.Y.Z` 标记，并同步本文件与 `web/tutorial/manifest.json` 的 `systemVersion`。

## 相关项目

- [`test-knowledge-system`](https://github.com/lifengss/test-knowledge-system)（知识管理系统，本系统的知识底座）
