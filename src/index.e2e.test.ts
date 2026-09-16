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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TermSim } from './testing/term-sim.js'
import { config } from './config.js'
import { setModelsDeps, resetModelsDeps } from './models.js'
import { setClipboardDeps, resetClipboardDeps } from './clipboard.js'
import { listSessions } from './session.js'

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
let stdin: EventEmitter & Record<string, any>
let tmp: string
let origAgentDir: string | undefined
let origArgv: string[]
let startInteractive: (systemPrompt: string, resumeFlag: boolean) => Promise<void>
/** 非交互单轮（`ui === null`）的轮次实现，用于覆盖 stderr 输出通道（N-8①） */
let runTurn: typeof import('./index.js')['runTurn']
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
async function launch(opts: { models?: Record<string, string[]> | null } = {}) {
  const models = opts.models === undefined ? CAPS_BY_MODEL : opts.models
  setModelsDeps({
    listModels: async () => (models ? listOutput(models) : ''),
    showModel: async (model: string) => ({ capabilities: models?.[model] ?? [] }),
  })
  await startInteractive(SYSTEM, false)
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
  Object.defineProperty(process.stdout, 'columns', { value: term.cols, configurable: true })
  Object.defineProperty(process.stdout, 'rows', { value: term.rows, configurable: true })
  ;(process.stdout as any).write = (s: string) => {
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
  ;({ startInteractive, runTurn } = await import('./index.js'))
})

afterEach(() => {
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
