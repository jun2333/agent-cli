---
name: task-planning
description: 任务计划阶段技能（项目版）。把设计拆解为可执行步骤，记录命中的既有经验。
---

# Task-Planning Skill

## Overview
任务规划专家，将设计拆解为可执行的实施步骤，明确每步的验证方式（vitest 单测 + TUI e2e + build，见 testing-rules.md）。

## 角色
熟悉 agent-cli 变更链路的任务规划专家。

## 输入
- 任务描述（task.md）
- 设计文档（design.md）

## 上下文加载指令
1. 精读 design.md，理解技术方案
2. 读取 `knowledge/standards/` 与 `knowledge/patterns/`
3. **检索项目经验（knowledge/lessons/）**：读取 lessons 下文件 frontmatter（tags/标题），筛选相关经验，精读命中项
4. 按需加载源码：`src/index.ts`（入口/编排改动）、`src/ui/tui.ts`、`src/session.ts`
5. 评估工作量与依赖关系

## 执行步骤
0. **启动 Skill Log**:
   ```bash
   node .harness/tools/skill-log.js start \
     --skill knowledge/skills/task-planning/SKILL.md \
     --task-id {task-id} \
     --input-files "task.md,design.md"
   ```
1. 分析设计文档，识别实施要点
2. **记录命中的经验**到 task-plan.md 的 `## Lessons Applied`（含命中理由与规避/应用方式）；无命中显式声明
3. 拆解为具体实施步骤
4. 确定步骤间依赖关系
5. 评估每步工作量
6. 识别风险与关键路径（TUI 渲染改动风险最高，需补 UI e2e 验证）
7. 生成任务计划（使用 templates/task-plan-output.md）

8. **完成 Skill Log**:
   ```bash
   node .harness/tools/skill-log.js complete \
     --task-id {task-id} \
     --skill-name task-planning \
     --output-file task-plan.md \
     --confidence {置信度}
   ```

## 输出
生成 workspace/{task-id}/task-plan.md

## 约束
- 必须包含 Summary for downstream、Decision Log、Lessons Applied 区块
- 每个步骤必须有明确的输入、操作、产出、验证方式（验证方式对齐 testing-rules.md：vitest 单测 / UI e2e / build）
- 命中经验递增其 use_count 并更新 last_used（引用即消费；lessons-apply 工具自动记账）
- 无命中时明确写"本次未命中既有经验"
