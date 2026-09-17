---
tags: [documentation, honesty, review, evidence]
confidence: 0.5
created: 2026-09-17
last_used: 2026-09-17
use_count: 1
source_task: 006
status: active
invalidation_condition: "当文档改为由证据自动生成（声明与其探针强绑定、无法单独手写）时，本条价值下降"
source_refs: [.harness/workspace/006/changes.md, .harness/workspace/006/review-report.md]
---

# 对抗性/边界性的声明没有实测证据就不许写

## 场景
在 `changes.md`、测试报告或审查报告里描述"某处风险已被控制"时。

## 问题
任务 006 有**两处声明被实测推翻**：

1. `changes.md` B8#4 写「hook 有 `timeoutMs` 强制上限、窗口有限」——实测 `timeoutMs:100` 跑了 **5014ms**、默认 10s 下可**无限挂起**；
2. Rework-1 写「数组形状结果仍受 50KB 字节阈值**保护**」——实测 `list_dir` 4000 条目 51302B 被**按字节劈坏成非法 JSON**，是**损坏**而不是保护。

两处都写在"看起来已覆盖"的位置（风险表 / 修复说明），若不派独立复核，就会被下游当成事实接受。

## 解决方案
凡涉及**边界 / 对抗性**的声明（"有上限""受保护""不会发生""已覆盖""窗口有限"），必须：

1. 附**可复现的实测证据**（探针命令 + 数字），或
2. 显式标注「**未实测，仅为推断**」。

审查/复审阶段把「**声明与实测是否一致**」列为**独立检查项**——不只看代码逻辑是否讲得通，而是逐条问"这句话有没有被真正跑过"。
