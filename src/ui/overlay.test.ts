/**
 * overlay.test.ts — 内联浮层纯逻辑（FR-5）
 *
 * 覆盖 AC-24（三形态 + allowManualInput）、AC-25 的 confirm 键位语义、AC-26 的 select
 * 键位语义与手动输入，以及渲染/高度/折行（lesson 010：长文案按列宽折行）。
 *
 * ⚠️ 按键事件形状一律取自**真实 `readline.emitKeypressEvents` 探针**（lesson 007 / D-7），
 * 见 overlay.ts 文件头的形状表；不得用"整段字符串当单个 keypress"或凭直觉构造：
 * - 箭头/Esc 的 `str` 是 `undefined`（不是空串）；
 * - lone Esc 的 `meta` 是 **true**；
 * - Tab 是 `'\t'`（name='tab'）、Enter 是 `'\r'`（name='return'）、Backspace 是 `'\x7f'`。
 */
import { describe, it, expect } from 'vitest'
import { MAX_OVERLAY_ITEMS, createOverlay, handleOverlayKey, overlayHeight, renderOverlay, type OverlayKey, type OverlayModel } from './overlay.js'
import { displayWidth } from './text.js'

/** 真实 readline 的按键形状（探针结果，见 overlay.ts 文件头） */
const K = {
  printable: (ch: string): [string, OverlayKey] => [ch, { name: ch, ctrl: false, meta: false, shift: false, sequence: ch }],
  tab: ['\t', { name: 'tab', ctrl: false, meta: false, shift: false, sequence: '\t' }] as [string, OverlayKey],
  enter: ['\r', { name: 'return', ctrl: false, meta: false, shift: false, sequence: '\r' }] as [string, OverlayKey],
  lf: ['\n', { name: 'enter', ctrl: false, meta: false, shift: false, sequence: '\n' }] as [string, OverlayKey],
  // lone Esc：真实 readline 等 ~500ms 后发 {name:'escape', meta:true}，且 str 为 undefined
  esc: [undefined as unknown as string, { name: 'escape', meta: true, sequence: '\x1b' }] as [string, OverlayKey],
  up: [undefined as unknown as string, { name: 'up', sequence: '\x1b[A' }] as [string, OverlayKey],
  down: [undefined as unknown as string, { name: 'down', sequence: '\x1b[B' }] as [string, OverlayKey],
  left: [undefined as unknown as string, { name: 'left', sequence: '\x1b[D' }] as [string, OverlayKey],
  right: [undefined as unknown as string, { name: 'right', sequence: '\x1b[C' }] as [string, OverlayKey],
  backspace: ['\x7f', { name: 'backspace', sequence: '\x7f' }] as [string, OverlayKey],
  space: [' ', { name: 'space', sequence: ' ' }] as [string, OverlayKey],
}

/** 派发一次真实形状的按键 */
function press(m: OverlayModel, [str, key]: [string, OverlayKey]) {
  return handleOverlayKey(m, str, key)
}

/** 去掉 ANSI 转义（断言用） */
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
/**
 * 与 `truncateTo` **同一宽度模型**的宽度：它把省略号 `…` 当 1 列（终端里 East Asian
 * Ambiguous 绝大多数是窄的），而 `displayWidth` 把任何 cp>0x7f 都算 2 列。用本函数断言
 * 才是在验证"渲染器的列宽预算"，而不是在验证两套模型的差异（该差异是 text.ts 既有行为，
 * 不在 B3 范围内改动；已在 changes.md 记为观察项）。
 */
const renderWidth = (s: string) => displayWidth(plain(s).replace(/…/g, '?'))

describe('浮层 AC-24：三种形态与 allowManualInput', () => {
  it('confirm / select / input 三种形态都能构造，且高度符合形状定义', () => {
    const confirm = createOverlay({ kind: 'confirm', title: '确认？' })
    expect(confirm.kind).toBe('confirm')
    expect(confirm.height).toBe(3) // 标题 + 消息行 + 提示

    const select = createOverlay({ kind: 'select', title: '选择', items: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] })
    expect(select.kind).toBe('select')
    expect(select.height).toBe(5) // min(3,8) + 2

    const input = createOverlay({ kind: 'input', title: '输入' })
    expect(input.kind).toBe('input')
    expect(input.height).toBe(3)
  })

  it('select 高度按 min(items, MAX_OVERLAY_ITEMS) + 2 封顶', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ label: `i${i}` }))
    expect(createOverlay({ kind: 'select', title: 'x', items }).height).toBe(MAX_OVERLAY_ITEMS + 2)
    expect(createOverlay({ kind: 'select', title: 'x', items: [] }).height).toBe(2) // 空列表：标题 + 提示
  })

  it('select.allowManualInput 被保留（缺省 false，显式 true 生效）', () => {
    const off = createOverlay({ kind: 'select', title: 'x', items: [{ label: 'a' }] })
    expect(off.allowManualInput).toBe(false)
    const on = createOverlay({ kind: 'select', title: 'x', items: [{ label: 'a' }], allowManualInput: true })
    expect(on.allowManualInput).toBe(true)
  })

  it('confirm.defaultYes 缺省为 true，显式 false 生效；input 保留 placeholder', () => {
    expect(createOverlay({ kind: 'confirm', title: 'x' }).defaultYes).toBe(true)
    expect(createOverlay({ kind: 'confirm', title: 'x', defaultYes: false }).defaultYes).toBe(false)
    expect(createOverlay({ kind: 'input', title: 'x', placeholder: '在此输入' }).placeholder).toBe('在此输入')
  })
})

describe('浮层 AC-25：confirm 的 y / n / Enter / Esc', () => {
  const mk = (defaultYes?: boolean) => createOverlay({ kind: 'confirm', title: '确认？', defaultYes })

  it('y/Y → true，n/N → false', () => {
    expect(press(mk(), K.printable('y'))).toEqual({ submit: { kind: 'confirm', value: true } })
    expect(press(mk(), K.printable('Y'))).toEqual({ submit: { kind: 'confirm', value: true } })
    expect(press(mk(), K.printable('n'))).toEqual({ submit: { kind: 'confirm', value: false } })
    expect(press(mk(), K.printable('N'))).toEqual({ submit: { kind: 'confirm', value: false } })
  })

  it('Enter（return 与 enter 两种真实键名）→ defaultYes（缺省 true）', () => {
    expect(press(mk(), K.enter)).toEqual({ submit: { kind: 'confirm', value: true } })
    expect(press(mk(), K.lf)).toEqual({ submit: { kind: 'confirm', value: true } })
    expect(press(mk(false), K.enter)).toEqual({ submit: { kind: 'confirm', value: false } })
    expect(press(mk(false), K.lf)).toEqual({ submit: { kind: 'confirm', value: false } })
  })

  it('Esc → 取消（真实形状 meta=true 也必须识别）', () => {
    expect(press(mk(), K.esc)).toEqual({ cancel: true })
  })

  it('其它可打印字符 / Tab 被消费但不结束浮层', () => {
    expect(press(mk(), K.printable('x'))).toBe('consumed')
    expect(press(mk(), K.tab)).toBe('consumed')
    expect(press(mk(), K.up)).toBe('consumed')
  })
})

describe('浮层 AC-26：select 的 ↑↓ / Enter / Esc 与手动输入', () => {
  const items = [{ label: 'A', detail: '第一' }, { label: 'B' }, { label: 'C' }]

  it('↑/↓ 循环移动，Enter 提交选中项', () => {
    const m = createOverlay({ kind: 'select', title: '选一个', items })
    expect(m.index).toBe(0)
    press(m, K.up) // 首项再上 → 末项
    expect(m.index).toBe(2)
    press(m, K.down) // 末项再下 → 首项
    expect(m.index).toBe(0)
    press(m, K.down)
    expect(press(m, K.enter)).toEqual({ submit: { kind: 'select', index: 1, label: 'B' } })
    expect(press(m, K.lf)).toEqual({ submit: { kind: 'select', index: 1, label: 'B' } })
  })

  it('Esc → 取消；空列表 Enter 也视为取消（无越界下标）', () => {
    expect(press(createOverlay({ kind: 'select', title: 'x', items }), K.esc)).toEqual({ cancel: true })
    expect(press(createOverlay({ kind: 'select', title: 'x', items: [] }), K.enter)).toEqual({ cancel: true })
  })

  it('未开启 allowManualInput：可打印字符被消费但不提交、不进 manual、不改变选中', () => {
    const m = createOverlay({ kind: 'select', title: 'x', items })
    expect(press(m, K.printable('z'))).toBe('consumed')
    expect(press(m, K.space)).toBe('consumed')
    expect(m.manual).toBe('')
    expect(m.index).toBe(0)
    expect(press(m, K.enter)).toEqual({ submit: { kind: 'select', index: 0, label: 'A' } })
  })

  it('开启 allowManualInput：可直接键入自由文本并提交 {index,label,manual}（AC-26）', () => {
    const m = createOverlay({ kind: 'select', title: 'x', items, allowManualInput: true })
    press(m, K.printable('c'))
    press(m, K.printable('u'))
    press(m, K.printable('s'))
    press(m, K.printable('t'))
    press(m, K.printable('o'))
    press(m, K.printable('m'))
    expect(m.manual).toBe('custom')
    // 手动输入非空 → Enter 提交 manual（index/label 仍是当前选中项，便于调用方记录上下文）
    expect(press(m, K.enter)).toEqual({ submit: { kind: 'select', index: 0, label: 'A', manual: 'custom' } })
  })

  it('allowManualInput：backspace 删除一个字符；删空后 Enter 回到选中项提交（不带 manual 字段）', () => {
    const m = createOverlay({ kind: 'select', title: 'x', items, allowManualInput: true })
    press(m, K.printable('a'))
    press(m, K.printable('b'))
    press(m, K.backspace)
    expect(m.manual).toBe('a')
    press(m, K.backspace)
    expect(m.manual).toBe('')
    expect(press(m, K.enter)).toEqual({ submit: { kind: 'select', index: 0, label: 'A' } })
  })

  it('allowManualInput：↑↓ 仍移动选中项（也不把控制字符写进 manual）', () => {
    const m = createOverlay({ kind: 'select', title: 'x', items, allowManualInput: true })
    press(m, K.down)
    press(m, K.up)
    press(m, K.up)
    expect(m.index).toBe(2)
    expect(m.manual).toBe('')
  })
})

describe('浮层：input 形态的编辑键位', () => {
  const mk = () => createOverlay({ kind: 'input', title: '输入', placeholder: '默认值' })

  it('可打印字符插入、backspace 删除、←/→ 移动光标、Enter 提交、Esc 取消', () => {
    const m = mk()
    press(m, K.printable('a'))
    press(m, K.printable('b'))
    press(m, K.printable('c'))
    expect(m.value).toBe('abc')
    expect(m.cursor).toBe(3)

    press(m, K.left)
    press(m, K.left)
    expect(m.cursor).toBe(1)
    press(m, K.printable('X'))
    expect(m.value).toBe('aXbc')
    expect(m.cursor).toBe(2)

    press(m, K.backspace)
    expect(m.value).toBe('abc')
    press(m, K.right)
    expect(m.cursor).toBe(2)

    expect(press(m, K.enter)).toEqual({ submit: { kind: 'input', value: 'abc' } })
    expect(press(mk(), K.esc)).toEqual({ cancel: true })
  })
})

describe('浮层：渲染（行数 / 列宽 / 折行 / 窗口滚动）', () => {
  it('renderOverlay 行数恒等于 overlayHeight（confirm/select/input）', () => {
    for (const spec of [
      { kind: 'confirm' as const, title: '确认？', message: '要执行吗' },
      { kind: 'select' as const, title: '选', items: [{ label: 'a' }, { label: 'b' }] },
      { kind: 'input' as const, title: '写点什么' },
    ]) {
      const m = createOverlay(spec)
      expect(renderOverlay(m, 80)).toHaveLength(overlayHeight(m, 80))
    }
  })

  it('每行不超列宽（含中文双宽）', () => {
    const m = createOverlay(
      {
        kind: 'select',
        title: '这是一个很长的中文标题用于测试列宽',
        items: [{ label: '中文选项一', detail: '中文细节' }, { label: '中文选项二' }],
      },
      20,
    )
    for (const l of renderOverlay(m, 20)) expect(renderWidth(l)).toBeLessThanOrEqual(20)
  })

  it('长标题/长消息按列宽折行且内容不丢（lesson 010，断言整段拼接而非单行）', () => {
    const long = '这是一段非常长的提示文案'.repeat(6) // 12 字 × 6 = 72 字 ≈ 144 列
    const m = createOverlay({ kind: 'confirm', title: long, message: '要不要继续？' }, 20)
    const lines = renderOverlay(m, 20)
    // 折行后高度超过形状最小值（3），证明没有把长文案整行截断
    expect(lines.length).toBeGreaterThan(3)
    const joined = lines.map(plain).join('')
    expect(joined).toContain(long) // 整段可复原：折行不丢字符
    expect(joined).toContain('要不要继续？')
  })

  it('select 窗口跟随选中项滚动（选中项始终可见）', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ label: `item-${i}` }))
    const m = createOverlay({ kind: 'select', title: '选', items })
    for (let i = 0; i < 9; i++) press(m, K.down) // index=9
    const lines = renderOverlay(m, 80).map(plain)
    // 首行是标题，末行是提示；中间 8 行是窗口内的项
    expect(lines[0]).toContain('选')
    expect(lines.some((l) => l.startsWith('▶ item-9'))).toBe(true) // 选中项可见（窗口末项）
    expect(lines.some((l) => l.includes('item-2'))).toBe(true) // 窗口首项（offset=2）
    expect(lines.some((l) => l.includes('item-0'))).toBe(false) // 溢出项已滚出窗口
    expect(lines).toHaveLength(MAX_OVERLAY_ITEMS + 2)
  })

  it('select 选中项用反色标记；allowManualInput 的已输入文本渲染在提示行', () => {
    const m = createOverlay({ kind: 'select', title: '选', items: [{ label: 'alpha' }], allowManualInput: true })
    expect(renderOverlay(m, 80).some((l) => l.includes('\x1b[7m') && l.includes('alpha'))).toBe(true)
    press(m, K.printable('q'))
    expect(renderOverlay(m, 80).map(plain).join('')).toContain('自定义输入：q')
  })

  it('input 为空时渲染 placeholder；有值时渲染光标反色', () => {
    const m = createOverlay({ kind: 'input', title: '输入', placeholder: '默认值' })
    expect(renderOverlay(m, 80).map(plain).join('')).toContain('默认值')
    press(m, K.printable('h'))
    press(m, K.printable('i'))
    const line = renderOverlay(m, 80).find((l) => l.includes('\x1b[7m'))!
    expect(plain(line)).toContain('hi')
  })
})
