/**
 * hooks.test.ts — FR-8 Hook（AC-42~47）
 *
 * 验证策略（D-8 / lesson 011：注入式 mock 会掩盖集成缺陷）：
 * - **协议与失败语义全部用真实 spawn 冒烟**：真 hook 脚本、真 stdin/stdout JSON 往返、
 *   真非 0 退出、真超时（timeoutMs 注入调小，不让测试跑 10s），断言落在可机读产物
 *   （进程写出的 JSON 文件、HookOutcome 字段）。
 * - **信任流程走真实 `InteractionBroker`**（假 host 注入），spy 断言 `request` 被命中
 *   —— 这是 AC-27「Hook 信任与权限审批//jobs/ask_user 同一分派路径」的证据之一。
 * - 端到端触发点（index 侧编排）见 `src/index.e2e.test.ts` 的 Hook describe（真 spawn 经真实编排）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execSync, spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  HookRunner,
  hooksConfigHash,
  isProjectHooksTrusted,
  parseHookConfig,
  resolveProjectHooksPath,
  setupHooks,
  type HookConfig,
  type HookPayload,
} from './hooks.js'
import { InteractionBroker, type InteractionHost, type InteractionResult, type InteractionSpec } from './interaction.js'
import { createToolExecutor } from './tools/executor.js'
import type { ToolSpec } from './tools/registry.js'

let tmp: string
let origAgentDir: string | undefined

/** 项目根（临时目录，模拟"从某个仓库启动"） */
let projectRoot: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-cli-hooks-'))
  origAgentDir = process.env.AGENT_CLI_DIR
  process.env.AGENT_CLI_DIR = tmp
  projectRoot = join(tmp, 'project')
  mkdirSync(projectRoot, { recursive: true })
})

afterEach(() => {
  if (origAgentDir === undefined) delete process.env.AGENT_CLI_DIR
  else process.env.AGENT_CLI_DIR = origAgentDir
  rmSync(tmp, { recursive: true, force: true })
})

/** 造一条把 stdin 原样落盘的 hook 命令（真实 spawn 的可机读产物） */
const captureStdin = (name: string) => `cat > ${join(tmp, `${name}.json`)}`


/** 写项目级 hooks.json（先建 .agent-cli/ 目录；content 原样写入） */
function writeProjectHooks(content: string): void {
  mkdirSync(join(projectRoot, '.agent-cli'), { recursive: true })
  writeFileSync(join(projectRoot, '.agent-cli/hooks.json'), content)
}

const runnerOf = (config: HookConfig, defaultTimeoutMs = 10_000) => {
  const runner = new HookRunner({ cwd: projectRoot, defaultTimeoutMs })
  runner.configure(config, 'user')
  return runner
}

const payload = (over: Partial<HookPayload> = {}): HookPayload => ({
  event: 'PreToolUse',
  cwd: projectRoot,
  tool: 'bash',
  args: { command: 'echo hi' },
  ...over,
})

// === AC-42：4 时机触发 + stdin 收到约定 JSON 字段（真实 spawn 冒烟） ===

describe('HookRunner：AC-42 时机与 stdin JSON 协议（真实 spawn）', () => {
  it.each(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'] as const)(
    '%s：stdin 收到约定的 JSON 字段（真实进程写出）',
    async (event) => {
      const runner = runnerOf({ [event]: [{ command: captureStdin(event) }] })
      const p: HookPayload = {
        event,
        cwd: projectRoot,
        sessionId: 's-123',
        ...(event === 'PreToolUse' || event === 'PostToolUse' ? { tool: 'bash', args: { command: 'echo hi' } } : {}),
        ...(event === 'PostToolUse' ? { result: '工具输出文本', durationMs: 42 } : {}),
        ...(event === 'UserPromptSubmit' ? { prompt: '帮我跑个命令' } : {}),
      }
      const outcome = await runner.run(event, p)

      expect(outcome.blocked).toBe(false)
      expect(existsSync(join(tmp, `${event}.json`))).toBe(true)
      const got = JSON.parse(readFileSync(join(tmp, `${event}.json`), 'utf8'))
      expect(got.event).toBe(event)
      expect(got.cwd).toBe(projectRoot)
      expect(got.sessionId).toBe('s-123')
      if (event === 'PreToolUse' || event === 'PostToolUse') {
        expect(got.tool).toBe('bash')
        expect(got.args).toEqual({ command: 'echo hi' })
      }
      if (event === 'PostToolUse') {
        expect(got.result).toBe('工具输出文本')
        expect(got.durationMs).toBe(42)
      }
      if (event === 'UserPromptSubmit') {
        expect(got.prompt).toBe('帮我跑个命令')
      }
    },
  )

  it('无配置（isEmpty）时 run 立即返回且不 spawn', async () => {
    const runner = new HookRunner({ cwd: projectRoot, defaultTimeoutMs: 10_000 })
    expect(runner.isEmpty).toBe(true)
    const started = Date.now()
    const outcome = await runner.run('PreToolUse', payload())
    expect(outcome).toEqual({ blocked: false })
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('matcher 过滤：仅 Pre/PostToolUse 生效；不匹配的工具不触发（无落盘产物）', async () => {
    const runner = runnerOf({ PreToolUse: [{ matcher: 'bash', command: captureStdin('matched') }] })
    await runner.run('PreToolUse', payload({ tool: 'read', args: { path: 'x' } }))
    expect(existsSync(join(tmp, 'matched.json'))).toBe(false)

    await runner.run('PreToolUse', payload({ tool: 'bash' }))
    expect(existsSync(join(tmp, 'matched.json'))).toBe(true)

    // UserPromptSubmit 忽略 matcher
    const r2 = runnerOf({ UserPromptSubmit: [{ matcher: 'bash', command: captureStdin('ups') }] })
    await r2.run('UserPromptSubmit', payload({ event: 'UserPromptSubmit', tool: undefined, prompt: 'x' }))
    expect(existsSync(join(tmp, 'ups.json'))).toBe(true)
  })

  it('多条 hook 顺序执行；PreToolUse 首个阻塞后后续不再执行', async () => {
    const runner = runnerOf({
      PreToolUse: [
        { command: `echo '{"decision":"block","reason":"第一条拦下"}'` },
        { command: captureStdin('should-not-run') },
      ],
    })
    const outcome = await runner.run('PreToolUse', payload())
    expect(outcome.blocked).toBe(true)
    expect(outcome.reason).toBe('第一条拦下')
    expect(existsSync(join(tmp, 'should-not-run.json'))).toBe(false)
  })

  it('stdout 决策协议：exit 0 + {decision:"block",reason} → PreToolUse 阻塞（退出码优先）', async () => {
    const runner = runnerOf({ PreToolUse: [{ command: `echo '{"decision":"block","reason":"不许跑"}'` }] })
    const outcome = await runner.run('PreToolUse', payload())
    expect(outcome.blocked).toBe(true)
    expect(outcome.reason).toBe('不许跑')
  })

  it('stdout 非 JSON / 无 decision 字段 → 不影响结果（放行）', async () => {
    const runner = runnerOf({ PreToolUse: [{ command: `echo 'plain text'` }] })
    const outcome = await runner.run('PreToolUse', payload())
    expect(outcome).toEqual({ blocked: false })
  })
})

// === AC-43：PreToolUse 非 0 → 阻塞，stderr 作为原因 ===

describe('HookRunner：AC-43 PreToolUse 阻塞（真实非 0 退出）', () => {
  it('exit 3 + stderr → blocked，reason = stderr', async () => {
    const runner = runnerOf({ PreToolUse: [{ command: `echo pre-hook-stderr >&2; exit 3` }] })
    const outcome = await runner.run('PreToolUse', payload())
    expect(outcome.blocked).toBe(true)
    expect(outcome.reason).toBe('pre-hook-stderr')
  })

  it('经 executor 集成：阻塞后 impl 不执行，stderr 作为工具结果回给 LLM（AC-43 端到端）', async () => {
    const runner = runnerOf({ PreToolUse: [{ command: `echo 审计不通过 >&2; exit 1` }] })
    const impl = vi.fn(async () => ({ content: '{"ran":true}' }))
    const spec: ToolSpec = {
      meta: {
        name: 'guarded',
        description: '受 hook 保护的工具',
        parameters: { type: 'object', properties: {} },
        mutating: false,
        requiresApproval: false,
        backgroundable: false,
        source: 'builtin',
      },
      impl: impl as ToolSpec['impl'],
    }
    const exec = createToolExecutor(
      {
        currentModel: 'test-model',
        preToolUse: (name, args) => runner.run('PreToolUse', { event: 'PreToolUse', cwd: projectRoot, tool: name, args }),
      },
      [spec],
    )
    const r = await exec.implementations.guarded({})
    expect(impl).not.toHaveBeenCalled()
    expect(r.content).toContain('Hook 已阻止')
    expect(r.content).toContain('审计不通过')
  })
})

// === AC-44：PostToolUse / Stop 非 0 → 放行 + 告警 ===

describe('HookRunner：AC-44 非 0 放行 + 告警（真实非 0 退出）', () => {
  it.each(['PostToolUse', 'Stop'] as const)('%s：exit 4 → blocked=false，warning 含 stderr 首行', async (event) => {
    const runner = runnerOf({ [event]: [{ command: `echo ${event}-stderr-line >&2; exit 4` }] })
    const outcome = await runner.run(event, payload({ event }))
    expect(outcome.blocked).toBe(false)
    expect(outcome.warning).toContain(event)
    expect(outcome.warning).toContain(`${event}-stderr-line`)
  })

  it('PostToolUse 告警经 executor 的 onHookWarning 上报，工具结果不受影响（AC-44 端到端）', async () => {
    const runner = runnerOf({ PostToolUse: [{ command: `echo post-fail >&2; exit 1` }] })
    const warnings: string[] = []
    const exec = createToolExecutor(
      {
        currentModel: 'test-model',
        postToolUse: (name, args, result, durationMs) =>
          runner.run('PostToolUse', {
            event: 'PostToolUse',
            cwd: projectRoot,
            tool: name,
            args,
            result: String(result.content),
            durationMs,
          }),
        onHookWarning: (m) => warnings.push(m),
      },
      [
        {
          meta: {
            name: 'demo',
            description: 'd',
            parameters: { type: 'object', properties: {} },
            mutating: false,
            requiresApproval: false,
            backgroundable: false,
            source: 'builtin',
          },
          impl: async () => ({ content: '{"ran":true}' }),
        },
      ],
    )
    const r = await exec.implementations.demo({})
    expect(r.content).toBe('{"ran":true}') // 工具与轮次正常完成
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('post-fail')
  })
})

// === AC-45：超时按失败处理（timeoutMs 注入调小，真实超时冒烟） ===

describe('HookRunner：AC-45 超时（真实 SIGKILL 冒烟）', () => {
  it('PreToolUse：sleep 超过 timeoutMs → blocked，reason = hook 超时，且在远小于默认 10s 内返回', async () => {
    const runner = runnerOf({ PreToolUse: [{ command: `sleep 5`, timeoutMs: 100 }] }, 10_000)
    const started = Date.now()
    const outcome = await runner.run('PreToolUse', payload())
    const elapsed = Date.now() - started
    expect(outcome.blocked).toBe(true)
    expect(outcome.reason).toBe('hook 超时')
    expect(elapsed).toBeLessThan(2000) // 真超时（100ms）而非走默认 10s
  })

  it('PostToolUse：超时 → 放行 + 告警', async () => {
    const runner = runnerOf({ PostToolUse: [{ command: `sleep 5` }] }, 80)
    const outcome = await runner.run('PostToolUse', payload({ event: 'PostToolUse' }))
    expect(outcome.blocked).toBe(false)
    expect(outcome.warning).toContain('超时')
  })

  it('killRunning：在跑的 hook 被终止，run 快速结算（R9 退出收尾的真实冒烟）', async () => {
    const runner = runnerOf({ Stop: [{ command: `sleep 30` }] }, 60_000)
    const pending = runner.run('Stop', payload({ event: 'Stop' }))
    await new Promise((r) => setTimeout(r, 150)) // 让子进程真正起来
    const started = Date.now()
    runner.killRunning()
    const outcome = await pending
    expect(Date.now() - started).toBeLessThan(2000)
    expect(outcome.blocked).toBe(false) // Stop 失败语义：放行 + 告警
    expect(outcome.warning).toBeTruthy()
  })
})

// === C-1（reviewing 返工修复）：hook 留下后台子进程的形态 ===
//
// 为什么单列一组（lesson 011）：旧实现的结算信号是 `'close'`，而 `close` 要等
// stdout/stderr 管道**全部持有者**退出——hook 命令里一个 `cmd &` 就足以让 `close` 永不触发。
// 旧用例只用 `sleep 5`（**无后台子进程**），恰好绕过这一形态；本组的命令**必须**含 `&`。
// 修复前实测（`npx tsx` 探针，timeoutMs:100）：`sleep 4 & sleep 5` → **5014ms**；
// `sleep 4 & echo hi` → **4019ms 且被误判为「hook 超时」**（PreToolUse 下=错误阻塞工具调用）。

/** `ps -p <pid> -o pid=` 是否仍能看到该进程（进程不存在时 ps 退出码非 0 → false） */
function psAlive(pid: number): boolean {
  try {
    return execSync(`ps -p ${pid} -o pid=`, { encoding: 'utf8' }).trim().length > 0
  } catch {
    return false
  }
}

/** 轮询等待进程消失（SIGKILL 后内核回收需极短时间）；返回是否在超时内消失 */
async function waitGone(pid: number, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!psAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

/** 读 hook 写出的后台子进程 pid（`echo $! > file` 的产物） */
function readPidFile(file: string): number {
  const pid = Number(readFileSync(file, 'utf8').trim())
  expect(Number.isInteger(pid) && pid > 0).toBe(true)
  return pid
}

describe('HookRunner：C-1 后台子进程形态（真实 spawn + ps 复核）', () => {
  it('① 超时不再被后台孙进程拖长：`sleep 5 & …; sleep 5` + timeoutMs:100 → 墙钟 ≈ timeoutMs，且无残留进程', async () => {
    const pidFile = join(tmp, 'bg-timeout.pid')
    const runner = runnerOf({
      PreToolUse: [{ command: `sleep 5 & echo $! > "${pidFile}"; sleep 5`, timeoutMs: 100 }],
    })
    const started = Date.now()
    const outcome = await runner.run('PreToolUse', payload())
    const elapsed = Date.now() - started

    expect(outcome.blocked).toBe(true)
    expect(outcome.reason).toBe('hook 超时')
    // 修复前实测 5014ms（后台孙子握着继承的管道 → close 要等它退出才触发）
    expect(elapsed).toBeLessThan(500)
    // ps 复核：后台孙子被进程组回收，结算后无残留
    expect(await waitGone(readPidFile(pidFile))).toBe(true)
  })

  it('② sh 立即 exit 0 + 后台子进程 → 不误报超时，stdout 决策被完整采集，且后台子进程被回收', async () => {
    const pidFile = join(tmp, 'bg-exit0.pid')
    const runner = runnerOf({
      PreToolUse: [
        {
          command: `sleep 5 & echo $! > "${pidFile}"; echo '{"decision":"block","reason":"stdout 决策被读到"}'`,
          timeoutMs: 100,
        },
      ],
    })
    const started = Date.now()
    const outcome = await runner.run('PreToolUse', payload())
    const elapsed = Date.now() - started

    // 修复前：sh 实际 exit 0，却被 100ms 到点的 timedOut 误判 → reason='hook 超时'（且要等 4019ms）
    expect(outcome.reason).toBe('stdout 决策被读到')
    expect(elapsed).toBeLessThan(500)
    expect(await waitGone(readPidFile(pidFile))).toBe(true)
  })

  it('③ 无残留的反证：hook 不清理时后台子进程确实会存活（证明 ①② 的回收不是恒真）', async () => {
    const pidFile = join(tmp, 'bg-leak.pid')
    // 用一个不受 HookRunner 管辖的裸 spawn 做反证：同样的命令、同样的后台形态，
    // 没有进程组回收就会残留（若它也不残留，说明 ①② 的 ps 断言无鉴别力）
    const bunny = spawn('sh', ['-c', `sleep 5 & echo $! > "${pidFile}"`], {
      detached: true,
      stdio: 'ignore',
    })
    await new Promise((r) => setTimeout(r, 200))
    const pid = readPidFile(pidFile)
    expect(psAlive(pid)).toBe(true) // 裸 spawn（leader 退出、后台孙子存活）→ 残留可见
    try {
      if (bunny.pid !== undefined) process.kill(-bunny.pid, 'SIGKILL')
    } catch {
      // 组已不可达
    }
    expect(await waitGone(pid)).toBe(true) // 用进程组回收清场
  })
})

// === 配置解析 / 哈希 / 路径 ===

describe('配置解析与路径（白名单校验 / resolveSafe 同语义）', () => {
  it('parseHookConfig：合法配置原样保留；任何一部分不合法 → null（整份忽略）', () => {
    expect(parseHookConfig({ PreToolUse: [{ command: 'echo hi' }] })).toEqual({
      PreToolUse: [{ command: 'echo hi' }],
    })
    expect(parseHookConfig({ PreToolUse: [{ command: 'echo hi', matcher: 'bash', timeoutMs: 500 }] })).toEqual({
      PreToolUse: [{ command: 'echo hi', matcher: 'bash', timeoutMs: 500 }],
    })
    // 非法：未知事件 / 空 command / 越界 timeoutMs / 数组顶层 / 非对象项
    expect(parseHookConfig({ SessionStart: [{ command: 'x' }] })).toBeNull()
    expect(parseHookConfig({ Stop: [{ command: '   ' }] })).toBeNull()
    expect(parseHookConfig({ Stop: [{ command: 'x', timeoutMs: -1 }] })).toBeNull()
    expect(parseHookConfig([{ command: 'x' }])).toBeNull()
    expect(parseHookConfig({ Stop: ['not-an-object'] })).toBeNull()
    expect(parseHookConfig(null)).toBeNull()
  })

  it('hooksConfigHash：内容相同哈希相同；命令变化哈希变化（重新信任的依据）', () => {
    const a: HookConfig = { PreToolUse: [{ command: 'echo hi' }] }
    const b: HookConfig = { PreToolUse: [{ command: 'echo hi' }] }
    const c: HookConfig = { PreToolUse: [{ command: 'echo hacked' }] }
    expect(hooksConfigHash(a)).toBe(hooksConfigHash(b))
    expect(hooksConfigHash(a)).not.toBe(hooksConfigHash(c))
    // 键序无关
    expect(hooksConfigHash({ Stop: [], PreToolUse: a.PreToolUse })).toBe(
      hooksConfigHash({ PreToolUse: a.PreToolUse, Stop: [] }),
    )
  })

  it('resolveProjectHooksPath：解析结果恒在 projectRoot 前缀内（lesson 008，不另写一套）', () => {
    const p = resolveProjectHooksPath(projectRoot)
    expect(p).toBe(join(projectRoot, '.agent-cli/hooks.json'))
    expect(p.startsWith(projectRoot + '/')).toBe(true)
  })
})

// === AC-46/47：信任流程（真实 InteractionBroker + 假 host，spy 同一分派路径） ===

/** 记录型 InteractionHost：confirm 结果可指定，记录全部 request spec */
function fakeHost(confirmValue: boolean | 'unavailable'): { host: InteractionHost; specs: InteractionSpec[] } {
  const specs: InteractionSpec[] = []
  const host: InteractionHost = {
    async openInteractionOverlay(spec: InteractionSpec): Promise<InteractionResult> {
      specs.push(spec)
      return confirmValue === 'unavailable'
        ? { kind: 'unavailable', reason: 'non-interactive' }
        : { kind: 'confirm', value: confirmValue }
    },
    addInfo() {},
  }
  return { host, specs }
}

/** 装配 + spy：断言信任确认命中 broker.request（AC-27 的 Hook 消费者证据） */
async function setupWith(confirmValue: boolean | 'unavailable') {
  const { host, specs } = fakeHost(confirmValue)
  const broker = new InteractionBroker(host, { interactive: confirmValue !== 'unavailable', autoAccept: false })
  const spy = vi.spyOn(broker, 'request')
  const result = await setupHooks({
    projectRoot,
    defaultTimeoutMs: 10_000,
    requestConfirm: (spec) => broker.request(spec),
  })
  return { ...result, spy, specs }
}

describe('setupHooks：AC-46 项目级首次信任确认', () => {
  it('项目级配置存在且未信任 → 经 broker.request 弹 confirm（展示来源路径 + 命令全文）；拒绝 → 不加载', async () => {
    writeProjectHooks(JSON.stringify({ PreToolUse: [{ command: 'echo proj-hook' }] }))
    const { runner, projectStatus, spy, specs } = await setupWith(false)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(specs[0].kind).toBe('confirm')
    expect(specs[0].title).toContain(join(projectRoot, '.agent-cli/hooks.json')) // 来源路径
    expect((specs[0] as { message?: string }).message).toContain('echo proj-hook') // 命令全文
    expect((specs[0] as { forced?: boolean }).forced).toBe(true) // --yes 不得自动信任（V-1 精神）
    expect((specs[0] as { defaultYes?: boolean }).defaultYes).toBe(false)

    expect(projectStatus).toBe('rejected')
    expect(runner.describe()).toHaveLength(0) // 项目配置未加载
    expect(isProjectHooksTrusted(projectRoot, hooksConfigHash({ PreToolUse: [{ command: 'echo proj-hook' }] }))).toBe(false)
  })

  it('非交互（unavailable）等同拒绝（D9 安全默认）', async () => {
    writeProjectHooks(JSON.stringify({ Stop: [{ command: 'true' }] }))
    const { projectStatus, runner } = await setupWith('unavailable')
    expect(projectStatus).toBe('rejected')
    expect(runner.describe()).toHaveLength(0)
  })

  it('批准 → 加载项目配置并写信任记录（trustedHooks[projectRoot]）', async () => {
    const cfg: HookConfig = { PreToolUse: [{ command: 'echo trusted' }] }
    writeProjectHooks(JSON.stringify(cfg))
    const { runner, projectStatus, specs } = await setupWith(true)

    expect(projectStatus).toBe('trusted')
    expect(runner.describe()).toHaveLength(1)
    expect(specs).toHaveLength(1) // 只问一次
    const saved = JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf8'))
    expect(saved.trustedHooks[projectRoot].hash).toBe(hooksConfigHash(cfg))
    expect(typeof saved.trustedHooks[projectRoot].trustedAt).toBe('string')
  })
})

describe('setupHooks：AC-47 用户级免确认 / 信任复用 / 哈希变化重问', () => {
  it('用户级 hooks.json 无需确认（request 不被调用）', async () => {
    writeFileSync(join(tmp, 'hooks.json'), JSON.stringify({ UserPromptSubmit: [{ command: captureStdin('u') }] }))
    const { runner, projectStatus, spy } = await setupWith('unavailable')
    expect(spy).not.toHaveBeenCalled()
    expect(projectStatus).toBe('none')
    expect(runner.describe()).toEqual([
      { source: 'user', event: 'UserPromptSubmit', item: { command: captureStdin('u') } },
    ])
  })

  it('已记录的信任可复用：第二次装配不再询问（AC-47 信任复用）', async () => {
    const cfg: HookConfig = { Stop: [{ command: 'echo reused' }] }
    writeProjectHooks(JSON.stringify(cfg))
    const first = await setupWith(true)
    expect(first.projectStatus).toBe('trusted')
    expect(first.spy).toHaveBeenCalledTimes(1)

    const second = await setupWith('unavailable') // 即使不可交互也应直接复用，不再询问
    expect(second.spy).not.toHaveBeenCalled()
    expect(second.projectStatus).toBe('trusted')
    expect(second.runner.describe()).toEqual([{ source: 'project', event: 'Stop', item: { command: 'echo reused' } }])
  })

  it('命令变了（哈希变化）→ 重新信任确认（AC-47 末句）', async () => {
    writeProjectHooks(JSON.stringify({ Stop: [{ command: 'echo v1' }] }))
    const first = await setupWith(true)
    expect(first.projectStatus).toBe('trusted')

    writeProjectHooks(JSON.stringify({ Stop: [{ command: 'echo v2-malicious' }] }))
    const second = await setupWith(false)
    expect(second.spy).toHaveBeenCalledTimes(1) // 哈希变了 → 必须重问
    expect(second.projectStatus).toBe('rejected')
    expect(second.runner.describe()).toHaveLength(0)
  })

  it('项目级文件不存在 / 内容无效 → 不询问（status none，其余来源不受影响）', async () => {
    const { projectStatus, spy } = await setupWith(true)
    expect(projectStatus).toBe('none')
    expect(spy).not.toHaveBeenCalled()

    writeProjectHooks('{ broken json')
    const bad = await setupWith(true)
    expect(bad.projectStatus).toBe('none')
    expect(bad.spy).not.toHaveBeenCalled()

    writeProjectHooks(JSON.stringify({ BadEvent: [{ command: 'x' }] }))
    const wrongShape = await setupWith(true)
    expect(wrongShape.projectStatus).toBe('none')
    expect(wrongShape.spy).not.toHaveBeenCalled()
  })
})
