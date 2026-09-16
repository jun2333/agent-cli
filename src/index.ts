#!/usr/bin/env node
import readline from 'readline'
import OpenAI from 'openai'
import { config } from './config.js'
import { createTools, type ContentPart } from './tools/index.js'
import { runAgentLoop, type LoopEvent } from './agent/loop.js'
import { TUI, type TUIHandlers, type StatusKind } from './ui/tui.js'
import type { SelectorItem } from './ui/selector.js'
import {
  getCapabilities,
  listChatModels,
  primeCapabilities,
  type ModelCapabilities,
  type ModelInfo,
} from './models.js'
import { loadUserConfig, saveUserConfig } from './user-config.js'
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

const HELP_TEXT = `命令：
  /exit, /quit  退出
  /clear        重开会话（清屏）
  /model        切换模型与思考等级
  /memory       查看记忆索引
  /help         显示帮助

快捷键：
  Ctrl+C        退出
  Esc           打断当前 agent（消息进队列）
  ↑ / ↓         多行时行间移动，否则历史输入
  ← / →         移动光标
  Ctrl+J        插入换行
  Alt+Enter     插入换行
  Ctrl+V        粘贴剪贴板图片（无图则粘贴文本）
  Ctrl+G        用外部编辑器撰写提示词`

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
  const { definitions, implementations } = createTools({ currentModel: opts.model })

  // think 只对**确认支持** thinking 的模型注入：能力未知（null，如 Ollama 未启动）或明确不支持时
  // 都不传，避免把无意义的顶层字段发给上游（getCapabilities 有进程内缓存，开销可忽略）。
  const caps = await getCapabilities(opts.model)
  const think = caps?.thinking === true ? opts.think : undefined

  let answer = ''
  let answerStarted = false
  // LLM 事件阶段 → 状态栏（统一英文；tool_end 不更新，避免"正在运行"残留）
  const phaseToStatus: Record<'llm_start' | 'tool_start', StatusKind> = {
    llm_start: 'thinking',
    tool_start: 'tool',
  }
  const handle = (event: LoopEvent) => {
    switch (event.type) {
      case 'status':
        if (!ui || event.phase === 'tool_end') break
        if (event.phase === 'llm_start') ui.addThinking()
        ui.setStatus(phaseToStatus[event.phase], event.phase === 'tool_start' ? event.name : undefined)
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
          ui?.setStatus('answering')
        }
        if (ui) ui.appendToLast(event.content)
        else process.stdout.write(`\x1b[1m${event.content}\x1b[0m`)
        break
      case 'tool':
        if (ui) ui.addToolLine(`${event.name} ${formatArgs(event.args)}`)
        else process.stdout.write(`\n${DIM}[tool] ${event.name} ${formatArgs(event.args)}${RESET}\n`)
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

function main() {
  const args = process.argv.slice(2)
  // 组装 system prompt（用户根提示词 > 默认，追加 memory）
  const systemPrompt = buildSystemPrompt()

  if (args[0] === '--version' || args[0] === '-v') {
    console.log('agent-cli 0.1.0')
    return
  }
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(`用法: agent-cli [选项] [问题]

  agent-cli              进入交互模式（自动恢复上次会话）
  agent-cli -r           选择历史会话恢复
  agent-cli "问题"        单轮问答后退出（便于脚本调用）

选项：
  -r, --resume  选择历史会话恢复

${HELP_TEXT}`)
    return
  }

  const resumeFlag = args[0] === '--resume' || args[0] === '-r'

  // 非交互单轮模式：agent-cli "问题"
  if (args.length > 0 && !resumeFlag) {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: args.join(' ') },
    ]
    // 非交互单轮：沿用配置模型、不注入 think（与改动前的请求体完全一致，避免脚本行为漂移）
    runTurn(messages, null, { model: config.chatModel })
      .then(() => process.exit(0))
      .catch((e) => {
        console.error('Error:', e.message)
        process.exit(1)
      })
    return
  }

  // 交互模式：自研 DECSTBM TUI
  void startInteractive(systemPrompt, resumeFlag)
}

/**
 * 交互模式入口：会话恢复/锁 → 模型与等级装配 → TUI 编排（命令分发）。
 * 导出仅为让 e2e（`src/index.e2e.test.ts`）在进程内驱动真实的入口编排；
 * 正常启动路径仍是文件末尾的 `main()`。
 */
export async function startInteractive(systemPrompt: string, resumeFlag: boolean) {
  ensureAgentCliDir()
  // 当前模型与思考等级：用户配置优先，缺省回落 config.chatModel / 'low'。
  // 这两个闭包变量是运行时的**唯一事实来源**——状态栏、agent loop 的 model/think、
  // view_image 的能力预检（经 runTurn → createTools 注入）三者都读它们。
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
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...(loaded ?? []),
  ]
  // 统一退出：先释放会话锁再退出（保证解锁及时，异常退出靠 pid 探测兜底）
  const exitApp = (code = 0) => {
    releaseSessionLock(sessionId)
    ui.exit()
    process.exit(code)
  }
  let running = false
  // 队列项与 processMessage 都接受「纯文本或带图的多模态部件」（TUI 的 onEnter 已放宽）
  let queue: Array<string | ContentPart[]> = []
  let currentAbort: AbortController | null = null

  async function processMessage(text: string | ContentPart[]) {
    ui.addUserMessage(text)
    messages.push({ role: 'user', content: text })
    saveSession(messages, sessionId) // 用户消息落盘

    running = true
    const ac = new AbortController()
    currentAbort = ac
    try {
      const answer = await runTurn(messages, ui, { model: currentModel, think: thinkLevel, signal: ac.signal })
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
   * 命令分发表（I-9）：`knowledge/standards/code-style.md:43` 要求「大 if/else 用枚举 + 映射表替代」。
   * 各分支体异质（同步落盘 / 异步取模型列表），故值统一为 `() => void | Promise<void>`，
   * 由 `handleSubmit` 统一 `await`；未知输入不在表中，落回「入队或直接处理」路径。
   *
   * ⚠️ 用 Map 而非对象字面量：key 来自用户输入，对象字面量会命中原型链上的
   * `constructor`/`toString` 等键，把普通输入误判成命令（并调用到非命令函数）。
   *
   * 语义约束（与重构前的 5 连 if 逐条对齐，勿合并分支）：
   * - `/exit`、`/quit` → 立即退出（**不得**被 running 状态拦下）
   * - `/clear` → 清空 messages/queue + ui.clear() + 落盘
   * - `/model` → 先查 running（运行中拒绝并提示），否则 await runModelCommand()
   */
  const COMMANDS = new Map<string, () => void | Promise<void>>([
    ['/exit', () => exitApp(0)],
    ['/quit', () => exitApp(0)], // /quit 是 /exit 的别名，指向同一行为
    [
      '/clear',
      () => {
        messages.length = 1
        queue = []
        ui.clear()
        saveSession(messages, sessionId) // 清空磁盘会话
      },
    ],
    ['/help', () => ui.addInfo(HELP_TEXT)],
    [
      '/memory',
      () => {
        const idx = readMemoryIndex()
        ui.addInfo(idx.trim() ? idx : '暂无记忆')
      },
    ],
    [
      '/model',
      async () => {
        // 运行期间拒绝切换：否则"本轮到底用哪个模型"含糊不清，且切换与进行中的对话会交错
        if (running) {
          ui.addInfo('Agent 正在运行，请等本轮结束（或按 Esc 打断）后再切换模型。')
          return
        }
        await runModelCommand()
      },
    ],
  ])

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
      exitApp(0)
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
}

main()
