import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTools } from '../tools/index.js'
import { classifyToolResult } from '../tools/index.js'
import type { ContentPart } from '../tools/index.js'
import { BASELINE_DEFINITIONS, BASELINE_SHA256, BASELINE_TOOL_NAMES } from './definitions.baseline.js'
import { TOOL_SPECS } from './registry.js'
import { TaskManager } from '../tasks.js'
import { InteractionBroker } from '../interaction.js'
import { imageDir, MAX_IMAGE_BYTES } from '../images.js'
import { config } from '../config.js'

// view_image 的能力预检要连 Ollama /api/show，单测整体替换为可控假实现
vi.mock('../models.js', () => ({ getCapabilities: vi.fn() }))
import { getCapabilities } from '../models.js'

function tools() {
  return createTools().implementations
}

function parse(content: string): any {
  return JSON.parse(content)
}

/**
 * B1.3：工具结果分类（loop 兜底取 ok/行数/字节的唯一纯函数）。
 * 规则必须锁住：既有工具用 JSON 字符串表达成败，没有结构化 ok 字段。
 */
describe('工具：classifyToolResult（B1.3，loop 的 ok/行数/字节兜底）', () => {
  it('含 error 字段 → 失败，并带出 error 文案', () => {
    const r = classifyToolResult(JSON.stringify({ error: '读取失败: ENOENT' }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('读取失败')
  })

  it('bash 失败形状（exitCode≠0 且无 error 字段）→ 失败，error 取 stderr 首行', () => {
    const r = classifyToolResult(JSON.stringify({ exitCode: 127, stdout: '', stderr: 'not found\nmore' }))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('not found')
  })

  it('exitCode=0 → 成功', () => {
    expect(classifyToolResult(JSON.stringify({ exitCode: 0, stdout: 'hi' })).ok).toBe(true)
  })

  it('数组结果（glob/grep/list_dir）与普通对象（read/write）→ 成功', () => {
    expect(classifyToolResult(JSON.stringify([{ file: 'a.ts' }])).ok).toBe(true)
    expect(classifyToolResult(JSON.stringify({ path: 'a.ts', content: '错误这个词出现在正文里' })).ok).toBe(true)
  })

  it('非 JSON 文本（read_memory 的 markdown 索引）→ 成功，不误判', () => {
    const md = '# Memory Index\n- [x](y.md) — error handling'
    const r = classifyToolResult(md)
    expect(r.ok).toBe(true)
    expect(r.error).toBeUndefined()
  })

  it('行数/字节口径：行 = split("\\n") 元素数、字节 = utf8 字节数（与 D19 一致）', () => {
    const text = JSON.stringify({ a: '中' })
    const r = classifyToolResult(text)
    expect(r.outputLines).toBe(1)
    expect(r.outputBytes).toBe(Buffer.byteLength(text, 'utf8'))
    const multi = classifyToolResult('a\nb\nc')
    expect(multi.outputLines).toBe(3)
  })

  it('多模态数组（view_image 成功）→ 成功，且只统计文本部件（图片不计入）', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: '图片如下：' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]
    const r = classifyToolResult(parts)
    expect(r.ok).toBe(true)
    expect(r.outputLines).toBe(1)
    expect(r.outputBytes).toBe(Buffer.byteLength('图片如下：', 'utf8'))
  })
})

describe('工具：参数校验', () => {
  it('read 传非字符串 path 返回错误', async () => {
    const r = await tools().read({ path: 123 as any })
    expect(parse(r.content).error).toBeTruthy()
  })

  it('write 缺 content 返回错误', async () => {
    const r = await tools().write({ path: 'x.ts' } as any)
    expect(parse(r.content).error).toBeTruthy()
  })

  it('bash 空命令返回错误', async () => {
    const r = await tools().bash({ command: '   ' })
    expect(parse(r.content).error).toBeTruthy()
  })

  it('glob 空 pattern 返回错误', async () => {
    const r = await tools().glob({ pattern: '' })
    expect(parse(r.content).error).toBeTruthy()
  })

  it('grep 无效正则返回错误', async () => {
    const r = await tools().grep({ pattern: '([unclosed' })
    expect(parse(r.content).error).toBeTruthy()
  })
})

describe('工具：路径穿越防护', () => {
  it('拒绝访问项目根之外的路径', async () => {
    const r = await tools().read({ path: '../outside.txt' })
    expect(parse(r.content).error).toContain('非法路径')
  })

  it('拒绝绝对路径指向外部', async () => {
    const r = await tools().read({ path: '/etc/passwd' })
    expect(parse(r.content).error).toContain('非法路径')
  })

  it('项目内相对路径可读', async () => {
    const r = await tools().read({ path: 'src/config.ts' })
    const data = parse(r.content)
    expect(data.path).toBe('src/config.ts')
    expect(data.content).toContain('ollamaBaseUrl')
  })
})

describe('工具：危险命令拦截（compat 路径 fail-closed，D-2）', () => {
  // V-2（B7）：危险命令的判定已整体迁至 src/permissions.ts（唯一来源），bash.impl 无硬拦截。
  // 本 compat 入口（createTools()）没有审批消费者，走 compatFailClosedPolicy：forced 规则直接 deny。
  it('拦截 rm 根目录/家目录', async () => {
    const r = await tools().bash({ command: 'rm -rf /' })
    expect(parse(r.content).error).toContain('危险命令')
  })

  it('拦截 sudo', async () => {
    const r = await tools().bash({ command: 'sudo rm -rf /etc' })
    expect(parse(r.content).error).toContain('危险命令')
  })

  it('拦截关机/重启', async () => {
    const r = await tools().bash({ command: 'reboot' })
    expect(parse(r.content).error).toContain('危险命令')
  })

  it('普通命令不拦截', async () => {
    const r = await tools().bash({ command: 'echo hello' })
    const data = parse(r.content)
    expect(data.exitCode).toBe(0)
    expect(data.stdout).toContain('hello')
  })
})

describe('工具：memory 三件套', () => {
  let tmp: string
  let origEnv: string | undefined
  beforeEach(() => {
    // 隔离 AGENT_CLI_DIR，避免写真实 ~/.agent-cli/memory
    tmp = mkdtempSync(join(tmpdir(), 'agent-cli-tools-'))
    origEnv = process.env.AGENT_CLI_DIR
    process.env.AGENT_CLI_DIR = tmp
  })
  afterEach(() => {
    if (origEnv === undefined) delete process.env.AGENT_CLI_DIR
    else process.env.AGENT_CLI_DIR = origEnv
    rmSync(tmp, { recursive: true, force: true })
  })

  it('read_memory 无 topic 返回索引；有 topic 返回内容', async () => {
    const t = tools()
    await t.append_memory({ topic: 'preferences', content: '用户喜欢 Python' })
    const idx = await t.read_memory({})
    expect(idx.content).toContain('# Memory Index')
    expect(idx.content).toContain('用户喜欢 Python')
    const detail = await t.read_memory({ topic: 'preferences' })
    expect(detail.content).toContain('用户喜欢 Python')
  })

  it('append_memory 追加多条，索引反映', async () => {
    const t = tools()
    await t.append_memory({ topic: 'project', content: '约定一' })
    await t.append_memory({ topic: 'project', content: '约定二' })
    const idx = await t.read_memory({})
    expect(idx.content).toContain('约定一')
    expect(idx.content).toContain('约定二')
  })

  it('write_memory 覆盖旧内容', async () => {
    const t = tools()
    await t.append_memory({ topic: 'project', content: '旧内容' })
    await t.write_memory({ topic: 'project', content: '新内容' })
    const detail = await t.read_memory({ topic: 'project' })
    expect(detail.content).toContain('新内容')
    expect(detail.content).not.toContain('旧内容')
  })

  it('topic 非法被拒绝（路径穿越）', async () => {
    const t = tools()
    const r = await t.append_memory({ topic: '../outside', content: 'x' })
    expect(parse(r.content).error).toBeTruthy()
  })

  it('read_memory 不存在的 topic 返回错误', async () => {
    const r = await tools().read_memory({ topic: 'nonexistent' })
    expect(parse(r.content).error).toBeTruthy()
  })
})

describe('工具：view_image', () => {
  let tmp: string
  let origEnv: string | undefined

  /** 最小 PNG 字节串（内容不重要，只看路径校验/编码/返回结构） */
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const CAPS_VISION = { completion: true, vision: true, tools: true, thinking: true }
  const CAPS_NO_VISION = { completion: true, vision: false, tools: true, thinking: true }

  /** 设定能力探测结果（null 表示探测失败） */
  function mockCaps(v: unknown): void {
    vi.mocked(getCapabilities).mockResolvedValue(v as any)
  }

  /** 失败路径的 content 必为 JSON 文本；取出 error 字段 */
  function errorOf(r: { content: string | ContentPart[] }): string {
    expect(typeof r.content).toBe('string')
    return parse(r.content as string).error
  }

  /** 在图片目录里造一张真实存在的图片，返回其绝对路径 */
  function makeImage(name: string, bytes: Buffer = PNG_BYTES): string {
    const abs = join(imageDir(), name)
    writeFileSync(abs, bytes)
    return abs
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'agent-cli-view-image-'))
    origEnv = process.env.AGENT_CLI_DIR
    process.env.AGENT_CLI_DIR = tmp
    mkdirSync(imageDir(), { recursive: true })
    vi.mocked(getCapabilities).mockReset()
    mockCaps(CAPS_VISION)
  })

  afterEach(() => {
    if (origEnv === undefined) delete process.env.AGENT_CLI_DIR
    else process.env.AGENT_CLI_DIR = origEnv
    rmSync(tmp, { recursive: true, force: true })
  })

  it('拒绝项目根之外且不在图片目录的路径（../）', async () => {
    expect(errorOf(await tools().view_image({ path: '../outside.png' }))).toContain('非法路径')
  })

  it('拒绝绝对路径指向项目根之外', async () => {
    expect(errorOf(await tools().view_image({ path: '/etc/passwd.png' }))).toContain('非法路径')
  })

  it('拒绝相似前缀 images-evil/ 下的图片（精确目录匹配）', async () => {
    const evilDir = join(tmp, 'images-evil')
    mkdirSync(evilDir, { recursive: true })
    const target = join(evilDir, 'x.png')
    writeFileSync(target, PNG_BYTES)
    expect(errorOf(await tools().view_image({ path: target }))).toContain('非法路径')
  })

  it('~ 开头的路径按 agent-cli 基址展开（不会落回项目根内）', async () => {
    // 若未展开，`~/x.png` 会被 resolve 成「项目根/~/x.png」而通过白名单（随后报"图片不存在"）；
    // 报"非法路径"才说明确实展开成了基址（AGENT_CLI_DIR）下的路径。
    expect(errorOf(await tools().view_image({ path: '~/definitely-not-here.png' }))).toContain('非法路径')
  })

  it('设置 AGENT_CLI_DIR 后，图片目录内的 ~ 形式路径能通过白名单并被读取（I-5）', async () => {
    const target = makeImage('clip.png')
    const r = await tools().view_image({ path: '~/images/clip.png' })

    // 通过白名单（未报"非法路径"）且真的读到了图片
    const parts = r.content as ContentPart[]
    expect(Array.isArray(parts)).toBe(true)
    expect((parts[0] as { type: 'text'; text: string }).text).toContain(target)
    expect((parts[1] as { type: 'image_url'; image_url: { url: string } }).image_url.url).toBe(
      `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
    )
  })

  it('空/非字符串 path 返回错误', async () => {
    expect(errorOf(await tools().view_image({ path: '   ' }))).toBeTruthy()
    expect(errorOf(await tools().view_image({ path: 123 as any }))).toBeTruthy()
  })

  it(`拒绝超过 ${MAX_IMAGE_BYTES} 字节（10MB）的图片`, async () => {
    const big = makeImage('big.png', Buffer.alloc(MAX_IMAGE_BYTES + 1))
    expect(errorOf(await tools().view_image({ path: big }))).toContain('图片过大')
  })

  it('图片不存在时返回错误', async () => {
    expect(errorOf(await tools().view_image({ path: join(imageDir(), 'nope.png') }))).toContain('图片不存在')
  })

  it('当前模型无 vision 能力时预检失败，且不读取图片', async () => {
    mockCaps(CAPS_NO_VISION)
    // 路径合法且文件真实存在，仍因能力不足被拒 → 证明预检发生在读图之前
    const err = errorOf(await tools().view_image({ path: makeImage('ok.png') }))
    expect(err).toContain('vision')
    expect(err).toContain(config.chatModel)
  })

  it('能力探测失败（null）时同样拒绝，不静默放行', async () => {
    mockCaps(null)
    const err = errorOf(await tools().view_image({ path: makeImage('ok.png') }))
    expect(err).toContain('无法探测模型能力')
  })

  it('预检用注入的运行时模型，而非 config.chatModel（/model 切换后仍准确）', async () => {
    mockCaps(CAPS_NO_VISION)
    const impl = createTools({ currentModel: 'qwen3-vl:8b-thinking' }).implementations
    const err = errorOf(await impl.view_image({ path: makeImage('ok.png') }))

    expect(vi.mocked(getCapabilities)).toHaveBeenCalledWith('qwen3-vl:8b-thinking')
    expect(err).toContain('qwen3-vl:8b-thinking')
  })

  it('未注入 currentModel 时回落 config.chatModel（非交互单轮模式）', async () => {
    mockCaps(CAPS_NO_VISION)
    const err = errorOf(await tools().view_image({ path: makeImage('ok.png') }))

    expect(vi.mocked(getCapabilities)).toHaveBeenCalledWith(config.chatModel)
    expect(err).toContain(config.chatModel)
  })

  it('成功路径返回 ContentPart[]：text 说明 + image_url data URL', async () => {
    const target = makeImage('shot.png')
    const r = await tools().view_image({ path: target })

    expect(Array.isArray(r.content)).toBe(true)
    const parts = r.content as ContentPart[]
    expect(parts).toHaveLength(2)

    const [text, image] = parts
    expect(text.type).toBe('text')
    if (text.type === 'text') {
      expect(text.text).toContain(target)
      expect(text.text).toContain(`${PNG_BYTES.length} 字节`)
    }
    expect(image).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` },
    })
  })

  it('项目根内的相对路径也可读', async () => {
    const rel = 'view-image-fixture.png'
    writeFileSync(join(process.cwd(), rel), PNG_BYTES)
    try {
      const r = await tools().view_image({ path: rel })
      const parts = r.content as ContentPart[]
      expect(Array.isArray(parts)).toBe(true)
      // 项目内路径回显相对路径
      expect((parts[0] as { type: 'text'; text: string }).text).toContain(rel)
    } finally {
      rmSync(join(process.cwd(), rel), { force: true })
    }
  })
})

/**
 * AC-41：由元数据生成的 OpenAI function definitions 与重构前逐字段一致。
 *
 * 口径演进（**每次变更都显式记录并收紧，不静默放宽**）：
 * - B2/D-4：基线 = 重构前的 **12** 个工具；断言「前 12 项逐字深相等 + 名字序列一致 + 新工具追加末尾」。
 * - B3：末尾追加 `ask_user`。
 * - B6：FR-2 **有意**给 `bash` 增加 `run_in_background`（design L720），因此前 12 项中 `bash` 的
 *   `parameters` 必然变化，而 `definitions.baseline.ts` 是**冻结的重构前快照、不得修改** —— 字面
 *   意义上的"前 12 项逐字深相等"与 FR-2 不可兼得。处理方式是把"逐字"拆成**两条更精确**的断言
 *   （而不是放弃它）：
 *   ① 除 `bash` 外的 **11 项**与原基线**字节级**相同（`JSON.stringify` 比对 —— 连键序变化都会被抓到）；
 *   ② `bash` 与基线的差异**恰好**是 `parameters.properties.run_in_background`，其余字段逐字不变。
 *   于是"搬迁重构出错"仍会被发现，B6 的增参则是被逐字段锁定的**显式**变更。
 * 另保留：基线快照自身的 sha256 完整性、名字序列（12 + 追加序）、追加项只在末尾、会话内字节恒定。
 */
describe('工具：AC-41 definitions 基线回归（B6 起 bash 有一个显式增参）', () => {
  const baselineCount = BASELINE_DEFINITIONS.length
  /** B6/FR-2 有意增参的工具（差异被断言 ③ 逐字段锁定） */
  const B6_CHANGED = 'bash'
  const unchangedNames = BASELINE_TOOL_NAMES.filter((n) => n !== B6_CHANGED)
  /** B3/B6 追加在末尾的新工具（顺序固化） */
  const APPENDED_TOOL_NAMES = ['ask_user', 'bash_output', 'kill_task']

  type DefParams = { type: string; properties: Record<string, unknown>; required?: string[] }
  type AnyDef = { type: string; function: { name: string; description: string; parameters: DefParams } }
  const byName = (defs: readonly { function: { name: string } }[], name: string) =>
    defs.find((d) => d.function.name === name)! as unknown as AnyDef

  it('① 基线快照自身完整（sha256 一致、12 项非空，防止基线被悄悄改写）', () => {
    const h = createHash('sha256').update(JSON.stringify(BASELINE_DEFINITIONS)).digest('hex')
    expect(h).toBe(BASELINE_SHA256)
    expect(baselineCount).toBe(12)
    expect(BASELINE_TOOL_NAMES).toHaveLength(12)
    expect(BASELINE_SHA256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('② 重构未改动的前 11 项与基线字节级相同（含键序）', () => {
    const actual = createTools()
      .definitions.slice(0, baselineCount)
      .filter((d) => d.function.name !== B6_CHANGED)
    const expected = BASELINE_DEFINITIONS.filter((d) => d.function.name !== B6_CHANGED)
    expect(actual.map((d) => d.function.name)).toEqual([...unchangedNames])
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
  })

  it('③ bash 的差异恰好是新增 run_in_background（其余字段与基线逐字一致）', () => {
    const actual = byName(createTools().definitions, B6_CHANGED)
    const base = byName(BASELINE_DEFINITIONS, B6_CHANGED)
    expect(actual.function.name).toBe('bash')
    expect(actual.function.description).toBe(base.function.description)
    expect(actual.type).toBe(base.type)

    const a = actual.function.parameters as unknown as DefParams
    const b = base.function.parameters as unknown as DefParams
    expect(a.type).toBe(b.type)
    expect(a.required).toEqual(b.required)
    // 键序：command 仍在首位（前缀/字节稳定），新参数追加在其后
    expect(Object.keys(a.properties)).toEqual(['command', 'run_in_background'])
    expect(a.properties.command).toEqual(b.properties.command)
    const rb = a.properties.run_in_background as Record<string, unknown>
    expect(Object.keys(rb)).toEqual(['type', 'description'])
    expect(rb.type).toBe('boolean')
    expect(typeof rb.description).toBe('string')
  })

  it('④ 名字序列 = 基线 12 项（顺序不变）+ 追加项（顺序固化）', () => {
    const names = createTools().definitions.map((d) => d.function.name)
    expect(names.slice(0, baselineCount)).toEqual([...BASELINE_TOOL_NAMES])
    expect(names.slice(baselineCount)).toEqual(APPENDED_TOOL_NAMES)
    expect(names).toHaveLength(baselineCount + APPENDED_TOOL_NAMES.length)
  })

  it('⑤ 追加项只出现在末尾（前 12 项的位置未被插队）', () => {
    const defs = createTools().definitions
    expect(defs.slice(0, baselineCount).map((d) => d.function.name)).toEqual([...BASELINE_TOOL_NAMES])
    for (const n of APPENDED_TOOL_NAMES) {
      expect(defs.findIndex((d) => d.function.name === n)).toBeGreaterThanOrEqual(baselineCount)
    }
    // TOOL_SPECS 与 definitions 同序（同源）
    expect(createTools().definitions.map((d) => d.function.name)).toEqual(TOOL_SPECS.map((s) => s.meta.name))
  })

  it('⑥ 同一会话内 definitions 字节恒定（前缀缓存 44× 的生命线）', () => {
    expect(JSON.stringify(createTools().definitions)).toBe(JSON.stringify(createTools().definitions))
  })
})

/** 递归收集 src/ 下的源码文件（排除测试文件与 fixtures：避免断言被自身字符串命中） */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '__fixtures__') continue
      collectSourceFiles(abs, out)
    } else if (e.isFile() && /\.(ts|tsx|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.test.ts')) {
      out.push(abs)
    }
  }
  return out
}

/** AC-63 要拦的标识（外部协议工具源的通用缩写） */
const BANNED_SOURCE_TOKEN = /\bmcp\b/i

/**
 * 去掉行注释与整行块注释：AC-63 查的是**代码**，不是文案。
 * 不这么做的话，"注释里说明某技术已移出本轮范围"会被当成"引入了该技术"（本用例第一次运行
 * 就是被 registry.ts 的一句说明命中而误报）。
 */
function stripComment(line: string): string {
  if (/^\s*(\*|\/\*)/.test(line)) return ''
  const i = line.indexOf('//')
  return i >= 0 ? line.slice(0, i) : line
}

/**
 * AC-63：本轮不引入外部协议工具源（D34 已把它移出整个 005 轮次）。
 * 两条断言：① `src/` 的**代码**（非注释）里无该标识；② 工具元数据 `source` 只有 `builtin`。
 */
describe('AC-63：不引入外部协议工具源，source 只有 builtin', () => {
  it('src/ 内（排除测试文件与 fixtures、且只查代码不查注释）无该标识', () => {
    const hits: string[] = []
    for (const f of collectSourceFiles(join(process.cwd(), 'src'))) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (BANNED_SOURCE_TOKEN.test(stripComment(line))) hits.push(`${f}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(hits).toEqual([])
  })

  it('全部内置工具的 meta.source 只有 builtin 一个取值', () => {
    expect(new Set(TOOL_SPECS.map((s) => s.meta.source))).toEqual(new Set(['builtin']))
  })
})

/**
 * FR-2：`bash` 的 `run_in_background` 与两个管理工具（AC-7 / AC-8 / AC-9 / AC-14）。
 *
 * 本块走**工具层**（参数校验、错误形状、越权回归）；进程组语义与"真的没有孤儿"在
 * `src/tasks.test.ts` 的**真实 spawn 冒烟**里验证（lesson 011 / D-8：注入式单测无法证明
 * 孙子进程被收掉）。两类测试互补，不能互相替代。
 */
describe('工具：FR-2 后台任务三件套（bash.run_in_background / bash_output / kill_task）', () => {
  let tmpDir: string
  let origEnv: string | undefined
  let mgr: TaskManager

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-cli-bgtools-'))
    origEnv = process.env.AGENT_CLI_DIR
    process.env.AGENT_CLI_DIR = tmpDir
    mgr = new TaskManager({ cwd: process.cwd() })
  })
  afterEach(async () => {
    await mgr.killAll().catch(() => {})
    if (origEnv === undefined) delete process.env.AGENT_CLI_DIR
    else process.env.AGENT_CLI_DIR = origEnv
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const withTasks = () => createTools({ tasks: mgr }).implementations

  /**
   * 等任务日志文件出现（= `createWriteStream` 的**异步 open 已完成**）。
   *
   * 背景（B6 遗留的测试竞态，本批 V-8 用例踩到）：`afterEach` 的顺序是
   * `killAll() → rmSync(临时目录)`，而日志流是异步 open。若用例在 open 完成前就结束，
   * `rmSync` 会让尚未完成的 open 以 `ENOENT` 报错，而 `WriteStream` 上没有 `error` 监听 →
   * vitest 记为 Unhandled Error（整轮 EXIT 1，尽管 566 条全绿）。本用例是"起完就结束"的
   * 最短路径，故显式等一次；超时不断言（日志落盘不是本用例的断言点）。
   */
  async function waitForLogFile(file: string, timeoutMs = 2000): Promise<void> {
    const start = Date.now()
    while (!existsSync(file) && Date.now() - start < timeoutMs) {
      await new Promise((res) => setTimeout(res, 5))
    }
  }

  it('AC-7：run_in_background → 1s 内返回 {task_id,pid,running:true}，进程仍在', async () => {
    const t0 = Date.now()
    const r = await withTasks().bash({ command: 'sleep 30', run_in_background: true })
    expect(Date.now() - t0).toBeLessThan(1000)

    const data = parse(r.content)
    expect(data.task_id).toMatch(/^task-[a-z0-9-]+$/)
    expect(data.pid).toBeGreaterThan(0)
    expect(data.running).toBe(true)
    expect(mgr.get(data.task_id)!.state).toBe('running')
    // 工具结果自身判为成功（否则工具行会显示 ✗）
    expect(r.ok).toBe(true)
  })

  it('AC-8：bash_output 返回增量与 running 标注；wait_ms 能等到新输出', async () => {
    const started = parse(
      (
        await withTasks().bash({
          command: `printf 'first\\n'; sleep 0.4; printf 'second\\n'; sleep 30`,
          run_in_background: true,
        })
      ).content,
    )
    const t = withTasks()

    const first = parse((await t.bash_output({ task_id: started.task_id, wait_ms: 300 })).content)
    expect(first.output).toContain('first')
    expect(first.running).toBe(true)
    expect(first.exit_code).toBeNull()

    const second = parse((await t.bash_output({ task_id: started.task_id, wait_ms: 3000 })).content)
    expect(second.output).toContain('second')
    expect(second.output).not.toContain('first') // 增量：不重发
    expect(second.running).toBe(true)
  })

  it('AC-9：kill_task 终止目标；重复 kill 返回 already_exited 且不抛', async () => {
    const started = parse((await withTasks().bash({ command: 'sleep 30', run_in_background: true })).content)
    const t = withTasks()

    const k1 = parse((await t.kill_task({ task_id: started.task_id })).content)
    expect(k1).toEqual({ task_id: started.task_id, killed: true, already_exited: false })
    expect(mgr.get(started.task_id)!.state).toBe('killed')

    const k2 = parse((await t.kill_task({ task_id: started.task_id })).content)
    expect(k2).toEqual({ task_id: started.task_id, killed: false, already_exited: true })
  })

  it('越权回归：task_id 含 ../ 或绝对路径一律"未找到任务"（只查 Map，绝不拼路径）', async () => {
    const t = withTasks()
    for (const bad of ['../escape', 'task-1-0/../../etc/passwd', '/etc/passwd', 'task-x', '../../tmp/x']) {
      expect(parse((await t.bash_output({ task_id: bad })).content).error).toContain('未找到任务')
      expect(parse((await t.kill_task({ task_id: bad })).content).error).toContain('未找到任务')
    }
  })

  it('参数校验：task_id 非字符串/空 → 明确错误', async () => {
    const t = withTasks()
    for (const bad of [undefined, '', 123]) {
      expect(parse((await t.bash_output({ task_id: bad as any })).content).error).toBeTruthy()
      expect(parse((await t.kill_task({ task_id: bad as any })).content).error).toBeTruthy()
    }
  })

  it('未装配 TaskManager（compat 路径）时三个入口都 fail-closed，不静默成功', async () => {
    const t = createTools().implementations
    expect(parse((await t.bash({ command: 'echo hi', run_in_background: true })).content).error).toContain(
      '不支持后台任务',
    )
    expect(parse((await t.bash_output({ task_id: 'task-1-0' })).content).error).toContain('不支持后台任务')
    expect(parse((await t.kill_task({ task_id: 'task-1-0' })).content).error).toContain('不支持后台任务')
  })

  /**
   * V-8（用户拍板 2026-09-17）：单轮（非交互）模式**显式拒绝**后台任务。
   *
   * 与"未装配 TaskManager"是两条不同的路径：这里注入了真实 `TaskManager`，
   * 仅凭 `InteractionBroker.interactive === false` 就拒绝 —— 证明"非交互"这层门禁
   * 优先于"有没有任务管理器"，单轮不会留下无人回收的孤儿进程。
   */
  it('V-8：非交互（单轮）模式 + 已注入 TaskManager → 仍拒绝，返回结构化错误且不起进程', async () => {
    const broker = new InteractionBroker(null, { interactive: false, autoAccept: false })
    const t = createTools({ tasks: mgr, interaction: broker }).implementations

    const r = await t.bash({ command: 'sleep 30', run_in_background: true })
    expect(parse(r.content).error).toContain('后台任务需要交互模式')
    expect(mgr.size).toBe(0) // 没有真的起进程（否则退出时无人回收）
  })

  it('V-8 反证：交互模式下同一调用照常启动后台任务（门禁只挡非交互）', async () => {
    const broker = new InteractionBroker(null, { interactive: true, autoAccept: false })
    const t = createTools({ tasks: mgr, interaction: broker }).implementations

    const r = parse((await t.bash({ command: 'sleep 30', run_in_background: true })).content)
    expect(r.task_id).toMatch(/^task-[a-z0-9-]+$/)
    expect(r.running).toBe(true)
    expect(mgr.size).toBe(1)

    // 等日志流 open 完成再结束（见 waitForLogFile 的注释：否则 afterEach 的 rmSync 会触发 ENOENT 竞态）
    await waitForLogFile(join(tmpDir, 'tasks', `${r.task_id}.log`))
  })

  it('危险命令在 compat 路径仍直接拒绝（V-2 后：forced 规则 deny，run_in_background 不能绕过）', async () => {
    const r = await withTasks().bash({ command: 'sudo rm -rf /etc', run_in_background: true })
    expect(parse(r.content).error).toContain('危险命令')
    expect(mgr.size).toBe(0) // 没有真的起进程
  })

  it('前台 bash 不受影响：run_in_background 缺省/false 都是同步执行，不产生任务', async () => {
    const t = withTasks()
    const a = parse((await t.bash({ command: 'echo fg' })).content)
    expect(a.exitCode).toBe(0)
    expect(a.stdout).toContain('fg')
    expect(a.task_id).toBeUndefined()

    const b = parse((await t.bash({ command: 'echo fg2', run_in_background: false })).content)
    expect(b.exitCode).toBe(0)
    expect(mgr.size).toBe(0)
  })
})

/**
 * AC-14：前台 bash 的 60s 超时与 AbortSignal 行为与改动前一致（回归）。
 * 真等 60s 不现实 → 临时调小 `config.bashTimeoutMs`，证明"超时确实由该配置驱动"（而非被偷偷去掉）。
 */
describe('工具：AC-14 前台 bash 超时行为不回归', () => {
  it('超时由 config.bashTimeoutMs 驱动：调小后长命令以非 0 退出码返回', async () => {
    const orig = config.bashTimeoutMs
    config.bashTimeoutMs = 300
    try {
      const r = parse((await tools().bash({ command: 'sleep 5' })).content)
      expect(r.exitCode).not.toBe(0)
    } finally {
      config.bashTimeoutMs = orig
    }
  })

  it('前台返回形状未变：{exitCode,stdout,stderr}，且 cwd = 项目根', async () => {
    const r = parse((await tools().bash({ command: 'pwd' })).content)
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(process.cwd())
    expect(r.stderr).toBe('')
  })
})
