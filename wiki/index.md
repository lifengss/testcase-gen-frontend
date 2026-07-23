# TestGen 前端业务系统 · 项目 Wiki

> 构建方式：Karpathy LLM Wiki（从 `raw/` 不可变源增量编译，交叉引用，持续维护）
> 维护对象：自动化测试用例生成前端业务系统 `testcase-gen-frontend`
> 关联：docs/架构设计与技术方案.md（权威设计）、需求列表.md、开发计划.md

## 目录索引

### 源摘要（Source Summaries）
- [[source-summary:知识管理系统-总体架构设计]] — 知识系统四层架构与业务端需求
- [[source-summary:AI测试用例自动生成系统-知识闭环能力PRD]] — 用例生成→沉淀→回流的知识闭环
- [[source-summary:架构设计与技术方案]] — 本系统架构设计原文摘要

### 概念（Concepts）
- [[concept:知识系统四层架构]] — L0 接入 / L1 检索 / L2 缓冲 / L3 GBrain
- [[concept:三层Prompt分离]] — 业务意图 / 执行模板 / 知识上下文
- [[concept:业务端集成模式]] — 路径A(经AI平台) 与 路径B(直连知识系统)
- [[concept:知识闭环数据流]] — 生成→编辑/回流→缓冲→双通路入库→赋能再生成
- [[concept:多项目隔离]] — 本地单人多项目的 project 隔离机制

### 实体（Entities）
- [[entity:测试用例生成前端业务系统]] — 本系统的定位、分层、模块
- [[entity:知识系统API契约]] — BFF 复用的 /api/* 端点契约

## 横向关系图

```
知识系统总体架构 ──业务端需求──▶ 本系统(实体)
        │                              │
        ├─四层架构─────────────────────┤
        ├─三层Prompt分离──▶集成模式────┤
        └─PRD闭环────────▶知识闭环数据流┘
                 多项目隔离 ◀── 知识系统 /api/projects
```

## 如何扩展本 Wiki
1. 新增/更新 `raw/` 源文件后，在对应 source-summary 增量修订。
2. 新概念/实体创建独立页，并在 index 与此处交叉引用。
3. 每次变更追加到 `log.md`。
