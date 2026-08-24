# Agent Instructions

本项目使用 DevAgent Harness 工作流（`.harness` 为 submodule）。

## 何时使用 Harness

判断标准是**任务复杂度**：

- **需要走 harness**：任务涉及多步决策、有明确产出物、需要用户审批、或可能影响多个文件/模块
- **可以跳过 harness**：简单的单步操作（改个配置、修个 typo、回答一个问题）

## 如何启动

需要走 harness 流程时，从 `.harness/harness.md` 启动，**第一步是选择工作流**：

- 做新功能或重构 → `feature.yaml`
- 修 bug → `bugfix.yaml`
- 创建/重构技能 → `skill-creation.yaml`
- 项目初始化 → `project-init.yaml`

现有工作流都不匹配时，询问用户应该使用哪个工作流。不要跳过 harness 直接动手做复杂任务。

## 项目结构

- `src/` — MVP 源码（当前阶段：L1 agent loop + Bash/Read/Write 三工具 + REPL）
  - `src/index.ts` — REPL 入口
  - `src/agent/loop.ts` — agent loop
  - `src/tools/` — 工具定义与实现
- `.harness/` — DevAgent Harness submodule（工作流引擎，勿直接改动；有演进需求走 harness 流程）

## 运行

```
pnpm dev      # 启动 REPL
```

## 知识库

项目知识库在 `knowledge/`（harness 的 `project-init` 工作流会初始化）。框架通用技能在 `.harness/skills/`。
