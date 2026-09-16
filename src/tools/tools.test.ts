import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTools } from '../tools/index.js'
import type { ContentPart } from '../tools/index.js'
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

describe('工具：危险命令拦截', () => {
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
