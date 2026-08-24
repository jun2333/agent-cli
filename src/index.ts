#!/usr/bin/env node
import OpenAI from 'openai'
import { config } from './config.js'
import { createTools } from './tools/index.js'
import { runAgentLoop, type LoopEvent } from './agent/loop.js'
import { TUI, type TUIHandlers } from './ui/tui.js'

const client = new OpenAI({
  apiKey: 'ollama',
  baseURL: config.ollamaBaseUrl,
})

const SYSTEM_PROMPT = `你是一个运行在终端里的通用编程助手，能执行 shell 命令、读写文件来完成用户的开发任务。

规则：
- 需要执行命令、读写文件时，调用对应工具；可以多轮调用（先读再改再验证）
- 回答简洁，用中文
- 工具执行失败时，先看错误信息再决定下一步，不要盲目重试
- 完成任务时，简要说明你做了什么和结果`

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
  const handle = (event: LoopEvent) => {
    switch (event.type) {
      case 'status':
        if (event.phase === 'llm_start') {
          ui?.addThinking()
          ui?.setStatus('思考中…')
        } else if (event.phase === 'tool_start') {
          ui?.setStatus(`工具: ${event.name}…`)
        }
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
          ui?.setStatus('回答中…')
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

  if (args[0] === '--version' || args[0] === '-v') {
    console.log('agent-cli 0.1.0')
    return
  }
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(`用法: agent-cli [问题]

  agent-cli           进入交互模式
  agent-cli "问题"     单轮问答后退出（便于脚本调用）

${HELP_TEXT}`)
    return
  }

  // 非交互单轮模式：agent-cli "问题"
  if (args.length > 0) {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: args.join(' ') },
    ]
    runTurn(messages, null)
      .then(() => process.exit(0))
      .catch((e) => {
        console.error('错误:', e.message)
        process.exit(1)
      })
    return
  }

  // === 交互模式：自研 DECSTBM TUI ===
  const ui = new TUI(BANNER)
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: SYSTEM_PROMPT }]
  let running = false
  let queue: string[] = []
  let currentAbort: AbortController | null = null

  async function processMessage(text: string) {
    ui.addUserMessage(text)
    messages.push({ role: 'user', content: text })

    running = true
    const ac = new AbortController()
    currentAbort = ac
    try {
      const answer = await runTurn(messages, ui, ac.signal)
      if (answer) messages.push({ role: 'assistant', content: answer })
    } catch (e: any) {
      if (ac.signal.aborted) {
        ui.addInfo('（已打断）')
        ui.setStatus('已打断')
      } else {
        ui.showError('错误: ' + e.message)
        ui.setStatus('出错')
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
      ui.setStatus(`处理队列 (剩 ${queue.length})`)
      await processMessage(next)
    } else {
      ui.setStatus('Ready')
    }
  }

  const handlers: TUIHandlers = {
    onEnter: (text) => {
      if (text === '/exit' || text === '/quit') {
        ui.exit()
        process.exit(0)
        return
      }
      if (text === '/clear') {
        messages.length = 1
        queue = []
        ui.clear()
        return
      }
      if (text === '/help') {
        ui.addInfo(HELP_TEXT)
        return
      }
      if (running) {
        queue.push(text)
        ui.addUserMessage(text)
        ui.addInfo('（已排队，当前任务完成后处理）')
      } else {
        void processMessage(text)
      }
    },
    onExit: () => {
      ui.exit()
      process.exit(0)
    },
    onInterrupt: () => {
      if (running && currentAbort) {
        currentAbort.abort()
        ui.addInfo('（发送打断…）')
      }
    },
  }

  ui.enter(handlers)
}

main()
