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

// === 样式 ===
const DIM = '\x1b[90m'
const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const BOLD = '\x1b[1m'
const RED = '\x1b[31m'
const INVERSE = '\x1b[7m'

// === 消息块模型 ===
type MsgBlock =
  | { type: 'banner'; lines: string[] }
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; outputCount: number }
  | { type: 'thinking'; full: string; done: boolean }
  | { type: 'tool'; text: string }
  | { type: 'error'; text: string }

// === 工具函数 ===

function displayWidth(s: string): number {
  let w = 0
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!
    w += cp > 0x7f ? 2 : 1
    if (cp > 0xffff) i++
  }
  return w
}

function wrapText(s: string, maxW: number): string[] {
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

function truncateTo(s: string, maxW: number): string {
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

function tailByWidth(s: string, maxW: number): string {
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
  private status = 'Ready'
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

    process.stdout.write('\x1b[?1049h\x1b[?25h')
    this.setScrollRegion()
    this.rerender(0)

    readline.emitKeypressEvents(process.stdin)
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('keypress', this.onKeypressBound)

    process.stdout.on('resize', this.onResizeBound)
  }

  exit() {
    process.stdout.removeListener('resize', this.onResizeBound)
    process.stdin.removeListener('keypress', this.onKeypressBound)
    process.stdout.write('\x1b[?25h\x1b[?1049l')
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
    this.rerender(0)
  }

  private setScrollRegion() {
    process.stdout.write(`\x1b[1;${this.contentRows}r`)
  }

  // === 低层输出 ===

  private cursorTo(row: number) {
    process.stdout.write(`\x1b[${row};1H`)
  }

  private write(s: string) {
    process.stdout.write(s)
  }

  private clearLine() {
    process.stdout.write('\x1b[K')
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
      this.write('\r')
    } else {
      this.cursorTo(this.contentRows)
      this.clearLine()
      this.write(text + '\r\n')
    }
  }

  /** 逻辑行（1-based）→ 物理行（1-based 滚动区），不可见返回 null */
  private logicalToPhysical(logicalRow: number): number | null {
    const offset = Math.max(0, this.outputRows - this.contentRows)
    const physical = logicalRow - offset
    if (physical >= 1 && physical <= this.contentRows) return physical
    return null
  }

  /** 重绘滚动区当前输出行（最后一行） */
  private updateLastLine(line: string) {
    const row = this.currentRow > 0 ? this.currentRow : 1
    this.cursorTo(row)
    this.clearLine()
    this.write(truncateTo(line, this.cols))
    this.write('\r')
  }

  // === 渲染行生成 ===

  /** 思考面板（1 行）：状态 + 水平滚动尾部摘要（紧凑） */
  private thinkingLines(b: Extract<MsgBlock, { type: 'thinking' }>): string {
    const clean = b.full.replace(/\n/g, ' ')
    const w = Math.max(10, this.cols - 14)
    const tail = tailByWidth(clean, w)
    const ellipsis = [...clean].length > [...tail].length ? '…' : ''
    const stateText = b.done ? '▸ 思考完成' : '▸ 思考中'
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
          for (const l of wrapText(b.text, this.cols)) out.push(`${BOLD}${l}${RESET}`)
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

  /** 重绘滚动区：清屏后从 top 行开始定位写 contentRows 行（不滚动）。clear/resize 用 */
  private rerender(top: number) {
    const lines = this.flattenBlocks()
    const maxTop = Math.max(0, lines.length - this.contentRows)
    top = Math.max(0, Math.min(top, maxTop))

    this.cursorTo(1)
    this.write('\x1b[2J')
    this.setScrollRegion()

    this.currentRow = 0
    this.outputRows = 0
    this.thinkLogicalStart = 0
    for (let i = top; i < Math.min(top + this.contentRows, lines.length); i++) {
      this.currentRow++
      this.outputRows++
      this.cursorTo(this.currentRow)
      this.clearLine()
      this.write(truncateTo(lines[i], this.cols))
    }

    this.renderFixed()
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

  /** 状态栏着色：Ready=绿，思考=黄，工具/回答/排队=青，出错/错误=红，打断=黄 */
  private statusColor(text: string): string {
    if (text.includes('思考')) return '\x1b[33m'
    if (text.includes('工具')) return '\x1b[36m'
    if (text.includes('回答')) return '\x1b[36m'
    if (text.includes('排队')) return '\x1b[36m'
    if (text.includes('出错') || text.includes('错误')) return '\x1b[31m'
    if (text.includes('打断')) return '\x1b[33m'
    return '\x1b[32m'
  }

  private renderFixed() {
    const statusLine = `${this.statusColor(this.status)}● ${this.status}${RESET}`
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
    this.write(`\x1b[${this.cursorCol()}G`)
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
    this.write(`\x1b[${this.cursorCol()}G`)
  }

  setStatus(text: string) {
    if (this.status === text) return
    this.status = text
    this.cursorTo(this.statusRow())
    this.clearLine()
    this.write(`${this.statusColor(text)}● ${text}${RESET}`)
    this.cursorTo(this.inputContentRow())
    this.write(`\x1b[${this.cursorCol()}G`)
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

    const asst = this.blocks[this.blocks.length - 1] as Extract<MsgBlock, { type: 'assistant' }>
    const newLines = wrapText(asst.text, this.cols).map((l) => `${BOLD}${l}${RESET}`)
    if (newLines.length > asst.outputCount) {
      if (asst.outputCount === 0) {
        // 首次输出：直接追加（不能用 updateLastLine——currentRow 此刻指向思考面板行，会覆盖它）
        for (const l of newLines) this.appendLine(l)
      } else {
        this.updateLastLine(newLines[asst.outputCount - 1] ?? '')
        for (let i = asst.outputCount; i < newLines.length; i++) {
          this.appendLine(newLines[i])
        }
      }
      asst.outputCount = newLines.length
    } else if (newLines.length === asst.outputCount) {
      this.updateLastLine(newLines[newLines.length - 1] ?? '')
    }
    this.renderFixed()
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
    this.write(`\x1b[${this.cursorCol()}G`)
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
    this.rerender(0)
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
    if (key.name === 'return') {
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
