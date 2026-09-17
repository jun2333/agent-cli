/**
 * commands.test.ts — FR-4 的纯逻辑（AC-19 候选集合 / AC-20 过滤 + 注册表容错）
 *
 * 只测纯函数/纯类：不碰 stdin/stdout、不起 TUI（键位与渲染在 completion-menu.test.ts /
 * tui.e2e.test.ts）。AC-23（技能候选）不在此文件，因为它依赖 FR-10（P4）。
 */
import { describe, it, expect } from 'vitest'
import {
  CompletionRegistry,
  builtinCandidates,
  createBuiltinSource,
  filterCandidates,
  type CommandSpec,
  type CompletionCandidate,
  type CompletionSource,
} from './commands.js'

/** 与 index.ts 的既有 6 命令同形（B5 时点；B6~B8 会逐批追加） */
const SPECS: CommandSpec[] = [
  { name: '/exit', description: '退出（会清屏）', run: () => {} },
  { name: '/quit', description: '退出（会清屏）', run: () => {} },
  { name: '/clear', description: '重开会话（清屏）', run: () => {} },
  { name: '/help', description: '显示帮助', run: () => {} },
  { name: '/memory', description: '查看记忆索引', run: () => {} },
  { name: '/model', description: '切换模型与思考等级', run: () => {} },
]

const c = (label: string, kind: CompletionCandidate['kind'] = 'other'): CompletionCandidate => ({ label, kind })

describe('AC-19：内置候选集合由命令规格单源生成', () => {
  it('候选 = 全部内置命令，名字与顺序与命令表逐个一致', () => {
    const cands = builtinCandidates(SPECS)
    expect(cands.map((x) => x.label)).toEqual(SPECS.map((s) => s.name))
    expect(cands.map((x) => x.detail)).toEqual(SPECS.map((s) => s.description))
  })

  it('候选 kind 全部为 builtin（source 语义：本轮只有内置源）', () => {
    expect(builtinCandidates(SPECS).every((x) => x.kind === 'builtin')).toBe(true)
  })

  it('内置源 id 固定为 builtin，list() 可同步返回且内容与规格同源', () => {
    const src = createBuiltinSource(SPECS)
    expect(src.id).toBe('builtin')
    const items = src.list()
    expect(Array.isArray(items)).toBe(true)
    expect((items as CompletionCandidate[]).map((x) => x.label)).toEqual(SPECS.map((s) => s.name))
  })

  it('候选集合覆盖全部 6 个内置命令（空 `/` 时列全部）', () => {
    const labels = filterCandidates(builtinCandidates(SPECS), '').map((x) => x.label)
    expect(labels).toEqual(['/exit', '/quit', '/clear', '/help', '/memory', '/model'])
  })
})

describe('AC-20：filterCandidates 前缀优先 + 子序列模糊（稳定序）', () => {
  const all = [c('/alpha'), c('/alps'), c('/alto'), c('/beta'), c('/delta'), c('/theta')]

  it('空查询原样返回全部（顺序不变）', () => {
    expect(filterCandidates(all, '').map((x) => x.label)).toEqual(all.map((x) => x.label))
    // 也接受 `/` 前缀形式的查询
    expect(filterCandidates(all, '/').map((x) => x.label)).toEqual(all.map((x) => x.label))
  })

  it('前缀命中优先于子序列命中（两组内部保持原顺序）', () => {
    const got = filterCandidates(all, 'al').map((x) => x.label)
    // 前缀组：alpha/alps/alto；子序列组：delta(l…? 无 l 后有 a? delta: d-e-l-t-a → 'a' 在 l 之前 → 不匹配)
    expect(got).toEqual(['/alpha', '/alps', '/alto'])
  })

  it('子序列模糊命中（不连续也算）', () => {
    expect(filterCandidates(all, 'dt').map((x) => x.label)).toEqual(['/delta'])
    expect(filterCandidates(all, 'lta').map((x) => x.label)).toEqual(['/delta'])
  })

  it('子序列命中排在全部前缀命中之后', () => {
    // 前缀组：theta；模糊组（原顺序）：alto / beta / delta（都含 t，但都不以 t 开头）
    const got = filterCandidates(all, 't').map((x) => x.label)
    expect(got).toEqual(['/theta', '/alto', '/beta', '/delta'])
  })

  it('大小写不敏感，且查询/候选的前导 `/` 都不影响匹配', () => {
    expect(filterCandidates(all, 'AL').map((x) => x.label)).toEqual(['/alpha', '/alps', '/alto'])
    expect(filterCandidates([c('Alpha')], 'al')).toHaveLength(1)
    expect(filterCandidates([c('/Alpha')], '/al')).toHaveLength(1)
  })

  it('无匹配返回空数组（调用方渲染占位行）', () => {
    expect(filterCandidates(all, 'zzz')).toEqual([])
  })

  it('不修改入参数组（纯函数）', () => {
    const before = all.map((x) => x.label)
    filterCandidates(all, 'al')
    expect(all.map((x) => x.label)).toEqual(before)
  })

  it('渐进过滤：10 → 3 → 1（供 V-5 固定高度断言复用同一数据形状）', () => {
    const many = [c('/a1'), c('/a2'), c('/a3'), c('/b1'), c('/b2'), c('/b3'), c('/b4'), c('/b5'), c('/b6'), c('/b7')]
    expect(filterCandidates(many, '')).toHaveLength(10)
    expect(filterCandidates(many, 'a').map((x) => x.label)).toEqual(['/a1', '/a2', '/a3'])
    expect(filterCandidates(many, 'a1').map((x) => x.label)).toEqual(['/a1'])
    expect(filterCandidates(many, 'a9')).toHaveLength(0)
  })
})

describe('CompletionRegistry：多源聚合与容错（AC-23 的扩展点形状）', () => {
  const sync = (id: string, labels: string[]): CompletionSource => ({
    id,
    list: () => labels.map((l) => c(l, 'skill')),
  })

  it('按注册顺序聚合，源内部顺序保留', async () => {
    const r = new CompletionRegistry()
    r.register(sync('builtin', ['/exit', '/help']))
    r.register(sync('skills', ['/review', '/deploy']))
    expect((await r.collect()).map((x) => x.label)).toEqual(['/exit', '/help', '/review', '/deploy'])
    expect(r.size).toBe(2)
  })

  it('异步源可用（P4 扫磁盘的形状）', async () => {
    const r = new CompletionRegistry()
    r.register({ id: 'async', list: async () => [c('/async', 'skill')] })
    expect((await r.collect()).map((x) => x.label)).toEqual(['/async'])
  })

  it('单个源同步抛错 → 跳过该源，其余源仍返回', async () => {
    const r = new CompletionRegistry()
    r.register({
      id: 'boom',
      list: () => {
        throw new Error('扫盘失败')
      },
    })
    r.register(sync('builtin', ['/help']))
    expect((await r.collect()).map((x) => x.label)).toEqual(['/help'])
  })

  it('单个源异步 reject → 跳过该源，其余源仍返回', async () => {
    const r = new CompletionRegistry()
    r.register({ id: 'reject', list: async () => Promise.reject(new Error('nope')) })
    r.register(sync('builtin', ['/help']))
    expect((await r.collect()).map((x) => x.label)).toEqual(['/help'])
  })

  it('unregister 摘除源；同 id 重复注册 = 替换（不会产生重复候选）', async () => {
    const r = new CompletionRegistry()
    r.register(sync('skills', ['/one']))
    r.register(sync('skills', ['/two']))
    expect(r.size).toBe(1)
    expect((await r.collect()).map((x) => x.label)).toEqual(['/two'])
    r.unregister('skills')
    expect(await r.collect()).toEqual([])
    expect(r.size).toBe(0)
  })

  it('无源时 collect() 返回空数组（TUI 因此不弹空菜单）', async () => {
    expect(await new CompletionRegistry().collect()).toEqual([])
  })
})
