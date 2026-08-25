---
tags: [memory, design, rag-lite]
confidence: 0.5
created: 2026-08-25
last_used: 2026-08-25
use_count: 2
source_task: 001
status: active
invalidation_condition: "当长期记忆改为数据库/向量检索等非文件索引方案时失效"
source_refs: [.harness/workspace/001/task.md]
---

# 索引化记忆 + 按需加载

## 场景
CLI agent 需要跨会话长期记忆，但直接全量加载记忆进 system prompt 会随内容膨胀；LLM 需要先知道"有什么"再决定"读什么"。

## 问题
单文件全量加载 → prompt 膨胀；纯索引（只有标题+条数）→ LLM 无法感知内容，仍需逐个读文件。

## 解决方案
按类型拆记忆文件 + `index.md`（类型分组 + 每条一句话摘要/记忆碎片）；启动只把索引拼进 system prompt，LLM 看索引掌握大概、不确定时用 `read_memory(topic)` 按需读详情；索引由工具自动维护（append/write 后重扫生成），LLM 不直接写文件，保证索引与文件一致。
