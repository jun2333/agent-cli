/**
 * index.exit-signal.e2e.test.ts — **真实信号**下的统一退出（AC-16，lesson 011）
 *
 * 为什么必须独立跑子进程拿真实信号：
 * - 在 vitest 进程内 `process.emit('SIGINT')` 会连 vitest 自己注册的信号处理器一起触发（可能中断测试运行）；
 * - 在 vitest 进程内真发 `kill -INT` / `kill -TERM` 等于把测试进程本身杀掉。
 * 因此用一个**真实子进程**（`node --import tsx src/index.ts`；stdin 用管道且保持打开 → 交互模式但不需要
 * PTY，`primeCapabilities` 指向关闭端口 → 秒级失败）承接真实信号，断言：进程以 **0** 退出（说明走的是
 * 我们注册的 handler 而非被信号直接杀死）、终端**真清屏**（`?1049l` 之后 `2J`+`3J`）、清屏后**只剩一行 bye**。
 *
 * ⚠️ 不能 spawn `node_modules/.bin/tsx`：它是 `#!/bin/sh` 包装脚本，信号杀掉的是 shell 而不是我们的进程
 * （实测：`exit 0` 但既无 `?1049l` 也无 bye，handler 从未执行）。必须 `node --import tsx` 直接跑。
 *
 * `createShutdown` 的**调用顺序**断言（cancelAll→releaseLock→killAll→ui.exit→bye→exit）在
 * `index.e2e.test.ts` 用注入式假 deps 覆盖——子进程只能观测"外部可见的收尾结果"，两者互补。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const READY_TIMEOUT_MS = 20000
const EXIT_TIMEOUT_MS = 10000

let child: ChildProcess | null = null
let tmpDir: string | null = null

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await new Promise((r) => child!.once('exit', r))
  }
  child = null
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

/** 轮询等 stdout 累积内容里出现 needle（避免固定 sleep 的脆弱性） */
async function waitForStdout(buf: { text: string }, needle: string): Promise<void> {
  const start = Date.now()
  while (!buf.text.includes(needle)) {
    if (Date.now() - start > READY_TIMEOUT_MS) {
      throw new Error(`超时：stdout 未出现 ${JSON.stringify(needle)}（已收 ${buf.text.length} 字节）`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * 起一个真实子进程 → 等它进入 TUI（alt screen）→ 发信号 → 断言收尾结果。
 * 注意：`createShutdown({ signals: true })` 在 `startInteractive` 里、`ui.enter()` **之前**执行，
 * 因此"看到 `?1049h`"就保证信号 handler 已注册。
 */
async function runSignalExit(signal: NodeJS.Signals) {
  tmpDir = mkdtempSync(join(tmpdir(), 'agent-cli-signal-e2e-'))
  const buf = { text: '' }
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_CLI_DIR: tmpDir, OLLAMA_BASE_URL: 'http://127.0.0.1:1' },
    // stdin 用管道且**保持打开**（不 end）：进程靠 stdin 保活，才能等到信号
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  child = proc
  proc.stdout!.setEncoding('utf8')
  proc.stdout!.on('data', (d: string) => {
    buf.text += d
  })

  await waitForStdout(buf, '\x1b[?1049h')

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.once('exit', (code, sig) => resolve({ code, signal: sig }))
  })
  proc.kill(signal)
  const result = await Promise.race([
    exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${signal} 后未在 ${EXIT_TIMEOUT_MS}ms 内退出`)), EXIT_TIMEOUT_MS)),
  ])

  const out = buf.text
  const altExit = out.lastIndexOf('\x1b[?1049l')
  const clear = out.lastIndexOf('\x1b[2J\x1b[3J')
  // 清屏（2J+3J）之后剥掉 ANSI，应恰好剩一行 bye
  const tail = clear >= 0 ? out.slice(clear + '\x1b[2J\x1b[3J'.length).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') : ''
  const lines = tail
    .split('\n')
    .filter((l) => l.trim())

  return { result, out, altExit, clear, lines }
}

describe('真实信号下的统一退出（AC-16，lesson 011）', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`${signal} → 走注册的 handler：退出码 0、真清屏、清屏后只剩一行含 session id 与 -r 的 bye`, async () => {
      const { result, altExit, clear, lines } = await runSignalExit(signal)

      // 走 handler → `exit(0)`。若 handler 未注册，进程会被信号直接杀死：
      // code=null 且 signal='SIGTERM'/'SIGINT'（断言即失败）。
      expect({ code: result.code, signal: result.signal }).toEqual({ code: 0, signal: null })

      // 终止时序：先退出 alt screen（?1049l），再真清屏（2J+3J）——顺序不可换
      expect(altExit).toBeGreaterThanOrEqual(0)
      expect(clear).toBeGreaterThan(altExit)

      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/^bye · session session-\d+-\d+ · 恢复：agent-cli -r$/)
    }, 40000)
  }
})
