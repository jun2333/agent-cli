---
tags: [agent-loop, error-handling, observability]
confidence: 0.5
created: 2026-09-16
last_used: 2026-09-17
use_count: 2
source_task: 004
status: active
invalidation_condition: "当上游模型/网关开始保证『任何结束都带明确原因且不出现空产出』，或项目改用带内建截断上报的 agent 框架时，本条紧迫性下降"
source_refs: [src/agent/loop.ts, src/agent/loop.test.ts, src/index.ts]
---

# 循环必须把"结束了但没产出"当成一等事件上报

## 场景
任何"多轮迭代直到产出结果"的循环（agent loop、构建流水线、重试器）。

## 问题
用户反馈「给一张图问它是啥内容，思考模型选了 max，它思考着就停了、也没完成」。根因是一条 6 步失败链的**末端**：

1. `Ctrl+V` 直投图片 → user 消息只有图、无路径文本
2. 模型仍要调 `view_image` 并**凭空编造路径**
3. 工具报不存在，模型继续思考纠错
4. 本机 Ollama 的 `/v1` 上下文固定 4096 且无法按请求调大，图片占 2000+ tokens 加 `think=max` 迅速耗尽预算
5. 模型以 `finish_reason='length'` 结束，**既无 content 也无 tool_calls**
6. `runAgentLoop` 见"没有工具调用"就 `return` → **用户看不到任何提示**

同类问题还有"用尽 `maxIterations` 仍未得到最终回答"——同样静默结束。

## 解决方案
循环的退出路径要显式区分三类：① 正常完成；② 被截断（`finish_reason === 'length'`）；③ 结束但**没有任何产出**（正文字符数为 0）或**迭代耗尽**。

后三类都要产出**可见且可操作**的错误事件（本例新增 `{ type: 'error'; message }`，文案给出三条出路：降思考等级 / 设 `OLLAMA_CONTEXT_LENGTH` / 缩小输入）。

实现要点：**逐轮重置** `finishReason` 与 `contentChars`，避免把上一轮状态带到下一轮；判定顺序让 `length` 优先于"无产出"，避免同一次失败报两条。
