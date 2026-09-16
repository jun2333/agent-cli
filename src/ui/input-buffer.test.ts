/**
 * input-buffer 单测 —— 覆盖 design.md / task-plan.md 明确要求的全部边界：
 * 折叠阈值（3/4 行、200/201 字符、\r 与 \r\n 行尾统计）、占位符整体删除、跨原子左右移动、
 * 折行边界上的上下移动列对齐、多图 toMessageContent 位置一致性、空缓冲不越界、单行时上下移动返回 false、
 * 多图与折叠粘贴交错时的部件顺序一致性、占位符文本 ↔ image 原子的往返（Ctrl+G 回填用）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ContentPart } from '../tools/index.js'
import { InputBuffer, PASTE_FOLD_CHARS, PASTE_FOLD_LINES, countLines } from './input-buffer.js'

let tmp: string
let pngA: string
let pngB: string
let origEnv: string | undefined

/** 生成 n 行文本（n-1 个换行） */
const pasteLines = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`).join('\n')

/** 全部显示行的拼接文本（断言「是否出现占位符」时用） */
const shown = (b: InputBuffer, cols = 80) => b.displayLines(cols).map((l) => l.text).join('\n')

const imageParts = (content: string | ContentPart[]) => content as Array<ContentPart & Record<string, any>>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-cli-input-buffer-'))
  origEnv = process.env.AGENT_CLI_DIR
  process.env.AGENT_CLI_DIR = tmp
  // 1x1 PNG 的最小字节序列（内容不重要，只要能被 base64 编码成 data URL）
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  pngA = join(tmp, 'a.png')
  pngB = join(tmp, 'b.png')
  writeFileSync(pngA, png)
  writeFileSync(pngB, png)
})

afterEach(() => {
  if (origEnv === undefined) delete process.env.AGENT_CLI_DIR
  else process.env.AGENT_CLI_DIR = origEnv
  rmSync(tmp, { recursive: true, force: true })
})

describe('折叠阈值边界', () => {
  it('阈值常量符合当前设计（3 行 / 200 字符）', () => {
    expect(PASTE_FOLD_LINES).toBe(3)
    expect(PASTE_FOLD_CHARS).toBe(200)
  })

  it('countLines 同时认 \\n、\\r\\n 与单独的 \\r', () => {
    expect(countLines('a\nb\nc')).toBe(3)
    expect(countLines('a\r\nb\r\nc')).toBe(3)
    expect(countLines('a\rb\rc')).toBe(3) // 只按 \n 切会算成 1 行
    expect(countLines('abc')).toBe(1)
    expect(countLines('')).toBe(1)
  })

  it('3 行不折叠（阈值是 >3）', () => {
    const b = new InputBuffer()
    b.insertPaste(pasteLines(3))
    expect(shown(b)).not.toContain('[粘贴')
    expect(b.toText()).toBe(pasteLines(3))
  })

  it('4 行折叠为占位符，且提交内容仍是完整原文', () => {
    const b = new InputBuffer()
    b.insertPaste(pasteLines(4))
    expect(shown(b)).toContain('[粘贴 4 行]')
    expect(b.toText()).toBe(pasteLines(4))
  })

  it('200 字符不折叠（阈值是 >200）', () => {
    const b = new InputBuffer()
    b.insertPaste('a'.repeat(200))
    expect(shown(b)).not.toContain('[粘贴')
    expect(b.toText()).toBe('a'.repeat(200))
  })

  it('201 字符折叠，且单行粘贴显示为 [粘贴 N 字符] 而非误导性的 [粘贴 1 行]', () => {
    const b = new InputBuffer()
    b.insertPaste('a'.repeat(201))
    expect(shown(b)).toContain('[粘贴 201 字符]')
    expect(shown(b)).not.toContain('1 行')
    expect(b.toText()).toBe('a'.repeat(201))
  })

  it('只有 \\r 行尾（旧 Mac 风格）也能正确统计行数并显示行数', () => {
    const b = new InputBuffer()
    const s = 'l0\rl1\rl2\rl3' // 4 行；旧实现按 \n 切会算成 1 行 → 误显示 [粘贴 1 行]
    b.insertPaste(s)
    expect(shown(b)).toContain('[粘贴 4 行]')
    expect(shown(b)).not.toContain('字符')
    expect(b.toText()).toBe(s)
  })

  it('\\r\\n 行尾也能正确统计行数', () => {
    const b = new InputBuffer()
    const s = 'l0\r\nl1\r\nl2\r\nl3'
    b.insertPaste(s)
    expect(shown(b)).toContain('[粘贴 4 行]')
    expect(b.toText()).toBe(s)
  })

  it('未超阈值的 insertPaste 等同 insertText（与已有 text 原子合并）', () => {
    const b = new InputBuffer()
    b.insertText('a')
    b.insertPaste('b\nc')
    expect(shown(b)).toBe('ab\nc')
    expect(b.displayLines(80).map((l) => l.text)).toEqual(['ab', 'c'])
  })

  // N-7：折叠判定与占位符显示必须同口径（都按**码点**）。
  // 旧实现用 s.length（UTF-16 码元）判 200，含 emoji 代理对时会出现
  // 「已折叠但显示 [粘贴 199 字符]」这种自相矛盾的画面。
  it('含 emoji（代理对）时按码点判折叠：200 码点 / 201 码元不折叠', () => {
    const b = new InputBuffer()
    const s = 'a'.repeat(199) + '😀' // 200 码点，但 UTF-16 码元是 201
    expect([...s].length).toBe(200)
    expect(s.length).toBe(201) // 前置条件：确实是代理对场景

    b.insertPaste(s)

    // 若按 s.length 判，会折叠成「[粘贴 200 字符]」——而阈值语义是 >200 才折叠
    expect(shown(b)).not.toContain('[粘贴')
    expect(b.toText()).toBe(s)
  })

  it('含 emoji 时 201 码点折叠，显示字符数与判定口径一致（201 而非 402）', () => {
    const b = new InputBuffer()
    const s = '😀'.repeat(201) // 201 码点 / 402 码元
    expect([...s].length).toBe(201)
    expect(s.length).toBe(402)

    b.insertPaste(s)

    expect(shown(b)).toContain('[粘贴 201 字符]') // 显示口径 = 码点数
    expect(shown(b)).not.toContain('402')
    expect(b.toText()).toBe(s)
  })

  it('纯文本与 emoji 混合时阈值同样按码点（199 码点 / 299 码元不折叠）', () => {
    const b = new InputBuffer()
    const s = 'a'.repeat(99) + '😀'.repeat(100) // 199 码点 / 299 码元
    expect([...s].length).toBe(199)
    expect(s.length).toBe(299)

    b.insertPaste(s)

    expect(shown(b)).not.toContain('[粘贴')
    expect(b.toText()).toBe(s)
  })
})

describe('原子删除（占位符整体删除）', () => {
  it('paste 占位符一次 backspace 整体删除，不逐字符', () => {
    const b = new InputBuffer()
    b.insertText('前')
    b.insertPaste(pasteLines(21))
    expect(shown(b)).toContain('[粘贴 21 行]')
    b.backspace() // 光标在占位符之后 → 一次删完整个占位符
    expect(b.toText()).toBe('前')
    expect(shown(b)).toBe('前')
  })

  it('image 占位符一次 backspace 整体删除', () => {
    const b = new InputBuffer()
    b.insertText('看图')
    b.insertImage('a.png', pngA)
    expect(shown(b)).toBe('看图[image: a.png]')
    b.backspace()
    expect(b.toText()).toBe('看图')
    expect(shown(b)).toBe('看图')
  })

  it('删除图片后两侧 text 原子合并，光标停在接缝处', () => {
    const b = new InputBuffer()
    b.insertText('ab')
    b.insertImage('a.png', pngA)
    b.insertText('cd')
    b.moveLeft()
    b.moveLeft() // 光标回到图片之后（{atom:2, offset:0}）
    expect(b.cursorPosition(80).col).toBe('ab'.length + '[image: a.png]'.length)
    b.backspace()
    expect(b.toText()).toBe('abcd')
    expect(b.cursorPosition(80)).toEqual({ line: 0, col: 2 }) // 停在 ab|cd 之间
  })

  it('text 原子删空后被丢弃，不残留空原子', () => {
    const b = new InputBuffer()
    b.insertText('a')
    b.insertImage('a.png', pngA)
    b.insertText('b')
    b.backspace() // 删 'b' → text 原子变空
    b.backspace() // 删图片
    b.backspace() // 删 'a'
    expect(b.isEmpty).toBe(true)
    expect(b.toText()).toBe('')
  })
})

describe('跨原子左右移动', () => {
  it('text → image → text 之间左右移动，占位符整体跨过', () => {
    const b = new InputBuffer()
    b.insertText('ab')
    b.insertImage('a.png', pngA)
    b.insertText('cd')
    // 光标在末尾：'ab'(2) + '[image: a.png]'(14) + 'cd'(2) = 18 列
    expect(b.cursorPosition(80).col).toBe(18)
    const cols: number[] = []
    for (let i = 0; i < 5; i++) {
      b.moveLeft()
      cols.push(b.cursorPosition(80).col)
    }
    // 依次：'d' 前(17) → 'cd' 段首(16) → 占位符前(2) → 'ab' 末尾(2) → 'ab' 中间(1) → 段首(0)
    // 第 3、4 拍列号同为 2：占位符前与 'ab' 末尾是同一屏幕位置、不同逻辑位置（backspace 语义不同）
    expect(cols).toEqual([17, 16, 2, 2, 1])
    b.moveLeft()
    expect(b.cursorPosition(80).col).toBe(0)
    b.moveLeft() // 已在行首，不越界
    expect(b.cursorPosition(80).col).toBe(0)
  })

  it('光标停在占位符之前时 backspace 只删前一个 text 原子的一个字符', () => {
    const b = new InputBuffer()
    b.insertText('ab')
    b.insertImage('a.png', pngA)
    b.moveLeft() // {atom:1, offset:0}：图片之前 = 'ab' 之后
    expect(b.cursorPosition(80).col).toBe(2)
    b.backspace()
    expect(b.toText()).toBe('a[image: a.png]') // 只删掉 'b'，图片保留
  })

  it('右移从 text 末尾跨过占位符，不进入占位符内部', () => {
    const b = new InputBuffer()
    b.insertText('ab')
    b.insertImage('a.png', pngA)
    const b2 = b
    b2.moveLeft() // {atom:1, offset:0} → 'ab' 末尾
    expect(b2.cursorPosition(80).col).toBe(2)
    b2.moveRight() // 跨过占位符到它之后
    expect(b2.cursorPosition(80).col).toBe(2 + '[image: a.png]'.length)
  })
})

describe('折行与光标定位', () => {
  it('按显示宽度折行（中文占 2 列）', () => {
    const b = new InputBuffer()
    b.insertText('你好世界')
    expect(b.displayLines(4).map((l) => l.text)).toEqual(['你好', '世界'])
    expect(b.cursorPosition(4)).toEqual({ line: 1, col: 4 })
  })

  it('超长行折行后 ↑/↓ 保持列对齐', () => {
    const b = new InputBuffer()
    b.insertText('0123456789ABCDEFGHIJ') // 20 字符，cols=10 → 2 行
    expect(b.displayLines(10).map((l) => l.text)).toEqual(['0123456789', 'ABCDEFGHIJ'])
    expect(b.cursorPosition(10)).toEqual({ line: 1, col: 10 })
    for (let i = 0; i < 5; i++) b.moveLeft() // → 第 2 行第 5 列
    expect(b.cursorPosition(10)).toEqual({ line: 1, col: 5 })
    expect(b.moveLineUp()).toBe(true)
    expect(b.cursorPosition(10)).toEqual({ line: 0, col: 5 })
    expect(b.moveLineDown()).toBe(true)
    expect(b.cursorPosition(10)).toEqual({ line: 1, col: 5 })
  })

  it('目标行更短时列收敛到行尾', () => {
    const b = new InputBuffer()
    b.insertText('0123456789ABCDE') // cols=10 → ['0123456789', 'ABCDE']
    expect(b.displayLines(10).map((l) => l.text)).toEqual(['0123456789', 'ABCDE'])
    for (let i = 0; i < 6; i++) b.moveLeft() // 光标 {atom:0, offset:9} → 第 1 行第 9 列
    expect(b.cursorPosition(10)).toEqual({ line: 0, col: 9 })
    expect(b.moveLineDown()).toBe(true)
    expect(b.cursorPosition(10)).toEqual({ line: 1, col: 5 }) // 第 2 行只有 5 列
  })

  it('硬换行（\\n）产生的多行也能上下移动', () => {
    const b = new InputBuffer()
    b.insertText('ab\ncd')
    expect(b.displayLines(80).map((l) => l.text)).toEqual(['ab', 'cd'])
    expect(b.cursorPosition(80)).toEqual({ line: 1, col: 2 })
    expect(b.moveLineUp()).toBe(true)
    expect(b.cursorPosition(80)).toEqual({ line: 0, col: 2 })
    expect(b.moveLineDown()).toBe(true)
    expect(b.cursorPosition(80)).toEqual({ line: 1, col: 2 })
  })

  it('cursorPosition 覆盖硬换行产生的空行', () => {
    const b = new InputBuffer()
    b.insertText('a\n\nb')
    expect(b.displayLines(80).map((l) => l.text)).toEqual(['a', '', 'b'])
    expect(b.cursorPosition(80)).toEqual({ line: 2, col: 1 })
    b.moveLeft()
    expect(b.cursorPosition(80)).toEqual({ line: 2, col: 0 })
    b.moveLeft()
    expect(b.cursorPosition(80)).toEqual({ line: 1, col: 0 }) // 空行
    b.moveLeft()
    expect(b.cursorPosition(80)).toEqual({ line: 0, col: 1 })
  })

  it('占位符不可被折行拆开（列宽不足时整体换到下一行）', () => {
    const b = new InputBuffer()
    b.insertText('abcdefgh') // 8 列
    b.insertPaste(pasteLines(21)) // '[粘贴 21 行]' 宽 12，放不进剩余 2 列
    const lines = b.displayLines(10).map((l) => l.text)
    expect(lines[0]).toBe('abcdefgh')
    expect(lines[1]).toBe('[粘贴 21 行]') // 完整占位符，未被拆开
  })

  it('占位符本身超过列宽时独占一行（不拆开、不丢内容）', () => {
    const b = new InputBuffer()
    b.insertImage('very-long-name.png', pngA)
    const lines = b.displayLines(5)
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('[image: very-long-name.png]')
  })
})

describe('上下移动的返回值（交 TUI 走历史）', () => {
  it('单行时 moveLineUp/Down 均返回 false', () => {
    const b = new InputBuffer()
    b.insertText('abc')
    expect(b.moveLineUp()).toBe(false)
    expect(b.moveLineDown()).toBe(false)
  })

  it('空缓冲时返回 false', () => {
    const b = new InputBuffer()
    expect(b.moveLineUp()).toBe(false)
    expect(b.moveLineDown()).toBe(false)
  })

  it('已在首行/末行时返回 false', () => {
    const b = new InputBuffer()
    b.insertText('ab\ncd')
    expect(b.moveLineUp()).toBe(true)
    expect(b.moveLineUp()).toBe(false) // 已在首行
    expect(b.moveLineDown()).toBe(true)
    expect(b.moveLineDown()).toBe(false) // 已在末行
  })
})

describe('空缓冲行为', () => {
  it('编辑操作全部不越界', () => {
    const b = new InputBuffer()
    expect(b.isEmpty).toBe(true)
    expect(b.toText()).toBe('')
    expect(b.displayLines(80).map((l) => l.text)).toEqual([''])
    expect(b.cursorPosition(80)).toEqual({ line: 0, col: 0 })
    b.backspace()
    b.moveLeft()
    b.moveRight()
    expect(b.toText()).toBe('')
    expect(b.cursorPosition(80)).toEqual({ line: 0, col: 0 })
    expect(b.toMessageContent()).toBe('')
  })

  it('clear 清空内容与光标', () => {
    const b = new InputBuffer()
    b.insertText('abc')
    b.insertImage('a.png', pngA)
    b.clear()
    expect(b.isEmpty).toBe(true)
    expect(b.toText()).toBe('')
    expect(b.cursorPosition(80)).toEqual({ line: 0, col: 0 })
  })
})

describe('toMessageContent', () => {
  it('无 image 原子时返回 string（向后兼容），paste 展开为原文', () => {
    const b = new InputBuffer()
    b.insertText('hi\n')
    b.insertPaste(pasteLines(21))
    const content = b.toMessageContent()
    expect(typeof content).toBe('string')
    expect(content).toBe(`hi\n${pasteLines(21)}`)
  })

  it('多图时位置与占位符一致（text/image 交替）', () => {
    const b = new InputBuffer()
    b.insertText('第一段')
    b.insertImage('a.png', pngA)
    b.insertText('中间')
    b.insertImage('b.png', pngB)
    b.insertText('末段')
    const parts = imageParts(b.toMessageContent())
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'text', 'image_url', 'text'])
    expect(parts[0].text).toBe('第一段')
    expect(parts[2].text).toBe('中间')
    expect(parts[4].text).toBe('末段')
    expect(parts[1].image_url.url.startsWith('data:image/png;base64,')).toBe(true)
    expect(parts[3].image_url.url.startsWith('data:image/png;base64,')).toBe(true)
    // 位置一致性：把 content 里的图片按顺序换回占位符，应等于 toText()
    const rebuilt = parts.map((p) => (p.type === 'text' ? p.text : `[image: ${p.name}]`)).join('')
    expect(rebuilt).toBe(b.toText())
  })

  it('图片在首/尾时不产生空文本段', () => {
    const b = new InputBuffer()
    b.insertImage('a.png', pngA)
    b.insertText('x')
    b.insertImage('b.png', pngB)
    const parts = imageParts(b.toMessageContent())
    expect(parts.map((p) => p.type)).toEqual(['image_url', 'text', 'image_url'])
    expect(parts[1].text).toBe('x')
  })

  it('图片部件携带 path/name（供会话持久化剥离为 image_ref）', () => {
    const b = new InputBuffer()
    b.insertImage('a.png', pngA)
    const parts = imageParts(b.toMessageContent())
    expect(parts[0].path).toBe(pngA)
    expect(parts[0].name).toBe('a.png')
  })

  it('图片文件消失时降级为文本标记，不产生空 URL 部件', () => {
    const b = new InputBuffer()
    b.insertText('看图')
    b.insertImage('gone.png', join(tmp, 'not-exist.png'))
    const parts = imageParts(b.toMessageContent())
    expect(parts.map((p) => p.type)).toEqual(['text', 'text'])
    expect(parts[1].text).toBe('[图片已失效: gone.png]')
  })
})

describe('多图与折叠粘贴的组合一致性', () => {
  /** 把 content 里的图片按顺序换回占位符（位置一致性断言用） */
  const rebuild = (parts: Array<Record<string, any>>) =>
    parts.map((p) => (p.type === 'text' ? p.text : `[image: ${p.name}]`)).join('')

  it('text → 折叠 paste → image → text：部件序列与占位符位置一致', () => {
    const b = new InputBuffer()
    const pasted = pasteLines(21)
    b.insertText('开头:')
    b.insertPaste(pasted)
    b.insertImage('a.png', pngA)
    b.insertText('结尾')
    // 先确认 paste 走的是折叠路径（显示为占位符），否则下面断言的是 text 路径
    expect(shown(b)).toContain('[粘贴 21 行]')

    const parts = imageParts(b.toMessageContent())
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'text'])
    // paste 展开为完整原文，并与它前后的 text 原子拼成同一段
    expect(parts[0].text).toBe(`开头:${pasted}`)
    expect(parts[1].name).toBe('a.png')
    expect(parts[2].text).toBe('结尾')
    // 无空文本段
    expect(parts.filter((p) => p.type === 'text').every((p) => p.text !== '')).toBe(true)
    // 位置一致性：图片按顺序换回占位符 == toText()
    expect(rebuild(parts)).toBe(b.toText())
    // 两种视图的文本部分一致：文本段拼接 == toText() 去掉图片占位符
    const textOnly = parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('')
    expect(textOnly).toBe(b.toText().replace('[image: a.png]', ''))
    expect(b.toText()).toBe(`开头:${pasted}[image: a.png]结尾`)
  })

  it('多个 image 与折叠 paste 交错时顺序正确', () => {
    const b = new InputBuffer()
    const p1 = pasteLines(21)
    const p2 = pasteLines(25)
    b.insertPaste(p1)
    b.insertImage('a.png', pngA)
    b.insertPaste(p2)
    b.insertImage('b.png', pngB)
    b.insertText('尾')

    const parts = imageParts(b.toMessageContent())
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'text', 'image_url', 'text'])
    expect(parts[0].text).toBe(p1) // 首个 paste 展开，且前面没有空段
    expect(parts[1].name).toBe('a.png')
    expect(parts[2].text).toBe(p2) // 第二个 paste 展开，两图之间无空段
    expect(parts[3].name).toBe('b.png')
    expect(parts[4].text).toBe('尾')
    expect(parts.filter((p) => p.type === 'text').every((p) => p.text !== '')).toBe(true)
    expect(rebuild(parts)).toBe(b.toText())
    expect(b.toText()).toBe(`${p1}[image: a.png]${p2}[image: b.png]尾`)
  })

  it('在 text 原子中间插入折叠 paste 后再插图，段顺序与内容正确', () => {
    const b = new InputBuffer()
    const pasted = pasteLines(21)
    b.insertText('前后')
    b.moveLeft() // 光标落到 '前|后' 之间，paste 会把 text 原子切成两半
    b.insertPaste(pasted)
    b.insertImage('a.png', pngA) // 光标仍在 '后' 之前 → 图片插在 paste 与 '后' 之间

    const parts = imageParts(b.toMessageContent())
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'text'])
    expect(parts[0].text).toBe(`前${pasted}`) // 切开的 head 与 paste 拼成一段
    expect(parts[1].name).toBe('a.png')
    expect(parts[2].text).toBe('后')
    expect(parts.filter((p) => p.type === 'text').every((p) => p.text !== '')).toBe(true)
    expect(rebuild(parts)).toBe(b.toText())
    expect(b.toText()).toBe(`前${pasted}[image: a.png]后`)
  })
})

describe('占位符往返（Ctrl+G 编辑器回填用）', () => {
  it('loadFromText 把 [image: name] 解析回 image 原子（路径由注入回调给）', () => {
    const b = new InputBuffer()
    b.loadFromText('看图[image: a.png]然后呢', (name) => (name === 'a.png' ? { name, path: pngA } : null))

    expect(b.imageAtoms()).toEqual([{ name: 'a.png', path: pngA }])
    expect(b.toText()).toBe('看图[image: a.png]然后呢')
    // 图片在消息 content 中的位置与占位符一致
    const parts = imageParts(b.toMessageContent())
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'text'])
    expect(parts[0].text).toBe('看图')
    expect(parts[1].name).toBe('a.png')
    expect(parts[2].text).toBe('然后呢')
  })

  it('resolveImage 返回 null 时保留字面量文本（手写的占位符不变成图片）', () => {
    const b = new InputBuffer()
    b.loadFromText('[image: unknown.png]', () => null)
    expect(b.imageAtoms()).toEqual([])
    expect(b.toText()).toBe('[image: unknown.png]')
    expect(typeof b.toMessageContent()).toBe('string') // 无 image 原子 → 仍是纯文本
  })

  it('未注入 resolveImage 时等同纯文本加载', () => {
    const b = new InputBuffer()
    b.loadFromText('a[image: a.png]b')
    expect(b.imageAtoms()).toEqual([])
    expect(b.toText()).toBe('a[image: a.png]b')
  })

  it('无占位符时等同纯文本加载（含换行）', () => {
    const b = new InputBuffer()
    b.loadFromText('第一行\n第二行')
    expect(b.imageAtoms()).toEqual([])
    expect(b.toText()).toBe('第一行\n第二行')
    expect(b.displayLines(80).map((l) => l.text)).toEqual(['第一行', '第二行'])
  })

  it('多图占位符全部解析，顺序与文本一致', () => {
    const b = new InputBuffer()
    b.insertText('旧内容') // 先有内容：loadFromText 必须清空后重建
    b.insertImage('b.png', pngB)
    b.loadFromText('[image: a.png] [image: a.png]', (name) => ({ name, path: pngA }))

    expect(b.imageAtoms()).toEqual([
      { name: 'a.png', path: pngA },
      { name: 'a.png', path: pngA },
    ])
    expect(b.toText()).toBe('[image: a.png] [image: a.png]')
    expect(b.toMessageContent()).toBeDefined()
  })

  it('空文本清空缓冲且光标归位', () => {
    const b = new InputBuffer()
    b.insertText('x')
    b.loadFromText('')
    expect(b.isEmpty).toBe(true)
    expect(b.cursorPosition(80)).toEqual({ line: 0, col: 0 })
  })

  it('imageAtoms 返回快照，改它不影响缓冲内部状态', () => {
    const b = new InputBuffer()
    b.insertImage('a.png', pngA)
    const snap = b.imageAtoms() as Array<{ name: string; path: string }>
    snap[0].path = '/tmp/evil.png'
    snap.push({ name: 'b.png', path: pngB })

    expect(b.imageAtoms()).toEqual([{ name: 'a.png', path: pngA }])
  })

  it('无图片原子时 imageAtoms 返回空数组', () => {
    const b = new InputBuffer()
    b.insertText('纯文本')
    expect(b.imageAtoms()).toEqual([])
  })
})
