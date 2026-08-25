---
name: testing
description: 测试阶段技能（项目版）。vitest 单测（session/tools/渲染纯函数）+ ANSI 模拟器 UI 端到端（tui.e2e.test.ts），verify 通道执行 build+test。
---

# Testing Skill

## Overview
严谨的测试工程师。验证分三层：`verify.js run` 执行项目验证命令（`pnpm build` + `pnpm test`，vitest 覆盖纯逻辑与 UI e2e），需要时补充针对变更的专项用例。

## 角色
熟悉项目验证手段（vitest、tsc 类型检查、ANSI 模拟器 e2e）的测试工程师。

## 输入
- 任务描述（task.md）
- 任务计划（task-plan.md）
- 变更清单（changes.md）

## 上下文加载指令
1. 精读 changes.md，了解所有变更
2. 读取变更文件及其依赖（如 `src/ui/tui.ts`、`src/session.ts`）
3. 读取 `knowledge/standards/testing-rules.md`（测试覆盖范围与模拟器注意事项）
4. 按需加载相关 pattern（decstbm-rendering.md / session-lock.md）
5. 读取现有测试文件（`src/**/*.test.ts`），了解覆盖情况

## 执行步骤
0. **启动 Skill Log**:
   ```bash
   node .harness/tools/skill-log.js start \
     --skill knowledge/skills/testing/SKILL.md \
     --task-id {task-id} \
     --input-files "task.md,task-plan.md,changes.md"
   ```
1. 运行项目验证命令（命令来自 `knowledge/verify.config.json`，不允许自选）:
   ```bash
   node .harness/tools/verify.js run \
     --output-dir .harness/workspace/{task-id}/test-results \
     --report .harness/workspace/{task-id}/verify/verification-result.json
   ```
2. 读取 verification-result.json，记录每个命令的 exit_code / log_path
3. 检查变更是否已有测试覆盖，按变更类型补充/确认：
   - **纯函数/工具/会话逻辑**：`src/**/*.test.ts`（vitest）覆盖
   - **TUI 渲染**：`src/ui/tui.e2e.test.ts`（TermSim 断言屏幕/滚动历史，流式 + resize 场景）
4. 验证 task.md 中的验收标准是否满足
5. 生成测试报告（使用 templates/test-report-output.md，引用 verification-result.json 数据）

6. **完成 Skill Log**:
   ```bash
   node .harness/tools/skill-log.js complete \
     --task-id {task-id} \
     --skill-name testing \
     --output-file test-report.md \
     --confidence {置信度}
   ```

## 输出
生成 workspace/{task-id}/test-report.md

## 约束
- 测试报告必须包含 Summary for downstream 和 Anti-Cherry-Pick Declaration
- 列出**全部**执行的验证命令/测试用例的实际结果（PASS/FAIL/NOT-RUN），不隐藏
- 验证命令只来自 `knowledge/verify.config.json`，`verify.js` 会拒绝 `--commands` 自选命令（他证原则）
- 新增逻辑必须有对应测试（TDD）；测试失败不得跳过，全绿是提交前提
- UI e2e 注意：resize 先 `term.resize()` 扩展屏幕再触发 onResize；`\x1b[3J` 清滚动历史；PTY 下回车键名可能是 `enter` 而非 `return`
