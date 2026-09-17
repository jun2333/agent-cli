/**
 * interaction.ts — 通用交互原语的分派中枢（FR-5）
 *
 * 为什么要有这一层（design.md Decision 5 / Option B）：
 * - 交互原语有**四个消费者**：权限审批（FR-6）、`/jobs`（FR-2）、Hook 信任（FR-8）、LLM 的
 *   `ask_user` 工具。AC-27 要求"UI 层与 LLM 层走**同一实现分派路径**"。
 *   如果每个消费者各写一次 `openXxx(cb)` + 回调转 Promise 的胶水，键位语义、Esc 语义、
 *   非交互降级就要各写一遍且必然漂移 —— 用一个 `request(spec): Promise<result>` 把
 *   "分派"这件事收敛成单一入口，是唯一能让 AC-27 成立的形态。
 * - 降级（非交互自动拒绝、`--yes` 自动接受、`forced` 规则拒绝）集中在这一个函数里，
 *   不散落到各消费者（D9 + V-1）。
 *
 * 分层：本模块**不碰** stdin/stdout（唯一的例外是 ui 缺失时的 stderr 提示，与 index.ts 的
 * 非交互错误通道一致），UI 通过 `InteractionHost` 结构化接口注入 —— 这样单测可以直接注入
 * 一个记录型假 host，不需要起 TUI（AC-27/28/29 都要求单测）。
 *
 * ⚠️ 本模块的 `InteractionHost` 刻意不 import TUI：`TUI` 结构上满足它即可，
 * 避免 `tui → overlay → interaction → tui` 的类型环。
 */

// === 请求 / 结果 ===

/**
 * 一次交互请求的规格（三种形态，AC-24）。
 *
 * `forced`：该请求来自**强制审批规则**（危险命令，AC-36）。它只影响 `--yes` 分支：
 * `--yes` 不覆盖 forced（V-1 的安全优先裁决），因此 spec 必须能携带这个事实。
 * 其余形态的 `forced` 当前恒为 undefined，保留字段是为了让 broker 的判定不必按 kind 收窄。
 */
export type InteractionSpec =
  | { kind: 'confirm'; title: string; message?: string; defaultYes?: boolean; forced?: boolean }
  | {
      kind: 'select'
      title: string
      items: { label: string; detail?: string }[]
      allowManualInput?: boolean
      forced?: boolean
    }
  | { kind: 'input'; title: string; message?: string; placeholder?: string; forced?: boolean }

/** 三种形态的成功结果（浮层与 `--yes` 自动接受都产出这个集合） */
export type OverlaySubmit =
  | { kind: 'confirm'; value: boolean }
  | { kind: 'select'; index: number; label: string; manual?: string }
  | { kind: 'input'; value: string }

/** 浮层能产出的全部结果：成功或用户取消（Esc）。`unavailable` 由 broker 的降级分支产生。 */
export type OverlayResult = OverlaySubmit | { kind: 'cancelled' }

/**
 * 交互请求的最终结果（AC-28 的"结构化结果"）。
 *
 * `unavailable` 是**快速失败**的降级结果，语义是"本次交互没有被执行"，分两种原因：
 * - `non-interactive`：没有可用 TUI 或 stdin 非 TTY（D9 默认拒绝，AC-28）；
 * - `forced`：`--yes` 下遇到强制审批规则（V-1：必须显式用 `bypass` 模式）。
 * 两者都会让 `deniedCount` +1（AC-28 的进程退出码依据）。
 */
export type InteractionResult = OverlayResult | { kind: 'unavailable'; reason: UnavailableReason; message?: string }

/** 「需交互但当前非交互」的具体原因（AC-28 / V-1） */
export type UnavailableReason = 'non-interactive' | 'forced'

/**
 * Broker 对 UI 的最小依赖（结构化接口）。
 * `TUI` 天然满足；单测可注入记录型假对象（AC-27 的 spy 断言）。
 */
export type InteractionHost = {
  /** 打开内联浮层；返回在浮层关闭（提交或取消）时 resolve 的 Promise（Decision 5：Promise-based） */
  openInteractionOverlay(spec: InteractionSpec): Promise<OverlayResult>
  /** 释放挂起中的浮层（退出收尾用，避免 awaiting 的 Promise 永久悬挂）；无浮层时为 no-op */
  cancelInteractionOverlay?(): void
  /** 非致命提示（非交互降级、forced 拒绝等） */
  addInfo(text: string): void
}

/** 运行环境（由入口装配时注入；不读全局，便于单测直接构造四种降级场景） */
export type InteractionEnv = {
  /** 是否有可用 TUI 且 stdin 是 TTY */
  interactive: boolean
  /** `--yes`：自动接受**非 forced** 的交互（V-1：与 `bypass` 语义不等价） */
  autoAccept: boolean
}

/** `--yes` 自动接受时各形态取的值（AC-29 / R10） */
function autoAcceptResult(spec: InteractionSpec): OverlaySubmit {
  if (spec.kind === 'confirm') return { kind: 'confirm', value: spec.defaultYes ?? true }
  if (spec.kind === 'select') return { kind: 'select', index: 0, label: spec.items[0]?.label ?? '' }
  return { kind: 'input', value: spec.placeholder ?? '' }
}

/** 降级提示文案（结构化结果与提示共用同一句，避免两处措辞漂移） */
const NON_INTERACTIVE_MESSAGE = '需交互但当前非交互：已按拒绝处理（普通审批可用 --yes 自动接受）。'
const FORCED_MESSAGE = '该操作命中强制审批规则：--yes 不覆盖危险操作，需显式使用 bypass 权限模式。'

/**
 * 交互请求的唯一分派入口（AC-27）。
 *
 * 降级矩阵（V-1 裁决后为 **4 种**，各有单测）：
 * 1. 正常交互 → 打开内联浮层（`host.openInteractionOverlay`）；
 * 2. `!interactive` 或没有 host → 自动拒绝：返回 `unavailable/non-interactive` + `deniedCount++`；
 * 3. `autoAccept`（`--yes`）且**非 forced** → 自动接受（不产生任何交互等待，不触碰 UI）；
 * 4. `autoAccept` 且 **forced** → 拒绝 + 提示「需显式使用 bypass 模式」+ `deniedCount++`。
 *
 * 判定顺序：**先判 autoAccept 再判 interactive**。理由：`--yes` 是"非交互下的交互替代策略"，
 * 交互模式下用户仍可用 `--yes` 让脚本化行为一致；两者同时为真时以 `--yes` 为准更符合直觉
 * （与 design §3 的伪码顺序一致）。
 */
export class InteractionBroker {
  /** 「因非交互/forced 而被拒」的计数（AC-28 的进程退出码依据） */
  private denied = 0
  /** 挂起中的浮层 resolver（`cancelAll` 用：退出时释放，避免 await 永久悬挂） */
  private pending: Array<(r: InteractionResult) => void> = []

  constructor(
    private readonly ui: InteractionHost | null,
    private readonly env: InteractionEnv,
  ) {}

  get deniedCount(): number {
    return this.denied
  }

  /**
   * 当前环境是否有可用交互通道（= `InteractionEnv.interactive` 的事实）。
   *
   * 暴露为只读 getter 的目的：让**非交互能力的判定只有一个来源**。后台任务（FR-2/V-8）
   * 需要"非交互模式直接拒绝"这个事实，若让消费方各写一份 `process.stdin.isTTY` 判断，
   * 就会出现"broker 认为是非交互、bash 认为是交互"的漂移。
   */
  get interactive(): boolean {
    return this.env.interactive
  }

  /** 是否有浮层正在等待用户（观测用；真值由 host 的浮层状态与 pending 共同决定） */
  get isWaiting(): boolean {
    return this.pending.length > 0
  }

  async request(spec: InteractionSpec): Promise<InteractionResult> {
    // ① --yes 自动接受；但 forced 规则不得被覆盖（V-1：安全优先）
    if (this.env.autoAccept) {
      if (spec.forced === true) {
        this.denied++
        this.notify(FORCED_MESSAGE)
        return { kind: 'unavailable', reason: 'forced', message: FORCED_MESSAGE }
      }
      return autoAcceptResult(spec)
    }

    // ② 非交互：快速失败（D9 默认拒绝），不挂起
    if (!this.env.interactive || !this.ui) {
      this.denied++
      this.notify(NON_INTERACTIVE_MESSAGE)
      return { kind: 'unavailable', reason: 'non-interactive', message: NON_INTERACTIVE_MESSAGE }
    }

    // ③ 正常：打开内联浮层（Promise-based，事件循环继续处理键位 → 不阻塞）
    return this.awaitHost(spec)
  }

  /**
   * 释放挂起中的请求（FR-3 的退出收尾 / FR-5）。
   * 先让 host 关掉浮层（它会 resolve 自己的 Promise），再把仍挂起的 resolver 一律按取消结算 ——
   * 双保险：host 若是 fake（测试注入）也能被释放，不会留下永不 resolve 的 Promise。
   */
  cancelAll(): void {
    this.ui?.cancelInteractionOverlay?.()
    const waiting = this.pending
    this.pending = []
    for (const done of waiting) done({ kind: 'cancelled' })
  }

  private awaitHost(spec: InteractionSpec): Promise<InteractionResult> {
    return new Promise<InteractionResult>((resolve) => {
      let settled = false
      const done = (r: InteractionResult) => {
        if (settled) return
        settled = true
        const i = this.pending.indexOf(done)
        if (i >= 0) this.pending.splice(i, 1)
        resolve(r)
      }
      this.pending.push(done)
      this.ui!.openInteractionOverlay(spec).then(done, () => done({ kind: 'cancelled' }))
    })
  }

  private notify(message: string): void {
    if (this.ui) this.ui.addInfo(message)
    else process.stderr.write(`${message}\n`)
  }
}
