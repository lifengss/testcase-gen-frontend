# testcase-gen-frontend v2.0.0

AI 测试用例自动生成前端业务系统（BFF 编排层 + Web UI）正式发布 V2.0.0。

## 核心新特性

- **Kimi AI 客户端**：新增 `server/kimi-client.js`，支持 kimi (moonshot) 自定义模型通道，与 codebuddy/openai/none 统一接入 AI-Adapter，离线/自托管模型可直连。
- **Git 同步模块**：新增 git-sync 能力（含 `tests/full-suite/tc-git.cjs` 全套测试），支持草稿/知识页与 git 仓库双向同步。
- **教程 v2 重构**：`web/tutorial/` 章节重命名为 git/cases/search 等，新增 git、cases、search 三章与对应截图，manifest 版本随系统升至 2.x。
- **双驱动业务流 E2E 测试**：新增 `e2e-business-flow.cjs`（10 流 × UI+API，PASS=55/FAIL=0）、`e2e-isolation-test.cjs`、`e2e-kimi-test.cjs`。

## 主要改动

- `server/index.js`：BFF 代理与 AI 通道增强（193 行改动）。
- `web/app.v2.js` / `web/index.html`：V2 工作台 UI 重构（新增回测、图谱、项目切换、设置等模块）。
- `docs/TCGF-API-CONTRACT.md`：对外 API 契约文档更新，对齐 KS V1.0 接口。
- 测试套件 `tests/full-suite/*` 全面升级，分层自动化（tc-ui / tc-docs / tc-draft-review / tc-git / tc-flow / tc-display）。

## 版本说明

- `package.json` version = `2.0.0`，与教程 manifest `systemVersion` 一致。
- 教程版本规则：系统大版本升级（1.x → 2.x）时，tutorial 大版本跟随并重置 minor。

## 依赖与运行

```bash
npm install
npm start          # 启动 BFF，默认 :4123
```

AI 平台为可选依赖：默认走 kimi/codebuddy 通道，不可用时回退知识系统内置生成器与本地模板。
