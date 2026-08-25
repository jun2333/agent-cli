---
tags: [harness, convention]
confidence: 0.5
created: 2026-08-25
last_used: 2026-08-25
use_count: 1
source_task: 001
status: active
invalidation_condition: "当 harness 改变任务目录命名规范（不再用 task-id 命名）时失效"
source_refs: [.harness/docs/orchestrator-design.md]
---

# task 目录命名规范（workspace/{task-id}）

## 场景
harness 工作流的任务目录命名。

## 问题
误以为任务目录名应为"task-id + 描述"的组合。

## 解决方案
harness 规范为 `workspace/{task-id}`（如 001）：目录名即 task-id（全小写 kebab-case，不含空格/中文），任务描述只存 `task.manifest.json` 的 `task_desc` 与 `task.md`，不进入目录名。编排器内部流转只认目录名。
