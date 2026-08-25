---
tags: [harness, workflow, convention]
confidence: 0.5
created: 2026-08-25
last_used: 2026-08-25
use_count: 1
source_task: 002
status: active
invalidation_condition: "当 harness 的 sections 校验改为模糊匹配时失效"
source_refs: [.harness/orchestrator/validate.js, .harness/tools/stage-check.js]
---

# 工作流 sections 校验是精确标题匹配

## 场景
validate 检查阶段产出物的必含区块（workflow.yaml 的 sections）。

## 问题
给标题加前缀（如"完整性声明（Anti-Cherry-Pick Declaration）"）导致精确匹配失败，validate 报"缺少必含区块"，且触发 on_fail rework 回退。

## 解决方案
产出物标题必须与 workflow.yaml 的 sections **精确一致**（如 `## Anti-Cherry-Pick Declaration`），不要自行改写标题或加前后缀。
