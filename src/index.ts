#!/usr/bin/env node
import readline from 'readline'
import OpenAI from 'openai'
import { config, projectRoot } from './config.js'
import { type ContentPart, type ToolResult } from './tools/index.js'
import { createToolExecutor, type ApprovalRequest } from './tools/executor.js'
import { runAgentLoop, type LoopEvent } from './agent/loop.js'
import { TUI, type TUIHandlers } from './ui/tui.js'
import type { SelectorItem } from './ui/selector.js'
import {
  getCapabilities,
  listChatModels,
  primeCapabilities,
  type ModelCapabilities,
  type ModelInfo,
} from './models.js'
import { loadUserConfig, saveUserConfig } from './user-config.js'
import { InteractionBroker } from './interaction.js'
// 权限系统（FR-6）：模式状态 + 纯函数判定 + 危险命令规则的唯一来源
import {
  BYPASS_WARNING,
  isPermissionMode,
  PermissionController,
  PERMISSION_MODE_DESCRIPTIONS,
  PERMISSION_MODES,
  type PermissionMode,
} from './permissions.js'
// 后台任务（FR-2）：注册表 + 日志清理（保留 7 天）
import { cleanupTaskLogs, TaskManager } from './tasks.js'
// Hook（FR-8）：4 时机执行器 + 信任装配（D32/D33）
import { setupHooks, HookRunner, type HookPayload } from './hooks.js'
// 斜杠命令与补全（FR-4）：命令规格 → 命令表 + 候选源（同一份数据，见 COMMAND_SPECS 的注释）
import {
  CompletionRegistry,
  createBuiltinSource,
  type CommandSpec,
} from './commands.js'
// 技能最小发现层（V-6 用户拍板）：`~/.agent-cli/skills/*/SKILL.md` + `<项目根>/.agent-cli/skills/*/SKILL.md`
// 注册为 `skills` 候选源 → AC-23 可端到端验证。FR-10 的其余部分（索引注入 / read_skill / write_skill）属 P4。
import { createSkillCompletionSource } from './skills.js'
import {
  loadSession,
  saveSession,
  ensureAgentCliDir,
  hydrateImages,
  loadUserPrompt,
  readMemoryIndex,
  migrateLegacyMemory,
  listSessions,
  newSessionId,
  acquireSessionLock,
  releaseSessionLock,
} from './session.js'

const client = new OpenAI({
  apiKey: 'ollama',
  baseURL: config.ollamaBaseUrl,
})

// 内置默认提示词（用户可在 ~/.agent-cli/prompt.md 定义自己的根提示词覆盖它）。
// 注意：不做格式/样式约束——样式由 TUI 渲染层统一决定，让模型自由发挥。
const DEFAULT_SYSTEM_PROMPT = `你是一个运行在终端里的通用编程助手，能执行 shell 命令、读写文件来完成用户的开发任务。

规则：
- 需要执行命令、读写文件时，调用对应工具；可以多轮调用（先读再改再验证）
- 回答简洁，用中文
- 工具执行失败时，先看错误信息再决定下一步，不要盲目重试
- 完成任务时，简要说明你做了什么和结果`

/** 组装 system prompt：用户根提示词（若有）> 默认提示词，再拼记忆索引（按需加载） */
function buildSystemPrompt(): string {
  ensureAgentCliDir()
  migrateLegacyMemory() // 兼容旧版单文件 memory.md
  const base = loadUserPrompt() ?? DEFAULT_SYSTEM_PROMPT
  const index = readMemoryIndex()
  if (!index.trim()) return base
  return `${base}\n\n# Memory\n${index}\n\n> 记忆已索引：不确定时用 read_memory(topic) 按需读取具体记忆。`
}

const DIM = '\x1b[90m'
const RESET = '\x1b[0m'

/** 思考等级（取值集合与 user-config / loop 一致；服务端全局固定四档，无 per-model 元数据） */
type ThinkLevel = 'low' | 'medium' | 'high' | 'max'
const THINK_LEVELS: ThinkLevel[] = ['low', 'medium', 'high', 'max']
/** 缺省思考等级（design.md：缺省 'low'） */
const DEFAULT_THINK_LEVEL: ThinkLevel = 'low'

// 纯文本 banner（颜色由 TUI 渲染）。模型名随运行时选择变化，故做成函数。
function bannerLines(model: string): string[] {
  return [
    '    _    ____ _____ _   _ _____',
    '   / \\  / ___| ____| \\ | |_   _|',
    '  / _ \\| |  _|  _| |  \\| | | |',
    ' / ___ \\ |_| | |___| |\\  | | |',
    '/_/   \\_\\____|_____|_| \\_| |_|',
    `v0.1.0 · ${model} · /help 查看帮助，Ctrl+C 退出`,
    '',
  ]
}

/**
 * `/help` 的正文（**行预算是硬约束**：可见行恰好一屏 18 行）。
 *
 * ⚠️ 可见行数 = `contentRows`（24 行终端 - 输入框 5 - 状态栏 1 = 18），当前正文**恰好 18 行**
 * （含 `--yes` 那行的折行）。再加一行就会把首行 `命令：` 顶出视口，打挂既有 `/help` 断言
 * （`term.contains('命令：')`）。因此新增帮助内容**必须合并进已有行**，不要新增行 ——
 * B7 就把权限模式与 `/mode`、`/permissions` 并入既有行，未增加行数。
 */
const HELP_TEXT = `命令：
  /exit, /quit  退出（会清屏）
  /clear        重开会话（清屏）
  /model        切换模型与思考等级
  /memory       查看记忆索引
  /help /jobs /hooks  帮助 / 后台任务 / 权限与 Hook（/mode · /permissions）

快捷键：
  Ctrl+C        退出
  Esc           打断当前 agent（消息进队列）
  ↑↓ / ←→       移动光标（单行时 ↑↓ 切历史）
  Ctrl+J        插入换行（Alt+Enter 同效）
  Ctrl+V        粘贴剪贴板图片（无图则粘贴文本）
  Ctrl+G        用外部编辑器撰写提示词

启动参数：
  --yes         自动接受需确认的普通审批（≠ bypass）；--permission-mode 指定权限模式（默认 default）`

/** 能力标注副文本（/model 列表用）：视觉/工具/思考；探测失败（null）标注"能力未知" */
function describeCapabilities(caps: ModelCapabilities | null): string {
  if (!caps) return '能力未知'
  const tags: string[] = []
  if (caps.vision) tags.push('vision')
  if (caps.tools) tags.push('tools')
  if (caps.thinking) tags.push('thinking')
  return tags.length > 0 ? tags.join(' · ') : '仅 completion'
}

/**
 * 交互式选择要恢复的会话（--resume/-r）。
 * TTY 下用箭头键单选列表；非 TTY 降级为数字输入。
 * 被其他进程锁定的会话不可选。返回选中的会话 id；取消返回 null。
 */
async function selectSession(): Promise<string | null> {
  const sessions = listSessions()
  if (sessions.length === 0) {
    console.log('No saved sessions.')
    return null
  }
  // 仅可选未锁定的会话
  const selectable = sessions.filter((s) => !s.locked)
  if (selectable.length === 0) {
    console.log('All sessions are locked by other running processes.')
    return null
  }

  // 非 TTY（管道/脚本）：降级为数字选择
  if (!process.stdin.isTTY) {
    console.log('\nSaved sessions:')
    sessions.forEach((s, i) => {
      const time = new Date(s.updatedAt).toLocaleString()
      const lock = s.locked ? ' [locked]' : ''
      console.log(`  ${i + 1}. ${time}  ${s.messageCount} msgs${lock}`)
    })
    console.log('\n(locked 项不可选)')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>((resolve) => rl.question('\nSelect session (0 to cancel): ', resolve))
    rl.close()
    const n = parseInt(answer, 10)
    if (!Number.isFinite(n) || n < 1 || n > sessions.length) return null
    if (sessions[n - 1].locked) {
      console.log('That session is locked by another process.')
      return null
    }
    return sessions[n - 1].id
  }

  // TTY：箭头键单选列表（↑/↓ 只在可选项目间移动，locked 项显示但不可选）
  return new Promise<string | null>((resolve) => {
    let selected = 0
    const draw = () => {
      process.stdout.write('\x1b[2J\x1b[H') // 清屏 + 光标到顶部
      process.stdout.write('Select a session to resume (↑/↓ move, Enter confirm, Esc/q cancel):\n\n')
      sessions.forEach((s) => {
        const time = new Date(s.updatedAt).toLocaleString()
        const line = `${s.messageCount} msgs ${time}${s.locked ? ' [locked]' : ''}`
        if (s.locked) {
          process.stdout.write(`\x1b[90m  ${line}\x1b[0m\n`) // 灰色：不可选
        } else {
          const item = selectable.indexOf(s)
          if (item === selected) process.stdout.write(`\x1b[7m▶ ${line}\x1b[0m\n`)
          else process.stdout.write(`  ${line}\n`)
        }
      })
      process.stdout.write('\nEsc/q: cancel')
    }
    const cleanup = (result: string | null) => {
      process.stdin.removeListener('keypress', onKey)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\x1b[2J\x1b[H')
      resolve(result)
    }
    const onKey = (_str: string, key: any) => {
      if (key.name === 'up') {
        selected = (selected - 1 + selectable.length) % selectable.length
        draw()
      } else if (key.name === 'down') {
        selected = (selected + 1) % selectable.length
        draw()
      } else if (key.name === 'return' || key.name === 'enter') {
        // 真实终端发 \r → 'return'；PTY 下 \r 常被转成 \n → 'enter'，两者都要兼容
        cleanup(selectable[selected].id)
      } else if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup(null)
      }
    }
    readline.emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('keypress', onKey)
    draw()
  })
}

function formatArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args)
    return s.length > 120 ? s.slice(0, 120) + '...' : s
  } catch {
    return String(args)
  }
}

/**
 * 取提交内容的纯文本形式（拼接文本部件，忽略图片）。
 * 斜杠命令必须用它匹配：含图时 TUI 的 onEnter 收到的是部件数组，
 * 若直接与字符串比较会全部落空——真实 PTY 实测发现「贴图后 /exit 失效，
 * 被当成普通消息发送并触发 400」。
 */
function textOfSubmit(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** 提交内容里是否含图片部件（直投路径） */
function hasImagePart(content: string | ContentPart[]): boolean {
  return Array.isArray(content) && content.some((p) => p.type === 'image_url')
}

// === 权限审批（FR-6） ===

/**
 * 构造生产用的审批通道：把 executor 的 `ask` 决策翻译成一次 `InteractionBroker.request`
 * （AC-27：权限审批与 LLM 层的 `ask_user` 走**同一分派路径**，没有第二套交互代码）。
 *
 * 三个关键语义（改动即破坏 V-1 / AC-28）：
 * - `forced`（危险命令）透传为 `InteractionSpec.forced` → `--yes` 分支拒绝它（V-1：安全优先）；
 * - `forced` 请求设 `defaultYes: false` → 交互模式下按 Enter **不会**批准危险命令（必须显式按 y）；
 *   普通请求不设该字段（缺省 true）→ `--yes` 才能按 R10 的 `defaultYes ?? true` 自动接受。
 *   这条分界正是「`--yes` ≠ `bypass`」的落点；
 * - 非交互降级（AC-28/D9）返回 `unavailable` 时，把「需交互但当前非交互」这一**结构化原因**
 *   回给 LLM（而不是笼统的"用户拒绝"），并说明可用的出路。
 */
export function createApprovalRequest(broker: InteractionBroker): ApprovalRequest {
  return async (meta, args, decision) => {
    const command =
      typeof (args as { command?: unknown })?.command === 'string' ? (args as { command: string }).command : ''
    // 危险命令审批时把命令原文放进浮层：用户需要看到自己批准的到底是什么（V-2 的补偿控制之一）
    const message = command ? `${decision.reason}\n命令：${command}` : decision.reason
    const result = await broker.request({
      kind: 'confirm',
      title: `允许执行 ${meta.name}？`,
      message,
      ...(decision.forced === true ? { defaultYes: false, forced: true } : {}),
    })
    if (result.kind === 'confirm') return { approved: result.value }
    if (result.kind === 'unavailable') {
      return {
        approved: false,
        reason:
          result.reason === 'forced'
            ? `需交互但当前非交互：${meta.name} 未被执行（命中强制审批规则，--yes 不覆盖危险命令，需显式使用 bypass 权限模式）`
            : `需交互但当前非交互：${meta.name} 未被执行（普通审批可用 --yes 自动接受，或用 --permission-mode 指定模式）`,
      }
    }
    return { approved: false, reason: `用户取消了 ${meta.name} 的执行（权限模式：${decision.mode}）` }
  }
}

// === 统一退出（FR-3） ===

/** 进程信号入口（SIGINT = Ctrl+C 的默认行为 / 外部 kill -INT；SIGTERM = kill 默认信号） */
const SIGNAL_NAMES: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

/**
 * 后台任务的收尾接口（FR-3 的第 4 步）。
 *
 * B4 先落**注入式空实现**（task-plan D-5：用户拍板的 FR 序把 FR-3 排在 FR-2 之前，
 * `TaskManager` 尚不存在）；**B6 起由真实 `TaskManager` 承担**（它结构化满足本接口），
 * 并由 `src/index.e2e.test.ts` 回归 AC-16/17 的收尾顺序断言。
 */
export type ShutdownTasks = {
  /** 终止全部存活后台任务并返回被终止清单（无任务时返回空数组） */
  killAll(): Promise<Array<{ taskId: string; command: string; killed: boolean }>>
}

export type ShutdownDeps = {
  ui: { exit(): void }
  sessionId: string
  broker: { cancelAll(): void }
  tasks: ShutdownTasks
  /**
   * 在跑的 hook 子进程回收（FR-8/R9）：`tasks.killAll()` 之后一并 SIGKILL
   * （hook 有 10s 强制超时兜底，此处只是收窄窗口）。缺省无 hook（单轮不装配）。
   */
  hooks?: { killRunning(): void }
  /** 释放会话锁（默认 session.ts 的 `releaseSessionLock`；注入用于断言收尾顺序，AC-16） */
  releaseLock?: (sessionId: string) => void
  /** 文本输出通道（默认 `process.stdout.write`；注入用于捕获 bye 与被终止清单） */
  write?: (s: string) => void
  /** 进程退出（默认 `process.exit`；注入用于断言顺序而不真杀测试进程，Risk R6） */
  exit?: (code: number) => void
  /** 是否注册 SIGINT/SIGTERM。**仅交互模式传 true** → 单轮模式不注册（AC-18） */
  signals?: boolean
}

/**
 * 进程内只保留**最新一份**信号收尾器。
 *
 * 为什么需要它：`startInteractive` 在测试里会被反复调用；若每次都 `process.on` 而不摘除，
 * SIGINT/SIGTERM 监听器会线性累积（Node 默认上限 10 → `MaxListenersExceededWarning`）。
 * 生产下一个进程只会有一个交互会话，因此"最新一份生效、旧的先摘除"是安全语义。
 */
let activeSignalDisposer: (() => void) | null = null

function installSignalHandlers(handler: () => void): () => void {
  activeSignalDisposer?.()
  for (const name of SIGNAL_NAMES) process.on(name, handler)
  const dispose = () => {
    for (const name of SIGNAL_NAMES) process.removeListener(name, handler)
    if (activeSignalDisposer === dispose) activeSignalDisposer = null
  }
  activeSignalDisposer = dispose
  return dispose
}

/**
 * 构造**所有退出入口共用的收尾函数**（`/exit`、`/quit`、Ctrl+C、SIGINT、SIGTERM → 同一个函数，AC-15/16）。
 *
 * 收尾顺序固定（改动即破坏 AC-16/17 的顺序断言）：
 * ```
 * 幂等守卫 → broker.cancelAll() → releaseSessionLock(sessionId) → await tasks.killAll()
 *          → ui.exit()（真清屏） → 打印被终止清单（若有） → 打印 bye → exit(code)
 * ```
 * 三处顺序理由（不可换）：
 * - `broker.cancelAll()` 在 `ui.exit()` **之前**：先释放挂起浮层的 Promise，否则 await 它的调用方
 *   会在退出途中永久悬挂。
 * - `ui.exit()`（含 `?1049l` 之后的真清屏）在打印 bye **之前**：清屏会擦掉此前所有输出，
 *   bye 必须是清屏后唯一的可见行（AC-15）。
 * - 被终止任务清单在 `ui.exit()` **之后**：打印在清屏之前等于没打印（AC-13）。
 *
 * `exit` 可注入：单测直接断言顺序，不必真杀 vitest（Risk R6）。
 */
export function createShutdown(deps: ShutdownDeps): (code?: number) => Promise<void> {
  const write = deps.write ?? ((s: string) => { process.stdout.write(s) })
  const exit = deps.exit ?? ((code: number) => { process.exit(code) })
  const releaseLock = deps.releaseLock ?? releaseSessionLock
  let finished = false

  const finish = async (code = 0): Promise<void> => {
    // 幂等守卫（design §8 步骤 1）：第二次信号/重复调用不再走收尾流程，直接退出。
    if (finished) {
      exit(code)
      return
    }
    finished = true
    // 先摘信号监听：退出途中/退出后不再响应信号（第二次信号回落为终端默认行为 = 立即退出）
    disposeSignals()
    deps.broker.cancelAll()
    releaseLock(deps.sessionId)
    const killed = await deps.tasks.killAll()
    deps.hooks?.killRunning()
    deps.ui.exit()
    // 被终止清单（AC-13）：无任务时不输出，保证 AC-15 的"清屏后只剩一行 bye"
    if (killed.length > 0) {
      const lines = killed.map((k) => `  ${k.taskId}${k.killed ? '' : '（未确认终止）'} · ${k.command}`)
      write(`已终止后台任务：\n${lines.join('\n')}\n`)
    }
    write(`bye · session ${deps.sessionId} · 恢复：agent-cli -r\n`)
    exit(code)
  }

  // 信号入口与返回值是**同一个函数**（AC-16 的「同一函数」）：handler 直接调 finish。
  // `disposeSignals` 需在 finish 之前声明（finish 体内引用它），默认为 no-op。
  let disposeSignals: () => void = () => {}
  const onSignal = () => { void finish(0) }
  if (deps.signals) disposeSignals = installSignalHandlers(onSignal)

  return finish
}

/**
 * 单轮执行的运行时参数。
 * 模型与思考等级**由调用方注入**：它们是 /model 切换后的运行时值，
 * 绝不能在别处再读一次 config.chatModel，否则会出现「工具按旧模型判断、请求按新模型发送」这类不一致。
 */
type TurnOptions = {
  /** 本轮使用的模型（运行时唯一事实来源） */
  model: string
  /** 思考等级（透传给 Ollama） */
  think?: ThinkLevel
  /** ESC 打断信号 */
  signal?: AbortSignal
  /** 交互原语分派入口（FR-5）：注入后 `ask_user` 才能问到用户（AC-27/30） */
  interaction?: InteractionBroker
  /**
   * 后台任务注册表（FR-2）。交互模式注入；**单轮模式刻意不注入**：
   * 单轮没有统一退出收尾路径（进程直接 exit），若允许起后台任务就会留下无人回收的孤儿进程。
   */
  tasks?: TaskManager
  /**
   * 权限模式持有者（FR-6/AC-37）。交互模式由 `startInteractive` 创建一次并**按引用**注入
   * （每个 turn 同一个对象 → `/mode` 切换立即生效）；缺省新建一个 `default` 模式的实例
   * （单轮 D-3 的默认即 `default`，写类工具自动拒绝）。
   */
  permissions?: PermissionController
  /**
   * Hook 执行器（FR-8）。注入后 4 时机生效：Pre/PostToolUse 挂 executor（与权限同一挂载点，
   * **hook 先于权限判定**，design §5）；UserPromptSubmit/Stop 由编排层触发。
   * 缺省（单轮模式不装配 hook，见 startInteractive 注释）→ 完全无 hook 开销。
   */
  hooks?: HookRunner
  /** 会话 id（Hook 载荷的 `sessionId` 字段） */
  sessionId?: string
}

/**
 * 跑一轮 agent loop。
 * ui 为 null 时（非交互模式）直接输出到 stdout；否则通过 TUI 渲染。
 * signal 用于 ESC 打断。
 *
 * 导出仅为让 e2e（`src/index.e2e.test.ts`）在进程内驱动 `ui === null` 的
 * **非交互单轮分支**（其 error → stderr 是 `main()` 里唯一无 UI 的输出通道）；
 * 正常启动路径仍是文件末尾的 `main()`。
 */
export async function runTurn(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ui: TUI | null,
  opts: TurnOptions,
): Promise<string> {
  // 工具实例绑定本轮模型：view_image 的能力预检必须跟随运行时模型（见 CreateToolsOptions）
  // 同一处注入交互通道：`ask_user` 的实现经 broker 分派（AC-27 的 LLM 层入口）
  // B7：权限判定与审批也在这里接线 —— `decidePermission` 按**引用**读 controller（AC-37），
  // `requestApproval` 经同一个 broker 打开审批浮层（AC-27：UI 层与 LLM 层同一分派路径）。
  const permissions = opts.permissions ?? new PermissionController('default')
  /**
   * Hook → executor 挂载（FR-8）：Pre/PostToolUse 走 B2 executor 的生命周期 seam。
   * **顺序 = design §5 的定义**：`tool_pre → PreToolUse hook → 权限 → impl → 截断 → PostToolUse → tool_post`
   * （hook 是"守卫"，先于权限判定拦下明显不该跑的调用，避免无谓弹审批；时序断言见 executor.test.ts）。
   * Hook 只产生 tool 结果消息或 UI 告警，**不写 system prompt**（D23 前缀稳定性）。
   */
  const hooks = opts.hooks
  const runHook = (event: HookPayload['event'], payload: Omit<HookPayload, 'event'>) =>
    hooks ? hooks.run(event, { event, ...payload }) : Promise.resolve({ blocked: false } as const)
  const { definitions, implementations } = createToolExecutor({
    currentModel: opts.model,
    interaction: opts.interaction,
    tasks: opts.tasks,
    decidePermission: (meta, args) => permissions.decide(meta, args),
    // 没有交互通道（compat/工具层测试）时不注入 → executor 的 ask 分支降级为安全拒绝，
    // 不会静默放行（与 D-2 的 fail-closed 取向一致）。
    ...(opts.interaction ? { requestApproval: createApprovalRequest(opts.interaction) } : {}),
    ...(hooks
      ? {
          preToolUse: (name: string, args: unknown) =>
            runHook('PreToolUse', { cwd: projectRoot, sessionId: opts.sessionId, tool: name, args }),
          postToolUse: (name: string, args: unknown, result: ToolResult, durationMs: number) =>
            runHook('PostToolUse', {
              cwd: projectRoot,
              sessionId: opts.sessionId,
              tool: name,
              args,
              result: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
              durationMs,
            }),
          onHookWarning: (message: string) => {
            if (ui) ui.addInfo(`[hook] ${message}`)
            else process.stderr.write(`[hook] ${message}\n`)
          },
        }
      : {}),
  })

  // think 只对**确认支持** thinking 的模型注入：能力未知（null，如 Ollama 未启动）或明确不支持时
  // 都不传，避免把无意义的顶层字段发给上游（getCapabilities 有进程内缓存，开销可忽略）。
  const caps = await getCapabilities(opts.model)
  const think = caps?.thinking === true ? opts.think : undefined

  let answer = ''
  let answerStarted = false
  /**
   * loop 事件 → TUI（B1 新契约）。
   *
   * 三处关键点（对应 loop.ts 的三处时序缺陷修复）：
   * - `tool_start` → `transitionStatus`（状态栏进入 tool 相位且带工具名）+ `beginToolLine`
   *   （**执行期间**就有工具行，AC-2/AC-3）
   * - `tool_end` → `endToolLine`（同一行原地变完成态，AC-3），不再被忽略
   * - `llm_start` → 新思考面板 + 状态机 thinking
   */
  const handle = (event: LoopEvent) => {
    switch (event.type) {
      case 'status':
        if (!ui) break
        ui.addThinking()
        ui.transitionStatus({ type: 'llm_start' })
        break
      case 'reasoning':
        if (ui) {
          ui.updateThinking(event.content)
        } else {
          process.stdout.write(`${DIM}${event.content}${RESET}`)
        }
        break
      case 'token':
        answer += event.content
        if (!answerStarted) {
          answerStarted = true
          ui?.transitionStatus({ type: 'answer_start' })
        }
        if (ui) ui.appendToLast(event.content)
        else process.stdout.write(`\x1b[1m${event.content}\x1b[0m`)
        break
      case 'tool_start':
        if (ui) {
          ui.transitionStatus({ type: 'tool_start', name: event.name })
          ui.beginToolLine(event.callId, event.name, formatArgs(event.args))
        } else {
          // 非交互单轮模式：stdout 是脚本消费的回答流，工具行只作旁注
          process.stdout.write(`\n${DIM}[tool] ${event.name} ${formatArgs(event.args)}${RESET}\n`)
        }
        break
      case 'tool_end':
        // 工具名/耗时/输出行数就地更新工具行；状态栏相位由下一个事件推进（AC-6 不回 Ready）
        if (ui) ui.endToolLine(event.callId, event.ok, event.durationMs, event.outputLines)
        break
      case 'error':
        // loop 的"静默失败"上报（输出被截断 / 无产出 / 迭代耗尽）：
        // 必须让用户看到，否则只会觉得"思考着就停了、没回答"
        if (ui) {
          ui.showError(event.message)
          ui.setStatus('error')
        } else {
          process.stderr.write(`${event.message}\n`)
        }
        break
    }
  }

  for await (const event of runAgentLoop({
    messages,
    definitions,
    implementations,
    client,
    model: opts.model,
    think,
    maxIterations: config.maxIterations,
    signal: opts.signal,
  })) {
    handle(event)
  }
  return answer
}

/**
 * 解析 CLI 参数（`--yes`/`-y`、`--permission-mode <模式>`，其余原样留在 `rest`）。
 *
 * 抽成独立函数的目的：`--permission-mode` 的值要**先校验**——非法值必须显式报错退出，
 * 而不是被静默落回 `default`（用户会以为 bypass 生效了），也不能把它当成单轮问题文本发给模型。
 */
function parseArgs(args: string[]): { autoAccept: boolean; permissionMode: PermissionMode; rest: string[] } {
  let autoAccept = false
  let permissionMode: PermissionMode = 'default'
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--yes' || a === '-y') {
      autoAccept = true
      continue
    }
    if (a === '--permission-mode' || a.startsWith('--permission-mode=')) {
      const value = a.startsWith('--permission-mode=') ? a.slice('--permission-mode='.length) : args[++i]
      if (!isPermissionMode(value)) {
        process.stderr.write(
          `无效的权限模式：${value ?? '(缺失)'}\n可用值：${PERMISSION_MODES.join(' / ')}（默认 default）\n`,
        )
        process.exit(1)
      }
      permissionMode = value
      continue
    }
    rest.push(a)
  }
  return { autoAccept, permissionMode, rest }
}

function main() {
  const args = process.argv.slice(2)
  // 组装 system prompt（用户根提示词 > 默认，追加 memory）
  const systemPrompt = buildSystemPrompt()

  // `--yes`（D9）与 `--permission-mode`（FR-6）：先解析并剥离，避免污染单轮模式的问题文本。
  // `--yes` 与 `bypass` **语义不等价**（V-1）：命中强制审批规则（危险命令）时仍拒绝，必须显式 bypass。
  const { autoAccept, permissionMode, rest } = parseArgs(args)

  if (rest[0] === '--version' || rest[0] === '-v') {
    console.log('agent-cli 0.1.0')
    return
  }
  if (rest[0] === '--help' || rest[0] === '-h') {
    console.log(`用法: agent-cli [选项] [问题]

  agent-cli              进入交互模式（自动恢复上次会话）
  agent-cli -r           选择历史会话恢复
  agent-cli "问题"        单轮问答后退出（便于脚本调用）

选项：
  -r, --resume  选择历史会话恢复
  -y, --yes     自动接受需要确认的**普通**审批（默认是自动拒绝）
                ⚠️ 与 bypass 权限模式**不等价**：危险命令的强制审批不会被 --yes 覆盖，
                   要真正执行必须显式使用 bypass 模式。
  --permission-mode <模式>
                权限模式：default（默认）/ acceptEdits / plan / bypass
                default     : 只读工具直接执行；write / edit / bash 需确认
                acceptEdits : 文件编辑不再确认；bash 与危险命令仍需确认
                plan        : 只读；写类操作（含 bash）直接拒绝
                bypass      : 全部不询问（启动有醒目警告）
                ⚠️ **破坏性变更**：单轮（agent-cli "问题"）模式不指定时落 default →
                   write / edit / bash 会被**自动拒绝**并以退出码 2 结束。
                   脚本里要执行写操作请显式加 --yes，或改用 --permission-mode bypass。

${HELP_TEXT}`)
    return
  }

  const resumeFlag = rest[0] === '--resume' || rest[0] === '-r'

  // 非交互单轮模式：agent-cli "问题"
  if (rest.length > 0 && !resumeFlag) {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: rest.join(' ') },
    ]
    // 非交互：没有 TUI，交互请求默认自动拒绝（D9/AC-28）；`--yes` 覆盖为非 forced 自动接受。
    // 权限模式缺省 `default`（D-3 用户拍板）：write/edit/bash 一律自动拒绝 → 退出码 2；
    // 要执行必须显式 `--yes`（危险命令仍不行，见 V-1）或 `--permission-mode`。
    const broker = new InteractionBroker(null, { interactive: false, autoAccept })
    const permissions = new PermissionController(permissionMode)
    runTurn(messages, null, { model: config.chatModel, interaction: broker, permissions })
      .then(() => process.exit(broker.deniedCount > 0 ? 2 : 0))
      .catch((e) => {
        console.error('Error:', e.message)
        process.exit(1)
      })
    return
  }

  // 交互模式：自研 DECSTBM TUI
  void startInteractive(systemPrompt, resumeFlag, { autoAccept, permissionMode })
}

/** 交互模式的启动选项（`--yes` / `--permission-mode`；由 main() 解析后注入） */
export type StartInteractiveOptions = {
  /** `--yes`：自动接受**非 forced** 的交互请求（V-1；与 bypass 不等价） */
  autoAccept?: boolean
  /** 启动时的权限模式（缺省 `default`）；交互中可用 `/mode` 切换 */
  permissionMode?: PermissionMode
}

/**
 * 交互模式入口：会话恢复/锁 → 模型与等级装配 → TUI 编排（命令分发）。
 * 导出仅为让 e2e（`src/index.e2e.test.ts`）在进程内驱动真实的入口编排；
 * 正常启动路径仍是文件末尾的 `main()`。
 */
export async function startInteractive(
  systemPrompt: string,
  resumeFlag: boolean,
  opts: StartInteractiveOptions = {},
) {
  ensureAgentCliDir()
  // 当前模型与思考等级：用户配置优先，缺省回落 config.chatModel / 'low'。
  // 这两个闭包变量是运行时的**唯一事实来源**——状态栏、agent loop 的 model/think、
  // view_image 的能力预检（经 runTurn → createToolExecutor 注入）三者都读它们。
  const saved = loadUserConfig()
  let currentModel = saved.model ?? config.chatModel
  let thinkLevel: ThinkLevel = saved.thinkLevel ?? DEFAULT_THINK_LEVEL
  // 预取能力：把当前模型写进 models.ts 的进程内缓存（view_image 预检/列表命中缓存）；
  // Ollama 未启动时静默失败，真正需要时再按"能力未知"降级处理，不阻断启动。
  await primeCapabilities([currentModel])

  // 会话 id 只存内存：默认新会话；--resume 则交互选择历史会话
  let sessionId: string
  let loaded: OpenAI.Chat.ChatCompletionMessageParam[] | null = null
  if (resumeFlag) {
    const chosenId = await selectSession()
    if (chosenId) {
      sessionId = chosenId
      if (!acquireSessionLock(sessionId)) {
        // 理论不会发生（列表已禁用被锁会话），防御处理
        console.log(`Session ${sessionId} is locked by another process.`)
        process.exit(1)
      }
      // 落盘时图片被剥离为 image_ref，恢复时重注入 data URL（文件已失效则降级为文本标记）
      const raw = loadSession(sessionId)
      loaded = raw ? hydrateImages(raw) : null
    } else {
      sessionId = newSessionId()
    }
  } else {
    sessionId = newSessionId()
  }

  const ui = new TUI(bannerLines(currentModel))
  /**
   * 交互原语分派中枢（FR-5）：**唯一分派路径**，UI 层（权限审批/`/jobs`/Hook 信任）与
   * LLM 层（`ask_user`）共用同一入口（AC-27）。`interactive` 取 stdin 的 TTY 事实，
   * `autoAccept` 来自 `--yes`；两者共同决定 4 种降级分支（V-1）。
   */
  const broker = new InteractionBroker(ui, {
    interactive: process.stdin.isTTY === true,
    autoAccept: opts.autoAccept === true,
  })
  /**
   * 权限模式持有者（FR-6/AC-37）：创建一次，**按引用**注入每个 `runTurn`
   * → `/mode` 切换的是同一个对象，下一次工具调用立即生效；已发出的 LLM 请求不受影响。
   * 启动值来自 `--permission-mode`（缺省 `default`）；**不持久化**（避免跨会话静默提权）。
   */
  const permissions = new PermissionController(opts.permissionMode ?? 'default')
  /**
   * Hook 执行器（FR-8）：先创建空 runner（保证 runTurn/processMessage 持有同一引用），
   * 配置在 `ui.enter()` 之后的 `setupHooks` 里注入 —— 信任确认浮层必须等 enter 完成
   * （enter 前写 stdout 会落主屏）。
   */
  const hooks = new HookRunner({ cwd: projectRoot, defaultTimeoutMs: config.hookTimeoutMs })
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...(loaded ?? []),
  ]
  /**
   * 后台任务收尾通道（FR-3 的第 4 步）：**B6 起为真实 `TaskManager`** ——
   * 它同时是 `bash(run_in_background)`/`bash_output`/`kill_task`/`/jobs` 的唯一数据源，
   * 也是退出时"一律 kill 存活任务并打印清单"（D11/AC-13）的执行者。
   * 启动时顺便清理 7 天前的任务日志（D18）。
   */
  cleanupTaskLogs(config.taskLogRetentionDays)
  const tasks = new TaskManager({
    cwd: projectRoot,
    bufferMaxLines: config.taskBufferMaxLines,
    bufferMaxBytes: config.taskBufferMaxBytes,
    killGraceMs: config.taskKillGraceMs,
  })
  /**
   * 统一退出收尾（FR-3）：`/exit`、`/quit`、Ctrl+C、SIGINT、SIGTERM **全部指向这一个函数**。
   * `signals: true` 只在这里传 → 单轮模式（不走 startInteractive）不注册信号 handler（AC-18）。
   * 收尾顺序与各步理由见 `createShutdown` 的文档注释。
   */
  const shutdown = createShutdown({ ui, sessionId, broker, tasks, hooks, signals: true })
  let running = false
  // 队列项与 processMessage 都接受「纯文本或带图的多模态部件」（TUI 的 onEnter 已放宽）
  let queue: Array<string | ContentPart[]> = []
  let currentAbort: AbortController | null = null

  async function processMessage(text: string | ContentPart[]) {
    ui.addUserMessage(text)
    // UserPromptSubmit（FR-8/AC-42）：在用户消息 push 进 messages **之前**触发（design §5 触发点表）。
    // 失败语义按 D33：非 0/超时 → 放行 + 告警（不拒绝输入、不改写消息，D23 前缀稳定性不受影响）。
    if (!hooks.isEmpty) {
      const outcome = await hooks.run('UserPromptSubmit', {
        event: 'UserPromptSubmit',
        cwd: projectRoot,
        sessionId,
        prompt: textOfSubmit(text),
      })
      if (outcome.warning) ui.addInfo(`[hook] ${outcome.warning}`)
    }
    messages.push({ role: 'user', content: text })
    saveSession(messages, sessionId) // 用户消息落盘

    running = true
    const ac = new AbortController()
    currentAbort = ac
    try {
      const answer = await runTurn(messages, ui, {
        model: currentModel,
        think: thinkLevel,
        signal: ac.signal,
        interaction: broker,
        tasks,
        permissions,
        hooks,
        sessionId,
      })
      if (answer) {
        messages.push({ role: 'assistant', content: answer })
        saveSession(messages, sessionId) // 回答落盘
      }
    } catch (e: any) {
      if (ac.signal.aborted) {
        ui.addInfo('Interrupted.')
        ui.setStatus('interrupted')
      } else {
        ui.showError('Error: ' + e.message)
        ui.setStatus('error')
      }
    } finally {
      running = false
      currentAbort = null
      // Stop（FR-8/AC-42）：一轮结束（runTurn 返回或异常）后触发，finally 段保证两条路径都覆盖
      if (!hooks.isEmpty) {
        try {
          const outcome = await hooks.run('Stop', { event: 'Stop', cwd: projectRoot, sessionId })
          if (outcome.warning) ui.addInfo(`[hook] ${outcome.warning}`)
        } catch {
          // Stop hook 的兜底：不让收尾告警路径打断队列推进
        }
      }
      void processQueue()
    }
  }

  async function processQueue() {
    if (running) return
    const next = queue.shift()
    if (next) {
      ui.setStatus('queued', `(${queue.length} left)`)
      await processMessage(next)
    } else {
      ui.setStatus('ready')
    }
  }

  /**
   * 应用 /model 的选择结果：落盘 → 更新运行时状态 → 刷新状态栏 → 提示。
   * **不清空 messages**（决策 D22）：已累积的会话消息保留，仅后续轮次使用新模型/等级。
   */
  function applyModelChoice(model: string, level: ThinkLevel) {
    currentModel = model
    thinkLevel = level
    saveUserConfig({ model: currentModel, thinkLevel })
    ui.setModelInfo(currentModel, thinkLevel)
    ui.addInfo(`已切换到 ${currentModel}（思考等级 ${thinkLevel}），后续对话生效；历史消息保留。`)
  }

  /**
   * 选中模型后决定下一步：支持 thinking → 再选等级（四档，不提供"关闭"）；
   * 不支持（含能力未知）→ 跳过等级，沿用当前等级。
   */
  function chooseThinkLevel(m: ModelInfo) {
    if (m.capabilities?.thinking !== true) {
      applyModelChoice(m.name, thinkLevel)
      return
    }
    ui.openSelector(
      THINK_LEVELS.map((level) => ({ label: level })),
      {
        title: `选择思考等级（${m.name}）`,
        onCancel: () => ui.addInfo('已取消模型切换。'),
        onPick: (i) => applyModelChoice(m.name, THINK_LEVELS[i]),
      },
    )
  }

  /** /model：本地模型列表（已过滤 embedding 类）→ 选模型 →（若支持思考）选等级 */
  async function runModelCommand() {
    let models: ModelInfo[]
    try {
      models = await listChatModels()
    } catch (e: any) {
      // listChatModels 内部已吞掉 `ollama list` 异常（返回空列表），此处兜底防止未来实现变化导致崩溃
      ui.showError(`获取模型列表失败：${e.message}`)
      return
    }
    if (models.length === 0) {
      ui.showError('未找到可用对话模型：请确认 ollama 已启动（`ollama list` 有输出）且已拉取对话模型。')
      return
    }
    const items: SelectorItem[] = models.map((m) => ({
      label: m.name,
      detail: describeCapabilities(m.capabilities),
    }))
    ui.openSelector(items, {
      title: '选择模型',
      onCancel: () => ui.addInfo('已取消模型切换。'),
      onPick: (i) => chooseThinkLevel(models[i]),
    })
  }

  /**
   * `/jobs` 的"最近输出"行数：**固定值**（V-5：浮层高度在生命周期内恒定；
   * 查看输出走内容区 `addInfo` 而非新浮层，因此输出增长不会触发整区重建）。
   */
  const JOBS_TAIL_LINES = 20

  /**
   * `/jobs`：后台任务的内联浮层二级菜单（FR-2 / D17）。
   *
   * 交互流：
   * ```
   * 列表（↑↓ 选择 · Esc 关闭）
   *   └─ 选中 → 动作菜单：查看输出 / 终止任务 / 返回（Esc 同"返回"）
   *        查看输出 → 内容区打印最近 20 行 → 回到列表
   *        终止任务 → tasks.kill()（幂等）→ 提示 → 回到列表
   * ```
   * 允许 **agent 运行期间**使用（查看/终止后台任务与当前轮次无关）。
   * 高度恒定（V-5）：列表项在打开时快照（`slice(0,50)` + overlay 最多显示 8 行），动作菜单恒 3 项。
   */
  async function runJobsCommand(): Promise<void> {
    for (;;) {
      const records = tasks.list()
      if (records.length === 0) {
        ui.addInfo('当前没有后台任务。')
        return
      }
      const runningCount = records.filter((r) => r.state === 'running').length
      const picked = await broker.request({
        kind: 'select',
        title: `后台任务（${runningCount} 运行中 / 共 ${records.length}）`,
        items: records.slice(0, 50).map((r) => ({
          label: `${r.id}  ${r.state === 'running' ? '● 运行中' : '○ 已结束'}`,
          detail: r.command.length > 40 ? `${r.command.slice(0, 40)}…` : r.command,
        })),
      })
      // Esc / 非交互降级 → 关闭（unavailable 时 broker 已给出提示）
      if (picked.kind !== 'select') return
      const rec = records[picked.index]
      if (!rec) continue

      const action = await broker.request({
        kind: 'select',
        title: `${rec.id} · ${rec.state === 'running' ? '运行中' : '已结束'}`,
        items: [{ label: '查看输出' }, { label: '终止任务' }, { label: '返回' }],
      })
      if (action.kind !== 'select') continue // Esc = 返回列表
      if (action.index === 0) {
        const tail = tasks.tailOutput(rec.id, JOBS_TAIL_LINES)
        const state = rec.state === 'running' ? '仍在运行' : `已结束（退出码 ${rec.exitCode ?? '—'}）`
        ui.addInfo(`【${rec.id}】${state} · 最近 ${JOBS_TAIL_LINES} 行：\n${tail?.trim() ? tail : '(暂无输出)'}`)
        continue
      }
      if (action.index === 1) {
        const killed = await tasks.kill(rec.id)
        ui.addInfo(
          killed?.alreadyExited
            ? `任务 ${rec.id} 已结束，无需终止。`
            : `已终止任务 ${rec.id}（含其子进程）。`,
        )
        continue
      }
      // '返回' → 关掉二级菜单（回到列表）
    }
  }

  /**
   * 应用权限模式（`/mode` 与启动警告共用）。
   * `bypass` 必须**醒目**（AC-35）：除 `addInfo` 外再走红色 `showError`（与启动告警同一通道）。
   */
  function applyPermissionMode(mode: PermissionMode): void {
    permissions.setMode(mode)
    if (mode === 'bypass') ui.showError(BYPASS_WARNING)
    ui.addInfo(`权限模式已切换为 ${mode}：${PERMISSION_MODE_DESCRIPTIONS[mode]}`)
  }

  /**
   * `/mode`：内联浮层选择权限模式（FR-6 / AC-35 / AC-37）。
   *
   * 高度恒定（V-5）：固定 4 项 → 浮层 6 行；选项文案里"当前"只是内容差异，不改行数。
   * 切换立即对**后续**工具调用生效（controller 按引用注入 executor），不打断本轮。
   */
  async function runModeCommand(): Promise<void> {
    const picked = await broker.request({
      kind: 'select',
      title: `权限模式（当前：${permissions.mode}）`,
      items: PERMISSION_MODES.map((m) => ({
        label: m,
        detail:
          m === permissions.mode ? `${PERMISSION_MODE_DESCRIPTIONS[m]} · 当前` : PERMISSION_MODE_DESCRIPTIONS[m],
      })),
    })
    if (picked.kind !== 'select') return // Esc / 非交互降级：不改模式（broker 已给提示）
    applyPermissionMode(PERMISSION_MODES[picked.index])
  }

  /**
   * 命令规格表（FR-4）：**命令的唯一描述**。同一份 `CommandSpec[]` 同时产出
   * ① `COMMANDS`（分发用）与 ② 斜杠补全候选（菜单用）—— 新增命令/改文案只写一处，不会漂移。
   *
   * 语义约束（与重构前的 5 连 if 逐条对齐，勿合并分支）：
   * - `/exit`、`/quit` → 立即退出（**不得**被 running 状态拦下）
   * - `/clear` → 清空 messages/queue + ui.clear() + 落盘
   * - `/model` → 先查 running（运行中拒绝并提示），否则 await runModelCommand()
   * - `/mode`、`/permissions`（B7）→ 权限模式的切换与只读视图，**不做 running 检查**（同 `/jobs`：
   *   切换对后续工具调用立即生效，与"本轮是否在跑"无关，AC-37）
   */
  const COMMAND_SPECS: CommandSpec[] = [
    { name: '/exit', description: '退出（会清屏）', run: () => shutdown(0) },
    { name: '/quit', description: '退出（会清屏）', run: () => shutdown(0) }, // /quit 是 /exit 的别名，指向同一收尾函数（AC-15/16）
    {
      name: '/clear',
      description: '重开会话（清屏）',
      run: () => {
        messages.length = 1
        queue = []
        ui.clear()
        saveSession(messages, sessionId) // 清空磁盘会话
      },
    },
    { name: '/help', description: '显示帮助', run: () => ui.addInfo(HELP_TEXT) },
    {
      name: '/memory',
      description: '查看记忆索引',
      run: () => {
        const idx = readMemoryIndex()
        ui.addInfo(idx.trim() ? idx : '暂无记忆')
      },
    },
    {
      name: '/model',
      description: '切换模型与思考等级',
      run: async () => {
        // 运行期间拒绝切换：否则"本轮到底用哪个模型"含糊不清，且切换与进行中的对话会交错
        if (running) {
          ui.addInfo('Agent 正在运行，请等本轮结束（或按 Esc 打断）后再切换模型。')
          return
        }
        await runModelCommand()
      },
    },
    {
      name: '/jobs',
      description: '查看/终止后台任务',
      // 刻意**不做** running 检查：查看/终止后台任务与"本轮是否在跑"无关（D17 的可用性要求）
      run: async () => {
        await runJobsCommand()
      },
    },
    {
      name: '/mode',
      description: '切换权限模式',
      // 同 /jobs：权限模式切换对**后续**工具调用立即生效，与"本轮是否在跑"无关（AC-37）
      run: async () => {
        await runModeCommand()
      },
    },
    {
      name: '/permissions',
      description: '查看当前权限模式',
      run: () =>
        ui.addInfo(
          `当前权限模式：${permissions.mode}（${PERMISSION_MODE_DESCRIPTIONS[permissions.mode]}）\n` +
            PERMISSION_MODES.map((m) => (m === permissions.mode ? `[${m}]` : m)).join(' / ') +
            ' · 用 /mode 切换',
        ),
    },
    {
      name: '/hooks',
      description: '查看已加载的 hook',
      // 只读视图，不做 running 检查（与 /permissions 同理）
      run: () => ui.addInfo(hooksSummaryText()),
    },
  ]

  /** `/hooks` 的只读正文：来源标记 + 事件 + matcher + 命令全文（FR-8 的可观测性） */
  function hooksSummaryText(): string {
    const entries = hooks.describe()
    if (entries.length === 0) {
      return (
        '当前没有加载任何 hook。\n' +
        '用户级：~/.agent-cli/hooks.json（无需确认）；项目级：<项目根>/.agent-cli/hooks.json（首次加载需信任确认）。'
      )
    }
    const lines = entries.map((e) => {
      const matcher = e.item.matcher && e.item.matcher !== '*' ? `(${e.item.matcher}) ` : ''
      return `  [${e.source === 'user' ? '用户级' : '项目级'}] ${e.event} ${matcher}${e.item.command}`
    })
    return `已加载 ${entries.length} 条 hook（行首标记来源）：\n${lines.join('\n')}`
  }

  /**
   * 命令分发表（I-9）：`knowledge/standards/code-style.md:43` 要求「大 if/else 用枚举 + 映射表替代」。
   * 各分支体异质（同步落盘 / 异步取模型列表），故值统一为 `() => void | Promise<void>`，
   * 由 `handleSubmit` 统一 `await`；未知输入不在表中，落回「入队或直接处理」路径。
   *
   * ⚠️ 用 Map 而非对象字面量：key 来自用户输入，对象字面量会命中原型链上的
   * `constructor`/`toString` 等键，把普通输入误判成命令（并调用到非命令函数）。
   */
  const COMMANDS = new Map<string, () => void | Promise<void>>(COMMAND_SPECS.map((s) => [s.name, s.run]))

  /**
   * 斜杠补全（FR-4）：候选源注册表 = 内置命令源 + 技能源（V-6）。
   * `CompletionRegistry` 仍是扩展点：**加候选只需 register 一个源**，命令表与候选不会漂移。
   * 技能源的告警走 `ui.addInfo`（不在 stderr 写——那会落在 alt screen 之外/破坏 TUI 渲染）；
   * 每个坏技能文件只报一次（见 `createSkillCompletionSource` 的注释）。
   */
  const completions = new CompletionRegistry()
  completions.register(createBuiltinSource(COMMAND_SPECS))
  completions.register(createSkillCompletionSource({ warn: (m) => ui.addInfo(`[技能] ${m}`) }))
  ui.setCompletionRegistry(completions)

  /**
   * 直投图片的能力预检失败后的统一善后（回填原内容 + 复位状态）。
   *
   * - TUI 的 `submit()` 已清空输入缓冲：不回填的话用户手打的文本与图片占位符全部丢失，
   *   只能重新 Ctrl+V（剪贴板被覆盖后无法恢复）；
   * - `restoreInput` 只在缓冲为空时回填（探测 await 期间用户新输入的文字不会被覆盖），
   *   此时它返回 false → 提示文案必须按真实返回值给，不得谎称"已回填"；
   * - 状态复位**仅在非 running 时**执行：运行中状态栏是 `Running tool`/`Thinking…`，
   *   无条件刷成 `Ready` 会与真实状态不符，且要等下一个流式事件才自愈（N-4②）。
   */
  function restoreAfterPreflightFailure(content: string | ContentPart[]) {
    // 用 unknown 承接返回值：兼容 restoreInput 的 void（无条件回填）与 boolean（仅缓冲为空时回填）两种签名
    const restored: unknown = ui.restoreInput(content)
    if (!running) ui.setStatus('ready')
    ui.addInfo(
      restored === false
        ? '输入框已有新内容，原内容未回填（可重新粘贴图片后提交）。'
        : '已把原内容回填到输入框，切换模型后可直接重新提交。',
    )
  }

  /**
   * 统一的提交处理（含命令分发）。
   * 抽成 async 是因为直投图片需要先做能力预检（getCapabilities 是异步的）。
   */
  async function handleSubmit(content: string | ContentPart[]): Promise<void> {
    // 命令只按纯文本匹配：含图时 content 是部件数组，直接与字符串比较会全部落空
    const text = textOfSubmit(content).trim()
    const command = COMMANDS.get(text)
    if (command) {
      await command()
      return
    }

    // 直投图片的能力预检：避免把图发给无 vision 的模型，导致上游抛原始 400（提示不友好）
    if (hasImagePart(content)) {
      const caps = await getCapabilities(currentModel)
      // 「能力未知」（探测失败）与「明确不支持」必须分开提示：前者是环境问题（Ollama 未启动 /
      // 模型不存在），后者才需要换模型；混成一句会把用户引向错误的排查方向
      // （与 tools/index.ts 的 view_image 预检写法一致）。
      if (!caps) {
        ui.showError(
          `无法探测模型能力（${currentModel}）：Ollama 可能未启动或模型不存在。请确认后重新提交，或用 /model 切换模型。`,
        )
        restoreAfterPreflightFailure(content)
        return
      }
      if (!caps.vision) {
        ui.showError(
          `当前模型 ${currentModel} 不支持视觉能力，无法处理图片。请用 /model 切换到支持视觉的模型后重新提交。`,
        )
        restoreAfterPreflightFailure(content)
        return
      }
    }

    if (running) {
      queue.push(content)
      ui.addUserMessage(content)
      ui.addInfo('Queued. Will run after the current task.')
    } else {
      void processMessage(content)
    }
  }

  const handlers: TUIHandlers = {
    onEnter: (content) => {
      void handleSubmit(content)
    },
    onExit: () => {
      // Ctrl+C 通道（TUI 在 raw mode 下把 Ctrl+C 报成 keypress 而非 SIGINT）：同一收尾函数
      void shutdown(0)
    },
    onInterrupt: () => {
      if (running && currentAbort) {
        currentAbort.abort()
        ui.addInfo('Sending interrupt…')
      }
    },
  }

  ui.enter(handlers)

  // 状态栏注入当前模型/等级（AC-31 常驻显示）。必须在 enter() 之后：
  // enter() 前写 stdout 会落到主屏（alt-screen 之外），退出后会留下残影。
  ui.setModelInfo(currentModel, thinkLevel)

  // 注意：restoreHistory 必须在 ui.enter() 之后调用——
  // enter() 内部会重置 blocks 为仅 banner，若先恢复历史会被覆盖
  if (loaded && loaded.length > 0) {
    ui.restoreHistory(loaded)
    ui.addInfo(`Session ${sessionId}: ${loaded.length} messages.`)
  } else {
    ui.addInfo(`New session ${sessionId}.`)
  }

  // `--permission-mode bypass` 的启动警告（AC-35）：必须在 `ui.enter()` **之后**打印，
  // 否则会落到主屏（alt-screen 之外），退出后留残影、用户也看不到。
  if (permissions.mode === 'bypass') ui.showError(BYPASS_WARNING)

  /**
   * Hook 装配（FR-8/AC-46/47）：必须在 `ui.enter()` 之后 —— 信任确认浮层要经 TUI 渲染。
   * 用户级 hooks.json 无需确认；项目级首次（或哈希变化后）弹 confirm（展示来源路径 + 命令全文，
   * `forced: true` → `--yes` 不得自动信任，V-1 的安全优先精神）；拒绝 / 非交互 → 不加载（安全默认）。
   * `requestConfirm` 是 `broker.request` 的透传 —— Hook 信任与权限审批 / `/jobs` / `ask_user`
   * 走**同一分派路径**（AC-27 的第 4 个消费者）。
   */
  const hookSetup = await setupHooks({
    projectRoot,
    defaultTimeoutMs: config.hookTimeoutMs,
    requestConfirm: (spec) => broker.request(spec),
    runner: hooks,
  })
  if (hookSetup.projectStatus === 'rejected') {
    ui.addInfo('[hook] 项目级 hook 配置未获信任，本次启动不加载（/hooks 查看已加载来源）。')
  } else if (hookSetup.projectStatus === 'trusted') {
    ui.addInfo('[hook] 项目级 hook 配置已加载（/hooks 查看命令清单）。')
  }
}

main()
