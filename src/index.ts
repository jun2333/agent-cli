#!/usr/bin/env node
import readline from 'readline'
import OpenAI from 'openai'
import { config } from './config.js'
import { createTools } from './tools/index.js'
import { runAgentLoop, type LoopEvent } from './agent/loop.js'
import { TUI, type TUIHandlers, type StatusKind } from './ui/tui.js'
import {
  loadSession,
  saveSession,
  ensureAgentCliDir,
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

// 纯文本 banner（颜色由 TUI 渲染）
const BANNER = [
  '    _    ____ _____ _   _ _____',
  '   / \\  / ___| ____| \\ | |_   _|',
  '  / _ \\| |  _|  _| |  \\| | | |',
  ' / ___ \\ |_| | |___| |\\  | | |',
  '/_/   \\_\\____|_____|_| \\_| |_|',
  `v0.1.0 · ${config.chatModel} · /help 查看帮助，Ctrl+C 退出`,
  '',
]

const HELP_TEXT = `命令：
  /exit, /quit  退出
  /clear        重开会话（清屏）
  /help         显示帮助

快捷键：
  Ctrl+C        退出
  Esc           打断当前 agent（消息进队列）
  ↑ / ↓         历史输入
  ← / →         移动光标`

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
 * 跑一轮 agent loop。
 * ui 为 null 时（非交互模式）直接输出到 stdout；否则通过 TUI 渲染。
 * signal 用于 ESC 打断。
 */
async function runTurn(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ui: TUI | null,
  signal?: AbortSignal,
): Promise<string> {
  const { definitions, implementations } = createTools()

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
    }
  }

  for await (const event of runAgentLoop({
    messages,
    definitions,
    implementations,
    client,
    model: config.chatModel,
    maxIterations: config.maxIterations,
    signal,
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
    runTurn(messages, null)
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

async function startInteractive(systemPrompt: string, resumeFlag: boolean) {
  ensureAgentCliDir()
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
      loaded = loadSession(sessionId)
    } else {
      sessionId = newSessionId()
    }
  } else {
    sessionId = newSessionId()
  }

  const ui = new TUI(BANNER)
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
  let queue: string[] = []
  let currentAbort: AbortController | null = null

  async function processMessage(text: string) {
    ui.addUserMessage(text)
    messages.push({ role: 'user', content: text })
    saveSession(messages, sessionId) // 用户消息落盘

    running = true
    const ac = new AbortController()
    currentAbort = ac
    try {
      const answer = await runTurn(messages, ui, ac.signal)
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

  const handlers: TUIHandlers = {
    onEnter: (text) => {
      if (text === '/exit' || text === '/quit') {
        exitApp(0)
        return
      }
      if (text === '/clear') {
        messages.length = 1
        queue = []
        ui.clear()
        saveSession(messages, sessionId) // 清空磁盘会话
        return
      }
      if (text === '/help') {
        ui.addInfo(HELP_TEXT)
        return
      }
      if (text === '/memory') {
        const idx = readMemoryIndex()
        ui.addInfo(idx.trim() ? idx : '暂无记忆')
        return
      }
      if (running) {
        queue.push(text)
        ui.addUserMessage(text)
        ui.addInfo('Queued. Will run after the current task.')
      } else {
        void processMessage(text)
      }
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
