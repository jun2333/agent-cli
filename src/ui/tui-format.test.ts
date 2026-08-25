import { describe, it, expect } from 'vitest'
import { displayWidth, wrapText, truncateTo, tailByWidth, inlineMarkdown } from '../ui/tui.js'

describe('displayWidth', () => {
  it('ASCII 按 1 计宽', () => {
    expect(displayWidth('abc')).toBe(3)
  })
  it('中文按 2 计宽', () => {
    expect(displayWidth('你好')).toBe(4)
  })
  it('混合宽度', () => {
    expect(displayWidth('a你1好')).toBe(1 + 2 + 1 + 2)
  })
})

describe('wrapText', () => {
  it('按显示宽度换行，不切分超宽单字符', () => {
    // '你' 宽 2，maxW=5 时 '你好' 占 4，'a' 再占 1 → 下一字符 'b' 放不下换行
    expect(wrapText('你好ab', 5)).toEqual(['你好a', 'b'])
  })
  it('显式换行符 \n 保留为独立行', () => {
    expect(wrapText('a\nb', 10)).toEqual(['a', 'b'])
  })
  it('空串返回空行', () => {
    expect(wrapText('', 10)).toEqual([''])
  })
  it('不截断恰好等于宽度的行', () => {
    expect(wrapText('abcd', 4)).toEqual(['abcd'])
  })
})

describe('truncateTo', () => {
  it('不超宽时原样返回', () => {
    expect(truncateTo('abc', 10)).toBe('abc')
  })
  it('恰好填满宽度时不加省略号', () => {
    expect(truncateTo('abcdef', 4)).toBe('abcd')
  })
  it('截断后有余量时追加省略号', () => {
    // '你' 宽 2，'好' 放不下（2+2>3），余量 1 可放省略号
    expect(truncateTo('你好', 3)).toBe('你…')
  })
  it('ANSI 转义序列不计宽度', () => {
    // '\x1b[1m' 加粗 + 'ab' + '\x1b[0m'，可见宽度 2
    expect(truncateTo('\x1b[1mab\x1b[0m', 2)).toBe('\x1b[1mab\x1b[0m')
  })
  it('maxW<=0 返回空串', () => {
    expect(truncateTo('abc', 0)).toBe('')
  })
})

describe('tailByWidth', () => {
  it('取尾部且不超过宽度', () => {
    expect(tailByWidth('你好世界', 6)).toBe('好世界') // 6 宽，从尾部取
  })
  it('中文按双宽计算', () => {
    expect(tailByWidth('abcd你好', 4)).toBe('你好')
  })
})

describe('inlineMarkdown', () => {
  it('普通文本不加样式', () => {
    expect(inlineMarkdown('普通文本')).toBe('普通文本')
  })
  it('**粗体** 渲染为加粗', () => {
    expect(inlineMarkdown('这是**重点**内容')).toBe('这是\x1b[1m重点\x1b[0m内容')
  })
  it('`行内代码` 渲染为青色', () => {
    expect(inlineMarkdown('跑 `npm run build` 即可')).toBe('跑 \x1b[36mnpm run build\x1b[0m 即可')
  })
  it('标题行整行加粗', () => {
    expect(inlineMarkdown('## 小节标题')).toBe('\x1b[1m## 小节标题\x1b[0m')
  })
  it('同时包含粗体和行内代码', () => {
    const out = inlineMarkdown('用 `code` 和 **bold**')
    expect(out).toContain('\x1b[36mcode\x1b[0m')
    expect(out).toContain('\x1b[1mbold\x1b[0m')
  })
})
