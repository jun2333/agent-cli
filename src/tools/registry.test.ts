import { describe, it, expect } from 'vitest'
import {
  buildDefinitions,
  toDefinition,
  TOOL_SPECS,
  type ToolMeta,
  type ToolSource,
} from './registry.js'
import { BASELINE_TOOL_NAMES } from './definitions.baseline.js'

/**
 * AC-38：工具注册表暴露统一元数据，全部内置工具登记且字段完整。
 * 验证方式：单测遍历 `TOOL_SPECS`。
 */
describe('工具注册表：AC-38 元数据完整性与登记完备性', () => {
  it('登记了全部内置工具（数量与名字序列与重构前一致，顺序锁定）', () => {
    expect(TOOL_SPECS.length).toBeGreaterThanOrEqual(BASELINE_TOOL_NAMES.length)
    expect(TOOL_SPECS.slice(0, BASELINE_TOOL_NAMES.length).map((s) => s.meta.name)).toEqual([
      ...BASELINE_TOOL_NAMES,
    ])
  })

  it('工具名全局唯一（不允许重复登记）', () => {
    const names = TOOL_SPECS.map((s) => s.meta.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('每个 spec 的元数据字段齐全且类型正确', () => {
    for (const spec of TOOL_SPECS) {
      const m = spec.meta
      expect(typeof m.name).toBe('string')
      expect(m.name.length).toBeGreaterThan(0)
      expect(typeof m.description).toBe('string')
      expect(m.description.length).toBeGreaterThan(0)
      expect(typeof m.parameters).toBe('object')
      expect((m.parameters as { type?: unknown }).type).toBe('object')
      expect(typeof m.mutating).toBe('boolean')
      expect(typeof m.requiresApproval).toBe('boolean')
      expect(typeof m.backgroundable).toBe('boolean')
      expect(m.source).toBe('builtin')
      expect(typeof spec.impl).toBe('function')
      if (m.paramRules !== undefined) {
        expect(Array.isArray(m.paramRules)).toBe(true)
        for (const r of m.paramRules) {
          expect(typeof r.id).toBe('string')
          expect(typeof r.test).toBe('function')
          expect(typeof r.requiresApproval).toBe('boolean')
          expect(typeof r.reason).toBe('string')
        }
      }
    }
  })

  it('source 的类型层面只有一个取值（AC-63）', () => {
    // 编译期约束：'builtin' 之外的值无法赋给 ToolSource（本行若被改成第二个取值会 tsc 失败）
    const only: ToolSource = 'builtin'
    expect(only).toBe('builtin')
    expect(new Set(TOOL_SPECS.map((s) => s.meta.source))).toEqual(new Set(['builtin']))
  })

  it('元数据取值符合工具语义（读写/审批/后台能力）', () => {
    const byName = new Map(TOOL_SPECS.map((s) => [s.meta.name, s.meta]))
    const meta = (n: string): ToolMeta => {
      const m = byName.get(n)
      expect(m, `工具 ${n} 必须已登记`).toBeTruthy()
      return m as ToolMeta
    }

    // 只读工具：不改变状态、不触发审批
    for (const n of ['read', 'list_dir', 'glob', 'grep', 'web_search', 'view_image', 'read_memory']) {
      expect(meta(n).mutating).toBe(false)
      expect(meta(n).requiresApproval).toBe(false)
      expect(meta(n).backgroundable).toBe(false)
    }
    // 写类工具：改变状态且需审批（FR-6 的 default 模式依据）
    for (const n of ['write', 'edit']) {
      expect(meta(n).mutating).toBe(true)
      expect(meta(n).requiresApproval).toBe(true)
    }
    // bash：写、需审批、且是唯一可后台运行的
    expect(meta('bash').mutating).toBe(true)
    expect(meta('bash').requiresApproval).toBe(true)
    expect(meta('bash').backgroundable).toBe(true)
    expect(TOOL_SPECS.filter((s) => s.meta.backgroundable).map((s) => s.meta.name)).toEqual(['bash'])
    // 记忆写入：改变状态（plan 模式拒绝），但不需要审批（写在 ~/.agent-cli，用户显式授权）
    for (const n of ['append_memory', 'write_memory']) {
      expect(meta(n).mutating).toBe(true)
      expect(meta(n).requiresApproval).toBe(false)
    }
    // ask_user（B3 追加）：只读语义（交互不改任何状态）→ plan 模式也允许问；不审批、不可后台
    expect(meta('ask_user').mutating).toBe(false)
    expect(meta('ask_user').requiresApproval).toBe(false)
    expect(meta('ask_user').backgroundable).toBe(false)
    // bash_output（B6 追加）：只读（读缓冲），不审批、不可后台
    expect(meta('bash_output').mutating).toBe(false)
    expect(meta('bash_output').requiresApproval).toBe(false)
    expect(meta('bash_output').backgroundable).toBe(false)
    // kill_task（B6 追加）：会终止进程（mutating）→ plan 模式被拒；但不需要审批（紧急停机不该被卡住）
    expect(meta('kill_task').mutating).toBe(true)
    expect(meta('kill_task').requiresApproval).toBe(false)
    expect(meta('kill_task').backgroundable).toBe(false)
    // bash 的 run_in_background 参数已登记（FR-2/AC-7 的入口）
    const bashParams = meta('bash').parameters as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(bashParams.properties)).toEqual(['command', 'run_in_background'])
    expect(bashParams.required).toEqual(['command'])
  })
})

/**
 * AC-41 的"同源"保证（另一半在 `tools.test.ts` 的基线回归）：
 * definitions 由元数据纯函数生成，不存在第二份 schema；且**只**取 name/description/parameters
 * （元数据里其余字段不得泄漏进注入 LLM 的 schema —— 那会改变请求字节）。
 */
describe('工具注册表：definitions 与元数据同源（AC-41 机制）', () => {
  it('toDefinition 只取 meta 的 name/description/parameters，不泄漏其余字段', () => {
    const meta: ToolMeta = {
      name: 'fake',
      description: '假工具',
      parameters: { type: 'object', properties: {} },
      mutating: true,
      requiresApproval: true,
      backgroundable: true,
      source: 'builtin',
      paramRules: [{ id: 'r', test: () => true, requiresApproval: true, reason: 'x' }],
    }
    expect(toDefinition(meta)).toEqual({
      type: 'function',
      function: { name: 'fake', description: '假工具', parameters: { type: 'object', properties: {} } },
    })
    // 键序稳定（键序变化会改变请求体字节 → 破坏前缀缓存）
    expect(Object.keys(toDefinition(meta).function)).toEqual(['name', 'description', 'parameters'])
    expect(Object.keys(toDefinition(meta))).toEqual(['type', 'function'])
  })

  it('buildDefinitions 是纯函数：同一 specs 多次调用深相等且字节相等', () => {
    const a = buildDefinitions()
    const b = buildDefinitions()
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.map((d) => d.function.name)).toEqual(TOOL_SPECS.map((s) => s.meta.name))
    expect(a.length).toBe(TOOL_SPECS.length)
  })

  it('注入自定义 specs 时 definitions 随之变化（证明是"由元数据生成"而非硬编码）', () => {
    const defs = buildDefinitions([
      {
        meta: {
          name: 'only',
          description: '只有一个',
          parameters: { type: 'object', properties: {} },
          mutating: false,
          requiresApproval: false,
          backgroundable: false,
          source: 'builtin',
        },
        impl: async () => ({ content: '{}' }),
      },
    ])
    expect(defs).toEqual([
      {
        type: 'function',
        function: { name: 'only', description: '只有一个', parameters: { type: 'object', properties: {} } },
      },
    ])
  })
})
