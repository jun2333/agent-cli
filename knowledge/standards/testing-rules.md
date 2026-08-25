---
tags: [standards, testing]
confidence: 0.9
created: 2026-08-25
status: active
source_refs: [package.json, tsconfig.json, vitest.config.ts]
invalidation_condition: "项目引入其他测试框架或测试策略变更时更新本文"
---

# 测试规范（agent-cli）

## 现状

- 已引入 **vitest**（`pnpm test` = `vitest run`），覆盖**确定性纯逻辑**：
  - `src/ui/` 渲染纯函数：`wrapText` / `truncateTo` / `inlineMarkdown` / `displayWidth` / `tailByWidth`（`src/ui/tui-format.test.ts`）
  - `src/session.ts`：锁行为、workspace 隔离、save/load 往返（`src/session.test.ts`）
  - `src/tools/`：参数校验、路径穿越防护、危险命令拦截（`src/tools/tools.test.ts`）
- 新增纯函数/工具逻辑时**必须补测试**（TDD：先写测试再实现）。
- 测试文件放 `src/` 同目录的 `*.test.ts`；tsconfig 已排除测试文件与 `vitest.config.ts`，不编译进 dist。

## 验证命令（verify.config.json 依据）

- `verify` 通道命令来自 `knowledge/verify.config.json`（v2 命令池）：
  - `build` = `pnpm build`（tsc 类型检查 + 编译）
  - `test` = `pnpm test`（vitest）
- feature/bugfix 工作流的 `verify.checks: [build, test]`。验证时**只读该配置**，不允许命令行自选命令（他证原则）。

## TUI / 终端渲染的验证方式

- **UI 端到端测试已固化**（`src/ui/tui.e2e.test.ts`）：用 ANSI 终端模拟器（`src/testing/term-sim.ts`）在进程内驱动 TUI，断言屏幕矩阵与滚动历史。
  - 覆盖：enter 界面结构、对话流式渲染（超一屏产生滚动历史）、markdown 渲染、resize 重绘、restoreHistory、键盘输入与回车提交（含 `enter`/`return` 两种键名兼容）。
  - mock 方式：`process.stdout.write` 喂给 TermSim；stdin 用 EventEmitter 模拟 keypress。
- **新增 UI 行为时补充 e2e 用例**（在 `tui.e2e.test.ts` 中）。
- 真实 PTY（起 `dist` 进程）仅作为手动冒烟验证，不纳入常规测试（慢、断言繁琐）。

### 模拟器注意点
- 宽字符（中文/符号）占两列，第二列用 `\u0000` 占位，输出方法自动去掉——断言时不会有假空格。
- resize 需先 `term.resize(rows)` 扩展屏幕再触发 `onResize`（不要用滚动区指令推断行数）。
- `\x1b[3J` 会清滚动历史（scrollback）。

## 约定

- 改动渲染逻辑后必须跑一次模拟器验证（至少验证流式结束 + resize 场景）。
- 改动会话逻辑（session.ts）后跑 `pnpm test`（session.test.ts 已覆盖）。
- 测试失败不得跳过；`pnpm test` 全绿是提交前提。
