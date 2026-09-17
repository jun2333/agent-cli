/**
 * index.noninteractive.e2e.test.ts — 单轮模式（非 TTY）的退出行为（AC-18）
 *
 * 覆盖：真实 `main()` 的**单轮分支**（`argv` 直接给问题、`stdin` 非 TTY）下，
 * 不得出现任何 spinner/动画字节、不得写 alt screen、不得清屏、不得打印 bye、
 * 不得注册 SIGINT/SIGTERM handler、不得引入交互等待。
 *
 * 为什么要独立文件：本文件要求「import `index.js` 时 `argv` 命中单轮分支」，
 * 而 `index.e2e.test.ts` 的整套夹具建立在「import 时 argv 命中 `--version`、主流程不启动」之上，
 * 两者的模块加载前置条件互斥。放同一个文件需 `vi.resetModules()` 重导模块，会让后续用例拿到
 * 「重新实例化、依赖未注入」的 `models.ts`（跨用例污染）——故拆成独立文件，各自前置条件互不干扰。
 *
 * AC-18 的背景（实测）：曾在终端输出里观察到孤立的 Braille 帧 `⠙`。本次排查确认它来自
 * **`npx` 自身的进度 spinner**（`⠙` = U+2819，紧跟 `\x1b[1G\x1b[0K` 擦除序列，见 changes.md 的探针），
 * 与 B1 的 `Ticker` 无关。本文件用断言把「单轮路径不产生任何动画字节」变成不可回归的事实。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const h = vi.hoisted(() => ({ createCalls: [] as any[] }))

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = {
      completions: {
        // 空流（无 token、无工具调用）→ 单轮跑完；这是最干净的非交互形态：
        // 除 loop 的"无产出"提示（走 stderr）外，stdout 不应有任何字节。
        create: async (params: any) => {
          h.createCalls.push(params)
          return (async function* () {})()
        },
      },
    }
  }
  return { default: FakeOpenAI }
})

let tmp: string
/** 单轮期间 stdout 收到的全部原始写入串 */
let stdoutChunks: string[]
/** 单轮分支的进程退出码记录（替换 process.exit，避免真杀 vitest） */
let exitCalls: number[]
/** 信号监听器基线（import index.js **之前**记录 → 与之后比较，AC-18 的"不注册 handler"） */
const sigBaseline = { SIGINT: 0, SIGTERM: 0 }
let origArgv: string[]
let origAgentDir: string | undefined
let origIsTTY: boolean | undefined
let origWrite: typeof process.stdout.write
let origStderrWrite: typeof process.stderr.write
let origExit: typeof process.exit

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-cli-noninteractive-e2e-'))
  origAgentDir = process.env.AGENT_CLI_DIR
  process.env.AGENT_CLI_DIR = tmp // 隔离 ~/.agent-cli（buildSystemPrompt → ensureAgentCliDir）
  origArgv = process.argv
  // 非 TTY + 直接给问题 → main() 走单轮分支
  process.argv = ['node', join(process.cwd(), 'src/index.ts'), '你好']
  origIsTTY = process.stdin.isTTY
  ;(process.stdin as any).isTTY = false

  stdoutChunks = []
  origWrite = process.stdout.write
  ;(process.stdout as any).write = (s: string) => {
    stdoutChunks.push(s)
    return true
  }
  // loop 的"无产出"提示走 stderr：这里静音，避免污染测试输出（断言只关心 stdout）
  origStderrWrite = process.stderr.write
  ;(process.stderr as any).write = () => true
  exitCalls = []
  origExit = process.exit
  ;(process as any).exit = (code?: number) => {
    exitCalls.push(code ?? 0)
    return undefined as never
  }

  // 能力探测注入假实现：单轮会经 runTurn → getCapabilities，别真连 Ollama（失败要等 5s 超时）。
  // ⚠️ 必须在 import index.js **之前**设置，且用的是同一个 models 模块实例（同一加载顺序）。
  const models = await import('./models.js')
  models.setModelsDeps({ listModels: async () => '', showModel: async () => ({ capabilities: [] }) })

  sigBaseline.SIGINT = process.listenerCount('SIGINT')
  sigBaseline.SIGTERM = process.listenerCount('SIGTERM')

  // import 即执行 main()（argv 已是单轮问题）
  await import('./index.js')
  // 等单轮真正跑完（真实链路：getCapabilities → loop → FakeOpenAI → .then(exit)）
  for (let i = 0; i < 500 && exitCalls.length === 0; i++) await new Promise((r) => setImmediate(r))
})

afterAll(() => {
  ;(process.stdout as any).write = origWrite
  ;(process.stderr as any).write = origStderrWrite
  ;(process as any).exit = origExit
  ;(process.stdin as any).isTTY = origIsTTY
  process.argv = origArgv
  if (origAgentDir === undefined) delete process.env.AGENT_CLI_DIR
  else process.env.AGENT_CLI_DIR = origAgentDir
  rmSync(tmp, { recursive: true, force: true })
})

describe('单轮模式（非 TTY）退出行为（AC-18）', () => {
  it('单轮跑完即退出：stdout 无任何 spinner/动画字节、不写 alt screen、不清屏、不打印 bye', () => {
    const out = stdoutChunks.join('')

    // 单轮确实执行了（有请求），且跑完立刻以 0 退出（未被交互等待挂住 → "不引入交互等待"）
    expect(h.createCalls).toHaveLength(1)
    expect(exitCalls).toEqual([0])

    // 不进入/退出 alt screen，不清屏，不清滚动历史
    expect(out).not.toContain('\x1b[?1049h')
    expect(out).not.toContain('\x1b[?1049l')
    expect(out).not.toContain('\x1b[2J')
    expect(out).not.toContain('\x1b[3J')
    // 不打印告别语（bye 只在交互模式的收尾路径产生）
    expect(out).not.toContain('bye')
    // 任何 Braille 帧（U+2800–U+28FF）：B1 的 Ticker 是它们的唯一来源，单轮不构造 TUI
    expect(/[\u2800-\u28FF]/.test(out)).toBe(false)
    // 更强的一条：无 UI 时 stdout 是交给脚本消费的回答流，空回答 = 零输出
    expect(out).toBe('')
  })

  it('单轮模式不注册 SIGINT/SIGTERM handler（信号只在 startInteractive 内部注册）', () => {
    expect(process.listenerCount('SIGINT')).toBe(sigBaseline.SIGINT)
    expect(process.listenerCount('SIGTERM')).toBe(sigBaseline.SIGTERM)
  })
})
