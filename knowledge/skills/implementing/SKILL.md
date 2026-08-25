---
name: implementing
description: 实施阶段技能（项目版）。按 task-plan.md 执行代码变更，遵循项目代码规范，验证以项目验证配置为准。
---

# Implementing Skill

## Overview
实施工程师，负责按照任务计划在 TypeScript/Node ESM 项目中执行代码变更。项目已有 vitest（纯逻辑单测）+ ANSI 模拟器 UI 端到端测试，按"先测试后实现"执行。

## 角色
熟悉本项目（agent-cli：Node ESM + TypeScript strict + 自研 DECSTBM TUI）的 TypeScript 实施工程师。

## 输入
- 任务描述（task.md）
- 设计文档（design.md）
- 任务计划（task-plan.md）

## 上下文加载指令
1. 精读 task-plan.md，了解实施步骤
2. 读取 design.md，理解技术方案
3. 读取项目规范 `knowledge/standards/code-style.md`（命名/导入/注释约定）与 `knowledge/standards/testing-rules.md`（测试规范）
4. 按需读取相关 pattern：`knowledge/patterns/decstbm-rendering.md`（TUI 改动）、`knowledge/patterns/session-lock.md`（会话改动）
5. 按需加载源码：`src/ui/tui.ts`（渲染）、`src/session.ts`（会话）、`src/agent/loop.ts`（agent 循环）、`src/tools/`（工具）

## 执行步骤
0. **启动 Skill Log**:
   ```bash
   node .harness/tools/skill-log.js start \
     --skill knowledge/skills/implementing/SKILL.md \
     --task-id {task-id} \
     --input-files "task.md,design.md,task-plan.md"
   ```
1. 按照 task-plan.md 的步骤顺序执行
2. 每完成一个变更单元（TDD：先写测试再实现）：
   - **纯函数/工具逻辑**：在对应 `src/**/*.test.ts` 先写 vitest 用例（描述预期行为/边界）→ 运行确认失败（Red）→ 实现 → 全绿（Green）
   - **TUI 渲染逻辑**：在 `src/ui/tui.e2e.test.ts` 补端到端用例（用 TermSim 断言屏幕/滚动历史，覆盖流式结束 + resize 场景），再实现
   - **会话逻辑**：在 `src/session.test.ts` 补读写往返 + 锁行为用例
3. 运行 `pnpm test`（vitest）确认全部通过，`npx tsc --noEmit` 无 error（含 noUnusedLocals）
4. 如遇问题，记录并评估影响，不盲目重试
5. 全部完成后运行 `pnpm build`（由 `knowledge/verify.config.json` 提供）确认无回归，生成变更清单 changes.md

6. **完成 Skill Log**:
   ```bash
   node .harness/tools/skill-log.js complete \
     --task-id {task-id} \
     --skill-name implementing \
     --output-file changes.md \
     --confidence {置信度}
   ```

## 输出
生成 workspace/{task-id}/changes.md（变更清单）

## 约束
- 必须遵循 `knowledge/standards/code-style.md`：ESM 导入带 `.js` 后缀、类型导入用 `import type`、中文注释、避免大 if/else 用映射表
- 验证命令来源 `knowledge/verify.config.json`（build + test），不自行用其他命令充当"验证通过"证据
- 新增纯函数/工具/渲染/会话逻辑必须补对应测试，测试全绿是提交前提；改动渲染/会话核心逻辑后必须跑 UI e2e
