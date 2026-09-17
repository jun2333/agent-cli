/**
 * index.singleturn-permission.e2e.test.ts — 单轮（非交互）模式的权限语义（FR-6 / D-3 / V-1）
 *
 * 覆盖 `main()` 单轮分支的端到端行为（真实 main → runTurn → executor → 权限 → 非交互 broker）：
 * - **D-3（用户拍板 2026-09-17，破坏性变更）**：单轮不指定权限模式 → 落 `default` →
 *   `write` 被自动拒绝，进程以**退出码 2** 结束（AC-28 的"单轮分支 deniedCount>0 → exit(2)"）；
 * - `--yes` 覆盖非 forced 审批 → `write` 真正执行、文件落盘、退出码 0（AC-29 的单轮侧）；
 * - **V-1（安全优先）**：`--yes` **不覆盖**危险命令的强制审批 → `sudo …` 仍被自动拒绝
 *   （退出码 2），LLM 收到「需显式使用 bypass」的结构化原因 —— `--yes` ≠ `bypass`。
 *
 * 为什么要独立文件：本文件要求「import `index.js` 时 `argv` 命中单轮分支」，与
 * `index.e2e.test.ts`（argv=`--version`）和 `index.noninteractive.e2e.test.ts`（import 一次共享）
 * 的前置条件互斥；这里每个用例 `vi.resetModules()` 后重新 import，跑一次真实的 `main()`。
 * models 依赖在每次 reset 后重新注入，避免"重新实例化、依赖未注入"的跨用例污染。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** 被 mock 的 OpenAI client 记录的请求与下发的工具调用（每用例重置） */
const h = vi.hoisted(() => ({
  createCalls: [] as any[],
  /** 下一次请求返回的工具调用（只消费一次）；null = 空流 */
  toolCall: null as { name: string; args: string } | null,
}))

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = {
      completions: {
        create: async (params: any) => {
          h.createCalls.push(params)
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

let tmp: string
let origAgentDir: string | undefined
let origArgv: string[]
let origIsTTY: boolean | undefined
let origWrite: typeof process.stdout.write
let origStderrWrite: typeof process.stderr.write
let origExit: typeof process.exit

/** 单轮的目标文件（write 工具落盘到 projectRoot = 仓库根；用例结束删除） */
const targetFile = () => join(process.cwd(), `b7-singleturn-e2e-${process.pid}.txt`)

/** 每个用例独立的单轮运行：设置 argv/环境 → resetModules → import 即执行 main() → 等退出 */
async function runSingleTurn(cliArgs: string[]) {
  // 重置模块注册表：每个用例都拿到全新的 index.js（import 即执行一次真实的 main()）。
  // mock（vi.mock 的 openai）在 reset 后依然生效；models 依赖在其后重新注入。
  vi.resetModules()
  h.createCalls.length = 0 // toolCall 由用例在调用前设置，这里不能清
  tmp = mkdtempSync(join(tmpdir(), 'agent-cli-st-perm-'))
  process.env.AGENT_CLI_DIR = tmp
  process.argv = ['node', join(process.cwd(), 'src/index.ts'), ...cliArgs]
  ;(process.stdin as any).isTTY = false
  // 静音 stdout/stderr（单轮的提示/错误走这两个通道；断言只关心退出码、落盘与工具消息）
  ;(process.stdout as any).write = () => true
  ;(process.stderr as any).write = () => true

  const exitCalls: number[] = []
  ;(process as any).exit = (code?: number) => {
    exitCalls.push(code ?? 0)
    return undefined as never
  }

  // 能力探测注入假实现（runTurn → getCapabilities；别真连 Ollama）
  const models = await import('./models.js')
  models.setModelsDeps({ listModels: async () => '', showModel: async () => ({ capabilities: [] }) })

  await import('./index.js')
  for (let i = 0; i < 1000 && exitCalls.length === 0; i++) await new Promise((r) => setImmediate(r))
  return exitCalls
}

afterEach(() => {
  ;(process as any).exit = origExit
  ;(process.stdout as any).write = origWrite
  ;(process.stderr as any).write = origStderrWrite
  ;(process.stdin as any).isTTY = origIsTTY
  process.argv = origArgv
  if (origAgentDir === undefined) delete process.env.AGENT_CLI_DIR
  else process.env.AGENT_CLI_DIR = origAgentDir
  if (existsSync(targetFile())) unlinkSync(targetFile())
  rmSync(tmp, { recursive: true, force: true })
})

describe('单轮模式权限语义（D-3 / V-1 / AC-28 退出码）', () => {
  // 原始值在文件加载时记录（先于任何用例改动），afterEach 恢复
  origAgentDir = process.env.AGENT_CLI_DIR
  origArgv = process.argv
  origIsTTY = process.stdin.isTTY
  origWrite = process.stdout.write
  origStderrWrite = process.stderr.write
  origExit = process.exit

  it('D-3：不指定模式 → write 被自动拒绝、文件不落盘、退出码 2（破坏性行为变更的证据）', async () => {
    h.toolCall = { name: 'write', args: JSON.stringify({ path: `b7-singleturn-e2e-${process.pid}.txt`, content: 'x' }) }
    const exitCalls = await runSingleTurn(['做个操作'])

    expect(exitCalls).toEqual([2]) // deniedCount>0 → exit(2)（AC-28）
    expect(existsSync(targetFile())).toBe(false) // 未执行
    // 第二轮请求里能看到结构化拒绝原因（LLM 可据此换策略，AC-32 同源）
    const toolMsg = h.createCalls[1].messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('需交互但当前非交互')
  })

  it('D-3：--yes 覆盖普通审批 → write 真正执行、文件落盘、退出码 0（AC-29 的单轮侧）', async () => {
    h.toolCall = { name: 'write', args: JSON.stringify({ path: `b7-singleturn-e2e-${process.pid}.txt`, content: 'hello-b7' }) }
    const exitCalls = await runSingleTurn(['--yes', '做个操作'])

    expect(exitCalls).toEqual([0])
    expect(existsSync(targetFile())).toBe(true) // 真的写了
    const toolMsg = h.createCalls[1].messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('"ok":true')
  })

  it('V-1：--yes 不覆盖危险命令的强制审批 → sudo 被拒、退出码 2、提示需显式 bypass（--yes ≠ bypass）', async () => {
    // 用 `sudo echo`（命中 ^sudo\b 强制审批规则）：若拒绝语义被破坏，最坏也只是多跑一条无害命令
    h.toolCall = { name: 'bash', args: JSON.stringify({ command: 'sudo echo should-not-run' }) }
    const exitCalls = await runSingleTurn(['--yes', '做个操作'])

    expect(exitCalls).toEqual([2]) // forced 拒绝也计入 deniedCount → exit(2)
    const toolMsg = h.createCalls[1].messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('强制审批')
    expect(toolMsg.content).toContain('bypass')
  })
})
