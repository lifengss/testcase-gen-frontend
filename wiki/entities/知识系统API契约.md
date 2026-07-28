# 实体：知识系统 API 契约

> 来源：[[source-summary:架构设计与技术方案]] · [[source-summary:知识管理系统-总体架构设计]]
> 关联：[[entity:测试用例生成前端业务系统]] · [[concept:业务端集成模式]] · [[concept:多项目隔离]] · [[concept:知识闭环数据流]]

## 定义
本系统 BFF（KS-Adapter）直接复用的知识系统 REST 端点（端口 3000）。所有写操作必须带 `project`（多项目隔离，见 [[concept:多项目隔离]]）。

## 端点清单（BFF 直连，路径 B）

| 用途 | 方法 | 路径 | 关键参数 |
|------|------|------|----------|
| 列项目 | GET | `/api/projects` | — |
| 建项目 | POST | `/api/projects` | `{id,name,description}` |
| 删项目 | DELETE | `/api/projects/:id` | — |
| 上传代码/PRD | POST | `/api/source-upload` | `file`/`content`, `type`, `project` |
| 知识页读取 | GET | `/api/brain/pages` | `category`, `project` |
| 业务流图谱读取 | GET | `/api/business-graph` | `project` |
| 检索 | POST | `/api/search` | `{query,mode,limit,project}` |
| 建草稿 | POST | `/api/drafts` | `{source,type,title,content,metadata,project}` |
| 冲突检测 | POST | `/api/conflicts/detect` | `{project}` |
| 质量门控 | POST | `/api/quality-gate/check` | `{draft_ids,project}` |
| 单条入库 | POST | `/api/drafts/:id/commit` | `{skip_conflict_check,skip_quality_gate,project}` |
| 批量入库 | POST | `/api/drafts/batch-commit` | `{ids,project}` |

## category 取值（brain/pages）
`quality-rules`(D1) / `defect-experience`(D2) / `project-wiki`(D3) / `test-cases`(D4 历史用例) / `test-scripts`(D5 自动化脚本)。

## source 取值（drafts）
`human_edit`（人工编辑优化链路）/ `exec_backflow`（自动执行回流链路）。

## type 取值（drafts）
`quality_rule` / `test_case` / `test_script` / `defect_rule`。

## 一致性约束
- 上传代码 `type=code`；上传 PRD/需求 `type=prd`/`requirement`。
- 所有 POST 写操作 body 或 URL 注入 `project`，缺失时报错（知识系统 resolveProject 兜底）。
- 生成相关读操作（brain/pages、business-graph、search）为**只读**，不触发任何落库。
