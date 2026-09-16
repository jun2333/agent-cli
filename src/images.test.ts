import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  utimesSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  imageDir,
  saveImage,
  imageToDataUrl,
  resolveImagePath,
  cleanupImages,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
} from './images.js'

let tmp: string
let origEnv: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-cli-images-'))
  origEnv = process.env.AGENT_CLI_DIR
  process.env.AGENT_CLI_DIR = tmp
})

afterEach(() => {
  if (origEnv === undefined) delete process.env.AGENT_CLI_DIR
  else process.env.AGENT_CLI_DIR = origEnv
  rmSync(tmp, { recursive: true, force: true })
})

/** 造一个最小 PNG 字节串（内容不重要，只看落盘/编码行为） */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 项目根内唯一的软链路径。
 * 「项目根内的软链」无法用 tmp 目录模拟（projectRoot = process.cwd()），只能在仓库根造，
 * 故用例内必须 try/finally 删除，避免残留污染仓库。
 */
let linkSeq = 0
function repoLinkPath(): string {
  linkSeq += 1
  return join(process.cwd(), `.agent-cli-test-link-${process.pid}-${linkSeq}.png`)
}

describe('images：图片目录', () => {
  it('imageDir 指向 AGENT_CLI_DIR/images', () => {
    expect(imageDir()).toBe(join(tmp, 'images'))
  })
})

describe('images：保存', () => {
  it('saveImage 落盘并返回时间戳文件名', () => {
    const r = saveImage(PNG_BYTES)
    expect(r.name).toMatch(/^\d{8}-\d{6}-\d{3}\.png$/)
    expect(r.path).toBe(join(imageDir(), r.name))
    expect(existsSync(r.path)).toBe(true)
  })

  it('saveImage 自动创建图片目录', () => {
    expect(existsSync(imageDir())).toBe(false)
    saveImage(PNG_BYTES)
    expect(existsSync(imageDir())).toBe(true)
  })

  it('saveImage 支持自定义扩展名（无点号也接受）', () => {
    expect(saveImage(PNG_BYTES, 'jpg').name.endsWith('.jpg')).toBe(true)
    expect(saveImage(PNG_BYTES, '.webp').name.endsWith('.webp')).toBe(true)
  })

  it('saveImage 非法扩展名回退 .png，且不会逃出图片目录', () => {
    const r = saveImage(PNG_BYTES, '../../evil')
    expect(r.name.endsWith('.png')).toBe(true)
    expect(r.path.startsWith(imageDir() + '/')).toBe(true)
    expect(existsSync(r.path)).toBe(true)
  })
})

describe('images：data URL 编码', () => {
  it('imageToDataUrl 返回 data:image/png;base64,... 与字节数', () => {
    const r = saveImage(PNG_BYTES)
    const enc = imageToDataUrl(r.path)
    expect(enc.ok).toBe(true)
    if (!enc.ok) return
    expect(enc.url).toBe(`data:image/png;base64,${PNG_BYTES.toString('base64')}`)
    expect(enc.bytes).toBe(PNG_BYTES.length)
  })

  it('按扩展名推断 MIME（.jpg → image/jpeg）', () => {
    const r = saveImage(PNG_BYTES, 'jpg')
    const enc = imageToDataUrl(r.path)
    expect(enc.ok && enc.url.startsWith('data:image/jpeg;base64,')).toBe(true)
  })

  it('文件不存在返回错误', () => {
    const r = imageToDataUrl(join(imageDir(), 'nope.png'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('图片不存在')
  })

  it(`超过 ${MAX_IMAGE_BYTES} 字节上限时拒绝`, () => {
    const big = join(tmp, 'big.png')
    writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 1))
    const r = imageToDataUrl(big)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('图片过大')
  })

  it('恰好等于上限时通过（边界含等号）', () => {
    const edge = join(tmp, 'edge.png')
    writeFileSync(edge, Buffer.alloc(MAX_IMAGE_BYTES))
    expect(imageToDataUrl(edge).ok).toBe(true)
  })

  it('目录不是文件，返回错误', () => {
    mkdirSync(join(tmp, 'adir'))
    const r = imageToDataUrl(join(tmp, 'adir'))
    expect(r.ok).toBe(false)
  })
})

describe('images：路径白名单（安全边界）', () => {
  it('项目根内相对路径通过', () => {
    const r = resolveImagePath('src/config.ts')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.display).toBe('src/config.ts')
  })

  it('项目根内绝对路径通过', () => {
    const r = resolveImagePath(join(process.cwd(), 'src', 'config.ts'))
    expect(r.ok).toBe(true)
  })

  it('图片目录内的绝对路径通过（受控例外）', () => {
    mkdirSync(imageDir(), { recursive: true })
    const target = join(imageDir(), 'shot.png')
    writeFileSync(target, PNG_BYTES)
    const r = resolveImagePath(target)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.abs).toBe(target)
    expect(r.display).toBe(target)
  })

  it('项目根之外（../）被拒绝', () => {
    const r = resolveImagePath('../outside.png')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('非法路径')
  })

  it('绝对路径指向项目根之外被拒绝', () => {
    expect(resolveImagePath('/etc/passwd').ok).toBe(false)
  })

  it('相似前缀 images-evil/ 被拒绝（禁止裸 startsWith）', () => {
    const evilDir = join(tmp, 'images-evil')
    mkdirSync(evilDir, { recursive: true })
    const target = join(evilDir, 'x.png')
    writeFileSync(target, PNG_BYTES)
    // tmp/images-evil/x.png 与 tmp/images/ 只差一个字符，裸 startsWith 会误判放行
    const r = resolveImagePath(target)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('非法路径')
  })

  it('相似前缀 imagesx/ 被拒绝', () => {
    const sibling = join(tmp, 'imagesx')
    mkdirSync(sibling, { recursive: true })
    const target = join(sibling, 'x.png')
    writeFileSync(target, PNG_BYTES)
    expect(resolveImagePath(target).ok).toBe(false)
  })

  it('图片目录的父目录被拒绝', () => {
    expect(resolveImagePath(tmp).ok).toBe(false)
  })

  it('图片目录本身被拒绝（目录不是图片；精确前缀不含自身）', () => {
    mkdirSync(imageDir(), { recursive: true })
    expect(resolveImagePath(imageDir()).ok).toBe(false)
  })

  it('空路径 / 非字符串被拒绝', () => {
    expect(resolveImagePath('').ok).toBe(false)
    expect(resolveImagePath('   ').ok).toBe(false)
    expect(resolveImagePath(undefined as any).ok).toBe(false)
  })
})

describe('images：路径白名单的符号链接二次校验', () => {
  it('项目根内的软链指向项目根外 → 被拒绝', () => {
    const outside = join(tmp, 'outside-target.png')
    writeFileSync(outside, PNG_BYTES)
    const link = repoLinkPath()
    symlinkSync(outside, link)
    try {
      const r = resolveImagePath(link)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error).toContain('符号链接指向了允许范围之外')
    } finally {
      rmSync(link, { force: true })
    }
  })

  it('项目根内的软链指向项目根内 → 通过', () => {
    const link = repoLinkPath()
    symlinkSync(join(process.cwd(), 'src', 'config.ts'), link)
    try {
      const r = resolveImagePath(link)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      // 白名单返回的是字面路径（软链本身），不把软链改写为真实路径
      expect(r.abs).toBe(link)
    } finally {
      rmSync(link, { force: true })
    }
  })

  it('图片目录内的软链指向图片目录外 → 被拒绝', () => {
    mkdirSync(imageDir(), { recursive: true })
    const outside = join(tmp, 'outside.png')
    writeFileSync(outside, PNG_BYTES)
    const link = join(imageDir(), 'link-out.png')
    symlinkSync(outside, link)
    const r = resolveImagePath(link)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('符号链接指向了允许范围之外')
  })

  it('图片目录内的软链指向图片目录内 → 通过', () => {
    mkdirSync(imageDir(), { recursive: true })
    const target = join(imageDir(), 'real.png')
    writeFileSync(target, PNG_BYTES)
    const link = join(imageDir(), 'alias.png')
    symlinkSync(target, link)
    const r = resolveImagePath(link)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.abs).toBe(link)
  })

  it('软链指向不存在的目标 → 不崩溃且返回明确结果', () => {
    mkdirSync(imageDir(), { recursive: true })
    const link = join(imageDir(), 'dangling.png')
    symlinkSync(join(imageDir(), 'no-such-target.png'), link)
    let r: ReturnType<typeof resolveImagePath> | undefined
    expect(() => {
      r = resolveImagePath(link)
    }).not.toThrow()
    // 目标不存在 → realpath 解析失败 → 按原逻辑放行（白名单已通过），由读取阶段报「图片不存在」
    expect(r?.ok).toBe(true)
    if (!r?.ok) return
    expect(r.abs).toBe(link)
    const enc = imageToDataUrl(r.abs)
    expect(enc.ok).toBe(false)
    if (enc.ok) return
    expect(enc.error).toContain('图片不存在')
  })

  it('软链目录指向图片目录外 → 其下的路径被拒绝（父目录 realpath 分支）', () => {
    mkdirSync(imageDir(), { recursive: true })
    const outsideDir = join(tmp, 'outside-dir')
    mkdirSync(outsideDir)
    const linkDir = join(imageDir(), 'linkdir')
    symlinkSync(outsideDir, linkDir)
    const r = resolveImagePath(join(linkDir, 'x.png'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('符号链接指向了允许范围之外')
  })
})

describe('images：按数量清理', () => {
  it(`保留 mtime 最新 ${MAX_IMAGE_COUNT} 张，删除更旧的`, () => {
    mkdirSync(imageDir(), { recursive: true })
    const base = Date.now() - 10 * 60 * 1000
    const names: string[] = []
    for (let i = 0; i < MAX_IMAGE_COUNT + 5; i++) {
      const name = `img-${String(i).padStart(3, '0')}.png`
      const abs = join(imageDir(), name)
      writeFileSync(abs, PNG_BYTES)
      const t = new Date(base + i * 1000) // i 越大越新
      utimesSync(abs, t, t)
      names.push(name)
    }

    cleanupImages()

    const left = readdirSync(imageDir()).sort()
    expect(left).toHaveLength(MAX_IMAGE_COUNT)
    // 最旧的 5 张（img-000..img-004）应被删除，最新的保留
    expect(left).not.toContain('img-000.png')
    expect(left).not.toContain('img-004.png')
    expect(left).toContain('img-005.png')
    expect(left).toContain(`img-${String(MAX_IMAGE_COUNT + 4).padStart(3, '0')}.png`)
  })

  it(`不足 ${MAX_IMAGE_COUNT} 张时不删除任何文件`, () => {
    mkdirSync(imageDir(), { recursive: true })
    writeFileSync(join(imageDir(), 'a.png'), PNG_BYTES)
    writeFileSync(join(imageDir(), 'b.png'), PNG_BYTES)
    cleanupImages()
    expect(readdirSync(imageDir())).toHaveLength(2)
  })

  it('图片目录不存在时静默返回', () => {
    expect(() => cleanupImages()).not.toThrow()
  })

  it(`恰好 ${MAX_IMAGE_COUNT} 张时一张都不删`, () => {
    mkdirSync(imageDir(), { recursive: true })
    const base = Date.now() - 10 * 60 * 1000
    const names: string[] = []
    for (let i = 0; i < MAX_IMAGE_COUNT; i++) {
      const name = `edge-${String(i).padStart(3, '0')}.png`
      const abs = join(imageDir(), name)
      writeFileSync(abs, PNG_BYTES)
      const t = new Date(base + i * 1000) // i 越大越新
      utimesSync(abs, t, t)
      names.push(name)
    }

    cleanupImages()

    // 逐个比对文件集合（不只看数量）：恰好等于上限时 slice(MAX) 为空，不应有任何删除
    expect(readdirSync(imageDir()).sort()).toEqual(names.slice().sort())
  })

  it(`恰好 ${MAX_IMAGE_COUNT + 1} 张时只删最旧的 1 张`, () => {
    mkdirSync(imageDir(), { recursive: true })
    const base = Date.now() - 10 * 60 * 1000
    const names: string[] = []
    for (let i = 0; i < MAX_IMAGE_COUNT + 1; i++) {
      const name = `edge-${String(i).padStart(3, '0')}.png`
      const abs = join(imageDir(), name)
      writeFileSync(abs, PNG_BYTES)
      const t = new Date(base + i * 1000) // i 越大越新
      utimesSync(abs, t, t)
      names.push(name)
    }

    cleanupImages()

    const left = readdirSync(imageDir()).sort()
    expect(left).toHaveLength(MAX_IMAGE_COUNT)
    // 只剩最新的 MAX_IMAGE_COUNT 张（即 edge-000.png 被删）
    expect(left).toEqual(names.slice(1).sort())
    expect(existsSync(join(imageDir(), names[0]))).toBe(false)
  })

  it('saveImage 落盘后自动触发清理', () => {
    mkdirSync(imageDir(), { recursive: true })
    const base = Date.now() - 10 * 60 * 1000
    for (let i = 0; i < MAX_IMAGE_COUNT + 3; i++) {
      const abs = join(imageDir(), `old-${String(i).padStart(3, '0')}.png`)
      writeFileSync(abs, PNG_BYTES)
      const t = new Date(base + i * 1000)
      utimesSync(abs, t, t)
    }
    saveImage(PNG_BYTES)
    expect(readdirSync(imageDir())).toHaveLength(MAX_IMAGE_COUNT)
  })
})
