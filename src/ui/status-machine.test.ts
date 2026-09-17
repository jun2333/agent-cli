/**
 * status-machine 单测 —— AC-1 / AC-2 / AC-4 / AC-5 / AC-6 的判定依据。
 *
 * 设计要点：状态机与 Ticker 都是**纯逻辑**（不碰 stdin/stdout，时钟可注入），
 * 因此这里既断言"7×8 迁移表穷举"，也断言"idle 时没有活动定时器"这类可证伪事实。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ASCII_FRAMES,
  BRAILLE_FRAMES,
  STATUS_EVENTS,
  STATUS_KINDS,
  StatusMachine,
  Ticker,
  spinnerFrame,
  type StatusEvent,
  type StatusKind,
} from './status-machine.js'

/** 固定时钟：让 elapsedMs 可确定性断言（不依赖真实时间） */
function machineAt(t = 1000) {
  let now = t
  const m = new StatusMachine(() => now)
  return {
    m,
    setNow: (v: number) => {
      now = v
    },
  }
}

/** 把机器驱动到指定相位：先 reset 回 ready，再用该相位对应的驱动事件 */
const TARGET_EVENT: Record<StatusKind, StatusEvent> = {
  ready: { type: 'reset' },
  thinking: { type: 'llm_start' },
  tool: { type: 'tool_start', name: 'bash' },
  answering: { type: 'answer_start' },
  queued: { type: 'queued', count: 1 },
  interrupted: { type: 'interrupt' },
  error: { type: 'error' },
}

function driveTo(m: StatusMachine, target: StatusKind): void {
  m.transition({ type: 'reset' })
  m.transition(TARGET_EVENT[target])
}

afterEach(() => {
  vi.useRealTimers()
})

describe('StatusMachine：迁移表穷举（AC-1）', () => {
  it('StatusKind 恰 7 个取值、StatusEvent 恰 8 个取值（可穷举集合）', () => {
    expect(new Set(STATUS_KINDS).size).toBe(7)
    expect(new Set(STATUS_EVENTS).size).toBe(8)
  })

  it('7×8 = 56 格全部有定义：任一 (当前相位, 事件) 迁移后都是合法 StatusKind', () => {
    const reached = new Set<StatusKind>()
    let cells = 0
    for (const from of STATUS_KINDS) {
      for (const ev of STATUS_EVENTS) {
        const { m } = machineAt()
        driveTo(m, from)
        expect(m.kind).toBe(from)
        m.transition({ type: ev } as StatusEvent)
        expect(STATUS_KINDS).toContain(m.kind)
        reached.add(m.kind)
        cells++
      }
    }
    expect(cells).toBe(56)
    // 穷举遍历后 7 个取值全部出现过（AC-1 的"全部取值可被覆盖"）
    expect([...reached].sort()).toEqual([...STATUS_KINDS].sort())
  })

  it('AC-6 关键格：tool + tool_end → thinking（而非 ready）', () => {
    const { m } = machineAt()
    m.transition({ type: 'tool_start', name: 'bash' })
    expect(m.kind).toBe('tool')
    m.transition({ type: 'tool_end' })
    expect(m.kind).toBe('thinking')
  })

  it('AC-6：连续两次工具调用之间从不回落 ready', () => {
    const { m } = machineAt()
    m.transition({ type: 'llm_start' })
    const seen: StatusKind[] = []
    for (let i = 0; i < 2; i++) {
      m.transition({ type: 'tool_start', name: `tool${i}` })
      seen.push(m.kind)
      m.transition({ type: 'tool_end' })
      seen.push(m.kind)
    }
    expect(seen).not.toContain('ready')
    expect(seen).toEqual(['tool', 'thinking', 'tool', 'thinking'])
    // 只有 reset（一轮彻底结束）才回落 ready
    m.transition({ type: 'reset' })
    expect(m.kind).toBe('ready')
  })
})

describe('StatusMachine：工具名（AC-2）', () => {
  it('tool_start 后 toolName 与状态栏文本都含工具名', () => {
    const { m } = machineAt(0)
    m.transition({ type: 'tool_start', name: 'bash' })
    expect(m.toolName).toBe('bash')
    expect(m.render(0).text).toContain('Running bash')
  })

  it('toolName 在 tool_end 后保留（不因相位切到 thinking 被清空），reset 后清空', () => {
    const { m } = machineAt(0)
    m.transition({ type: 'tool_start', name: 'grep' })
    m.transition({ type: 'tool_end' })
    expect(m.toolName).toBe('grep')
    m.transition({ type: 'reset' })
    expect(m.toolName).toBeNull()
  })

  it('连续两次 tool_start（不同工具）名字被后者覆盖，不会残留旧名', () => {
    const { m } = machineAt(0)
    m.transition({ type: 'tool_start', name: 'bash' })
    m.transition({ type: 'tool_end' })
    m.transition({ type: 'tool_start', name: 'read' })
    expect(m.toolName).toBe('read')
    expect(m.render(0).text).toContain('Running read')
    expect(m.render(0).text).not.toContain('bash')
  })
})

describe('StatusMachine：动画与计时（AC-4 / AC-5）', () => {
  it('AC-4：animating 仅在 running 相位（thinking/tool/answering）为 true', () => {
    const { m } = machineAt(0)
    const animatingOf = (k: StatusKind) => {
      driveTo(m, k)
      return { kind: m.kind, animating: m.render(0).animating }
    }
    for (const k of ['thinking', 'tool', 'answering'] as StatusKind[]) {
      expect(animatingOf(k)).toEqual({ kind: k, animating: true })
    }
    for (const k of ['ready', 'queued', 'interrupted', 'error'] as StatusKind[]) {
      expect(animatingOf(k)).toEqual({ kind: k, animating: false })
    }
  })

  it('AC-5：elapsedMs 随真实时间单调递增；reset 后停止计时（null）', () => {
    const { m } = machineAt(1000)
    m.transition({ type: 'llm_start' })
    expect(m.render(1000).elapsedMs).toBe(0)
    const t1 = m.render(2500).elapsedMs
    const t2 = m.render(9000).elapsedMs
    expect(t1).toBe(1500)
    expect(t2).toBe(8000)
    expect(t2!).toBeGreaterThan(t1!)
    m.transition({ type: 'reset' })
    expect(m.render(9000).elapsedMs).toBeNull()
    expect(m.render(20000).elapsedMs).toBeNull() // 已停止计时，不随时间增长
  })

  it('elapsedMs 在相位切换时从 0 重新计（tool_start 开启新相位）', () => {
    const { m, setNow } = machineAt(0)
    m.transition({ type: 'llm_start' })
    expect(m.render(5000).elapsedMs).toBe(5000)
    setNow(5000) // 相位起点 = 切换时刻
    m.transition({ type: 'tool_start', name: 'bash' })
    expect(m.render(5000).elapsedMs).toBe(0)
    expect(m.render(5500).elapsedMs).toBe(500)
  })

  it('AC-4：spinnerFrame 每 ~100ms 换帧、10 帧循环，ASCII 兜底另有一套帧', () => {
    expect(BRAILLE_FRAMES).toHaveLength(10)
    expect(spinnerFrame(0, false)).toBe(BRAILLE_FRAMES[0])
    expect(spinnerFrame(100, false)).toBe(BRAILLE_FRAMES[1])
    expect(spinnerFrame(100, false)).not.toBe(spinnerFrame(0, false))
    expect(spinnerFrame(1000, false)).toBe(BRAILLE_FRAMES[0]) // 10 帧循环
    expect(ASCII_FRAMES).toHaveLength(4)
    expect(spinnerFrame(0, true)).toBe(ASCII_FRAMES[0])
    expect(spinnerFrame(100, true)).not.toBe(spinnerFrame(0, true))
    expect(BRAILLE_FRAMES).not.toContain(spinnerFrame(100, true)) // ascii=true 时不用 Braille
  })

  it('状态栏文本含 spinner 帧与已用时长（D14 格式）', () => {
    const { m } = machineAt(0)
    m.transition({ type: 'tool_start', name: 'bash' })
    const text = m.render(3200).text
    expect(text.startsWith(spinnerFrame(3200, false))).toBe(true)
    expect(text).toContain('(3s)')
  })
})

describe('Ticker：唯一定时器（AC-4）', () => {
  it('幂等启停 + isActive 可断言；idle 停止后不再触发', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = new Ticker(fn, 100)
    expect(t.isActive).toBe(false)

    t.start()
    t.start() // 幂等：第二次 no-op（否则会有两个 interval）
    expect(t.isActive).toBe(true)
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(200)
    expect(fn).toHaveBeenCalledTimes(3)

    t.stop()
    t.stop() // 幂等
    expect(t.isActive).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(3) // 已停，不再空转
  })
})

describe('StatusMachine：静态兼容入口（Decision 9 facade 语义）', () => {
  it('setStatic 写入静态状态：不带动画、不计时，文本含 detail', () => {
    const { m } = machineAt(0)
    m.setStatic('queued', '(2 left)')
    const v = m.render(9999)
    expect(v.kind).toBe('queued')
    expect(v.text).toBe('Queued (2 left)')
    expect(v.elapsedMs).toBeNull()
    expect(v.animating).toBe(false)
  })

  it('静态状态可被后续 transition 取代，且迁移从该状态出发', () => {
    const { m } = machineAt(0)
    m.setStatic('ready')
    m.transition({ type: 'llm_start' })
    expect(m.kind).toBe('thinking')
    expect(m.render(0).animating).toBe(true)
  })

  it('机器驱动的 queued 相位文本含剩余条数', () => {
    const { m } = machineAt(0)
    m.transition({ type: 'queued', count: 3 })
    expect(m.render(0).text).toBe('Queued (3 left)')
    expect(m.render(0).elapsedMs).toBeNull()
  })
})
