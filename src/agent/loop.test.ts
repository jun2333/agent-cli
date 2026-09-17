/**
 * loop 单测 —— 重点覆盖"静默失败"的上报（真实用户反馈的 bug）。
 *
 * 背景：本机 Ollama /v1 上下文固定 4096 且无法按请求调大，图片 + think=max 极易耗尽预算，
 * 模型会以 finish_reason='length' 结束、既无 content 也无 tool_calls。旧实现此时直接 return，
 * 用户只看到"思考着就停了、没有回答"。以下用例锁住修复。
 */
import { describe, it, expect } from 'vitest'
import type OpenAI from 'openai'
import { runAgentLoop, type LoopEvent } from './loop.js'
import type { ToolImplementations } from '../tools/index.js'

type Chunk = { choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }> }

/** 用给定的 chunk 序列伪造一个流式 client */
function fakeClient(chunks: Chunk[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async () =>
          (async function* () {
            for (const c of chunks) yield c
          })(),
      },
    },
  } as unknown as OpenAI
}

/**
 * 逐次请求返回不同 chunk 序列的假 client（每个 create 消费一个序列，用尽后复用最后一个）。
 * 用于"第一轮决定调工具、第二轮产出最终回答"这类需要区分请求的用例。
 */
function fakeClientSeq(streams: Chunk[][]): OpenAI {
  let call = 0
  return {
    chat: {
      completions: {
        create: async () => {
          const chunks = streams[Math.min(call, streams.length - 1)]
          call++
          return (async function* () {
            for (const c of chunks) yield c
          })()
        },
      },
    },
  } as unknown as OpenAI
}

/** 一轮"决定调用某个工具"的 chunk */
function toolCallChunk(name: string, args = '{}', id = 'call_1'): Chunk {
  return {
    choices: [
      {
        delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] },
        finish_reason: null,
      },
    ],
  }
}

/** 一轮"产出最终回答并结束"的 chunk */
const finalAnswerChunk: Chunk = { choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] }

const noTools: ToolImplementations = {}

async function collect(
  client: OpenAI,
  maxIterations = 5,
  implementations: ToolImplementations = noTools,
): Promise<LoopEvent[]> {
  const out: LoopEvent[] = []
  for await (const ev of runAgentLoop({
    messages: [{ role: 'user', content: 'hi' }],
    definitions: [],
    implementations,
    client,
    model: 'fake-model',
    maxIterations,
  })) {
    out.push(ev)
  }
  return out
}

describe('loop：正常路径', () => {
  it('有 content 且 finish_reason=stop → 不产生 error 事件', async () => {
    const events = await collect(
      fakeClient([
        { choices: [{ delta: { content: '答案' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    )
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.filter((e) => e.type === 'token').map((e) => (e as any).content).join('')).toBe('答案')
  })
})

describe('loop：静默失败必须上报（真实用户反馈）', () => {
  it('finish_reason=length 且无 content / 无 tool_calls → 上报"输出被截断"', async () => {
    const events = await collect(
      fakeClient([
        // 只有 reasoning（长思考），然后以 length 结束
        { choices: [{ delta: { reasoning: '思考中…' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ]),
    )
    const err = events.find((e) => e.type === 'error') as { type: 'error'; message: string } | undefined
    expect(err).toBeDefined()
    expect(err!.message).toContain('被截断')
    // 提示必须给出可操作的出路
    expect(err!.message).toContain('/model')
    expect(err!.message).toContain('OLLAMA_CONTEXT_LENGTH')
  })

  it('finish_reason=length 且有 content → 既有 token 也有"被截断"error（部分内容已流出也须说明为何停止）', async () => {
    // 当前实现的判定顺序是「先看 length，再看 contentChars === 0」，因此 length 且有
    // content 时会**同时**产出 token 与 error。判定为合理：用户已看到半截回答，若不提示
    // 会把截断当成完整回答（正是本次修复要消灭的"静默失败"）；提示只补充"为何停止 + 出路"。
    const events = await collect(
      fakeClient([
        { choices: [{ delta: { content: '部分回答' }, finish_reason: null }] },
        { choices: [{ delta: { content: '，后文被截断' }, finish_reason: 'length' }] },
      ]),
    )
    // 已产出的正文必须原样流出，不能被错误吞掉
    const tokens = events.filter((e) => e.type === 'token').map((e) => (e as { content: string }).content)
    expect(tokens.join('')).toBe('部分回答，后文被截断')
    // 同时必须恰好上报一条截断提示，且给出可操作出路
    const errs = events.filter((e) => e.type === 'error') as Array<{ type: 'error'; message: string }>
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toContain('被截断')
    expect(errs[0].message).toContain('/model')
    // 有 content 时不得误报"未产生任何回答"
    expect(errs[0].message).not.toContain('未产生任何回答')
    // 顺序：token 先于 error（先让用户看到内容，再给提示）
    expect(events.findIndex((e) => e.type === 'error')).toBeGreaterThan(events.findIndex((e) => e.type === 'token'))
  })

  it('finish_reason=stop 但一个正文字符都没产出 → 上报"未产生任何回答"', async () => {
    const events = await collect(
      fakeClient([
        { choices: [{ delta: { reasoning: '想了一下' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    )
    const err = events.find((e) => e.type === 'error') as { type: 'error'; message: string } | undefined
    expect(err).toBeDefined()
    expect(err!.message).toContain('未产生任何回答')
  })

  it('用尽 maxIterations 仍在调工具 → 上报"达到最大迭代轮次"', async () => {
    const toolCallChunk: Chunk = {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
          },
          finish_reason: null,
        },
      ],
    }
    const events = await collect(fakeClient([toolCallChunk]), 2)
    const err = events.find((e) => e.type === 'error') as { type: 'error'; message: string } | undefined
    expect(err).toBeDefined()
    expect(err!.message).toContain('最大迭代轮次')
    // 两轮都真的执行了工具（B1：事件由 `tool` 拆为成对的 tool_start/tool_end）
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(2)
  })
})

/**
 * B1 的核心修复：事件契约（`src/agent/loop.ts` 的三处时序缺陷）。
 *
 * 旧实现的三处缺陷：
 *   ① `tool_start` emit 两次（第二次不带 name）→ 上层把工具名清空（AC-2 的反例）
 *   ② `tool_end` 根本不存在 → "Running tool" 残留到下一次 llm_start
 *   ③ 工具行由 `tool` 事件驱动，而它在 `await fn(args)` **之后**才 emit → 工具行滞后（AC-3/AC-64）
 */
describe('loop：事件契约与工具行时序（B1 修复回归）', () => {
  it('AC-2：一次工具调用只 emit 一次 tool_start，且必带 callId/name/args', async () => {
    const seen: string[] = []
    const events = await collect(
      fakeClientSeq([[toolCallChunk('bash', '{"command":"ls"}')], [finalAnswerChunk]]),
      5,
      {
        bash: async () => {
          seen.push('impl')
          return { content: JSON.stringify({ exitCode: 0, stdout: 'a\nb' }) }
        },
      },
    )
    const starts = events.filter((e) => e.type === 'tool_start') as Array<
      Extract<LoopEvent, { type: 'tool_start' }>
    >
    expect(starts).toHaveLength(1) // 唯一 emit（旧实现是 2 次，第二次 name 为空）
    expect(starts[0].callId).toBe('call_1')
    expect(starts[0].name).toBe('bash') // 工具名绝不为空
    expect(starts[0].args).toEqual({ command: 'ls' })
    expect(seen).toEqual(['impl'])
  })

  it('AC-3：tool_start 在 await 工具之前 emit；tool_end 在执行完成之后', async () => {
    const events: LoopEvent[] = []
    let sawStartAtEntry = false
    let sawEndAtEntry = false
    const implementations: ToolImplementations = {
      probe: async () => {
        // 工具实现入口：tool_start 必须**已经**被消费者收到；tool_end 必须**还没**产生
        sawStartAtEntry = events.some((e) => e.type === 'tool_start' && e.name === 'probe')
        sawEndAtEntry = events.some((e) => e.type === 'tool_end')
        return { content: JSON.stringify({ ok: true }) }
      },
    }
    for await (const ev of runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }],
      definitions: [],
      implementations,
      client: fakeClientSeq([[toolCallChunk('probe')], [finalAnswerChunk]]),
      model: 'fake-model',
      maxIterations: 5,
    })) {
      events.push(ev)
    }

    expect(sawStartAtEntry).toBe(true) // 执行前已 emit（否则工具行只能在执行后出现）
    expect(sawEndAtEntry).toBe(false) // 执行前不得有完成事件
    const startIdx = events.findIndex((e) => e.type === 'tool_start')
    const endIdx = events.findIndex((e) => e.type === 'tool_end')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(endIdx).toBeGreaterThan(startIdx)
    // tool_start/tool_end 成对且 callId 一致
    const start = events[startIdx] as Extract<LoopEvent, { type: 'tool_start' }>
    const end = events[endIdx] as Extract<LoopEvent, { type: 'tool_end' }>
    expect(end.callId).toBe(start.callId)
    expect(end.name).toBe(start.name)
  })

  it('tool_end 携带耗时/输出行数/字节，且 ok 由 content 兜底判定（含 error 字段 → 失败）', async () => {
    const events = await collect(
      fakeClientSeq([[toolCallChunk('read')], [finalAnswerChunk]]),
      5,
      { read: async () => ({ content: JSON.stringify({ error: '读取失败: ENOENT' }) }) },
    )
    const end = events.find((e) => e.type === 'tool_end') as Extract<LoopEvent, { type: 'tool_end' }>
    expect(end.ok).toBe(false)
    expect(end.error).toContain('读取失败')
    expect(end.durationMs).toBeGreaterThanOrEqual(0)
    expect(end.outputLines).toBe(1)
    expect(end.outputBytes).toBe(Buffer.byteLength(JSON.stringify({ error: '读取失败: ENOENT' }), 'utf8'))
  })

  it('tool_end 的 ok 判定能识别 bash 的失败形状（exitCode≠0，无 error 字段）', async () => {
    const events = await collect(
      fakeClientSeq([[toolCallChunk('bash')], [finalAnswerChunk]]),
      5,
      { bash: async () => ({ content: JSON.stringify({ exitCode: 127, stdout: '', stderr: 'not found' }) }) },
    )
    const end = events.find((e) => e.type === 'tool_end') as Extract<LoopEvent, { type: 'tool_end' }>
    expect(end.ok).toBe(false)
    expect(end.error).toContain('not found')
  })

  it('结构化字段优先于 content 兜底（executor 落地后由它给出 ok/lines/bytes）', async () => {
    const events = await collect(
      fakeClientSeq([[toolCallChunk('t')], [finalAnswerChunk]]),
      5,
      {
        // content 看起来是失败，但实现方给了结构化 ok:true → 以结构化字段为准
        t: async () => ({ content: JSON.stringify({ error: '脏数据' }), ok: true, lines: 7, bytes: 70 }),
      },
    )
    const end = events.find((e) => e.type === 'tool_end') as Extract<LoopEvent, { type: 'tool_end' }>
    expect(end.ok).toBe(true)
    expect(end.outputLines).toBe(7)
    expect(end.outputBytes).toBe(70)
  })

  it('未知工具：仍 emit tool_start/tool_end 并由 ok=false 暴露（不静默）', async () => {
    const events = await collect(fakeClientSeq([[toolCallChunk('nope')], [finalAnswerChunk]]))
    const start = events.find((e) => e.type === 'tool_start') as Extract<LoopEvent, { type: 'tool_start' }>
    const end = events.find((e) => e.type === 'tool_end') as Extract<LoopEvent, { type: 'tool_end' }>
    expect(start.name).toBe('nope')
    expect(end.ok).toBe(false)
    expect(end.error).toContain('未知工具')
  })
})
