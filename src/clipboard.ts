/**
 * clipboard.ts — macOS 剪贴板取图 / 取文本（Ctrl+V 直投图片进输入框）
 *
 * 设计约定（design.md §接口设计 5）：
 * - 取图优先 `pngpaste`（brew install pngpaste）；未安装则降级 `osascript` 取 `«class PNGf»`。
 * - 两条路径都取不到时区分三种语义：
 *   - `unavailable`：取图工具本身不可用（非 macOS / 两者都没装）→ 调用方提示用户；
 *   - `no-image`：工具可用但剪贴板里**确实没有图片**（剪贴板是文字/空）→ 调用方**退化为文本粘贴**；
 *   - `failed`：取图过程**出错**（超时/被 kill、Automation 权限被拒、命令缺失等）→ 调用方应提示用户，
 *     **不得**静默退化为文本粘贴——否则用户对"取图失败"毫无感知（见审查发现 W-7）。
 * - 取到 PNG 后统一交给 images.saveImage() 落盘（图片目录 + 按数量清理），
 *   临时文件在 finally 里删除，不留下垃圾。
 * - 子进程调用收敛在可注入的 `ClipboardDeps` 薄封装里（同 models.ts 的 setModelsDeps 风格），
 *   便于 e2e 注入假实现；本模块不碰 process.stdin/stdout。
 */
import { execFile } from 'child_process'
import { existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { saveImage } from './images.js'

const execFileAsync = promisify(execFile)

export type ClipboardImageResult =
  | { ok: true; name: string; path: string }
  | { ok: false; reason: 'no-image' | 'unavailable' | 'failed' }

/** 外部 IO 依赖（薄封装）：生产走真实子进程，测试注入假实现 */
export type ClipboardDeps = {
  /** 命令是否存在（`which <cmd>`） */
  hasCommand: (cmd: string) => Promise<boolean>
  /** 执行命令并返回 stdout；失败抛异常 */
  run: (cmd: string, args: string[]) => Promise<string>
}

const defaultDeps: ClipboardDeps = {
  hasCommand: async (cmd: string) => {
    try {
      await execFileAsync('which', [cmd])
      return true
    } catch {
      return false
    }
  },
  run: async (cmd: string, args: string[]) => {
    try {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 10000, maxBuffer: 10 * 1024 * 1024 })
      return stdout
    } catch (e: unknown) {
      // 不改变"失败即抛异常"的既有契约（对注入式假实现无影响），只把错误对象里
      // classifyFailure 需要的判别信息拼进 message。拼装逻辑抽成纯函数便于单测。
      throw new Error(describeExecError(e))
    }
  },
}

let deps: ClipboardDeps = defaultDeps

/** 覆盖 IO 依赖（仅供测试注入假实现，生产代码不调用） */
export function setClipboardDeps(overrides: Partial<ClipboardDeps>): void {
  deps = { ...deps, ...overrides }
}

/** 恢复默认依赖（仅供测试清理） */
export function resetClipboardDeps(): void {
  deps = defaultDeps
}

/** 临时 PNG 路径（时间戳 + 随机后缀，避免同进程内并发调用互相覆盖） */
function tmpPngPath(): string {
  return join(tmpdir(), `agent-cli-clip-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`)
}

/**
 * 把子进程（`execFile`）的失败对象拼成一条可判别的错误消息（纯函数，便于单测）。
 *
 * 为什么需要这一层：`execFile` 的错误对象把 stderr/code/killed/signal 挂在对象上，
 * 而 `classifyFailure` 只能看 message。不同 Node 版本/调用形态下 message 未必内联 stderr
 * （实测 v26.3.0 的 `promisify(execFile)` 会内联且 `err.stderr` 同时存在，但回调形态
 * 不保证），所以这里把两类信息都拼进来，保证「无图」与「取图失败」始终可判别。
 *
 * 拼装规则与顺序（` | ` 分隔）：message → stderr → `code=<code>` → `killed`。
 * 空值一律丢弃；若全部为空则返回空串（保持与内联实现完全一致的对外行为）。
 */
export function describeExecError(err: unknown): string {
  const e = err as { message?: unknown; stderr?: unknown; code?: unknown; killed?: unknown } | null | undefined
  return [
    e?.message,
    e?.stderr ? String(e.stderr) : '',
    e?.code != null ? `code=${e.code}` : '',
    e?.killed ? 'killed' : '',
  ]
    .filter(Boolean)
    .join(' | ')
}

/**
 * 把取图失败归类为「剪贴板无图」或「取图失败」（纯函数，便于单测）。
 *
 * 只有以下两种特征才说明"剪贴板确实没有图片"：
 * - osascript 报 `-1700`：`the clipboard as «class PNGf»` 在剪贴板没有 PNG 时必然失败；
 * - pngpaste 报 `no image`（实际措辞为 `no image data`）：同为"无图"的明确信号。
 *
 * 其余一律归 `failed`：超时（`ETIMEDOUT` / `killed`）、Automation 权限被拒（`-1743`）、
 * 命令不存在（`ENOENT`）、非 Error 值等——这些都无法推出"剪贴板没有图片"，
 * 必须让调用方提示用户，而不是静默退化成文本粘贴。
 */
export function classifyFailure(err: unknown): 'no-image' | 'failed' {
  const msg = err instanceof Error ? err.message : String(err)
  if (/-1700\b/.test(msg)) return 'no-image'
  // 用 `no image` 而非精确的 `no image data`：后者是 pngpaste 的实际措辞，
  // 但调用方/测试常简写为 `no image`，两者是同一个"无图"信号。
  if (/no image/i.test(msg)) return 'no-image'
  return 'failed'
}

/** 安全删除临时文件（失败不致命） */
function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    // 忽略：临时目录会被系统清理
  }
}

/**
 * 读取工具写出的临时 PNG 并落盘到图片目录。
 * 文件不存在/空文件（pngpaste 在无图时可能创建一个空文件）都归为「剪贴板无图」；
 * 读取或落盘本身出错（权限/磁盘）属"取图过程出错"，归为 `failed` 而不是伪装成"无图"。
 */
function collect(tmpFile: string): ClipboardImageResult {
  try {
    if (!existsSync(tmpFile)) return { ok: false, reason: 'no-image' }
    const buf = readFileSync(tmpFile)
    if (buf.length === 0) return { ok: false, reason: 'no-image' }
    const { name, path } = saveImage(buf, '.png')
    return { ok: true, name, path }
  } catch {
    return { ok: false, reason: 'failed' }
  } finally {
    removeQuietly(tmpFile)
  }
}

/**
 * 读取剪贴板图片并落盘。
 * 顺序：pngpaste → osascript；前者存在但失败（多为无图）时继续尝试后者。
 * 两个工具都没取到图时按 `classifyFailure` 归类：只要有一次失败属"取图出错"，就返回 `failed`。
 */
export async function readClipboardImage(): Promise<ClipboardImageResult> {
  // 只要某个工具报的是"取图出错"，就无法断定剪贴板没有图片 → 整体归 failed（不静默退化）
  let failure: 'no-image' | 'failed' = 'no-image'
  const noteFailure = (e: unknown) => {
    if (classifyFailure(e) === 'failed') failure = 'failed'
  }

  const hasPngpaste = await deps.hasCommand('pngpaste')
  if (hasPngpaste) {
    const file = tmpPngPath()
    try {
      await deps.run('pngpaste', [file])
      return collect(file)
    } catch (e) {
      removeQuietly(file)
      noteFailure(e)
    }
  }

  const hasOsascript = await deps.hasCommand('osascript')
  if (hasOsascript) {
    const file = tmpPngPath()
    // «class PNGf» 是 macOS 剪贴板的 PNG 类型；剪贴板无图时 osascript 以非 0 退出。
    // ⚠️ 必须把全部语句放进**同一次** osascript 调用（多个 -e），不能逐行起独立进程——
    // AppleScript 变量不跨进程存活，分次调用时 `write d to f` 里的 d/f 会是未定义，
    // 表现为「取不到图且产物 0 字节」（真实剪贴板实测发现）。
    const script = [
      'set d to (the clipboard as «class PNGf»)',
      `set f to open for access POSIX file "${file}" with write permission`,
      'write d to f',
      'close access f',
    ]
    const args: string[] = []
    for (const line of script) args.push('-e', line)
    try {
      await deps.run('osascript', args)
      return collect(file)
    } catch (e) {
      removeQuietly(file)
      noteFailure(e)
    }
  }

  // 工具本身不可用 → unavailable；工具可用但确实没取到图 → no-image（退化为文本粘贴）；
  // 取图过程中出错 → failed（调用方提示用户）
  if (!hasPngpaste && !hasOsascript) return { ok: false, reason: 'unavailable' }
  return { ok: false, reason: failure }
}

/**
 * 读取剪贴板纯文本（Ctrl+V 无图时的退化路径，走 macOS `pbpaste`）。
 * 不可用或剪贴板为空返回 null——调用方据此不做任何事。
 */
export async function readClipboardText(): Promise<string | null> {
  try {
    if (!(await deps.hasCommand('pbpaste'))) return null
    const text = await deps.run('pbpaste', [])
    return text || null
  } catch {
    return null
  }
}
