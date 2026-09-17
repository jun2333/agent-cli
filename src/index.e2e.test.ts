/**
 * index.e2e.test.ts — 入口编排端到端（task-plan Step 12）
 *
 * 在进程内驱动**真实的 `startInteractive`**：mock 终端（TermSim）+ mock stdin + mock Ollama
 * （`models.setModelsDeps`）+ mock OpenAI client，覆盖：
 * - `/model` 列表：标注能力、过滤 embedding 类（AC-21/22）
 * - 含 thinking → 四档等级；不含 → 跳过等级（AC-23）
 * - 切换后状态栏更新、写入 config.json、已累积消息保留（AC-24/31，D22）
 * - 切换后**下一轮请求**用新模型与新等级（AC-25）
 * - `ollama list` 为空 → 明确提示不崩溃（AC-27）
 * - agent running 期间 `/model` 被拒绝
 * - `/help` 含新增快捷键与 `/model`
 *
 * 驱动方式说明：`src/index.ts` 末尾直接调用 `main()`，因此 import 之前先把 `process.argv`
 * 设为 `--version`（main 打印版本后立即 return，不启动 TUI），随后只调用导出的 `startInteractive`。
 * 这样无需为测试改动入口结构。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TermSim } from './testing/term-sim.js'
import { config } from './config.js'
import { setModelsDeps, resetModelsDeps } from './models.js'
import { setClipboardDeps, resetClipboardDeps } from './clipboard.js'
import { acquireSessionLock, listSessions, sessionWorkspaceDir } from './session.js'
import { InteractionBroker } from './interaction.js'
import { PermissionController } from './permissions.js'
import { TaskManager } from './tasks.js'

/** 被 mock 的 OpenAI client 记录的请求参数（每轮 runTurn 一条） */
const h = vi.hoisted(() => ({
  createCalls: [] as any[],
  /** 非空时本轮请求会先等它 resolve（用于制造"agent 正在运行"状态） */
  gate: null as Promise<void> | null,
  /** 非空时下一次请求返回一个 view_image 工具调用（只消费一次），用于验证工具链路 */
  toolCall: null as { name: string; args: string } | null,
  /**
   * 非空时下一次请求以该 finish_reason 结束且**不产出 content**
   * （模拟真实用户反馈的"思考着就停了"：上下文被思考耗尽 → length）。
   */
  finishReason: null as string | null,
}))

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = {
      completions: {
        // 默认空流：无 token、无 tool_calls → agent loop 立即结束（测试只关心请求参数）；
        // 设了 h.toolCall 时首次调用返回一个工具调用，用于驱动真实的工具执行链路。
        create: async (params: any) => {
          h.createCalls.push(params)
          if (h.gate) await h.gate
          const fr = h.finishReason
          h.finishReason = null
          if (fr) {
            return (async function* () {
              yield { choices: [{ delta: { reasoning: '思考中…' }, finish_reason: null }] }
              yield { choices: [{ delta: {}, finish_reason: fr }] }
            })()
          }
          const call = h.toolCall
          h.toolCall = null
          if (!call) return (async function* () {})()
          return (async function* () {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call_1', type: 'function', function: { name: call.name, arguments: call.args } },
                    ],
                  },
                },
              ],
            }
          })()
        },
      },
    }
  }
  return { default: FakeOpenAI }
})

const SYSTEM = 'SYSTEM-PROMPT'

/** 24 行终端 + INPUT_ROWS=5 → 状态栏在第 16 行（与 tui.e2e.test.ts 同一套布局常量） */
const STATUS_ROW = 16
/** 输入内容窗口首行（第 17 行是上边框，18..20 是内容窗口） */
const INPUT_FIRST = 18

/** 最小 PNG 字节串（内容不重要，只要能被 base64 编码成 data URL） */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CAPS_VL = ['completion', 'vision', 'tools', 'thinking']
const CAPS_TEXT = ['completion', 'tools']
const CAPS_EMBED = ['embedding']

/** 默认模型清单：两个对话模型 + 一个 embedding 类（后者用于验证过滤） */
const CAPS_BY_MODEL: Record<string, string[]> = {
  'qwen3-vl:8b-thinking': CAPS_VL,
  'qwen3:8b': CAPS_TEXT,
  'bge-m3': CAPS_EMBED,
}

let term: TermSim
/**
 * 原始 stdout 写入串（逐次累积，未经 TermSim 解析）。
 * 退出收尾（FR-3）的可观测点在这里：TermSim 不模拟 alt screen（`?1049l`）也不认模式序列，
 * 「清屏之后只剩一行 bye」只能对原始写入串断言（AC-15/18）。
 */
let rawWrites: string[]
let stdin: EventEmitter & Record<string, any>
let tmp: string
let origAgentDir: string | undefined
let origArgv: string[]
let startInteractive: (
  systemPrompt: string,
  resumeFlag: boolean,
  opts?: { autoAccept?: boolean; permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypass' },
) => Promise<void>
/** 非交互单轮（`ui === null`）的轮次实现，用于覆盖 stderr 输出通道（N-8①） */
let runTurn: typeof import('./index.js')['runTurn']
/** 统一退出收尾工厂（FR-3；AC-16/17 直接注入假 deps 断言顺序） */
let createShutdown: typeof import('./index.js')['createShutdown']
let logSpy: ReturnType<typeof vi.spyOn>

/** 模拟一次 keypress（name 省略表示无名按键，extra 可覆盖 ctrl/meta） */
function press(ch: string, name?: string, extra: Record<string, unknown> = {}) {
  stdin.emit('keypress', ch, {
    name,
    ctrl: false,
    shift: false,
    meta: false,
    sequence: ch,
    ...extra,
  })
}

/** 输入一段普通字符 */
function type(s: string) {
  for (const ch of s) press(ch, ch)
}

/** 等待异步按键处理（/model 要 await listChatModels，是 async）落地 */
async function flush() {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
}

/** 提交一行命令 */
async function submit(line: string) {
  type(line)
  press('', 'return')
  await flush()
}

/** 生成 `ollama list` 输出（表头 + 每个模型一行） */
function listOutput(models: Record<string, string[]>): string {
  const rows = Object.keys(models).map((name, i) => `${name}  id${i}  5.0 GB  1 day ago`)
  return ['NAME  ID  SIZE  MODIFIED', ...rows, ''].join('\n')
}

/** 启动入口编排（真实 startInteractive），返回后 TUI 已接管模拟终端 */
async function launch(
  opts: { models?: Record<string, string[]> | null; permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypass' } = {},
) {
  const models = opts.models === undefined ? CAPS_BY_MODEL : opts.models
  setModelsDeps({
    listModels: async () => (models ? listOutput(models) : ''),
    showModel: async (model: string) => ({ capabilities: models?.[model] ?? [] }),
  })
  await startInteractive(SYSTEM, false, opts.permissionMode ? { permissionMode: opts.permissionMode } : undefined)
  await flush()
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-cli-index-e2e-'))
  origAgentDir = process.env.AGENT_CLI_DIR
  process.env.AGENT_CLI_DIR = tmp
  h.createCalls.length = 0
  h.gate = null
  h.toolCall = null
  h.finishReason = null

  term = new TermSim(24, 80)
  rawWrites = []
  Object.defineProperty(process.stdout, 'columns', { value: term.cols, configurable: true })
  Object.defineProperty(process.stdout, 'rows', { value: term.rows, configurable: true })
  ;(process.stdout as any).write = (s: string) => {
    rawWrites.push(s)
    term.write(s)
    return true
  }
  ;(process.stdout as any).on = () => {}
  ;(process.stdout as any).removeListener = () => {}

  stdin = new EventEmitter() as EventEmitter & Record<string, any>
  stdin.isTTY = true
  stdin.resume = () => {}
  stdin.pause = () => {}
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => {}
  ;(process.stdin as any).on = stdin.on.bind(stdin)
  ;(process.stdin as any).removeListener = stdin.removeListener.bind(stdin)
  ;(process.stdin as any).resume = stdin.resume
  ;(process.stdin as any).pause = stdin.pause
  ;(process.stdin as any).setRawMode = stdin.setRawMode
  ;(process.stdin as any).setEncoding = stdin.setEncoding
  ;(process.stdin as any).isTTY = true

  // import index.ts 会执行 main()：让 argv 命中 --version 分支，打印版本后直接返回
  origArgv = process.argv
  process.argv = ['node', join(process.cwd(), 'src/index.ts'), '--version']
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  ;({ startInteractive, runTurn, createShutdown } = await import('./index.js'))
})

afterEach(() => {
  // 兜底清理：FR-2 的后台任务用例若中途失败，别把 `sleep 47xx` 留在机器上
  //（标记只用于本文件的用例，避免误杀其他进程）
  try {
    execSync("pkill -f 'sleep 47' || true", { stdio: 'ignore' })
  } catch {
    // pkill 不存在/无匹配都不影响测试
  }
  logSpy.mockRestore()
  process.argv = origArgv
  resetModelsDeps()
  resetClipboardDeps()
  if (origAgentDir === undefined) delete process.env.AGENT_CLI_DIR
  else process.env.AGENT_CLI_DIR = origAgentDir
  rmSync(tmp, { recursive: true, force: true })
})

/** 读取 /model 写入的用户配置 */
function savedConfig(): any {
  return JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf8'))
}

describe('入口编排：/model 列表', () => {
  it('列出本地对话模型、标注能力，并过滤掉 embedding 类', async () => {
    await launch()
    await submit('/model')

    // 主文本：模型名；副文本：能力标注
    expect(term.contains('qwen3-vl:8b-thinking')).toBe(true)
    expect(term.contains('vision · tools · thinking')).toBe(true)
    expect(term.contains('qwen3:8b')).toBe(true)
    // bge-m3 只有 embedding 能力 → 不应出现在列表中（AC-21）
    expect(term.contains('bge-m3')).toBe(false)
  })

  it('ollama list 不可用（空列表）时给出明确提示且不崩溃（AC-27）', async () => {
    await launch({ models: null })
    await submit('/model')

    expect(term.contains('未找到可用对话模型')).toBe(true)
    // 未进入选择器：输入框仍在（界面未崩）
    expect(term.row(STATUS_ROW)).toContain('Ready')
  })
})

describe('入口编排：/model 切换与等级', () => {
  it('支持 thinking 的模型 → 展示 low/medium/high/max 四档（无"关闭"项）', async () => {
    await launch()
    await submit('/model')
    press('', 'return') // 选中 qwen3-vl:8b-thinking
    await flush()

    expect(term.contains('选择思考等级（qwen3-vl:8b-thinking）')).toBe(true)
    for (const level of ['low', 'medium', 'high', 'max']) {
      expect(term.contains(level)).toBe(true)
    }
    expect(term.contains('off')).toBe(false)
    expect(term.contains('关闭')).toBe(false)
  })

  it('不支持 thinking 的模型 → 跳过等级选择，直接应用', async () => {
    await launch({ models: { 'qwen3:8b': CAPS_TEXT } })
    await submit('/model')
    press('', 'return') // 选中 qwen3:8b
    await flush()

    expect(term.contains('选择思考等级')).toBe(false)
    expect(term.contains('已切换到 qwen3:8b')).toBe(true)
  })

  it('切换后：状态栏更新、配置落盘、历史消息保留（AC-24/31，D22）', async () => {
    await launch()
    await submit('/model')
    press('', 'return') // 选模型
    await flush()
    press('', 'down') // low → medium
    press('', 'down') // → high
    press('', 'return')
    await flush()

    // 状态栏常驻显示「模型/等级」
    expect(term.row(STATUS_ROW)).toContain('qwen3-vl:8b-thinking/high')
    // 配置持久化
    expect(savedConfig()).toEqual({ model: 'qwen3-vl:8b-thinking', thinkLevel: 'high' })
    // 切换提示 + 会话未重开（历史消息保留，不清空）
    expect(term.contains('已切换到 qwen3-vl:8b-thinking（思考等级 high）')).toBe(true)
    expect(term.contains('New session')).toBe(true)
  })

  it('切换后下一轮请求使用新模型与新等级（AC-25）', async () => {
    await launch()
    await submit('/model')
    press('', 'return') // 选 qwen3-vl:8b-thinking
    await flush()
    press('', 'down') // low → medium
    press('', 'down') // → high
    press('', 'return')
    await flush()

    await submit('你好')
    expect(h.createCalls).toHaveLength(1)
    expect(h.createCalls[0].model).toBe('qwen3-vl:8b-thinking')
    expect(h.createCalls[0].think).toBe('high')
  })

  it('切换到不支持 thinking 的模型后，请求不再注入 think（I-7）', async () => {
    await launch({ models: { 'vl-model:8b': CAPS_VL, 'text-model:8b': CAPS_TEXT } })
    await submit('/model')
    press('', 'down') // vl-model:8b → text-model:8b
    press('', 'return') // 无 thinking → 跳过等级选择
    await flush()

    await submit('你好')

    // 沿用当前等级但不注入：非 thinking 模型收到顶层 think 无意义（能力未知时同样不注入）
    expect(h.createCalls).toHaveLength(1)
    expect(h.createCalls[0].model).toBe('text-model:8b')
    expect(h.createCalls[0].think).toBeUndefined()
  })

  it('切换后 view_image 的能力预检跟随新模型（集成缺口：不再是 config.chatModel）', async () => {
    // 假模型名与 config.chatModel 不同，才能区分"预检读的是旧值还是新值"
    await launch({ models: { 'vl-model:8b': CAPS_VL, 'text-model:8b': CAPS_TEXT } })
    const imgPath = join(tmp, 'images', 'shot.png')
    mkdirSync(join(tmp, 'images'), { recursive: true })
    writeFileSync(imgPath, PNG_BYTES)

    await submit('/model')
    press('', 'return') // 选中 vl-model:8b（有 vision → 进等级选择）
    await flush()
    press('', 'return') // 选等级 low
    await flush()

    // 下一轮：LLM 返回一个 view_image 工具调用 → 走真实工具执行链路
    h.toolCall = { name: 'view_image', args: JSON.stringify({ path: imgPath }) }
    await submit('看看这张图')

    // 工具结果回传进第二轮请求：content 是 ContentPart[] 且含 image_url
    // （若预检仍读 config.chatModel，会因"不支持视觉"返回字符串错误，断言即失败）
    const toolMsg = h.createCalls[1].messages.find((m: any) => m.role === 'tool')
    expect(Array.isArray(toolMsg.content)).toBe(true)
    expect(JSON.stringify(toolMsg.content)).toContain('image_url')
  })

  it('Esc 取消模型选择 → 不写入配置、状态栏不变', async () => {    await launch()
    await submit('/model')
    press('', 'escape')
    await flush()

    expect(term.contains('已取消模型切换')).toBe(true)
    // 状态栏保持初始值（config.chatModel 的默认模型），未被 Esc 改动
    expect(term.row(STATUS_ROW)).toContain(`${config.chatModel}/low`)
    expect(() => savedConfig()).toThrow()
  })

  it('agent 运行期间拒绝切换（避免与进行中的对话交错）', async () => {
    await launch()
    // 让本轮请求挂起 → running=true
    let release!: () => void
    h.gate = new Promise<void>((r) => {
      release = r
    })
    type('先跑一轮')
    press('', 'return')
    await flush()

    await submit('/model')
    expect(term.contains('Agent 正在运行')).toBe(true)
    expect(term.contains('选择模型')).toBe(false)

    release()
    h.gate = null
    await flush()
  })
})

describe('入口编排：/help', () => {
  it('包含新增快捷键与 /model 说明', async () => {
    await launch()
    await submit('/help')

    for (const text of ['Ctrl+J', 'Alt+Enter', 'Ctrl+V', 'Ctrl+G', '/model']) {
      expect(term.contains(text)).toBe(true)
    }
  })
})

/**
 * I-9：命令分发从 5 连 if 改为映射表。重构只换分发结构、不动行为，
 * 故这里逐条锁定「别名同行为 / 运行中不被拦 / 清屏并落盘 / 记忆索引 / 未知输入不误判」。
 */
describe('入口编排：命令分发表（I-9 语义回归）', () => {
  it('/quit 与 /exit 行为一致：立即退出', async () => {
    await launch()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any)

    await submit('/quit')

    expect(exitSpy).toHaveBeenCalledWith(0)
    exitSpy.mockRestore()
  })

  it('/exit 在 agent 运行期间仍立即退出（不被 running 状态拦下）', async () => {
    await launch()
    // 让本轮请求挂起 → running=true
    let release!: () => void
    h.gate = new Promise<void>((r) => {
      release = r
    })
    type('先跑一轮')
    press('', 'return')
    await flush()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any)

    await submit('/exit')

    // 与 /model 的"运行中拒绝"不同：/exit 必须在 running 时也立即退出
    expect(exitSpy).toHaveBeenCalledWith(0)

    exitSpy.mockRestore()
    release()
    h.gate = null
    await flush()
  })

  it('/clear 清空界面、内存消息与磁盘会话', async () => {
    await launch()
    await submit('你好')
    expect(term.contains('You: 你好')).toBe(true)
    expect(listSessions()[0].messageCount).toBe(1) // 用户消息已落盘

    await submit('/clear')

    expect(term.contains('You: 你好')).toBe(false) // 界面已清
    expect(term.contains('查看帮助')).toBe(true) // 清屏后从 banner 重新渲染（banner 末行含该文案）
    expect(listSessions()[0].messageCount).toBe(0) // 磁盘会话被清空（只剩空数组）
  })

  it('/memory 无记忆文件时提示"暂无记忆"', async () => {
    await launch()
    await submit('/memory')

    expect(term.contains('暂无记忆')).toBe(true)
  })

  it('未知输入不被映射表误判：原型链键 constructor 仍走正常消息路径', async () => {
    await launch()
    await submit('constructor')

    // 若用对象字面量做映射表，会命中原型链上的 Object.prototype.constructor 而被当成命令
    expect(h.createCalls).toHaveLength(1)
    expect(term.contains('You: constructor')).toBe(true)
  })
})

/**
 * 以下用例对应**真实 PTY 实测**发现的两个缺陷（注入式 e2e 全部漏掉）：
 * 1. 输入框含图片时 onEnter 收到的是 ContentPart[]，斜杠命令直接与字符串比较会全部落空
 *    → 贴图后 /exit 失效，被当成普通消息发送并触发上游 400；
 * 2. 直投路径没有视觉能力预检 → 无 vision 模型下抛原始 HTTP 400，提示不友好。
 */
describe('入口编排：含图片提交时的命令识别与能力预检（真实 PTY 实测回归）', () => {
  /** 注入假剪贴板：pngpaste 直接把 PNG 写到目标文件，避免真调系统剪贴板 */
  function injectClipboard() {
    setClipboardDeps({
      hasCommand: async (cmd: string) => cmd === 'pngpaste',
      run: async (_cmd: string, args: string[]) => {
        writeFileSync(args[0], PNG_BYTES)
        return ''
      },
    })
  }

  /** Ctrl+V 贴一张图进输入缓冲 */
  async function pasteImage() {
    injectClipboard()
    press('\x16', 'v', { ctrl: true })
    await flush()
  }

  it('含图片时 /help 仍被识别为命令，不会被当成消息发送', async () => {
    await launch()
    await pasteImage()
    expect(term.contains('[image: ')).toBe(true)

    await submit('/help')

    expect(term.contains('命令：')).toBe(true) // HELP_TEXT 已渲染
    expect(h.createCalls).toHaveLength(0) // 关键：没有当作消息发出去
  })

  it('含图片时 /exit 仍能退出（不当作消息）', async () => {
    await launch()
    await pasteImage()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any)

    await submit('/exit')

    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(h.createCalls).toHaveLength(0)
    exitSpy.mockRestore()
  })

  it('当前模型无 vision 时提交含图内容 → 明确错误，且不发请求', async () => {
    await launch({ models: { 'vl-model:8b': CAPS_VL, 'text-model:8b': CAPS_TEXT } })
    // 先切到无 vision 的模型（默认模型 config.chatModel 是有 vision 的）
    await submit('/model')
    press('', 'down') // vl-model:8b → text-model:8b
    press('', 'return') // 选中 text-model:8b（无 thinking → 跳过等级）
    await flush()

    await pasteImage()
    await submit('这是什么')

    expect(term.contains('不支持视觉能力')).toBe(true)
    expect(term.contains('/model')).toBe(true) // 提示里给出解决路径
    expect(h.createCalls).toHaveLength(0) // 关键：没有把图发给无 vision 的模型
  })

  it('当前模型有 vision 时含图提交正常发送为多模态 user 消息（回归）', async () => {
    await launch({ models: { 'vl-model:8b': CAPS_VL } })
    // 先切到有 vision 的模型
    await submit('/model')
    press('', 'return') // 选 vl-model:8b（有 thinking → 进等级）
    await flush()
    press('', 'return') // 选等级 low
    await flush()

    await pasteImage()
    await submit('这是什么')

    expect(h.createCalls).toHaveLength(1)
    const userMsg = h.createCalls[0].messages.find((m: any) => m.role === 'user')
    expect(Array.isArray(userMsg.content)).toBe(true)
    expect(JSON.stringify(userMsg.content)).toContain('image_url')
  })

  it('预检失败后回填原内容并复位状态，用户可切模型后重试（W-6）', async () => {
    await launch({ models: { 'vl-model:8b': CAPS_VL, 'text-model:8b': CAPS_TEXT } })
    // 先切到无 vision 的模型
    await submit('/model')
    press('', 'down') // vl-model:8b → text-model:8b
    press('', 'return')
    await flush()

    await pasteImage()
    await submit('这是什么')

    // ① 明确错误提示 + 解决路径（切模型后重试）
    expect(term.contains('不支持视觉能力')).toBe(true)
    expect(term.contains('请用 /model 切换')).toBe(true)
    // ② 原文本与图片占位符仍在输入框（submit() 的清空被回填抵消，不再丢输入）
    expect(term.row(INPUT_FIRST)).toContain('[image: ')
    expect(term.row(INPUT_FIRST)).toContain('这是什么')
    // ③ 状态栏复位为 Ready，而不是停在 Error
    expect(term.row(STATUS_ROW)).toContain('● Ready')
    expect(term.row(STATUS_ROW)).not.toContain('Error')
    // ④ 未发出请求
    expect(h.createCalls).toHaveLength(0)

    // 缓冲区是"活"的（不是渲染残影）：继续输入会追加到回填内容之后
    press('x', 'x')
    await flush()
    expect(term.row(INPUT_FIRST)).toContain('这是什么x')
  })

  it('能力探测失败（Ollama 未启动）→ 提示"无法探测"而非"不支持视觉"（I-8）', async () => {
    // showModel 抛异常 → getCapabilities 返回 null（能力未知），与"明确无 vision"是两种原因
    setModelsDeps({
      listModels: async () => listOutput({ 'vl-model:8b': CAPS_VL }),
      showModel: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
      },
    })
    await startInteractive(SYSTEM, false)
    await flush()

    await pasteImage()
    await submit('这是什么')

    expect(term.contains('无法探测模型能力')).toBe(true)
    expect(term.contains('Ollama 可能未启动')).toBe(true)
    expect(term.contains('不支持视觉能力')).toBe(false) // 不得把环境问题说成模型能力问题
    expect(h.createCalls).toHaveLength(0)
    // 输入同样被回填、状态同样复位
    expect(term.row(INPUT_FIRST)).toContain('这是什么')
    expect(term.row(STATUS_ROW)).toContain('● Ready')
  })

  it('agent 运行中预检失败 → 状态栏不被刷成 Ready（N-4②）', async () => {
    await launch({ models: { 'vl-model:8b': CAPS_VL, 'text-model:8b': CAPS_TEXT } })
    // 先切到无 vision 的模型，使含图提交必然预检失败
    await submit('/model')
    press('', 'down') // vl-model:8b → text-model:8b
    press('', 'return')
    await flush()

    // 让本轮请求挂起 → running=true，状态栏处于非 Ready（长工具调用期间同理）
    let release!: () => void
    h.gate = new Promise<void>((r) => {
      release = r
    })
    type('先跑一轮')
    press('', 'return')
    await flush()
    expect(term.row(STATUS_ROW)).toContain('Thinking') // 前置条件：状态栏此刻不是 Ready

    await pasteImage()
    await submit('这是什么')

    expect(term.contains('不支持视觉能力')).toBe(true)
    // 关键：running 时不得把 Thinking…/Running tool 无条件刷成 Ready（否则状态栏说谎，
    // 要等下一个流式事件才自愈）；修复前此处会变成 ● Ready
    expect(term.row(STATUS_ROW)).not.toContain('Ready')
    expect(term.row(STATUS_ROW)).toContain('Thinking')

    release()
    h.gate = null
    await flush()
  })
})

/**
 * 真实用户反馈："给一张图问它是啥内容，思考模型选了 max，它思考着就停了、也没完成"。
 * 根因：本机 Ollama /v1 上下文固定 4096 且无法按请求调大，图片 + 长思考耗尽预算后
 * 模型以 finish_reason='length' 结束、既无 content 也无 tool_calls；旧实现直接 return，
 * 用户看不到任何提示。以下用例锁住"必须把静默失败暴露给用户"。
 */
describe('入口编排：模型静默失败必须可见（真实用户反馈回归）', () => {
  /**
   * 把整屏行拼起来做子串匹配。
   * 长提示（截断文案约 230 显示列）会折成多行，而 `term.contains` 只查**单行**，
   * 直接用它会在折行边界处漏判。
   */
  function screenContains(text: string): boolean {
    return term.dump().join('').includes(text)
  }

  it('finish_reason=length（思考耗尽上下文）→ 界面显示可操作的截断提示，而非静默结束', async () => {
    await launch()
    h.finishReason = 'length'
    await submit('这张图里是什么内容？')

    expect(screenContains('模型输出被截断')).toBe(true)
    // 提示要给出可操作的出路
    expect(screenContains('/model')).toBe(true)
    expect(screenContains('OLLAMA_CONTEXT_LENGTH')).toBe(true)
    // 思考状态必须结束（不再停在 Thinking…），否则用户以为还在跑
    expect(term.row(STATUS_ROW)).not.toContain('Thinking')
  })

  it('finish_reason=stop 但没有任何产出 → 同样给出明确提示', async () => {
    await launch()
    h.finishReason = 'stop'
    await submit('随便问点什么')

    expect(screenContains('未产生任何回答')).toBe(true)
    expect(term.row(STATUS_ROW)).not.toContain('Thinking')
  })
})

/**
 * N-8①：非交互单轮路径（`agent-cli "问题"`，即 `runTurn` 的 `ui === null` 分支）此前整体无测试，
 * 其中「loop 的静默失败 → process.stderr.write」是 main() 在无 UI 时**唯一**的错误通道：
 * 若被误写成 stdout，脚本调用方会把提示当成模型回答解析。
 *
 * 这里直接驱动导出的 `runTurn(..., ui = null, ...)`（`main()` 的单轮分支只做参数装配后调用它），
 * 不额外改动入口结构。
 */
describe('非交互单轮路径：error 输出到 stderr（N-8①）', () => {
  /** 单轮消息（结构与 main() 的单轮分支一致） */
  const singleTurnMessages = () =>
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: '这张图里是什么？' },
    ] as unknown as Parameters<typeof runTurn>[0]

  it('finish_reason=length → 截断提示写入 stderr（不写 stdout），且不抛异常', async () => {
    await launch()
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    h.finishReason = 'length'

    await runTurn(singleTurnMessages(), null, { model: 'text-model:8b' })

    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderr).toContain('模型输出被截断')
    expect(h.createCalls).toHaveLength(1) // 确实跑了一轮请求
    // 关键：提示不得走 stdout（无 UI 时 stdout 是交给脚本消费的回答流）
    expect(term.dump().join('')).not.toContain('模型输出被截断')

    errSpy.mockRestore()
  })

  it('无任何产出（finish_reason=stop）→ 提示同样只走 stderr', async () => {
    await launch()
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    h.finishReason = 'stop'

    await runTurn(singleTurnMessages(), null, { model: 'text-model:8b' })

    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderr).toContain('未产生任何回答')
    expect(stderr.endsWith('\n')).toBe(true) // 每个提示自成一行，不与后续输出粘连

    errSpy.mockRestore()
  })
})

/**
 * FR-3：统一退出体验（AC-15/16/17）。
 *
 * - AC-15 走**真实编排**（真实 `startInteractive` + 真实命令表 + TermSim）：三条入口各跑一次，
 *   对原始写入串断言「`\x1b[2J\x1b[3J`（真清屏）之后只剩一行 bye」，bye 含 session id 与 `-r` 提示。
 * - AC-16/17 直接对 `createShutdown` 注入假 deps（记录调用顺序 / 真实临时锁文件）——
 *   `process.exit` 与信号 handler 若真跑会杀 vitest（design Risk R6），故必须注入。
 * - AC-18（单轮非 TTY）见 `src/index.noninteractive.e2e.test.ts`（该文件需要互斥的 argv 前置条件）。
 */
describe('入口编排：统一退出（FR-3）', () => {
  /** 取「最后一次真清屏之后」的可见文本（剥掉 ANSI 序列） */
  function visibleAfterLastClear(): string {
    const out = rawWrites.join('')
    const at = out.lastIndexOf('\x1b[2J\x1b[3J')
    expect(at).toBeGreaterThanOrEqual(0)
    return out.slice(at + '\x1b[2J\x1b[3J'.length).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  }

  /** 干净退出的统一断言：真清屏（且在 ALT_SCREEN_EXIT 之后）+ 清屏后恰好一行 bye（AC-15） */
  function expectCleanExit() {
    const out = rawWrites.join('')
    const altExit = out.lastIndexOf('\x1b[?1049l')
    const clear = out.lastIndexOf('\x1b[2J\x1b[3J')
    expect(altExit).toBeGreaterThanOrEqual(0) // 退出了 alt screen
    expect(clear).toBeGreaterThan(altExit) // 清屏必须在 ALT_SCREEN_EXIT **之后**（顺序不可换）
    const lines = visibleAfterLastClear()
      .split('\n')
      .filter((l) => l.trim())
    expect(lines).toHaveLength(1) // 清屏后只剩一行（不留残屏）
    // session id 形如 `session-<unixms>-<seq>`（src/session.ts:newSessionId）
    expect(lines[0]).toMatch(/^bye · session session-\d+-\d+ · 恢复：agent-cli -r$/)
  }

  /** 跑一条退出入口（真实 startInteractive）：三条入口必须产出相同的干净退出 */
  async function runExitEntry(kind: 'exit' | 'quit' | 'ctrl-c') {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any)
    await launch()
    if (kind === 'ctrl-c') {
      // TUI 在 raw mode 下把 Ctrl+C 报成 keypress（不是 SIGINT）→ 走 handlers.onExit → 同一收尾函数
      press('\x03', 'c', { ctrl: true })
    } else {
      await submit(kind === 'exit' ? '/exit' : '/quit')
    }
    await flush()
    expect(exitSpy).toHaveBeenCalledWith(0)
    exitSpy.mockRestore()
  }

  it('AC-15：/exit 入口 → 先清屏、再输出一行含 session id 与 -r 提示的 bye', async () => {
    await runExitEntry('exit')
    expectCleanExit()
  })

  it('AC-15：/quit 入口 → 与 /exit 同一收尾路径', async () => {
    await runExitEntry('quit')
    expectCleanExit()
  })

  it('AC-15：Ctrl+C 入口 → 与 /exit 同一收尾路径', async () => {
    await runExitEntry('ctrl-c')
    expectCleanExit()
  })

  /**
   * AC-16：`SIGINT`/`SIGTERM` 的 handler 与显式调用走**同一个收尾函数**，且顺序固定。
   *
   * ⚠️ 不用 `process.emit('SIGINT')` 触发：那会连 vitest 自己注册的 SIGINT 处理器一起触发。
   * 改为从 `process.listeners()` 里取出**本次新装的那个** handler 直接调用——这同时证明了
   * "handler 确实被注册在进程上"与"调用它就走这条路径"。
   */
  it('AC-16：SIGINT / SIGTERM 与显式调用同一收尾函数，顺序为 cancelAll→releaseLock→killAll→ui.exit→bye→exit', async () => {
    const expected = [
      'broker.cancelAll',
      'releaseLock:session-1-0',
      'tasks.killAll',
      'ui.exit',
      'write:bye · session session-1-0 · 恢复：agent-cli -r',
      'exit:0',
    ]

    const runWith = async (trigger: 'explicit' | 'SIGINT' | 'SIGTERM') => {
      const steps: string[] = []
      const before = new Set(process.listeners('SIGINT'))
      const shutdown = createShutdown({
        ui: { exit: () => steps.push('ui.exit') },
        sessionId: 'session-1-0',
        broker: { cancelAll: () => steps.push('broker.cancelAll') },
        tasks: {
          killAll: async () => {
            steps.push('tasks.killAll')
            return []
          },
        },
        releaseLock: (id) => steps.push(`releaseLock:${id}`),
        write: (s) => steps.push(`write:${s.trim()}`),
        exit: (c) => steps.push(`exit:${c}`),
        signals: true,
      })
      const afterInstall = process.listenerCount('SIGINT')

      if (trigger === 'explicit') {
        await shutdown(0)
      } else {
        const added = process.listeners(trigger).find((l) => !before.has(l))
        expect(typeof added).toBe('function')
        ;(added as () => void)() // 直接调用注册的 handler（避免触发 vitest 自身的信号处理）
        for (let i = 0; i < 50 && steps.length === 0; i++) await new Promise((r) => setImmediate(r))
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
      }

      // 收尾时摘除监听：不再累积在进程上（也保证退出后不再响应信号）
      expect(process.listenerCount('SIGINT')).toBe(afterInstall - 1)
      return steps
    }

    for (const trigger of ['explicit', 'SIGINT', 'SIGTERM'] as const) {
      expect(await runWith(trigger)).toEqual(expected)
    }
  })

  it('AC-16：幂等守卫——重复调用不再重跑收尾流程，只再执行一次 exit', async () => {
    const steps: string[] = []
    const shutdown = createShutdown({
      ui: { exit: () => steps.push('ui.exit') },
      sessionId: 'session-1-0',
      broker: { cancelAll: () => steps.push('broker.cancelAll') },
      tasks: {
        killAll: async () => {
          steps.push('tasks.killAll')
          return []
        },
      },
      releaseLock: () => steps.push('releaseLock'),
      write: (s) => steps.push(`write:${s.trim()}`),
      exit: (c) => steps.push(`exit:${c}`),
    })

    await shutdown(0)
    await shutdown(3)

    expect(steps.filter((s) => s === 'broker.cancelAll')).toHaveLength(1)
    expect(steps.filter((s) => s === 'ui.exit')).toHaveLength(1)
    expect(steps.filter((s) => s.startsWith('write:bye'))).toHaveLength(1)
    expect(steps).toContain('exit:3') // 第二次调用只透传退出码
  })

  it('AC-16：被终止任务清单在清屏（ui.exit）之后打印；无任务时不打印（AC-15 的"只剩一行 bye"）', async () => {
    const steps: string[] = []
    const shutdown = createShutdown({
      ui: { exit: () => steps.push('ui.exit') },
      sessionId: 'session-1-0',
      broker: { cancelAll: () => steps.push('broker.cancelAll') },
      tasks: {
        killAll: async () => {
          steps.push('tasks.killAll')
          return [{ taskId: 't-1', command: 'sleep 300', killed: true }]
        },
      },
      write: (s) => steps.push(`write:${s.split('\n')[0]}`),
      exit: () => steps.push('exit'),
    })

    await shutdown(0)

    expect(steps.indexOf('ui.exit')).toBeGreaterThan(steps.indexOf('tasks.killAll'))
    expect(steps.findIndex((s) => s.includes('已终止后台任务'))).toBeGreaterThan(steps.indexOf('ui.exit'))
  })

  it('AC-17：退出收尾后会话锁已释放，无残留 .lock', async () => {
    const id = 'session-lock-probe-0'
    expect(acquireSessionLock(id)).toBe(true)
    const lockFile = join(sessionWorkspaceDir(), `${id}.lock`)
    expect(existsSync(lockFile)).toBe(true)

    const shutdown = createShutdown({
      ui: { exit: () => {} },
      sessionId: id,
      broker: { cancelAll: () => {} },
      tasks: { killAll: async () => [] },
      write: () => {},
      exit: () => {}, // 不真退出，留在进程内断言锁文件
    })
    await shutdown(0)

    expect(existsSync(lockFile)).toBe(false)
  })
})

/**
 * FR-5：LLM 层交互原语（AC-30）——伪造 LLM 调 `ask_user`，浮层出现、用户选择作为工具结果
 * 回传、本轮继续执行。跑的是**真实链路**：FakeOpenAI → loop → executor → InteractionBroker →
 * TUI.openInteractionOverlay（同一分派路径，AC-27），而不是只驱动 broker。
 *
 * 键位形状取自真实 readline 探针（lesson 007 / D-7）：箭头/Esc 的 `str` 是 undefined、lone Esc 的
 * `meta` 是 true；这里用 `pressBare` 复刻，不用"整段字符串当 keypress"。
 */
describe('入口编排：ask_user 交互原语（AC-30）', () => {
  const STATUS_ROW_LOCAL = STATUS_ROW
  /** 轮询直到条件成立（真实等待浮层/第二轮请求） */
  async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
    const start = Date.now()
    for (;;) {
      const v = fn()
      if (v) return v as T
      if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时：条件未在预期时间内成立')
      await new Promise((r) => setTimeout(r, 15))
    }
  }
  /** 真实形状的"无 str"按键（箭头/Esc）：生产里 str 是 undefined */
  function pressBare(name: string, extra: Record<string, unknown> = {}) {
    stdin.emit('keypress', undefined, {
      name,
      ctrl: false,
      shift: false,
      meta: false,
      sequence: '',
      ...extra,
    })
  }

  it('LLM 调 ask_user（有选项）→ 浮层出现 → 选择回传为工具结果 → 本轮继续执行', async () => {
    await launch()
    h.toolCall = { name: 'ask_user', args: JSON.stringify({ question: '选哪个？', options: ['A', 'B'] }) }
    type('请你问我')
    press('', 'return')

    // ① 浮层出现：ask_user 的工具行已渲染 + 问题（浮层标题）在预留区
    await waitFor(() => term.contains('选哪个？'))
    expect(term.contains('ask_user')).toBe(true)

    // ② 用户选择第二项（↓ + Enter）
    pressBare('down', { sequence: '\x1b[B' })
    press('\r', 'return')

    // ③ 工具结果作为 tool 消息回传，本轮继续（发出第二轮请求）
    const second = await waitFor(() => h.createCalls[1])
    const toolMsg = second.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg).toBeTruthy()
    expect(toolMsg.content).toContain('"choice":"B"')
    expect(toolMsg.content).toContain('"answered":true')
    // 浮层已关闭、界面恢复（输入框仍在原位）
    expect(term.row(STATUS_ROW_LOCAL)).toContain('Ready')
    expect(term.contains('选哪个？')).toBe(false)
  })

  it('LLM 调 ask_user（无选项）→ input 形态 → 键入自由文本回传', async () => {
    await launch()
    h.toolCall = { name: 'ask_user', args: JSON.stringify({ question: '你的名字？' }) }
    type('请提问')
    press('', 'return')

    await waitFor(() => term.contains('你的名字？'))
    for (const ch of 'codebuddy') press(ch, ch)
    press('\r', 'return')

    const second = await waitFor(() => h.createCalls[1])
    const toolMsg = second.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('"answer":"codebuddy"')
  })

  it('非交互单轮：ask_user 被自动拒绝并计入 deniedCount（AC-28 的退出码依据）', async () => {
    await launch()
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const broker = new InteractionBroker(null, { interactive: false, autoAccept: false })
    h.toolCall = { name: 'ask_user', args: JSON.stringify({ question: '选哪个？', options: ['A', 'B'] }) }

    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: '请提问' },
    ] as unknown as Parameters<typeof runTurn>[0]
    await runTurn(messages, null, { model: 'text-model:8b', interaction: broker })

    expect(broker.deniedCount).toBe(1)
    const second = await waitFor(() => h.createCalls[1])
    const toolMsg = second.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('需交互但当前非交互')
    expect(toolMsg.content).toContain('"answered":false')
    // 提示走 stderr（无 UI 时的非交互通道），不污染 stdout 的回答流
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('需交互但当前非交互')
    errSpy.mockRestore()
  })
})

/**
 * FR-1 的端到端验证（AC-3 + AC-64）——跑**真实的 `runTurn` + `handle` + TUI**，
 * 用一个真的慢工具（`bash sleep`）在"执行期间"采样屏幕，而不是只驱动 TUI 的 API。
 *
 * AC-64 的结论（证据见 changes.md）：
 * - 修复**前**：执行期间状态栏恒为 `● Running tool`（工具名被第二次 tool_start 清空），
 *   且屏幕上**没有**工具行（工具行由执行完才 emit 的 `tool` 事件驱动）——
 *   "调工具期间显示 Ready"按字面**未复现**；真实体感是"状态栏无动画且丢了工具名 + 工具行全程缺席"。
 * - 修复**后**：执行期间状态栏为 `⠋ Running bash (0s)`，且工具行（带 spinner）已在屏幕上。
 */
describe('入口编排：FR-1 工具行实时化（AC-3 / AC-64）', () => {
  /** 轮询直到条件成立（真实等待慢工具执行；只用于本组用例） */
  async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
    const start = Date.now()
    for (;;) {
      const v = fn()
      if (v) return v as T
      if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时：条件未在预期时间内成立')
      await new Promise((r) => setTimeout(r, 15))
    }
  }

  /** 整区重建（DECSTBM 重设）次数：V-5 的可观测点（/jobs 用例也用它） */
  const rebuilds = () => (rawWrites.join('').match(/\x1b\[1;\d+r/g) ?? []).length

  it('慢工具执行期间：状态栏含工具名（不丢）且工具行已渲染；完成后同行变完成态（AC-2/AC-3/AC-64）', async () => {
    await launch()
    h.toolCall = { name: 'bash', args: JSON.stringify({ command: 'sleep 0.6' }) }
    type('跑个慢命令')
    press('', 'return')

    // 执行期间采样：工具行必须已经出现（旧实现只在执行完之后才有）
    // 注意：B7 起 default 模式下 bash 需要审批 → tool_start 在审批**之前**就已发出（loop 契约），
    // 因此工具行先于审批浮层出现；采样用整屏断言（浮层一旦打开布局会整体上移，行号不再固定）。
    const toolLine = await waitFor(() => term.dump().find((l) => l.includes('"command"')))
    expect(toolLine).toContain('bash')
    // 状态栏必须带工具名且不是 idle 文案（旧实现此处是 `● Running tool`，名字被清空）
    const statusLine = await waitFor(() => term.dump().find((l) => l.includes('Running bash')))
    expect(statusLine).not.toContain('Ready')

    // === B7 审批浮层（FR-6/AC-32 的交互侧）+ V-5 恒定高度 ===
    // 浮层布局（确定性）：title 1 行 + 消息 2 行（'命令执行' + '命令：…'）+ 提示 1 行 = 4
    // → contentRows = 24-5-1-4 = 14，状态栏 = 15，预留区 = 21..24（提示行恒在 24）
    const overlayTitle = await waitFor(() => term.dump().find((l) => l.includes('允许执行 bash')))
    expect(overlayTitle).toBeTruthy()
    expect(term.dump().join(' ')).toContain('命令执行')
    expect(term.row(15)).toContain('Running bash') // 状态栏随重建上移 1 行，仍带工具名
    expect(term.row(24)).toContain('y / n')
    // V-5：浮层生命周期内高度恒定 —— 无关键（↑↓）被浮层消费，不产生新的整区重建、行数不变
    const rebuildsAtOpen = rebuilds()
    press(undefined as any, 'down', { sequence: '\x1b[B' })
    await flush()
    expect(rebuilds()).toBe(rebuildsAtOpen)
    expect(term.row(24)).toContain('y / n') // 浮层仍在原位原行数
    expect(term.row(15)).toContain('Running bash')
    // 批准（y）→ 工具真正执行
    press('y', 'y')
    await flush()

    // 完成后同一行原地变完成态（含耗时与输出行数），且屏幕上只有一条工具行
    const done = await waitFor(() => term.dump().find((l) => l.includes('✓ bash')))
    expect(done).toMatch(/^✓ bash \d+\.\ds · 输出 \d+ 行$/)
    expect(term.dump().filter((l) => l.includes('✓ bash'))).toHaveLength(1)
    // 审批浮层已关闭：预留区清空（关闭走异步 relayout → 轮询）
    await waitFor(() => term.row(24).trim() === '')
  })

  it('B7：拒绝审批（n）→ bash 不执行，LLM 收到明确拒绝结果且本轮继续（AC-32 拒绝侧）', async () => {
    await launch()
    h.toolCall = { name: 'bash', args: JSON.stringify({ command: 'echo should-not-run' }) }
    await submit('跑个命令')

    // 等审批浮层 → 按 n 拒绝
    await waitFor(() => term.dump().some((l) => l.includes('允许执行 bash')))
    press('n', 'n')
    await flush()

    // 工具没有执行（无 ✓ bash 行），LLM 收到拒绝原因并继续（发起了第二轮请求）
    expect(term.dump().some((l) => l.includes('✓ bash'))).toBe(false)
    await waitFor(() => h.createCalls.length >= 2, 5000, '第二轮请求')
    const second = h.createCalls[1]
    const toolMsg = second.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('用户拒绝了 bash 的执行')
    expect(toolMsg.content).toContain('权限模式：default')
  })

  /**
   * W-1（reviewing 返工修复）：工具行的「输出 N 行」必须取**真实行数**。
   *
   * 修复前被数的是 `JSON.stringify({exitCode,stdout,stderr})` 信封（换行是转义的 `\n`）→
   * 恒为「输出 1 行」（上面的 `sleep 0.6` 用例因此只锁格式、锁不住数值）。
   * 这里跑真实编排：`bash seq 1 40` → 真 spawn → 工具行必须显示 40 行。
   */
  it('W-1：真实链路 `bash seq 1 40` → 工具行显示真实行数「输出 40 行」（修复前恒为 1）', async () => {
    await launch()
    h.toolCall = { name: 'bash', args: JSON.stringify({ command: 'seq 1 40' }) }
    await submit('跑个命令')

    await waitFor(() => term.dump().some((l) => l.includes('允许执行 bash')))
    press('y', 'y')
    await flush()

    const done = await waitFor(() => term.dump().find((l) => l.includes('✓ bash')))
    expect(done).toContain('输出 40 行')
    // 工具行只此一条（原地更新，没有重复行）
    expect(term.dump().filter((l) => l.includes('✓ bash'))).toHaveLength(1)
  })
})

/**
 * FR-4：斜杠补全在**真实编排**下的接线（AC-19 的"全部内置命令"= 生产命令表本身）。
 *
 * 上面 `tui.e2e.test.ts` 的 FR-4 用例注入的是测试自己的候选源（验证机制）；
 * 这里跑真实 `startInteractive` → 断言 `COMMAND_SPECS` 经 `createBuiltinSource` 注入后，
 * `/` 列出的就是**生产命令表**里的 6 个命令（接线断了这条必红）。
 *
 * ⚠️ `/` 的真实键位形状是"可打印符号、**没有 name 字段**"（readline 探针，lesson 007），
 * 故这里显式传 `name: undefined`，不用 `type()`（后者会给 `/` 塞上 name 与生产不一致）。
 */
describe('入口编排：斜杠补全接线（FR-4 / AC-19）', () => {
  it('输入 `/` → 菜单列出全部 10 个内置命令（超出 8 行视窗的最后一个经过滤可见）；Esc 关闭且保留输入', async () => {
    await launch()
    press('/', undefined, { sequence: '/' })
    await flush()

    // 布局推导（确定性，与 tui.ts 的 INPUT_ROWS=5 / STATUS_ROWS=1 一致）：
    // 24 行终端，10 个候选 → 菜单高度 min(10,8)+1 = 9 → contentRows = 24-5-1-9 = 9，
    // 状态栏 = contentRows+1 = 10，预留区首行 = contentRows+2+5 = 16。
    // ⚠️ B8 追加 `/hooks`：候选 9→10（菜单高度仍 9，布局行号不变 —— task-plan B8.5 收口）。
    const COMMANDS = ['/exit', '/quit', '/clear', '/help', '/memory', '/model', '/jobs', '/mode', '/permissions', '/hooks']
    const menuHeight = Math.min(COMMANDS.length, 8) + 1
    const contentRows = 24 - 5 - 1 - Math.max(3, menuHeight)
    const reservedFrom = contentRows + 2 + 5

    expect(term.row(contentRows + 1)).toContain('● Ready') // 状态栏随重建移动到 contentRows+1
    // 菜单视窗最多 8 项（MAX_OVERLAY_ITEMS）：前 8 个命令逐行可见
    for (let i = 0; i < 8; i++) expect(term.row(reservedFrom + i)).toContain(COMMANDS[i])
    expect(term.row(reservedFrom)).toContain('▶ /exit') // 首项默认选中
    expect(term.row(reservedFrom + menuHeight - 1)).toContain('Tab 填入') // 提示行恒在末行
    // 第 9/10 个候选（/permissions、/hooks）超出视窗 → 过滤后可见（滚动窗口机制在 tui.e2e 验证）
    for (const ch of 'per') press(ch, ch)
    await flush()
    expect(term.dump().join(' ')).toContain('/permissions')
    for (let i = 0; i < 3; i++) press('\x7f', 'backspace')
    await flush()
    for (const ch of 'hoo') press(ch, ch)
    await flush()
    expect(term.dump().join(' ')).toContain('/hooks')
    for (let i = 0; i < 3; i++) press('\x7f', 'backspace')
    await flush()

    // Esc 关闭：菜单消失（预留区被清）、输入保留（这里是 '/'）、未打断 agent（状态栏仍 Ready）
    press(undefined as any, 'escape', { meta: true, sequence: '\x1b' })
    await flush()
    expect(term.row(24)).toBe('') // 预留区清空
    expect(term.row(22)).toBe('')
    expect(term.row(STATUS_ROW)).toContain('● Ready')
    expect(term.row(STATUS_ROW)).not.toContain('Interrupted')
    expect(term.row(INPUT_FIRST)).toContain('/')

    // 收尾：清掉输入
    press('\x7f', 'backspace')
    await flush()
  })

  /**
   * AC-23（V-6 用户拍板 2026-09-17）：**真实编排 + 真实磁盘技能文件**。
   *
   * 与 `tui.e2e.test.ts` 的 AC-23 分工：那边注入候选源（验证菜单机制与坏文件跳过），
   * 这里不注入任何源 —— 技能写在隔离的 `AGENT_CLI_DIR/skills/` 下，由 `startInteractive`
   * 内部真实的 `createSkillCompletionSource()` 扫到。接线若断（忘注册 skills 源）这条必红。
   */
  it('AC-23（V-6）：磁盘上的技能出现在 `/` 候选中，可被选中并 Tab 填入', async () => {
    mkdirSync(join(tmp, 'skills', 'demo-skill'), { recursive: true })
    writeFileSync(
      join(tmp, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: 演示技能\n---\n正文\n',
    )
    await launch()
    press('/', undefined, { sequence: '/' })
    await flush()

    // B8 起 10 命令 + 1 技能 = 11 个候选 > 菜单视窗 8 → 直接开菜单看不到技能。
    // 过滤到技能（查询 '/demo' → 唯一候选）后再做布局断言：接线断了（技能没被扫到）这里必红。
    for (const ch of 'demo') press(ch, ch)
    await flush()
    expect(term.dump().join(' ')).toContain('/demo-skill')

    // 菜单打开时 11 个候选 → 固定高度 min(11,8)+1 = 9（V-5：生命周期内恒定，过滤只换内容不换行数）
    // → contentRows = 9、状态栏 10、预留区 16..24；过滤后候选行仍在 16、提示行仍在 24
    const reservedFrom = 16
    expect(term.row(reservedFrom)).toContain('▶ /demo-skill')
    expect(term.row(24)).toContain('Tab 填入')

    // Tab 只填入不提交
    press('\t', 'tab', { sequence: '\t' })
    await flush()
    expect(term.row(INPUT_FIRST)).toContain('/demo-skill')
    expect(h.createCalls).toHaveLength(0) // Tab 只填入：没有提交、没有打扰 agent

    // 收尾：清掉输入
    for (let i = 0; i < '/demo-skill'.length; i++) press('\x7f', 'backspace')
    await flush()
  })
})

/**
 * FR-2：后台任务在**真实编排**下的交互（AC-10 `/jobs` 二级菜单 + AC-13 退出收尾 + V-5 高度恒定）。
 *
 * 与 `tasks.test.ts` 的分工：那边验证 `TaskManager` 的进程组语义（真实 spawn + `ps` 复核），
 * 这里验证**接进 TUI/命令表之后**的端到端行为：`/jobs` 浮层能列出任务、能看输出、能终止，
 * 退出时真实 `TaskManager.killAll()` 被调用、清单被打印、`ps` 无孤儿（D-5 的 B4→B6 回归）。
 *
 * 起任务走**真实链路**：fake LLM 返回一个 `bash(run_in_background:true)` 工具调用 →
 * loop → executor → registry.bash.impl → TaskManager.start（不是直接调 TaskManager）。
 */
describe('入口编排：后台任务 /jobs 与退出收尾（FR-2 / AC-10 / AC-13 / V-5）', () => {
  /** 真实 ps 复核：带某标记的进程是否还在（AC-13 的"无孤儿"） */
  function hasProcess(marker: string): boolean {
    const out = execSync('ps -o command= -ax', { encoding: 'utf8' })
    return out.split('\n').some((l) => l.includes(marker))
  }

  /** 轮询直到条件成立（kill / 退出收尾都是异步的，`flush()` 的 4 个 tick 不够） */
  async function waitUntil(fn: () => boolean, timeoutMs = 8000, label = '条件'): Promise<void> {
    const start = Date.now()
    while (!fn()) {
      if (Date.now() - start > timeoutMs) throw new Error(`waitUntil 超时：${label}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  /** 屏幕**或**滚动历史里出现某文本（长内容会把行顶出可视区，只查 dump 会假红） */
  const screenHas = (text: string) => [...term.dump(), ...term.historyText()].some((l) => l.includes(text))

  /** `tmp/tasks/` 下的 task id（日志文件名 → id；id 由代码生成，不是测试编的） */
  function taskIds(): string[] {
    const dir = join(tmp, 'tasks')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => f.slice(0, -4))
  }

  /** 让 fake LLM 起一个后台任务并等它真的跑起来（真实链路：loop → executor → 权限审批 → bash → TaskManager） */
  async function startBackground(command: string, marker: string) {
    h.toolCall = { name: 'bash', args: JSON.stringify({ command, run_in_background: true }) }
    await submit('起个后台任务')
    // B7：default 模式下 bash 需审批 → 等浮层出现并批准（y）
    const start0 = Date.now()
    while (!term.dump().join(' ').includes('允许执行 bash')) {
      if (Date.now() - start0 > 5000) throw new Error('审批浮层未出现')
      await new Promise((r) => setTimeout(r, 20))
    }
    press('y', 'y')
    await flush()
    const start = Date.now()
    while (!hasProcess(marker)) {
      if (Date.now() - start > 5000) throw new Error(`后台进程未起来：${command}`)
      await new Promise((r) => setTimeout(r, 20))
    }
    await flush()
  }

  /** 收到的 DECSTBM（滚动区重设）次数 = 整区重建次数的计数器（V-5 的可观测点） */
  const rebuilds = () => (rawWrites.join('').match(/\x1b\[1;\d+r/g) ?? []).length

  it('AC-10：/jobs 列出任务 → 查看输出 → 终止任务（含 V-5 的"导航不重建"与"高度变化才重建"）', async () => {
    await launch()
    await startBackground('echo MARK-4721; sleep 4741', 'MARK-4721')
    await startBackground('echo MARK-4722; sleep 4742', 'MARK-4722')

    const ids = taskIds()
    expect(ids).toHaveLength(2)

    // === 打开列表浮层 ===
    // 2 项 → overlay 高度 = 标题 + 2 项 + 提示 = 4 → contentRows = 24-5-1-4 = 14
    // 状态栏 = contentRows+1 = 15；预留区（浮层）首行 = contentRows+2+5 = 21（标题行）
    await submit('/jobs')
    const listRows = 24 - 5 - 1 - 4
    const listFrom = listRows + 2 + 5
    expect(term.row(listRows + 1)).toContain('● Ready')
    expect(term.row(listFrom)).toContain('后台任务（2 运行中 / 共 2）')
    expect(term.row(listFrom + 1)).toContain(ids[0])
    expect(term.row(listFrom + 1)).toContain('▶') // 首项默认选中
    expect(term.row(listFrom + 2)).toContain(ids[1])
    expect(term.row(24)).toContain('↑/↓ 移动') // 提示行恒在最后一行（高度恒定的可观测点）
    const afterOpen = rebuilds()
    expect(afterOpen).toBeGreaterThan(0) // 打开浮层 = 一次整区重建（V-5 允许的两类之一）

    // === V-5：↑↓ 导航不得改变高度、不得重建 ===
    press(undefined as any, 'down', { sequence: '\x1b[B' })
    await flush()
    expect(rebuilds()).toBe(afterOpen) // 没有新的整区重建
    expect(term.row(listFrom + 2)).toContain('▶') // 选中项确实移动了（不是"没反应"的假绿）
    expect(term.row(listFrom + 1)).not.toContain('▶')
    expect(term.row(24)).toContain('↑/↓ 移动') // 浮层行数/位置未变
    press(undefined as any, 'up', { sequence: '\x1b[A' })
    await flush()
    expect(rebuilds()).toBe(afterOpen)
    expect(term.row(listFrom + 1)).toContain('▶')

    // === 二级菜单（Enter）→ 动作菜单高度 5（3 项）→ 关闭列表 + 打开动作 = 两次重建 ===
    // 这一步同时是 **V-5 断言敏感度的反证**：高度确实变化时，计数器必然增加。
    press('', 'return')
    await flush()
    const actionRows = 24 - 5 - 1 - 5 // 13
    const actionFrom = actionRows + 2 + 5 // 20（标题行）
    expect(term.row(actionFrom)).toContain(ids[0])
    expect(term.row(actionFrom + 1)).toContain('▶ 查看输出')
    expect(term.row(actionFrom + 2)).toContain('终止任务')
    expect(term.row(actionFrom + 3)).toContain('返回')
    expect(rebuilds()).toBe(afterOpen + 2)

    // === 查看输出 → 内容区打印 tail → 回到列表 ===
    press('', 'return')
    await flush()
    expect(term.contains('最近 20 行')).toBe(true)
    expect(term.contains('MARK-4721')).toBe(true) // 任务真实产出被打印出来（不是占位）

    // === 终止任务：列表首项（4721）→ 动作菜单 → ↓ 到"终止任务" → Enter ===
    press('', 'return') // 打开动作菜单
    await flush()
    press(undefined as any, 'down', { sequence: '\x1b[B' }) // 选中"终止任务"
    await flush()
    press('', 'return')
    await flush()
    // kill 是异步的（SIGTERM → 等退出 → 可能 SIGKILL），且提示在 kill 的 Promise 落地后才 addInfo
    // → 直接等**被断言的文本**出现（等 ps 会早于 addInfo，产生竞态）
    await waitUntil(() => screenHas('已终止任务'), 8000, '终止提示出现')
    expect(hasProcess('MARK-4721')).toBe(false) // 真杀（ps 复核，不看 UI 文案）

    // === Esc 关闭浮层 → 布局复原（预留区回到 3 行） ===
    press(undefined as any, 'escape', { meta: true, sequence: '\x1b' })
    await flush()
    expect(term.row(STATUS_ROW)).toContain('● Ready')
    expect(term.row(24)).toBe('')

    // === 清理第二个任务（同一条链路：列表里两条记录，存活的在第 2 位） ===
    await submit('/jobs')
    press(undefined as any, 'down', { sequence: '\x1b[B' }) // 选中 4722
    await flush()
    press('', 'return')
    await flush()
    press(undefined as any, 'down', { sequence: '\x1b[B' }) // 选中"终止任务"
    await flush()
    press('', 'return')
    await flush()
    await waitUntil(() => screenHas('已终止任务'), 8000, '终止提示出现')
    expect(hasProcess('MARK-4722')).toBe(false)
    press(undefined as any, 'escape', { meta: true, sequence: '\x1b' }) // 关列表
    await flush()
  }, 30000)

  it('AC-13/AC-16：/exit 时真实 TaskManager.killAll() 被调用 → 打印被终止清单 + ps 无孤儿', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any)
    await launch()
    await startBackground('echo MARK-4731; sleep 4731', 'MARK-4731')
    const id = taskIds()[0]
    expect(id).toBeTruthy()
    expect(hasProcess('MARK-4731')).toBe(true)

    await submit('/exit')
    // 退出收尾是异步的（killAll 要等进程退出）→ 等 bye 真的写出来
    await waitUntil(() => rawWrites.join('').includes('· 恢复：agent-cli -r'), 10000, '退出收尾完成')
    await flush()

    // 收尾顺序：真清屏 → 被终止清单 → bye（清单在清屏之后，否则等于没打印）
    const out = rawWrites.join('')
    const clear = out.lastIndexOf('\x1b[2J\x1b[3J')
    const afterClear = out.slice(clear + '\x1b[2J\x1b[3J'.length)
    expect(afterClear).toContain('已终止后台任务')
    expect(afterClear).toContain(id)
    expect(afterClear).toMatch(/bye · session session-\d+-\d+ · 恢复：agent-cli -r/)

    // AC-13：真实 ps 复核（不是看 UI 文案）
    expect(hasProcess('MARK-4731')).toBe(false)
    // AC-17：锁已释放
    expect(readdirSync(sessionWorkspaceDir()).filter((f) => f.endsWith('.lock'))).toEqual([])
    exitSpy.mockRestore()
  }, 30000)

  it('没有后台任务时 /jobs 给出明确提示（不弹空浮层）', async () => {
    await launch()
    await submit('/jobs')
    expect(term.contains('当前没有后台任务')).toBe(true)
  })
})

/**
 * V-8（用户拍板 2026-09-17）：单轮（非交互）模式**显式拒绝**后台任务。
 *
 * 走真实链路（`runTurn` + 真实 loop/executor/registry + 真实 `TaskManager` + 非交互 broker），
 * 与 `tools.test.ts` 的工具层用例互补：那边锁实现分支，这里证明"单轮装配下 LLM 收到的是
 * 结构化错误、且真的没有进程被起"。
 */
describe('入口编排：单轮（非交互）模式拒绝后台任务（V-8）', () => {
  it('bash(run_in_background) → 结构化错误「后台任务需要交互模式」，且不起进程', async () => {
    await launch()
    const broker = new InteractionBroker(null, { interactive: false, autoAccept: false })
    const mgr = new TaskManager({ cwd: process.cwd() })
    try {
      h.toolCall = { name: 'bash', args: JSON.stringify({ command: 'sleep 4751', run_in_background: true }) }
      const messages = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: '起个后台任务' },
      ] as unknown as Parameters<typeof runTurn>[0]

      // V-8 的门禁在 bash.impl 内（环境能力检查，不是权限规则）——B7 起 default 模式下 bash 会先被
      // 权限层拒绝、根本到不了这道门禁，故用 bypass 模式直达 impl（这正是"门禁只挡非交互"的语义）。
      await runTurn(messages, null, {
        model: 'text-model:8b',
        interaction: broker,
        tasks: mgr,
        permissions: new PermissionController('bypass'),
      })

      expect(mgr.size).toBe(0) // 没起进程 → 单轮退出时不会留孤儿
      const second = h.createCalls[1]
      expect(second).toBeTruthy()
      const toolMsg = second.messages.find((m: any) => m.role === 'tool')
      // 结构化错误回给 LLM，并给出可执行的下一步（改用前台）
      expect(toolMsg.content).toContain('后台任务需要交互模式')
      expect(toolMsg.content).toContain('前台')
    } finally {
      await mgr.killAll().catch(() => {})
    }
  })
})

/**
 * FR-6：权限模式命令与启动警告的端到端（AC-35 / AC-37）。
 *
 * `/mode` 与 `/permissions` 走真实命令表（AC-27：与 ask_user、/jobs 同一个 broker 分派路径）；
 * `--permission-mode bypass` 的启动警告必须在 `ui.enter()` 之后打印（否则落在主屏，AC-35）。
 */
describe('入口编排：权限模式命令与启动警告（FR-6 / AC-35 / AC-37）', () => {
  /** 轮询直到条件成立（addInfo / relayout 都是异步的） */
  async function waitFor(fn: () => boolean, timeoutMs = 5000, label = '条件'): Promise<void> {
    const start = Date.now()
    while (!fn()) {
      if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时：${label}`)
      await new Promise((r) => setTimeout(r, 15))
    }
  }

  it('--permission-mode bypass → 启动醒目警告（AC-35），且 bash 不再弹审批直接执行', async () => {
    await launch({ permissionMode: 'bypass' })
    // 警告出现在 TUI 内容区（enter() 之后写才可见；enter() 之前的输出会落主屏残影）
    await waitFor(() => term.dump().join(' ').includes('不再请求确认'), 5000, 'bypass 警告')
    // bypass 下 bash 免审批：无浮层、直接出 ✓ 行
    h.toolCall = { name: 'bash', args: JSON.stringify({ command: 'echo bypassed' }) }
    await submit('跑个命令')
    await waitFor(() => term.dump().some((l) => l.includes('✓ bash')), 5000, 'bash 执行完成')
    expect(term.dump().join(' ')).not.toContain('允许执行 bash') // 全程没有审批浮层
  })

  it('/permissions 显示当前模式（只读视图）；/mode 切换立即生效（AC-35/AC-37）', async () => {
    await launch()
    await submit('/permissions')
    expect(term.dump().join(' ')).toContain('当前权限模式：default')

    // /mode → select 浮层（4 项 → 高度 min(4,8)+2 = 6 → 预留区 19..24，提示行恒在 24）
    await submit('/mode')
    expect(term.row(19)).toContain('权限模式（当前：default）')
    const modes = ['default', 'acceptEdits', 'plan', 'bypass']
    modes.forEach((m, i) => expect(term.row(20 + i)).toContain(m))
    expect(term.row(20)).toContain('▶') // 首项默认选中（default）
    expect(term.row(24)).toContain('↑/↓ 移动')

    // ↓ 选中 acceptEdits → Enter → 切换提示；/permissions 复核
    press(undefined as any, 'down', { sequence: '\x1b[B' })
    await flush()
    expect(term.row(21)).toContain('▶') // 选中项移动（不是"没反应"的假绿）
    press('', 'return')
    await flush()
    await waitFor(() => term.dump().join(' ').includes('权限模式已切换为 acceptEdits'), 5000, '切换提示')
    await submit('/permissions')
    expect(term.dump().join(' ')).toContain('当前权限模式：acceptEdits')
  })

  it('/mode 切到 bypass 时打印醒目警告（AC-35 的运行时侧，与启动警告同一通道）', async () => {
    await launch()
    await submit('/mode')
    // ↓↓↓ 选中 bypass（第 4 项）→ Enter
    for (let i = 0; i < 3; i++) press(undefined as any, 'down', { sequence: '\x1b[B' })
    press('', 'return')
    await flush()
    await waitFor(() => term.dump().join(' ').includes('不再请求确认'), 5000, 'bypass 警告')
    expect(term.dump().join(' ')).toContain('权限模式已切换为 bypass')
  })
})

/**
 * FR-8：Hook 在**真实编排**下的端到端（AC-42 的 index 侧触发点）。
 *
 * 与 `hooks.test.ts` 的分工：那边验证 HookRunner 的协议/失败语义/信任判定（真实 spawn 冒烟），
 * 这里验证**挂进真实 startInteractive 之后的触发位置**：UserPromptSubmit 在用户消息处理时、
 * Pre/PostToolUse 在 executor 挂载点、Stop 在 runTurn 返回后 —— 全部走**真实 spawn**
 * （hook 命令 `cat > 文件` 把 stdin JSON 落盘成可机读产物；用户级 hooks.json 放隔离的
 * `AGENT_CLI_DIR` 下，无需信任确认，也不污染工作树）。
 *
 * 项目级信任确认（AC-46）与 V-5 浮层高度断言见下一个 describe；AC-43/44/45 在 hooks.test.ts。
 */
describe('入口编排：Hook 4 时机触发（FR-8 / AC-42，真实 spawn）', () => {
  async function waitUntil(fn: () => boolean, timeoutMs = 8000, label = '条件'): Promise<void> {
    const start = Date.now()
    while (!fn()) {
      if (Date.now() - start > timeoutMs) throw new Error(`waitUntil 超时：` + label)
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('4 个时机的 stdin 载荷字段正确（UserPromptSubmit / PreToolUse / PostToolUse / Stop）', async () => {
    const payloadDir = join(tmp, 'hook-payloads')
    mkdirSync(payloadDir)
    const capture = (event: string) => `cat > ${join(payloadDir, event + '.json')}`
    writeFileSync(
      join(tmp, 'hooks.json'),
      JSON.stringify({
        UserPromptSubmit: [{ command: capture('UserPromptSubmit') }],
        PreToolUse: [{ command: capture('PreToolUse') }],
        PostToolUse: [{ command: capture('PostToolUse') }],
        Stop: [{ command: capture('Stop') }],
      }),
    )

    await launch()
    // 走只读工具（default 模式免审批）：一次工具调用同时触发 Pre/PostToolUse
    h.toolCall = { name: 'read', args: JSON.stringify({ path: 'package.json' }) }
    await submit('你好 hook')

    await waitUntil(
      () =>
        ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].every((e) => {
          // ⚠️ 不能只等"文件存在"：`cat > f` 由 shell 重定向**先建空文件**、再写入内容，
          // 中间有 2~4ms 的空窗（实测，与 spawn 选项无关）→ 20ms 轮询有 ~15% 概率读到空文件。
          // 故等到"内容可解析"为止（断言强度不变，只去掉竞态；C-1 返工期间实测到该 flake）。
          const p = join(payloadDir, e + '.json')
          if (!existsSync(p)) return false
          try {
            return typeof JSON.parse(readFileSync(p, 'utf8')) === 'object'
          } catch {
            return false
          }
        }),
      8000,
      '4 个 hook 载荷落盘（且内容可解析）',
    )

    const ups = JSON.parse(readFileSync(join(payloadDir, 'UserPromptSubmit.json'), 'utf8'))
    expect(ups.event).toBe('UserPromptSubmit')
    expect(ups.cwd).toBe(process.cwd())
    expect(typeof ups.sessionId).toBe('string')
    expect(ups.sessionId.length).toBeGreaterThan(0)
    expect(ups.prompt).toBe('你好 hook')

    const pre = JSON.parse(readFileSync(join(payloadDir, 'PreToolUse.json'), 'utf8'))
    expect(pre.event).toBe('PreToolUse')
    expect(pre.tool).toBe('read')
    expect(pre.args).toEqual({ path: 'package.json' })
    expect(pre.cwd).toBe(process.cwd())

    const post = JSON.parse(readFileSync(join(payloadDir, 'PostToolUse.json'), 'utf8'))
    expect(post.event).toBe('PostToolUse')
    expect(post.tool).toBe('read')
    expect(typeof post.result).toBe('string')
    expect(post.result.length).toBeGreaterThan(0) // 已截断的工具结果文本
    expect(typeof post.durationMs).toBe('number')

    const stop = JSON.parse(readFileSync(join(payloadDir, 'Stop.json'), 'utf8'))
    expect(stop.event).toBe('Stop')
    expect(stop.cwd).toBe(process.cwd())
    expect(stop.sessionId).toBe(ups.sessionId) // 同一会话
  })

  it('未配置 hook 时零开销：无 hooks.json → 无 [hook] 输出、无浮层', async () => {
    await launch()
    h.toolCall = { name: 'read', args: JSON.stringify({ path: 'package.json' }) }
    await submit('普通消息')
    await waitUntil(() => h.createCalls.length >= 2, 8000, '本轮结束（LLM 第二次请求）')
    expect(term.dump().join(' ')).not.toContain('[hook]')
  })
})

describe('入口编排：/hooks 命令（FR-8 可观测性）', () => {
  it('无 hook → 明确提示两个配置位置', async () => {
    await launch()
    await submit('/hooks')
    expect(term.dump().join(' ')).toContain('当前没有加载任何 hook')
    expect(term.dump().join(' ')).toContain('.agent-cli/hooks.json')
  })

  it('用户级已加载 → 列出来源标记、事件与命令全文', async () => {
    writeFileSync(join(tmp, 'hooks.json'), JSON.stringify({ PreToolUse: [{ matcher: 'bash', command: 'echo audit' }] }))
    await launch()
    await submit('/hooks')
    const screen = term.dump().join(' ')
    expect(screen).toContain('已加载 1 条 hook')
    expect(screen).toContain('用户级')
    expect(screen).toContain('PreToolUse')
    expect(screen).toContain('(bash)')
    expect(screen).toContain('echo audit')
  })
})

/**
 * AC-46（index 侧）+ V-5：项目级 hooks 配置首次加载弹信任确认（走真实 broker 分派路径），
 * 浮层高度在生命周期内恒定（V-5）；拒绝则不加载。
 *
 * 项目级路径 = `<projectRoot>/.agent-cli/hooks.json`，而 projectRoot = 进程 cwd = 仓库根。
 * 这里**临时**写入该文件并在 finally/afterEach 双保险删除（B6b 先例：不在工作树留 `.agent-cli/`）。
 */
describe('入口编排：项目级 hook 信任确认（FR-8 / AC-46 / V-5）', () => {
  const repoHooksDir = join(process.cwd(), '.agent-cli')
  const repoHooksPath = join(repoHooksDir, 'hooks.json')
  let repoHooksWritten = false

  afterEach(() => {
    if (repoHooksWritten) {
      repoHooksWritten = false
      rmSync(repoHooksDir, { recursive: true, force: true })
    }
  })

  it('首次加载弹 confirm（来源路径 + 命令全文）；按无关键浮层不动（V-5）；拒绝 → 不加载', async () => {
    writeProjectHooksFixture()
    try {
      setModelsDeps({
        listModels: async () => listOutput(CAPS_BY_MODEL),
        showModel: async (model: string) => ({ capabilities: CAPS_BY_MODEL[model] ?? [] }),
      })
      // startInteractive 会 await 信任确认 → 不能整体 await，先让浮层出现
      const launched = startInteractive(SYSTEM, false)
      await flush()

      await waitScreenHas('.agent-cli/hooks.json', '信任确认浮层')
      const screen = term.dump().join(' ')
      expect(screen).toContain('信任项目级 hook 配置')
      expect(screen).toContain('echo project-hook-cmd')

      // V-5：浮层高度在生命周期内恒定 —— 按无关键（↑）后整屏逐行不变
      const before = term.dump()
      press(undefined as any, 'up', { sequence: '\x1b[A' })
      await flush()
      expect(term.dump()).toEqual(before)

      // 拒绝（n）→ 不加载项目配置，明确提示
      press('n', 'n')
      await flush()
      await launched
      await flush()
      await waitScreenHas('未获信任', '拒绝提示')
      // 信任记录未写入（本用例没切过模型，config.json 不存在）
      expect(existsSync(join(tmp, 'config.json'))).toBe(false)

      // /hooks 复核：项目配置确实没加载
      await submit('/hooks')
      expect(term.dump().join(' ')).toContain('当前没有加载任何 hook')
    } finally {
      rmSync(repoHooksDir, { recursive: true, force: true })
    }
  })

  it('批准 → 项目配置加载并写入信任记录（AC-46 正向路径）', async () => {
    writeProjectHooksFixture()
    try {
      setModelsDeps({
        listModels: async () => listOutput(CAPS_BY_MODEL),
        showModel: async (model: string) => ({ capabilities: CAPS_BY_MODEL[model] ?? [] }),
      })
      const launched = startInteractive(SYSTEM, false)
      await flush()
      await waitScreenHas('信任项目级 hook 配置', '信任确认浮层')
      press('y', 'y')
      await flush()
      await launched
      await flush()
      await waitScreenHas('已加载（/hooks 查看命令清单）', '加载提示')

      // 信任记录写入用户配置（trustedHooks[projectRoot]）
      const saved = JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf8'))
      expect(saved.trustedHooks[process.cwd()].hash).toBeTruthy()
      expect(typeof saved.trustedHooks[process.cwd()].trustedAt).toBe('string')

      // /hooks 显示项目级条目
      await submit('/hooks')
      const screen = term.dump().join(' ')
      expect(screen).toContain('项目级')
      expect(screen).toContain('echo project-hook-cmd')
    } finally {
      rmSync(repoHooksDir, { recursive: true, force: true })
    }
  })

  function writeProjectHooksFixture(): void {
    mkdirSync(repoHooksDir, { recursive: true })
    writeFileSync(repoHooksPath, JSON.stringify({ PreToolUse: [{ command: 'echo project-hook-cmd' }] }))
    repoHooksWritten = true
  }

  async function waitScreenHas(text: string, label: string): Promise<void> {
    const start = Date.now()
    while (!term.dump().join(' ').includes(text)) {
      if (Date.now() - start > 5000) throw new Error(`waitScreenHas 超时：` + label + '（' + text + '）')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
})

/**
 * 前缀稳定性（D23 硬约束 / task-plan B2 承诺的 R1 断言）：
 * 连续两轮请求的 system 消息与 tools 必须**逐字节一致**，且第二轮 messages
 * 只能是第一轮的**前缀追加**——这是 Ollama 前缀 KV 缓存（8.6s → ~0.2s）的命线。
 * 之前只在工具层断言过 definitions 恒定（tools.test.ts ⑥），从未在**真实编排的
 * 连续两轮请求**上锁过 system+tools 字节 —— 本用例补上这个缺口。
 */
describe('前缀稳定性（D23/R1）：连续两轮请求的 system+tools 字节一致', () => {
  /** 轮询直到条件成立 */
  async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
    const start = Date.now()
    for (;;) {
      const v = fn()
      if (v) return v as T
      if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时：条件未在预期时间内成立')
      await new Promise((r) => setTimeout(r, 15))
    }
  }

  it('两轮请求 system 逐字节一致、tools 逐字节一致，且第二轮 messages 是第一轮的前缀追加', async () => {
    await launch()
    await submit('第一轮提问')
    const first = await waitFor(() => h.createCalls[0])
    // ⚠️ messages 是跨轮共享的同一数组引用（append-only 本身就是前缀缓存的机制），
    // 必须在第二轮发出**之前**把第一轮的 system/tools/messages 快照成字节串。
    const firstLen = first.messages.length
    const firstSystem = JSON.stringify(first.messages[0])
    const firstTools = JSON.stringify(first.tools)
    const firstAll = JSON.stringify(first.messages)
    expect(first.messages[0].role).toBe('system')

    // 等第一轮彻底结束（回到 Ready）再发第二轮，避免与运行态竞态
    await waitFor(() => term.row(STATUS_ROW).includes('Ready'))
    await submit('第二轮提问')
    const second = await waitFor(() => h.createCalls[1])

    // ① system 消息逐字节一致（messages[0] 就是 system）
    expect(second.messages[0].role).toBe('system')
    expect(JSON.stringify(second.messages[0])).toBe(firstSystem)

    // ② tools（definitions）逐字节一致
    expect(JSON.stringify(second.tools)).toBe(firstTools)

    // ③ 前缀追加：第二轮 messages 的前 firstLen 条与第一轮快照逐字节一致，且长度只增
    expect(second.messages.length).toBeGreaterThan(firstLen)
    expect(JSON.stringify(second.messages.slice(0, firstLen))).toBe(firstAll)
  })
})
