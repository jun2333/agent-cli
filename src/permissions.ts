/**
 * permissions.ts — 权限判定与预设模式（FR-6 / D8）
 *
 * 分层定位（design.md §4 / Decision 6）：
 * - 判定是**纯函数** `decidePermission(meta, args, mode)`：只读元数据 + 参数，无 IO、无全局状态。
 *   于是 AC-31~37/39 都能直测，而不必伪造 LLM 流或起 TUI。
 * - 模式状态由 `PermissionController` 持有，**按引用**注入 executor（`/mode` 改的是同一个对象）
 *   → 运行时切换对下一次工具调用立即生效（AC-37），不需要任何同步机制。
 *
 * 判定读的是 `ToolMeta`（`requiresApproval` / `mutating` / `paramRules`），**不读 `name`** ——
 * 这是 AC-39「注入一个 `requiresApproval:true` 的假工具即可改变行为、无需改权限代码」的
 * 结构性前提：新增工具只需声明元数据，权限层零改动（FR-7 的用户故事）。
 *
 * ⚠️ **危险命令规则的唯一来源**（V-2 用户拍板 2026-09-17）：
 * 4 条 `DANGEROUS_PATTERNS` 从 `tools/registry.ts` **整体迁入**本模块的 `matchDangerousCommand`，
 * `bash.impl` 内的硬拦截循环已删除。行为变化是有意的：危险命令从「硬拦截（不可能执行）」变为
 * 「强制审批（非 bypass 模式下每次都必须经用户批准，`--yes` 也不覆盖，见 V-1）」，`plan` 模式
 * 仍直接拒绝。因此本规则**不得**在 `src/` 内出现第二份定义。
 */
import type { ToolMeta } from './tools/registry.js'

// === 模式 ===

/** 四种预设权限模式（D8） */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

/** 全部模式（顺序 = `/mode` 浮层与 `--help` 的展示顺序，也是取值校验的唯一来源） */
export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass']

/** 取值校验（CLI `--permission-mode` 用）：非法值必须被显式拒绝，而不是静默回落 */
export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v)
}

/** 每种模式的一句话说明（`/mode` 浮层、`/permissions`、切换提示共用同一份文案） */
export const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: '写操作与命令执行前询问',
  acceptEdits: '文件编辑不问；命令执行仍询问',
  plan: '只读：写类操作直接拒绝',
  bypass: '全部不询问（危险）',
}

/** `bypass` 的醒目警告（启动时与 `/mode` 切过去时都打印；AC-35） */
export const BYPASS_WARNING =
  '⚠️ bypass 权限模式：所有工具调用将不再请求确认（含危险命令），请自行承担风险。'

// === 危险命令规则（唯一来源，V-2） ===

/**
 * 危险命令模式表（原 `tools/registry.ts` 的 `DANGEROUS_PATTERNS`，逐条原样迁入）。
 * `test` 一律匹配**去掉首尾空白**后的命令（与迁入前 `bash.impl` 的 `command.trim()` 同口径）。
 */
const DANGEROUS_PATTERNS: Array<{ ruleId: string; pattern: RegExp; hint: string }> = [
  { ruleId: 'rm-root', pattern: /^rm\s+(-rf?)?\s+(\/|~)/, hint: '删除根目录或家目录' },
  { ruleId: 'sudo', pattern: /^sudo\b/, hint: 'sudo 提权' },
  { ruleId: 'power', pattern: /^(shutdown|poweroff|reboot|halt)\b/, hint: '关机/重启' },
  { ruleId: 'mkfs', pattern: /^mkfs\./, hint: '格式化磁盘' },
]

/**
 * 命中危险命令返回规则信息，否则 `null`。
 * 由 `bash.meta.paramRules` 的 `dangerous` 规则消费（`forced: true`）。
 */
export function matchDangerousCommand(cmd: string): { ruleId: string; hint: string } | null {
  const trimmed = cmd.trim()
  for (const p of DANGEROUS_PATTERNS) {
    if (p.pattern.test(trimmed)) return { ruleId: p.ruleId, hint: p.hint }
  }
  return null
}

/** 危险命令规则的 `reason`（审批浮层与 compat 拒绝文案共用，保证文案不漂移） */
export const DANGEROUS_REASON = '危险命令'

// === 判定 ===

/**
 * 一次工具调用的权限判定结果。
 *
 * `ask` 携带 `mode`：executor 在「用户拒绝」时的结果文案要带权限模式
 * （`用户拒绝了 write 的执行（权限模式：default）`，AC-32/37 的"LLM 能看懂为什么没执行"）。
 * `ruleId` / `forced` 供审批浮层与 `InteractionSpec.forced` 使用（V-1 的分界点）。
 */
export type ApprovalDecision =
  | { type: 'allow' }
  | { type: 'deny'; reason: string }
  | { type: 'ask'; reason: string; ruleId?: string; forced?: boolean; mode: PermissionMode }

/**
 * 权限判定（顺序即实现，单测逐行覆盖；design §4 的 8 步优先级）：
 * ```
 * 1. bypass                          → allow
 * 2. plan 且 mutating                 → deny（只读模式，AC-34；直接拒绝、不弹浮层）
 * 3. 找第一条命中的 paramRules        → 参数级覆盖（D8 下半段）
 * 4. 命中且 forced                    → ask（危险命令，任何非 bypass 模式都不得豁免，AC-36）
 * 5. 命中且 requiresApproval          → ask（bash 的 catch-all「命令执行」规则）
 * 6. 工具级 requiresApproval 为 false  → allow（只读工具，AC-31）
 * 7. acceptEdits                      → allow（只豁免"文件编辑"这类工具级默认，AC-33）
 * 8. 否则                             → ask（default 模式的写操作，AC-32）
 * ```
 *
 * 注意步骤 6 在步骤 7 之前：`acceptEdits` 只豁免**工具级默认需要审批**的工具，
 * 命中 `paramRules` 的（如 `bash`）已在 4/5 步被拦下，不会被步骤 7 顺手放过。
 */
export function decidePermission(
  meta: ToolMeta,
  args: Record<string, unknown>,
  mode: PermissionMode,
): ApprovalDecision {
  if (mode === 'bypass') return { type: 'allow' }

  if (mode === 'plan' && meta.mutating) {
    return { type: 'deny', reason: `plan 模式为只读：${meta.name} 已被拒绝` }
  }

  const matched = meta.paramRules?.find((rule) => rule.test(args))
  if (matched?.forced) {
    return { type: 'ask', reason: matched.reason, ruleId: matched.id, forced: true, mode }
  }
  if (matched?.requiresApproval) {
    return { type: 'ask', reason: matched.reason, ruleId: matched.id, mode }
  }

  if (!meta.requiresApproval) return { type: 'allow' }
  if (mode === 'acceptEdits') return { type: 'allow' }
  return { type: 'ask', reason: `需要审批：${meta.name}`, mode }
}

/**
 * 运行时模式持有者（AC-37）。
 *
 * 由 `startInteractive` 创建一次，**按引用**注入每个 `runTurn` → `/mode` 切换的是同一个对象，
 * 因此下一次工具调用立即生效；已发出的 LLM 请求不受影响（工具参数在请求发出时已定）。
 * **不持久化**到用户配置：避免"上次开了 bypass，这次启动静默提权"。
 */
export class PermissionController {
  private current: PermissionMode

  constructor(mode: PermissionMode = 'default') {
    this.current = mode
  }

  get mode(): PermissionMode {
    return this.current
  }

  setMode(mode: PermissionMode): void {
    this.current = mode
  }

  /** 判定入口（executor 注入 `(meta, args) => controller.decide(meta, args)` 即完成接线） */
  decide(meta: ToolMeta, args: unknown): ApprovalDecision {
    return decidePermission(meta, args as Record<string, unknown>, this.current)
  }
}
