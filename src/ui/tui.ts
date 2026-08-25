/**
 * tui.ts — 自研 DECSTBM 渲染层
 *
 * 架构：
 * - Alt Screen 缓冲（\x1b[?1049h）
 * - DECSTBM 滚动区域：内容区 = 1..contentRows，状态栏/输入框/预留区在滚动区外固定
 * - 增量追加输出：内容从滚动区顶部逐行写入，写满后终端自动滚动（产生滚动历史 → 滚轮可用）
 * - 每轮对话自己的思考面板（2 行，在滚动区）：用户消息 → 思考面板 → LLM 回复
 *   思考面板用"逻辑行→物理行"映射精确重绘，不展开/折叠，杜绝行数变化导致的错乱
 *
 * 布局（1-based）：
 *   1..contentRows      滚动区（banner + 每轮：用户消息 + 思考面板 + 回复）
 *   contentRows+1       状态栏
 *   contentRows+2..+4   输入框（顶/内容/底）
 *   contentRows+5..rows 预留区
 */
import readline from 'readline'

// === SGR 样式（Select Graphic Rendition：\x1b[<n>m 设置文本样式） ===
// 前景色层次（代码写死，不靠提示词约束；暗 → 亮：思考 < 回答 < 强调）：
const DIM = '\x1b[90m' // 暗灰：思考面板/工具行等辅助文字，最不显眼
const CODE = '\x1b[36m' // 青色：行内代码 / 代码块
const BOLD = '\x1b[1m' // 加粗（markdown **重点** / 标题）
const RESET = '\x1b[0m' // 重置所有样式
const GREEN = '\x1b[32m' // 绿色（"You" 前缀、Ready 状态）
const RED = '\x1b[31m' // 红色（错误）
const INVERSE = '\x1b[7m' // 反色（前景/背景互换），用于输入光标所在字符
const YELLOW = '\x1b[33m' // 黄色（Thinking/Interrupted 状态）
const CYAN = '\x1b[36m' // 青色（工具/回答/排队状态）

// === ANSI 控制序列 ===
// \x1b = ESC 键；CSI = \x1b[（Control Sequence Introducer，控制序列引导符），
// 格式：CSI 参数 ; 参数 ... 最终字节（字母）。最终字节决定具体指令。
// 参考：https://vt100.net/docs/vt510-rm/
const ALT_SCREEN_ENTER = '\x1b[?1049h' // 进入备用屏（Alt Screen）：保存主屏内容并清空绘制区，退出时原样恢复（TUI 程序的标准做法）
const ALT_SCREEN_EXIT = '\x1b[?1049l' // 退出备用屏，恢复进入前的主屏内容
const CURSOR_SHOW = '\x1b[?25h' // 显示光标（对应 \x1b[?25l 隐藏光标）
const ERASE_DISPLAY = '\x1b[2J' // 清空整个屏幕（不影响滚动历史）
const ERASE_SCROLLBACK = '\x1b[3J' // 清空终端滚动历史（滚轮/滚动条不可见的旧行）
const ERASE_LINE = '\x1b[K' // 从光标处擦除到行尾
const DECSTBM = (bottom: number) => `\x1b[1;${bottom}r` // 设置滚动区为第 1..bottom 行：区域内的滚动只影响这些行，区域外（如状态栏/输入框）固定不动
const CUP = (row: number, col: number) => `\x1b[${row};${col}H` // Cursor Position：光标绝对定位到 (row, col)，均为 1-based
const CHA = (col: number) => `\x1b[${col}G` // Cursor Horizontal Absolute：光标绝对定位到第 col 列（1-based），行不变

// === 状态栏：状态类型 → 文案 + 颜色（统一英文） ===
export type StatusKind =
  | 'ready'
  | 'thinking'
  | 'tool'
  | 'answering'
  | 'queued'
  | 'interrupted'
  | 'error'

const STATUS_STYLE: Record<StatusKind, { text: string; color: string }> = {
  ready: { text: 'Ready', color: GREEN },
  thinking: { text: 'Thinking…', color: YELLOW },
  tool: { text: 'Running tool', color: CYAN },
  answering: { text: 'Answering…', color: CYAN },
  queued: { text: 'Queued', color: CYAN },
  interrupted: { text: 'Interrupted', color: YELLOW },
  error: { text: 'Error', color: RED },
}

// === 消息块模型 ===
type MsgBlock =
  | { type: 'banner'; lines: string[] }
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; outputCount: number }
  | { type: 'thinking'; full: string; done: boolean }
  | { type: 'tool'; text: string }
  | { type: 'error'; text: string }

// === 工具函数 ===

export function displayWidth(s: string): number {
  let w = 0
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!
    w += cp > 0x7f ? 2 : 1
    if (cp > 0xffff) i++
  }
  return w
}

export function wrapText(s: string, maxW: number): string[] {
  if (!s) return ['']
  const lines: string[] = []
  let cur = ''
  let w = 0
  for (const ch of s) {
    if (ch === '\n') {
      lines.push(cur)
      cur = ''
      w = 0
      continue
    }
    const cw = ch.codePointAt(0)! > 0x7f ? 2 : 1
    if (w + cw > maxW) {
      lines.push(cur)
      cur = ch
      w = cw
    } else {
      cur += ch
      w += cw
    }
  }
  lines.push(cur)
  return lines
}

export function truncateTo(s: string, maxW: number): string {
  if (maxW <= 0) return ''
  let out = ''
  let w = 0
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\x1b') {
      let j = i + 1
      if (s[j] === '[') {
        j++
        while (j < s.length && !/[A-Za-z]/.test(s[j])) j++
        out += s.slice(i, j + 1)
        i = j + 1
      } else {
        out += ch
        i++
      }
      continue
    }
    const cp = s.codePointAt(i)!
    const cw = cp > 0x7f ? 2 : 1
    if (w + cw > maxW) {
      if (w + 1 <= maxW) out += '…'
      break
    }
    out += ch
    w += cw
    i += cp > 0xffff ? 2 : 1
  }
  return out
}

export function tailByWidth(s: string, maxW: number): string {
  const chars = [...s]
  let w = 0
  let out = ''
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = displayWidth(chars[i])
    if (w + cw > maxW) break
    out = chars[i] + out
    w += cw
  }
  return out
}

/**
 * 渲染一行内的轻量 Markdown（样式写死，让模型自由发挥）：
 * - `**粗体**` → 加粗
 * - `` `行内代码` `` → 青色
 * - `# 标题` → 加粗
 * 普通文本用终端默认前景色（不强制着色，避免刺眼）。先换行后解析（跨行的标记会保留原样，可接受）。
 */
export function inlineMarkdown(line: string): string {
  const trimmed = line.trimStart()
  // 标题：整行加粗
  if (/^#{1,3}\s+/.test(trimmed)) {
    return `${BOLD}${line}${RESET}`
  }
  // 行内标记：**bold** 或 `code`
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    out += line.slice(last, m.index)
    const token = m[0]
    if (token.startsWith('**')) {
      out += `${BOLD}${token.slice(2, -2)}${RESET}`
    } else {
      out += `${CODE}${token.slice(1, -1)}${RESET}`
    }
    last = m.index + token.length
  }
  out += line.slice(last)
  return out
}

// === TUI ===

const INPUT_ROWS = 3
const STATUS_ROWS = 1
const RESERVED_ROWS = 3

export type TUIHandlers = {
  onEnter: (text: string) => void
  onExit: () => void
  onInterrupt: () => void
}

export class TUI {
  private blocks: MsgBlock[] = []
  private status: StatusKind = 'ready'
  private statusDetail = ''
  private inputValue = ''
  private inputCursor = 0
  private history: string[] = []
  private historyIdx = 0
  private cols = 80
  private rows = 24
  private contentRows = 0
  /** 滚动区当前输出到的物理行（1-based，0=未开始） */
  private currentRow = 0
  /** 滚动区已写入的逻辑行数（用于 逻辑行→物理行 映射） */
  private outputRows = 0
  /** 当前思考面板的起始逻辑行（1-based） */
  private thinkLogicalStart = 0
  private handlers: TUIHandlers | null = null
  private readonly BANNER: string[]
  private readonly PROMPT = `${GREEN}>${RESET} `
  private readonly PROMPT_VIS = '> '
  private onResizeBound: () => void
  private onKeypressBound: (str: string, key: any) => void

  constructor(banner: string[]) {
    this.BANNER = banner
    this.onResizeBound = () => this.onResize()
    this.onKeypressBound = (str, key) => this.onKeypress(str, key)
  }

  // === 生命周期 ===

  enter(handlers: TUIHandlers) {
    this.handlers = handlers
    this.syncSize()
    this.blocks = [{ type: 'banner', lines: this.BANNER }]

    process.stdout.write(ALT_SCREEN_ENTER + CURSOR_SHOW)
    this.setScrollRegion()
    this.rerender(0, true)

    readline.emitKeypressEvents(process.stdin)
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('keypress', this.onKeypressBound)

    process.stdout.on('resize', this.onResizeBound)
  }

  exit() {
    process.stdout.removeListener('resize', this.onResizeBound)
    process.stdin.removeListener('keypress', this.onKeypressBound)
    process.stdout.write(CURSOR_SHOW + ALT_SCREEN_EXIT)
  }

  private syncSize() {
    const c = process.stdout.columns
    const r = process.stdout.rows
    if (c) this.cols = c
    if (r) this.rows = r
    this.contentRows = Math.max(1, this.rows - INPUT_ROWS - STATUS_ROWS - RESERVED_ROWS)
  }

  private onResize() {
    this.syncSize()
    this.setScrollRegion()
    const lines = this.flattenBlocks()
    const total = lines.length
    const excess = Math.max(0, total - this.contentRows)

    // 清屏 + 清历史：消除终端 alt-screen 重排（reflow）留下的残影/重复
    this.cursorTo(1)
    this.write(ERASE_DISPLAY + ERASE_SCROLLBACK)

    this.currentRow = 0
    this.outputRows = 0
    this.thinkLogicalStart = 0

    // 重建滚动历史：把最早 excess 行按 contentRows 一段段写入滚动区并滚动推入
    // 终端历史，让滚动条立即恢复，且内容与流式一致（历史 + 最新一屏）。
    let written = 0
    while (written < excess) {
      const n = Math.min(this.contentRows, excess - written)
      this.currentRow = 0
      for (let i = 0; i < this.contentRows; i++) {
        const line = lines[written + i]
        this.currentRow++
        this.cursorTo(this.currentRow)
        this.clearLine()
        if (line !== undefined) this.write(truncateTo(line, this.cols))
      }
      for (let i = 0; i < n; i++) {
        this.cursorTo(this.contentRows)
        this.write('\r\n')
      }
      written += n
    }

    // 显示最新 contentRows 行
    this.currentRow = 0
    const from = excess
    for (let i = from; i < total; i++) {
      this.currentRow++
      this.cursorTo(this.currentRow)
      this.clearLine()
      this.write(truncateTo(lines[i], this.cols))
    }
    this.outputRows = total
    this.renderFixed()
  }

  private setScrollRegion() {
    process.stdout.write(DECSTBM(this.contentRows))
  }

  // === 低层输出 ===

  private cursorTo(row: number) {
    process.stdout.write(CUP(row, 1))
  }

  private write(s: string) {
    process.stdout.write(s)
  }

  private clearLine() {
    process.stdout.write(ERASE_LINE)
  }

  /** 追加一行到滚动区（写满自动滚动 → 终端产生滚动历史） */
  private appendLine(line: string) {
    const text = truncateTo(line, this.cols)
    this.outputRows++
    if (this.outputRows <= this.contentRows) {
      this.currentRow++
      this.cursorTo(this.currentRow)
      this.clearLine()
      this.write(text)
      this.write('\r') // \r（回车）：光标回到行首，避免行尾残留光标影响下一次定位
    } else {
      // 先触发滚动（底部行变空），再在底部行写入。
      // 若先写后 \r\n，终端会把刚写的行滚到倒数第二行、底部留空，
      // 而 currentRow 仍指向底部 → 后续 updateLastLine 写到空行，行内容丢失。
      this.cursorTo(this.contentRows)
      this.write('\r\n') // \r\n：在滚动区底部产生一次换行，触发终端把顶部行推入滚动历史
      this.cursorTo(this.contentRows)
      this.clearLine()
      this.write(text)
      this.write('\r')
    }
  }

  /** 逻辑行（1-based）→ 物理行（1-based 滚动区），不可见返回 null */
  private logicalToPhysical(logicalRow: number): number | null {
    const offset = Math.max(0, this.outputRows - this.contentRows)
    const physical = logicalRow - offset
    if (physical >= 1 && physical <= this.contentRows) return physical
    return null
  }

  // === 渲染行生成 ===

  /** 思考面板（1 行）：状态 + 水平滚动尾部摘要（紧凑） */
  private thinkingLines(b: Extract<MsgBlock, { type: 'thinking' }>): string {
    const clean = b.full.replace(/\n/g, ' ')
    const w = Math.max(10, this.cols - 14)
    const tail = tailByWidth(clean, w)
    const ellipsis = [...clean].length > [...tail].length ? '…' : ''
    const stateText = b.done ? '▸ Thinking done' : '▸ Thinking…'
    return `${DIM}${stateText} ${ellipsis}${tail}${RESET}`
  }

  /** blocks → 渲染行（带样式） */
  private flattenBlocks(): string[] {
    const out: string[] = []
    for (const b of this.blocks) {
      switch (b.type) {
        case 'banner':
          for (const l of b.lines) out.push(`${DIM}${l}${RESET}`)
          break
        case 'user':
          out.push(`${GREEN}You${RESET}: ${b.text}`)
          break
        case 'assistant':
          // 轻量 Markdown 渲染：按 ``` 代码块切分，代码块整体青色显示，
          // 普通文本换行后解析行内 **加粗** / `行内代码`
          {
            const parts = b.text.split(/```/)
            parts.forEach((part, idx) => {
              if (idx % 2 === 1) {
                // 代码块（在两个 ``` 之间）：青色，按行截断不自动换行
                for (const l of part.replace(/^\n/, '').replace(/\n$/, '').split('\n')) {
                  out.push(`${CODE}${l}${RESET}`)
                }
              } else {
                for (const l of wrapText(part, this.cols)) {
                  out.push(inlineMarkdown(l))
                }
              }
            })
          }
          break
        case 'thinking':
          out.push(this.thinkingLines(b))
          break
        case 'tool':
          out.push(`${DIM}[tool] ${b.text}${RESET}`)
          break
        case 'error':
          out.push(`${RED}${b.text}${RESET}`)
          break
      }
    }
    return out
  }

  /**
   * 重绘滚动区。从 top 行起写 contentRows 行（不滚动）。
   * clearScreen=true：清屏 + 清滚动历史（用于 enter/clear，避免 alt-screen 残留）。
   * clearScreen=false：原地覆写（流式用，无闪烁）。
   */
  private rerender(top: number, clearScreen = false) {
    const lines = this.flattenBlocks()
    const maxTop = Math.max(0, lines.length - this.contentRows)
    top = Math.max(0, Math.min(top, maxTop))

    if (clearScreen) {
      this.cursorTo(1)
      this.write(ERASE_DISPLAY + ERASE_SCROLLBACK)
      this.setScrollRegion()
    }

    this.currentRow = 0
    this.outputRows = 0
    this.thinkLogicalStart = 0
    for (let i = top; i < Math.min(top + this.contentRows, lines.length); i++) {
      this.currentRow++
      this.cursorTo(this.currentRow)
      this.clearLine()
      this.write(truncateTo(lines[i], this.cols))
    }
    // outputRows 表示逻辑总行数（含已滚出屏幕的部分），用于
    // logicalToPhysical 映射和流式增量滚动的 prevExcess 计算。
    this.outputRows = lines.length

    this.renderFixed()
  }

  /**
   * 重绘到"底部"（即显示最后 contentRows 行），原地覆写，无闪烁。流式用。
   * 覆写前先增量触发终端滚动，把新增的超出行真正推入终端滚动历史
   * （滚动条可回看），避免整区覆写导致滚动条消失。
   */
  private rerenderToBottom() {
    const total = this.flattenBlocks().length
    const top = Math.max(0, total - this.contentRows)
    const prevExcess = Math.max(0, this.outputRows - this.contentRows)
    const scrollN = Math.max(0, top - prevExcess)
    for (let i = 0; i < scrollN; i++) {
      this.cursorTo(this.contentRows)
      this.write('\r\n')
    }
    this.rerender(top, false)
  }

  // === 固定区 ===

  private statusRow(): number {
    return this.contentRows + 1
  }
  private inputTopRow(): number {
    return this.contentRows + 2
  }
  private inputContentRow(): number {
    return this.contentRows + 3
  }
  private inputBotRow(): number {
    return this.contentRows + 4
  }

  private inputLineText(): string {
    const avail = this.cols - 3
    const vis = this.inputValue
    const promptW = displayWidth(this.PROMPT_VIS)
    if (displayWidth(vis) <= avail - promptW - 2) {
      const before = vis.slice(0, this.inputCursor)
      const at = vis[this.inputCursor] || ' '
      const after = vis.slice(this.inputCursor + 1)
      return `| ${this.PROMPT}${before}${INVERSE}${at}${RESET}${after}`
    }
    const windowLen = Math.max(5, avail - promptW - 2)
    const beforeChars = [...vis.slice(0, this.inputCursor)]
    const afterChars = [...vis.slice(this.inputCursor)]
    let beforeW = 0
    let keepBefore: string[] = []
    for (let i = beforeChars.length - 1; i >= 0; i--) {
      const cw = displayWidth(beforeChars[i])
      if (beforeW + cw > windowLen - 4) break
      keepBefore.unshift(beforeChars[i])
      beforeW += cw
    }
    const showBefore = keepBefore.length < beforeChars.length
    let afterW = 0
    let keepAfter: string[] = []
    for (const ch of afterChars) {
      const cw = displayWidth(ch)
      if (afterW + cw > windowLen - 4) break
      keepAfter.push(ch)
      afterW += cw
    }
    const at = (afterChars.length > keepAfter.length ? keepAfter.shift() : undefined) || ' '
    const before = (showBefore ? '…' : '') + keepBefore.join('')
    const after = keepAfter.join('') + (afterChars.length > keepAfter.length + (at === ' ' ? 0 : 1) ? '…' : '')
    return `| ${this.PROMPT}${before}${INVERSE}${at}${RESET}${after}`
  }

  private cursorCol(): number {
    const promptW = displayWidth(this.PROMPT_VIS)
    const beforeW = displayWidth(this.inputValue.slice(0, this.inputCursor))
    return 3 + promptW + beforeW
  }

  /** 状态栏完整文本（含颜色） */
  private statusLineText(): string {
    const s = STATUS_STYLE[this.status]
    const text = this.statusDetail ? `${s.text} ${this.statusDetail}` : s.text
    return `${s.color}● ${text}${RESET}`
  }

  private renderFixed() {
    const statusLine = this.statusLineText()
    const topBorder = `${DIM}+-- input ${'-'.repeat(Math.max(0, this.cols - 11))}+${RESET}`
    const botBorder = `${DIM}+${'-'.repeat(this.cols - 2)}+${RESET}`

    this.cursorTo(this.statusRow())
    this.clearLine()
    this.write(statusLine)

    this.cursorTo(this.inputTopRow())
    this.clearLine()
    this.write(topBorder)

    this.cursorTo(this.inputContentRow())
    this.clearLine()
    this.write(this.inputLineText())

    this.cursorTo(this.inputBotRow())
    this.clearLine()
    this.write(botBorder)

    for (let i = this.contentRows + 5; i <= this.rows; i++) {
      this.cursorTo(i)
      this.clearLine()
    }

    this.cursorTo(this.inputContentRow())
    this.write(CHA(this.cursorCol()))
  }

  private renderInput() {
    const topBorder = `${DIM}+-- input ${'-'.repeat(Math.max(0, this.cols - 11))}+${RESET}`
    const botBorder = `${DIM}+${'-'.repeat(this.cols - 2)}+${RESET}`

    this.cursorTo(this.inputTopRow())
    this.clearLine()
    this.write(topBorder)

    this.cursorTo(this.inputContentRow())
    this.clearLine()
    this.write(this.inputLineText())

    this.cursorTo(this.inputBotRow())
    this.clearLine()
    this.write(botBorder)

    this.cursorTo(this.inputContentRow())
    this.write(CHA(this.cursorCol()))
  }

  setStatus(kind: StatusKind, detail?: string) {
    const text = detail ? `${STATUS_STYLE[kind].text} ${detail}` : STATUS_STYLE[kind].text
    if (this.status === kind && this.statusDetail === (detail ?? '')) return
    this.status = kind
    this.statusDetail = detail ?? ''
    this.cursorTo(this.statusRow())
    this.clearLine()
    this.write(`${STATUS_STYLE[kind].color}● ${text}${RESET}`)
    this.cursorTo(this.inputContentRow())
    this.write(CHA(this.cursorCol()))
  }

  // === 业务方法 ===

  addUserMessage(text: string) {
    this.blocks.push({ type: 'user', text })
    this.appendLine(`${GREEN}You${RESET}: ${text}`)
    this.renderFixed()
  }

  appendToLast(chunk: string) {
    // 清洗 LLM 输出：去掉 ANSI 转义和控制字符（防止破坏终端渲染，如大段空白）
    const cleaned = chunk
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')

    const blocks = [...this.blocks]
    const last = blocks[blocks.length - 1]

    // 思考结束（第一个 token）：面板标记完成
    if (last.type === 'thinking' && !last.done) {
      last.done = true
      this.blocks = blocks
      this.renderThinkingPanel(last)
    }

    if (last.type === 'assistant') {
      last.text += cleaned
    } else {
      blocks.push({ type: 'assistant', text: cleaned, outputCount: 0 })
    }
    this.blocks = blocks

    // 流式输出：直接整区原地重绘到底部。
    // 避免增量 updateLastLine + appendLine 的光标/换行边界追踪脆弱性
    // （行宽跨越换行点时旧"最后一行"会残留、超过一屏后内容错乱）。
    // 整区重绘每次 O(contentRows) 写入，对终端无压力且零闪烁。
    this.rerenderToBottom()
  }

  addThinking() {
    this.blocks.push({ type: 'thinking', full: '', done: false })
    this.thinkLogicalStart = this.outputRows + 1
    this.appendLine(this.thinkingLines({ type: 'thinking', full: '', done: false }))
    this.renderFixed()
  }

  /** 重绘思考面板（用逻辑行→物理行映射定位，多轮滚动后仍精确） */
  private renderThinkingPanel(b: Extract<MsgBlock, { type: 'thinking' }>) {
    const line = this.thinkingLines(b)
    const p1 = this.logicalToPhysical(this.thinkLogicalStart)
    if (p1 === null) return // 面板已滚出视口，不渲染
    this.cursorTo(p1)
    this.clearLine()
    this.write(truncateTo(line, this.cols))
    this.cursorTo(this.inputContentRow())
    this.write(CHA(this.cursorCol()))
  }

  updateThinking(chunk: string) {
    const blocks = [...this.blocks]
    const last = blocks[blocks.length - 1]
    if (last.type !== 'thinking' || last.done) return
    last.full += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    this.blocks = blocks
    this.renderThinkingPanel(last)
  }

  addToolLine(line: string) {
    this.blocks.push({ type: 'tool', text: line })
    this.appendLine(`${DIM}[tool] ${line}${RESET}`)
    this.renderFixed()
  }

  addInfo(text: string) {
    this.blocks.push({ type: 'tool', text })
    for (const l of text.split('\n')) {
      if (l.trim()) this.appendLine(`${DIM}${l}${RESET}`)
    }
    this.renderFixed()
  }

  showError(msg: string) {
    this.blocks.push({ type: 'error', text: msg })
    this.appendLine(`${RED}${msg}${RESET}`)
    this.renderFixed()
  }

  clear() {
    this.blocks = [{ type: 'banner', lines: this.BANNER }]
    // clearScreen=true：清屏 + 清滚动历史，彻底重开（否则旧内容和历史会残留）
    this.rerender(0, true)
  }

  /** 从磁盘历史恢复渲染（重启恢复会话用）。tool/tool_calls 消息跳过，只渲染 user/assistant 文本。 */
  restoreHistory(items: { role: string; content?: unknown }[]) {
    this.blocks = [{ type: 'banner', lines: this.BANNER }]
    for (const item of items) {
      if (item.role === 'user') {
        this.blocks.push({ type: 'user', text: typeof item.content === 'string' ? item.content : '' })
      } else if (item.role === 'assistant' && typeof item.content === 'string') {
        this.blocks.push({ type: 'assistant', text: item.content, outputCount: 0 })
      }
    }
    this.rerenderToBottom()
  }

  // === 键盘 ===

  private onKeypress(_str: string, key: any) {
    if (!key) return
    const h = this.handlers
    if (!h) return

    if (key.ctrl && key.name === 'c') {
      h.onExit()
      return
    }
    if (key.name === 'escape') {
      h.onInterrupt()
      return
    }
    if (key.name === 'up') {
      this.historyUp()
      return
    }
    if (key.name === 'down') {
      this.historyDown()
      return
    }
    if (key.name === 'left') {
      this.moveLeft()
      return
    }
    if (key.name === 'right') {
      this.moveRight()
      return
    }
    if (key.name === 'backspace') {
      this.backspace()
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      const v = this.submit()
      if (v) h.onEnter(v)
      return
    }
    if (_str) {
      for (const ch of _str) {
        if (ch === '\r' || ch === '\n') {
          const v = this.submit()
          if (v) h.onEnter(v)
        } else {
          this.typeChar(ch)
        }
      }
    }
  }

  private typeChar(ch: string) {
    this.inputValue = this.inputValue.slice(0, this.inputCursor) + ch + this.inputValue.slice(this.inputCursor)
    this.inputCursor += [...ch].length
    this.renderInput()
  }

  private backspace() {
    if (this.inputCursor <= 0) return
    const chars = [...this.inputValue]
    chars.splice(this.inputCursor - 1, 1)
    this.inputValue = chars.join('')
    this.inputCursor--
    this.renderInput()
  }

  private moveLeft() {
    if (this.inputCursor > 0) {
      this.inputCursor--
      this.renderInput()
    }
  }

  private moveRight() {
    if (this.inputCursor < [...this.inputValue].length) {
      this.inputCursor++
      this.renderInput()
    }
  }

  private historyUp() {
    if (this.history.length === 0) return
    if (this.historyIdx > 0) this.historyIdx--
    this.inputValue = this.history[this.historyIdx]
    this.inputCursor = [...this.inputValue].length
    this.renderInput()
  }

  private historyDown() {
    if (this.historyIdx < this.history.length) this.historyIdx++
    if (this.historyIdx >= this.history.length) this.inputValue = ''
    else this.inputValue = this.history[this.historyIdx]
    this.inputCursor = [...this.inputValue].length
    this.renderInput()
  }

  private submit(): string {
    const v = this.inputValue.trim()
    if (v) {
      this.history.push(v)
      this.historyIdx = this.history.length
    }
    this.inputValue = ''
    this.inputCursor = 0
    this.renderInput()
    return v
  }
}
