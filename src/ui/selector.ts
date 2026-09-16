/**
 * selector.ts — 全屏模态选择器（供 `/model` 选模型 / 选思考等级）
 *
 * 设计约定（design.md §接口设计 10、Decision 4）：
 * - **不持有 stdin/stdout**：按键由 TUI 路由进来（`handleKey`），绘制结果由 `render()` 返回行数组，
 *   由 TUI 决定写到屏幕哪里。这样选择器的全部行为都是纯逻辑，可在 e2e 中直接断言。
 * - 为什么用全屏模态而不是复用预留区（3 行）：模型列表 + 等级列表可达 10+ 项，预留区装不下（Decision 4）。
 * - 选中项用反色（`\x1b[7m`）标记，与 `src/index.ts` 的 `selectSession` 既有交互范式保持一致。
 * - `↑/↓` 循环移动（首项再上到末项，反之亦然），`Enter` 确认，`Esc` 取消。
 *
 * 渲染行数恒等于入参 `rows`（不足补空行、超出裁剪），保证 TUI 全屏接管时行数确定、可断言。
 */
import { displayWidth, truncateTo } from './text.js'

const DIM = '\x1b[90m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'
const INVERSE = '\x1b[7m' // 反色：选中项（与输入框光标、selectSession 同一套范式）

/** 选择器的一项：主文本 + 可选的能力标注副文本 */
export type SelectorItem = {
  /** 主文本（如模型名 `qwen3-vl:8b-thinking`） */
  label: string
  /** 副文本（如 `vision · tools · thinking`），可省略 */
  detail?: string
}

/** 按键对象（readline keypress 的子集，只取选择器用得到的字段） */
export type SelectorKey = {
  name?: string
  ctrl?: boolean
  meta?: boolean
  sequence?: string
}

/** `consumed` = 已处理但选择未结束；`picked` = 确认；`cancelled` = 取消 */
export type SelectorKeyResult = 'consumed' | { picked: number } | { cancelled: true }

/** 标题 + 项区上下各留 1 行空白 + 底部提示 = 4 行固定开销 */
const CHROME_ROWS = 4

export class Selector {
  private readonly items: SelectorItem[]
  private readonly title: string
  private index = 0

  constructor(items: SelectorItem[], title = 'Select') {
    this.items = items
    this.title = title
  }

  /** 当前选中项下标（0-based） */
  get selected(): number {
    return this.index
  }

  /**
   * 处理一次按键。除 ↑/↓/Enter/Esc 外的按键一律吞掉（返回 `consumed`），
   * 避免模态期间误触把字符送进输入缓冲。
   */
  handleKey(_str: string, key: SelectorKey): SelectorKeyResult {
    if (!key) return 'consumed'
    const n = this.items.length

    if (n === 0) {
      // 空列表：没有任何可选项，Enter/Esc 都视为取消（避免返回 picked 一个越界下标）
      if (key.name === 'escape' || key.name === 'return' || key.name === 'enter') return { cancelled: true }
      return 'consumed'
    }

    if (key.name === 'up') {
      this.index = (this.index - 1 + n) % n // 循环：首项再上 → 末项
      return 'consumed'
    }
    if (key.name === 'down') {
      this.index = (this.index + 1) % n // 循环：末项再下 → 首项
      return 'consumed'
    }
    if (key.name === 'escape') return { cancelled: true }
    // 真实终端 Enter 发 \r → 'return'；PTY 下可能被识别成 'enter'。
    // 选择器没有「插入换行」的语义，两者都当确认（与 selectSession 一致）。
    if (key.name === 'return' || key.name === 'enter') return { picked: this.index }
    return 'consumed'
  }

  /** 项区可视行数（至少 1 行，窄终端下也不崩） */
  private areaRows(rows: number): number {
    return Math.max(1, Math.floor(rows) - CHROME_ROWS)
  }

  /**
   * 项区滚动偏移：让选中项始终可见。
   * 选中项在窗口下方越界时窗口下移刚好露出它；到列表末尾后不再下移（避免底部留空）。
   */
  private windowOffset(rows: number): number {
    const area = this.areaRows(rows)
    const n = this.items.length
    if (n <= area) return 0
    if (this.index >= area) return Math.min(this.index - area + 1, n - area)
    return 0
  }

  /**
   * 选中项在 `render()` 结果中的行号（0-based），供 TUI 把终端光标停到该项上。
   * 布局：第 0 行标题、第 1 行空行、第 2 行起是项区。
   */
  cursorLine(rows: number): number {
    return 2 + Math.max(0, this.index - this.windowOffset(rows))
  }

  /**
   * 生成要绘制的行（恰好 `rows` 行，每行不超过 `cols` 列）。
   * 纯字符串计算，不写 stdout——TUI 负责定位与输出。
   */
  render(cols: number, rows: number): string[] {
    const w = Math.max(1, Math.floor(cols) || 1)
    const h = Math.max(1, Math.floor(rows) || 1)
    const area = this.areaRows(h)
    const offset = this.windowOffset(h)

    const out: string[] = []
    out.push(truncateTo(`${BOLD}${this.title}${RESET}`, w))
    out.push('')

    for (let i = 0; i < area; i++) {
      const item = this.items[offset + i]
      if (!item) {
        out.push('')
        continue
      }
      out.push(this.itemLine(item, offset + i === this.index, w))
    }

    out.push('')
    out.push(truncateTo(`${DIM}↑/↓ move · Enter confirm · Esc cancel${RESET}`, w))

    // 行数对齐到 rows：窄终端下项区被压到 1 行时可能超出，裁掉多余部分
    while (out.length < h) out.push('')
    return out.slice(0, h)
  }

  /** 单项一行：选中项整行反色；未选中项主文本原色 + 副文本暗灰 */
  private itemLine(item: SelectorItem, selected: boolean, cols: number): string {
    const plain = `${selected ? '▶ ' : '  '}${item.label}`
    if (selected) {
      const withDetail = item.detail ? `${plain}  ${item.detail}` : plain
      return `${INVERSE}${truncateTo(withDetail, cols)}${RESET}`
    }
    const used = displayWidth(plain)
    const detail = item.detail
      ? `${DIM}${truncateTo(`  ${item.detail}`, Math.max(0, cols - used))}${RESET}`
      : ''
    return `${truncateTo(plain, cols)}${detail}`
  }
}
