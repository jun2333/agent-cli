/**
 * overlay.ts — 内联交互浮层的**纯逻辑**（FR-5，design.md Decision 2 / Decision 5）
 *
 * 职责边界：本模块只做「把一个交互请求折叠成一组待绘制的行」与「把一个按键翻译成状态变更」，
 * **不持有 stdin/stdout、不碰终端**（与 `selector.ts`、`input-buffer.ts` 同一分层约定）。
 * 于是 AC-24/25/26 的键位语义可以 vitest 直测，TUI 只负责把这些行画到预留区。
 *
 * 浮层画在**预留区**（输入框下边框之下，见 tui.ts 的 reservedFrom），不进滚动区：
 * - 不污染滚动历史（浮层是瞬时 UI，不该被推入 history）；
 * - 浮层开关只改 `contentRows`（预留区从 3 行扩到 height 行），内容区从 blocks 重建即可。
 *
 * 高度计算：`overlayHeight(m, cols)` = `renderOverlay(m, cols).length`。design 给的形状是
 * confirm=3 / select=min(items,8)+2 / input=3；**短文案时三者完全一致**，长文案（标题/消息）
 * 会按列宽折行而增加行数 —— 这是 lesson 010 的要求（浮层文案/权限提示/拒绝原因可能很长，
 * 断言要按整屏拼接），故高度是"最小值"而非硬常量。
 *
 * ⚠️ 键位形状来自**真实 `readline.emitKeypressEvents` 探针**（lesson 007 / D-7），不是凭直觉构造：
 * ```
 * y / n / A / 3 / space / '/'  -> { str: <该字符>, name: 'y'|'n'|'a'|'3'|'space'|undefined, sequence: <该字符> }
 * Tab                          -> { str: '\t', name: 'tab', sequence: '\t' }
 * Enter(CR)                    -> { str: '\r', name: 'return', sequence: '\r' }
 * LF(Ctrl+J)                   -> { str: '\n', name: 'enter', sequence: '\n' }
 * Ctrl+C                       -> { str: '\x03', name: 'c', ctrl: true, sequence: '\x03' }
 * Backspace(DEL 0x7f)          -> { str: '\x7f', name: 'backspace', sequence: '\x7f' }
 * Esc（单独按下，~500ms 后）    -> { str: undefined, name: 'escape', meta: **true**, sequence: '\x1b' }
 * ↑ / ↓                        -> { str: undefined, name: 'up'|'down', sequence: '\x1b[A'|'\x1b[B' }
 * paste-start / paste-end      -> { str: undefined, name: 'paste-start'|'paste-end', sequence: ... }
 * ```
 * 结论：**路由一律以 `key.name` 为准**，只有"可打印字符进了 manual/value"才读 `str`；
 * 且 lone Esc 的 `meta` 是 **true**，任何按 `!key.meta` 过滤可打印字符的写法都会把它误判（这里不用 meta）。
 * 注意箭头/Esc/粘贴事件的 `str` 是 `undefined`（不是空串），`isPrintable` 必须容忍。
 */
import type { InteractionSpec, OverlaySubmit } from '../interaction.js'
import { displayWidth, truncateTo, wrapText } from './text.js'

// === SGR 样式（与 selector.ts 同一套范式：选中项反色、提示暗灰） ===
const DIM = '\x1b[90m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'
const INVERSE = '\x1b[7m'

/** select 形态最多显示多少项（其余靠窗口滚动；design §3） */
export const MAX_OVERLAY_ITEMS = 8

/** 创建时的默认列宽（仅用于填 `m.height` 的初值；TUI 用 overlayHeight(m, cols) 取实际值） */
const DEFAULT_COLS = 80

/** readline keypress 的子集（与 selector.ts 的 `SelectorKey` 同形） */
export type OverlayKey = {
  name?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
}

/** 浮层可变状态（纯数据；`handleOverlayKey` 原地修改并返回结果） */
export type OverlayModel = {
  kind: 'confirm' | 'select' | 'input'
  title: string
  message?: string
  placeholder?: string
  items: { label: string; detail?: string }[]
  /** select 当前选中下标 */
  index: number
  /** select 开启手动输入时用户键入的自由文本（AC-26） */
  manual: string
  allowManualInput: boolean
  /** input 形态的值与光标（UTF-16 下标） */
  value: string
  cursor: number
  /** confirm 的 Enter 默认值 */
  defaultYes: boolean
  /** 由 `createOverlay` 按默认列宽估算；TUI 应以 `overlayHeight(m, cols)` 为准 */
  height: number
}

/** `consumed` = 已处理但浮层未结束；`submit` = 用户确认；`cancel` = 用户取消（Esc） */
export type OverlayKeyResult = 'consumed' | { submit: OverlaySubmit } | { cancel: true }

/** 按规格构造浮层模型（三种形态，AC-24） */
export function createOverlay(spec: InteractionSpec, cols = DEFAULT_COLS): OverlayModel {
  const base = {
    title: spec.title,
    items: [] as OverlayModel['items'],
    index: 0,
    manual: '',
    allowManualInput: false,
    value: '',
    cursor: 0,
    defaultYes: true,
    height: 0,
  }
  let m: OverlayModel
  if (spec.kind === 'select') {
    m = {
      ...base,
      kind: 'select',
      items: spec.items,
      allowManualInput: spec.allowManualInput === true,
    }
  } else if (spec.kind === 'input') {
    m = { ...base, kind: 'input', message: spec.message, placeholder: spec.placeholder }
  } else {
    m = { ...base, kind: 'confirm', message: spec.message, defaultYes: spec.defaultYes ?? true }
  }
  m.height = overlayHeight(m, cols)
  return m
}

/** 浮层实际高度（行数）：`renderOverlay` 的行数，随列宽折行变化 */
export function overlayHeight(m: OverlayModel, cols: number): number {
  return renderOverlay(m, cols).length
}

/**
 * 处理一次按键并就地更新模型。
 * 往返约定：`'consumed'` / `{ submit }` / `{ cancel: true }`。
 */
export function handleOverlayKey(m: OverlayModel, str: string | undefined, key: OverlayKey): OverlayKeyResult {
  const name = key?.name

  if (m.kind === 'confirm') {
    if (name === 'escape') return { cancel: true }
    // Enter 取 defaultYes；y/n 是显式覆盖
    if (name === 'return' || name === 'enter') return { submit: { kind: 'confirm', value: m.defaultYes } }
    if (str === 'y' || str === 'Y') return { submit: { kind: 'confirm', value: true } }
    if (str === 'n' || str === 'N') return { submit: { kind: 'confirm', value: false } }
    return 'consumed'
  }

  if (m.kind === 'input') {
    if (name === 'escape') return { cancel: true }
    if (name === 'return' || name === 'enter') return { submit: { kind: 'input', value: m.value } }
    if (name === 'backspace') {
      if (m.cursor > 0) {
        m.value = m.value.slice(0, m.cursor - 1) + m.value.slice(m.cursor)
        m.cursor--
      }
      return 'consumed'
    }
    if (name === 'left') {
      if (m.cursor > 0) m.cursor--
      return 'consumed'
    }
    if (name === 'right') {
      if (m.cursor < m.value.length) m.cursor++
      return 'consumed'
    }
    if (isPrintable(str)) {
      m.value = m.value.slice(0, m.cursor) + str + m.value.slice(m.cursor)
      m.cursor += str.length
      return 'consumed'
    }
    return 'consumed'
  }

  // === select ===
  const n = m.items.length
  if (name === 'escape') return { cancel: true }
  if (name === 'up') {
    if (n > 0) m.index = (m.index - 1 + n) % n // 循环：首项再上 → 末项
    return 'consumed'
  }
  if (name === 'down') {
    if (n > 0) m.index = (m.index + 1) % n
    return 'consumed'
  }
  if (name === 'backspace') {
    if (m.allowManualInput && m.manual) m.manual = m.manual.slice(0, -1)
    return 'consumed'
  }
  if (name === 'return' || name === 'enter') {
    // 手动输入非空 → 提交自定义答案（AC-26）；否则提交选中项
    if (m.allowManualInput && m.manual.trim()) {
      return { submit: { kind: 'select', index: m.index, label: m.items[m.index]?.label ?? '', manual: m.manual } }
    }
    if (n === 0) return { cancel: true } // 空列表无可选项：Enter 视为取消（同 Selector）
    return { submit: { kind: 'select', index: m.index, label: m.items[m.index]?.label ?? '' } }
  }
  if (m.allowManualInput && isPrintable(str)) {
    m.manual += str
    return 'consumed'
  }
  return 'consumed'
}

/**
 * 渲染成恰好 `overlayHeight(m, cols)` 行（每行不超过 cols 列）。
 * 纯字符串计算，不写 stdout —— TUI 负责定位（CUP + EL + write）。
 */
export function renderOverlay(m: OverlayModel, cols: number): string[] {
  const w = Math.max(1, Math.floor(cols) || 1)
  const out: string[] = []

  // 标题可能很长（权限原因 / hook 命令全文）→ 折行（lesson 010）
  for (const l of wrapText(m.title, w)) out.push(`${BOLD}${CYAN}${truncateTo(l, w)}${RESET}`)

  if (m.kind === 'confirm') {
    // 消息行恒占 1 行（缺省为空行），使短文案时高度恰为 design 的 3
    const msg = m.message ? wrapText(m.message, w) : ['']
    for (const l of msg) out.push(l ? truncateTo(l, w) : '')
    out.push(dim(truncateTo(`y / n · Enter(${m.defaultYes ? 'y' : 'n'}) · Esc 取消`, w)))
    return out
  }

  if (m.kind === 'input') {
    if (m.message) for (const l of wrapText(m.message, w)) out.push(truncateTo(l, w))
    out.push(inputLine(m, w))
    out.push(dim(truncateTo('Enter 提交 · Esc 取消', w)))
    return out
  }

  // === select ===
  const area = Math.min(m.items.length, MAX_OVERLAY_ITEMS)
  const offset = windowOffset(m, area)
  for (let i = 0; i < area; i++) {
    out.push(itemLine(m.items[offset + i], offset + i === m.index, w))
  }
  // 手动输入直接显示在提示行（不额外占行 → 高度在交互期间恒定，避免 DECSTBM 反复重建）
  const hint = m.allowManualInput
    ? m.manual
      ? `自定义输入：${m.manual}`
      : '↑/↓ 选择 · 直接键入自定义答案 · Enter 确认 · Esc 取消'
    : '↑/↓ 移动 · Enter 确认 · Esc 取消'
  out.push(dim(truncateTo(hint, w)))
  return out
}

// === 内部 ===

function dim(s: string): string {
  return `${DIM}${s}${RESET}`
}

/**
 * 可打印字符判定。四个边界都来自真实探针（见文件头）：
 * - 箭头/Esc/粘贴事件的 `str` 是 `undefined`（不是空串）；
 * - Tab 是 `'\t'`、Enter 是 `'\r'` / `'\n'`、Backspace 是 `'\x7f'`，都是控制字符；
 * - 空格是 `' '`，必须算可打印；
 * - 代理对（emoji）`str.length === 2`，也必须算一个可打印输入。
 */
function isPrintable(str: string | undefined): str is string {
  return typeof str === 'string' && str.length > 0 && !/[\x00-\x1f\x7f]/.test(str)
}

/** select 的窗口偏移：让选中项可见，且到列表末尾后不再下移（不留空） */
function windowOffset(m: OverlayModel, area: number): number {
  const n = m.items.length
  if (n <= area) return 0
  if (m.index >= area) return Math.min(m.index - area + 1, n - area)
  return 0
}

/** select 单项：选中整行反色；未选中主文本原色 + 副文本暗灰 */
function itemLine(item: { label: string; detail?: string } | undefined, selected: boolean, cols: number): string {
  if (!item) return ''
  const plain = `${selected ? '▶ ' : '  '}${item.label}`
  if (selected) {
    const withDetail = item.detail ? `${plain}  ${item.detail}` : plain
    return `${INVERSE}${truncateTo(withDetail, cols)}${RESET}`
  }
  const used = displayWidth(plain)
  const detail = item.detail ? `${DIM}${truncateTo(`  ${item.detail}`, Math.max(0, cols - used))}${RESET}` : ''
  return `${truncateTo(plain, cols)}${detail}`
}

/** input 的编辑行：光标处字符反色；空值显示 placeholder（暗灰） */
function inputLine(m: OverlayModel, cols: number): string {
  if (!m.value) {
    const ph = m.placeholder ? truncateTo(m.placeholder, Math.max(1, cols - 2)) : ''
    return `${DIM}${ph}${RESET}${INVERSE} ${RESET}`
  }
  const plain = truncateTo(m.value, Math.max(1, cols - 1))
  const { before, at, after } = splitAtIndex(plain, m.cursor)
  return `${before}${INVERSE}${at}${RESET}${after}`
}

/** 按 UTF-16 下标切出 [前, 光标处字符, 后]；越界时光标处用空格占位（反色块可见） */
function splitAtIndex(s: string, idx: number): { before: string; at: string; after: string } {
  const i = Math.max(0, Math.min(idx, s.length))
  if (i >= s.length) return { before: s, at: ' ', after: '' }
  const cp = s.codePointAt(i)!
  const len = cp > 0xffff ? 2 : 1
  return { before: s.slice(0, i), at: s.slice(i, i + len), after: s.slice(i + len) }
}
