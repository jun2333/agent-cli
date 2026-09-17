import fs from 'fs/promises'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { glob as globFiles } from 'glob'
import type { OpenAI } from 'openai'
import { projectRoot, config } from '../config.js'
import { agentCliDir, imageToDataUrl, resolveImagePath } from '../images.js'
import type { InteractionBroker, InteractionResult, InteractionSpec } from '../interaction.js'
import type { TaskManager } from '../tasks.js'
import { getCapabilities } from '../models.js'
import { DANGEROUS_REASON, matchDangerousCommand } from '../permissions.js'
import { LINE_END, countLines } from './truncate.js'
import { readMemoryIndex, readMemoryTopic, appendMemory, writeMemory } from '../session.js'

const execAsync = promisify(exec)

// === 类型：工具元数据与执行契约（FR-7） ===

/**
 * 工具来源（AC-63/D34/D36）。
 * 本轮**只有** `builtin` 一个取值：D34 已把"外部协议工具源"整体移出 005 轮次，
 * 本轮实现层不接入任何此类能力（AC-63 的代码检索基线）。
 * 保留该字段是为了给将来的外部工具留出形状，而不是现在就产生第二个取值。
 */
export type ToolSource = 'builtin'

/**
 * 参数级审批规则（D8 下半段）。
 * `test` 是纯函数（只读 args），便于单测与权限判定复用；**B7 起由 `bash` 的实际规则消费**
 * （`dangerous` 强制审批 / `exec` 命令执行）。
 */
export type ParamRule = {
  id: string
  test: (args: Record<string, unknown>) => boolean
  /** 命中后是否需要审批 */
  requiresApproval: boolean
  /** true = 危险规则，任何非 bypass 模式都不得豁免（AC-36） */
  forced?: boolean
  /** 命中原因（回给 LLM / 审批浮层展示） */
  reason: string
}

/** 工具元数据：**消费方（definitions / 权限 / Hook / UI）的唯一来源**（AC-38/39） */
export type ToolMeta = {
  name: string
  /** 与重构前逐字一致（AC-41） */
  description: string
  /** JSON Schema，与重构前逐字一致（AC-41） */
  parameters: Record<string, unknown>
  /** 是否改变状态（写文件/执行命令/写记忆）→ `plan` 模式拒绝的依据（AC-34） */
  mutating: boolean
  /** 工具级静态默认是否需审批（D8 上半段） */
  requiresApproval: boolean
  /** 是否支持后台运行（本轮仅 bash） */
  backgroundable: boolean
  source: ToolSource
  /**
   * 参数级规则覆盖（D8 下半段）；**B7 起 `bash` 已填充**（`dangerous` / `exec`）。
   * 消费方是 `permissions.ts` 的 `decidePermission`（唯一判定入口）。
   */
  paramRules?: ParamRule[]
}

/**
 * 工具实现可访问的运行时上下文（**注入**而非全局，避免多轮/多会话互相污染）。
 *
 * B2 只有 `currentModel`。后续批次的扩展点：
 * - B3 追加 `interaction?: InteractionBroker`（`ask_user` 用）
 * - B6 追加 `tasks?: TaskManager`（`bash_output`/`kill_task` 用）
 * 可选是刻意的：compat 路径（`createTools()`，无 TUI/无交互通道）不注入 broker，此时
 * `ask_user` 的 impl 返回明确的错误结果（fail-closed），而不是让类型层阻止兼容路径装配。
 */
export type ToolExecContext = {
  /** 本轮真实使用的模型（`view_image` 能力预检用；`/model` 切换后立即生效） */
  currentModel: string
  /** 交互原语分派入口（FR-5）；缺省表示当前环境没有交互通道（`ask_user` 会返回错误结果） */
  interaction?: InteractionBroker
  /**
   * 后台任务注册表（FR-2）；缺省表示当前环境不支持后台任务
   * （`bash(run_in_background)` / `bash_output` / `kill_task` 返回明确的错误结果，
   * 而不是让类型层阻止 compat 路径装配）。
   *
   * **V-8（用户拍板）**：即使注入了 `tasks`，只要 `interaction` 明确是非交互（单轮），
   * `bash(run_in_background)` 仍直接拒绝——非交互判定优先于"有没有 `TaskManager`"，
   * 避免单轮模式留下孤儿进程。判定来源是 `InteractionBroker.interactive`（不新造第二套）。
   */
  tasks?: TaskManager
}

/** 多模态内容部件（与 OpenAI ChatCompletionContentPart 对齐） */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 工具执行结果：content 回传给 LLM，支持纯文本或多模态数组（如图片） */
export type ToolResult = {
  content: string | ContentPart[]
  /**
   * 结构化执行结果（可选）。B1 起由 loop 用于工具行的完成态（✓/✗）与耗时行数摘要。
   * B2 起 executor 会**优先**采用这里的字段（没有才回落 `classifyToolResult`）。
   */
  ok?: boolean
  /** 输出行数（口径：`split('\n')` 的元素数，与 D19 截断阈值一致） */
  lines?: number
  /** 输出字节数（口径：`Buffer.byteLength(·,'utf8')`） */
  bytes?: number
}

/** 与既有 loop 的调用约定保持一致：Record<name, (args) => Promise<ToolResult>> */
export type ToolImplementations = Record<string, (args: any) => Promise<ToolResult>>

/**
 * 工具输出的"**有效正文**"编解码器（W-1 行数 / W-3 截断的**单一口径来源**）。
 *
 * 为什么需要它：多数工具的 content 是 `JSON.stringify({…})` **信封**——真实换行在信封里被
 * 转义成 `\n` 两个字面字符，整段信封只有 1 行。直接对信封做行数计数或行阈值截断都会失效
 * （修复前实测：`bash seq 1 40` → 工具行显示「输出 1 行」；`read` 一个 2000 行/36.9KB 的文件
 * → **完全不截断**，因为 `split('\n').length === 1`）。
 *
 * 编解码器把"信封里哪些字段是输出正文"显式声明出来：计数与截断都作用在抽出的正文上，
 * 截断后再按**同一形状**回填，LLM 收到的仍是合法 JSON。
 */
export type OutputCodec = {
  /** 抽出参与计数与截断的文本段（顺序 = 信封中的出现顺序） */
  segments: (content: string | ContentPart[]) => string[]
  /** 用（可能被截断的）段按原形状回填 content；段数与 `segments` 一一对应 */
  rebuild: (content: string | ContentPart[], segments: string[]) => string | ContentPart[]
}

/**
 * JSON 信封编解码器：把 `fields` 中**确实存在且为字符串**的字段当作有效正文。
 *
 * 一个都没有（错误形状 `{error:…}`、形状变化）→ `segments` 返回空数组，
 * 调用方回落"整段文本"口径（错误结果因此仍按 1 行计，不改变既有语义）。
 */
export function jsonFieldsCodec(fields: readonly string[]): OutputCodec {
  const pick = (content: string | ContentPart[]): { obj: Record<string, unknown>; keys: string[] } | null => {
    if (typeof content !== 'string') return null
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    return { obj, keys: fields.filter((f) => typeof obj[f] === 'string') }
  }
  return {
    segments: (content) => {
      const p = pick(content)
      return p ? p.keys.map((k) => p.obj[k] as string) : []
    },
    rebuild: (content, segments) => {
      const p = pick(content)
      if (!p) return content
      p.keys.forEach((k, i) => {
        p.obj[k] = segments[i] ?? ''
      })
      return JSON.stringify(p.obj)
    },
  }
}

/**
 * JSON **数组**编解码器（W-R2）：`list_dir`/`glob`/`grep`/`web_search` 的 content 是
 * `JSON.stringify(items)` —— 整段信封只有 1 行，但**每一项**本身是自包含的 JSON。
 *
 * 修复的故障：这些工具没有 codec → 超 50KB 时走整段文本路径 → 在字节边界把信封**劈坏**
 * （实测真实 `list_dir` 4000 条目 → 51302B，`JSON.parse` 报
 * `Bad control character ... at position 51200`，而 `classifyToolResult` 因"非 JSON"还会判 `ok=true`）。
 *
 * 口径（与 `jsonFieldsCodec` 同一机制、同一 `OutputCodec` 接口，不新造第二套截断逻辑）：
 * - **一项 = 一行**（`JSON.stringify(item)` 必为单行，真实换行被转义）→ 双阈值（1000 行 / 50KB）
 *   作用在真实内容上，且只会**整项**丢弃，绝不切开某个项的 JSON；
 * - 截断标注作为**尾元素**回填 → 结果恒为合法 JSON（`JSON.parse` 成功）；
 * - 行数/字节/标注三者同源：标注数字直接取自 `truncateToolOutput` 的返回值。
 *
 * 为什么尾元素是字符串：数组没有"元数据位"。追加一个字符串元素是唯一既不改数组形状、
 * 又让 LLM 看到「被截断了 + 省略多少」的合法 JSON 做法。
 *
 * 边界（如实记录）：若**单个项**的 JSON 自身就超过字节阈值（`keep === 0` 路径，工具项会被
 * 按字节切开），`rebuild` 会丢弃解析失败的残项、只保留标注 → 仍是合法 JSON，但此时标注的
 * 「N 行」会少算那一个残项。这 4 个工具的项都是有界的（grep 的 text 截到 200 字符、
 * 文件名 ≤255B、web_search ≤5 条），该路径实际上不可达。
 */
export function jsonArrayCodec(): OutputCodec {
  const parseArray = (content: string | ContentPart[]): unknown[] | null => {
    if (typeof content !== 'string') return null
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return null
    }
    return Array.isArray(parsed) ? parsed : null
  }
  return {
    segments: (content) => {
      const items = parseArray(content)
      if (!items || items.length === 0) return []
      return [items.map((it) => JSON.stringify(it)).join('\n')]
    },
    rebuild: (content, segments) => {
      const items = parseArray(content)
      if (!items) return content
      const kept: unknown[] = []
      let notice: string | null = null
      for (const line of (segments[0] ?? '').split(LINE_END)) {
        if (line === '') continue
        try {
          kept.push(JSON.parse(line))
        } catch {
          // 截断标注（含 `keep === 0` 时被字节切开的残项）→ 不进数组，只保留为尾元素
          notice = line
        }
      }
      return JSON.stringify(notice === null ? kept : [...kept, notice])
    },
  }
}

/**
 * 一条工具登记项：元数据 + 实现 + 输出口径（单一声明，见 Decision 3 的 Option B）。
 *
 * `output` 只在 content 是 JSON **信封**（换行被转义）时才需要声明：
 * - 对象信封（`bash`/`read`/`bash_output`）→ `jsonFieldsCodec([字段…])`（W-3）；
 * - 数组信封（`list_dir`/`glob`/`grep`/`web_search`）→ `jsonArrayCodec()`（W-R2）；
 * - 缺省 = 整段 content 即有效正文（`read_memory` 的 markdown、错误形状、小结果对象）。
 * 它挂在 `ToolSpec` 而**不是** `ToolMeta` 上：meta 是 definitions 的来源（AC-41 的字节基线），
 * 输出口径与 OpenAI schema 无关，不该进 meta。
 */
export type ToolSpec = {
  meta: ToolMeta
  impl: (args: any, ctx: ToolExecContext) => Promise<ToolResult>
  output?: OutputCodec
}

// === 工具函数 ===

/**
 * 从工具结果**兜底**判定执行成败与输出规模（B1.3）。
 *
 * 为什么需要它：部分工具的成败只用 JSON 字符串表达（成功/失败都是字符串），没有结构化
 * `ok` 字段，而状态栏的工具行需要 ✓/✗ 与"输出 N 行"。这是**单一**的判定函数——
 * 不在 loop 里散落字符串匹配，也不在 TUI 里再写一份。
 *
 * 判定规则（宁可漏判失败，不可把成功判成失败）：
 * - 能 JSON.parse 成对象且含 `error` 字段 → 失败（既有约定：失败一律 `{ error }`）
 * - 能 JSON.parse 成对象且 `exitCode` 为非 0 数字 → 失败（bash 的失败形状是 `{exitCode,stdout,stderr}`，
 *   **没有** `error` 字段；不特判它会让 bash 失败显示成 ✓）
 * - 其余（数组结果 / 普通对象 / 非 JSON 文本如 read_memory 的 markdown）→ 成功
 *
 * 行数/字节是**兜底口径**：只度量"整段 content"。真实产物大的工具（`bash`/`read`/`bash_output`）
 * 在 `ToolSpec.output` 里声明了有效正文，由 `measureToolOutput` 度量（W-1），
 * executor 会把结果写进 `ToolResult.lines/bytes`，本函数不再被它们用到。
 * 行数用 `countLines`（唯一口径，见 truncate.ts），不是 `split('\n').length`。
 */
export function classifyToolResult(content: string | ContentPart[]): {
  ok: boolean
  outputLines: number
  outputBytes: number
  error?: string
} {
  // 多模态数组（view_image 成功路径）：图片部件不计入行数/字节（V-4 的同类口径）
  if (Array.isArray(content)) {
    const text = content.map((p) => (p.type === 'text' ? p.text : '')).join('')
    return { ok: true, outputLines: countLines(text), outputBytes: Buffer.byteLength(text, 'utf8') }
  }
  const error = inspectErrorText(content)
  return {
    ok: error === null,
    outputLines: countLines(content),
    outputBytes: Buffer.byteLength(content, 'utf8'),
    ...(error === null ? {} : { error }),
  }
}

/** 提取失败原因；非失败返回 null（规则见 classifyToolResult 注释） */
function inspectErrorText(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null // 非 JSON（如 read_memory 返回的索引 markdown）→ 视为成功
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if ('error' in obj) return typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error)
  if (typeof obj.exitCode === 'number' && obj.exitCode !== 0) {
    const stderr = typeof obj.stderr === 'string' && obj.stderr ? obj.stderr.split('\n')[0] : ''
    return stderr || `exitCode ${obj.exitCode}`
  }
  return null
}

/** 遍历时跳过的目录 */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.harness'])

/** 路径穿越防护：解析后必须位于项目根内 */
function resolveSafe(p: string): { ok: true; resolved: string; relative: string } | { ok: false; error: string } {
  const resolved = path.resolve(projectRoot, p)
  const root = projectRoot + path.sep
  if (resolved !== projectRoot && !resolved.startsWith(root)) {
    return { ok: false, error: `非法路径：不允许访问项目根目录之外的文件（${p}）` }
  }
  return { ok: true, resolved, relative: path.relative(projectRoot, resolved) }
}

/**
 * 把开头的 `~` 展开为 **agent-cli 基址**（`AGENT_CLI_DIR` 或家目录，同 images.agentCliDir）：
 * 图片目录在项目根之外，用户/LLM 常按 `~/images/x.png` 书写，而 `path.resolve` 不会展开 `~`
 * （会被当成名为 `~` 的目录）。基址必须与 `imageDir()` 一致，否则设置 `AGENT_CLI_DIR` 后
 * 工具描述承诺的路径会被白名单拒绝（审查发现 I-5）。展开后再交给 images.resolveImagePath 校验。
 */
function expandHome(p: string): string {
  if (p === '~') return agentCliDir()
  return p.startsWith('~/') ? path.join(agentCliDir(), p.slice(2)) : p
}

/** 递归遍历目录收集文本文件（跳过忽略目录、二进制、大文件） */
async function collectTextFiles(
  dir: string,
  base: string,
  limit: number,
): Promise<Array<{ abs: string; rel: string }>> {
  const results: Array<{ abs: string; rel: string }> = []
  const entries = await fs.readdir(dir, { withFileTypes: true })

  for (const e of entries) {
    if (results.length >= limit) break
    const abs = path.join(dir, e.name)
    const rel = path.relative(base, abs)

    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue
      results.push(...(await collectTextFiles(abs, base, limit)))
    } else if (e.isFile()) {
      // 只看常见文本文件扩展名，跳过二进制/大文件
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|vue|css|scss|html|yaml|yml|toml|sh|ts)$/i.test(e.name)) continue
      const stat = await fs.stat(abs)
      if (stat.size > 1024 * 1024) continue
      results.push({ abs, rel })
    }
  }
  return results
}

/**
 * `ask_user` 的工具结果整形（FR-5/AC-30）。
 *
 * 为什么要把 broker 的结果 JSON 化：工具结果是回给 LLM 的**唯一通道**，
 * 必须让模型能区分「用户给了答案」与「用户没答 / 当前无法问」并据此继续本轮
 * （AC-32 的"拒绝后 LLM 收到明确结果并能继续"同源）。
 * - 成功 → `{ answered: true, ... }`；
 * - Esc 取消 → `{ answered: false, reason: 'cancelled' }`；
 * - 非交互 / forced 拒绝 → `{ answered: false, error: '<原因>' }`（带 `error` 会被
 *   `classifyToolResult` 判为失败 → 工具行显示 ✗，与"这次没能问到"的事实一致）。
 */
function askUserPayload(result: InteractionResult): Record<string, unknown> {
  switch (result.kind) {
    case 'confirm':
      return { answered: true, value: result.value }
    case 'select':
      return {
        answered: true,
        index: result.index,
        choice: result.label,
        ...(result.manual === undefined ? {} : { manual: result.manual }),
      }
    case 'input':
      return { answered: true, answer: result.value }
    case 'cancelled':
      return { answered: false, reason: 'cancelled' }
    case 'unavailable':
      return { answered: false, reason: result.reason, error: result.message ?? '需交互但当前不可用' }
  }
}

// === 注册表（definitions 与元数据的唯一来源） ===

/**
 * 全部内置工具的登记表。
 *
 * **顺序即 definitions 顺序**（与重构前的硬编码数组一致，AC-41）。
 * 新增工具**只能追加在末尾**，且必须**无条件注册**：任何"按运行期条件增删工具"的写法都会
 * 改变请求前缀 → 前缀 KV 缓存失效（实测同前缀 prefill 8.6s → 0.2s，44×）。
 * 因此本数组是静态常量，`buildDefinitions()` 是纯函数，一个会话内 `definitions` 恒定。
 */
export const TOOL_SPECS: ToolSpec[] = [
  {
    meta: {
      name: 'bash',
      description: '在项目目录下执行 shell 命令，返回 stdout、stderr 和退出码。用于编译、测试、运行、git 操作等。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          run_in_background: {
            type: 'boolean',
            description:
              '设为 true 时命令在后台运行并立即返回 task_id；用 bash_output 读输出、kill_task 终止。适合 dev server / 长构建。',
          },
        },
        required: ['command'],
      },
      mutating: true,
      requiresApproval: true,
      backgroundable: true,
      source: 'builtin',
      /**
       * 参数级规则覆盖（V-2 用户拍板：危险命令由「硬拦截」改为「强制审批」）。
       * 规则本体在 `src/permissions.ts`（`matchDangerousCommand` 是唯一来源，本文件不再定义）；
       * 命中后由 `decidePermission` 产出 `ask`：
       * - `dangerous` 是 `forced` 规则 → 任何非 bypass 模式都必须经用户批准，`--yes` 也不覆盖（AC-36）；
       * - `exec` 是 catch-all → `bash` 在 `default`/`acceptEdits` 下始终需要审批（AC-33）。
       */
      paramRules: [
        {
          id: 'dangerous',
          test: (a) => matchDangerousCommand(String(a.command ?? '')) !== null,
          requiresApproval: true,
          forced: true,
          reason: DANGEROUS_REASON,
        },
        { id: 'exec', test: () => true, requiresApproval: true, reason: '命令执行' },
      ],
    },
    /**
     * 输出口径（W-1/W-3）：真实正文是 stdout + stderr 两个字段（信封里的换行是转义的 `\n`）。
     * 段序 = 信封里的出现顺序；每段独立应用双阈值（stdout 截断不会挤空 stderr）。
     */
    output: jsonFieldsCodec(['stdout', 'stderr']),
    impl: async ({ command, run_in_background }: { command: string; run_in_background?: unknown }, ctx: ToolExecContext) => {
      if (typeof command !== 'string' || !command.trim()) {
        return { content: JSON.stringify({ error: 'command 参数必须是非空字符串' }) }
      }
      const trimmed = command.trim()
      // ⚠️ 危险命令的拦截**不在本 impl**：B7 起它由 `permissions.ts` 的 `dangerous` 规则
      // （`forced: true`）在 executor 的权限判定步骤处理（V-2：硬拦截 → 强制审批）。
      // 本 impl 只保留"环境能力"门禁（V-8 的非交互拒绝后台任务），它不是权限规则。
      // 后台分支（FR-2/AC-7）：`spawn(detached)` 后**立即**返回，不 await 进程结束
      if (run_in_background === true) {
        // V-8（用户拍板 2026-09-17）：**非交互（单轮）模式显式拒绝后台任务**。
        // 理由：单轮没有统一退出收尾路径（进程直接 exit），起后台任务 = 留下无人回收的孤儿进程。
        // 判定复用 B3 的 `InteractionBroker.interactive`（它的 env 是交互事实的**唯一来源**），
        // 不在这里另写 `process.stdin.isTTY`——单轮分支装配的 broker 恒为 `{ interactive: false }`。
        // 返回**结构化错误**（不抛），让 LLM 据此改用前台执行。
        if (ctx.interaction && !ctx.interaction.interactive) {
          return {
            content: JSON.stringify({
              error: '后台任务需要交互模式：当前为非交互（单轮）运行，退出时无法回收后台进程，请改用前台执行。',
            }),
          }
        }
        if (!ctx.tasks) {
          return { content: JSON.stringify({ error: '当前环境不支持后台任务（未装配 TaskManager）' }) }
        }
        const info = ctx.tasks.start(trimmed)
        return { content: JSON.stringify({ task_id: info.taskId, pid: info.pid, running: true }), ok: true }
      }
      try {
        const { stdout, stderr } = await execAsync(trimmed, {
          cwd: projectRoot,
          timeout: config.bashTimeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        })
        return { content: JSON.stringify({ exitCode: 0, stdout, stderr }) }
      } catch (e: any) {
        return {
          content: JSON.stringify({
            exitCode: e.code ?? 1,
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? String(e.message ?? e),
          }),
        }
      }
    },
  },
  {
    meta: {
      name: 'read',
      description: '读取项目内文件的完整内容。路径相对于项目根目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对项目根的文件路径，如 src/index.ts' },
        },
        required: ['path'],
      },
      mutating: false,
      requiresApproval: false,
      backgroundable: false,
      source: 'builtin',
    },
    /** 输出口径（W-3）：真实正文是 `content` 字段（2000 行文件修复前完全不触发 1000 行阈值） */
    output: jsonFieldsCodec(['content']),
    impl: async ({ path: p }: { path: string }) => {
      if (typeof p !== 'string') {
        return { content: JSON.stringify({ error: 'path 参数必须是字符串' }) }
      }
      const safe = resolveSafe(p)
      if (!safe.ok) return { content: JSON.stringify({ error: safe.error }) }
      try {
        const content = await fs.readFile(safe.resolved, 'utf-8')
        return { content: JSON.stringify({ path: safe.relative, content }) }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `读取失败: ${e.message}` }) }
      }
    },
  },
  {
    meta: {
      name: 'write',
      description: '写入或覆盖项目内文件，自动创建父目录。用于创建新文件或整文件重写。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对项目根的文件路径，如 src/hello.ts' },
          content: { type: 'string', description: '要写入的完整文件内容' },
        },
        required: ['path', 'content'],
      },
      mutating: true,
      requiresApproval: true,
      backgroundable: false,
      source: 'builtin',
    },
    impl: async ({ path: p, content }: { path: string; content: string }) => {
      if (typeof p !== 'string' || typeof content !== 'string') {
        return { content: JSON.stringify({ error: 'path 和 content 参数必须是字符串' }) }
      }
      const safe = resolveSafe(p)
      if (!safe.ok) return { content: JSON.stringify({ error: safe.error }) }
      try {
        await fs.mkdir(path.dirname(safe.resolved), { recursive: true })
        await fs.writeFile(safe.resolved, content, 'utf-8')
        return { content: JSON.stringify({ ok: true, path: safe.relative, bytes: Buffer.byteLength(content) }) }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `写入失败: ${e.message}` }) }
      }
    },
  },
  {
    meta: {
      name: 'edit',
      description:
        '精确替换项目内文件的一段文本。用于小范围修改，比 write 整文件重写更省 token。old_string 必须在文件中唯一。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对项目根的文件路径' },
          old_string: { type: 'string', description: '要被替换的原文，必须精确匹配且唯一' },
          new_string: { type: 'string', description: '替换后的内容' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
      mutating: true,
      requiresApproval: true,
      backgroundable: false,
      source: 'builtin',
    },
    impl: async ({ path: p, old_string, new_string }: { path: string; old_string: string; new_string: string }) => {
      if (typeof p !== 'string' || typeof old_string !== 'string' || typeof new_string !== 'string') {
        return { content: JSON.stringify({ error: 'path/old_string/new_string 参数必须是字符串' }) }
      }
      if (!old_string) {
        return { content: JSON.stringify({ error: 'old_string 不能为空' }) }
      }
      const safe = resolveSafe(p)
      if (!safe.ok) return { content: JSON.stringify({ error: safe.error }) }
      try {
        const content = await fs.readFile(safe.resolved, 'utf-8')
        const count = content.split(old_string).length - 1
        if (count === 0) {
          return { content: JSON.stringify({ error: 'old_string 未在文件中找到' }) }
        }
        if (count > 1) {
          return { content: JSON.stringify({ error: `old_string 在文件中出现 ${count} 次，不唯一；请扩大匹配范围` }) }
        }
        const updated = content.replace(old_string, new_string)
        await fs.writeFile(safe.resolved, updated, 'utf-8')
        return { content: JSON.stringify({ ok: true, path: safe.relative }) }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `编辑失败: ${e.message}` }) }
      }
    },
  },
  {
    meta: {
      name: 'list_dir',
      description: '列出项目内目录的条目（文件/子目录）。路径相对于项目根目录，默认当前目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对项目根的目录路径，默认 .' },
        },
      },
      mutating: false,
      requiresApproval: false,
      backgroundable: false,
      source: 'builtin',
    },
    impl: async ({ path: p = '.' }: { path?: string }) => {
      const safe = resolveSafe(p)
      if (!safe.ok) return { content: JSON.stringify({ error: safe.error }) }
      try {
        const entries = await fs.readdir(safe.resolved, { withFileTypes: true })
        const items = entries
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file',
            path: path.join(safe.relative === '.' ? '' : safe.relative, e.name),
          }))
        return { content: JSON.stringify(items) }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `列目录失败: ${e.message}` }) }
      }
    },
    // W-R2：数组形状 → 项 = 行；超阈值时整项丢弃 + 尾元素标注，信封恒为合法 JSON
    output: jsonArrayCodec(),
  },
  {
    meta: {
      name: 'glob',
      description: '按 glob 模式查找项目内文件，返回匹配的文件路径列表。用于定位文件，如 **/*.ts、src/**/*.vue。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，相对于项目根目录' },
        },
        required: ['pattern'],
      },
      mutating: false,
      requiresApproval: false,
      backgroundable: false,
      source: 'builtin',
    },
    impl: async ({ pattern }: { pattern: string }) => {
      if (typeof pattern !== 'string' || !pattern.trim()) {
        return { content: JSON.stringify({ error: 'pattern 参数必须是非空字符串' }) }
      }
      try {
        const files = await globFiles(pattern, {
          cwd: projectRoot,
          ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**', 'coverage/**'],
          nodir: true,
        })
        return { content: JSON.stringify(files.slice(0, 200)) }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `glob 失败: ${e.message}` }) }
      }
    },
    // W-R2：数组形状 → 项 = 行
    output: jsonArrayCodec(),
  },
  {
    meta: {
      name: 'grep',
      description: '在项目文件中搜索文本/正则，返回匹配的文件和行。用于定位"某函数/某关键词在哪"。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '要搜索的正则表达式或关键词' },
          path: { type: 'string', description: '搜索起始目录（相对项目根），默认整个项目' },
        },
        required: ['pattern'],
      },
      mutating: false,
      requiresApproval: false,
      backgroundable: false,
      source: 'builtin',
    },
    impl: async ({ pattern, path: p = '.' }: { pattern: string; path?: string }) => {
      if (typeof pattern !== 'string' || !pattern.trim()) {
        return { content: JSON.stringify({ error: 'pattern 参数必须是非空字符串' }) }
      }
      const safe = resolveSafe(p)
      if (!safe.ok) return { content: JSON.stringify({ error: safe.error }) }
      try {
        let re: RegExp
        try {
          re = new RegExp(pattern)
        } catch {
          return { content: JSON.stringify({ error: `正则表达式无效: ${pattern}` }) }
        }
        const files = await collectTextFiles(safe.resolved, projectRoot, 500)
        const matches: Array<{ file: string; line: number; text: string }> = []
        for (const f of files) {
          if (matches.length >= 100) break
          const content = await fs.readFile(f.abs, 'utf-8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              matches.push({ file: f.rel, line: i + 1, text: lines[i].trim().slice(0, 200) })
              if (matches.length >= 100) break
            }
          }
        }
        return { content: JSON.stringify(matches) }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `搜索失败: ${e.message}` }) }
      }
    },
    // W-R2：数组形状 → 项 = 行
    output: jsonArrayCodec(),
  },
  {
    meta: {
      name: 'web_search',
      description:
        '在互联网上搜索信息，返回相关结果的标题、链接和摘要。当用户问题需要实时/最新信息、或超出你的知识范围时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
      mutating: false,
      requiresApproval: false,
      backgroundable: false,
      source: 'builtin',
    },
    impl: async ({ query }: { query: string }) => {
      if (typeof query !== 'string' || !query.trim()) {
        return { content: JSON.stringify({ error: 'query 参数必须是非空字符串' }) }
      }
      try {
        // Bing 国内可访问（DuckDuckGo 等可能被墙）
        const url = `https://cn.bing.com/search?q=${encodeURIComponent(query.trim())}`
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(15000),
        })
        const html = await res.text()
        const results: Array<{ title: string; url: string; snippet: string }> = []
        // Bing 结果：<li class="b_algo">...<h2><a href="url">title</a></h2>...<p>snippet</p>
        const re =
          /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a><\/h2>[\s\S]*?(?:<p[^>]*>(.*?)<\/p>)?/g
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) && results.length < 5) {
          const title = m[2].replace(/<[^>]+>/g, '').trim()
          if (!title) continue
          results.push({
            title,
            url: m[1],
            snippet: (m[3] || '').replace(/<[^>]+>/g, '').trim(),
          })
        }
        return {
          content: JSON.stringify(
            results.length > 0 ? results : { error: '没有搜索到相关结果，请尝试更换关键词' },
          ),
        }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `搜索失败: ${e.message}` }) }
      }
    },
    // W-R2：数组形状（非数组的错误形状由 codec 回落整段口径）→ 项 = 行
    output: jsonArrayCodec(),
  },
  {
    meta: {
      name: 'view_image',
      description:
        '读取并理解**尚未在对话中显示**的图片文件（需要当前模型支持视觉）。路径可为项目内的图片文件，或 ~/.agent-cli/images/ 下的图片（用户 Ctrl+V 粘贴的图片存放在这里）。' +
        '⚠️ 若图片已随用户消息附带（你能直接看到图），请直接基于它回答，**不要**调用本工具，也不要凭空猜测路径。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '图片路径，如 docs/shot.png 或 ~/.agent-cli/images/20260916-112233-123.png' },
        },
        required: ['path'],
      },
      mutating: false,
      requiresApproval: false,
      backgroundable: false,
      source: 'builtin',
    },
    impl: async ({ path: p }: { path: string }, ctx: ToolExecContext) => {
      if (typeof p !== 'string' || !p.trim()) {
        return { content: JSON.stringify({ error: 'path 参数必须是非空字符串' }) }
      }

      // 能力预检：探测失败（null = 能力未知）或明确无 vision 都直接拒绝，且不读取图片——
      // 避免把图塞给不支持视觉的模型，导致上游报错或图片被静默丢弃。
      // 用注入的运行时模型（/model 切换后立即生效），而非 config.chatModel。
      const caps = await getCapabilities(ctx.currentModel)
      if (!caps) {
        return {
          content: JSON.stringify({
            error: `无法探测模型能力（${ctx.currentModel}）：Ollama 可能未启动或模型不存在，请确认后再试`,
          }),
        }
      }
      if (!caps.vision) {
        return {
          content: JSON.stringify({
            error: `当前模型 ${ctx.currentModel} 不支持视觉（vision）能力，无法读取图片；可用 /model 切换到支持视觉的模型`,
          }),
        }
      }

      // 路径校验统一复用 images.resolveImagePath（项目根内 或 图片目录内），不另写一套
      const safe = resolveImagePath(expandHome(p.trim()))
      if (!safe.ok) return { content: JSON.stringify({ error: safe.error }) }

      // 读取 + 大小校验（>10MB 拒绝）+ base64 编码为 data URL，全部由 images 承担
      const encoded = imageToDataUrl(safe.abs)
      if (!encoded.ok) {
        // 真实用户反馈的失败链之一：图片已直投进用户消息，模型却仍想"再读一次"，
        // 而直投消息里没有路径文本 → 它会**凭空猜一个路径**，这里报"不存在"后
        // 又白花一轮去纠错。故在路径不存在时把它拉回正轨。
        const hint = encoded.error.startsWith('图片不存在')
          ? '。若该图已随用户消息附带（你能直接看到），请直接基于它回答，无需调用本工具'
          : ''
        return { content: JSON.stringify({ error: encoded.error + hint }) }
      }

      return {
        content: [
          { type: 'text', text: `图片 ${safe.display}（${encoded.bytes} 字节）如下：` },
          { type: 'image_url', image_url: { url: encoded.url } },
        ],
      }
    },
  },
  {
    meta: {
      name: 'read_memory',
      description: '读取长期记忆：无 topic 返回记忆索引（类型 + 每条一句话摘要）；有 topic 返回对应类型记忆的完整内容。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '记忆类型名（如 preferences/project），可选；缺省返回索引' },
        },
      },
      mutating: false,
      requiresApproval: false,
      backgroundable: false,
      source: 'builtin',
    },
    impl: async ({ topic }: { topic?: string }) => {
      if (topic === undefined) {
        const idx = readMemoryIndex()
        return { content: idx.trim() ? idx : JSON.stringify({ note: '暂无记忆' }) }
      }
      const r = readMemoryTopic(String(topic))
      return r.ok ? { content: r.content } : { content: JSON.stringify({ error: r.error }) }
    },
  },
  {
    meta: {
      name: 'append_memory',
      description: '向指定类型的长期记忆追加一条内容，并自动更新记忆索引。用于记录用户偏好、项目约定等。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '记忆类型名（如 preferences/project）' },
          content: { type: 'string', description: '要追加的记忆内容（一句话）' },
          summary: { type: 'string', description: '可选的一句话摘要；缺省用 content 前 40 字' },
        },
        required: ['topic', 'content'],
      },
      // 记忆写在 ~/.agent-cli（项目根之外，不经 resolveSafe），是用户显式授权的长期记忆，
      // 故 mutating=true（plan 模式视为写操作而拒绝）但 requiresApproval=false。
      mutating: true,
      requiresApproval: false,
      backgroundable: false,
      source: 'builtin',
    },
    impl: async ({ topic, content }: { topic: string; content: string }) => {
      if (typeof topic !== 'string' || typeof content !== 'string') {
        return { content: JSON.stringify({ error: 'topic/content 参数必须是字符串' }) }
      }
      const r = appendMemory(topic, content)
      return r.ok ? { content: JSON.stringify({ ok: true, topic }) } : { content: JSON.stringify({ error: r.error }) }
    },
  },
  {
    meta: {
      name: 'write_memory',
      description: '覆盖指定类型的长期记忆内容，并自动重建记忆索引。用于修正/重写某类记忆。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '记忆类型名（如 preferences/project）' },
          content: { type: 'string', description: '覆盖后的完整内容（可多行，每行一条记忆）' },
        },
        required: ['topic', 'content'],
      },
      mutating: true,
      requiresApproval: false,
      backgroundable: false,
      source: 'builtin',
    },
    impl: async ({ topic, content }: { topic: string; content: string }) => {
      if (typeof topic !== 'string' || typeof content !== 'string') {
        return { content: JSON.stringify({ error: 'topic/content 参数必须是字符串' }) }
      }
      const r = writeMemory(topic, content)
      return r.ok ? { content: JSON.stringify({ ok: true, topic }) } : { content: JSON.stringify({ error: r.error }) }
    },
  },
  {
    meta: {
      name: 'ask_user',
      description: '向用户提问并等待回答。需要用户做决定或补充信息时使用；提供选项时为单选，否则为自由问答。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要向用户提出的问题' },
          options: { type: 'array', items: { type: 'string' }, description: '可选项列表；缺省为自由问答' },
          allow_manual_input: { type: 'boolean', description: '有选项时是否允许用户直接键入自定义答案' },
        },
        required: ['question'],
      },
      // 只读语义（不改变任何状态）→ plan 模式也允许问；交互本身不需要审批
      mutating: false,
      requiresApproval: false,
      backgroundable: false,
      source: 'builtin',
    },
    impl: async (
      { question, options, allow_manual_input }: { question?: unknown; options?: unknown; allow_manual_input?: unknown },
      ctx: ToolExecContext,
    ) => {
      if (typeof question !== 'string' || !question.trim()) {
        return { content: JSON.stringify({ error: 'question 参数必须是非空字符串' }) }
      }
      const broker = ctx.interaction
      // 没有交互通道（compat 路径 / 单轮且未注入 broker）：fail-closed，明确告诉模型问不了
      if (!broker) {
        return { content: JSON.stringify({ error: '当前环境没有可用的交互通道，无法向用户提问' }) }
      }
      const items = Array.isArray(options)
        ? options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).map((label) => ({ label }))
        : []
      const spec: InteractionSpec =
        items.length > 0
          ? { kind: 'select', title: question.trim(), items, allowManualInput: allow_manual_input === true }
          : { kind: 'input', title: question.trim() }
      const result = await broker.request(spec)
      return { content: JSON.stringify(askUserPayload(result)), ok: result.kind !== 'unavailable' }
    },
  },
  {
    meta: {
      name: 'bash_output',
      description:
        '读取后台任务的**增量**输出（自上次读取之后的新内容），并返回是否仍在运行、退出码，以及内存缓冲是否已丢弃过旧输出。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'bash 以 run_in_background 启动时返回的 task_id' },
          wait_ms: {
            type: 'number',
            description: '可选：等待新增输出的最长时间（毫秒，上限 10000）；默认 0 立即返回',
          },
        },
        required: ['task_id'],
      },
      // 只读（读缓冲区，不改任何状态）→ plan 模式也允许
      mutating: false,
      requiresApproval: false,
      backgroundable: false,
      source: 'builtin',
    },
    /** 输出口径（W-3）：真实正文是 `output` 字段（增量输出可能是几千行） */
    output: jsonFieldsCodec(['output']),
    impl: async ({ task_id, wait_ms }: { task_id?: unknown; wait_ms?: unknown }, ctx: ToolExecContext) => {
      if (typeof task_id !== 'string' || !task_id) {
        return { content: JSON.stringify({ error: 'task_id 参数必须是非空字符串' }) }
      }
      if (!ctx.tasks) {
        return { content: JSON.stringify({ error: '当前环境不支持后台任务（未装配 TaskManager）' }) }
      }
      // 只做 Map 查表：未命中即错误。绝不把 task_id 拼进路径（lesson 004 / 路径穿越在结构上不可能）
      if (!ctx.tasks.get(task_id)) {
        return {
          content: JSON.stringify({
            error: `未找到任务：${task_id}（task_id 必须是 bash 以 run_in_background 启动时返回的 id）`,
          }),
        }
      }
      if (typeof wait_ms === 'number' && Number.isFinite(wait_ms) && wait_ms > 0) {
        await ctx.tasks.waitForActivity(task_id, wait_ms)
      }
      const out = ctx.tasks.readOutput(task_id)!
      return {
        content: JSON.stringify({
          task_id: out.taskId,
          running: out.running,
          state: out.state,
          exit_code: out.exitCode,
          signal: out.signal,
          output: out.output,
          dropped: out.dropped,
          dropped_lines: out.droppedLines,
          dropped_bytes: out.droppedBytes,
        }),
        // 工具调用本身成功（读到了），与"任务失败"是两件事 → ok 恒 true
        ok: true,
      }
    },
  },
  {
    meta: {
      name: 'kill_task',
      description: '终止一个后台任务（连同其子进程）。任务已退出时返回 already_exited=true，不报错。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '要终止的 task_id（bash 后台启动时返回）' },
        },
        required: ['task_id'],
      },
      // 会终止进程（改变状态）→ mutating=true；但不需要审批（用户/模型都可能需要紧急停掉任务）
      mutating: true,
      requiresApproval: false,
      backgroundable: false,
      source: 'builtin',
    },
    impl: async ({ task_id }: { task_id?: unknown }, ctx: ToolExecContext) => {
      if (typeof task_id !== 'string' || !task_id) {
        return { content: JSON.stringify({ error: 'task_id 参数必须是非空字符串' }) }
      }
      if (!ctx.tasks) {
        return { content: JSON.stringify({ error: '当前环境不支持后台任务（未装配 TaskManager）' }) }
      }
      const r = await ctx.tasks.kill(task_id)
      if (!r) {
        return { content: JSON.stringify({ error: `未找到任务：${task_id}` }) }
      }
      return {
        content: JSON.stringify({ task_id: r.taskId, killed: r.killed, already_exited: r.alreadyExited }),
        // 幂等成功：重复 kill 不抛也不报错（AC-9）
        ok: true,
      }
    },
  },
]

/**
 * 元数据 → OpenAI function definition（AC-41 的"同源"保证）。
 * 纯函数，只读 meta，无任何运行期分支。
 */
export function toDefinition(meta: ToolMeta): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: { name: meta.name, description: meta.description, parameters: meta.parameters },
  }
}

/**
 * 由注册表生成 definitions。
 * 只依赖静态 `specs` → **同一会话内恒定**（前缀缓存的硬约束，见 TOOL_SPECS 注释）。
 */
export function buildDefinitions(specs: ToolSpec[] = TOOL_SPECS): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return specs.map((s) => toDefinition(s.meta))
}
