import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { TUI } from './tui.js'
import { TermSim } from '../testing/term-sim.js'

const BANNER = ['banner-line-1', 'banner-line-2', '']

let term: TermSim
let ui: TUI

beforeEach(() => {
  term = new TermSim(24, 80)
  // mock stdout：TUI 的 write 全部喂给模拟器；columns/rows 由测试控制
  Object.defineProperty(process.stdout, 'columns', { value: term.cols, configurable: true })
  Object.defineProperty(process.stdout, 'rows', { value: term.rows, configurable: true })
  ;(process.stdout as any).write = (s: string) => {
    term.write(s)
    return true
  }
  ;(process.stdout as any).on = () => {}
  ;(process.stdout as any).removeListener = () => {}
  // mock stdin：EventEmitter 承载 keypress 事件
  const stdinMock = new EventEmitter() as any
  stdinMock.isTTY = true
  stdinMock.resume = () => {}
  stdinMock.pause = () => {}
  stdinMock.setRawMode = () => stdinMock
  ;(process.stdin as any).on = stdinMock.on.bind(stdinMock)
  ;(process.stdin as any).removeListener = stdinMock.removeListener.bind(stdinMock)
  ;(process.stdin as any).emit = stdinMock.emit.bind(stdinMock)
  ;(process.stdin as any).resume = stdinMock.resume
  ;(process.stdin as any).pause = stdinMock.pause
  ;(process.stdin as any).setRawMode = stdinMock.setRawMode
  ;(process.stdin as any).isTTY = true
  ;(process.stdin as any).setEncoding = stdinMock.setEncoding?.bind(stdinMock) ?? (() => {})

  ui = new TUI(BANNER)
})

afterEach(() => {
  try {
    ui.exit()
  } catch {
    // 忽略
  }
})

function press(ch: string, name: string) {
  ;(process.stdin as any).emit('keypress', ch, { name, ctrl: false, shift: false })
}

describe('TUI 端到端：界面结构', () => {
  it('enter 后渲染 banner、状态栏和输入框', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    expect(term.row(1)).toContain('banner-line-1')
    expect(term.row(18)).toContain('● Ready') // contentRows=17，状态栏在 18
    expect(term.row(19)).toContain('+-- input')
    expect(term.row(21)).toContain('+---')
  })
})

describe('TUI 端到端：对话流式渲染', () => {
  it('用户消息、思考、回答正确渲染，超一屏产生滚动历史', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    ui.addUserMessage('你好')
    ui.addThinking()
    expect(term.contains('You: 你好')).toBe(true)
    expect(term.contains('Thinking')).toBe(true)

    // 流式输出超一屏（banner3 + user1 + thinking1 + 回复 > 17 行）
    const chunk = '这是一段很长的回复内容，用来测试流式输出超过一屏后滚动历史是否正常。'
    for (let i = 0; i < 20; i++) {
      ui.appendToLast(`第${i}段${chunk}`)
    }
    expect(term.scrollCount).toBeGreaterThan(0) // 产生了滚动历史
    expect(term.contains('第19段')).toBe(true) // 最新内容可见
    // 历史 + 屏幕首行应能对上最早内容（banner 或最开始的回复）
    const all = [...term.historyText(), ...term.visible()].filter((l) => l !== '')
    expect(all[0]).toContain('banner-line-1')
  })

  it('markdown 粗体和行内代码被渲染', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    ui.addUserMessage('hi')
    for (const ch of '这是 **重点** 和 `code` 测试') ui.appendToLast(ch)
    // 模拟器屏幕里保留的是原始文本（ANSI 被剥离），文本应完整无标记符号
    expect(term.contains('这是')).toBe(true)
    expect(term.contains('重点')).toBe(true)
    expect(term.contains('code')).toBe(true)
    expect(term.contains('**')).toBe(false) // 标记被渲染掉，不应出现原样 **
  })
})

describe('TUI 端到端：resize', () => {
  it('resize 放大后重绘到底部，内容不重复', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    ui.addUserMessage('问题')
    ui.addThinking()
    for (let i = 0; i < 30; i++) ui.appendToLast(`第${i}行内容用于 resize 测试。`)
    const beforeScroll = term.scrollCount

    // 放大到 30 行：先扩展屏幕再触发 onResize
    Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true })
    term.resize(30)
    ;(ui as any).onResize()

    // 内容不重复：滚动历史 + 屏幕合计不应出现两遍 "第0行"
    const all = [...term.historyText(), ...term.visible()]
    const countZero = all.filter((l) => l.includes('第0行')).length
    expect(countZero).toBeLessThanOrEqual(1)
    expect(term.contains('第29行')).toBe(true) // 最新内容在底部
  })
})

describe('TUI 端到端：恢复会话', () => {
  it('restoreHistory 渲染历史对话', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    ui.restoreHistory([
      { role: 'user', content: '历史上的问题' },
      { role: 'assistant', content: '历史上的回答' },
    ])
    expect(term.contains('You: 历史上的问题')).toBe(true)
    expect(term.contains('历史上的回答')).toBe(true)
  })
})

describe('TUI 端到端：输入与提交', () => {
  it('键盘输入进入输入框，回车触发 onEnter', () => {
    let submitted = ''
    ui.enter({
      onEnter: (text) => {
        submitted = text
      },
      onExit: () => {},
      onInterrupt: () => {},
    })
    for (const ch of 'hello') press(ch, ch)
    expect(term.row(20)).toContain('hello')
    press('\r', 'return')
    expect(submitted).toBe('hello')
  })

  it('Enter/return 与 enter 两种键名都能提交（PTY 兼容）', () => {
    let count = 0
    ui.enter({
      onEnter: () => count++,
      onExit: () => {},
      onInterrupt: () => {},
    })
    press('a', 'a')
    press('\r', 'enter') // PTY 下 \r 可能被识别为 enter
    press('b', 'b')
    press('\r', 'return')
    expect(count).toBe(2)
  })
})
