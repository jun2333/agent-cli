/**
 * status-machine.ts — 状态栏的显式状态机 + 唯一定时器（FR-1）
 *
 * 为什么独立成模块（design.md Decision 1 / Option B）：
 * - 本项目此前把状态散落在 `index.ts` 的 6 处 `ui.setStatus(...)` 调用里，没有单一状态源；
 *   AC-1/AC-5/AC-6 都要求"单测穷举迁移表"，逻辑必须离开 `index.ts` 的模块级 main() 闭包。
 * - 全项目此前**零定时器**。FR-1 引入的 tick 必须是唯一的，且 idle 时停止（AC-4）——
 *   把 `setInterval` 封装进 `Ticker` 才能让"idle 无活动定时器"成为可断言事实而非口头约定。
 *
 * 分层：本模块**不碰** stdin/stdout，时钟可注入（`clock` 参数）→ vitest 直测、行为确定。
 * 动画帧与已用时长都由 `elapsedMs` 派生（无内部帧计数器）→ 同一 now 必得同一渲染结果。
 */

/** 状态栏相位（保持既有 7 个取值，AC-1 的可穷举集合） */
export type StatusKind = 'ready' | 'thinking' | 'tool' | 'answering' | 'queued' | 'interrupted' | 'error'

/** 驱动迁移的唯一事件集合（8 个取值，AC-1） */
export type StatusEvent =
  | { type: 'llm_start' }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end' }
  | { type: 'answer_start' } // 首个 token
  | { type: 'queued'; count: number }
  | { type: 'interrupt' }
  | { type: 'error' }
  | { type: 'reset' } // 回到 ready（一轮彻底结束）

/** 状态栏渲染数据：TUI 只消费它，不自己推导文案 */
export type StatusView = {
  kind: StatusKind
  /** 状态栏主文本（`Running bash` / `⠹ Thinking… (3s)` / `Queued (2 left)`） */
  text: string
  /** 已用时长（ms）；非 running 相位为 null（AC-5） */
  elapsedMs: number | null
  /** 是否需要动画（决定 Ticker 启停，AC-4） */
  animating: boolean
}

/** 用于穷举测试的取值清单（AC-1） */
export const STATUS_KINDS: readonly StatusKind[] = [
  'ready',
  'thinking',
  'tool',
  'answering',
  'queued',
  'interrupted',
  'error',
]

export const STATUS_EVENTS: ReadonlyArray<StatusEvent['type']> = [
  'llm_start',
  'tool_start',
  'tool_end',
  'answer_start',
  'queued',
  'interrupt',
  'error',
  'reset',
]

/** 静态相位的状态栏文案（动态相位在此基础上加 spinner 与时长） */
const BASE_TEXT: Record<StatusKind, string> = {
  ready: 'Ready',
  thinking: 'Thinking…',
  tool: 'Running tool',
  answering: 'Answering…',
  queued: 'Queued',
  interrupted: 'Interrupted',
  error: 'Error',
}

/**
 * 7×8 迁移表（AC-1 的"可穷举覆盖"依据，单测逐格断言）。
 *
 * ⚠️ AC-6 的关键格是 `tool + tool_end → thinking`（**不是** ready）：
 * 同一轮里工具执行完必然还要回到 LLM 决策；只有 `reset`（一轮真正结束）才回落 ready。
 * 这一格直接消灭"连续两次工具调用之间状态回落 Ready"的体感。
 *
 * 其余几格的取舍：
 * - `tool_end` 落在 answering/queued/interrupted/error 时保持原位（不回退，避免状态倒退）
 * - `queued` 是静态相位（不计时）：它只在下一条消息开跑前短暂出现
 */
const TRANSITIONS: Record<StatusKind, Record<StatusEvent['type'], StatusKind>> = {
  ready: {
    llm_start: 'thinking', tool_start: 'tool', tool_end: 'tool', answer_start: 'answering',
    queued: 'queued', interrupt: 'interrupted', error: 'error', reset: 'ready',
  },
  thinking: {
    llm_start: 'thinking', tool_start: 'tool', tool_end: 'tool', answer_start: 'answering',
    queued: 'queued', interrupt: 'interrupted', error: 'error', reset: 'ready',
  },
  tool: {
    llm_start: 'thinking', tool_start: 'tool', tool_end: 'thinking', answer_start: 'answering',
    queued: 'queued', interrupt: 'interrupted', error: 'error', reset: 'ready',
  },
  answering: {
    llm_start: 'thinking', tool_start: 'tool', tool_end: 'answering', answer_start: 'answering',
    queued: 'queued', interrupt: 'interrupted', error: 'error', reset: 'ready',
  },
  queued: {
    llm_start: 'thinking', tool_start: 'tool', tool_end: 'queued', answer_start: 'answering',
    queued: 'queued', interrupt: 'interrupted', error: 'error', reset: 'ready',
  },
  interrupted: {
    llm_start: 'thinking', tool_start: 'tool', tool_end: 'interrupted', answer_start: 'answering',
    queued: 'queued', interrupt: 'interrupted', error: 'error', reset: 'ready',
  },
  error: {
    llm_start: 'thinking', tool_start: 'tool', tool_end: 'error', answer_start: 'answering',
    queued: 'queued', interrupt: 'interrupted', error: 'error', reset: 'ready',
  },
}

/** 需要动画的相位（AC-4：idle 相位不得为 animating） */
const ANIMATING_KINDS = new Set<StatusKind>(['thinking', 'tool', 'answering'])

/** Braille 主选（10 帧 × 100ms = 1s 一轮） */
export const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
/** ASCII 兜底（字体不支持 Braille 时仍可读，见兼容性 NFR） */
export const ASCII_FRAMES = ['|', '/', '-', '\\']

/** 每帧时长（与 Ticker 的 interval 一致，AC-4 的"~100ms 变化"） */
export const FRAME_INTERVAL_MS = 100

/** 由已用时长派生当前帧（纯函数 → 可确定性单测，不需要真的等 100ms） */
export function spinnerFrame(elapsedMs: number, ascii = false): string {
  const frames = ascii ? ASCII_FRAMES : BRAILLE_FRAMES
  const i = Math.floor(Math.max(0, elapsedMs) / FRAME_INTERVAL_MS) % frames.length
  return frames[i]
}

/** 已用时长文本（秒级，够用且不抖动） */
function elapsedText(ms: number): string {
  return `${Math.floor(Math.max(0, ms) / 1000)}s`
}

export class StatusMachine {
  /** 当前相位（transition 维护） */
  private current: StatusKind = 'ready'
  /** 最近一次工具名；tool_end 后保留（AC-2），reset 时清空 */
  private currentTool: string | null = null
  private queuedCount = 0
  /** 当前相位的起始时刻（elapsedMs 的基准，AC-5） */
  private phaseStartedAt: number
  /**
   * facade 静态覆盖（`TUI.setStatus` 兼容层专用）。
   * 存在时渲染恒为静态文本（无 spinner、无计时）——既有 e2e 断言 `Thinking… · model/level`
   * 依赖这一语义；一旦有新的 transition 就被取代。
   */
  private staticOverride: { kind: StatusKind; detail: string } | null = null
  /** ASCII 兜底开关（由 TUI 按环境变量注入；状态机本身不读 process.env） */
  asciiSpinner = false

  constructor(private readonly clock: () => number = Date.now) {
    this.phaseStartedAt = clock()
  }

  /** 当前相位（含静态覆盖） */
  get kind(): StatusKind {
    return this.staticOverride?.kind ?? this.current
  }

  /** 最近一次工具名（AC-2 的断言友好出口） */
  get toolName(): string | null {
    return this.currentTool
  }

  /** 是否需要动画（AC-4：idle 时为 false，静态覆盖恒 false） */
  get animating(): boolean {
    if (this.staticOverride) return false
    return ANIMATING_KINDS.has(this.current)
  }

  /**
   * 唯一迁移入口。返回值表示**相位是否变化**（供调用方判断，不做重绘去重——
   * 同一相位下工具名/排队条数也可能变化，必须重绘）。
   */
  transition(e: StatusEvent): boolean {
    this.staticOverride = null
    const next = TRANSITIONS[this.current][e.type]
    const changed = next !== this.current
    this.current = next
    // 任何事件都开启新相位：elapsedMs 从 0 重新计
    this.phaseStartedAt = this.clock()
    switch (e.type) {
      case 'tool_start':
        this.currentTool = e.name
        break
      case 'queued':
        this.queuedCount = e.count
        break
      case 'reset':
        this.currentTool = null
        this.queuedCount = 0
        break
      default:
        break
    }
    return changed
  }

  /**
   * facade 入口：直接写入静态相位（不参与动画与计时）。
   * 仅供 `TUI.setStatus(kind, detail?)` 兼容层使用（design Decision 9 / R8：防双写漂移）。
   */
  setStatic(kind: StatusKind, detail = ''): void {
    this.staticOverride = { kind, detail }
    // 同步内部相位：后续 transition 从该状态出发，而不是从覆盖前的旧相位
    this.current = kind
    this.phaseStartedAt = this.clock()
  }

  /** 纯函数渲染：给定 now 产出状态栏数据（帧与时长都由 elapsed 派生，无内部计数器） */
  render(now: number): StatusView {
    if (this.staticOverride) {
      const { kind, detail } = this.staticOverride
      return {
        kind,
        text: detail ? `${BASE_TEXT[kind]} ${detail}` : BASE_TEXT[kind],
        elapsedMs: null,
        animating: false,
      }
    }

    const kind = this.current
    if (!ANIMATING_KINDS.has(kind)) {
      const text = kind === 'queued' && this.queuedCount > 0 ? `${BASE_TEXT.queued} (${this.queuedCount} left)` : BASE_TEXT[kind]
      return { kind, text, elapsedMs: null, animating: false }
    }

    const elapsedMs = Math.max(0, now - this.phaseStartedAt)
    // D14 格式：动宾短语 + 已用时长。tool 相位必须带工具名（AC-2），故不复用静态 BASE_TEXT
    const label = kind === 'tool' ? `Running ${this.currentTool ?? ''}`.trim() : BASE_TEXT[kind]
    return {
      kind,
      text: `${spinnerFrame(elapsedMs, this.asciiSpinner)} ${label} (${elapsedText(elapsedMs)})`,
      elapsedMs,
      animating: true,
    }
  }
}

/**
 * 唯一定时器（AC-4）。惰性启停 + 幂等 + `isActive` 可内省。
 *
 * `unref()`：定时器本身不应阻止进程退出（交互模式由 stdin 保活；
 * 单轮模式不该因为一个动画 interval 挂住进程）。
 */
export class Ticker {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly onTick: () => void,
    private readonly intervalMs: number = FRAME_INTERVAL_MS,
  ) {}

  /** 幂等：已启动则 no-op（避免重复 interval 导致帧率翻倍） */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.onTick(), this.intervalMs)
    this.timer.unref?.()
  }

  /** 幂等：未启动则 no-op */
  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  get isActive(): boolean {
    return this.timer !== null
  }
}
