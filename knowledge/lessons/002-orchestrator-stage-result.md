---
tags: [harness, orchestrator, workflow]
confidence: 0.5
created: 2026-08-25
last_used: 2026-08-25
use_count: 1
source_task: 001
status: active
invalidation_condition: "当 harness 的 stage-result 协议或 core.js validate/advance/approve 命令行为变更时失效"
source_refs: [.harness/docs/orchestrator-design.md, .harness/orchestrator/core.js]
---

# 对话式完成工作流阶段后需补编排层状态

## 场景
用 harness requirements 等工作流时，各阶段产出以对话方式完成（用户逐条拍板、文档定稿），但未逐阶段调用 `core.js` 推进编排层。

## 问题
`checkpoint.json` 停在旧阶段（completed/approved 为空），编排层认为任务未完成；`validate` 会因 `stage-result.json` 缺失而失败。

## 解决方案
补跑收尾：为每阶段写 `stage-result.json`（schema：stage/output_file/sections_ok/verify_evidence/notes，非验证阶段 verify_evidence 可为 null）→ `validate` → user_approval 阶段 `advance` 取一次性确认码 → AskUserQuestion 用户确认 → `approve --code` → `advance`，逐阶段推进直至 reflecting 完成。
