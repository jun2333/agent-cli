/**
 * interaction.test.ts — 交互原语分派中枢（FR-5 / AC-27~29 + V-1）
 *
 * 单测覆盖 V-1 裁决后的**四种降级矩阵**（每种至少一条断言）：
 * 1. 正常交互 → 打开内联浮层（唯一分派路径）；
 * 2. 非交互 → 自动拒绝 + `unavailable/non-interactive` + `deniedCount`（AC-28）；
 * 3. `--yes` 且**非 forced** → 自动接受（confirm/select/input 三形态取值，AC-29）；
 * 4. `--yes` 且 **forced** → 拒绝 + 提示需显式 `bypass`（V-1，`--yes` ≠ `bypass`）。
 *
 * `openInteractionOverlay` 的调用点只有 `interaction.ts` 一处（见「单一分派」用例）——
 * 这是 AC-27「UI 层与 LLM 层走同一实现分派路径」的结构性证据。
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  InteractionBroker,
  type InteractionHost,
  type InteractionSpec,
  type OverlayResult,
} from './interaction.js'
import { createToolExecutor } from './tools/executor.js'
import { TOOL_SPECS } from './tools/registry.js'

type Recorded = {
  specs: InteractionSpec[]
  infos: string[]
  cancels: number
  resolve?: (r: OverlayResult) => void
}

/** 记录型假 host（AC-27 的 spy）；不传 autoResolve 时保持挂起，供 cancelAll 用例 */
function makeHost(autoResolve?: OverlayResult) {
  const rec: Recorded = { specs: [], infos: [], cancels: 0 }
  const host: InteractionHost = {
    openInteractionOverlay(spec) {
      rec.specs.push(spec)
      if (autoResolve) return Promise.resolve(autoResolve)
      return new Promise<OverlayResult>((resolve) => {
        rec.resolve = resolve
      })
    },
    cancelInteractionOverlay() {
      rec.cancels++
    },
    addInfo(text) {
      rec.infos.push(text)
    },
  }
  return { host, rec }
}

const interactive = { interactive: true, autoAccept: false }
const nonInteractive = { interactive: false, autoAccept: false }
const yes = { interactive: false, autoAccept: true }

describe('交互分派：AC-27 单一分派路径', () => {
  it('三种形态都经由唯一入口 broker.request → host.openInteractionOverlay（无第二套交互代码）', async () => {
    for (const spec of [
      { kind: 'confirm' as const, title: '确认' },
      { kind: 'select' as const, title: '选', items: [{ label: 'a' }] },
      { kind: 'input' as const, title: '输入' },
    ]) {
      const { host, rec } = makeHost({ kind: 'cancelled' })
      const broker = new InteractionBroker(host, interactive)
      await broker.request(spec)
      expect(rec.specs).toEqual([spec]) // 原样分派，没有重写/翻译
    }
  })

  it('LLM 层：`ask_user` 的实现命中同一个 broker.request（AC-30 的底层）', async () => {
    const { host, rec } = makeHost({ kind: 'select', index: 1, label: 'B' })
    const broker = new InteractionBroker(host, interactive)
    const exec = createToolExecutor({ currentModel: 'm', interaction: broker }, TOOL_SPECS)

    const r = await exec.implementations.ask_user({ question: '选哪个？', options: ['A', 'B'] })

    expect(rec.specs).toEqual([
      { kind: 'select', title: '选哪个？', items: [{ label: 'A' }, { label: 'B' }], allowManualInput: false },
    ])
    expect(JSON.parse(r.content as string)).toEqual({ answered: true, index: 1, choice: 'B' })
  })

  it('LLM 层：无选项 → input 形态；allow_manual_input 透传', async () => {
    const { host, rec } = makeHost({ kind: 'input', value: '自由回答' })
    const broker = new InteractionBroker(host, interactive)
    const exec = createToolExecutor({ currentModel: 'm', interaction: broker }, TOOL_SPECS)

    const r = await exec.implementations.ask_user({ question: '你想说什么？' })
    expect(rec.specs).toEqual([{ kind: 'input', title: '你想说什么？' }])
    expect(JSON.parse(r.content as string)).toEqual({ answered: true, answer: '自由回答' })

    const { host: h2, rec: r2 } = makeHost({ kind: 'cancelled' })
    const exec2 = createToolExecutor({ currentModel: 'm', interaction: new InteractionBroker(h2, interactive) }, TOOL_SPECS)
    await exec2.implementations.ask_user({ question: 'q', options: ['x'], allow_manual_input: true })
    expect(r2.specs[0]).toMatchObject({ kind: 'select', allowManualInput: true })
  })

  it('`src/` 内 `openInteractionOverlay` 的**调用点唯一**（结构性锁：禁止第二套交互路径）', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name)
        if (e.isDirectory()) {
          walk(abs)
        } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
          const src = readFileSync(abs, 'utf8')
          if (/\.openInteractionOverlay\(/.test(src)) hits.push(e.name)
        }
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(hits).toEqual(['interaction.ts'])
  })
})

describe('交互分派：AC-28 非交互自动拒绝（降级分支 ②）', () => {
  it('无 TUI / 非 TTY → unavailable + non-interactive + deniedCount++ + stderr 提示（不挂起）', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const broker = new InteractionBroker(null, nonInteractive)
      const r = await broker.request({ kind: 'confirm', title: '要执行吗' })

      expect(r).toMatchObject({ kind: 'unavailable', reason: 'non-interactive' })
      expect(r.kind === 'unavailable' && r.message).toContain('需交互但当前非交互')
      expect(broker.deniedCount).toBe(1) // AC-28 的进程退出码依据
      // 结构化结果必须能回给 LLM（ask_user）——见 askUserPayload
      expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('需交互但当前非交互')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('非交互但注入 host（TTY=false 的兜底）→ 同样拒绝，且 host 的浮层通道不被打开', async () => {
    const { host, rec } = makeHost({ kind: 'confirm', value: true })
    const broker = new InteractionBroker(host, nonInteractive)
    const r = await broker.request({ kind: 'confirm', title: 'x' })
    expect(r.kind).toBe('unavailable')
    expect(rec.specs).toEqual([]) // 关键：非交互下不得弹浮层
    expect(rec.infos.join('')).toContain('需交互但当前非交互')
    expect(broker.deniedCount).toBe(1)
  })

  it('LLM 层：非交互下 ask_user 返回结构化拒绝（answered=false + error），deniedCount++', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const broker = new InteractionBroker(null, nonInteractive)
      const exec = createToolExecutor({ currentModel: 'm', interaction: broker }, TOOL_SPECS)
      const r = await exec.implementations.ask_user({ question: '选哪个？', options: ['A', 'B'] })
      const payload = JSON.parse(r.content as string)
      expect(payload).toMatchObject({ answered: false, reason: 'non-interactive' })
      expect(payload.error).toContain('需交互但当前非交互')
      expect(broker.deniedCount).toBe(1)
    } finally {
      errSpy.mockRestore()
    }
  })

  it('compat 路径（未注入 broker）→ ask_user 明确报错，不静默成功', async () => {
    const exec = createToolExecutor({ currentModel: 'm' }, TOOL_SPECS)
    const r = await exec.implementations.ask_user({ question: 'q' })
    expect(JSON.parse(r.content as string).error).toContain('没有可用的交互通道')
  })
})

describe('交互分派：AC-29 --yes 自动接受非 forced（降级分支 ③）', () => {
  it('confirm → defaultYes（缺省 true）；不产生交互等待（host 不被调用）', async () => {
    const { host, rec } = makeHost()
    const broker = new InteractionBroker(host, yes)
    expect(await broker.request({ kind: 'confirm', title: 'x' })).toEqual({ kind: 'confirm', value: true })
    expect(await broker.request({ kind: 'confirm', title: 'x', defaultYes: false })).toEqual({
      kind: 'confirm',
      value: false,
    })
    expect(rec.specs).toEqual([]) // 无交互等待、无浮层
    expect(broker.deniedCount).toBe(0)
    expect(broker.isWaiting).toBe(false)
  })

  it('select → 第 0 项；input → placeholder ?? 空串', async () => {
    const broker = new InteractionBroker(makeHost().host, yes)
    expect(await broker.request({ kind: 'select', title: 'x', items: [{ label: 'first' }, { label: 'second' }] })).toEqual({
      kind: 'select',
      index: 0,
      label: 'first',
    })
    expect(await broker.request({ kind: 'input', title: 'x', placeholder: '默认' })).toEqual({
      kind: 'input',
      value: '默认',
    })
    expect(await broker.request({ kind: 'input', title: 'x' })).toEqual({ kind: 'input', value: '' })
  })

  it('交互模式下也会走 --yes（--yes 是"交互替代策略"，与非交互无关）', async () => {
    const { host, rec } = makeHost()
    const broker = new InteractionBroker(host, { interactive: true, autoAccept: true })
    expect(await broker.request({ kind: 'confirm', title: 'x' })).toEqual({ kind: 'confirm', value: true })
    expect(rec.specs).toEqual([])
  })

  it('LLM 层：--yes 下 ask_user 自动回答，deniedCount 保持 0', async () => {
    const broker = new InteractionBroker(makeHost().host, yes)
    const exec = createToolExecutor({ currentModel: 'm', interaction: broker }, TOOL_SPECS)
    const r = await exec.implementations.ask_user({ question: '选哪个？', options: ['A', 'B'] })
    expect(JSON.parse(r.content as string)).toEqual({ answered: true, index: 0, choice: 'A' })
    expect(broker.deniedCount).toBe(0)
  })
})

describe('交互分派：V-1 forced 拒绝（降级分支 ④，--yes ≠ bypass）', () => {
  it('--yes + forced → 拒绝（unavailable/forced）+ 提示需显式 bypass + host 不被调用', async () => {
    const { host, rec } = makeHost()
    const broker = new InteractionBroker(host, yes)
    const r = await broker.request({ kind: 'confirm', title: '执行 sudo rm -rf / ？', forced: true })

    expect(r).toMatchObject({ kind: 'unavailable', reason: 'forced' })
    expect(r.kind === 'unavailable' && r.message).toContain('bypass')
    expect(rec.specs).toEqual([]) // 不弹浮层（forced 来自权限判定，不经交互）
    expect(broker.deniedCount).toBe(1)
    // 再跑一次确认计数单调
    await broker.request({ kind: 'confirm', title: 'x', forced: true })
    expect(broker.deniedCount).toBe(2)
  })

  it('非 forced 的请求在同一个 broker 上仍被自动接受（forced 是逐请求判定）', async () => {
    const broker = new InteractionBroker(makeHost().host, yes)
    expect(await broker.request({ kind: 'confirm', title: 'x', forced: true })).toMatchObject({
      kind: 'unavailable',
      reason: 'forced',
    })
    expect(await broker.request({ kind: 'confirm', title: 'y' })).toEqual({ kind: 'confirm', value: true })
    expect(broker.deniedCount).toBe(1)
  })

  it('正常交互模式下 forced 请求仍弹浮层（用户可显式批准；AC-36 的交互侧）', async () => {
    const { host, rec } = makeHost({ kind: 'confirm', value: false })
    const broker = new InteractionBroker(host, interactive)
    const r = await broker.request({ kind: 'confirm', title: '危险命令', forced: true })
    expect(r).toEqual({ kind: 'confirm', value: false })
    expect(rec.specs).toHaveLength(1) // forced 只影响 --yes 分支
    expect(broker.deniedCount).toBe(0)
  })
})

describe('交互分派：cancelAll 释放挂起请求', () => {
  it('cancelAll → host 的浮层被取消、挂起的 Promise 按 cancelled 结算', async () => {
    const { host, rec } = makeHost() // 不 autoResolve → 保持挂起
    const broker = new InteractionBroker(host, interactive)
    const pending = broker.request({ kind: 'input', title: '输入' })

    expect(broker.isWaiting).toBe(true)
    broker.cancelAll()

    await expect(pending).resolves.toEqual({ kind: 'cancelled' })
    expect(rec.cancels).toBe(1)
    expect(broker.isWaiting).toBe(false)
  })

  it('无挂起请求时 cancelAll 是 no-op（幂等）', () => {
    const { host } = makeHost()
    const broker = new InteractionBroker(host, interactive)
    expect(() => {
      broker.cancelAll()
      broker.cancelAll()
    }).not.toThrow()
  })
})
