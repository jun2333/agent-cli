/**
 * text.ts — 终端文本的纯函数工具（宽度 / 折行 / 截断 / 行内 Markdown）
 *
 * 为什么单独成模块（I-3）：这些函数被渲染层（`tui.ts`、`selector.ts`）和纯逻辑层
 * （`input-buffer.ts` 折行时算列宽）共用。放在 `tui.ts` 里会让 `input-buffer.ts` 反向依赖
 * 渲染层，形成 `input-buffer → tui → input-buffer` 循环导入（虽然函数声明提升使其"恰好能跑"，
 * 但把 readline/终端依赖拖进了纯逻辑单测的加载图）。提到本模块后两处都只依赖它，无环。
 *
 * 本模块不碰 process.stdin/stdout，全部是可单测的纯计算。
 */

// === SGR 样式（Select Graphic Rendition：\x1b[<n>m 设置文本样式） ===
// 只放本模块函数用到的三个；其余渲染样式（DIM/GREEN/…）留在 tui.ts。
// CODE/RESET 被 tui.ts 的渲染共用，故导出复用，避免两处各写一份字面量。
export const CODE = '\x1b[36m' // 青色：行内代码 / 代码块
export const BOLD = '\x1b[1m' // 加粗（markdown **重点** / 标题）
export const RESET = '\x1b[0m' // 重置所有样式

/** 字符串的终端显示宽度：中文/全角按 2 列计（宽字符近似规则） */
export function displayWidth(s: string): number {
  let w = 0
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!
    w += cp > 0x7f ? 2 : 1
    if (cp > 0xffff) i++
  }
  return w
}

/** 按显示宽度折行（不切分超宽单字符）；显式 \n 保留为独立行 */
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

/** 按显示宽度截断（超宽时尽量补省略号）；ANSI 转义序列不占宽度、原样保留 */
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

/** 取字符串尾部且不超过宽度（思考面板的水平滚动摘要用） */
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
