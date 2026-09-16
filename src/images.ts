/**
 * images.ts — 图片落盘 / data URL 编码 / 路径白名单 / 按数量清理
 *
 * 设计约定（design.md §接口设计 4）：
 * - 图片统一落在 `~/.agent-cli/images`（受 AGENT_CLI_DIR 覆盖），单图上限 10MB，
 *   目录按数量保留 mtime 最新的 100 张。
 * - **路径白名单是本模块的安全边界**：只允许项目根内（沿用 tools 的 resolveSafe 语义）
 *   或图片目录内，其余一律拒绝。判断必须在 `path.resolve` 之后、用「目录末尾拼 path.sep」
 *   做精确前缀匹配——裸 `startsWith` 会把 `images-evil/` 误判为 `images/` 的子路径
 *   （见 knowledge/lessons/004-topic-to-file-safe-mapping.md）。
 * - 本模块不碰 process.stdin/stdout，全部为可单测的纯逻辑 + fs。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'path'
import { projectRoot } from './config.js'

export const IMAGE_DIR_NAME = 'images'
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_COUNT = 100

/** 常见位图扩展名 → MIME（vision 只认这些格式） */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/**
 * ~/.agent-cli 根目录（受 `AGENT_CLI_DIR` 覆盖；运行时读取，方便测试隔离）。
 *
 * 这是「用户家目录侧的 agent-cli 基址」的唯一来源：图片目录与 `~` 展开都必须基于它，
 * 否则设置 `AGENT_CLI_DIR` 后工具描述承诺的 `~/...images/x.png` 会被白名单拒绝（审查发现 I-5）。
 */
export function agentCliDir(): string {
  return process.env.AGENT_CLI_DIR || join(homedir(), '.agent-cli')
}

/** 图片目录绝对路径（~/.agent-cli/images） */
export function imageDir(): string {
  return join(agentCliDir(), IMAGE_DIR_NAME)
}

/** 按扩展名推断 MIME；未知扩展名按 PNG 处理（图片模块的合理缺省） */
function mimeOf(file: string): string {
  return MIME_BY_EXT[extname(file).toLowerCase()] ?? 'image/png'
}

/**
 * 扩展名白名单：只接受 `.xxx` 形式，否则回退 `.png`。
 * 防的是 `ext` 携带 `../` 或路径分隔符把文件拼到图片目录之外。
 */
function safeExt(ext?: string): string {
  if (!ext) return '.png'
  const normalized = ext.startsWith('.') ? ext : `.${ext}`
  return /^\.[a-z0-9]+$/i.test(normalized) ? normalized.toLowerCase() : '.png'
}

/** 时间戳文件名，形如 20260916-112233-123.png（可读 + 天然按时间排序） */
function timestampName(ext: string): string {
  const d = new Date()
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`
  return `${stamp}${ext}`
}

/** 保存图片 buffer，返回 { name, path }；落盘后触发一次清理 */
export function saveImage(buf: Buffer, ext?: string): { name: string; path: string } {
  const dir = imageDir()
  mkdirSync(dir, { recursive: true })
  const name = timestampName(safeExt(ext))
  const p = join(dir, name)
  writeFileSync(p, buf)
  cleanupImages()
  return { name, path: p }
}

/** 读图并编码为 data URL；文件不存在或超过 10MB 上限时返回错误 */
export function imageToDataUrl(
  p: string,
): { ok: true; url: string; bytes: number } | { ok: false; error: string } {
  try {
    if (!existsSync(p)) return { ok: false, error: `图片不存在：${p}` }
    const stat = statSync(p)
    if (!stat.isFile()) return { ok: false, error: `不是文件：${p}` }
    if (stat.size > MAX_IMAGE_BYTES) {
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1)
      return { ok: false, error: `图片过大：${mb(stat.size)}MB，单图上限 ${mb(MAX_IMAGE_BYTES)}MB` }
    }
    const base64 = readFileSync(p).toString('base64')
    return { ok: true, url: `data:${mimeOf(p)};base64,${base64}`, bytes: stat.size }
  } catch (e: any) {
    return { ok: false, error: `读取图片失败: ${e.message}` }
  }
}

/** 尽力解析真实路径；路径不存在/无权限/软链成环时返回 null，由调用方按原逻辑继续 */
function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/**
 * 路径白名单：项目根内（同 tools 的 resolveSafe 语义）或图片目录内。
 * 必须在 path.resolve 之后判断，且两个允许前缀都带尾部 path.sep，
 * 保证 `/x/.agent-cli/images-evil/a.png` 不会被当成 `/x/.agent-cli/images/` 的子路径。
 * 白名单通过后还要做符号链接二次校验（见函数内注释，审查发现 I-1）。
 */
export function resolveImagePath(
  p: string,
): { ok: true; abs: string; display: string } | { ok: false; error: string } {
  if (typeof p !== 'string' || !p.trim()) {
    return { ok: false, error: '图片路径必须是非空字符串' }
  }

  const abs = resolve(projectRoot, p)
  const root = projectRoot + sep
  const imgRoot = imageDir() + sep

  const inProject = abs === projectRoot || abs.startsWith(root)
  const inImageDir = abs.startsWith(imgRoot)
  if (!inProject && !inImageDir) {
    return { ok: false, error: `非法路径：不允许访问项目根与图片目录之外的路径（${p}）` }
  }

  // 符号链接二次校验（审查 I-1）：上面的白名单只校验字面路径，而 imageToDataUrl 的
  // readFileSync 会跟随软链，因此项目根/图片目录内的软链可以指向目录外并被读走。
  // 这里解析真实路径后重新判断是否仍在允许的根内：
  // - 文件存在 → 解析文件本身；不存在 → 解析父目录再拼 basename，用于挡住「软链目录」。
  // - 允许的根也做 realpath 归一，否则根自身是软链时（macOS 的 /tmp → /private/tmp）
  //   合法路径会被误判为越界。
  // - realpath 抛错（路径不存在等）→ 跳过二次校验，后续读取会自然报「图片不存在」。
  const realRoots = [projectRoot, imageDir()].map((r) => tryRealpath(r) ?? r)
  const realAbs = existsSync(abs)
    ? tryRealpath(abs)
    : (() => {
        const realDir = tryRealpath(dirname(abs))
        return realDir === null ? null : join(realDir, basename(abs))
      })()

  if (realAbs !== null && !realRoots.some((r) => realAbs === r || realAbs.startsWith(r + sep))) {
    return { ok: false, error: `非法路径：符号链接指向了允许范围之外（${p}）` }
  }

  // display 用于回显给 LLM/用户：项目根内给相对路径，图片目录内给绝对路径
  return { ok: true, abs, display: inProject ? relative(projectRoot, abs) : abs }
}

/** 按数量上限清理图片目录：保留 mtime 最新的 MAX_IMAGE_COUNT 张，其余删除 */
export function cleanupImages(): void {
  try {
    const dir = imageDir()
    if (!existsSync(dir)) return

    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const abs = join(dir, e.name)
        return { abs, mtimeMs: statSync(abs).mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs) // 新 → 旧

    for (const f of files.slice(MAX_IMAGE_COUNT)) {
      rmSync(f.abs, { force: true })
    }
  } catch {
    // 清理失败不致命（权限/并发删除），下次落盘时再试
  }
}
