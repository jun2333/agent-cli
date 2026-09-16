---
tags: [standards, code-style, typescript]
confidence: 0.9
created: 2026-08-25
status: active
source_refs: [src/index.ts, src/ui/tui.ts, src/session.ts]
invalidation_condition: "项目迁移到非 TS 或整体重构改变风格时失效"
---

# 代码规范（agent-cli）

基于项目实际代码提炼，改动代码时必须遵守。

## 语言与运行

- **TypeScript strict 模式**（tsconfig `strict: true`），额外开启 `noUnusedLocals`/`noUnusedParameters`/`isolatedModules`。
- **Node ESM**（`package.json` 的 `"type": "module"`），开发用 `tsx` 运行，编译产物在 `dist/`。
- 所有相对导入**必须带 `.js` 后缀**（如 `from './ui/tui.js'`），适配 ESM 编译产物。

## 命名

- 文件名：小写连字符（`tui.ts`、`session.ts`、`loop.ts`）。
- 类：`PascalCase`（`TUI`）；构造函数注入依赖（banner）。
- 函数/变量：`camelCase`；常量：`UPPER_SNAKE`（`DIM`、`RESET`、`STATUS_STYLE`）。
- 类型/接口：`PascalCase`；联合类型消息模型用 `MsgBlock` 判别联合（`type` 字段区分）。
- 私有成员：TS `private` 关键字，不用下划线前缀。

## 导入

- 类型导入用 `import type`（如 `import type OpenAI from 'openai'`），配合 `isolatedModules`。
- 值导入与类型导入分开写。

## 注释

- **中文注释**，说明设计意图和"为什么"，不重复代码本身。
- 关键算法/易错点（如 DECSTBM 滚动、会话锁 pid 探测）必须写块注释解释原因。
- 状态/样式等集中定义处注释"暗→亮层次"等设计原则。

## 结构

- 模块内顺序：常量/类型 → 工具函数 → 类/主逻辑 → 导出。
- 单一职责：入口（index）只管编排；渲染（tui）只管终端；会话（session）只管持久化。
- 大 if/else 用枚举 + 映射表替代（如 `StatusKind` + `STATUS_STYLE`、`phaseToStatus`）。

## 格式

- 2 空格缩进、单引号、**不使用语句尾分号**（依赖 ASI，与全仓库既有代码一致）。
  > 2026-09-16 修订：原文要求"语句尾分号"，但全仓库（含存量代码）均不使用分号，导致"逐条对照规范"必然误判不合规（任务 004 的独立审查 I-10）。以实际代码为准。
- 模板字符串用于拼装带变量文本（尤其是 ANSI 序列）。
