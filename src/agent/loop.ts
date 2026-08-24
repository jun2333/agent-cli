import type OpenAI from 'openai'
import type { ToolImplementations } from '../tools/index.js'

export type LoopEvent =
  | { type: 'status'; phase: 'llm_start' | 'tool_start' | 'tool_end'; name?: string }
  | { type: 'reasoning'; content: string }
  | { type: 'token'; content: string }
  | { type: 'tool'; name: string; args: unknown }

type LoopOptions = {
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  definitions: OpenAI.Chat.Completions.ChatCompletionTool[]
  implementations: ToolImplementations
  client: OpenAI
  model: string
  maxIterations?: number
  signal?: AbortSignal
}

/**
 * Agent Loop：LLM 决定调工具 → 执行 → 结果回传 → 直到无工具调用。
 *
 * 产出事件流：
 * - token：模型生成的流式文本（工具决策轮与最终回答轮都会产出）
 * - tool：每次工具执行完成后产出
 */
export async function* runAgentLoop(opts: LoopOptions): AsyncGenerator<LoopEvent> {
  const { messages, definitions, implementations, client, model, maxIterations = 5, signal } = opts

  for (let turn = 0; turn < maxIterations; turn++) {
    yield { type: 'status', phase: 'llm_start' }
    const response = await client.chat.completions.create(
      {
        model,
        messages,
        tools: definitions,
        stream: true,
        temperature: 0.3,
      },
      { signal },
    )

    // 流式收集 content + reasoning + tool_calls（delta 分段累积）
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = []
    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
        reasoning?: string
      }
      if (delta?.reasoning) {
        yield { type: 'reasoning', content: delta.reasoning }
      }
      if (delta?.content) {
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
    }

    // 无工具调用 → 最终回答已通过 token 事件流出，结束
    if (toolCalls.length === 0) return

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
      yield { type: 'status', phase: 'tool_start', name: tc.function.name }
      const fn = implementations[tc.function.name]
      let result: { content: string }
      let args: unknown = {}

      if (fn) {
        try {
          args = JSON.parse(tc.function.arguments || '{}')
        } catch {
          args = { _error: '参数解析失败' }
        }
        try {
          result = await fn(args)
        } catch (e: any) {
          result = { content: JSON.stringify({ error: `工具执行失败: ${e.message}` }) }
        }
      } else {
        result = { content: JSON.stringify({ error: `未知工具: ${tc.function.name}` }) }
      }

      yield { type: 'status', phase: 'tool_end' }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result.content })
      yield { type: 'tool', name: tc.function.name, args }
    }
  }
}
