/**
 * commands.ts — 斜杠命令与补全候选的**纯逻辑**（FR-4，design.md §7）
 *
 * 职责边界（与 `ui/completion-menu.ts`、`ui/overlay.ts` 同一分层约定）：
 * 本模块只做「候选从哪来、怎么过滤、怎么注册源」，**不碰 stdin/stdout、不持有终端状态**。
 * 于是 AC-19（候选集合）与 AC-20（过滤与选中重置）可以 vitest 直测，
 * TUI 只负责把候选渲染成行、把键位翻译成状态变更。
 *
 * 两条刻意的设计约束：
 * 1. **`CommandSpec.name` 含前导 `/`**，且它的 `run` 就是命令表的 Map 值 ——
 *    命令表与候选列表同源（新增命令只写一处），这是 "元数据是消费方唯一来源" 在 FR-4 的体现。
 * 2. **`CompletionSource` 是 P4 技能系统的全部扩展点**：P4 只需
 *    `registry.register({ id: 'skills', list })` 即可让技能出现在 `/` 候选中（AC-23）。
 *    本任务只注册 `builtin` 一个源，**不实现任何技能扫描**。
 *
 * ⚠️ `filterCandidates` 的匹配口径：一律按 `label` **去掉前导 `/`** 后比较（大小写不敏感）。
 * 因为输入框里的查询串是 `/` 之后的部分（如 `/he` → query=`he`），而候选 `label` 是完整命令
 * （`/help`）。若拿 query 直接与 `/help` 比，`startsWith` 永远匹配不上（`/help` 不以 `he` 开头）。
 */
/**
 * 一条斜杠命令。`name` **含前导 `/`**（既是命令表的 Map key，也是补全候选的 label）——
 * 命令表与候选列表同源，新增命令只写一处。
 */
export type CommandSpec = {
  name: string
  description: string
  run: () => void | Promise<void>
}

/** 候选来源分类（`source` 的语义扩展；本期只会出现 `builtin`） */
export type CompletionKind = 'builtin' | 'skill' | 'other'

/**
 * 一条补全候选。
 * `label` 是**要写回输入框的完整文本**（含前导 `/`）—— Tab/Enter 都直接把它填进去，
 * 所以它必须自带 `/`，否则填入后命令前缀会丢失。
 */
export type CompletionCandidate = {
  label: string
  detail?: string
  kind: CompletionKind
}

/**
 * 候选源（P4 技能系统的扩展点，见 design §7）。
 * `list()` 允许返回 Promise（P4 需扫磁盘）；TUI 在**菜单打开时收集一次并缓存整个菜单生命周期**
 * （design §7 的明确要求，也是「浮层高度恒定」V-5 的前提）。
 */
export type CompletionSource = {
  id: string
  list(): CompletionCandidate[] | Promise<CompletionCandidate[]>
}

/**
 * 候选源注册表：聚合多个源，**单个源抛错只跳过该源**（候选是增强，不阻断输入）。
 * `collect()` 的顺序 = 注册顺序，每个源内部的顺序原样保留（稳定序，便于断言）。
 */
export class CompletionRegistry {
  private sources: CompletionSource[] = []

  /** 注册；同 id 重复注册 = 替换（避免 P4 重复 register 造成候选重复） */
  register(src: CompletionSource): void {
    this.unregister(src.id)
    this.sources.push(src)
  }

  unregister(id: string): void {
    this.sources = this.sources.filter((s) => s.id !== id)
  }

  /** 当前已注册源数（只读，观测用） */
  get size(): number {
    return this.sources.length
  }

  /**
   * 聚合全部源。`list()` 同步抛错或异步 reject 都被吞掉（跳过该源）——
   * 技能扫盘失败不该让 `/` 菜单整体消失。
   */
  async collect(): Promise<CompletionCandidate[]> {
    const out: CompletionCandidate[] = []
    for (const src of [...this.sources]) {
      try {
        const items = await src.list()
        if (Array.isArray(items)) out.push(...items)
      } catch {
        // 单源失败只跳过：候选是增强，不阻断输入
      }
    }
    return out
  }
}

/** 命令规格 → 候选（同源：命令表与候选列表不会漂移） */
export function builtinCandidates(specs: CommandSpec[]): CompletionCandidate[] {
  return specs.map((s) => ({ label: s.name, detail: s.description, kind: 'builtin' as const }))
}

/** 由命令规格构造内置候选源（id 固定 `builtin`，P4 追加技能源时两者并列） */
export function createBuiltinSource(specs: CommandSpec[]): CompletionSource {
  const candidates = builtinCandidates(specs)
  return { id: 'builtin', list: () => candidates }
}

/** 候选 label 的匹配键：去掉前导 `/` 并小写（见文件头口径说明） */
function matchKey(label: string): string {
  return label.replace(/^\//, '').toLowerCase()
}

/** 查询串的匹配键：去掉前导 `/`、小写、去首尾空白 */
function queryKey(query: string): string {
  return query.replace(/^\//, '').trim().toLowerCase()
}

/** q 是否为 s 的子序列（模糊命中；不要求连续） */
function isSubsequence(q: string, s: string): boolean {
  let i = 0
  for (const ch of s) {
    if (i < q.length && ch === q[i]) i++
    if (i === q.length) return true
  }
  return i === q.length
}

/**
 * 候选过滤（AC-20 的纯函数部分）：**前缀命中优先，其次子序列模糊命中**，两组内部保持原顺序。
 * - 空查询 → 原样返回全部（"空 `/` 列全部"）；
 * - 无匹配 → 空数组（调用方渲染 `无匹配命令` 占位行，而不是空浮层）。
 */
export function filterCandidates(all: CompletionCandidate[], query: string): CompletionCandidate[] {
  const q = queryKey(query)
  if (!q) return all.slice()
  const prefix: CompletionCandidate[] = []
  const fuzzy: CompletionCandidate[] = []
  for (const c of all) {
    const key = matchKey(c.label)
    if (key.startsWith(q)) prefix.push(c)
    else if (isSubsequence(q, key)) fuzzy.push(c)
  }
  return [...prefix, ...fuzzy]
}
