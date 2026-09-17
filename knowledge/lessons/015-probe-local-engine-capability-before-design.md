---
tags: [requirements, ollama, prompt-cache, measurement, context-management]
confidence: 0.5
created: 2026-09-17
last_used: 2026-09-17
use_count: 2
source_task: 005
status: active
invalidation_condition: "当上游不再是本地 Ollama（改用带计费的云端 API，或换了不支持前缀复用的推理后端）时，「缓存收益是延迟而非成本」的结论失效，需重新实测"
source_refs: [.harness/workspace/005/task.md, src/agent/loop.ts, src/index.ts]
---

# 需求阶段先实测本地推理引擎的隐式能力，再设计上下文/缓存方案

## 场景
设计上下文管理、缓存、性能优化类需求时；尤其当用户问"别人（云端 CLI）的缓存是怎么做的"。

## 问题
任务 005 中用户问"其他 harness cli 的缓存是如何做到的？"。若直接照搬云端结论，会拿到错误的设计前提——Claude Code 的 prompt caching 是**成本**优化（缓存读取费率约为标准输入的 10%），而本机 Ollama **没有计费**，照抄会得出"缓存无收益、不必设计"的结论。实测前无法确定本地引擎是否支持前缀复用。

## 解决方案
在需求阶段就写最小探测脚本直接测引擎能力，而不是等实现期才发现：

1. 对同一模型发 4 个请求：冷启动 / 同前缀换问题 / 破坏前缀（改 system）/ 重复上一个
2. 比较 `/api/chat` 返回的 `prompt_eval_duration`（注意：`prompt_eval_count` 仍是全量计数，看不出复用，只有 duration 能反映）
3. 实测结果：1848 tokens 前缀的 prefill **8587ms → 192ms（44×）**；破坏 system 回到 **8581ms**
4. 据此把"缓存"从**成本问题**重定义为**延迟问题**，并升级为硬约束（D23：请求只在末尾追加，易变内容一律走对话消息，不得改写 system prompt 前部）
5. 该约束随后直接决定了技能索引的注入位置（D30：作为对话消息追加一次，不常驻 system prompt）

关键收益：实测不只用来"证伪某个选项"，还能**重定义问题本身**——同一份 44× 数据，在"成本"框架下毫无价值，在"延迟"框架下变成整个路线图最强的设计约束。

## 附加发现（同一个探测的副产品）
现有实现**已经吃到**这个红利（`buildSystemPrompt()` 只在启动时组装一次、system prompt 无易变内容、messages 只 append），所以这条经验的价值不是"去实现缓存"，而是"**别把已经生效的东西弄坏**"——凡是往请求前部塞易变内容（时间戳、目录树、每轮刷新的索引）的改动，都会让每轮 prefill 从 0.2s 退回 8.6s。
