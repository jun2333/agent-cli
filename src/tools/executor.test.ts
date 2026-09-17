import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ApprovalDecision } from '../permissions.js'
import { PermissionController } from '../permissions.js'
import { config } from '../config.js'
import {
  compatFailClosedPolicy,
  createToolExecutor,
  type PermissionPolicy,
  type ToolLifecycleEvent,
} from './executor.js'
import { buildDefinitions, TOOL_SPECS, type ToolExecContext, type ToolMeta, type ToolSpec } from './registry.js'
import { TRUNCATION_MARK, countLines } from './truncate.js'

/** 造一个最小 spec（只用于执行器行为测试，不进注册表） */
function fakeSpec(name: string, over: Partial<ToolMeta> = {}, impl?: ToolSpec['impl']): ToolSpec {
  return {
    meta: {
      name,
      description: `假工具 ${name}`,
      parameters: { type: 'object', properties: {} },
      mutating: false,
      requiresApproval: false,
      backgroundable: false,
      source: 'builtin',
      ...over,
    },
    impl: impl ?? (async () => ({ content: JSON.stringify({ ok: true }) })),
  }
}

/** 测试内构造执行器的便捷封装：固定 currentModel，其余依赖按需注入 */
type ExecOpts = Omit<Parameters<typeof createToolExecutor>[0], 'currentModel'>
const executorOf = (specs: ToolSpec[], opts: ExecOpts = {}) =>
  createToolExecutor({ currentModel: 'test-model', ...opts }, specs)

/**
 * AC-40：执行前/后事件在工具执行前后各触发一次，载荷含工具名、参数、结果、耗时。
 * 验证方式：单测订阅 `executor.on()`。
 */
describe('工具执行器：AC-40 执行前/后事件', () => {
  it('一次成功调用恰好 1 个 tool_pre + 1 个 tool_post，载荷字段齐全', async () => {
    const events: ToolLifecycleEvent[] = []
    const exec = executorOf([fakeSpec('demo')])
    exec.on((e) => events.push(e))

    const result = await exec.implementations.demo({ a: 1 })

    expect(result.content).toBe(JSON.stringify({ ok: true }))
    expect(events.map((e) => e.type)).toEqual(['tool_pre', 'tool_post'])

    const pre = events[0]
    expect(pre.type).toBe('tool_pre')
    if (pre.type === 'tool_pre') {
      expect(pre.name).toBe('demo')
      expect(pre.args).toEqual({ a: 1 })
    }

    const post = events[1]
    expect(post.type).toBe('tool_post')
    if (post.type === 'tool_post') {
      expect(post.name).toBe('demo')
      expect(post.args).toEqual({ a: 1 })
      expect(post.ok).toBe(true)
      expect(post.durationMs).toBeGreaterThanOrEqual(0)
      // 行数/字节与 classifyToolResult 同口径（结构化字段缺省时由 content 兜底）
      expect(post.outputLines).toBe(1)
      expect(post.outputBytes).toBe(Buffer.byteLength(JSON.stringify({ ok: true }), 'utf8'))
      expect(post.error).toBeUndefined()
    }
  })

  it('impl 返回的结构化 ok/lines/bytes 优先于 content 兜底判定', async () => {
    const events: ToolLifecycleEvent[] = []
    const exec = executorOf([
      fakeSpec('rich', {}, async () => ({ content: '看起来成功', ok: false, lines: 7, bytes: 99 })),
    ])
    exec.on((e) => events.push(e))

    await exec.implementations.rich({})

    const post = events[1]
    expect(post.type).toBe('tool_post')
    if (post.type === 'tool_post') {
      expect(post.ok).toBe(false)
      expect(post.outputLines).toBe(7)
      expect(post.outputBytes).toBe(99)
    }
  })

  it('失败的 content（含 error 字段）→ post.ok=false 且带出 error 原因', async () => {
    const events: ToolLifecycleEvent[] = []
    const exec = executorOf([fakeSpec('bad', {}, async () => ({ content: JSON.stringify({ error: '炸了' }) }))])
    exec.on((e) => events.push(e))

    await exec.implementations.bad({})

    const post = events[1]
    if (post.type === 'tool_post') {
      expect(post.ok).toBe(false)
      expect(post.error).toBe('炸了')
    }
  })

  it('impl 抛异常 → 归一为既有 {error} 形状，pre/post 仍然成对', async () => {
    const events: ToolLifecycleEvent[] = []
    const exec = executorOf([
      fakeSpec('boom', {}, async () => {
        throw new Error('内部爆炸')
      }),
    ])
    exec.on((e) => events.push(e))

    const r = await exec.implementations.boom({})
    expect(r.content).toContain('工具执行失败: 内部爆炸')
    expect(r.content).toContain('error')
    expect(events.map((e) => e.type)).toEqual(['tool_pre', 'tool_post'])
    const post = events[1]
    if (post.type === 'tool_post') expect(post.ok).toBe(false)
  })

  it('退订后不再收到事件', async () => {
    const events: ToolLifecycleEvent[] = []
    const exec = executorOf([fakeSpec('demo')])
    const off = exec.on((e) => events.push(e))
    off()
    await exec.implementations.demo({})
    expect(events).toEqual([])
  })

  it('多个订阅者都收到同一个事件', async () => {
    const a: string[] = []
    const b: string[] = []
    const exec = executorOf([fakeSpec('demo')])
    exec.on((e) => a.push(e.type))
    exec.on((e) => b.push(e.type))
    await exec.implementations.demo({})
    expect(a).toEqual(['tool_pre', 'tool_post'])
    expect(b).toEqual(['tool_pre', 'tool_post'])
  })
})

/**
 * 包装顺序（design §2）：pre 事件 → PreToolUse → 权限 → impl → 截断 → PostToolUse → post 事件。
 * 这是权限（FR-6）与 Hook（FR-8）能正确挂载的前提。
 */
describe('工具执行器：包装顺序与各挂载点', () => {
  it('正常路径的调用顺序严格为 pre → hook → 权限 → impl → 截断 → post hook → post', async () => {
    const trace: string[] = []
    const exec = createToolExecutor(
      {
        currentModel: 'test-model',
        preToolUse: async () => {
          trace.push('preHook')
          return { blocked: false }
        },
        decidePermission: () => {
          trace.push('permission')
          return 'allow'
        },
        truncate: (r) => {
          trace.push('truncate')
          return r
        },
        postToolUse: async () => {
          trace.push('postHook')
          return { blocked: false }
        },
      },
      [fakeSpec('ordered', {}, async () => {
        trace.push('impl')
        return { content: '{}' }
      })],
    )
    exec.on((e) => trace.push(e.type))

    await exec.implementations.ordered({})

    expect(trace).toEqual(['tool_pre', 'preHook', 'permission', 'impl', 'truncate', 'postHook', 'tool_post'])
  })

  it('PreToolUse 阻塞（AC-43 的挂载点）：impl 不执行、原因回给调用方、post 成对', async () => {
    const events: ToolLifecycleEvent[] = []
    const impl = vi.fn(async () => ({ content: '{}' }))
    const exec = createToolExecutor(
      {
        currentModel: 'test-model',
        preToolUse: async () => ({ blocked: true, reason: '被 hook 拦下' }),
      },
      [fakeSpec('blocked', {}, impl)],
    )
    exec.on((e) => events.push(e))

    const r = await exec.implementations.blocked({ x: 1 })

    expect(impl).not.toHaveBeenCalled()
    expect(r.content).toContain('Hook 已阻止')
    expect(r.content).toContain('被 hook 拦下')
    expect(events.map((e) => e.type)).toEqual(['tool_pre', 'tool_post'])
    const post = events[1]
    if (post.type === 'tool_post') expect(post.ok).toBe(false)
  })

  it('PreToolUse 早于权限判定（hook 可先拦，避免无谓弹审批）', async () => {
    const order: string[] = []
    const exec = createToolExecutor(
      {
        currentModel: 'test-model',
        preToolUse: async () => {
          order.push('hook')
          return { blocked: true, reason: 'x' }
        },
        decidePermission: () => {
          order.push('permission')
          return 'allow'
        },
        requestApproval: async () => {
          order.push('approval')
          return true
        },
      },
      [fakeSpec('t')],
    )
    await exec.implementations.t({})
    expect(order).toEqual(['hook'])
  })

  it('hook 的非阻塞告警经 onHookWarning 上报（AC-44 的通道）', async () => {
    const warnings: string[] = []
    const exec = createToolExecutor(
      {
        currentModel: 'test-model',
        postToolUse: async () => ({ blocked: false, warning: 'post hook 退出码非 0' }),
        onHookWarning: (m) => warnings.push(m),
      },
      [fakeSpec('t')],
    )
    await exec.implementations.t({})
    expect(warnings).toEqual(['post hook 退出码非 0'])
  })

  it('PostToolUse hook 收到第 4 参 durationMs（FR-8 载荷字段，design §5）', async () => {
    let seen: number | null = null
    const exec = createToolExecutor(
      {
        currentModel: 'test-model',
        postToolUse: async (_name, _args, _result, durationMs) => {
          seen = durationMs
          return { blocked: false }
        },
      },
      [fakeSpec('t')],
    )
    await exec.implementations.t({})
    expect(seen).not.toBeNull()
    expect(seen as unknown as number).toBeGreaterThanOrEqual(0)
  })

  it('权限 deny：impl 不执行并返回拒绝原因', async () => {
    const impl = vi.fn(async () => ({ content: '{}' }))
    const exec = executorOf([fakeSpec('denied', {}, impl)], {
      decidePermission: () => ({ type: 'deny', reason: '策略不允许' }),
    })
    const r = await exec.implementations.denied({})
    expect(impl).not.toHaveBeenCalled()
    expect(r.content).toContain('权限拒绝')
    expect(r.content).toContain('策略不允许')
  })

  it('权限 ask + requestApproval=false：impl 不执行；=true：执行', async () => {
    const impl = vi.fn(async () => ({ content: JSON.stringify({ ran: true }) }))
    const spec = [fakeSpec('askme', {}, impl)]
    const ask = (): ApprovalDecision => ({ type: 'ask', reason: '需要审批', mode: 'default' })

    const denied = executorOf(spec, { decidePermission: ask, requestApproval: async () => ({ approved: false }) })
    expect((await denied.implementations.askme({})).content).toContain('用户拒绝')
    expect(impl).not.toHaveBeenCalled()

    const approved = executorOf(spec, { decidePermission: ask, requestApproval: async () => ({ approved: true }) })
    await approved.implementations.askme({})
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('权限 ask 但没有审批通道 → 安全默认拒绝（B2 的 fail-closed）', async () => {
    const impl = vi.fn(async () => ({ content: '{}' }))
    const exec = executorOf([fakeSpec('askme', {}, impl)], {
      decidePermission: () => ({ type: 'ask', reason: '需要审批', mode: 'default' }),
    })
    const r = await exec.implementations.askme({})
    expect(impl).not.toHaveBeenCalled()
    expect(r.content).toContain('没有可用的审批通道')
  })

  it('截断 seam 生效：替换后的结果与 post 的规模都取自替换后', async () => {
    const events: ToolLifecycleEvent[] = []
    const exec = executorOf([fakeSpec('long', {}, async () => ({ content: 'x\n'.repeat(100) }))], {
      truncate: (r) => ({ ...r, content: '已截断', lines: 1, bytes: 9 }),
    })
    exec.on((e) => events.push(e))

    const r = await exec.implementations.long({})
    expect(r.content).toBe('已截断')
    const post = events[1]
    if (post.type === 'tool_post') {
      expect(post.outputLines).toBe(1)
      expect(post.outputBytes).toBe(9)
    }
  })

  it('不注入截断时用默认 truncateToolResult：小输出上等价 identity（config 双阈值未触发）', async () => {
    const original = 'a\nb\nc'
    const exec = executorOf([fakeSpec('n', {}, async () => ({ content: original }))])
    const r = await exec.implementations.n({})
    expect(r.content).toBe(original)
  })

  it('不注入截断时默认挂载双阈值（B6 接线）：1200 行输出被截断并标注剩余量', async () => {
    const long = Array.from({ length: 1200 }, (_, i) => `line-${i}`).join('\n')
    const exec = executorOf([fakeSpec('long', {}, async () => ({ content: long }))])
    const r = await exec.implementations.long({})

    const text = r.content as string
    expect(text).toContain('输出已截断')
    expect(text).toContain('省略 200 行')
    // 标注的数值与 config 阈值同源（阈值 = config.toolOutputMaxLines）
    expect(text.split('\n').length).toBeLessThan(1200)
  })

  it('ToolExecContext 注入了 tasks（FR-2 的工具据此读写后台任务）', async () => {
    const fakeTasks = { fake: true } as unknown as import('../tasks.js').TaskManager
    let seen: unknown = undefined
    const exec = createToolExecutor({ currentModel: 'm', tasks: fakeTasks }, [
      fakeSpec('ctx', {}, async (_args, ctx: ToolExecContext) => {
        seen = ctx.tasks
        return { content: '{}' }
      }),
    ])
    await exec.implementations.ctx({})
    expect(seen).toBe(fakeTasks)
  })

  it('ToolExecContext 注入了 currentModel（view_image 预检依赖它）', async () => {
    let seen = ''
    const exec = createToolExecutor(
      { currentModel: 'qwen3-vl:8b-thinking' },
      [
        fakeSpec('ctx', {}, async (_args, ctx: ToolExecContext) => {
          seen = ctx.currentModel
          return { content: '{}' }
        }),
      ],
    )
    await exec.implementations.ctx({})
    expect(seen).toBe('qwen3-vl:8b-thinking')
  })
})

/**
 * 权限 seam 的可注入性 —— **AC-39 的正式判定**（B7 落地）。
 *
 * AC-39 的原文要求：注入一个 `requiresApproval: true` 的假工具即可改变行为，**无需改权限代码**。
 * 因此本组的正式判定用**生产权限代码**（`PermissionController`，零注入替身）+ 记录型 broker：
 * 假工具只凭元数据翻转行为；权限模块（`src/permissions.ts`）自始至终一行不改。
 *
 * 另保留一组"测试内替身策略"的用例（B2 的 seam 回归网）：证明 executor 对策略本身也是零假设的。
 */
describe('工具执行器：权限 seam 可注入（AC-39）', () => {
  /** 记录型审批通道（记录收到的审批请求；批准与否可指定）。与 index.ts 的 createApprovalRequest 同形状 */
  function recordingApproval(approved: boolean) {
    const asked: Array<{ title: string; message?: string }> = []
    const requestApproval = async (
      meta: ToolMeta,
      _args: unknown,
      decision: Extract<ApprovalDecision, { type: 'ask' }>,
    ) => {
      asked.push({ title: `允许执行 ${meta.name}？`, message: decision.reason })
      // 不带 reason → executor 落到默认文案「用户拒绝了 <name> 的执行（权限模式：<mode>）」
      return approved ? { approved: true } : { approved: false }
    }
    return { requestApproval, asked }
  }

  it('AC-39：注入 requiresApproval:true 的假工具 + 生产 PermissionController → 触发审批；false → 直接放行（权限代码零改动）', async () => {
    const gatedImpl = vi.fn(async () => ({ content: JSON.stringify({ ran: 'gated' }) }))
    const openImpl = vi.fn(async () => ({ content: JSON.stringify({ ran: 'open' }) }))
    const { requestApproval, asked } = recordingApproval(true)
    // 生产权限代码原样注入（default 模式）；本用例不替身、不 mock 任何判定逻辑
    const controller = new PermissionController('default')

    const exec = createToolExecutor(
      { currentModel: 'test-model', requestApproval, decidePermission: (meta, args) => controller.decide(meta, args) },
      [...TOOL_SPECS, fakeSpec('fake_gated', { requiresApproval: true }, gatedImpl), fakeSpec('fake_open', { requiresApproval: false }, openImpl)],
    )

    // requiresApproval:true 的假工具：ask → 记录型 broker 批准 → 执行
    const gated = await exec.implementations.fake_gated({})
    expect(gatedImpl).toHaveBeenCalledTimes(1)
    expect(asked).toHaveLength(1)
    expect(asked[0].title).toContain('fake_gated')
    expect(JSON.parse(gated.content as string)).toEqual({ ran: 'gated' })

    // requiresApproval:false 的假工具：不产生任何审批请求
    const open = await exec.implementations.fake_open({})
    expect(openImpl).toHaveBeenCalledTimes(1)
    expect(asked).toHaveLength(1) // 没有新增
    expect(JSON.parse(open.content as string)).toEqual({ ran: 'open' })
  })

  it('AC-39（拒绝侧）：同一假工具在审批被拒时不执行，拒绝结果带权限模式', async () => {
    const gatedImpl = vi.fn(async () => ({ content: '{}' }))
    const { requestApproval } = recordingApproval(false)
    // default 模式：requiresApproval:true → ask（acceptEdits 会放行工具级默认，语义如此，不在此测）
    const controller = new PermissionController('default')
    const exec = createToolExecutor(
      { currentModel: 'test-model', requestApproval, decidePermission: (meta, args) => controller.decide(meta, args) },
      [fakeSpec('fake_gated', { requiresApproval: true }, gatedImpl)],
    )
    const r = await exec.implementations.fake_gated({})
    expect(gatedImpl).not.toHaveBeenCalled()
    expect(r.content).toContain('用户拒绝')
    expect(r.content).toContain('default')
  })

  /** B2 seam 的回归网：executor 对"策略"本身零假设（不依赖生产 controller） */
  it('seam 回归：自定义策略读元数据同样翻转行为（executor 零改动）', async () => {
    const metadataPolicy: PermissionPolicy = (meta, args): ApprovalDecision => {
      for (const rule of meta.paramRules ?? []) {
        if (rule.test(args as Record<string, unknown>)) {
          return rule.requiresApproval ? { type: 'ask', reason: rule.reason, mode: 'default' } : { type: 'allow' }
        }
      }
      return meta.requiresApproval ? { type: 'ask', reason: `需要审批：${meta.name}`, mode: 'default' } : { type: 'allow' }
    }

    const gatedImpl = vi.fn(async () => ({ content: JSON.stringify({ ran: 'gated' }) }))
    const openImpl = vi.fn(async () => ({ content: JSON.stringify({ ran: 'open' }) }))

    const gated = createToolExecutor({ currentModel: 'test-model', decidePermission: metadataPolicy }, [
      ...TOOL_SPECS,
      fakeSpec('fake_gated', { requiresApproval: true }, gatedImpl),
    ])
    const open = createToolExecutor({ currentModel: 'test-model', decidePermission: metadataPolicy }, [
      ...TOOL_SPECS,
      fakeSpec('fake_open', { requiresApproval: false }, openImpl),
    ])

    // 没有审批通道 → ask 降级为安全默认拒绝
    const gatedResult = await gated.implementations.fake_gated({})
    expect(gatedImpl).not.toHaveBeenCalled()
    expect(gatedResult.content).toContain('error')

    const openResult = await open.implementations.fake_open({})
    expect(openImpl).toHaveBeenCalledTimes(1)
    expect(JSON.parse(openResult.content as string)).toEqual({ ran: 'open' })
  })

  it('paramRules 由同一策略消费（命中 requiresApproval:false 的规则即可放行）', async () => {
    const metadataPolicy: PermissionPolicy = (meta, args): ApprovalDecision => {
      for (const rule of meta.paramRules ?? []) {
        if (rule.test(args as Record<string, unknown>)) {
          return rule.requiresApproval ? { type: 'ask', reason: rule.reason, mode: 'default' } : { type: 'allow' }
        }
      }
      return meta.requiresApproval ? { type: 'ask', reason: `需要审批：${meta.name}`, mode: 'default' } : { type: 'allow' }
    }
    const impl = vi.fn(async () => ({ content: '{}' }))
    const opts = { currentModel: 'test-model', decidePermission: metadataPolicy }

    await createToolExecutor(opts, [
      fakeSpec('rulebased', {
        requiresApproval: true,
        paramRules: [{ id: 'safe-read', test: (a) => a.safe === true, requiresApproval: false, reason: '只读子命令' }],
      }, impl),
    ]).implementations.rulebased({ safe: true })
    expect(impl).toHaveBeenCalledTimes(1)

    const denied = vi.fn(async () => ({ content: '{}' }))
    await createToolExecutor(opts, [fakeSpec('rulebased', { requiresApproval: true }, denied)]).implementations.rulebased({
      safe: false,
    })
    expect(denied).not.toHaveBeenCalled()
  })

  it('注入假工具后追加在末尾：前 12 项 definitions 仍与基线口径一致', () => {
    const exec = createToolExecutor({ currentModel: 'test-model' }, [...TOOL_SPECS, fakeSpec('fake_extra')])
    expect(exec.definitions.slice(0, 12)).toEqual(buildDefinitions().slice(0, 12))
    expect(exec.definitions.map((d) => d.function.name).slice(0, 12)).toEqual(
      TOOL_SPECS.map((s) => s.meta.name).slice(0, 12),
    )
    expect(exec.definitions.length).toBe(TOOL_SPECS.length + 1)
  })
})

/**
 * 前缀缓存的硬约束（015 / R1）：`definitions` 在一个会话内必须恒定。
 * 断言用 `JSON.stringify` 而不是 `toEqual` —— 键序变化也要被抓到（键序就是请求体的字节）。
 */
describe('工具执行器：definitions 会话内恒定（前缀缓存硬约束）', () => {
  it('两次独立构造的 executor，definitions 深相等且字节相等', () => {
    const a = createToolExecutor({ currentModel: 'm1' })
    const b = createToolExecutor({ currentModel: 'm2' })
    expect(a.definitions).toEqual(b.definitions)
    expect(JSON.stringify(a.definitions)).toBe(JSON.stringify(b.definitions))
    expect(JSON.stringify(a.definitions)).toBe(JSON.stringify(buildDefinitions()))
  })

  it('同一 executor 反复读 definitions 是同一引用（不会被运行期改写）', () => {
    const exec = createToolExecutor({ currentModel: 'm' })
    expect(exec.definitions).toBe(exec.definitions)
  })

  it('执行工具不会改变 definitions（无"按运行期条件增删工具"）', async () => {
    const exec = createToolExecutor({ currentModel: 'm' }, [
      ...TOOL_SPECS,
      fakeSpec('noop'),
    ])
    const before = JSON.stringify(exec.definitions)
    await exec.implementations.noop({})
    await exec.implementations.read({ path: 'src/config.ts' })
    expect(JSON.stringify(exec.definitions)).toBe(before)
  })
})

/**
 * B2 的默认权限决策（D-2）：`forced` 规则 deny、其余 allow。
 * 这条默认值决定了 compat 路径（`createTools()`）的既有行为面（12 个工具一律可执行），必须锁死。
 */
describe('工具执行器：默认权限决策（D-2 的 fail-closed）', () => {
  const meta = (over: Partial<ToolMeta> = {}): ToolMeta => fakeSpec('m', over).meta

  it('compatFailClosedPolicy：forced 规则 deny，其余放行（即使 requiresApproval=true）', () => {
    expect(compatFailClosedPolicy(meta({ requiresApproval: true }), {})).toEqual({ type: 'allow' })
    expect(
      compatFailClosedPolicy(
        meta({ paramRules: [{ id: 'd', test: () => true, requiresApproval: true, forced: true, reason: '危险' }] }),
        {},
      ),
    ).toEqual({ type: 'deny', reason: '危险' })
    // 非 forced 的规则不拦：compat 路径（createTools()）只服务 tools.test.ts，无审批消费者（D-2）
    expect(
      compatFailClosedPolicy(
        meta({ paramRules: [{ id: 'n', test: () => true, requiresApproval: true, reason: '普通' }] }),
        {},
      ),
    ).toEqual({ type: 'allow' })
  })

  it('默认生效：不注入 decidePermission 时，requiresApproval 的工具仍可执行（compat 行为不变）', async () => {
    const impl = vi.fn(async () => ({ content: '{}' }))
    const exec = createToolExecutor({ currentModel: 'test-model' }, [fakeSpec('w', { requiresApproval: true }, impl)])
    await exec.implementations.w({})
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('默认策略下 forced 规则命中 → 直接拒绝（B7 迁移危险命令规则后的行为面已就位）', async () => {
    const impl = vi.fn(async () => ({ content: '{}' }))
    const exec = createToolExecutor({ currentModel: 'test-model' }, [
      fakeSpec(
        'danger',
        {
          paramRules: [
            { id: 'rm', test: (a) => a.cmd === 'rm -rf /', requiresApproval: true, forced: true, reason: '删除根目录' },
          ],
        },
        impl,
      ),
    ])
    const r = await exec.implementations.danger({ cmd: 'rm -rf /' })
    expect(impl).not.toHaveBeenCalled()
    expect(r.content).toContain('权限拒绝')
  })
})

/**
 * W-1 / W-3（reviewing 返工修复）：行数口径与双阈值必须作用在**真实输出**上。
 *
 * 修复前的实测（复审报告 W-1/W-2）：
 * - `bash seq 1 40` → 工具行「输出 1 行」（`classifyToolResult` 数的是 JSON **信封**，恒 1 行）；
 * - `read` 一个 2000 行 / 36.9KB 的文件 → **完全不截断**（信封只有 1 行，1000 行阈值永不触发）。
 * 本组走**真实 `TOOL_SPECS`**（真 spawn `seq`、真读文件），断言落在可机读产物上（lesson 011），
 * 并显式反证"被数的对象修复前确实只有 1 行"——否则这些断言可能恒真。
 */
describe('工具执行器：W-1/W-3 真实输出的行数与截断（JSON 信封不再是盲区）', () => {
  it('W-1：真实 `bash seq 1 40` → 行数 40（不是 1），且 ToolResult.lines 与 post 事件同源', async () => {
    const events: ToolLifecycleEvent[] = []
    const exec = executorOf([...TOOL_SPECS])
    exec.on((e) => events.push(e))

    const r = await exec.implementations.bash({ command: 'seq 1 40' })
    const parsed = JSON.parse(r.content as string)
    expect(parsed.exitCode).toBe(0)
    expect(parsed.stdout).toBe(Array.from({ length: 40 }, (_, i) => i + 1).join('\n') + '\n')

    // 反证：修复前被数行的对象（整段 JSON 信封）确实只有 1 行 —— 断言不是恒真
    expect(countLines(r.content as string)).toBe(1)

    expect(r.lines).toBe(40) // 交付给 LLM 的 40 行（末尾换行不算第 41 行）
    expect(r.bytes).toBe(Buffer.byteLength(parsed.stdout, 'utf8')) // 只看 stdout+stderr（同截断口径）
    const post = events[1]
    expect(post.type).toBe('tool_post')
    if (post.type === 'tool_post') {
      expect(post.outputLines).toBe(40)
      expect(post.outputBytes).toBe(r.bytes)
    }
  })

  it('W-1：真实 `read` 多行文件 → 行数 = 文件行数', async () => {
    const rel = 'executor-lines-fixture.txt'
    writeFileSync(join(process.cwd(), rel), 'l1\nl2\nl3\nl4\nl5\n')
    try {
      const exec = executorOf([...TOOL_SPECS])
      const r = await exec.implementations.read({ path: rel })
      expect(countLines(r.content as string)).toBe(1) // 反证：信封 1 行
      expect(r.lines).toBe(5)
    } finally {
      rmSync(join(process.cwd(), rel), { force: true })
    }
  })

  it('W-3：`bash seq 1 2000`（<50KB，只有行阈值能触发）→ stdout 真被截断，标注数字取自实际截断量', async () => {
    const exec = executorOf([...TOOL_SPECS])
    const r = await exec.implementations.bash({ command: 'seq 1 2000' })
    const parsed = JSON.parse(r.content as string)
    const stdout = parsed.stdout as string

    expect(countLines(r.content as string)).toBe(1) // 反证：信封 1 行（修复前 1000 行阈值因此永不触发）
    expect(Buffer.byteLength(parsed.stdout, 'utf8')).toBeLessThan(config.toolOutputMaxBytes) // 字节阈值未参与

    expect(stdout).toContain(TRUNCATION_MARK)
    expect(stdout).toContain('省略 1000 行') // 2000 - config.toolOutputMaxLines(1000)
    expect(stdout.split('\n')[0]).toBe('1')
    expect(stdout).not.toContain('\n1500\n') // 第 1500 行确实没进上下文
    // 交付行数 = 保留 1000 行 + 1 行截断标注（与截断同源）
    expect(r.lines).toBe(1001)
    // 信封仍是**合法 JSON**（修复前按字节砍信封 → JSON 被劈坏）
    expect(parsed.exitCode).toBe(0)
  })

  it('W-3：`read` 2000 行文件（<50KB）→ content 字段真被截断', async () => {
    const rel = 'executor-truncate-fixture.txt'
    const body = Array.from({ length: 2000 }, (_, i) => `line-${i}`).join('\n')
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(config.toolOutputMaxBytes) // 只有行阈值能触发
    writeFileSync(join(process.cwd(), rel), body)
    try {
      const exec = executorOf([...TOOL_SPECS])
      const r = await exec.implementations.read({ path: rel })
      const parsed = JSON.parse(r.content as string)

      expect(countLines(r.content as string)).toBe(1) // 反证：信封 1 行（修复前完全不截断）
      expect(parsed.path).toBe(rel)
      expect(parsed.content).toContain(TRUNCATION_MARK)
      expect(parsed.content).toContain('省略 1000 行')
      expect(parsed.content.split('\n')[0]).toBe('line-0')
      expect(parsed.content).not.toContain('line-1999')
      expect(r.lines).toBe(1001) // 1000 保留行 + 1 标注行
    } finally {
      rmSync(join(process.cwd(), rel), { force: true })
    }
  })

  it('W-1/W-3 反证：去掉 codec（信封当作一整段）时行数确实是 1、且行阈值不触发', async () => {
    // 同一份真实产出，只是不让 executor 用 codec 抽正文 → 复现修复前的行为
    const bare = TOOL_SPECS.find((s) => s.meta.name === 'bash')!
    const exec = createToolExecutor({ currentModel: 'test-model' }, [{ meta: bare.meta, impl: bare.impl }])
    const r = await exec.implementations.bash({ command: 'seq 1 2000' })
    const stdout = JSON.parse(r.content as string).stdout as string
    expect(r.lines).toBe(1) // 信封 1 行
    expect(stdout).not.toContain(TRUNCATION_MARK) // 1000 行阈值完全失效（W-3 的根因）
  })
})

/**
 * W-R2（Rework-2）：**数组形状**的输出（`list_dir`/`glob`/`grep`/`web_search`）没有 codec →
 * 超 50KB 时走整段文本路径，被**按字节劈成非法 JSON**（实测真实 `list_dir` 4000 条目：
 * 51302B、`JSON.parse` 报 `Bad control character ... at position 51200`，而 `classifyToolResult`
 * 因"非 JSON"仍判 `ok=true` → 工具行显示 ✓ 而上下文里是坏数据）。
 *
 * 本组走**真实 `TOOL_SPECS` + 真实文件系统**（临时目录真造 4000 个文件，无 mock），
 * 并显式反证"去掉 codec 后确实劈坏"——否则"合法 JSON"的断言可能恒真（lesson 011/014）。
 */
describe('工具执行器：W-R2 数组形状输出的截断（项 = 行，信封恒为合法 JSON）', () => {
  const REL = 'executor-listdir-fixture'

  it('W-R2：真实 list_dir 4000 条目（>50KB）→ 截断成合法 JSON，标注数字与实际截断量同源', async () => {
    const abs = join(process.cwd(), REL)
    rmSync(abs, { recursive: true, force: true })
    mkdirSync(abs, { recursive: true })
    try {
      for (let i = 0; i < 4000; i++) writeFileSync(join(abs, `f${String(i).padStart(4, '0')}`), '')

      const spec = TOOL_SPECS.find((s) => s.meta.name === 'list_dir')!
      const raw = await spec.impl({ path: REL }, { currentModel: 'test-model' })
      const rawItems = JSON.parse(raw.content as string) as unknown[]
      // 前提（反证）：真实产出确实超过字节阈值，且**没有** codec 时会被劈坏
      expect(rawItems).toHaveLength(4000)
      expect(Buffer.byteLength(raw.content as string, 'utf8')).toBeGreaterThan(config.toolOutputMaxBytes)
      const bare = createToolExecutor({ currentModel: 'test-model' }, [{ meta: spec.meta, impl: spec.impl }])
      const broken = await bare.implementations.list_dir({ path: REL })
      expect(() => JSON.parse(broken.content as string)).toThrow() // 修复前的故障形态

      // ② 交付内容是**合法 JSON**，且确实被截断
      const exec = executorOf([...TOOL_SPECS])
      const r = await exec.implementations.list_dir({ path: REL })
      const delivered = JSON.parse(r.content as string) as unknown[]
      const notice = delivered[delivered.length - 1] as string
      expect(notice).toContain(TRUNCATION_MARK) // ① 结果被截断
      const kept = delivered.slice(0, -1)
      expect(kept.length).toBeGreaterThan(0)
      expect(kept.length).toBeLessThan(rawItems.length)
      // 整项保留、顺序不变——不是被字节劈坏的残片
      expect(JSON.stringify(kept)).toBe(JSON.stringify(rawItems.slice(0, kept.length)))

      // ③ 标注数字 == 实际截断量（同一 countLines / utf8 口径复算，逐字相等；lesson 012）
      const m = /省略 (\d+) 行 \/ (\d+) 字节/.exec(notice)!
      const joined = (a: unknown[]) => a.map((x) => JSON.stringify(x)).join('\n')
      expect(Number(m[1])).toBe(rawItems.length - kept.length)
      expect(Number(m[2])).toBe(
        Buffer.byteLength(joined(rawItems), 'utf8') - Buffer.byteLength(joined(kept), 'utf8'),
      )
      // 工具行「输出 N 行」= 实际交付行数（保留项 + 1 行标注），与截断同源
      expect(r.lines).toBe(kept.length + 1)
    } finally {
      rmSync(abs, { recursive: true, force: true })
    }
  })

  it('W-R2：未超限的数组结果不截断，但行数按"项 = 行"计（数组口径已声明）', async () => {
    const rel = 'executor-listdir-small-fixture'
    const abs = join(process.cwd(), rel)
    rmSync(abs, { recursive: true, force: true })
    mkdirSync(abs, { recursive: true })
    try {
      for (let i = 0; i < 7; i++) writeFileSync(join(abs, `f${i}`), '')
      const exec = executorOf([...TOOL_SPECS])
      const r = await exec.implementations.list_dir({ path: rel })
      const items = JSON.parse(r.content as string) as unknown[]
      expect(items).toHaveLength(7)
      expect(JSON.stringify(items)).not.toContain(TRUNCATION_MARK)
      expect(r.lines).toBe(7) // 修复前：整段 JSON 信封 1 行（W-R1）；数组口径声明后为项数
    } finally {
      rmSync(abs, { recursive: true, force: true })
    }
  })

  it('W-R2：错误形状（非数组）回落整段口径，行为不变', async () => {
    const exec = executorOf([...TOOL_SPECS])
    const r = await exec.implementations.list_dir({ path: '../evil' })
    expect(JSON.parse(r.content as string).error).toContain('非法路径')
    expect(r.lines).toBe(1) // 单行对象信封，与修复前一致
  })
})
