# 概念：三层 Prompt 分离

> 来源：[[source-summary:知识管理系统-总体架构设计]]
> 关联：[[concept:业务端集成模式]] · [[entity:测试用例生成前端业务系统]]

## 定义
将「生成一次测试用例」所需的 prompt 拆分为三层，分属不同系统，互不耦合：

| 层 | 归属 | 职责 | V1.0 载体 |
|----|------|------|-----------|
| 业务意图 | 业务前端 | 描述「做什么」（操作类型+参数+约束） | 业务意图 JSON（op/sourceRefs/scope） |
| 执行模板 | AI 平台 | 描述「怎么做」（专家角色、步骤、工具编排） | Agent 执行模板 / prompt 文件 |
| 知识上下文 | 知识系统 | 描述「知道什么」（检索+图谱+Brain 页） | Context-Harvester 聚合注入 |

## 价值
- **可替换性**：换 AI 平台（CodeBuddy ↔ WorkBuddy ↔ Coze MCP）只需替换执行模板层，业务前端与知识系统零改动。
- **关注点分离**：业务侧只管「要什么」，不写 prompt，避免 prompt 与业务耦合腐烂。

## 在本系统的落地
- 业务意图由前端 features/generator 构造 → BFF Intent-Orchestrator。
- 知识上下文由 Context-Harvester 从知识系统只读采集（详见 [[concept:知识闭环数据流]]）。
- AI 平台负责执行模板与 harness（[[entity:测试用例生成前端业务系统]] 的 AI-Adapter）。
