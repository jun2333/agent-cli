/**
 * term-sim.ts — ANSI 终端模拟器（测试基础设施）
 *
 * 用于在进程内驱动 TUI 并验证其"终端画面"：
 * - 解析 CSI 序列（光标定位、erase、DECSTBM 滚动区、清屏/清历史）
 * - 维护屏幕字符矩阵 + 滚动历史（scrollback），支持 resize 扩展
 * - 覆盖宽字符（中文按 2 列）、wrap-pending、滚动区滚动
 *
 * 这是本项目 TUI 端到端/集成测试的基础：把 TUI 的 stdout 喂给它，
 * 再用 dump()/visible()/historyText() 断言最终屏幕与滚动历史。
 */
export class TermSim {
  rows: number
  cols: number
  screen: string[][]
  scrollback: string[][] = []
  scrollCount = 0
  cursorRow = 0
  cursorCol = 0
  scrollTop = 0
  scrollBottom: number
  wrapPending = false

  constructor(rows: number, cols: number) {
    this.rows = rows
    this.cols = cols
    this.scrollBottom = rows - 1
    this.screen = Array.from({ length: rows }, () => Array(cols).fill(' '))
  }

  /** 模拟终端收到一段输出字节 */
  write(s: string) {
    let i = 0
    while (i < s.length) {
      const ch = s[i]
      if (ch === '\x1b') {
        const esc = s[i + 1]
        if (esc === '[') {
          let j = i + 2
          let p = ''
          while (j < s.length && !/[A-Za-z@`]/.test(s[j])) p += s[j++]
          this.csi(p, s[j])
          i = j + 1
        } else i += 2
      } else if (ch === '\r') {
        this.wrapPending = false
        this.cursorCol = 0
        i++
      } else if (ch === '\n') {
        this.newline()
        i++
      } else {
        this.putChar(ch)
        i++
      }
    }
  }

  /** 模拟真实终端 resize：扩展/收缩屏幕行数（在触发 onResize 之前调用） */
  resize(rows: number) {
    if (rows > this.rows) {
      for (let i = 0; i < rows - this.rows; i++) this.screen.push(Array(this.cols).fill(' '))
    } else if (rows < this.rows) {
      this.screen = this.screen.slice(0, rows)
    }
    this.rows = rows
    this.scrollBottom = rows - 1
  }

  private csi(p: string, f: string) {
    const a = p.split(';').map((x) => parseInt(x || '1', 10))
    switch (f) {
      case 'H': // CUP：光标定位
        this.cursorRow = Math.min(this.rows - 1, a[0] - 1)
        this.cursorCol = Math.min(this.cols - 1, a[1] - 1)
        this.wrapPending = false
        break
      case 'G': // CHA：列定位
        this.cursorCol = Math.min(this.cols - 1, a[0] - 1)
        this.wrapPending = false
        break
      case 'K': // EL：从光标擦到行尾
        for (let c = this.cursorCol; c < this.cols; c++) this.screen[this.cursorRow][c] = ' '
        break
      case 'J': // ED：清屏（2）或清滚动历史（3）
        if (a[0] === 2) {
          for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) this.screen[r][c] = ' '
        } else if (a[0] === 3) {
          this.scrollback = []
        }
        break
      case 'r': // DECSTBM：设置滚动区
        this.scrollTop = a[0] - 1
        this.scrollBottom = a[1] - 1
        break
      // 'm'（SGR）、'h'/'l'（模式）等不影响布局，忽略
    }
  }

  private newline() {
    this.wrapPending = false
    if (this.cursorRow === this.scrollBottom) {
      // 滚动区上移，顶部行进入滚动历史
      this.scrollback.push(this.screen[this.scrollTop].slice())
      for (let r = this.scrollTop; r < this.scrollBottom; r++) this.screen[r] = this.screen[r + 1].slice()
      this.screen[this.scrollBottom] = Array(this.cols).fill(' ')
      this.scrollCount++
    } else {
      this.cursorRow++
    }
  }

  private putChar(ch: string) {
    if (this.wrapPending) {
      this.wrapPending = false
      this.newline()
    }
    const w = ch.codePointAt(0)! > 0x7f ? 2 : 1
    this.screen[this.cursorRow][this.cursorCol] = ch
    // 宽字符占两列：第二列用 \u0000 占位（输出时去掉，避免 join 产生假空格）
    if (w === 2 && this.cursorCol + 1 < this.cols) {
      this.screen[this.cursorRow][this.cursorCol + 1] = '\u0000'
    }
    this.cursorCol += w
    if (this.cursorCol >= this.cols) {
      this.cursorCol = this.cols - 1
      this.wrapPending = true
    }
  }

  /** 行内文本：去掉宽字符占位符与行尾空白 */
  private lineText(row: string[]): string {
    return row.join('').replace(/\u0000/g, '').replace(/\s+$/, '')
  }

  /** 整个屏幕的文本行（含空行保留，尾部空白去除） */
  dump(): string[] {
    return this.screen.map((r) => this.lineText(r))
  }

  /** 滚动区可见内容（row1..scrollBottom，不含固定区） */
  visible(): string[] {
    return this.screen.slice(0, this.scrollBottom + 1).map((r) => this.lineText(r))
  }

  /** 滚动历史（被推出屏幕的旧行） */
  historyText(): string[] {
    return this.scrollback.map((r) => this.lineText(r))
  }

  /** 指定行（1-based）的文本 */
  row(row: number): string {
    return this.screen[row - 1] ? this.lineText(this.screen[row - 1]) : ''
  }

  /** 屏幕中是否包含指定文本（去除 ANSI 后） */
  contains(text: string): boolean {
    return this.dump().some((l) => l.includes(text))
  }
}
