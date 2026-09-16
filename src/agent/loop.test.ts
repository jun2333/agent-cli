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

const noTools: ToolImplementations = {}

async function collect(client: OpenAI, maxIterations = 5): Promise<LoopEvent[]> {
  const out: LoopEvent[] = []
  for await (const ev of runAgentLoop({
    messages: [{ role: 'user', content: 'hi' }],
    definitions: [],
    implementations: noTools,
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
    // 两轮都真的执行了工具
    expect(events.filter((e) => e.type === 'tool')).toHaveLength(2)
  })
})
