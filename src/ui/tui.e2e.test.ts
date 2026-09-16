/**
 * tui.e2e.test.ts — TUI 端到端（ANSI 终端模拟器在进程内驱动）
 *
 * 覆盖（task-plan Step 9）：
 * - 固定高度输入框：INPUT_ROWS=5（上边框 + 3 行内容窗口 + 下边框），contentRows 不随内容变化
 * - 多行渲染与窗口自动滚动（保持光标可见）
 * - Ctrl+J / Alt+Enter 插入换行且不提交
 * - bracketed paste：整段粘贴只产生一条消息、不触发提交；超阈值折叠为占位符且提交内容完整
 * - Ctrl+V 贴图（注入假剪贴板）：图片原子进缓冲、提交为 ContentPart[]
 * - Ctrl+V 退化路径：无图且剪贴板无文本 → 缓冲不变、无提示、不提交
 * - 终端状态恢复（AC-17）：enter 开 / exit 关 bracketed paste，断言原始 stdout 写入串
 * - Ctrl+G 外部编辑器（注入假编辑器）：回填、图片占位符往返（不丢附件）、未改动视为取消、
 *   手写占位符含 `..` 被路径白名单拒绝（N-1）
 * - restoreInput：能力预检失败时回填原内容（文本 + 图片占位符）后可再次提交；
 *   仅在缓冲为空时回填，await 期间的新输入不被覆盖（N-4①）
 * - 粘贴期间不路由给选择器（N-2）、粘贴里的裸 Ctrl+C 不退出程序（N-3）
 * - 多行 addInfo 在全量重绘（rerender(0,true)）后仍逐行渲染，无阶梯错乱（N-5）
 * - 窄终端（cols=30）：超宽占位符被截断，输入框仍固定 5 行
 * - 模态选择器：接管期间按键不进输入缓冲，选中/取消后界面完整恢复
 * - 状态栏显示模型与等级（超长截断不挤掉状态文本）
 * - 原有交互回归：单行输入、历史上下、命令透传
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ContentPart } from '../tools/index.js'
import { setClipboardDeps, resetClipboardDeps } from '../clipboard.js'
import { TUI, displayWidth } from './tui.js'
import { TermSim } from '../testing/term-sim.js'

/**
 * Ctrl+G 假编辑器：真起 $EDITOR 会阻塞且依赖本机 VSCode，故在模块层替换。
 * `content` = 编辑器回读到的内容；`null` 表示模拟"编辑器不可用"。
 * 与 `editor.ts` 同语义：内容与初始值相同 → cancel（用户没改就退出）。
 */
const editorMock = vi.hoisted(() => ({ content: null as string | null }))
vi.mock('../editor.js', () => ({
  editInExternalEditor: async (initial: string) => {
    if (editorMock.content === null) return { ok: false, reason: 'error', error: '假编辑器不可用' }
    if (editorMock.content === initial) return { ok: false, reason: 'cancel' }
    return { ok: true, content: editorMock.content }
  },
}))

const BANNER = ['banner-line-1', 'banner-line-2', '']

/** 24 行终端 + INPUT_ROWS=5 → contentRows=15：状态栏 16，输入上边框 17，内容窗口 18..20，下边框 21 */
const CONTENT_ROWS = 15
const STATUS_ROW = 16
const INPUT_TOP = 17
const INPUT_FIRST = 18
const INPUT_BOT = 21

/** 最小 PNG 字节序列（内容不重要，只要能被 base64 编码成 data URL） */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let term: TermSim
let ui: TUI
let tmp: string
let origAgentDir: string | undefined
/**
 * 原始 stdout 写入串（逐次累积，未经 TermSim 解析）。
 * TermSim 会把 bracketed paste 等模式序列当控制序列吞掉（`csi` 只认 H/G/K/J/r），
 * 屏幕断言看不到 `\x1b[?2004h/l`，只能从这里断言（AC-17 的唯一可观测点）。
 */
let rawWrites: string[]

beforeEach(() => {
  // 图片落盘目录隔离（Ctrl+V 用例会真的走 images.saveImage）
  tmp = mkdtempSync(join(tmpdir(), 'agent-cli-tui-e2e-'))
  origAgentDir = process.env.AGENT_CLI_DIR
  process.env.AGENT_CLI_DIR = tmp
  editorMock.content = null

  term = new TermSim(24, 80)
  rawWrites = []
  // mock stdout：TUI 的 write 全部喂给模拟器；columns/rows 由测试控制
  Object.defineProperty(process.stdout, 'columns', { value: term.cols, configurable: true })
  Object.defineProperty(process.stdout, 'rows', { value: term.rows, configurable: true })
  ;(process.stdout as any).write = (s: string) => {
    rawWrites.push(s) // 原始串单独收集：TermSim 会吞掉模式序列（见 rawWrites 声明处注释）
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
  resetClipboardDeps()
  try {
    ui.exit()
  } catch {
    // 忽略
  }
  if (origAgentDir === undefined) delete process.env.AGENT_CLI_DIR
  else process.env.AGENT_CLI_DIR = origAgentDir
  rmSync(tmp, { recursive: true, force: true })
})

/** 模拟一次 keypress；name 可省略（粘贴内容这类无名按键），extra 可覆盖 ctrl/meta 等字段 */
function press(ch: string, name?: string, extra: Record<string, unknown> = {}) {
  ;(process.stdin as any).emit('keypress', ch, {
    name,
    ctrl: false,
    shift: false,
    meta: false,
    sequence: ch,
    ...extra,
  })
}

/** 输入一段普通字符 */
function type(s: string) {
  for (const ch of s) press(ch, ch)
}

/**
 * 模拟**真实 readline** 的 bracketed paste 事件序列。
 *
 * ⚠️ 不要用 `press(整段, undefined, {sequence: 整段})` 代替：真实 readline 从不把整段
 * 粘贴当单个 keypress，而是逐字符派发，且把其中的 \n 报成 `name='enter' + sequence='\n'`、
 * \r 报成 `name='return' + sequence='\r'`。用不真实的事件形状会掩盖真实缺陷——
 * 曾因此漏掉「粘贴中的 \n 被 Ctrl+J 分支抢先插入、提交时被 trim 掉」的 Critical 缺陷。
 */
function pasteText(s: string) {
  press('', 'paste-start', { sequence: '\x1b[200~' })
  for (const ch of s) {
    if (ch === '\n') press('\n', 'enter', { sequence: '\n' })
    else if (ch === '\r') press('\r', 'return', { sequence: '\r' })
    else press(ch, ch)
  }
  press('', 'paste-end', { sequence: '\x1b[201~' })
}

/** 等待异步按键处理（Ctrl+V 取剪贴板是 async）落地 */
async function flush() {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

/** 收集提交内容的 handler */
function collector() {
  const submitted: Array<string | ContentPart[]> = []
  return {
    submitted,
    handlers: {
      onEnter: (c: string | ContentPart[]) => submitted.push(c),
      onExit: () => {},
      onInterrupt: () => {},
    },
  }
}

/** 去掉 ANSI 转义后的显示宽度（displayWidth 不忽略转义序列，故先剥离） */
const plainWidth = (s: string) => displayWidth(s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))

/** 注入「剪贴板里有一张 PNG」的假依赖（Ctrl+V / Ctrl+G / 窄终端用例共用） */
function usePngClipboard() {
  setClipboardDeps({
    hasCommand: async (cmd: string) => cmd === 'pngpaste',
    run: async (cmd: string, args: string[]) => {
      if (cmd === 'pngpaste') writeFileSync(args[0], PNG_BYTES)
      return ''
    },
  })
}

/** 直接读 TUI 私有缓冲（e2e 断言原子级状态的既有做法，同 contentRows / selector） */
const bufferOf = (t: TUI) =>
  (t as any).buffer as { imageAtoms(): Array<{ name: string; path: string }>; toText(): string }

/** Ctrl+V 贴一张图进缓冲，返回落盘的图片原子 */
async function pasteImage(ui: TUI) {
  press('', 'v', { ctrl: true })
  await flush()
  const images = bufferOf(ui).imageAtoms()
  expect(images).toHaveLength(1)
  return images[0]
}

describe('TUI 端到端：界面结构', () => {
  it('enter 后渲染 banner、状态栏和固定 5 行输入框', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    expect(term.row(1)).toContain('banner-line-1')
    expect(term.row(STATUS_ROW)).toContain('● Ready')
    expect(term.row(INPUT_TOP)).toContain('+-- input')
    expect(term.row(INPUT_BOT)).toContain('+---')
    // 输入内容窗口恰好 3 行（18..20）
    expect(term.row(INPUT_FIRST)).toContain('| >')
    expect(term.row(INPUT_FIRST + 1)).toContain('|')
    expect(term.row(INPUT_FIRST + 2)).toContain('|')
    expect((ui as any).contentRows).toBe(CONTENT_ROWS)
  })
})

describe('TUI 端到端：终端状态恢复（AC-17，I-11）', () => {
  it('enter 开启 bracketed paste，exit 关闭（退出后终端状态恢复）', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    // 断言原始写入串而非屏幕：TermSim 不解析 `?2004h/l` 这类模式序列
    expect(rawWrites.join('')).toContain('\x1b[?2004h')

    ui.exit()

    const out = rawWrites.join('')
    expect(out).toContain('\x1b[?2004l')
    // 关闭必须发生在开启之后，否则退出时终端仍处于 bracketed paste 模式
    expect(out.lastIndexOf('\x1b[?2004l')).toBeGreaterThan(out.indexOf('\x1b[?2004h'))
  })
})

describe('TUI 端到端：对话流式渲染', () => {
  it('用户消息、思考、回答正确渲染，超一屏产生滚动历史', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    ui.addUserMessage('你好')
    ui.addThinking()
    expect(term.contains('You: 你好')).toBe(true)
    expect(term.contains('Thinking')).toBe(true)

    // 流式输出超一屏（banner3 + user1 + thinking1 + 回复 > 15 行）
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

  it('多行用户消息按行渲染（首行带 You 前缀）', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    ui.addUserMessage('第一行\n第二行')
    expect(term.contains('You: 第一行')).toBe(true)
    expect(term.contains('第二行')).toBe(true)
  })
})

describe('TUI 端到端：resize', () => {
  it('resize 放大后重绘到底部，内容不重复', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    ui.addUserMessage('问题')
    ui.addThinking()
    for (let i = 0; i < 30; i++) ui.appendToLast(`第${i}行内容用于 resize 测试。`)

    // 放大到 30 行：先扩展屏幕再触发 onResize
    Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true })
    term.resize(30)
    ;(ui as any).onResize()

    // 内容不重复：滚动历史 + 屏幕合计不应出现两遍 "第0行"
    const all = [...term.historyText(), ...term.visible()]
    const countZero = all.filter((l) => l.includes('第0行')).length
    expect(countZero).toBeLessThanOrEqual(1)
    expect(term.contains('第29行')).toBe(true) // 最新内容在底部
    // resize 后 contentRows 仍按同一公式（30 - 5 - 1 - 3 = 21）
    expect((ui as any).contentRows).toBe(21)
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

  it('restoreHistory 对含图消息渲染占位符而非空串（FR-3 验收要点）', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    ui.restoreHistory([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, name: 'shot.png' },
          { type: 'text', text: '这张图是什么' },
        ],
      },
      // 无 name 的图片部件也要有可读占位，且不能产生空的 You 行
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }] },
    ])
    expect(term.contains('[image: shot.png]')).toBe(true)
    expect(term.contains('这张图是什么')).toBe(true)
    expect(term.contains('[图片]')).toBe(true)
    // 不应出现空的 "You: " 行（修复前含图消息会渲染成空串）
    expect(term.contains('You: \n')).toBe(false)
  })
})

describe('TUI 端到端：输入与提交（回归）', () => {
  it('键盘输入进入输入框，回车触发 onEnter', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)
    type('hello')
    expect(term.row(INPUT_FIRST)).toContain('hello')
    press('\r', 'return')
    expect(submitted).toEqual(['hello'])
  })

  it('Enter/return 与 enter 两种键名都能提交（PTY 兼容）', () => {
    let count = 0
    ui.enter({ onEnter: () => count++, onExit: () => {}, onInterrupt: () => {} })
    press('a', 'a')
    press('\r', 'enter') // PTY 下 \r 可能被识别为 enter
    press('b', 'b')
    press('\r', 'return')
    expect(count).toBe(2)
  })

  it('历史 ↑/↓ 可回填与前进（单行时优先历史）', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)
    type('first')
    press('\r', 'return')
    type('second')
    press('\r', 'return')
    expect(submitted).toEqual(['first', 'second'])

    press('', 'up')
    expect(term.row(INPUT_FIRST)).toContain('second')
    press('', 'up')
    expect(term.row(INPUT_FIRST)).toContain('first')
    press('', 'down')
    expect(term.row(INPUT_FIRST)).toContain('second')
    press('', 'down')
    expect(term.row(INPUT_FIRST)).not.toContain('second')
  })

  it('命令文本原样透传给 onEnter（首尾空格被 trim）', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)
    type('  /exit ')
    press('\r', 'return')
    expect(submitted).toEqual(['/exit'])
  })

  it('空输入回车不触发 onEnter', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)
    press('\r', 'return')
    expect(submitted).toEqual([])
  })
})

describe('TUI 端到端：多行编辑', () => {
  it('Ctrl+J 插入换行且不提交，3 行窗口逐行渲染', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)

    type('aaa')
    press('\n', 'enter') // Ctrl+J：readline 报 name='enter' + sequence='\n'
    type('bbb')
    press('\n', 'enter')
    type('ccc')

    expect(submitted).toEqual([]) // 换行不提交
    expect(term.row(INPUT_FIRST)).toContain('aaa')
    expect(term.row(INPUT_FIRST + 1)).toContain('bbb')
    expect(term.row(INPUT_FIRST + 2)).toContain('ccc')
    // 内容行数变化不影响布局常量
    expect((ui as any).contentRows).toBe(CONTENT_ROWS)
    expect(term.row(STATUS_ROW)).toContain('● Ready')
    expect(term.row(INPUT_BOT)).toContain('+---')

    // 提交后内容完整（含换行）
    press('\r', 'return')
    expect(submitted).toEqual(['aaa\nbbb\nccc'])
  })

  it('Alt+Enter 插入换行且不提交', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)
    type('aa')
    press('\x1b\r', 'return', { meta: true }) // Alt+Enter
    type('bb')
    expect(submitted).toEqual([])
    expect(term.row(INPUT_FIRST)).toContain('aa')
    expect(term.row(INPUT_FIRST + 1)).toContain('bb')
    press('\r', 'return')
    expect(submitted).toEqual(['aa\nbb'])
  })

  it('超过 3 行时窗口自动滚动，保持光标可见', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    type('l0')
    press('\n', 'enter')
    type('l1')
    press('\n', 'enter')
    type('l2')
    press('\n', 'enter')
    type('l3')

    // 4 行内容：窗口下移 1 行，显示 l1/l2/l3（l0 滚出窗口）
    expect(term.row(INPUT_FIRST)).toContain('l1')
    expect(term.row(INPUT_FIRST + 1)).toContain('l2')
    expect(term.row(INPUT_FIRST + 2)).toContain('l3')
    expect(term.row(INPUT_FIRST)).not.toContain('l0')
    // 窗口滚动不改变 contentRows
    expect((ui as any).contentRows).toBe(CONTENT_ROWS)

    // ↑ 逐行上移：光标仍在窗口内时窗口不动（l1/l2/l3），直到光标越过窗口上沿才上移
    press('', 'up')
    expect(term.row(INPUT_FIRST)).toContain('l1')
    press('', 'up')
    press('', 'up') // 光标到 l0，越过窗口上沿 → 窗口上移到 l0/l1/l2
    expect(term.row(INPUT_FIRST)).toContain('l0')
    expect(term.row(INPUT_FIRST + 1)).toContain('l1')
    expect(term.row(INPUT_FIRST + 2)).toContain('l2')
  })

  it('backspace 与 ←/→ 走输入缓冲（多行下不越界）', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    type('ab')
    press('\n', 'enter')
    type('cd')
    expect(term.row(INPUT_FIRST)).toContain('ab')
    expect(term.row(INPUT_FIRST + 1)).toContain('cd')

    press('', 'backspace')
    expect(term.row(INPUT_FIRST + 1)).toContain('c')
    press('', 'left')
    press('', 'backspace') // 删到行首后不越界
    expect(term.row(INPUT_FIRST + 1)).not.toContain('c')
    expect(term.row(INPUT_FIRST)).toContain('ab')
  })
})

describe('TUI 端到端：bracketed paste', () => {
  it('整段粘贴只产生一条消息，粘贴期间不触发提交', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)

    const pasted = 'l0\nl1\nl2'
    pasteText(pasted)

    expect(submitted).toEqual([]) // 粘贴不提交
    expect(term.row(INPUT_FIRST)).toContain('l0')
    expect(term.row(INPUT_FIRST + 1)).toContain('l1')
    expect(term.row(INPUT_FIRST + 2)).toContain('l2')

    press('\r', 'return')
    expect(submitted).toEqual([pasted]) // 只有一条消息
  })

  it('粘贴中的换行必须逐字保留（真实事件形状回归：\\n 报成 enter+LF，曾被 Ctrl+J 分支抢先插入后被 trim 掉）', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)

    const pasted = 'a\nb\n\nc'
    pasteText(pasted)
    press('\r', 'return')

    expect(submitted).toEqual([pasted])
    // 显式断言换行没被丢弃、也没跑到开头
    expect(submitted[0]).toBe('a\nb\n\nc')
    expect(submitted[0]).not.toBe('abc')
  })

  it('超阈值粘贴折叠为 [粘贴 N 行] 占位符，提交内容仍是完整原文', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)

    const lines = Array.from({ length: 25 }, (_, i) => `P${i}`)
    const pasted = lines.join('\n')
    pasteText(pasted)

    expect(term.contains('[粘贴 25 行]')).toBe(true)
    expect(submitted).toEqual([])

    press('\r', 'return')
    expect(submitted).toEqual([pasted]) // 折叠只影响显示，提交内容完整
  })

  it('粘贴内容含裸 Ctrl+C（0x03）不退出程序，按字面保留（N-3）', () => {
    const { submitted, handlers } = collector()
    let exits = 0
    ui.enter({ ...handlers, onExit: () => exits++ })

    // 真实 readline 把粘贴中的 0x03 报成 {name:'c', ctrl:true, str:'\x03'}（非 paste 时才等于退出）
    press('', 'paste-start', { sequence: '\x1b[200~' })
    press('a', 'a')
    press('b', 'b')
    press('\x03', 'c', { ctrl: true })
    press('c', 'c')
    press('d', 'd')
    press('', 'paste-end', { sequence: '\x1b[201~' })

    expect(exits).toBe(0) // 粘贴期间 0x03 是数据，不是退出意图
    expect(bufferOf(ui).toText()).toBe('ab\x03cd') // 控制字符按字面保留，不丢失

    press('\r', 'return')
    expect(submitted).toEqual(['ab\x03cd'])

    // 非粘贴期间 Ctrl+C 的退出语义完全不变（该通道是刻意保留的）
    press('\x03', 'c', { ctrl: true })
    expect(exits).toBe(1)
  })

  it('bare LF（Ctrl+J）插入换行且不提交；CR（Enter）才提交', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)
    type('go')

    // 裸 LF = Ctrl+J = 插入换行（不是提交）
    press('\n', 'enter', { sequence: '\n' })
    expect(submitted).toEqual([])

    // CR = Enter = 提交；submit() 会 trim，故尾部换行被去掉
    press('\r', 'return')
    expect(submitted).toEqual(['go'])
  })
})

describe('TUI 端到端：Ctrl+V 贴图', () => {
  it('取到图片则插入图片原子，提交为 ContentPart[]', async () => {
    setClipboardDeps({
      hasCommand: async (cmd: string) => cmd === 'pngpaste',
      run: async (cmd: string, args: string[]) => {
        if (cmd === 'pngpaste') writeFileSync(args[0], PNG_BYTES)
        return ''
      },
    })

    const { submitted, handlers } = collector()
    ui.enter(handlers)
    press('', 'v', { ctrl: true })
    await flush()

    expect(term.row(INPUT_FIRST)).toContain('[image: ')

    press('\r', 'return')
    expect(submitted).toHaveLength(1)
    const content = submitted[0]
    expect(Array.isArray(content)).toBe(true)
    const parts = content as ContentPart[]
    expect(parts.some((p) => p.type === 'image_url')).toBe(true)
  })

  it('剪贴板无图时退化为文本粘贴', async () => {
    setClipboardDeps({
      hasCommand: async (cmd: string) => cmd === 'pngpaste' || cmd === 'pbpaste',
      run: async (cmd: string) => {
        if (cmd === 'pngpaste') throw new Error('no image') // 剪贴板里没有图片
        if (cmd === 'pbpaste') return 'clip-text'
        return ''
      },
    })

    const { submitted, handlers } = collector()
    ui.enter(handlers)
    press('', 'v', { ctrl: true })
    await flush()

    expect(term.row(INPUT_FIRST)).toContain('clip-text')
    press('\r', 'return')
    expect(submitted).toEqual(['clip-text'])
  })

  it('剪贴板既无图也无文本时：缓冲区不变、无提示、不提交（B-7）', async () => {
    setClipboardDeps({
      // pngpaste 可用但报「无图」→ no-image；pbpaste 可用但返回空串 → readClipboardText() 返回 null
      hasCommand: async (cmd: string) => cmd === 'pngpaste' || cmd === 'pbpaste',
      run: async (cmd: string) => {
        if (cmd === 'pngpaste') throw new Error('no image data') // 归类为 no-image（不是 failed）
        if (cmd === 'pbpaste') return '' // 空文本 → readClipboardText() 返回 null
        return ''
      },
    })

    const { submitted, handlers } = collector()
    ui.enter(handlers)
    press('', 'v', { ctrl: true })
    await flush()

    // 输入缓冲仍是空的：既没插入图片原子，也没插入文本
    expect(bufferOf(ui).toText()).toBe('')
    expect(bufferOf(ui).imageAtoms()).toEqual([])
    expect(term.row(INPUT_FIRST)).toContain('| >')
    // 这条退化路径应当静默：既不是「取图失败」，也不是「工具不可用」
    expect(term.contains('剪贴板取图')).toBe(false)

    // 回车不提交任何内容（空输入不触发 onEnter），且 TUI 仍可正常输入（没崩）
    press('\r', 'return')
    expect(submitted).toEqual([])
    type('x')
    expect(term.row(INPUT_FIRST)).toContain('x')
  })

  it('取图工具不可用时给出提示且不写入缓冲', async () => {
    setClipboardDeps({
      hasCommand: async () => false,
      run: async () => '',
    })

    const { submitted, handlers } = collector()
    ui.enter(handlers)
    press('', 'v', { ctrl: true })
    await flush()

    expect(term.contains('剪贴板取图不可用')).toBe(true)
    press('\r', 'return')
    expect(submitted).toEqual([]) // 缓冲仍为空
  })
})

describe('TUI 端到端：Ctrl+G 外部编辑器（图片占位符往返，W-5）', () => {
  it('回填后图片原子仍在：编辑器里的 [image: x] 占位符解析回图片原子', async () => {
    usePngClipboard()
    const { submitted, handlers } = collector()
    ui.enter(handlers)
    const img = await pasteImage(ui)

    // 编辑器看到的内容就是 toText()（图片降级为占位符），用户在后面补一行字
    const initial = bufferOf(ui).toText()
    expect(initial).toBe(`[image: ${img.name}]`)
    editorMock.content = `${initial}\n补充说明`
    press('', 'g', { ctrl: true })
    await flush()

    expect(bufferOf(ui).imageAtoms()).toEqual([img]) // 附件没丢，路径不变
    expect(term.contains('补充说明')).toBe(true)

    // 提交内容仍是 image_url 部件（而不是字面量文本）
    press('\r', 'return')
    const parts = submitted[0] as Array<ContentPart & Record<string, any>>
    expect(parts.map((p) => p.type)).toEqual(['image_url', 'text'])
    expect(parts[0].name).toBe(img.name)
    expect(parts[0].path).toBe(img.path)
    expect(parts[1].text).toBe('\n补充说明')
  })

  it('编辑器里删掉占位符 → 回填后图片原子随之丢弃', async () => {
    usePngClipboard()
    const { submitted, handlers } = collector()
    ui.enter(handlers)
    await pasteImage(ui)

    editorMock.content = '只剩文字'
    press('', 'g', { ctrl: true })
    await flush()

    expect(bufferOf(ui).imageAtoms()).toEqual([])
    expect(term.contains('[image: ')).toBe(false)

    press('\r', 'return')
    expect(submitted).toEqual(['只剩文字']) // 退化为纯文本提交
  })

  it('编辑器里手写的占位符：图片目录内存在则解析为图片原子，不存在则保留字面量', async () => {
    const dir = join(tmp, 'images')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manual.png'), PNG_BYTES)

    const { submitted, handlers } = collector()
    ui.enter(handlers)
    editorMock.content = '[image: manual.png][image: not-there.png]'
    press('', 'g', { ctrl: true })
    await flush()

    expect(bufferOf(ui).imageAtoms()).toEqual([{ name: 'manual.png', path: join(dir, 'manual.png') }])
    // 解析不到的占位符保持为普通文本，不静默吞掉用户输入
    expect(term.contains('[image: not-there.png]')).toBe(true)

    press('\r', 'return')
    const parts = submitted[0] as Array<ContentPart & Record<string, any>>
    expect(parts.map((p) => p.type)).toEqual(['image_url', 'text'])
    expect(parts[1].text).toBe('[image: not-there.png]')
  })

  it('占位符含 .. 时被路径白名单拒绝：不产生图片原子，按字面量保留（N-1）', async () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)

    // 足够多的 `..` 保证规范化后落在项目根与图片目录之外（path.join 在根处截断，多写无副作用）
    const evil = `[image: ${'../'.repeat(12)}etc/passwd]`
    editorMock.content = evil
    press('', 'g', { ctrl: true })
    await flush()

    // 关键断言：不能把白名单外的文件当图片读进消息（修复前会得到 path=/etc/passwd 的图片原子）
    expect(bufferOf(ui).imageAtoms()).toEqual([])
    expect((bufferOf(ui) as any).toMessageContent()).toBe(evil) // 纯文本，不含 image_url
    expect(bufferOf(ui).toText()).toBe(evil) // 保留为字面量文本，不静默吞掉用户输入

    press('\r', 'return')
    expect(submitted).toEqual([evil])
    expect(Array.isArray(submitted[0])).toBe(false)
  })

  it('编辑器内容未改动视为取消：缓冲区保持原样（图片与文字都不丢）', async () => {
    usePngClipboard()
    const { submitted, handlers } = collector()
    ui.enter(handlers)
    const img = await pasteImage(ui)
    type('看图')
    const initial = bufferOf(ui).toText()

    editorMock.content = initial // 与初始值相同 → 假编辑器返回 cancel
    press('', 'g', { ctrl: true })
    await flush()

    expect(bufferOf(ui).imageAtoms()).toEqual([img])
    expect(term.contains('[image: ')).toBe(true)
    expect(term.contains('看图')).toBe(true)

    press('\r', 'return')
    expect(submitted).toHaveLength(1)
    expect(Array.isArray(submitted[0])).toBe(true)
  })
})

describe('TUI 端到端：restoreInput（预检失败回填，W-6）', () => {
  it('回填文本与图片占位符，且可再次提交出相同内容', () => {
    const png = join(tmp, 'shot.png')
    writeFileSync(png, PNG_BYTES)
    const { submitted, handlers } = collector()
    ui.enter(handlers)

    const filled = ui.restoreInput([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, name: 'shot.png', path: png },
      { type: 'text', text: '然后呢' },
    ] as ContentPart[])
    expect(filled).toBe(true)

    // 输入框按占位符文本显示，图片原子已还原
    expect(term.row(INPUT_FIRST)).toContain('看图[image: shot.png]然后呢')

    press('\r', 'return')
    const parts = submitted[0] as Array<ContentPart & Record<string, any>>
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'text'])
    expect(parts[0].text).toBe('看图')
    expect(parts[1].name).toBe('shot.png')
    expect(parts[1].path).toBe(png)
    expect(parts[2].text).toBe('然后呢')
  })

  it('缓冲为空时回填纯文本并返回 true', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)
    expect(ui.restoreInput('新内容')).toBe(true)

    expect(term.row(INPUT_FIRST)).toContain('新内容')
    press('\r', 'return')
    expect(submitted).toEqual(['新内容'])
  })

  it('缓冲非空时不覆盖（返回 false）：await 期间的新输入不被抹掉（N-4①）', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)
    // 模拟 getCapabilities() 探测期间（最长 5s）用户已开始输入的新内容
    type('新输入')

    expect(ui.restoreInput('要回填的原内容')).toBe(false)

    expect(term.row(INPUT_FIRST)).toContain('新输入')
    expect(term.row(INPUT_FIRST)).not.toContain('要回填的原内容')
    press('\r', 'return')
    expect(submitted).toEqual(['新输入'])
  })
})

describe('TUI 端到端：多行 info 的全量重绘（N-5）', () => {
  it('addInfo 多行内容经 rerender(0,true) 后仍逐行渲染，无阶梯错乱', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    const info = '命令：\n  /exit 退出\n  /model 切换模型\n\n快捷键：\n  Ctrl+C 退出'
    ui.addInfo(info)

    // banner 占 3 行 → info 从第 4 行起连续 5 行（空行不显示）
    const EXPECTED = ['命令：', '  /exit 退出', '  /model 切换模型', '快捷键：', '  Ctrl+C 退出']
    expect(term.visible().slice(3, 8)).toEqual(EXPECTED)

    // 开关一次选择器 → closeSelector 走 rerender(0, true) 全量重绘（blocks 是唯一真源）
    ui.openSelector([{ label: 'x' }], { onPick: () => {}, onCancel: () => {} })
    press('', 'escape')

    // 修复前：整段被当作一个元素 push，内嵌 \n 被 truncateTo 原样写出 →
    // 第 4 行变成 "[tool] 命令："、后续行按 LF 的列位置阶梯缩进
    expect(term.row(4)).toBe('命令：')
    expect(term.visible().slice(3, 8)).toEqual(EXPECTED)
  })
})

describe('TUI 端到端：窄终端（I-4）', () => {
  it('cols=30 时超宽图片占位符被截断，输入框仍固定 5 行不越界', async () => {
    usePngClipboard()
    const { handlers } = collector()
    ui.enter(handlers)
    await pasteImage(ui) // 占位符 `[image: <时间戳>.png]` 宽 33 列 > 30 列终端

    // 模拟终端缩到 30 列（走真实的 resize 路径：syncSize 重新读 columns）
    term.cols = 30
    Object.defineProperty(process.stdout, 'columns', { value: 30, configurable: true })
    ;(ui as any).onResize()

    // 每行绘制文本（含 4 列前缀）都不超过终端宽度，占位符被截断而非撑破布局
    const texts = (ui as any).inputLineTexts() as string[]
    expect(texts).toHaveLength(3)
    for (const t of texts) expect(plainWidth(t)).toBeLessThanOrEqual(30)
    expect(texts[0]).toContain('[image: ')

    // 输入框仍是固定 5 行：上/下边框 + 3 行内容窗口，且内容窗口未被撑开
    expect(term.row(INPUT_TOP)).toContain('+-- input')
    expect(term.row(INPUT_BOT)).toContain('+---')
    expect(term.row(INPUT_FIRST)).toContain('| >')
    expect(term.row(INPUT_FIRST + 1).trim()).toBe('|')
    expect(term.row(INPUT_FIRST + 2).trim()).toBe('|')
    expect((ui as any).contentRows).toBe(CONTENT_ROWS)
  })
})

describe('TUI 端到端：状态栏模型信息', () => {
  it('显示当前模型与思考等级', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    ui.setModelInfo('qwen3-vl:8b-thinking', 'low')
    expect(term.row(STATUS_ROW)).toContain('● Ready · qwen3-vl:8b-thinking/low')
  })

  it('模型名过长时截断，不挤掉状态文本', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    const long = 'a-very-long-model-name-that-would-not-fit'.repeat(3)
    ui.setModelInfo(long, 'max')
    const row = term.row(STATUS_ROW)
    expect(row).toContain('● Ready') // 状态文本完整保留
    expect(row).not.toContain(long) // 模型部分被截断
    expect(row.length).toBeLessThanOrEqual(80)
  })

  it('状态切换后模型信息仍在', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    ui.setModelInfo('qwen3:8b', 'medium')
    ui.setStatus('thinking')
    expect(term.row(STATUS_ROW)).toContain('Thinking… · qwen3:8b/medium')
    ui.setStatus('ready')
    expect(term.row(STATUS_ROW)).toContain('Ready · qwen3:8b/medium')
  })
})

describe('TUI 端到端：模态选择器', () => {
  it('接管期间按键不进入输入缓冲，选中后界面完整恢复', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)

    let picked = -1
    let cancelled = 0
    ui.openSelector(
      [
        { label: 'alpha', detail: 'vision · tools' },
        { label: 'beta', detail: 'tools' },
      ],
      { onPick: (i) => (picked = i), onCancel: () => cancelled++, title: 'Select model' },
    )

    // 选择器铺满全屏：对话区被清掉
    expect(term.contains('alpha')).toBe(true)
    expect(term.contains('Select model')).toBe(true)
    expect(term.contains('banner-line-1')).toBe(false)

    // 期间输入不进入缓冲
    press('x', 'x')
    press('y', 'y')
    press('', 'down') // 选中 beta
    press('\r', 'return')

    expect(picked).toBe(1)
    expect(cancelled).toBe(0)
    // 界面从 blocks 完整重建
    expect(term.contains('banner-line-1')).toBe(true)
    expect(term.row(STATUS_ROW)).toContain('● Ready')
    expect(term.row(INPUT_TOP)).toContain('+-- input')

    // 缓冲未被污染：回车不提交
    press('\r', 'return')
    expect(submitted).toEqual([])
  })

  it('选择器打开时粘贴：不误选模型、不把粘贴内容当消息发出（N-2）', () => {
    const { submitted, handlers } = collector()
    ui.enter(handlers)

    let picked = -1
    let cancelled = 0
    ui.openSelector(
      [
        { label: 'model-a' },
        { label: 'model-b' },
      ],
      { onPick: (i) => (picked = i), onCancel: () => cancelled++, title: 'Select model' },
    )

    // 粘贴里的 \r 在修复前会被选择器当确认键（误切模型）并让剩余内容提交
    pasteText('AAA\rBBB\rCCC')

    expect(picked).toBe(-1)
    expect(cancelled).toBe(0)
    expect(submitted).toEqual([])
    // 选择器状态未被粘贴扰动，且粘贴内容不落入输入缓冲
    expect((ui as any).selector.selected).toBe(0)
    expect(bufferOf(ui).toText()).toBe('')
    expect(term.contains('Select model')).toBe(true)

    // 关闭选择器后缓冲仍为空：粘贴内容没有残留（既不误发也不延迟注入）
    press('', 'escape')
    expect(cancelled).toBe(1)
    expect(term.row(INPUT_FIRST)).toContain('| >')
    press('\r', 'return')
    expect(submitted).toEqual([])
  })

  it('Esc 取消后界面恢复', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    let picked = -1
    let cancelled = 0
    ui.openSelector([{ label: 'only' }], {
      onPick: (i) => (picked = i),
      onCancel: () => cancelled++,
    })
    expect(term.contains('only')).toBe(true)
    press('', 'escape')
    expect(cancelled).toBe(1)
    expect(picked).toBe(-1)
    expect(term.contains('banner-line-1')).toBe(true)
  })

  it('↑/↓ 循环移动，选中项用反色标记', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    ui.openSelector([{ label: 'one' }, { label: 'two' }, { label: 'three' }], {
      onPick: () => {},
      onCancel: () => {},
    })
    const sel = (ui as any).selector
    expect(sel.selected).toBe(0)
    press('', 'up') // 首项再上 → 末项（循环）
    expect(sel.selected).toBe(2)
    press('', 'down') // 末项再下 → 首项
    expect(sel.selected).toBe(0)
    // 反色标记出现在渲染结果里（选中项行）
    const lines = sel.render(80, 24)
    expect(lines.some((l: string) => l.includes('\x1b[7m') && l.includes('one'))).toBe(true)
  })

  it('接管期间的滚动区更新不破坏选择器画面，关闭后从 blocks 统一补上', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    ui.openSelector([{ label: 'keepme' }], { onPick: () => {}, onCancel: () => {} })
    expect(term.contains('keepme')).toBe(true)

    // 后台追加内容（如 agent 仍在输出）不应覆盖选择器画面
    ui.addInfo('background-note')
    expect(term.contains('keepme')).toBe(true)
    expect(term.contains('background-note')).toBe(false)

    press('', 'escape')
    expect(term.contains('background-note')).toBe(true)
    expect(term.contains('banner-line-1')).toBe(true)
  })

  it('选择器结束可立即打开下一个（模型 → 等级 的链式选择）', () => {
    ui.enter({ onEnter: () => {}, onExit: () => {}, onInterrupt: () => {} })
    let level = ''
    ui.openSelector([{ label: 'm1' }], {
      onPick: () => {
        ui.openSelector([{ label: 'low' }, { label: 'max' }], {
          onPick: (i) => (level = i === 1 ? 'max' : 'low'),
          onCancel: () => {},
          title: 'Select think level',
        })
      },
      onCancel: () => {},
    })
    press('\r', 'return') // 选 m1
    expect(term.contains('Select think level')).toBe(true)
    press('', 'down')
    press('\r', 'return')
    expect(level).toBe('max')
    expect(term.contains('banner-line-1')).toBe(true)
  })
})
