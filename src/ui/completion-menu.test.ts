/**
 * completion-menu.test.ts — FR-4 补全菜单的纯逻辑（AC-20 重置 / AC-21 fill+execute / AC-22 close）
 * 以及 **V-5 的固定高度**（height 在生命周期内不随过滤结果变化）。
 *
 * ⚠️ 键位事件形状取自真实 `readline.emitKeypressEvents` 探针（lesson 007 / D-7），
 * 形状表见 `completion-menu.ts` 文件头。两个最容易写错的点在本文件各有专门用例：
 * - `/` 是可打印字符且 **`name === undefined`**（不是空串、也不是 '/'）；
 * - Ctrl+J 的真实 `name` 也是 `'enter'`（只靠 `sequence === '\n'` 区分），Alt+Enter 是 `return+meta`。
 */
import { describe, it, expect } from 'vitest'
import type { CompletionCandidate } from '../commands.js'
import {
  EMPTY_MENU_PLACEHOLDER,
  MAX_MENU_ITEMS,
  createCompletionMenu,
  handleMenuKey,
  isCompletionTrigger,
  renderCompletionMenu,
  updateQuery,
} from './completion-menu.js'

const c = (label: string, detail?: string): CompletionCandidate => ({ label, detail, kind: 'other' })

/** 10 条候选（V-5 用例的基准形状）：/a1../a3 + /b1../b7 */
const TEN = [
  c('/a1'),
  c('/a2'),
  c('/a3'),
  c('/b1'),
  c('/b2'),
  c('/b3'),
  c('/b4'),
  c('/b5'),
  c('/b6'),
  c('/b7'),
]

// === 真实 keypress 形状 ===
const escKey = { name: 'escape', meta: true, sequence: '\x1b' }
const upKey = { name: 'up', sequence: '\x1b[A' }
const downKey = { name: 'down', sequence: '\x1b[B' }
const tabKey = { name: 'tab', sequence: '\t' }
const enterKey = { name: 'return', sequence: '\r' }
const lfKey = { name: 'enter', sequence: '\n' }
const altEnterKey = { name: 'return', meta: true, sequence: '\x1b\r' }

describe('触发条件（isCompletionTrigger）', () => {
  it('`/` 开头且未敲空格才触发', () => {
    expect(isCompletionTrigger('/')).toBe(true)
    expect(isCompletionTrigger('/he')).toBe(true)
    expect(isCompletionTrigger('/help')).toBe(true)
  })

  it('普通消息、`/ `（带空格）、空串都不触发', () => {
    expect(isCompletionTrigger('')).toBe(false)
    expect(isCompletionTrigger('hello')).toBe(false)
    expect(isCompletionTrigger('/ foo')).toBe(false)
    expect(isCompletionTrigger('/help me')).toBe(false)
    expect(isCompletionTrigger(' /help')).toBe(false)
    expect(isCompletionTrigger('/he\nlp')).toBe(false)
  })
})

describe('V-5：浮层高度在菜单生命周期内恒定', () => {
  it('height = min(候选总数, 8) + 1，且 render 行数恒等于 height', () => {
    expect(createCompletionMenu(TEN).height).toBe(MAX_MENU_ITEMS + 1) // 9
    expect(createCompletionMenu([c('/one')]).height).toBe(2)
    expect(createCompletionMenu([c('/a'), c('/b')]).height).toBe(3)
    expect(createCompletionMenu([]).height).toBe(1)
  })

  it('候选数 10 → 3 → 1：height 与渲染行数全程不变（只改行内容，多余行留空）', () => {
    const m = createCompletionMenu(TEN)
    const h = m.height
    expect(renderCompletionMenu(m, 80)).toHaveLength(h) // 10 条 → 显示 8 条 + 提示

    updateQuery(m, 'a')
    expect(m.filtered.map((x) => x.label)).toEqual(['/a1', '/a2', '/a3'])
    expect(m.height).toBe(h)
    expect(renderCompletionMenu(m, 80)).toHaveLength(h) // 3 条 → 3 行内容 + 5 行空 + 提示

    updateQuery(m, 'a1')
    expect(m.filtered.map((x) => x.label)).toEqual(['/a1'])
    expect(m.height).toBe(h)
    expect(renderCompletionMenu(m, 80)).toHaveLength(h) // 1 条 → 1 行内容 + 7 行空 + 提示

    updateQuery(m, 'zzz')
    expect(m.filtered).toEqual([])
    expect(m.height).toBe(h)
    expect(renderCompletionMenu(m, 80)).toHaveLength(h) // 0 条 → 占位行 + 空行 + 提示
  })

  it('过滤后不足的行留空；无匹配时第 0 行是占位文案（不是空浮层）', () => {
    const m = createCompletionMenu([c('/a1'), c('/a2'), c('/a3')])
    updateQuery(m, 'a1')
    const lines = renderCompletionMenu(m, 80)
    expect(lines).toHaveLength(4) // 3 行显示区 + 提示
    expect(lines[0]).toContain('/a1')
    expect(lines[1]).toBe('')
    expect(lines[2]).toBe('')
    expect(lines[3]).toContain('Tab 填入') // 提示行恒在末行

    updateQuery(m, 'zzz')
    const empty = renderCompletionMenu(m, 80)
    expect(empty).toHaveLength(4)
    expect(empty[0]).toContain(EMPTY_MENU_PLACEHOLDER)
    expect(empty[1]).toBe('')
  })
})

describe('AC-20：过滤与选中重置', () => {
  it('初始列全部、选中第 0 项', () => {
    const m = createCompletionMenu(TEN)
    expect(m.filtered).toHaveLength(10)
    expect(m.index).toBe(0)
    expect(m.query).toBe('')
  })

  it('继续输入字符后过滤生效，且选中项**重置到第一项**', () => {
    const m = createCompletionMenu(TEN)
    handleMenuKey(m, '', downKey)
    handleMenuKey(m, '', downKey)
    expect(m.index).toBe(2) // 先移开

    updateQuery(m, 'b')
    expect(m.filtered.map((x) => x.label)).toEqual(['/b1', '/b2', '/b3', '/b4', '/b5', '/b6', '/b7'])
    expect(m.index).toBe(0) // 重置（AC-20）

    updateQuery(m, 'a') // 再过滤一次也重置
    handleMenuKey(m, '', downKey)
    expect(m.index).toBe(1)
    updateQuery(m, 'a3')
    expect(m.index).toBe(0)
    expect(m.filtered.map((x) => x.label)).toEqual(['/a3'])
  })
})

describe('AC-21：↑↓ 移动 / Tab 只填入 / Enter 执行', () => {
  it('↑↓ 循环移动选中项', () => {
    const m = createCompletionMenu([c('/one'), c('/two'), c('/three')])
    expect(handleMenuKey(m, '', downKey)).toBe('consumed')
    expect(m.index).toBe(1)
    handleMenuKey(m, '', downKey)
    expect(m.index).toBe(2)
    handleMenuKey(m, '', downKey)
    expect(m.index).toBe(0) // 末项再下 → 首项
    handleMenuKey(m, '', upKey)
    expect(m.index).toBe(2) // 首项再上 → 末项
  })

  it('Tab 返回 { fill: 选中 label }（不提交由 TUI 保证）', () => {
    const m = createCompletionMenu([c('/help'), c('/memory')])
    handleMenuKey(m, '', downKey)
    expect(handleMenuKey(m, '\t', tabKey)).toEqual({ fill: '/memory' })
    // 状态不变（Tab 不移动选中、不改查询）
    expect(m.index).toBe(1)
    expect(m.filtered).toHaveLength(2)
  })

  it('Enter 返回 { execute: 选中 label }', () => {
    const m = createCompletionMenu([c('/help'), c('/memory')])
    expect(handleMenuKey(m, '\r', enterKey)).toEqual({ execute: '/help' })
    handleMenuKey(m, '', downKey)
    expect(handleMenuKey(m, '\r', enterKey)).toEqual({ execute: '/memory' })
  })

  it('无匹配时 Enter 原样提交用户输入（`/` + query），不吞掉回车', () => {
    const m = createCompletionMenu([c('/help')])
    updateQuery(m, 'zzz')
    expect(handleMenuKey(m, '\r', enterKey)).toEqual({ execute: '/zzz' })
  })

  it('无匹配时 Tab 只消费、不产生 fill', () => {
    const m = createCompletionMenu([c('/help')])
    updateQuery(m, 'zzz')
    expect(handleMenuKey(m, '\t', tabKey)).toBe('consumed')
  })

  it('候选显示区为空时 ↑↓ 不越界（height=1 的菜单）', () => {
    const m = createCompletionMenu([])
    expect(handleMenuKey(m, '', upKey)).toBe('consumed')
    expect(handleMenuKey(m, '', downKey)).toBe('consumed')
    expect(m.index).toBe(0)
  })
})

describe('AC-22：Esc 关闭且不改状态（输入保留由 TUI 保证）', () => {
  it('Esc 返回 { close: true }；查询串与选中项保持不变', () => {
    const m = createCompletionMenu([c('/help'), c('/memory')])
    updateQuery(m, 'mem')
    handleMenuKey(m, '', downKey)
    const idxBefore = m.index
    expect(handleMenuKey(m, undefined, escKey)).toEqual({ close: true })
    expect(m.query).toBe('mem') // 输入内容不因 Esc 改变
    expect(m.index).toBe(idxBefore)
    expect(m.filtered.map((x) => x.label)).toEqual(['/memory'])
  })

  it('Esc 的形状里 str 是 undefined、meta 是 true（真实探针）——不得误判为其它键', () => {
    const m = createCompletionMenu([c('/help')])
    expect(handleMenuKey(m, undefined, { name: 'escape', meta: true, sequence: '\x1b' })).toEqual({ close: true })
  })
})

describe('可打印字符与换行必须 pass（菜单不吞输入）', () => {
  it("'/' 是可打印字符且 name 为 undefined → pass（真实探针）", () => {
    const m = createCompletionMenu([c('/help')])
    expect(handleMenuKey(m, '/', { name: undefined, sequence: '/' })).toBe('pass')
  })

  it('字母/数字/空格 → pass', () => {
    const m = createCompletionMenu([c('/help')])
    expect(handleMenuKey(m, 'a', { name: 'a', sequence: 'a' })).toBe('pass')
    expect(handleMenuKey(m, '1', { name: '1', sequence: '1' })).toBe('pass')
    expect(handleMenuKey(m, ' ', { name: 'space', sequence: ' ' })).toBe('pass')
  })

  it('Ctrl+J（name=enter + sequence=\\n）是插换行 → pass，不是 Enter 执行', () => {
    const m = createCompletionMenu([c('/help')])
    expect(handleMenuKey(m, '\n', lfKey)).toBe('pass')
  })

  it('Alt+Enter（return + meta）是插换行 → pass', () => {
    const m = createCompletionMenu([c('/help')])
    expect(handleMenuKey(m, '\r', altEnterKey)).toBe('pass')
  })
})

describe('渲染：选中标记 / 窗口滚动 / 列宽截断', () => {
  it('选中项用 ▶ 标记且整行反色；非选中项只有两空格前缀', () => {
    const m = createCompletionMenu([c('/help', '显示帮助'), c('/memory', '查看记忆索引')])
    const lines = renderCompletionMenu(m, 80)
    expect(lines[0]).toContain('▶ /help')
    expect(lines[1]).toContain('  /memory')
    expect(lines[1]).not.toContain('▶')
  })

  it('候选数超过 8 时窗口滚动，选中项始终可见且不留空', () => {
    const m = createCompletionMenu(TEN)
    for (let i = 0; i < 9; i++) handleMenuKey(m, '', downKey) // 选中第 9 项（/b7）
    const lines = renderCompletionMenu(m, 80)
    expect(lines).toHaveLength(9) // 8 行显示区 + 提示
    expect(lines[7]).toContain('▶ /b7')
    expect(lines[8]).toContain('Tab 填入')
  })

  it('列宽受限时每行被截断到列宽内（不撑破预留区）', () => {
    const m = createCompletionMenu([c('/a-very-long-command-name', '一段很长的说明文字')])
    const lines = renderCompletionMenu(m, 20)
    for (const l of lines) {
      const plain = l.replace(/\x1b\[[0-9;]*m/g, '')
      expect([...plain].length).toBeLessThanOrEqual(20)
    }
  })
})
