# TCGF API 消费契约（前端 ↔ BFF ↔ KS）

> **用途**：TCGF（测试用例生成前端）侧 API 契约权威源。所有由 TCGF 前端/BFF 新增、调用的端点必须先在此登记，再开发。
> **对齐基线**：KS（test-knowledge-system）`docs/API-INTERFACE-DOC.md` 第 §12 节 Git 协同（S1 阶段）、§8 检索增强、§9 回测分流。
> **原则**：TCGF 仅作为 KS `/api/*` 的消费方，不另立后端语义；端点名/参数/响应信封须与 KS 文档逐字一致。
> **新增/变更流程**：① 在本文档登记端点；② 若端点属 KS 新能力，同步确认已在 KS `API-INTERFACE-DOC.md` 存在（不修改 KS，仅引用）；③ 按文档开发；④ 跑 script-check-skill 校验。

---

## 1. Git 协同（对齐 KS §12 · S1 + S2 完整阶段）

> KS §12 已开放 S1（config/status/init/commit）+ S2（push/pull/fetch/log/diff/conflict-content/resolve-conflict/branches/switch-branch）。TCGF 全量消费。

### S1 · 基础

| 方法 | 路径 | 说明 | 关键参数 | 响应 data |
|------|------|------|----------|-----------|
| GET | `/api/git/config` | 读 Git 配置 | query: `project` | `{ initialized, remote, branch, user:{name,email} }` |
| PUT | `/api/git/config` | 更新 Git 配置（不触发网络） | body: `remote, branch, user{name,email}` | `{ configured }` |
| POST | `/api/git/init` | 将 `brains/` 初始化为 Git 仓库 | body: `branch?` | `{ initialized, branch, commitHash }` |
| POST | `/api/git/commit` | 暂存并提交 `brains/` 变更 | body: `message?, addAll?` | `{ commitHash, message, branch, gbrainSynced?, gbrainNote? }` |
| GET | `/api/git/status` | 查工作区状态 | query: `project` | `{ initialized, branch, untracked[], modified[], staged[], conflicts[], hasConflict, ahead, behind }` |

### S2 · 同步 / 历史 / 冲突 / 分支

| 方法 | 路径 | 说明 | 关键参数 | 响应 data |
|------|------|------|----------|-----------|
| POST | `/api/git/push` | 推送当前分支到远端 | body: `branch?, force?` | `{ success, pushed, branch, output }` |
| POST | `/api/git/pull` | 拉取远端（默认 merge，`rebase=true` 走 rebase） | body: `branch?, rebase?` | `{ success, branch, ahead, behind, output }` |
| POST | `/api/git/fetch` | 仅取远端引用（不合并） | body: `branch?` | `{ success, branch, ahead, behind, output }` |
| GET | `/api/git/log` | 提交历史（版本树数据源） | query: `project, limit?` | `{ success, commits:[{hash, fullHash, author, email, date, message}], branch }` |
| GET | `/api/git/diff` | 工作树/暂存变更 diff（按文件分组） | query: `project, path?, cached?` | `{ success, files:[{path, additions, deletions, hunks[]}] }` |
| GET | `/api/git/conflict-content` | 读冲突文件原始内容（含 ours/theirs 标记） | query: `project, path` | `{ success, path, filename, category, title, content }` |
| POST | `/api/git/resolve-conflict` | 解决冲突 | body: `path, strategy(ours\|theirs\|both\|manual), content?` | `{ success, path, strategy }` |
| GET | `/api/git/branches` | 本地/远程分支列表+当前分支 | query: `project` | `{ success, current, locals[], remotes[] }` |
| POST | `/api/git/switch-branch` | 切换/新建分支 | body: `branch, create?, force?` | `{ success, branch, switched }` |

**信封**：所有响应 `{ success:bool, data:{} }`（错误 `success:false, error:string`）；`git_adapter.py` 在子命令层统一补 `success` 默认值。
**安全**：Git 限定 `brains/` 内；push 失败仅保留本地提交，KS 不存储凭证（config.user 仅用于 git identity，不落库凭证字段）。
**冲突**：status 新增 `conflicts[]`/`hasConflict`；conflict-content 返回含 `<<<<<<< ours / ======= / >>>>>>> theirs` 标记的原始文本，前端可页面内选择保留版本。

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
| 1.1.0 | 2026-08-16 | 扩展 Git 协同为完整 S1+S2（push/pull/fetch/log/diff/conflict-content/resolve-conflict/branches/switch-branch），对齐 KS §12 最新文档；commit 增 gbrainSynced/gbrainNote |
