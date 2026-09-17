import type { OpenAI } from 'openai'
import type { InteractionBroker } from '../interaction.js'
import type { TaskManager } from '../tasks.js'
import type { ApprovalDecision } from '../permissions.js'
import { measureToolOutput, truncateToolResult } from './truncate.js'
import { config } from '../config.js'
import {
  buildDefinitions,
  classifyToolResult,
  TOOL_SPECS,
  type OutputCodec,
  type ToolExecContext,
  type ToolImplementations,
  type ToolMeta,
  type ToolResult,
  type ToolSpec,
} from './registry.js'

// === 执行生命周期事件（AC-40：权限 FR-6 与 Hook FR-8 的唯一挂载点） ===

/**
 * 一次工具调用的执行前/后事件。
 *
 * 与 loop 的 `tool_start`/`tool_end` 的分工：loop 的事件是**给 UI 的**（状态栏/工具行，
 * 带 `callId` 以做同行原地更新）；本事件是**给执行层消费方的**（权限、Hook、审计），
 * 载荷只有名字/参数/结果/耗时/规模。两者一一对应但互不替换。
 *
 * ⚠️ design §2 的事件原型带 `callId`；B2 不实现它——loop→executor 的调用边界是
 * `implementations[name](args)`，没有 callId 可传，且现有消费者（B7 权限、B8 Hook 的
 * `HookPayload{tool,args,result,durationMs}`）都不需要它。将来若要，可在不破坏现有
 * 监听方的前提下**追加**该可选字段。
 */
export type ToolLifecycleEvent =
  | { type: 'tool_pre'; name: string; args: unknown }
  | {
      type: 'tool_post'
      name: string
      args: unknown
      ok: boolean
      durationMs: number
      outputLines: number
      outputBytes: number
      error?: string
    }

/** 工具生命周期事件的订阅者 */
export type ToolLifecycleListener = (event: ToolLifecycleEvent) => void

// === 权限（B7 起为真实接线；B2 的 seam 已由其替换） ===

/** 权限判定结果（结构化的 allow/deny/ask，定义在 `permissions.ts`） */
export type { ApprovalDecision }

/** 权限策略：读元数据 + 参数，**纯函数**（AC-39 要求判定只依赖元数据） */
export type PermissionPolicy = (meta: ToolMeta, args: unknown) => ApprovalDecision

/**
 * 审批结果：`approved=false` 时可用 `reason` 覆盖默认的拒绝文案。
 * 为什么不是 `boolean`：非交互降级（D9/AC-28）要把「需交互但当前非交互」这一**结构化原因**
 * 原样回给 LLM，而这条原因只有审批通道知道（broker 的 `unavailable.reason`）。
 */
export type ApprovalOutcome = { approved: boolean; reason?: string }

/** 审批通道（B3 的 broker / B7 的 PermissionController 注入） */
export type ApprovalRequest = (
  meta: ToolMeta,
  args: unknown,
  decision: Extract<ApprovalDecision, { type: 'ask' }>,
) => Promise<ApprovalOutcome>

/**
 * **兼容路径的默认权限决策**（D-2）：只拦 `forced` 规则（危险命令），其余一律放行。
 *
 * 定位与边界（**避免越界读**）：
 * - 唯一消费方是 `createTools()`（compat 入口，现在只服务 `tools.test.ts`）；单轮与交互路径
 *   都改用真实 `PermissionController`（D-3 用户拍板），因此本策略**不是**生产权限语义；
 * - 为什么默认必须是这一版而不是"读 `requiresApproval`"：compat 路径没有审批通道，若把
 *   `write`/`edit`/`bash` 判成 `ask` 再降级为拒绝，既有 `tools.test.ts` 的行为回归面会全红（D-2）；
 * - 但它**必须**拦住 `forced`：无人审批时静默执行 `rm -rf /` 是不可接受的（fail-closed）。
 */
export const compatFailClosedPolicy: PermissionPolicy = (meta, args) => {
  for (const rule of meta.paramRules ?? []) {
    if (rule.forced && rule.test(args as Record<string, unknown>)) {
      return { type: 'deny', reason: rule.reason }
    }
  }
  return { type: 'allow' }
}

// === Hook seam（B8 的替换点） ===

/** Hook 的决策结果（形状对齐 design §5 的 `HookOutcome`） */
export type ToolHookOutcome = {
  /** 仅 PreToolUse 可能为 true（AC-43） */
  blocked: boolean
  /** 阻塞原因（stderr），作为工具结果回给 LLM */
  reason?: string
  /** 非阻塞时机的失败告警（AC-44），由调用方转成 UI 告警 */
  warning?: string
}

export type PreToolUseHook = (name: string, args: unknown) => Promise<ToolHookOutcome>
/** 第 4 参 `durationMs` = 工具执行耗时（PostToolUse 载荷字段，design §5）；B8 接 HookRunner 时透传 */
export type PostToolUseHook = (
  name: string,
  args: unknown,
  result: ToolResult,
  durationMs: number,
) => Promise<ToolHookOutcome>

// === 截断 seam（B6 已落地：双阈值 1000 行 / 50KB，配置注入） ===

/**
 * 工具结果截断（B6 落地双阈值 1000 行 / 50KB；缺省即 `truncateToolResult` + config 值）。
 * 第 2 参是工具的输出口径（W-1/W-3）：`bash`/`read` 的 JSON 信封必须经它抽正文再截断。
 */
export type TruncateToolResult = (result: ToolResult, codec?: OutputCodec) => ToolResult

export type ExecutorOptions = {
  /** 本轮真实使用的模型（注入 `ToolExecContext`，见 registry 的同名字段说明） */
  currentModel: string
  /**
   * 交互原语分派入口（B3/FR-5）。注入后 `ask_user` 的实现即可向用户提问；
   * 缺省（compat 路径、单轮未装配 broker）时 `ask_user` 返回"没有交互通道"的错误结果。
   */
  interaction?: InteractionBroker
  /**
   * 后台任务注册表（B6/FR-2）。注入后 `bash(run_in_background)`/`bash_output`/`kill_task` 可用；
   * 缺省（compat 路径）时这三个入口返回"当前环境不支持后台任务"的错误结果。
   */
  tasks?: TaskManager
  /** 缺省 `compatFailClosedPolicy`（D-2，只服务 compat 入口）；生产路径注入 `PermissionController.decide`（AC-37 的引用注入） */
  decidePermission?: PermissionPolicy
  /** 缺省（不注入）→ `ask` 一律降级为拒绝；生产路径接 `InteractionBroker.request`（FR-5/FR-6） */
  requestApproval?: ApprovalRequest
  /** 缺省（不注入）→ 无 PreToolUse hook */
  preToolUse?: PreToolUseHook
  /** 缺省（不注入）→ 无 PostToolUse hook */
  postToolUse?: PostToolUseHook
  /** 缺省（不注入）→ 用 `truncateToolResult` + `config.toolOutputMaxLines/MaxBytes` */
  truncate?: TruncateToolResult
  /** Hook 的非阻塞告警出口（B8 接 `ui.addInfo`） */
  onHookWarning?: (message: string) => void
}

export type ToolExecutor = {
  /** 由注册表生成，**一个会话内恒定**（AC-41 / 前缀缓存硬约束） */
  definitions: OpenAI.Chat.Completions.ChatCompletionTool[]
  /** 与既有 loop 的调用约定一致（`Record<name, (args) => Promise<ToolResult>>`） */
  implementations: ToolImplementations
  /** 订阅执行前/后事件（AC-40）；返回退订函数 */
  on(listener: ToolLifecycleListener): () => void
}

/**
 * 创建工具执行器：把注册表里每条 `ToolSpec` 包成带生命周期的实现。
 *
 * 单次调用的包装顺序（**权限与 Hook 的唯一挂载点**）：
 * ```
 * 1. emit tool_pre                        ← AC-40 前事件
 * 2. PreToolUse hook                      ← B8：非 0 则直接返回 {error}，不执行 impl（AC-43）
 * 3. 权限 decidePermission                ← B7：deny 直接返回；ask → requestApproval，拒绝则返回
 * 4. spec.impl(args, ctx)                 ← 真正执行（异常兜底为 {error}）
 * 5. truncate                             ← B6：双阈值截断
 * 6. PostToolUse hook                     ← B8：非阻塞，仅告警（AC-44）
 * 7. emit tool_post                       ← AC-40 后事件
 * ```
 * **每条返回路径都成对 emit（pre/post 恒 1:1）**——包括 hook 阻止与权限拒绝：订阅方需要
 * 看到"这次调用被拒了"这一结论。`PostToolUse` hook 仍只在**真正执行之后**触发（与 design 一致）。
 */
export function createToolExecutor(opts: ExecutorOptions, specs: ToolSpec[] = TOOL_SPECS): ToolExecutor {
  const listeners = new Set<ToolLifecycleListener>()
  const emit = (event: ToolLifecycleEvent) => {
    for (const l of listeners) l(event)
  }

  const ctx: ToolExecContext = {
    currentModel: opts.currentModel,
    interaction: opts.interaction,
    tasks: opts.tasks,
  }
  const decide = opts.decidePermission ?? compatFailClosedPolicy
  // 双阈值截断（B6 落地，D19/AC-11/V-4）：配置值注入，不硬编码在调用点；
  // 第 2 参传工具的输出口径（W-3：JSON 信封先抽正文再截断，否则行阈值恒不触发）
  const truncate =
    opts.truncate ??
    ((result: ToolResult, codec?: OutputCodec) =>
      truncateToolResult(result, config.toolOutputMaxLines, config.toolOutputMaxBytes, codec))
  const definitions = buildDefinitions(specs)

  const errorResult = (reason: string): ToolResult => ({ content: JSON.stringify({ error: reason }) })

  const implementations: ToolImplementations = {}
  for (const spec of specs) {
    const { name } = spec.meta

    implementations[name] = async (args: any) => {
      const startedAt = Date.now()
      emit({ type: 'tool_pre', name, args })

      /**
       * 收尾：emit tool_post（ok/耗时/行数/字节与 loop 同口径，结构化字段优先）并把**结果规模写回
       * ToolResult**（loop 的 `tool_end` 直接取 `result.lines` → 工具行「输出 N 行」）。
       *
       * W-1：行数/字节按工具语义测量（`measureToolOutput` + spec.output 的有效正文），
       * 不再对 JSON 信封数行（那恒等于 1）。截断后 `result.lines` 已被清空 →
       * 这里度量的是**实际交付给 LLM 的内容**（与截断同源，lesson 012）。
       */
      const finish = (result: ToolResult): ToolResult => {
        const fallback = classifyToolResult(result.content)
        const measured = measureToolOutput(spec.output, result.content)
        const final: ToolResult = {
          ...result,
          ok: result.ok ?? fallback.ok,
          lines: result.lines ?? measured.lines,
          bytes: result.bytes ?? measured.bytes,
        }
        emit({
          type: 'tool_post',
          name,
          args,
          ok: final.ok ?? fallback.ok,
          durationMs: Date.now() - startedAt,
          outputLines: final.lines ?? measured.lines,
          outputBytes: final.bytes ?? measured.bytes,
          ...(fallback.error === undefined ? {} : { error: fallback.error }),
        })
        return final
      }

      // ② PreToolUse：早于权限判定（hook 可先拦，避免无谓弹审批）
      if (opts.preToolUse) {
        const outcome = await opts.preToolUse(name, args)
        if (outcome.warning) opts.onHookWarning?.(outcome.warning)
        if (outcome.blocked) {
          return finish(errorResult(`Hook 已阻止：${outcome.reason ?? '未提供原因'}`))
        }
      }

      // ③ 权限判定（只读元数据 + 参数，AC-39）
      const decision = decide(spec.meta, args)
      if (decision.type === 'deny') {
        // plan 模式的写类拒绝（AC-34）：**不弹浮层**，直接返回拒绝结果给 LLM
        return finish(errorResult(`权限拒绝：${decision.reason}`))
      }
      if (decision.type === 'ask') {
        if (!opts.requestApproval) {
          return finish(errorResult(`需要用户审批，但当前没有可用的审批通道（安全默认：拒绝 ${name}）`))
        }
        const approval = await opts.requestApproval(spec.meta, args, decision)
        if (!approval.approved) {
          // 拒绝也要给出**明确、可继续**的结果（AC-32/37）：LLM 据此换策略，本轮不中断。
          // 非交互降级（AC-28）由审批通道给出更具体的原因（「需交互但当前非交互…」）。
          return finish(
            errorResult(approval.reason ?? `用户拒绝了 ${name} 的执行（权限模式：${decision.mode}）`),
          )
        }
      }

      // ④ 执行（异常一律转成既有约定的 {error} 形状）
      let result: ToolResult
      try {
        result = await spec.impl(args, ctx)
      } catch (e: any) {
        result = errorResult(`工具执行失败: ${e.message}`)
      }

      // ⑤ 截断（B6：双阈值 1000 行 / 50KB，作用于**工具的有效正文**；ContentPart[] 的图片豁免，V-4）
      result = truncate(result, spec.output)

      // ⑥ PostToolUse（非阻塞；durationMs 供 HookRunner 的 payload 字段，design §5）
      if (opts.postToolUse) {
        const outcome = await opts.postToolUse(name, args, result, Date.now() - startedAt)
        if (outcome.warning) opts.onHookWarning?.(outcome.warning)
      }

      return finish(result)
    }
  }

  return {
    definitions,
    implementations,
    on(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
