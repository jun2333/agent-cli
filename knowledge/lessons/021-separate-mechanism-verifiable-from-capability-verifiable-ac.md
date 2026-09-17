---
tags: [requirements, acceptance-criteria, cross-phase, verification]
confidence: 0.5
created: 2026-09-17
last_used: 2026-09-17
use_count: 1
source_task: 006
status: active
invalidation_condition: "当需求不再跨期引用（单期交付、无下游依赖）时，本条价值下降"
source_refs: [.harness/workspace/005/task.md, .harness/workspace/006/design.md]
---

# 写 AC 要区分「机制可验」与「端到端可验」，否则会造出假的 NOT-RUN

## 场景
需求阶段为某条能力写验收标准，而该能力的完整实现落在下游期。

## 问题
任务 005 把 AC-23 写成「已发现的**技能**出现在 `/` 候选列表中（对应 **FR-4 + FR-10**）」，而 FR-10（技能系统）在 P4、不在本期范围 → 结论只能是 **NOT-RUN**，等于埋了一条"看起来不可验"的假象。

用户一眼看出问题："斜杠菜单不只列技能，也列内置命令"——这条 AC 真正要验的是「**候选源可扩展**」这个机制，顺带实现"最小技能发现"（扫技能目录取 frontmatter `name` 注册为候选源，约 30~60 行）就能**端到端验掉**。最终 AC-23 由 NOT-RUN 转为真 PASS、`it.skip` 归零；P4 只需接上索引注入与 `read_skill`/`write_skill`，发现层不重做。

## 解决方案
写 AC 时把两类**分开写**：

1. 「**机制可验**」——本期可端到端验的部分（候选源注册后条目即出现；可用测试桩或最小实现验证）；
2. 「**能力可验**」——需要下游期交付的能力本体。

**不要用「X + Y」的复合编号把跨期依赖藏进一条 AC**，否则本期只能给出 NOT-RUN，而真正的验证缺口（机制其实可验）被掩盖。
