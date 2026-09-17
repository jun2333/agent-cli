/**
 * truncate.ts — 工具输出的**规模口径**（行数/字节）与**双阈值截断**（FR-2 / D19 / AC-11）
 *
 * 单位口径（lesson 012，**阈值、标注、计数三者同源**）：
 * - 行 = `countLines(·)`（按 `\r\n | \r | \n` 切分后的段数，**末尾行尾不额外算一行**；
 *   空文本 0 行）。**全项目唯一的行数实现**：截断判定、截断标注、工具行「输出 N 行」
 *   都调用它，不存在第二套计数（W-1 修复的关键）；
 * - 字节 = `Buffer.byteLength(text, 'utf8')`（不是 `string.length` 的 UTF-16 码元数，
 *   否则中文输出会少算一半 → 截断上限形同虚设）。
 *
 * ⚠️ **JSON 信封**（W-3 / W-R2）：`bash`/`read` 等工具的 content 是 `JSON.stringify({…})`，
 * 真实换行在信封里是 `\n` 两个字面字符 → 整段只有 1 行。若直接对信封计数/按行截断，两者
 * 都会失效（修复前：`seq 1 40` 显示「输出 1 行」；2000 行文件完全不截断）。
 * 因此计数与截断都先经 `OutputCodec` 抽出**有效正文**（哪些字段/哪些项是输出），截断后再按原形状
 * 回填——信封仍是合法 JSON。**数组信封**（`list_dir`/`glob`/`grep`/`web_search`）由
 * `jsonArrayCodec` 把「一项 = 一行」声明出来；修复前它没有 codec，超 50KB 时被按字节
 * **劈成非法 JSON**（W-R2：真实 4000 条目 `list_dir` → 51302B → `JSON.parse` 失败）。
 *
 * ⚠️ **V-4（用户拍板 2026-09-17）**：双阈值只作用于**文本**。`ContentPart[]` 里的
 * `image_url` 部件**原样保留、不参与截断与计数**（`view_image` 返回的 base64 图片动辄几十 KB，
 * 若计入字节阈值，同一结果里的文本说明会被误截）。此时超限提示必须说明「图片未计入」。
 *
 * 截断后追加一行标注，形如：
 * `… [输出已截断：省略 200 行 / 5120 字节；完整输出请用 bash_output 或查看日志]`
 * 其中 N/M **直接取自本次截断的返回值**，不存在第二次计算（lesson 012）。
 */
import type { ContentPart, OutputCodec, ToolResult } from './registry.js'

/** 截断标注的起始标记（测试与调用方据此辨认"这段是元信息，不是原始输出"） */
export const TRUNCATION_MARK = '… [输出已截断'

/**
 * 行尾：`\r\n` 必须整体匹配，否则 CRLF 文本会多算一行（lesson 012）。
 * 导出给 `registry.ts` 的数组 codec 复用——切行口径必须**只有这一处**，否则数组的
 * 「项 = 行」与 `countLines` 会各算一套（lesson 012 的"单一口径"）。
 */
export const LINE_END = /\r\n|\r|\n/

/**
 * 文本的**行数**（行数口径的唯一定义，见文件头）。
 *
 * `'a\nb\n'` → 2（`split('\n').length` 会给出 3）；`'a\nb'` → 2；`''` → 0。
 * 末尾的空段只在"文本以行尾结束"时出现，它不是一个可见行——这正是 `seq 1 40`
 * 必须显示 40（而不是 41）的原因（W-1）。
 */
export function countLines(text: string): number {
  if (!text) return 0
  const parts = text.split(LINE_END)
  return parts.length > 1 && parts[parts.length - 1] === '' ? parts.length - 1 : parts.length
}

export type TruncateOutcome = {
  /** 截断后的文本（含标注；未截断时即原文） */
  text: string
  truncated: boolean
  /** 被省略的行数（行 = 行尾切分元素数） */
  droppedLines: number
  /** 被省略的字节数（utf8；不含标注自身） */
  droppedBytes: number
}


/**
 * 按字节数安全截断字符串：不劈开多字节字符（UTF-8 续字节 `0b10xxxxxx`）。
 * 用 U+FFFD 替换是"看起来能用但会污染输出"的做法，这里明确回退到字符边界。
 */
function sliceUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

/** 标注文案：数字一律由调用方传入（同源），不在这里重算 */
function notice(droppedLines: number, droppedBytes: number, imagesExempt: boolean): string {
  const exempt = imagesExempt ? '（图片未计入）' : ''
  return `${TRUNCATION_MARK}：省略 ${droppedLines} 行 / ${droppedBytes} 字节${exempt}；完整输出请用 bash_output 或查看日志]`
}

/**
 * 对**文本**做双阈值截断。
 *
 * 行为：
 * 1. 两个阈值都没超 → 原样返回（`truncated: false`）；
 * 2. 按「行上限」先定保留行数，再按「字节上限」从头累计 —— 两者取更小者；
 * 3. 第一行本身就超字节（超长单行，如无换行的大块输出）→ 按字节裁该行，`droppedLines = 0`；
 * 4. 末尾追加标注行（标注自身不计入 `droppedBytes`，否则数字会自我指涉）。
 */
export function truncateToolOutput(text: string, maxLines: number, maxBytes: number): TruncateOutcome {
  const totalBytes = Buffer.byteLength(text, 'utf8')
  const totalLines = countLines(text)
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { text, truncated: false, droppedLines: 0, droppedBytes: 0 }
  }

  const lines = text.split(LINE_END)
  const lineCap = Math.min(lines.length, Math.max(0, maxLines))
  let used = 0
  let keep = 0
  for (let i = 0; i < lineCap; i++) {
    const add = Buffer.byteLength(lines[i], 'utf8') + (i > 0 ? 1 : 0) // 分隔符也占 1 字节
    if (used + add > maxBytes) break
    used += add
    keep++
  }

  if (keep === 0) {
    // 首行自身就超字节（或 maxBytes 极小）：按字节裁第一行，其余整行丢弃
    const head = sliceUtf8(lines[0], maxBytes)
    const droppedBytes = totalBytes - Buffer.byteLength(head, 'utf8')
    const droppedLines = Math.max(0, totalLines - 1)
    return {
      text: `${head}\n${notice(droppedLines, droppedBytes, false)}`,
      truncated: true,
      droppedLines,
      droppedBytes,
    }
  }

  const kept = lines.slice(0, keep).join('\n')
  const droppedBytes = totalBytes - Buffer.byteLength(kept, 'utf8')
  // 同源：被省略的行数 = 总行数 - 保留正文的行数（同一 countLines 口径，不二次计算）
  const droppedLines = totalLines - countLines(kept)
  return {
    text: `${kept}\n${notice(droppedLines, droppedBytes, false)}`,
    truncated: true,
    droppedLines,
    droppedBytes,
  }
}

/**
 * 结果规模（行数/字节）的**唯一测量口径**（W-1）。
 *
 * - 有 `codec` 且信封里确实有有效正文字段 → 度量这些字段（`bash` = stdout+stderr 行数之和）；
 * - 否则 → 回落"整段文本"（JSON 错误形状 `{error}`、`read_memory` 的 markdown、无 codec 的工具）；
 *   `ContentPart[]` 只看 `text` 部件，`image_url` 不计数（V-4）。
 *
 * 工具行「输出 N 行」与 executor `tool_post` 事件都来自这里 → 与截断同一口径（lesson 012）。
 */
export function measureToolOutput(
  codec: OutputCodec | undefined,
  content: string | ContentPart[],
): { lines: number; bytes: number } {
  const segments = codec ? codec.segments(content) : []
  if (segments.length > 0) {
    let lines = 0
    let bytes = 0
    for (const s of segments) {
      lines += countLines(s)
      bytes += Buffer.byteLength(s, 'utf8')
    }
    return { lines, bytes }
  }
  if (Array.isArray(content)) {
    const text = content.map((p) => (p.type === 'text' ? p.text : '')).join('')
    return { lines: countLines(text), bytes: Buffer.byteLength(text, 'utf8') }
  }
  return { lines: countLines(content), bytes: Buffer.byteLength(content, 'utf8') }
}

/**
 * `ToolResult` 的截断挂载点（executor 的 `truncate` seam 用它）。
 *
 * - 有 `codec`（JSON 信封工具：`bash`/`read`/`bash_output` 的字段口径，以及
 *   `list_dir`/`glob`/`grep`/`web_search` 的数组口径）→ 先抽出**有效正文**，
 *   对正文做双阈值截断，再按原形状回填（信封仍是合法 JSON）——这是 W-3 / W-R2 的修复点；
 * - `string` content 无 codec → 整段文本走 `truncateToolOutput`（原行为）；
 * - `ContentPart[]` → **只截 `type:'text'` 部件**，`image_url` 原样保留（V-4），
 *   超限时在末尾追加一个文本部件说明「图片未计入」。
 *
 * 未发生任何截断时**原样返回入参对象**（保持 `toEqual`/引用语义，也让"没超限"零开销）。
 */
export function truncateToolResult(
  result: ToolResult,
  maxLines: number,
  maxBytes: number,
  codec?: OutputCodec,
): ToolResult {
  // ① JSON 信封工具：双阈值作用在**有效正文**上（W-3）
  if (codec && typeof result.content === 'string') {
    const segments = codec.segments(result.content)
    if (segments.length > 0) {
      let truncated = false
      // 每段**独立**应用双阈值：先出现的段（stdout）不把后面的段（stderr，通常是错误信息）挤空；
      // 段数由工具语义固定且很小（bash = 2），最坏 ≤ 段数 × 上限（有界）
      const out = segments.map((seg) => {
        const r = truncateToolOutput(seg, maxLines, maxBytes)
        if (r.truncated) truncated = true
        return r.text
      })
      if (!truncated) return result
      // 行数/字节交给调用方按"实际回传内容"重算（单一来源，不在两处各记一套）
      return { ...result, content: codec.rebuild(result.content, out), lines: undefined, bytes: undefined }
    }
    // 信封里没有有效正文字段（错误形状 `{error}` 等）→ 落回下面的整段文本口径
  }

  if (typeof result.content === 'string') {
    const r = truncateToolOutput(result.content, maxLines, maxBytes)
    if (!r.truncated) return result
    // 行数/字节交给 executor 的兜底按"实际回传内容"重算（单一来源，不在两处各记一套）
    return { ...result, content: r.text, lines: undefined, bytes: undefined }
  }

  let droppedLines = 0
  let droppedBytes = 0
  const parts: ContentPart[] = result.content.map((p) => {
    if (p.type !== 'text') return p // image_url：原样保留、不计数（V-4）
    const t = truncateToolOutput(p.text, maxLines, maxBytes)
    if (!t.truncated) return p
    droppedLines += t.droppedLines
    droppedBytes += t.droppedBytes
    return { type: 'text' as const, text: t.text }
  })
  if (droppedLines === 0 && droppedBytes === 0) return result

  parts.push({ type: 'text', text: notice(droppedLines, droppedBytes, /* imagesExempt */ true) })
  return { ...result, content: parts, lines: undefined, bytes: undefined }
}
