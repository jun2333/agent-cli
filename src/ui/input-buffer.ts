/**
 * input-buffer.ts — 输入框缓冲的纯逻辑模型（原子模型，design.md §接口设计 3）
 *
 * 为什么用「原子数组」而不是一个字符串（design.md Decision 1）：
 * - 需求要求粘贴/图片占位符「backspace 一次整体删除」，字符串模型必须靠扫描标记实现原子性，脆弱且难测；
 *   原子数组让原子性由数据结构天然保证（占位符是独立元素，不可被拆开）。
 * - 需求要求图片在消息 content 数组中的位置与占位符在文本中的位置一致，按原子顺序遍历即可保证。
 *
 * 本模块不碰 process.stdin/stdout，也不持有终端状态：折行、光标定位、跨行移动全是可单测的纯计算。
 *
 * 两个易错点（改动前务必先读）：
 * 1. **折行边界的光标归属**：光标是 (原子, 偏移) 表示的「字符之间」位置，折行处「上一行行尾」与
 *    「下一行行首」是同一个位置。本实现统一归属**上一行行尾**（cursorPosition 返回上一行、列为该行宽度）。
 *    这样 ← 从续行首字符回到上一行行尾是可见移动，且 ↑/↓ 能稳定往返；若归属下一行行首，
 *    ↓ 落在折行边界时会「看起来没动」（同一位置又落回下一行行首）。
 * 2. **折行与光标定位必须共用一套算法**：displayLines 折行时同步记录每个光标落在哪一行哪一列，
 *    否则「按宽度折行」与「按字符数算列」两套算法必然对不齐。中文按 2 列宽（复用 text.displayWidth）。
 */
import { imageToDataUrl } from '../images.js'
import type { ContentPart } from '../tools/index.js'
import { displayWidth } from './text.js'

/** 输入缓冲的原子单元：占位符不可被逐字符拆分 */
export type InputAtom =
  | { kind: 'text'; value: string } // 可含 \n
  | { kind: 'paste'; full: string; lines: number } // 超阈值折叠的粘贴
  | { kind: 'image'; name: string; path: string } // Ctrl+V 直投的图片

/** 光标：定位到第 atom 个原子的第 offset 个字符（offset 仅对 text 有意义） */
export type Cursor = { atom: number; offset: number }

/** 渲染行（供 TUI 绘制 + 上下移动定位） */
export type DisplayLine = {
  text: string
  start: Cursor
  /** 该行内容之后的光标（独占）；折行处它与下一行 start 相同（见文件头易错点 1） */
  end: Cursor
  /** 该行起始光标对应的屏幕列（折行后每行都从第 0 列开始，故为 0；供 TUI 加行前缀时做基准） */
  col: number
}

// 折叠阈值：超过任一项即折叠为单个 paste 原子。
// 行阈值取 3（用户反馈：20 行太大，贴 4 行就该收起来）；
// 字符阈值取 200（与"固定 3 行可见窗口"匹配——80 列下 3 行约 240 字符，
// 单行长文本换行折行后同样会撑破窗口，故也要按字符数挡）。
// 字符按**码点**计（见 insertPaste：与 atomDisplayText 的「[粘贴 N 字符]」同口径）。
export const PASTE_FOLD_LINES = 3
export const PASTE_FOLD_CHARS = 200

/**
 * 统计行数：同时认 \n、\r\n 与**单独的 \r**（旧 Mac 行尾 / 部分应用复制出的内容只有 \r）。
 * 只按 \n 切会把这类内容算成 1 行，从而显示成误导性的「[粘贴 1 行]」（真实用户反馈）。
 */
export function countLines(s: string): number {
  if (!s) return 1
  return s.split(/\r\n|\r|\n/).length
}

/** 图片读取失败时的降级文本（与 session.hydrateImages 的标记保持一致） */
function missingImageText(name: string): string {
  return `[图片已失效: ${name || '未知图片'}]`
}

/**
 * 占位符显示文本（渲染用）：
 * - paste 多行 → [粘贴 N 行]；paste 单行（按字符数折叠的）→ [粘贴 N 字符]
 *   否则单行长文本会显示成误导性的「[粘贴 1 行]」
 * - image → [image: 文件名]
 */
function atomDisplayText(a: InputAtom): string {
  if (a.kind === 'paste') {
    return a.lines > 1 ? `[粘贴 ${a.lines} 行]` : `[粘贴 ${[...a.full].length} 字符]`
  }
  if (a.kind === 'image') return `[image: ${a.name}]`
  return a.value
}

/** 纯文本形式（提交/历史用）：paste 展开为完整原文，image 只能降级为占位符文本 */
function atomPlainText(a: InputAtom): string {
  if (a.kind === 'paste') return a.full
  if (a.kind === 'image') return `[image: ${a.name}]`
  return a.value
}

/** 折行的最小单元：char 可拆分；atom 不可拆分（整体换行）；hardBreak 强制断行且不占宽度 */
type Piece = {
  text: string
  start: Cursor
  /** 片段消费完后的光标；hardBreak 不消费光标，为 null */
  end: Cursor | null
  atomic: boolean
  hardBreak: boolean
  width: number
}

/** 光标 key（Map 的键）：Cursor 是对象，用 `atom:offset` 字符串做等价判断 */
function cursorKey(c: Cursor): string {
  return `${c.atom}:${c.offset}`
}

/**
 * 图片部件：标准 image_url 之外附带 path/name（**非标准字段**）。
 * data URL 无法反推文件路径，而写盘时要换成 image_ref，故定位信息必须随部件带出。
 * 单独命名是为了绕开 TS 对「新鲜对象字面量」的多余属性检查（ContentPart 里没有这两个字段）。
 */
type ImageContentPart = { type: 'image_url'; image_url: { url: string }; path: string; name: string }

type CursorPositions = Map<string, { line: number; col: number }>

type Render = {
  cols: number
  lines: DisplayLine[]
  /** 每行的片段（上下移动时按列反查光标用） */
  linePieces: Piece[][]
  /** 光标位置索引：光标 key → 落在第几行第几列（先记录者优先，见易错点 1） */
  positions: CursorPositions
}

/** 在一行的片段里找「最接近目标列」的光标（上下移动时对齐列）：列落在片段内取片段起点，超出取行尾 */
function cursorAtColumn(pieces: Piece[], target: number): Cursor {
  let acc = 0
  let last: Cursor | null = null
  for (const p of pieces) {
    if (p.hardBreak) continue
    if (target < acc + p.width) return p.start
    acc += p.width
    last = p.end ?? p.start
  }
  return last ?? { atom: 0, offset: 0 }
}

export class InputBuffer {
  private atoms: InputAtom[] = []
  private cursor: Cursor = { atom: 0, offset: 0 }
  /** 最近一次渲染用的列宽：moveLineUp/Down 无 cols 入参，沿用 TUI 每帧渲染时的列宽 */
  private lastCols = 80
  private cache: Render | null = null

  get isEmpty(): boolean {
    return this.atoms.length === 0
  }

  clear(): void {
    this.atoms = []
    this.cursor = { atom: 0, offset: 0 }
    this.cache = null
  }

  insertText(s: string): void {
    if (!s) return
    const { atom, offset } = this.cursor
    const cur = this.atoms[atom]
    if (cur && cur.kind === 'text') {
      // 光标在 text 原子内（含末尾）→ 直接并入，避免出现相邻 text 原子
      cur.value = cur.value.slice(0, offset) + s + cur.value.slice(offset)
      this.cursor = { atom, offset: offset + s.length }
      this.cache = null
      return
    }
    this.atoms.splice(atom, 0, { kind: 'text', value: s })
    this.cursor = { atom, offset: s.length }
    this.cache = null
    this.normalize()
  }

  /** 粘贴入口：超阈值（>3 行 或 >200 字符，任一超限）折叠为 paste 原子，否则等同 insertText */
  insertPaste(s: string): void {
    if (!s) return
    const lines = countLines(s)
    // 字符阈值按**码点数**统计，与 atomDisplayText 的「[粘贴 N 字符]」口径一致（N-7）：
    // 用 s.length（UTF-16 码元）会把 emoji 等代理对算成 2，出现「已折叠但显示字符数 < 200」的自相矛盾。
    if (lines > PASTE_FOLD_LINES || [...s].length > PASTE_FOLD_CHARS) {
      const at = this.splitTextAtom()
      this.atoms.splice(at, 0, { kind: 'paste', full: s, lines })
      this.cursor = { atom: at + 1, offset: 0 }
      this.cache = null
      return
    }
    this.insertText(s)
  }

  insertImage(name: string, path: string): void {
    const at = this.splitTextAtom()
    this.atoms.splice(at, 0, { kind: 'image', name, path })
    this.cursor = { atom: at + 1, offset: 0 }
    this.cache = null
  }

  /**
   * 当前全部 image 原子的快照（Ctrl+G 进编辑器前缓存「名字 → 路径」用）。
   * 返回新数组 + 新对象，调用方改它不影响缓冲内部状态。
   */
  imageAtoms(): ReadonlyArray<{ name: string; path: string }> {
    return this.atoms
      .filter((a): a is Extract<InputAtom, { kind: 'image' }> => a.kind === 'image')
      .map((a) => ({ name: a.name, path: a.path }))
  }

  /**
   * 按文本重建缓冲（Ctrl+G 从编辑器回填用）：先清空，再把 `[image: <name>]` 解析回 image 原子，
   * 其余按 text 原子插入。
   *
   * 路径解析必须靠注入的 `resolveImage`（本模块保持纯逻辑、不引 fs）：回调返回 null 时
   * 保留字面量文本——用户若在编辑器里删掉占位符，图片也随之丢弃（语义自然）。
   * 用 insertText 而非 insertPaste：编辑器里刚写的内容应完整可见可编辑，不折叠成占位符。
   */
  loadFromText(text: string, resolveImage?: (name: string) => { name: string; path: string } | null): void {
    this.clear()
    const re = /\[image: ([^\]]+)\]/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) this.insertText(text.slice(last, m.index))
      const resolved = resolveImage?.(m[1]) ?? null
      if (resolved) this.insertImage(resolved.name, resolved.path)
      else this.insertText(m[0]) // 解析不到路径 → 当作普通文本保留
      last = m.index + m[0].length
    }
    if (last < text.length) this.insertText(text.slice(last))
  }

  /** 原子删除：paste/image 原子整体删除；text 原子删一个字符 */
  backspace(): void {
    const { atom, offset } = this.cursor
    const cur = this.atoms[atom]
    if (cur && cur.kind === 'text' && offset > 0) {
      cur.value = cur.value.slice(0, offset - 1) + cur.value.slice(offset)
      this.cursor = { atom, offset: offset - 1 }
      this.cache = null
      this.normalize() // 删空后可能出现空 text 原子
      return
    }
    if (atom > 0) {
      const prev = this.atoms[atom - 1]
      if (prev.kind === 'text') {
        // 光标停在 text 原子之后（如占位符前）：只删它最后一个字符，光标退回该原子内
        prev.value = prev.value.slice(0, -1)
        this.cursor = { atom: atom - 1, offset: prev.value.length }
        this.cache = null
        this.normalize()
        return
      }
      // 占位符：整体删除（一次删完，不逐字符）
      this.atoms.splice(atom - 1, 1)
      this.cursor = { atom: atom - 1, offset: 0 }
      this.cache = null
      this.normalize()
    }
  }

  /**
   * 左移：跨原子；占位符整体跨过（不进入内部）。
   * 注意原子边界两侧（占位符前 / 前一个 text 原子末尾）是**同一屏幕位置但不同逻辑位置**，
   * 因此 ← 在这一拍列号不变。这是刻意的：两处的 backspace 语义不同（前者删一个字符，后者删占位符）。
   */
  moveLeft(): void {
    const { atom, offset } = this.cursor
    if (offset > 0) {
      this.cursor = { atom, offset: offset - 1 }
      return
    }
    if (atom > 0) {
      const prev = this.atoms[atom - 1]
      // text 原子进入其末尾；占位符只能停在它前面（offset 恒为 0）
      this.cursor = { atom: atom - 1, offset: prev.kind === 'text' ? prev.value.length : 0 }
    }
  }

  /** 右移：跨原子；占位符整体跨过（不进入内部） */
  moveRight(): void {
    const { atom, offset } = this.cursor
    const cur = this.atoms[atom]
    if (cur && cur.kind === 'text' && offset < cur.value.length) {
      this.cursor = { atom, offset: offset + 1 }
      return
    }
    if (atom < this.atoms.length) this.cursor = { atom: atom + 1, offset: 0 }
  }

  /** 上移一行；无多行或已在首行返回 false（交 TUI 切换历史） */
  moveLineUp(): boolean {
    const r = this.ensureRender(this.lastCols)
    const pos = this.cursorPosition(this.lastCols)
    if (pos.line <= 0) return false
    this.cursor = cursorAtColumn(r.linePieces[pos.line - 1], pos.col)
    return true
  }

  /** 下移一行；无多行或已在末行返回 false（交 TUI 切换历史） */
  moveLineDown(): boolean {
    const r = this.ensureRender(this.lastCols)
    const pos = this.cursorPosition(this.lastCols)
    if (pos.line >= r.lines.length - 1) return false
    this.cursor = cursorAtColumn(r.linePieces[pos.line + 1], pos.col)
    return true
  }

  /** 渲染行（按 cols 折行）；返回缓存数组，调用方只读 */
  displayLines(cols: number): DisplayLine[] {
    return this.ensureRender(cols).lines
  }

  /** 当前光标在 displayLines 中的行号与列号（列 = 屏幕显示列，中文算 2） */
  cursorPosition(cols: number): { line: number; col: number } {
    const r = this.ensureRender(cols)
    const hit = r.positions.get(cursorKey(this.cursor))
    if (hit) return hit
    // 兜底：光标位置未被记录（理论不可达），归到末行行尾
    const last = r.lines.length - 1
    return { line: last, col: displayWidth(r.lines[last]?.text ?? '') }
  }

  /** 纯文本形式（历史记录 / 无图时提交）；paste 展开为完整原文 */
  toText(): string {
    return this.atoms.map(atomPlainText).join('')
  }

  /**
   * 消息内容：无 image 原子 → 返回 string（保持既有行为与向后兼容）；
   * 有 image 原子 → 返回 ContentPart[]，图片位置与占位符位置一致（按原子顺序遍历，
   * 遇 image 先把已累积文本段推入再推入 image_url）。
   *
   * 图片部件额外携带 path/name：它们是**非标准字段**，供 session.stripImages 写盘时
   * 换成 image_ref（data URL 无法反推文件路径，故必须随部件带出）。
   */
  toMessageContent(): string | ContentPart[] {
    if (!this.atoms.some((a) => a.kind === 'image')) return this.toText()

    const parts: ContentPart[] = []
    let text = ''
    const flushText = () => {
      if (!text) return
      parts.push({ type: 'text', text })
      text = ''
    }

    for (const a of this.atoms) {
      if (a.kind !== 'image') {
        text += atomPlainText(a) // paste 在这里必须展开为完整原文
        continue
      }
      flushText()
      const encoded = imageToDataUrl(a.path)
      if (encoded.ok) {
        const part: ImageContentPart = {
          type: 'image_url',
          image_url: { url: encoded.url },
          path: a.path,
          name: a.name,
        }
        parts.push(part)
      } else {
        // 文件在提交前消失：降级为文本标记，避免把空 URL 发给模型
        parts.push({ type: 'text', text: missingImageText(a.name) })
      }
    }
    flushText()
    return parts
  }

  // === 内部 ===

  /**
   * 合并相邻 text 原子、丢弃空 text 原子，并同步光标。
   * 结构性编辑（删占位符/删空文本）后调用：例如 [text, image, text] 删掉 image 后
   * 两侧文本必须重新拼成一个原子，否则 toText/折行仍然正确但原子数会持续膨胀。
   */
  private normalize(): void {
    const out: InputAtom[] = []
    /** 原原子下标 → 新原子下标 + 合并起点偏移（光标重映射用） */
    const map: Array<{ atom: number; offset: number }> = []

    for (const a of this.atoms) {
      const prev = out[out.length - 1]
      if (a.kind === 'text' && a.value === '') {
        map.push({ atom: out.length, offset: 0 }) // 空原子被丢弃，位置等价于它之后的起点
        continue
      }
      if (a.kind === 'text' && prev && prev.kind === 'text') {
        map.push({ atom: out.length - 1, offset: prev.value.length })
        prev.value += a.value
        continue
      }
      map.push({ atom: out.length, offset: 0 })
      out.push(a)
    }

    const m = this.cursor.atom < map.length ? map[this.cursor.atom] : { atom: out.length, offset: 0 }
    this.cursor = { atom: m.atom, offset: m.offset + this.cursor.offset }
    this.atoms = out
  }

  /** 在光标处把 text 原子切成两半（插入占位符用），返回插入位置（原子下标） */
  private splitTextAtom(): number {
    const { atom, offset } = this.cursor
    const cur = this.atoms[atom]
    if (!cur || cur.kind !== 'text' || offset === 0) return atom
    if (offset >= cur.value.length) return atom + 1
    const head: InputAtom = { kind: 'text', value: cur.value.slice(0, offset) }
    const tail: InputAtom = { kind: 'text', value: cur.value.slice(offset) }
    this.atoms.splice(atom, 1, head, tail)
    return atom + 1
  }

  /** 把原子展开成片段流：text 拆到字符（\n 变硬换行），占位符整体一个片段 */
  private pieces(): Piece[] {
    const out: Piece[] = []
    this.atoms.forEach((a, i) => {
      if (a.kind !== 'text') {
        const text = atomDisplayText(a)
        out.push({
          text,
          start: { atom: i, offset: 0 },
          end: { atom: i + 1, offset: 0 },
          atomic: true,
          hardBreak: false,
          width: displayWidth(text),
        })
        return
      }
      // 用码点遍历（宽度判断），偏移按 UTF-16 单位累加（与 String 下标一致）
      let offset = 0
      for (const ch of a.value) {
        if (ch === '\n') {
          out.push({
            text: '',
            start: { atom: i, offset },
            end: null,
            atomic: false,
            hardBreak: true,
            width: 0,
          })
        } else {
          out.push({
            text: ch,
            start: { atom: i, offset },
            end: { atom: i, offset: offset + ch.length },
            atomic: false,
            hardBreak: false,
            width: displayWidth(ch),
          })
        }
        offset += ch.length
      }
    })
    return out
  }

  private ensureRender(cols: number): Render {
    const width = Math.max(1, Math.floor(cols) || 1)
    this.lastCols = width
    if (!this.cache || this.cache.cols !== width) this.cache = this.render(width)
    return this.cache
  }

  /** 折行 + 光标定位一次算完：贪心按列宽打包片段，同时记录每个光标的位置 */
  private render(cols: number): Render {
    const lines: DisplayLine[] = []
    const linePieces: Piece[][] = []
    const positions: CursorPositions = new Map()

    let pieces: Piece[] = []
    let text = ''
    let lineWidth = 0
    let start: Cursor = { atom: 0, offset: 0 }
    let end: Cursor = start

    const record = (c: Cursor, line: number, col: number) => {
      const key = cursorKey(c)
      if (!positions.has(key)) positions.set(key, { line, col }) // 先记录者优先（易错点 1）
    }
    const flush = () => {
      lines.push({ text, start, end, col: 0 })
      linePieces.push(pieces)
      pieces = []
      text = ''
      lineWidth = 0
    }

    for (const p of this.pieces()) {
      if (p.hardBreak) {
        // 硬换行：\n 不渲染，光标停在当前行行尾；下一行从 \n 之后开始
        end = p.start
        record(p.start, lines.length, lineWidth)
        flush()
        start = { atom: p.start.atom, offset: p.start.offset + 1 }
        end = start
        record(start, lines.length, 0)
        continue
      }

      if (lineWidth > 0 && lineWidth + p.width > cols) {
        // 放不下就断行。占位符整体挪到下一行（不可拆开）；普通字符的折行边界光标留在上一行行尾
        if (!p.atomic) record(p.start, lines.length, lineWidth)
        flush()
        start = p.start
        end = p.start
      }

      record(p.start, lines.length, lineWidth)
      pieces.push(p)
      text += p.text
      if (p.end) {
        end = p.end
        record(p.end, lines.length, lineWidth + p.width)
      }
      lineWidth += p.width
    }

    // 收尾：末行（可能是 \n 留下的空行）+ 缓冲区末尾光标
    lines.push({ text, start, end, col: 0 })
    linePieces.push(pieces)
    const lastLine = lines.length - 1
    record({ atom: this.atoms.length, offset: 0 }, lastLine, lineWidth)
    const lastAtom = this.atoms[this.atoms.length - 1]
    if (lastAtom && lastAtom.kind === 'text') {
      // text 原子末尾光标与「缓冲区末尾」是等价位置，但 key 不同，两个都要能查到
      record({ atom: this.atoms.length - 1, offset: lastAtom.value.length }, lastLine, lineWidth)
    }

    return { cols, lines, linePieces, positions }
  }
}
