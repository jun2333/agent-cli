---
name: designing
description: 设计阶段技能（项目版）。将需求转化为技术方案，决策记录进 design.md，至少 2 个备选方案。
---

# Designing Skill

## Overview
技术设计专家，将需求转化为可实施的 TypeScript/Node 方案。设计要贴合本项目分层（index 编排 / agent loop / tools / tui 渲染 / session 持久化）与既有 pattern。

## 角色
熟悉 agent-cli 架构（入口编排、DECSTBM TUI、会话持久化）的技术设计专家。

## 输入
- 任务描述（task.md）
- 项目知识库（knowledge/）

## 上下文加载指令
1. 精读 task.md，理解需求
2. 读取 `knowledge/standards/`（code-style、testing-rules）与 `knowledge/patterns/`（decstbm-rendering、session-lock）
3. 按需加载源码：`src/ui/tui.ts`、`src/session.ts`、`src/agent/loop.ts`、`src/index.ts`
4. 如涉及需求理解，参考 `docs/requirements.md`

## 执行步骤
0. **启动 Skill Log**:
   ```bash
   node .harness/tools/skill-log.js start \
     --skill knowledge/skills/designing/SKILL.md \
     --task-id {task-id} \
     --input-files "task.md"
   ```
1. 分析需求，明确设计目标
2. 调研现有实现与约束（复用既有 pattern：渲染/会话/状态映射）
3. 提出至少 2 个备选方案
4. 对比优缺点（基于项目实际约束：vitest 纯逻辑单测 + TUI e2e 基础设施、自研 DECSTBM TUI 特殊性）
5. 做出选择并记录理由
6. 生成设计文档（使用 templates/design-output.md）

7. **完成 Skill Log**:
   ```bash
   node .harness/tools/skill-log.js complete \
     --task-id {task-id} \
     --skill-name designing \
     --output-file design.md \
     --confidence {置信度}
   ```

## 输出
生成 workspace/{task-id}/design.md

## 约束
- 必须包含 Summary for downstream 和 Decision Log 区块
- 至少 2 个备选方案，说明选择理由与放弃方案
- 标注 Source Tag（confirmed/advisory/user）
- 设计尽量复用既有模式（decstbm-rendering / session-lock / StatusKind 映射），不重复造轮子
