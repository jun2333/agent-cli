/**
 * tui.ts — 自研 DECSTBM 渲染层
 *
 * 架构：
 * - Alt Screen 缓冲（\x1b[?1049h）
 * - DECSTBM 滚动区域：内容区 = 1..contentRows，状态栏/输入框/预留区在滚动区外固定
 * - 增量追加输出：内容从滚动区顶部逐行写入，写满后终端自动滚动（产生滚动历史 → 滚轮可用）
 * - 每轮对话自己的思考面板（1 行，在滚动区）：用户消息 → 思考面板 → LLM 回复
 *   思考面板用"逻辑行→物理行"映射精确重绘，不展开/折叠，杜绝行数变化导致的错乱
 * - 输入框**固定高度 5 行**（上边框 + 3 行内容窗口 + 下边框）：多行内容只在窗口内滚动，
 *   contentRows 是常量，不随输入内容行数变化（AC-12 的实质要求）
 *
 * 布局（1-based）：
 *   1..contentRows           滚动区（banner + 每轮：用户消息 + 思考面板 + 回复）
 *   contentRows+1            状态栏（状态 + 当前模型/思考等级）
 *   contentRows+2            输入框上边框
 *   contentRows+3..+5        输入框内容窗口（3 行，随光标自动滚动）
 *   contentRows+6            输入框下边框
 *   contentRows+7..rows      预留区
 *
 * 职责边界：输入缓冲的全部编辑语义（原子删除、跨行光标、折行、折叠）都在
 * `ui/input-buffer.ts` 里（纯逻辑、可单测）；本文件只做两件事——
 * 把 `displayLines()` 画进固定窗口，把按键翻译成缓冲的编辑操作。
 */
import { existsSync } from 'fs'
import { join } from 'path'
import readline from 'readline'
import type { ContentPart } from '../tools/index.js'
import { readClipboardImage, readClipboardText } from '../clipboard.js'
import { editInExternalEditor } from '../editor.js'
import { imageDir, resolveImagePath } from '../images.js'
import { InputBuffer } from './input-buffer.js'
import { Selector, type SelectorItem } from './selector.js'
// 纯文本函数与它们用到的样式常量都在 text.ts（见该文件头注释：避免 input-buffer ↔ tui 循环导入）
import { CODE, RESET, displayWidth, inlineMarkdown, tailByWidth, truncateTo, wrapText } from './text.js'

// 重新导出纯文本函数：既有调用方（selector.ts、tui-format.test.ts 等）从 './tui.js' 导入的行为不变
export { displayWidth, wrapText, truncateTo, tailByWidth, inlineMarkdown } from './text.js'

// === SGR 样式（Select Graphic Rendition：\x1b[<n>m 设置文本样式） ===
// 前景色层次（代码写死，不靠提示词约束；暗 → 亮：思考 < 回答 < 强调）：
const DIM = '\x1b[90m' // 暗灰：思考面板/工具行等辅助文字，最不显眼
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
// Bracketed Paste（\x1b[?2004h/l）：开启后终端把整段粘贴包在 paste-start/paste-end 之间，
// readline 会据此发出对应的 keypress 事件——这是"粘贴里的换行不触发提交"的基础。
const BRACKET_PASTE_ON = '\x1b[?2004h'
const BRACKET_PASTE_OFF = '\x1b[?2004l'

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
  // tool 块有两个来源：addToolLine（单行工具调用，渲染带 `[tool] ` 前缀）与
  // addInfo（多行说明文本，逐行渲染且无前缀）。info 标记区分二者，避免前缀/拆行语义错配。
  | { type: 'tool'; text: string; info?: boolean }
  | { type: 'error'; text: string }

// === 工具函数 ===

/**
 * 按显示宽度把一行切成 [光标前, 光标处字符, 光标后]。
 * 为什么不用字符串下标：`InputBuffer.cursorPosition()` 返回的是**屏幕列**（中文算 2 列），
 * 与 UTF-16 下标不是一回事，必须按宽度走一遍才能找到正确的切分点。
 * 光标在行尾时 `at` 用空格占位（反色块才可见）。
 */
function splitAtWidth(s: string, width: number): { before: string; at: string; after: string } {
  let w = 0
  let i = 0
  while (i < s.length) {
    const cp = s.codePointAt(i)!
    const cw = cp > 0x7f ? 2 : 1
    if (w + cw > width) break
    w += cw
    i += cp > 0xffff ? 2 : 1
  }
  if (i >= s.length) return { before: s, at: ' ', after: '' }
  const cp = s.codePointAt(i)!
  const len = cp > 0xffff ? 2 : 1
  return { before: s.slice(0, i), at: s.slice(i, i + len), after: s.slice(i + len) }
}

/** 用户消息的终端回显文本：多模态内容里图片以 `[image]` 占位（图片本体由模型看到，终端只回显文本） */
function contentToPlainText(c: string | ContentPart[]): string {
  if (typeof c === 'string') return c
  return c.map((p) => (p.type === 'text' ? p.text : '[image]')).join('')
}

/**
 * 从历史消息的 content 里取出可显示文本。
 * 含图消息的 content 是部件数组：文本部件直接拼接，图片部件渲染为占位符
 * （FR-3 要求「恢复时用户消息按占位符文本显示，不内联渲染图片」）。
 * 图片名优先取部件上的非标准 name 字段（运行时注入，见 session.ts 的 image_ref 往返）。
 */
export function historyTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p: any) => {
      if (p?.type === 'text') return typeof p.text === 'string' ? p.text : ''
      if (p?.type === 'image_url') return typeof p.name === 'string' && p.name ? `[image: ${p.name}]` : '[图片]'
      return ''
    })
    .join('')
}

// === TUI ===

const INPUT_ROWS = 5 // 上边框 + 3 行内容窗口 + 下边框（design.md Decision 6，用户已拍板）
const INPUT_CONTENT_ROWS = 3 // 输入内容窗口行数（固定，多行内容在窗口内滚动）
const STATUS_ROWS = 1
const RESERVED_ROWS = 3
/** 输入行前缀 `| > ` / `|   ` 的显示宽度 */
const INPUT_PREFIX_WIDTH = 4

export type TUIHandlers = {
  /** 提交内容：纯文本，或带图片的多模态部件数组（TUI 不解释其语义，原样交给上层） */
  onEnter: (content: string | ContentPart[]) => void
  onExit: () => void
  onInterrupt: () => void
}

/** 打开模态选择器的回调（选择器本身不持有 stdin，键位由 TUI 路由） */
export type SelectorOptions = {
  onPick: (index: number) => void
  onCancel: () => void
  title?: string
}

export class TUI {
  private blocks: MsgBlock[] = []
  private status: StatusKind = 'ready'
  private statusDetail = ''
  /** 状态栏尾部的「模型/思考等级」，由上层注入 */
  private modelInfo = ''
  /** 输入缓冲（原子模型，纯逻辑模块）：多行/粘贴折叠/图片原子都在这里 */
  private buffer = new InputBuffer()
  /** 输入内容窗口的滚动偏移（行号，0-based）：保持光标可见，其余内容滚出窗口 */
  private inputScrollTop = 0
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
  /** 交互模态：input = 正常输入；selector = 全屏选择器接管 */
  private mode: 'input' | 'selector' = 'input'
  private selector: Selector | null = null
  private selectorOptions: SelectorOptions | null = null
  /** bracketed paste 状态：置位期间收到的字符只累积、不触发提交 */
  private pasting = false
  private pasteBuf = ''
  private readonly BANNER: string[]
  private readonly PROMPT = `${GREEN}>${RESET} `
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

    // 开启 bracketed paste：粘贴内容会被 paste-start/paste-end 包住（见 onKeypress）
    process.stdout.write(ALT_SCREEN_ENTER + CURSOR_SHOW + BRACKET_PASTE_ON)
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
    // 关闭 bracketed paste，避免退出后把终端留给下个程序时行为异常
    process.stdout.write(BRACKET_PASTE_OFF + CURSOR_SHOW + ALT_SCREEN_EXIT)
  }

  private syncSize() {
    const c = process.stdout.columns
    const r = process.stdout.rows
    if (c) this.cols = c
    if (r) this.rows = r
    // 计算逻辑不变：输入框固定高度，contentRows 不随输入内容行数变化
    this.contentRows = Math.max(1, this.rows - INPUT_ROWS - STATUS_ROWS - RESERVED_ROWS)
  }

  private onResize() {
    this.syncSize()
    this.setScrollRegion()
    // 选择器接管期间只重绘选择器（它铺满全屏，没有滚动区概念）
    if (this.mode === 'selector') {
      this.renderSelector()
      return
    }
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
    // 选择器接管全屏期间不画滚动区（blocks 仍是唯一真源，关闭时会整体重建）
    if (this.mode === 'selector') return
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
          // 用户输入现在可以含换行：首行带 "You:" 前缀，续行原样缩进，避免把 \n 直接塞进一行
          b.text.split('\n').forEach((l, i) => {
            out.push(i === 0 ? `${GREEN}You${RESET}: ${l}` : l)
          })
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
          // 必须按 \n 拆行：addInfo 塞入的是多行文本，整段当作一个元素 push 时内嵌换行会被
          // truncateTo 原样写出（LF 只下移不回车），全量重绘后呈阶梯状错乱（N-5，与 'error' 同类）。
          if (b.info) {
            // addInfo：逐行、无前缀、跳过空行 —— 与 addInfo 的增量 appendLine 写法一致
            for (const l of b.text.split('\n')) {
              if (l.trim()) out.push(`${DIM}${l}${RESET}`)
            }
          } else {
            // addToolLine：单行带 `[tool] ` 前缀（多行时逐行加，避免内嵌换行破坏排版）
            for (const l of b.text.split('\n')) out.push(`${DIM}[tool] ${l}${RESET}`)
          }
          break
        case 'error':
          // 错误消息可能很长且含可操作建议（如截断提示里的 /model、OLLAMA_CONTEXT_LENGTH）。
          // 必须按列宽折行，否则 appendLine/truncateTo 会把后半段（最有用的部分）整段截掉。
          for (const l of wrapText(b.text, this.cols)) out.push(`${RED}${l}${RESET}`)
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
    // 选择器接管全屏期间不重绘滚动区；closeSelector 会先切回 input 再调用本方法重建
    if (this.mode === 'selector') return
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
    if (this.mode === 'selector') return
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
  /** 输入内容窗口第 i 行（i = 0..INPUT_CONTENT_ROWS-1） */
  private inputContentRow(i: number): number {
    return this.contentRows + 3 + i
  }
  private inputBotRow(): number {
    return this.contentRows + 2 + INPUT_ROWS - 1
  }
  /** 预留区起始行（输入框下边框的下一行） */
  private reservedFrom(): number {
    return this.contentRows + 2 + INPUT_ROWS
  }

  /** 输入行可用的文本列宽（扣掉前缀 4 列 + 1 列余量，避免行尾触发终端换行） */
  private inputTextCols(): number {
    return Math.max(1, this.cols - INPUT_PREFIX_WIDTH - 2)
  }

  /**
   * 计算输入窗口：折行结果 + 光标位置，并同步滚动偏移（保持光标可见）。
   * 滚动策略：光标在窗口上方越界 → 窗口上移到光标行；在下方越界 → 窗口下移刚好露出光标。
   */
  private inputWindow() {
    const textCols = this.inputTextCols()
    const lines = this.buffer.displayLines(textCols)
    const pos = this.buffer.cursorPosition(textCols)

    if (pos.line < this.inputScrollTop) this.inputScrollTop = pos.line
    else if (pos.line >= this.inputScrollTop + INPUT_CONTENT_ROWS) {
      this.inputScrollTop = pos.line - INPUT_CONTENT_ROWS + 1
    }
    const maxTop = Math.max(0, lines.length - INPUT_CONTENT_ROWS)
    this.inputScrollTop = Math.max(0, Math.min(this.inputScrollTop, maxTop))

    return { textCols, lines, pos }
  }

  /** 输入窗口 3 行的绘制文本（光标所在行用反色标记光标处字符） */
  private inputLineTexts(): string[] {
    const { textCols, lines, pos } = this.inputWindow()
    const out: string[] = []
    for (let i = 0; i < INPUT_CONTENT_ROWS; i++) {
      const idx = this.inputScrollTop + i
      // 前缀等宽（4 列）：首逻辑行显示提示符，续行留白，保证列对齐
      const prefix = `| ${idx === 0 ? this.PROMPT : '  '}`
      const dl = lines[idx]
      if (!dl) {
        out.push(prefix)
        continue
      }
      let raw = dl.text
      if (idx === pos.line) {
        const { before, at, after } = splitAtWidth(dl.text, pos.col)
        raw = `${before}${INVERSE}${at}${RESET}${after}`
      }
      // 截断到可用列宽（I-4）：原子占位符（如 `[image: 20260916-112233-123.png]`）比输入窗口宽时
      // 会被 displayLines 整行保留，窄终端下会让该物理行自动换行、撑破固定 5 行布局。
      const clipped = truncateTo(raw, textCols)
      // 截断可能把光标行的 RESET 切掉（反色溢出到行尾）→ 被截断时补一次复位
      out.push(clipped.length < raw.length ? `${prefix}${clipped}${RESET}` : `${prefix}${clipped}`)
    }
    return out
  }

  /** 光标应停的物理行与列（1-based） */
  private inputCursorPos(): { row: number; col: number } {
    const { textCols, pos } = this.inputWindow()
    const i = Math.max(0, Math.min(INPUT_CONTENT_ROWS - 1, pos.line - this.inputScrollTop))
    // 前缀 4 列 → 文本从第 5 列开始
    return { row: this.inputContentRow(i), col: 1 + INPUT_PREFIX_WIDTH + Math.min(pos.col, textCols) }
  }

  /** 把终端光标放回输入框内的编辑位置（选择器接管期间不做） */
  private positionInputCursor() {
    if (this.mode === 'selector') return
    const { row, col } = this.inputCursorPos()
    this.cursorTo(row)
    this.write(CHA(col))
  }

  /** 状态栏完整文本（含颜色）；尾部追加「模型/等级」，超长时截断模型部分而不挤掉状态文本 */
  private statusLineText(): string {
    const s = STATUS_STYLE[this.status]
    const text = this.statusDetail ? `${s.text} ${this.statusDetail}` : s.text
    const head = `${s.color}● ${text}${RESET}`
    if (!this.modelInfo) return head
    const sep = ' · '
    const avail = this.cols - displayWidth(`● ${text}`) - displayWidth(sep)
    if (avail <= 0) return head
    return `${head}${DIM}${sep}${truncateTo(this.modelInfo, avail)}${RESET}`
  }

  private renderStatus() {
    this.cursorTo(this.statusRow())
    this.clearLine()
    this.write(this.statusLineText())
  }

  private renderFixed() {
    if (this.mode === 'selector') return
    const topBorder = `${DIM}+-- input ${'-'.repeat(Math.max(0, this.cols - 11))}+${RESET}`
    const botBorder = `${DIM}+${'-'.repeat(this.cols - 2)}+${RESET}`

    this.renderStatus()

    this.cursorTo(this.inputTopRow())
    this.clearLine()
    this.write(topBorder)

    const texts = this.inputLineTexts()
    for (let i = 0; i < INPUT_CONTENT_ROWS; i++) {
      this.cursorTo(this.inputContentRow(i))
      this.clearLine()
      this.write(texts[i])
    }

    this.cursorTo(this.inputBotRow())
    this.clearLine()
    this.write(botBorder)

    for (let i = this.reservedFrom(); i <= this.rows; i++) {
      this.cursorTo(i)
      this.clearLine()
    }

    this.positionInputCursor()
  }

  /** 只重绘输入框（每次按键调用，避免整屏重绘） */
  private renderInput() {
    if (this.mode === 'selector') return
    const topBorder = `${DIM}+-- input ${'-'.repeat(Math.max(0, this.cols - 11))}+${RESET}`
    const botBorder = `${DIM}+${'-'.repeat(this.cols - 2)}+${RESET}`

    this.cursorTo(this.inputTopRow())
    this.clearLine()
    this.write(topBorder)

    const texts = this.inputLineTexts()
    for (let i = 0; i < INPUT_CONTENT_ROWS; i++) {
      this.cursorTo(this.inputContentRow(i))
      this.clearLine()
      this.write(texts[i])
    }

    this.cursorTo(this.inputBotRow())
    this.clearLine()
    this.write(botBorder)

    this.positionInputCursor()
  }

  setStatus(kind: StatusKind, detail?: string) {
    if (this.status === kind && this.statusDetail === (detail ?? '')) return
    this.status = kind
    this.statusDetail = detail ?? ''
    this.renderStatus()
    this.positionInputCursor()
  }

  /** 注入状态栏尾部的「当前模型/思考等级」（如 `qwen3-vl:8b-thinking/low`）；level 省略时只显示模型名 */
  setModelInfo(model: string, level?: string) {
    const info = level ? `${model}/${level}` : model
    if (this.modelInfo === info) return
    this.modelInfo = info
    this.renderStatus()
    this.positionInputCursor()
  }

  // === 模态选择器 ===

  /**
   * 打开全屏模态选择器。接管期间所有按键都路由给选择器（不进入输入缓冲），
   * 结束时从 blocks 完整重建界面（rerender(0, true)），无需重设终端状态。
   */
  openSelector(items: SelectorItem[], opts: SelectorOptions) {
    this.selector = new Selector(items, opts.title ?? 'Select')
    this.selectorOptions = opts
    this.mode = 'selector'
    this.renderSelector()
  }

  private renderSelector() {
    const sel = this.selector
    if (!sel) return
    const lines = sel.render(this.cols, this.rows)
    this.write(ERASE_DISPLAY)
    for (let i = 0; i < lines.length; i++) {
      this.cursorTo(i + 1)
      this.write(truncateTo(lines[i], this.cols))
    }
    // 光标停在选中项那一行，视觉焦点与选择一致
    this.cursorTo(sel.cursorLine(this.rows) + 1)
  }

  /** 关闭选择器并完整重建界面（blocks 是唯一真源，无需手工恢复各区域） */
  private closeSelector() {
    this.mode = 'input'
    this.selector = null
    this.rerender(0, true)
  }

  private onSelectorKey(str: string, key: any) {
    const sel = this.selector
    const opts = this.selectorOptions
    if (!sel || !opts) return
    const r = sel.handleKey(str, key)
    if (r === 'consumed') {
      this.renderSelector()
      return
    }
    // 先关闭（恢复界面）再回调：回调里可能立刻打开下一个选择器（如模型 → 等级）
    this.closeSelector()
    this.selectorOptions = null
    if ('cancelled' in r) opts.onCancel()
    else opts.onPick(r.picked)
  }

  // === 业务方法 ===

  addUserMessage(content: string | ContentPart[]) {
    const text = contentToPlainText(content)
    this.blocks.push({ type: 'user', text })
    // 多行输入：首行带前缀，续行独立成行（与 flattenBlocks 的渲染保持一致）
    text.split('\n').forEach((l, i) => {
      this.appendLine(i === 0 ? `${GREEN}You${RESET}: ${l}` : l)
    })
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
    this.positionInputCursor()
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
    this.blocks.push({ type: 'tool', text, info: true })
    for (const l of text.split('\n')) {
      if (l.trim()) this.appendLine(`${DIM}${l}${RESET}`)
    }
    this.renderFixed()
  }

  showError(msg: string) {
    this.blocks.push({ type: 'error', text: msg })
    // 逐行折行写入：长错误消息不能只写一行（appendLine 会 truncateTo 掉后半段）
    for (const l of wrapText(msg, this.cols)) this.appendLine(`${RED}${l}${RESET}`)
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
        // 含图消息的 content 是部件数组，用 historyTextOf 取占位符文本（不内联渲染图片）
        const text = historyTextOf(item.content)
        if (text) this.blocks.push({ type: 'user', text })
      } else if (item.role === 'assistant' && typeof item.content === 'string') {
        this.blocks.push({ type: 'assistant', text: item.content, outputCount: 0 })
      }
    }
    this.rerenderToBottom()
  }

  /**
   * 把内容重新装回输入缓冲（入口编排在**能力预检失败**等场景回填用户原内容，避免丢输入）。
   *
   * **只在缓冲为空时回填**，返回是否真的回填：true = 已装入；false = 缓冲非空、原样保留。
   * 为什么不是无条件覆盖：调用方的 `await getCapabilities()` 未命中缓存时最长 5s
   * （models.ts 的 `AbortSignal.timeout(5000)`，且失败不写缓存），这期间用户可能已在输入新内容，
   * 无条件 `buffer.clear()` 会把它整段抹掉（N-4①）。取舍是明确的：宁可丢掉"要回填的原内容"，
   * 也不能吞掉用户正在打的新输入。也不做"总是追加"——追加会让两次内容粘连，语义不可预测。
   *
   * - 纯文本：整体作为文本装入；
   * - 部件数组：text 部件拼接为文本，image_url 部件用其**非标准** `name`/`path` 字段还原为图片原子
   *   （这两个字段由 `InputBuffer.toMessageContent` 注入，data URL 无法反推路径）；
   * - 缺 name/path 的图片部件无法还原路径，退化为 `[图片]` 文本，至少不静默丢内容。
   * 用 insertText 而非 insertPaste：回填的内容应当完整可见可编辑，不折叠成占位符。
   */
  restoreInput(content: string | ContentPart[]): boolean {
    if (!this.buffer.isEmpty) return false
    if (typeof content === 'string') {
      this.buffer.insertText(content)
    } else {
      for (const p of content) {
        if (p.type === 'text') {
          this.buffer.insertText(p.text)
          continue
        }
        const img = p as { name?: unknown; path?: unknown }
        const name = typeof img.name === 'string' ? img.name : ''
        const path = typeof img.path === 'string' ? img.path : ''
        if (name && path) this.buffer.insertImage(name, path)
        else this.buffer.insertText(name ? `[image: ${name}]` : '[图片]')
      }
    }
    this.inputScrollTop = 0
    this.renderInput()
    return true
  }

  // === 键盘 ===

  private onKeypress(str: string, key: any) {
    if (!key) return
    const h = this.handlers
    if (!h) return

    // bracketed paste 边界事件：置位/复位，期间内容只累积（不提交）。
    // ⚠️ 必须排在 Ctrl+C 退出与选择器路由**之前**（见下方 pasting 守卫的说明）。
    if (key.name === 'paste-start') {
      this.pasting = true
      this.pasteBuf = ''
      return
    }
    if (key.name === 'paste-end') {
      this.pasting = false
      const pasted = this.pasteBuf
      this.pasteBuf = ''
      // 选择器接管期间整段丢弃：既不路由给选择器、也不污染输入缓冲（N-2）
      if (this.mode === 'selector') return
      if (pasted) {
        // 统一在 paste-end 做折叠判定：无论 readline 是一次性给整段还是逐字符给，
        // 折叠阈值（>3 行 / >200 字符）都能正确生效
        this.buffer.insertPaste(pasted)
        this.renderInput()
      }
      return
    }

    // 粘贴期间：一切按键只累积到 pasteBuf，绝不触发换行 / 命令 / 提交 / 退出。
    // ⚠️ 必须排在 Ctrl+C 与选择器路由**之前**：
    // - Ctrl+C（N-3）：真实 readline 把粘贴里的裸 0x03 报成 {name:'c',ctrl:true}，若先命中
    //   全局退出分支会直接退出程序且内容丢失；粘贴期间它只是数据，按字面累积。
    //   非粘贴期间 Ctrl+C 的全局退出语义完全不变（该通道是刻意保留的）。
    // - 选择器（N-2）：粘贴内容若被当普通按键路由给选择器，其中的 \r 会确认选中项
    //   （实测误切模型）并把剩余内容当消息提交。
    // ⚠️ 也必须排在 Ctrl+J / Alt+Enter / Enter 等分支**之前**：真实 readline 把粘贴中的
    // \n 报成 name='enter' + sequence='\n'，若先命中 Ctrl+J 分支，换行会被插到
    // pasteBuf 内容之前（缓冲区变成 "\n\nl0l1l2"），提交时又被 trim 掉前导换行，
    // 导致多行粘贴的换行全部丢失（用真实事件形状复现确认）。
    if (this.pasting) {
      if (str) this.pasteBuf += str
      return
    }

    // Ctrl+C 是全局退出，模态期间也保留（否则选择器里无法退出程序）
    if (key.ctrl && key.name === 'c') {
      h.onExit()
      return
    }

    // 选择器接管：按键全部路由给选择器，不进入输入缓冲
    if (this.mode === 'selector') {
      this.onSelectorKey(str, key)
      return
    }

    if (key.name === 'escape') {
      h.onInterrupt()
      return
    }

    // ↑/↓：先尝试在输入内容的多行之间移动；只有移动不了（单行）才切历史
    if (key.name === 'up') {
      if (!this.buffer.moveLineUp()) this.historyUp()
      this.renderInput()
      return
    }
    if (key.name === 'down') {
      if (!this.buffer.moveLineDown()) this.historyDown()
      this.renderInput()
      return
    }
    if (key.name === 'left') {
      this.buffer.moveLeft()
      this.renderInput()
      return
    }
    if (key.name === 'right') {
      this.buffer.moveRight()
      this.renderInput()
      return
    }
    if (key.name === 'backspace') {
      this.buffer.backspace()
      this.renderInput()
      return
    }

    // Ctrl+V：剪贴板贴图（无图则退化为文本粘贴）
    if (key.ctrl && key.name === 'v') {
      void this.pasteFromClipboard()
      return
    }
    // Ctrl+G：在外部编辑器里撰写提示词
    if (key.ctrl && key.name === 'g') {
      void this.editInEditor()
      return
    }

    // Alt+Enter：插入换行（\x1b\r，无歧义）
    if (key.name === 'return' && key.meta) {
      this.buffer.insertText('\n')
      this.renderInput()
      return
    }
    // Ctrl+J：readline 把 LF 报成 name='enter' + sequence='\n'（与 Enter 的 \r 区分开）
    if (key.name === 'enter' && key.sequence === '\n') {
      this.buffer.insertText('\n')
      this.renderInput()
      return
    }

    if (key.name === 'return' || key.name === 'enter') {
      const v = this.submit()
      if (v) h.onEnter(v)
      return
    }

    if (str) {
      for (const ch of str) {
        if (ch === '\r' || ch === '\n') {
          const v = this.submit()
          if (v) h.onEnter(v)
        } else {
          this.buffer.insertText(ch)
          this.renderInput()
        }
      }
    }
  }

  /** Ctrl+V：取剪贴板图片进缓冲；无图退化为文本粘贴；工具不可用则提示 */
  private async pasteFromClipboard() {
    const r = await readClipboardImage()
    if (r.ok) {
      this.buffer.insertImage(r.name, r.path)
      this.renderInput()
      return
    }
    if (r.reason === 'no-image') {
      const text = await readClipboardText()
      if (text) {
        this.buffer.insertPaste(text)
        this.renderInput()
      }
      return
    }
    // failed：取图过程出错（超时 / Automation 权限被拒 / 剪贴板内容类型不支持等），
    // 与「剪贴板本来就没图」不同，不能静默退化——必须让用户看到并知道可以怎么办。
    if (r.reason === 'failed') {
      this.addInfo('剪贴板取图失败（可能是权限、超时或剪贴板内容类型不支持）。可重试，或改用图片路径让 agent 读取。')
      return
    }
    this.addInfo('剪贴板取图不可用：未找到 pngpaste 与 osascript。')
  }

  /** Ctrl+G：把当前输入交给外部编辑器；ok 按占位符重建缓冲（保留图片原子），cancel 保持原样，error 提示 */
  private async editInEditor() {
    // 编辑器里只有纯文本，图片原子以 `[image: <name>]` 占位符形式往返。
    // 先缓存「名字 → 路径」映射，回填时按占位符还原成图片原子，避免保存后静默丢附件（W-5）；
    // 用户若在编辑器里删掉占位符，图片随之丢弃（语义自然）。
    const images = new Map(this.buffer.imageAtoms().map((a) => [a.name, a.path]))
    const r = await editInExternalEditor(this.buffer.toText())
    if (r.ok) {
      this.buffer.loadFromText(r.content, (name) => {
        const cached = images.get(name)
        if (cached) return { name, path: cached }
        // 用户手写的占位符：必须同时过「路径白名单（含软链二次校验）」且文件真实存在。
        // ⚠️ 不能只做 join(imageDir(), name) + existsSync：name 由用户在编辑器里手打，可含 `..`
        // （实测 `[image: ../../../../etc/passwd]` 会把 /etc/passwd 当图片读进消息，绕过白名单）。
        // 复用 images.resolveImagePath —— 与 view_image / Ctrl+V 同一安全边界，不另写一套判断。
        const resolved = resolveImagePath(join(imageDir(), name))
        return resolved.ok && existsSync(resolved.abs) ? { name, path: resolved.abs } : null
      })
      this.inputScrollTop = 0
      this.renderInput()
      return
    }
    if (r.reason === 'error') {
      this.addInfo(`编辑器不可用：${r.error ?? '未知错误'}`)
    }
  }

  private historyUp() {
    if (this.history.length === 0) return
    if (this.historyIdx > 0) this.historyIdx--
    this.setInputText(this.history[this.historyIdx])
    this.renderInput()
  }

  private historyDown() {
    if (this.historyIdx < this.history.length) this.historyIdx++
    if (this.historyIdx >= this.history.length) this.setInputText('')
    else this.setInputText(this.history[this.historyIdx])
    this.renderInput()
  }

  /** 用纯文本整体替换输入缓冲（历史切换用），并重置滚动窗口 */
  private setInputText(s: string) {
    this.buffer.clear()
    if (s) this.buffer.insertText(s)
    this.inputScrollTop = 0
  }

  /**
   * 提交：清空缓冲并返回消息内容。
   * - 纯文本：返回 trim 后的字符串（保持既有行为——`/exit` 等命令带首尾空格也能识别）；
   * - 含图片：返回 ContentPart[]（原文不 trim，避免破坏图片与文本的相对位置）；
   * - 空输入（无图且全空白）：返回 null，调用方不触发提交。
   */
  private submit(): string | ContentPart[] | null {
    const content = this.buffer.toMessageContent()
    if (typeof content === 'string' && !content.trim()) {
      this.buffer.clear()
      this.renderInput()
      return null
    }

    const text = this.buffer.toText().trim()
    if (text) {
      this.history.push(text)
      this.historyIdx = this.history.length
    }
    this.buffer.clear()
    this.inputScrollTop = 0
    this.renderInput()
    return typeof content === 'string' ? content.trim() : content
  }
}
