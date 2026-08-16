# TCGF API 消费契约（前端 ↔ BFF ↔ KS）

> **用途**：TCGF（测试用例生成前端）侧 API 契约权威源。所有由 TCGF 前端/BFF 新增、调用的端点必须先在此登记，再开发。
> **对齐基线**：KS（test-knowledge-system）`docs/API-INTERFACE-DOC.md` 第 §12 节 Git 协同（S1 阶段）、§8 检索增强、§9 回测分流。
> **原则**：TCGF 仅作为 KS `/api/*` 的消费方，不另立后端语义；端点名/参数/响应信封须与 KS 文档逐字一致。
> **新增/变更流程**：① 在本文档登记端点；② 若端点属 KS 新能力，同步确认已在 KS `API-INTERFACE-DOC.md` 存在（不修改 KS，仅引用）；③ 按文档开发；④ 跑 script-check-skill 校验。

---

## 1. Git 协同（对齐 KS §12 · S1 阶段）

> S1 仅含 4 端点。pull / push / conflicts / diff / log 属 S2，TCGF M1 **不消费**，待 KS §12 扩展后再登记。

| 方法 | 路径 | 说明 | 关键参数 | 响应 data |
|------|------|------|----------|-----------|
| GET | `/api/git/config` | 读 Git 配置（remote/分支/身份/是否初始化） | query: `project` | `{ initialized, remote, branch, user:{name,email} }` |
| PUT | `/api/git/config` | 更新 Git 配置（不触发网络） | body: `project, remote, branch, user{name,email}` | `{ configured }` |
| POST | `/api/git/init` | 将 `brains/` 初始化为 Git 仓库 | body: `project, branch` | `{ initialized, branch, commitHash }` |
| POST | `/api/git/commit` | 暂存并提交 `brains/` 变更 | body: `project, message?, addAll?` | `{ commitHash, message, branch }` |
| GET | `/api/git/status` | 查 Git 工作区状态 | query: `project` | `{ initialized, branch, untracked[], modified[], staged[], ahead, behind }` |

**信封**：所有响应 `{ success:bool, data:{} }`（错误 `success:false, error:string`）。
**安全**：Git 限定 `brains/` 内；push 失败仅保留本地提交，KS 不存储凭证。

---

## 2. 检索增强（对齐 KS §8 · V2.0 规划，待 M3 登记）

> `POST /api/search` 扩展 `mode: keyword|semantic|hybrid`；响应项含 `score, source`（hybrid 标注语义命中）。

## 3. 回测分流（对齐 KS §9 · V2.0 规划，待 M2 登记）

> `POST /api/retest/plan`：body `{ project, scope, weights:{recentFail, severity} }`，返回加权分流计划。

---

## 变更日志

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0.0 | 2026-08-11 | 建立 TCGF 消费契约；登记 Git 协同 S1 四端点（对齐 KS §12）|
