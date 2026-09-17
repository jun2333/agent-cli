/**
 * hooks.ts — Hook 系统（FR-8 / D32 / D33）
 *
 * 4 个时机：`PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop`。
 * **不做 `SessionStart`**（D32 明确不做：它会改写已发送内容，违反 D23 前缀稳定性硬约束）。
 *
 * 协议（与 Claude Code 的 hook 同构，D32）：
 * - 配置 = 内联 shell 命令；stdin 收 `JSON.stringify(payload) + '\n'`，stdout 可回
 *   `{decision:'block', reason}`（仅 PreToolUse 消费）；stderr 是人读诊断。
 * - 失败语义（D33）：`PreToolUse` 非 0 / 超时 → **阻塞**（reason = stderr）；
 *   其余时机非 0 / 超时 → **放行 + 告警**（warning，由调用方转 UI addInfo）。
 *   stdout 决策协议只在退出码为 0 时生效（**退出码优先**）。
 *
 * 信任模型（D33 / AC-46/47）：
 * - 用户级 `~/.agent-cli/hooks.json` **永不询问**；
 * - 项目级 `<projectRoot>/.agent-cli/hooks.json` 来自仓库（可能被恶意注入）→
 *   首次加载（或内容哈希变化后）必须经 `InteractionBroker` 信任确认；拒绝则不加载。
 * - 信任记录 `trustedHooks[projectRoot] = {hash, trustedAt}` 写**用户级**配置。
 *
 * 分层：本模块的协议执行与信任判定不持有 TUI；确认交互经注入的 `requestConfirm`
 * （= `InteractionBroker.request` 的透传，AC-27 的同一分派路径）。真实 spawn 的
 * stdin/stdout/超时/非 0 退出全部可被 vitest 直测（超时可注入调小，D-8 冒烟原则）。
 */
import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import { agentCliDir, loadUserConfig, saveUserConfig } from './user-config.js'
import type { InteractionResult, InteractionSpec } from './interaction.js'

// === 类型 ===

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop'

/** 全部合法事件（配置解析的白名单来源） */
export const HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop']

export type HookConfigItem = {
  /** 仅 Pre/PostToolUse 生效：`tool` 名或 `'*'`/缺省（全部匹配）；另两个时机忽略 */
  matcher?: string
  /** 内联 shell 命令（`sh -c` 执行） */
  command: string
  /** 覆盖默认超时（ms）；到点 SIGKILL 按失败处理 */
  timeoutMs?: number
}

export type HookConfig = Partial<Record<HookEvent, HookConfigItem[]>>

export type HookPayload = {
  event: HookEvent
  cwd: string
  sessionId?: string
  tool?: string
  args?: unknown
  /** PostToolUse：工具结果文本（已截断） */
  result?: string
  /** PostToolUse：工具耗时 */
  durationMs?: number
  /** UserPromptSubmit：用户输入纯文本 */
  prompt?: string
}

export type HookOutcome = {
  /** 仅 PreToolUse 可能为 true（AC-43） */
  blocked: boolean
  /** 阻塞原因（stderr / 超时 / stdout 决策），PreToolUse 下作为工具结果回给 LLM */
  reason?: string
  /** 其余时机的非 0 / 超时 → 告警（AC-44），由调用方转成 UI 告警 */
  warning?: string
}

// === 配置解析（白名单校验：任何一部分不合法 → 整份文件忽略，安全默认） ===

/** 解析并校验一份 hook 配置（来自 JSON.parse 的产物）；不合法返回 null */
export function parseHookConfig(raw: unknown): HookConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: HookConfig = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(key) || !Array.isArray(value)) return null
    const items: HookConfigItem[] = []
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const rec = item as Record<string, unknown>
      if (typeof rec.command !== 'string' || !rec.command.trim()) return null
      if (rec.matcher !== undefined && typeof rec.matcher !== 'string') return null
      if (rec.timeoutMs !== undefined && (typeof rec.timeoutMs !== 'number' || !Number.isFinite(rec.timeoutMs) || rec.timeoutMs <= 0)) {
        return null
      }
      items.push({
        command: rec.command,
        ...(typeof rec.matcher === 'string' ? { matcher: rec.matcher } : {}),
        ...(typeof rec.timeoutMs === 'number' ? { timeoutMs: rec.timeoutMs } : {}),
      })
    }
    ;(out as Record<string, HookConfigItem[]>)[key] = items
  }
  return out
}

/** 读一个 hooks.json 文件（不存在/损坏 → null，不抛） */
export function loadHooksFile(path: string): HookConfig | null {
  try {
    if (!existsSync(path)) return null
    return parseHookConfig(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

/**
 * 项目级配置路径：`path.resolve(projectRoot, '.agent-cli/hooks.json')` + 前缀校验
 * （等价 `resolveSafe` 语义；lesson 008：不另写一套路径判断，只做同等级校验）。
 */
export function resolveProjectHooksPath(projectRoot: string): string {
  const root = resolve(projectRoot)
  const p = resolve(root, '.agent-cli/hooks.json')
  if (p !== root && !p.startsWith(root + sep)) {
    throw new Error(`hooks 配置路径越出项目根：${p}`)
  }
  return p
}

// === 信任记录（AC-46/47） ===

/** 内容哈希：命令变了要重新信任（键序无关的稳定序列化 → sha256） */
export function hooksConfigHash(config: HookConfig): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, stable(val)]),
      )
    }
    return v
  }
  return createHash('sha256').update(JSON.stringify(stable(config))).digest('hex')
}

/** 项目级配置是否已被用户信任（读 user-config.trustedHooks） */
export function isProjectHooksTrusted(projectRoot: string, hash: string): boolean {
  const trusted = loadUserConfig().trustedHooks
  return trusted?.[projectRoot]?.hash === hash
}

/** 记录信任（合并进既有用户配置，保留 model/thinkLevel 等字段；失败静默降级） */
export function trustProjectHooks(projectRoot: string, hash: string): void {
  const cfg = loadUserConfig()
  saveUserConfig({
    ...cfg,
    trustedHooks: { ...(cfg.trustedHooks ?? {}), [projectRoot]: { hash, trustedAt: new Date().toISOString() } },
  })
}

// === 执行器 ===

type RunnerOptions = { cwd: string; defaultTimeoutMs: number }

/**
 * `exit` 之后等待 stdout/stderr 排空的**有界**宽限（ms）。
 *
 * 为什么需要：以 `exit` 结算后，sh 最后写进管道的数据可能还没被我们的 data 回调取走；
 * 而 hook 留下的后台子进程握着继承的写端 → 管道 EOF 可能永远不来。
 * 取值 50ms：本地管道的排空是微秒级，50ms 足够；被孙进程继承时最多多等 50ms，
 * 墙钟上界不再依赖任何外部进程。**不得**改成无界等待（那正是 C-1）。
 */
const STDIO_FLUSH_GRACE_MS = 50

/**
 * SIGKILL 整个进程组。
 *
 * `spawn(..., { detached: true })` 使子进程成为新进程组组长（pgid === child.pid，与
 * `src/tasks.ts` 同一实测结论）→ `process.kill(-pid, ...)` 连孙进程（hook 里 `cmd &` 起的
 * 后台进程）一起回收。组已不存在（ESRCH）/无权限（EPERM）时回退到直接 kill 子进程。
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (typeof pid === 'number' && pid > 0) {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      // ESRCH / EPERM → 回退（子进程未 detach 时 -pid 也不指向任何组）
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // 已退出/无权限 → 视为不在跑
  }
}

/** stderr 首行（告警/原因用；stderr 为空回退到 fallback） */
function firstLine(text: string, fallback: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return line ?? fallback
}

/**
 * HookRunner：持有两来源（user/project）的配置，`run(event, payload)` 顺序执行全部匹配项。
 *
 * - 无配置（`isEmpty`）时 `run` 立即返回且**不 spawn**；
 * - matcher 只对 Pre/PostToolUse 生效（`'*'`/缺省 = 全部）；
 * - PreToolUse 下任一匹配项阻塞 → 立即返回（后续项不再执行）；
 * - 在跑的子进程集合被持有，`killRunning()` 供退出收尾一并 kill（Risk R9）。
 */
export class HookRunner {
  private configs: Array<{ source: 'user' | 'project'; config: HookConfig }> = []
  private readonly live = new Set<ChildProcess>()

  constructor(private readonly opts: RunnerOptions) {}

  /** 按 source 替换配置（同 source 再次 configure = 覆盖） */
  configure(config: HookConfig, source: 'user' | 'project'): void {
    this.configs = this.configs.filter((c) => c.source !== source)
    this.configs.push({ source, config })
  }

  get isEmpty(): boolean {
    return this.configs.length === 0
  }

  /** 已加载条目的只读视图（/hooks 命令用） */
  describe(): Array<{ source: 'user' | 'project'; event: HookEvent; item: HookConfigItem }> {
    const out: Array<{ source: 'user' | 'project'; event: HookEvent; item: HookConfigItem }> = []
    for (const { source, config } of this.configs) {
      for (const event of HOOK_EVENTS) {
        for (const item of config[event] ?? []) out.push({ source, event, item })
      }
    }
    return out
  }

  /** 无配置时立即返回且不 spawn */
  async run(event: HookEvent, payload: HookPayload): Promise<HookOutcome> {
    if (this.isEmpty) return { blocked: false }
    const useMatcher = event === 'PreToolUse' || event === 'PostToolUse'
    const warnings: string[] = []
    for (const { config } of this.configs) {
      for (const item of config[event] ?? []) {
        if (useMatcher && item.matcher && item.matcher !== '*' && item.matcher !== payload.tool) continue
        const outcome = await this.runOne(event, item, payload)
        if (outcome.warning) warnings.push(outcome.warning)
        if (outcome.blocked) {
          return { blocked: true, ...(outcome.reason ? { reason: outcome.reason } : {}), ...(warnings.length ? { warning: warnings.join('；') } : {}) }
        }
      }
    }
    return { blocked: false, ...(warnings.length ? { warning: warnings.join('；') } : {}) }
  }

  /** 退出收尾（R9）：SIGKILL 全部在跑的 hook **进程组**（含 hook 自起的后台子进程），避免孤儿 */
  killRunning(): void {
    for (const child of this.live) killTree(child)
  }

  /**
   * 执行单条：真实 spawn，stdin 写 JSON，收集 stdout/stderr，超时 SIGKILL。
   *
   * **结算契约（C-1 返工修复，改动前是 `child.on('close')`）**：
   * - 以 **`exit`**（进程自身退出）为结算信号，而非 `close`。`close` 要等 stdout/stderr
   *   管道**全部持有者**退出，hook 命令一旦留下后台子进程（`cmd &`），`close` 永不触发：
   *   修复前实测 `timeoutMs:100` + `sleep 4 & sleep 5` → **5014ms**、`sleep 4 & echo hi`
   *   → **4019ms 且 sh 实际 exit 0 却被误判「hook 超时」**（PreToolUse 下=错误阻塞工具调用）；
   *   默认 10s 超时下挂一个长驻 daemon = **无限挂起 agent loop**。
   * - **超时回调自己结算**（`timedOut=true` → kill 进程组 → `finish`），不等任何事件 →
   *   墙钟上界 ≈ `timeoutMs`（+ kill 的直接开销）。
   * - `exit` 之后给 stdout/stderr 一个**有界** flush 宽限（等两个流 end，最多
   *   `STDIO_FLUSH_GRACE_MS`）—— 不无界等待被孙进程继承的管道关闭，也不丢 sh 自己的输出。
   * - `detached: true` 使 `sh` 成为新进程组组长（pgid === pid，与 `tasks.ts` 同一实测结论），
   *   结算时 `kill(-pid)` **连孙进程一起回收** → 结算后不留残留进程。
   *   ⚠️ 这意味着 hook 里 `cmd &` 起的后台进程**不会跨这次 hook 调用存活**（刻意的取舍：
   *   与"超时可被后台进程绕过"不可兼得；要长驻请用 `bash(run_in_background)`/`/jobs`）。
   */
  private runOne(event: HookEvent, item: HookConfigItem, payload: HookPayload): Promise<HookOutcome> {
    const timeoutMs = item.timeoutMs ?? this.opts.defaultTimeoutMs
    return new Promise<HookOutcome>((resolveDone) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      let timer: NodeJS.Timeout | null = null
      let flushTimer: NodeJS.Timeout | null = null
      let sawExit = false
      let exitCode: number | null = null
      let streamsEnded = 0

      // detached：新进程组组长（pgid === pid）→ 可 kill(-pid) 回收整组（含 hook 自起的后台子进程）
      const child = spawn('sh', ['-c', item.command], {
        cwd: this.opts.cwd,
        env: process.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.live.add(child)
      const streamCount = [child.stdout, child.stderr].filter(Boolean).length
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf8')
      })
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      // 两个流都排空（没有孙进程握着写端）→ 不必等满宽限期，立即结算
      const onStreamEnd = () => {
        streamsEnded++
        if (streamsEnded >= streamCount && sawExit) finish(exitCode)
      }
      child.stdout?.on('end', onStreamEnd)
      child.stderr?.on('end', onStreamEnd)

      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (flushTimer) clearTimeout(flushTimer)
        this.live.delete(child)
        // 结算即回收整个进程组（幂等；组已不存在时 ESRCH 被吞掉）
        killTree(child)
        // 释放 read 端 fd：被孙进程继承的管道不该继续留在本进程里（F-1）
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        const failed = timedOut || (code !== 0)

        if (event === 'PreToolUse') {
          if (failed) {
            // D33：PreToolUse 非 0 / 超时 → 阻塞，stderr 作为原因回给 LLM（AC-43/45）
            resolveDone({
              blocked: true,
              reason: timedOut ? 'hook 超时' : firstLine(stderr, `hook 退出码 ${code ?? 'unknown'}`),
            })
            return
          }
          // stdout 决策协议（退出码优先：exit 0 且 stdout 要求 block 才生效）
          const decision = parseStdoutDecision(stdout)
          if (decision?.decision === 'block') {
            resolveDone({ blocked: true, reason: decision.reason ?? 'hook 要求阻塞' })
            return
          }
          resolveDone({ blocked: false })
          return
        }

        // 其余时机（D33）：失败 → 放行 + 告警（AC-44/45）
        if (failed) {
          const how = timedOut ? 'hook 超时' : `退出码 ${code ?? 'unknown'}`
          resolveDone({ blocked: false, warning: `${event} hook 失败（${how}）：${firstLine(stderr, '无 stderr 输出')}` })
          return
        }
        resolveDone({ blocked: false })
      }

      // 超时：**自己结算**（不等 exit/close），墙钟上界 ≈ timeoutMs（C-1 的核心）
      timer = setTimeout(() => {
        timedOut = true
        killTree(child)
        finish(null)
      }, timeoutMs)

      // 以 exit 为准结算；迟到的 stdout/stderr 只给有界 flush 宽限
      child.on('exit', (code) => {
        sawExit = true
        exitCode = code
        // 进程已在期限内退出 → 余下只是 I/O 排空，不再按超时处理
        // （否则"95ms 退出 + 50ms 排空"会被误判成超时）
        if (timer) clearTimeout(timer)
        if (streamsEnded >= streamCount) {
          finish(code)
          return
        }
        flushTimer = setTimeout(() => finish(code), STDIO_FLUSH_GRACE_MS)
      })
      child.on('error', () => {
        sawExit = true
        finish(null)
      }) // spawn 本身失败（如 sh 不存在）按失败处理
      // 兜底：exit 未触发时（极端平台行为）仍能结算，不至于挂死
      child.on('close', (code) => {
        if (sawExit) return
        sawExit = true
        exitCode = code
        finish(code)
      })

      try {
        child.stdin?.write(JSON.stringify(payload) + '\n')
        child.stdin?.end()
      } catch {
        // stdin 写失败（进程已退）→ 让 exit/error 分支按真实退出码结算
      }
    })
  }
}

/** stdout 决策协议：合法 JSON 且含 `decision` 字段才有效 */
function parseStdoutDecision(stdout: string): { decision: string; reason?: string } | null {
  try {
    const parsed = JSON.parse(stdout.trim())
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as any).decision === 'string') {
      const reason = (parsed as any).reason
      return { decision: (parsed as any).decision, ...(typeof reason === 'string' ? { reason } : {}) }
    }
    return null
  } catch {
    return null
  }
}

// === 启动装配（AC-46/47 的信任流程） ===

export type HookProjectStatus = 'none' | 'trusted' | 'rejected'

export type HookSetupResult = {
  runner: HookRunner
  /** 项目级配置的加载状态：none=不存在或无效；trusted=已信任并加载；rejected=用户拒绝/不可交互 */
  projectStatus: HookProjectStatus
}

export type SetupHooksOptions = {
  projectRoot: string
  /** hook 默认超时（config.hookTimeoutMs 注入；测试调小做真实超时冒烟） */
  defaultTimeoutMs: number
  /**
   * 信任确认入口 —— **必须是 `InteractionBroker.request` 的透传**（AC-27：Hook 信任与
   * 权限审批 / `/jobs` / `ask_user` 走同一分派路径，不允许第二套交互代码）。
   * spec 带 `forced: true`：项目级 hook 来自仓库、属安全确认，`--yes` 不得自动信任（V-1 精神）。
   */
  requestConfirm: (spec: InteractionSpec) => Promise<InteractionResult>
  /** 复用既有 runner（生产装配传它，保证 runTurn 持有的是同一实例）；缺省新建 */
  runner?: HookRunner
}

/**
 * 启动装配：加载用户级（无需确认）+ 项目级（首次/哈希变化后信任确认）配置。
 *
 * 项目级路径经 `resolveProjectHooksPath`（前缀校验，lesson 008）；配置无效 → 视为不存在；
 * 未信任 → 弹 confirm（展示**来源路径 + 命令全文**）；拒绝 / `unavailable`（非交互、
 * `--yes` 遇 forced）→ 不加载该项目配置（安全默认，D9/V-1）。
 */
export async function setupHooks(opts: SetupHooksOptions): Promise<HookSetupResult> {
  const runner = opts.runner ?? new HookRunner({ cwd: opts.projectRoot, defaultTimeoutMs: opts.defaultTimeoutMs })

  // 用户级：永不询问（AC-47）
  const userConfig = loadHooksFile(join(agentCliDir(), 'hooks.json'))
  if (userConfig) runner.configure(userConfig, 'user')

  // 项目级：存在且有效才需要信任（AC-46）
  const projectPath = resolveProjectHooksPath(opts.projectRoot)
  const projectConfig = loadHooksFile(projectPath)
  let projectStatus: HookProjectStatus = 'none'
  if (projectConfig) {
    const hash = hooksConfigHash(projectConfig)
    if (isProjectHooksTrusted(opts.projectRoot, hash)) {
      runner.configure(projectConfig, 'project')
      projectStatus = 'trusted'
    } else {
      const commands = (Object.values(projectConfig) as HookConfigItem[][])
        .flat()
        .map((i) => i.command)
        .join('\n')
      const result = await opts.requestConfirm({
        kind: 'confirm',
        title: `信任项目级 hook 配置？\n来源：${projectPath}`,
        message: commands,
        defaultYes: false,
        forced: true,
      })
      if (result.kind === 'confirm' && result.value === true) {
        runner.configure(projectConfig, 'project')
        trustProjectHooks(opts.projectRoot, hash)
        projectStatus = 'trusted'
      } else {
        // 拒绝 / Esc / 非交互 unavailable → 一律不加载（安全默认）
        projectStatus = 'rejected'
      }
    }
  }

  return { runner, projectStatus }
}
