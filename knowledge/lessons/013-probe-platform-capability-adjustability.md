---
tags: [ollama, capability-probe, design-assumption]
confidence: 0.5
created: 2026-09-16
last_used: 2026-09-17
use_count: 2
source_task: 004
status: active
invalidation_condition: "当 Ollama 在 /v1 上支持 num_ctx，或项目改用原生 /api/chat 后，本条的具体结论失效；『参数是否生效要实测』的方法论不变"
source_refs: [src/agent/loop.ts, src/config.ts, .harness/workspace/004/changes.md]
---

# 平台能力"能不能按请求调整"必须实测，不能按文档或直觉假设

## 场景
设计要依赖某个外部服务/运行时的可调参数（上下文长度、并发、超时）。

## 问题
设计阶段假设"上下文长度可以通过请求参数调大"。实测发现：Ollama 的 **`/v1`（OpenAI 兼容接口）完全忽略** `options.num_ctx`、顶层 `num_ctx`、`max_tokens`（全部恒为 4096），**只有**原生 `/api/chat` 的 `options.num_ctx` 或服务端环境变量 `OLLAMA_CONTEXT_LENGTH` 才生效。

这个假设错误直接放大了"静默截断"问题（图片 2000+ tokens 挤在 4096 里），也让"在请求里调大上下文"这个本该最简单的修法**根本不可行**，只能改为"上报截断 + 引导用户改环境变量"。

**注意"接口不报错"≠"参数生效"**——`/v1` 对未知字段静默忽略并返回 200。

## 解决方案
设计阶段对每个"我打算调的参数"做一次最小实测：

1. 发一次带该参数的请求
2. 用观测接口确认参数**真的生效**（本项目用 `/api/ps` 读实际 `context_length`，而非只看 HTTP 状态码）
3. 把结论写进设计的约束区（本项目据此把"`/v1` 上下文固定 4096、无法按请求调大"写进 `design.md` 与截断提示文案）
