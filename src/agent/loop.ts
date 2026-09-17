import type OpenAI from 'openai'
import { classifyToolResult, type ToolImplementations, type ToolResult } from '../tools/index.js'

/**
 * Agent loop 的事件契约（B1 修正版，唯一版本）。
 *
 * 与改动前的差异（这三处正是"状态栏不实时"的根因）：
 * - `tool_start` **只 emit 一次**且在 `await fn(args)` **之前**，必带 `callId/name/args`
 *   （旧实现 emit 两次，第二次不带 name → 上层把工具名清空，AC-2 的反例）；
 * - `tool_end` 不再被忽略，携带耗时/输出行数/字节（旧实现根本没有它，
 *   导致"Running tool"残留到下一次 llm_start）；
 * - 删除 `tool` 事件（它在工具**执行完之后**才 emit → 工具行滞后）。
 *   工具行改由 `tool_start`/`tool_end` 驱动，做到"开始执行即渲染 + 完成后原地更新"。
 */
export type LoopEvent =
  | { type: 'status'; phase: 'llm_start' }
  | { type: 'reasoning'; content: string }
  | { type: 'token'; content: string }
  | { type: 'tool_start'; callId: string; name: string; args: unknown }
  | {
      type: 'tool_end'
      callId: string
      name: string
      ok: boolean
      durationMs: number
      outputLines: number
      outputBytes: number
      error?: string
    }
  | { type: 'error'; message: string }

/**
 * 输出被截断时的提示。
 *
 * 背景（真实用户反馈 + 实测）：本机 Ollama 的 /v1 上下文固定 4096，且**无法按请求调大**
 * （顶层 num_ctx、options.num_ctx、max_tokens 实测全被忽略；只有原生 /api/chat 的
 * options.num_ctx 或服务端 OLLAMA_CONTEXT_LENGTH 才生效）。图片本身要占 2000+ tokens，
 * 若再用 think=max 思考，预算很快耗尽 → 模型以 finish_reason='length' 结束、
 * **既无 content 也无 tool_calls**。旧实现此时直接 return，用户只看到"思考着就停了、没回答"。
 */
const TRUNCATION_HINT =
  '模型输出被截断：思考过程耗尽了上下文预算（本机 Ollama 的 /v1 上下文固定 4096，无法按请求调大）。' +
  '建议任选其一：① 用 /model 降低思考等级（如 max → low）；' +
  '② 设环境变量 OLLAMA_CONTEXT_LENGTH=16384 后重启 Ollama；③ 缩小输入（如把大图压小）。'

type LoopOptions = {
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  definitions: OpenAI.Chat.Completions.ChatCompletionTool[]
  implementations: ToolImplementations
  client: OpenAI
  model: string
  maxIterations?: number
  signal?: AbortSignal
  /** 思考等级（仅对支持 thinking 的模型有意义），透传给 Ollama */
  think?: 'low' | 'medium' | 'high' | 'max'
}

/**
 * Agent Loop：LLM 决定调工具 → 执行 → 结果回传 → 直到无工具调用。
 *
 * 产出事件流见 `LoopEvent`（tool_start 在工具执行前、tool_end 在执行后，成对出现）。
 */
export async function* runAgentLoop(opts: LoopOptions): AsyncGenerator<LoopEvent> {
  const { messages, definitions, implementations, client, model, maxIterations = 5, signal, think } = opts

  for (let turn = 0; turn < maxIterations; turn++) {
    yield { type: 'status', phase: 'llm_start' }
    // think 不在 OpenAI SDK 的请求类型里，但实测 Ollama /v1 接受该顶层字段
    // （low/medium/high/max 四档单调生效，而 reasoning_effort 被忽略）→
    // 用 as 断言补上类型。上游类型补齐后可移除该断言。
    const params = {
      model,
      messages,
      tools: definitions,
      stream: true,
      temperature: 0.3,
      ...(think ? { think } : {}),
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & { think?: string }

    const response = await client.chat.completions.create(params, { signal })

    // 流式收集 content + reasoning + tool_calls（delta 分段累积）
    // 同时记录 finish_reason 与本轮正文字符数：用于识别"静默失败"（见下方无工具调用分支）
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = []
    let finishReason: string | null = null
    let contentChars = 0
    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
        reasoning?: string
      }
      if (delta?.reasoning) {
        yield { type: 'reasoning', content: delta.reasoning }
      }
      if (delta?.content) {
        contentChars += delta.content.length
        yield { type: 'token', content: delta.content }
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? toolCalls.length
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: tc.id ?? `call_${idx}`, type: 'function', function: { name: '', arguments: '' } }
          }
          if (tc.function?.name) toolCalls[idx].function.name += tc.function.name
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
        }
      }
      const fr = chunk.choices[0]?.finish_reason
      if (fr) finishReason = fr
    }

    // 无工具调用 → 正常情况就是最终回答（已通过 token 事件流出），结束。
    // 但有两种"静默失败"必须显式上报，否则用户只看到"思考着就停了、没有回答"：
    //   ① finish_reason='length'：上下文/输出预算耗尽（长思考 + 图片极易触发）
    //   ② 一个正文字符都没产出
    if (toolCalls.length === 0) {
      if (finishReason === 'length') {
        yield { type: 'error', message: TRUNCATION_HINT }
      } else if (contentChars === 0) {
        yield { type: 'error', message: '模型未产生任何回答（响应异常结束）。可重试，或先用 /model 降低思考等级。' }
      }
      return
    }

    // 有工具调用 → 回传 assistant 消息（含 tool_calls）
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    })

    // 逐个执行工具，结果回传
    for (const tc of toolCalls) {
      const callId = tc.id
      const name = tc.function.name
      let args: unknown = {}
      try {
        args = JSON.parse(tc.function.arguments || '{}')
      } catch {
        args = { _error: '参数解析失败' }
      }

      // ⚠️ 必须在 `await fn(args)` **之前** emit，且**只 emit 一次**。
      // 旧实现在此处与下方各 emit 一次 `tool_start`，第二次不带 name → 上层把状态栏的
      // 工具名清成空（AC-2 的根因）；改由本事件驱动 TUI 的 beginToolLine（AC-3）。
      yield { type: 'tool_start', callId, name, args }

      const startedAt = Date.now()
      const fn = implementations[name]
      let result: ToolResult
      try {
        result = fn ? await fn(args) : { content: JSON.stringify({ error: `未知工具: ${name}` }) }
      } catch (e: any) {
        result = { content: JSON.stringify({ error: `工具执行失败: ${e.message}` }) }
      }

      // ok/行数/字节：优先用 executor 给出的结构化字段（FR-7 落地后），
      // 否则由 classifyToolResult 从 content 兜底判定（既有 12 个 impl 只返回 content）。
      const fallback = classifyToolResult(result.content)
      const ok = result.ok ?? fallback.ok
      const outputLines = result.lines ?? fallback.outputLines
      const outputBytes = result.bytes ?? fallback.outputBytes

      yield {
        type: 'tool_end',
        callId,
        name,
        ok,
        durationMs: Date.now() - startedAt,
        outputLines,
        outputBytes,
        ...(fallback.error === undefined ? {} : { error: fallback.error }),
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        // 实测 Ollama /v1 允许 role:"tool" 消息的 content 携带 image_url（多模态工具结果，
        // view_image 依赖此能力），但 OpenAI SDK 的 ChatCompletionToolMessageParam.content
        // 类型只声明了文本 part → 必须断言。上游类型补齐后可移除该断言。
        content: result.content as OpenAI.Chat.Completions.ChatCompletionToolMessageParam['content'],
      })
    }
  }

  // 用尽 maxIterations 仍未拿到最终回答 —— 同样是静默结束，必须显式上报
  yield {
    type: 'error',
    message: `达到最大迭代轮次（${maxIterations}）仍未得到最终回答。可先用 /model 降低思考等级，或把任务拆小后重试。`,
  }
}
