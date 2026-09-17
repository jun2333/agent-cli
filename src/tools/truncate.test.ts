/**
 * truncate.test.ts — FR-2 的工具输出双阈值截断（AC-11 / D19 / V-4 / lesson 012）
 *
 * 断言原则（lesson 012）：**阈值、标注数字、计数三者同源** ——
 * 标注里的「省略 N 行 / M 字节」必须**等于**返回值 `droppedLines/droppedBytes`，
 * 不允许测试自己按第二种口径重算（那样只能证明测试和实现一起错）。
 * 行 = 按 `\r\n | \r | \n` 切分后的元素数；字节 = `Buffer.byteLength(·,'utf8')`。
 */
import { describe, it, expect } from 'vitest'
import { TRUNCATION_MARK, countLines, measureToolOutput, truncateToolOutput, truncateToolResult } from './truncate.js'
import { jsonArrayCodec, jsonFieldsCodec } from './registry.js'
import { config } from '../config.js'
import type { ContentPart, ToolResult } from './registry.js'

const MAX_LINES = config.toolOutputMaxLines
const MAX_BYTES = config.toolOutputMaxBytes

/** 取截断后的"保留正文"（标注之前的部分，去掉标注前那一行分隔符），用于与 droppedBytes 对齐 */
function keptBody(text: string): string {
  const at = text.indexOf(TRUNCATION_MARK)
  if (at < 0) return text
  const body = text.slice(0, at)
  return body.endsWith('\n') ? body.slice(0, -1) : body
}

/** 从标注里抽出被测实现自己声明的 N / M（用于"标注 == 返回值"的同源断言） */
function numbersInNotice(text: string): { lines: number; bytes: number } {
  const m = text.match(/省略 (\d+) 行 \/ (\d+) 字节/)
  if (!m) throw new Error(`未找到截断标注：${JSON.stringify(text.slice(-200))}`)
  return { lines: Number(m[1]), bytes: Number(m[2]) }
}

describe('FR-2/AC-11：truncateToolOutput 双阈值（仅文本）', () => {
  it('未超限：原样返回、truncated=false、计数为 0', () => {
    const text = 'hello\nworld'
    const r = truncateToolOutput(text, MAX_LINES, MAX_BYTES)
    expect(r).toEqual({ text, truncated: false, droppedLines: 0, droppedBytes: 0 })
  })

  it(`恰好 ${MAX_LINES} 行且字节不超限 → 不截断（阈值是"超过"才截）`, () => {
    const text = Array.from({ length: MAX_LINES }, (_, i) => `line-${i}`).join('\n')
    const r = truncateToolOutput(text, MAX_LINES, MAX_BYTES)
    expect(r.truncated).toBe(false)
  })

  it('行超限（1200 行）：保留前 1000 行，标注与返回值同源', () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `line-${i}`)
    const r = truncateToolOutput(lines.join('\n'), MAX_LINES, MAX_BYTES)

    expect(r.truncated).toBe(true)
    expect(r.droppedLines).toBe(200)
    // 保留正文 = 前 1000 行（逐字），且第 1000 行之后的内容不再出现
    expect(keptBody(r.text)).toBe(lines.slice(0, MAX_LINES).join('\n'))
    expect(r.text).not.toContain('line-1199')
    // 同源：标注里的数字直接取自返回值
    expect(numbersInNotice(r.text)).toEqual({ lines: r.droppedLines, bytes: r.droppedBytes })
    // 契约：droppedBytes = 原文 - 保留正文（即"从文本里去掉的字节"，含被吃掉的那一个分隔符）
    expect(r.droppedBytes).toBe(
      Buffer.byteLength(lines.join('\n'), 'utf8') - Buffer.byteLength(lines.slice(0, MAX_LINES).join('\n'), 'utf8'),
    )
  })

  it('字节超限（300 行 × 300B = 90KB）：按字节保留前缀，标注与返回值同源', () => {
    const one = 'a'.repeat(300)
    const lines = Array.from({ length: 300 }, () => one)
    const text = lines.join('\n')
    const total = Buffer.byteLength(text, 'utf8')
    expect(total).toBeGreaterThan(MAX_BYTES)

    const r = truncateToolOutput(text, MAX_LINES, MAX_BYTES)

    expect(r.truncated).toBe(true)
    // 行数没超（300 < 1000）→ 截断完全由字节阈值触发
    expect(r.droppedLines).toBeGreaterThan(0)
    expect(Buffer.byteLength(keptBody(r.text), 'utf8')).toBeLessThanOrEqual(MAX_BYTES)
    // 同源：保留正文 + 被省略字节 = 原文（标注本身不计入）
    expect(Buffer.byteLength(keptBody(r.text), 'utf8') + r.droppedBytes).toBe(total)
    expect(numbersInNotice(r.text)).toEqual({ lines: r.droppedLines, bytes: r.droppedBytes })
  })

  it('单行超字节（60KB 无换行）：droppedLines=0，按字节裁这一行且不劈开多字节字符', () => {
    const text = '中'.repeat(20 * 1024) // 20KiB 个中文字 = 60KB
    const total = Buffer.byteLength(text, 'utf8')
    expect(total).toBeGreaterThan(MAX_BYTES)

    const r = truncateToolOutput(text, MAX_LINES, MAX_BYTES)

    expect(r.truncated).toBe(true)
    expect(r.droppedLines).toBe(0)
    expect(r.droppedBytes).toBe(total - Buffer.byteLength(keptBody(r.text), 'utf8'))
    expect(Buffer.byteLength(keptBody(r.text), 'utf8')).toBeLessThanOrEqual(MAX_BYTES)
    // 未劈开多字节字符：保留正文仍是合法 UTF-8（无替换字符 U+FFFD）
    expect(keptBody(r.text)).not.toContain('\uFFFD')
    expect(numbersInNotice(r.text)).toEqual({ lines: 0, bytes: r.droppedBytes })
  })

  it('行尾识别覆盖 \\r\\n：1200 行按 CRLF 连接仍按 1200 行判定', () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `l${i}`)
    const r = truncateToolOutput(lines.join('\r\n'), MAX_LINES, MAX_BYTES)
    expect(r.truncated).toBe(true)
    expect(r.droppedLines).toBe(200)
  })

  it('行尾识别覆盖单独 \\r（lesson 012：旧实现只认 \\n 会把 1200 行当成 1 行）', () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `l${i}`)
    const r = truncateToolOutput(lines.join('\r'), MAX_LINES, MAX_BYTES)
    expect(r.truncated).toBe(true)
    expect(r.droppedLines).toBe(200)
    expect(keptBody(r.text)).toBe(lines.slice(0, MAX_LINES).join('\n'))
  })
})

/**
 * V-4（用户拍板 2026-09-17）：双阈值只作用于文本；`ContentPart[]` 里的 `image_url`
 * **原样保留、不参与截断与计数**，超限提示必须说明"图片未计入"。
 */
describe('FR-2/AC-11/V-4：ContentPart[] 只截文本、图片部件豁免', () => {
  const IMAGE: ContentPart = { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(80_000) } }

  it('文本超限时只截文本部件，image_url 逐字保留', () => {
    const text = Array.from({ length: 1500 }, (_, i) => `line-${i}`).join('\n')
    const parts: ContentPart[] = [{ type: 'text', text }, IMAGE]
    const r = truncateToolResult({ content: parts }, MAX_LINES, MAX_BYTES)

    const out = r.content as ContentPart[]
    expect(Array.isArray(out)).toBe(true)
    // 图片部件逐字原样（含 80KB data URL —— 若被计入字节，文本会被截得更狠）
    expect(out[1]).toEqual(IMAGE)
    // 文本部件被截断，且提示里说明图片未计入
    const notice = out.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    expect(notice).toContain('图片未计入')
    expect(notice).toContain('省略 500 行')
  })

  it('图片不计入计数：只在文本上触发/统计（80KB 图片不导致文本被截）', () => {
    const text = 'short text'
    const r = truncateToolResult({ content: [{ type: 'text', text }, IMAGE] }, MAX_LINES, MAX_BYTES)
    expect(r.content).toEqual([{ type: 'text', text }, IMAGE])
  })

  it('未超限的 ContentPart[] 原样返回（不追加任何提示）', () => {
    const parts: ContentPart[] = [{ type: 'text', text: 'ok' }, IMAGE]
    const r = truncateToolResult({ content: parts }, MAX_LINES, MAX_BYTES)
    expect(r).toEqual({ content: parts })
  })

  it('不修改入参（纯函数）：原数组与文本部件保持不变', () => {
    const long = Array.from({ length: 1200 }, (_, i) => `x${i}`).join('\n')
    const parts: ContentPart[] = [{ type: 'text', text: long }, IMAGE]
    const snapshot = JSON.parse(JSON.stringify(parts))
    truncateToolResult({ content: parts }, MAX_LINES, MAX_BYTES)
    expect(parts).toEqual(snapshot)
  })

  it('字符串 content 超限时由 truncateToolResult 处理（executor 的挂载路径）', () => {
    const text = Array.from({ length: 1200 }, (_, i) => `y${i}`).join('\n')
    const result: ToolResult = { content: text, ok: true }
    const r = truncateToolResult(result, MAX_LINES, MAX_BYTES)
    expect(r.ok).toBe(true)
    expect(typeof r.content).toBe('string')
    expect(r.content as string).toContain(TRUNCATION_MARK)
  })
})

/**
 * W-1/W-3（reviewing 返工修复）：行数口径与 JSON 信封编解码。
 *
 * 修复前：行数用 `split('\n').length` 数的是 **JSON 信封**（换行被转义 → 恒 1 行），
 * 1000 行阈值因此永不触发。这里锁死新的唯一口径与编解码器的回填形状。
 */
describe('W-1/W-3：countLines / jsonFieldsCodec / measureToolOutput（唯一口径）', () => {
  it('countLines：末尾行尾不额外算一行；空文本 0 行', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\nb\n')).toBe(2) // 旧口径 split('\n').length 会给 3
    expect(countLines('a\n\n')).toBe(2) // 末尾空行是"有内容的一行"的前一个空行
    expect(countLines('a\r\nb\r\n')).toBe(2)
    expect(countLines('a\rb\r')).toBe(2)
  })

  it('jsonFieldsCodec：抽出指定字段、按原形状回填（信封仍合法）；无有效字段 → 空数组', () => {
    const codec = jsonFieldsCodec(['stdout', 'stderr'])
    const content = JSON.stringify({ exitCode: 0, stdout: 'a\nb\n', stderr: '' })
    expect(codec.segments(content)).toEqual(['a\nb\n', ''])

    const rebuilt = codec.rebuild(content, ['a\nb\n… [输出已截断]', 'boom']) as string
    expect(JSON.parse(rebuilt)).toEqual({ exitCode: 0, stdout: 'a\nb\n… [输出已截断]', stderr: 'boom' })

    // 错误形状 / 非 JSON / 数组 → 没有有效字段 → 回落整段口径
    expect(codec.segments(JSON.stringify({ error: 'x' }))).toEqual([])
    expect(codec.segments('not json')).toEqual([])
    expect(codec.segments(JSON.stringify(['a']))).toEqual([])
    expect(codec.rebuild(JSON.stringify({ error: 'x' }), ['ignored'])).toBe(JSON.stringify({ error: 'x' }))
  })

  it('measureToolOutput：codec 优先；无有效字段回落整段；ContentPart[] 只看文本（V-4）', () => {
    const codec = jsonFieldsCodec(['content'])
    expect(measureToolOutput(codec, JSON.stringify({ path: 'a', content: 'l1\nl2\n' }))).toEqual({ lines: 2, bytes: 6 })
    // 无有效字段 → 整段信封（1 行，与修复前的错误结果语义一致）
    expect(measureToolOutput(codec, JSON.stringify({ error: 'boom' }))).toEqual({
      lines: 1,
      bytes: Buffer.byteLength(JSON.stringify({ error: 'boom' }), 'utf8'),
    })
    const image: ContentPart = { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(1000) } }
    expect(measureToolOutput(undefined, [{ type: 'text', text: 'a\nb' }, image])).toEqual({ lines: 2, bytes: 3 })
  })

  it('truncateToolResult 带 codec：只截有效正文，信封仍是合法 JSON，且计数器交给调用方重算（W-3）', () => {
    const codec = jsonFieldsCodec(['content'])
    const body = Array.from({ length: 1200 }, (_, i) => `l${i}`).join('\n')
    const input: ToolResult = { content: JSON.stringify({ path: 'a', content: body }) }
    const r = truncateToolResult(input, MAX_LINES, MAX_BYTES, codec)

    const parsed = JSON.parse(r.content as string)
    expect(Object.keys(parsed)).toEqual(['path', 'content']) // 形状未变
    expect(parsed.path).toBe('a')
    expect(parsed.content).toContain(TRUNCATION_MARK)
    expect(parsed.content).toContain('省略 200 行')
    expect(parsed.content).not.toContain('l1199')
    // lines/bytes 清空 → executor 按实际交付内容重算（单一来源）
    expect(r.lines).toBeUndefined()
    expect(r.bytes).toBeUndefined()
    // 未超限时原样返回（引用相等）
    const small: ToolResult = { content: JSON.stringify({ path: 'a', content: 'x' }) }
    expect(truncateToolResult(small, MAX_LINES, MAX_BYTES, codec)).toBe(small)
  })
})

/**
 * W-R2（Rework-2）：**数组形状**的 JSON 信封（`list_dir`/`glob`/`grep`/`web_search`）。
 *
 * 修复前没有数组 codec → 超 50KB 时整段文本按字节切 → 信封被劈成非法 JSON。
 * 数组 codec 把「一项 = 一行」声明出来：只整项丢弃、标注作尾元素回填，信封恒为合法 JSON。
 */
describe('W-R2：jsonArrayCodec（数组信封 = 项/行，截断后仍是合法 JSON）', () => {
  const codec = jsonArrayCodec()

  it('segments：项 = 行；非数组（错误形状 / ContentPart[]）→ 空数组回落整段口径', () => {
    expect(codec.segments(JSON.stringify([{ a: 1 }, { b: 2 }]))).toEqual(['{"a":1}\n{"b":2}'])
    expect(codec.segments(JSON.stringify(['x', 'y']))).toEqual(['"x"\n"y"'])
    // 错误形状、空数组、非 JSON、多模态 → 没有有效正文
    expect(codec.segments(JSON.stringify({ error: 'x' }))).toEqual([])
    expect(codec.segments('[]')).toEqual([])
    expect(codec.segments('not json')).toEqual([])
    expect(codec.segments([{ type: 'text', text: 'x' }])).toEqual([])
  })

  it('rebuild：标注作**尾元素**回填，恒为合法 JSON；截断残项不进数组', () => {
    const content = JSON.stringify([{ a: 1 }, { b: 2 }, { c: 3 }])
    const out = codec.rebuild(content, ['{"a":1}\n{"b":2}\n… [输出已截断：省略 1 行 / 8 字节]']) as string
    expect(JSON.parse(out)).toEqual([{ a: 1 }, { b: 2 }, '… [输出已截断：省略 1 行 / 8 字节]'])

    // keep===0 边界：被字节切开的残项解析失败 → 丢弃，只留标注 → 仍是合法 JSON
    const sliced = codec.rebuild(content, ['{"a":1\n… [输出已截断：省略 2 行 / 20 字节]']) as string
    expect(JSON.parse(sliced)).toEqual(['… [输出已截断：省略 2 行 / 20 字节]'])
  })

  it('truncateToolResult + 数组 codec：只按项丢弃，信封仍合法，计数器交给调用方重算', () => {
    const items = Array.from({ length: 1200 }, (_, i) => ({ i, name: `n${i}` }))
    const input: ToolResult = { content: JSON.stringify(items) }
    const r = truncateToolResult(input, MAX_LINES, MAX_BYTES, codec)

    const out = JSON.parse(r.content as string) as unknown[]
    expect(out).toHaveLength(MAX_LINES + 1) // 1000 项 + 1 条标注
    // 标注数字与实际截断量同源（同一 utf8 口径复算，逐字相等）
    const joined = (a: unknown[]) => a.map((x) => JSON.stringify(x)).join('\n')
    const droppedBytes =
      Buffer.byteLength(joined(items), 'utf8') - Buffer.byteLength(joined(items.slice(0, MAX_LINES)), 'utf8')
    expect(out[out.length - 1]).toBe(
      `${TRUNCATION_MARK}：省略 ${items.length - MAX_LINES} 行 / ${droppedBytes} 字节；完整输出请用 bash_output 或查看日志]`,
    )
    expect(out.slice(0, MAX_LINES)).toEqual(items.slice(0, MAX_LINES)) // 整项保留、顺序不变
    expect(r.lines).toBeUndefined() // 由 executor 按实际交付内容重算（单一来源）

    // 未超限时原样返回（引用相等）
    const small: ToolResult = { content: JSON.stringify([{ a: 1 }]) }
    expect(truncateToolResult(small, MAX_LINES, MAX_BYTES, codec)).toBe(small)
  })

  it('measureToolOutput + 数组 codec：行数 = 项数（不再恒为 1）', () => {
    expect(measureToolOutput(codec, JSON.stringify([{ a: 1 }, { b: 2 }, { c: 3 }]))).toEqual({
      lines: 3,
      bytes: Buffer.byteLength('{"a":1}\n{"b":2}\n{"c":3}', 'utf8'),
    })
    // 反证：错误形状仍按整段口径（1 行）
    expect(measureToolOutput(codec, JSON.stringify({ error: 'boom' })).lines).toBe(1)
  })
})
