/**
 * completion-menu.ts — 斜杠补全候选菜单的**纯逻辑**（FR-4，design.md §7）
 *
 * 与 `overlay.ts` 同一分层：只把「候选集合 + 查询串 + 选中项」折叠成一组待绘制的行，
 * 并把一个按键翻译成状态变更；**不持有 stdin/stdout**。TUI 只负责把行画进预留区。
 *
 * ⚠️ **高度在生命周期内恒定（V-5 的硬约束，用户拍板 2026-09-17）**
 * 浮层高度的任何变化都会触发**整区重建**（清屏 + 清 scrollback + 从 `blocks` 全量重推），
 * 是本项目最脆弱的路径。因此：
 * - `height` 在 **`createCompletionMenu()` 时**由**候选总数**算出，此后**永不改变**；
 * - `updateQuery()` 只改 `filtered`，**不碰 height** → 打字过程中的过滤只重绘预留区，零重建；
 * - 候选显示区固定为 `min(总数, MAX_MENU_ITEMS)` 行：过滤后不足的行**留空**，
 *   一条都没有时第 0 行显示 `无匹配命令` 占位 —— 行数始终不变。
 * → 整区重建只发生在菜单**出现/消失**各一次。
 *
 * 另一条硬约束：候选源在菜单**生命周期内只收集一次并缓存**（见 TUI 的 openCompletionMenu），
 * 因此 `items`（总数）也不会变 —— 否则 height 会跟着变，V-5 失守。
 *
 * ⚠️ 键位形状全部来自**真实 `readline.emitKeypressEvents` 探针**（lesson 007 / D-7，
 * B5 实测复现 B3 的结论，脚本 `node` + 每个按键独立 `PassThrough`）：
 * ```
 * '/'（可打印符号）  -> { str: '/',      name: **undefined**（无 name 字段）, sequence: '/' }
 * 'm' / 'a' / '1'    -> { str: <字符>,   name: <该字符>,   sequence: <字符> }
 * space              -> { str: ' ',     name: 'space',  sequence: ' ' }
 * Tab                -> { str: '\t',    name: 'tab',    sequence: '\t' }
 * Enter(CR)          -> { str: '\r',    name: 'return', sequence: '\r' }
 * LF(Ctrl+J)         -> { str: '\n',    name: 'enter',  sequence: '\n' }
 * Esc（单独按下）     -> { str: undefined, name: 'escape', meta: **true**, sequence: '\x1b' }
 * ↑ / ↓              -> { str: undefined, name: 'up'|'down', sequence: '\x1b[A'|'\x1b[B' }
 * paste-start / -end -> { str: undefined, name: 'paste-start'|'paste-end', sequence: ... }
 * ```
 * 结论：**路由一律以 `key.name` 为准**；只有"是否把字符放进输入框"才看 `str`；
 * `/` 是唯一一个 `name` 为 undefined 的本批按键（符号类），所以任何"必须有 name 才处理"的
 * 写法都会让 `/` 失效；反过来，Ctrl+J（name='enter'）与 Alt+Enter（name='return'+meta）
 * 必须**排除**在 Enter 之外，否则在菜单打开时插换行会变成执行命令。
 */
import { filterCandidates, type CompletionCandidate } from '../commands.js'
import { displayWidth, truncateTo } from './text.js'

// === SGR 样式（与 selector.ts / overlay.ts 同一套范式：选中项反色、提示暗灰） ===
const DIM = '\x1b[90m'
const INVERSE = '\x1b[7m'
const RESET = '\x1b[0m'

/** 候选显示区最多几行（其余靠窗口滚动；design §7） */
export const MAX_MENU_ITEMS = 8

/** 固定提示行（不随查询变化 → 不会改变宽度/行数） */
export const MENU_HINT = '↑/↓ 移动 · Tab 填入 · Enter 执行 · Esc 关闭'

/** 过滤后无候选时的占位行（否则用户会以为界面卡住，design §FR-4 边界） */
export const EMPTY_MENU_PLACEHOLDER = '无匹配命令'

/** readline keypress 的子集（与 overlay.ts 的 `OverlayKey` 同形） */
export type MenuKey = {
  name?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
}

/** 补全菜单状态。`height` 恒定（V-5），`filtered` 随查询变化 */
export type CompletionMenuState = {
  /** 菜单生命周期内的**全部**候选（打开时收集一次；总数决定 height） */
  items: CompletionCandidate[]
  /** 当前查询命中的候选（`updateQuery` 维护） */
  filtered: CompletionCandidate[]
  /** 选中下标（对 `filtered` 而言） */
  index: number
  /** 当前查询串（输入框文本去掉前导 `/`） */
  query: string
  /** 浮层行数：`min(items.length, MAX_MENU_ITEMS) + 1`，生命周期内不变 */
  height: number
}

/**
 * 按键结果：
 * - `'pass'`：不是菜单键（可打印字符、Ctrl+J、Alt+Enter）→ 交回既有输入处理，**菜单不吞字符**；
 * - `'consumed'`：菜单键且菜单继续打开（↑↓ 移动）；
 * - `{ fill }`：Tab —— 把候选写回输入框，**不提交**（AC-21）；
 * - `{ execute }`：Enter —— 把候选写回输入框并交给既有 `handleSubmit`（AC-21）；
 * - `{ close }`：Esc —— 关菜单**不清输入**（AC-22），若菜单为空则提交用户原输入（不吞 Enter）。
 *
 * `'pass'` 是对 design §7 原型签名的**必要补充**：原型只有 4 个返回值，无法表达
 * "这个字符应该进输入框"（菜单必须能被继续输入，否则过滤永远不生效）。已写入 changes.md。
 */
export type MenuKeyResult =
  | 'pass'
  | 'consumed'
  | { fill: string }
  | { execute: string }
  | { close: true }

/** 菜单行数：候选显示区 + 1 行提示。`0 个候选`也保留 1 行（TUI 不弹空菜单） */
function heightFor(total: number): number {
  return Math.min(total, MAX_MENU_ITEMS) + 1
}

/** 候选显示区行数（`items` 恒定 → 该值也恒定） */
function areaOf(m: CompletionMenuState): number {
  return Math.min(m.items.length, MAX_MENU_ITEMS)
}

/**
 * 输入框纯文本是否触发补全菜单：以 `/` 开头且**尚未敲空格**（`/ foo` 视为普通消息）。
 * 含图提交时用的是 `toText()`（纯文本），与既有 `textOfSubmit()` 的理由一致。
 */
export function isCompletionTrigger(text: string): boolean {
  return /^\/[^\s]*$/.test(text)
}

/**
 * 构造菜单：`items` 是**全部**候选（打开时收集一次），初始查询为空（列全部）。
 * height 在此确定并**冻结**（V-5）。
 */
export function createCompletionMenu(items: CompletionCandidate[]): CompletionMenuState {
  return {
    items,
    filtered: items.slice(),
    index: 0,
    query: '',
    height: heightFor(items.length),
  }
}

/**
 * 按新查询过滤（AC-20）：**选中项重置到第 0 项**，`height` 不变（V-5）。
 * 就地在原对象上更新并返回（与 `handleOverlayKey` 的就地风格一致）。
 */
export function updateQuery(m: CompletionMenuState, query: string): CompletionMenuState {
  m.query = query
  m.filtered = filterCandidates(m.items, query)
  m.index = 0
  return m
}

/** Ctrl+J（LF → name='enter'）与 Alt+Enter（return+meta）都是"插入换行"，不是提交 */
function isEnterKey(key: MenuKey): boolean {
  if (key.meta) return false
  if (key.sequence === '\n') return false
  return key.name === 'return' || key.name === 'enter'
}

/** 处理一次按键（就地更新 `m` 的 index 等） */
export function handleMenuKey(m: CompletionMenuState, _str: string | undefined, key: MenuKey): MenuKeyResult {
  const name = key?.name

  if (name === 'escape') return { close: true }

  const n = m.filtered.length
  if (name === 'up') {
    if (n > 0) m.index = (m.index - 1 + n) % n
    return 'consumed'
  }
  if (name === 'down') {
    if (n > 0) m.index = (m.index + 1) % n
    return 'consumed'
  }
  if (name === 'tab') {
    const it = m.filtered[m.index]
    return it ? { fill: it.label } : 'consumed'
  }
  if (isEnterKey(key)) {
    const it = m.filtered[m.index]
    // 无匹配时把用户原输入原样提交（`/` + query），保住"菜单没改变提交语义"这条不变量
    return { execute: it ? it.label : `/${m.query}` }
  }
  return 'pass'
}

/**
 * 渲染成**恰好 `m.height` 行**（每行不超过 cols 列）。
 * 候选显示区行数固定（`areaOf`），过滤后不足的行留空 / 首行占位 → 行数不随查询变化（V-5）。
 */
export function renderCompletionMenu(m: CompletionMenuState, cols: number): string[] {
  const w = Math.max(1, Math.floor(cols) || 1)
  const area = areaOf(m)
  const offset = windowOffset(m, area)
  const out: string[] = []

  for (let i = 0; i < area; i++) {
    const item = m.filtered[offset + i]
    if (item) {
      out.push(itemLine(item, offset + i === m.index, w))
    } else if (i === 0) {
      // 一条都没命中：占位而不是空浮层（高度不变）
      out.push(`${DIM}${truncateTo(EMPTY_MENU_PLACEHOLDER, w)}${RESET}`)
    } else {
      out.push('')
    }
  }
  out.push(`${DIM}${truncateTo(MENU_HINT, w)}${RESET}`)
  return out
}

// === 内部 ===
/** 候选窗口偏移：让选中项可见，且到列表末尾后不再下移（与 overlay.ts 的 windowOffset 同策略） */
function windowOffset(m: CompletionMenuState, area: number): number {
  const n = m.filtered.length
  if (n <= area) return 0
  if (m.index >= area) return Math.min(m.index - area + 1, n - area)
  return 0
}

/** 单项：选中整行反色；未选中主文本原色 + 副文本暗灰 */
function itemLine(item: CompletionCandidate, selected: boolean, cols: number): string {
  const plain = `${selected ? '▶ ' : '  '}${item.label}`
  if (selected) {
    const withDetail = item.detail ? `${plain}  ${item.detail}` : plain
    return `${INVERSE}${truncateTo(withDetail, cols)}${RESET}`
  }
  const used = displayWidth(plain)
  const detail = item.detail ? `${DIM}${truncateTo(`  ${item.detail}`, Math.max(0, cols - used))}${RESET}` : ''
  return `${truncateTo(plain, cols)}${detail}`
}
