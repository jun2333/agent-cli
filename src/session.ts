/**
 * session.ts — 会话历史持久化（按工作目录隔离 + 会话锁）+ 用户配置（根提示词 / memory）
 *
 * ~/.agent-cli 目录结构（AGENT_CLI_DIR 可整体覆盖，默认 ~/.agent-cli）：
 *   session/
 *     <workspace-id>/           每个工作目录一个文件夹（workspace-id = cwd 的 sha256 前 16 位）
 *       session-<unixms>.json   会话消息（对话内容）
 *       session-<unixms>.lock   会话锁（记录持有进程 pid，防止多进程并发编辑同一会话）
 *   memory/memory.md            用户维护的长期记忆（启动时拼进 system prompt）
 *   prompt.md                   用户自定义根提示词（存在则替换内置默认提示词）
 *
 * 设计约定：
 * - 会话 id 只存在进程内存（index.ts 持有），不落盘"当前会话"指针，
 *   因此无退出清空/异常残留/多进程"当前会话"冲突问题。
 * - 保存时机：每条用户消息、每次回答完成后实时写盘（不是退出时）。
 * - 锁：编辑会话前 acquireSessionLock，正常退出 releaseSessionLock；
 *   异常退出残留的锁靠 pid 存活探测判定过期并自动接管。
 * - 只存"对话消息"（user/assistant/tool），不存 system prompt——
 *   恢复时由 index.ts 用当前提示词组装，避免提示词改版后旧会话用过期 system。
 * - 图片不落 base64：写盘前 stripImages 把 image_url 换成自定义 image_ref（一张全屏截图可达数 MB，
 *   内联会让会话文件膨胀、listSessions 的 JSON.parse 变慢）；恢复时 hydrateImages 重读文件还原。
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type OpenAI from 'openai'
import { imageToDataUrl } from './images.js'

export type SessionMessage = OpenAI.Chat.ChatCompletionMessageParam

export type SessionInfo = {
  id: string
  file: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 是否被其他活进程锁定（被锁的会话不可选择） */
  locked: boolean
}

/** ~/.agent-cli 根目录（运行时读取，方便测试隔离） */
const agentCliDir = () => process.env.AGENT_CLI_DIR || join(homedir(), '.agent-cli')
const sessionRootDir = () => join(agentCliDir(), 'session')

/** 当前工作目录的 workspace id（稳定 hash，不随文件系统变化） */
export function workspaceIdOf(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16)
}

/** 当前 workspace 的会话目录（不存在时由 ensureAgentCliDir 创建） */
function workspaceDir(): string {
  return join(sessionRootDir(), workspaceIdOf(process.cwd()))
}

function sessionFile(id: string): string {
  return join(workspaceDir(), `${id}.json`)
}

function lockFile(id: string): string {
  return join(workspaceDir(), `${id}.lock`)
}

/** 当前 workspace 目录（供提示用） */
export function sessionWorkspaceDir(): string {
  return workspaceDir()
}

/** 用户 memory 文件路径 */
export function memoryFilePath(): string {
  return join(agentCliDir(), 'memory', 'memory.md')
}

/** 用户根提示词文件路径 */
export function promptFilePath(): string {
  return join(agentCliDir(), 'prompt.md')
}

/** 确保目录结构存在（启动时调用一次）。旧版会话不迁移。 */
export function ensureAgentCliDir() {
  try {
    mkdirSync(workspaceDir(), { recursive: true })
    mkdirSync(dirname(memoryFilePath()), { recursive: true })
  } catch {
    // 创建失败不致命（如只读 home），相关功能会静默降级
  }
}

// === 会话锁 ===

/** 进程是否存活（process.kill(pid, 0) 只探测不实际发信号） */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e.code === 'EPERM' // 进程存在但无权限操作，视为存活
  }
}

/** 会话是否被其他活进程锁定 */
export function isSessionLocked(id: string): boolean {
  try {
    const f = lockFile(id)
    if (!existsSync(f)) return false
    const info = JSON.parse(readFileSync(f, 'utf8'))
    return typeof info.pid === 'number' && info.pid !== process.pid && isProcessAlive(info.pid)
  } catch {
    return false
  }
}

/** 获取会话锁；被其他活进程持有返回 false，否则接管并返回 true */
export function acquireSessionLock(id: string): boolean {
  try {
    const f = lockFile(id)
    if (existsSync(f)) {
      try {
        const info = JSON.parse(readFileSync(f, 'utf8'))
        if (typeof info.pid === 'number' && info.pid !== process.pid && isProcessAlive(info.pid)) {
          return false
        }
      } catch {
        // 锁文件损坏，视为可接管
      }
    }
    mkdirSync(workspaceDir(), { recursive: true })
    writeFileSync(f, JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
    return true
  } catch {
    return false
  }
}

/** 释放自己的会话锁（只删除自己持有的锁，不影响他人） */
export function releaseSessionLock(id: string) {
  try {
    const f = lockFile(id)
    if (existsSync(f)) {
      const info = JSON.parse(readFileSync(f, 'utf8'))
      if (info.pid === process.pid) rmSync(f, { force: true })
    }
  } catch {
    // 忽略
  }
}

// === 图片剥离 / 恢复（会话文件不存 base64） ===

/**
 * 磁盘上的图片引用（非 OpenAI 标准，仅存在于会话文件中）。
 * 运行时消息里的 image_url part 会额外携带 path/name（见 ui/input-buffer.ts 的 toMessageContent）——
 * data URL 无法反推文件路径，只有靠这两个字段才能在恢复会话时重新读盘。
 */
type ImageRefPart = { type: 'image_ref'; path: string; name: string }

/** 运行时图片部件：标准 image_url 之外附带定位信息（非标准扩展，仅供持久化剥离使用） */
type RuntimeImagePart = { type: 'image_url'; image_url: { url: string }; path?: string; name?: string }

/** 图片失效时的降级文本（与 ui/input-buffer.ts 的标记保持一致） */
const missingImageText = (name: string) => `[图片已失效: ${name || '未知图片'}]`

/**
 * 递归遍历内容部件做图片相关替换：消息 content 可能是字符串/null（原样返回），
 * 也可能是部件数组；对数组递归是为防御嵌套数组结构。
 */
function mapContentParts(content: unknown, fn: (part: any) => unknown): unknown {
  if (Array.isArray(content)) return content.map((p) => mapContentParts(p, fn))
  if (content && typeof content === 'object') {
    const type = (content as { type?: unknown }).type
    if (type === 'image_url' || type === 'image_ref') return fn(content)
  }
  return content
}

/** 对每条消息的 content 应用部件替换；content 非数组时原样返回同一条消息 */
function transformContent(messages: SessionMessage[], fn: (part: any) => unknown): SessionMessage[] {
  return messages.map((m) => {
    const content = (m as { content?: unknown }).content
    if (!Array.isArray(content)) return m
    // content 是 SDK 的联合类型（string | 部件数组 | null），替换后需断言回去
    return { ...m, content: mapContentParts(content, fn) } as unknown as SessionMessage
  })
}

/** 写盘前：把 image_url part 换成 image_ref（剥离 base64）。已是 image_ref 的原样保留（幂等）。 */
function stripImages(messages: SessionMessage[]): SessionMessage[] {
  return transformContent(messages, (part) => {
    if (part.type === 'image_ref') return part
    const p = part as RuntimeImagePart
    const path = typeof p.path === 'string' ? p.path : ''
    const name = typeof p.name === 'string' ? p.name : ''
    // 没有路径就无法恢复（例如非本模块产生的图片部件）：降级为文本标记，
    // 绝不能让 base64 落盘——写盘内容不含 data:image 是本模块的硬约束。
    if (!path) return { type: 'text', text: missingImageText(name) }
    const ref: ImageRefPart = { type: 'image_ref', path, name }
    return ref
  })
}

/**
 * 读盘后：image_ref → 文件仍在则还原为 image_url（重新读文件编码 data URL），
 * 已失效则替换为文本标记。还原出的部件仍带 path/name，保证「恢复会话 → 再次保存」不会退化。
 */
export function hydrateImages(messages: SessionMessage[]): SessionMessage[] {
  return transformContent(messages, (part) => {
    const p = part as ImageRefPart
    const path = typeof p.path === 'string' ? p.path : ''
    const name = typeof p.name === 'string' ? p.name : ''
    const encoded = path ? imageToDataUrl(path) : ({ ok: false as const, error: '缺少路径' })
    if (!encoded.ok) return { type: 'text', text: missingImageText(name || path) }
    const image: RuntimeImagePart = { type: 'image_url', image_url: { url: encoded.url }, path, name }
    return image
  })
}

// === 会话读写 ===

// 同毫秒内多次 newSessionId 时用自增序列保证唯一（避免会话文件撞名）
let sessionSeq = 0

/** 新建会话 id（不落盘任何指针；调用方在内存持有该 id） */
export function newSessionId(): string {
  sessionSeq = (sessionSeq + 1) % 1000
  return `session-${Date.now()}-${sessionSeq}`
}

/** 列出当前 workspace 的所有会话（按最近更新倒序），含锁定状态 */
export function listSessions(): SessionInfo[] {
  try {
    const dir = workspaceDir()
    if (!existsSync(dir)) return []
    const infos: SessionInfo[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const file = join(dir, name)
      const st = statSync(file)
      let messageCount = 0
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        if (Array.isArray(data)) messageCount = data.length
      } catch {
        // 损坏的会话文件，messageCount 记 0
      }
      const id = name.replace(/\.json$/, '')
      infos.push({
        id,
        file,
        createdAt: st.birthtimeMs,
        updatedAt: st.mtimeMs,
        messageCount,
        locked: isSessionLocked(id),
      })
    }
    infos.sort((a, b) => b.updatedAt - a.updatedAt)
    return infos
  } catch {
    return []
  }
}

/** 读取指定会话。文件不存在/损坏返回 null。 */
export function loadSession(id: string): SessionMessage[] | null {
  try {
    const file = sessionFile(id)
    if (!existsSync(file)) return null
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(data)) return null
    return data as SessionMessage[]
  } catch {
    return null
  }
}

/** 保存指定会话。自动过滤 system prompt，传空数组即清空；写盘前剥离图片 base64。 */
export function saveSession(messages: SessionMessage[], id: string) {
  try {
    const dialog = stripImages(messages.filter((m) => m.role !== 'system'))
    const file = sessionFile(id)
    mkdirSync(workspaceDir(), { recursive: true })
    writeFileSync(file, JSON.stringify(dialog, null, 2))
  } catch {
    // 写入失败不致命（比如磁盘满/权限），静默忽略，会话仍只在内存中继续
  }
}

/** 读取用户自定义根提示词（prompt.md）。不存在/为空返回 null。 */
export function loadUserPrompt(): string | null {
  try {
    const f = promptFilePath()
    if (!existsSync(f)) return null
    const content = readFileSync(f, 'utf8').trim()
    return content || null
  } catch {
    return null
  }
}

/** 读取用户 memory（memory.md）。不存在/为空返回 null。 */
export function loadMemory(): string | null {
  try {
    const f = memoryFilePath()
    if (!existsSync(f)) return null
    const content = readFileSync(f, 'utf8').trim()
    return content || null
  } catch {
    return null
  }
}

// === memory 索引化（按类型拆文件 + index.md 索引，工具自动维护） ===

const memoryDir = () => join(agentCliDir(), 'memory')
const memoryIndexFile = () => join(memoryDir(), 'index.md')

/** topic → 记忆文件名（安全校验：拒绝空/保留字/路径穿越/含分隔符）。非法返回 null。 */
export function memoryTopicToFile(topic: string): string | null {
  if (!topic || !topic.trim()) return null
  const t = topic.trim()
  if (t === 'index') return null
  if (t.includes('/') || t.includes('\\') || t.includes('..')) return null
  return `${t}.md`
}

/** 读取记忆索引（index.md）全文；无记忆返回空串 */
export function readMemoryIndex(): string {
  try {
    const f = memoryIndexFile()
    if (!existsSync(f)) return ''
    return readFileSync(f, 'utf8')
  } catch {
    return ''
  }
}

/** 读取某类型记忆文件全文。topic 不存在或非法返回错误。 */
export function readMemoryTopic(topic: string): { ok: true; content: string } | { ok: false; error: string } {
  const file = memoryTopicToFile(topic)
  if (!file) return { ok: false, error: `topic 非法（不能为空/含 ../ / 路径分隔符，index 为保留字）` }
  try {
    const f = join(memoryDir(), file)
    if (!existsSync(f)) return { ok: false, error: `topic "${topic}" 暂无记忆` }
    return { ok: true, content: readFileSync(f, 'utf8').replace(/\s+$/, '') }
  } catch (e: any) {
    return { ok: false, error: `读取失败: ${e.message}` }
  }
}

/** 追加一条记忆到 <topic>.md，并自动重建索引 */
export function appendMemory(topic: string, content: string): { ok: true } | { ok: false; error: string } {
  const file = memoryTopicToFile(topic)
  if (!file) return { ok: false, error: `topic 非法（不能为空/含 ../ / 路径分隔符，index 为保留字）` }
  try {
    const dir = memoryDir()
    mkdirSync(dir, { recursive: true })
    const full = join(dir, file)
    const existing = existsSync(full) ? readFileSync(full, 'utf8').replace(/\s+$/, '') : ''
    writeFileSync(full, `${existing ? existing + '\n' : ''}${content}\n`, 'utf8')
    rebuildMemoryIndex()
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: `写入失败: ${e.message}` }
  }
}

/** 覆盖 <topic>.md 内容，并自动重建索引 */
export function writeMemory(topic: string, content: string): { ok: true } | { ok: false; error: string } {
  const file = memoryTopicToFile(topic)
  if (!file) return { ok: false, error: `topic 非法（不能为空/含 ../ / 路径分隔符，index 为保留字）` }
  try {
    const dir = memoryDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, file), `${content}\n`, 'utf8')
    rebuildMemoryIndex()
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: `写入失败: ${e.message}` }
  }
}

/** 重扫 memory/*.md（除 index.md）生成 index.md：类型分组 + 每条一句话摘要（行内容前 40 字） */
function rebuildMemoryIndex(): void {
  try {
    const dir = memoryDir()
    if (!existsSync(dir)) return
    const topics: Array<{ topic: string; lines: string[] }> = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md') || name === 'index.md') continue
      const lines = readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      if (lines.length > 0) topics.push({ topic: name.replace(/\.md$/, ''), lines })
    }
    if (topics.length === 0) {
      writeFileSync(memoryIndexFile(), '')
      return
    }
    const parts = ['# Memory Index']
    for (const t of topics) {
      parts.push(`\n## ${t.topic}`)
      for (const l of t.lines) parts.push(`- ${l.length > 40 ? l.slice(0, 40) + '…' : l}`)
    }
    writeFileSync(memoryIndexFile(), parts.join('\n') + '\n')
  } catch {
    // 索引重建失败不阻塞主流程
  }
}

/** 兼容旧版单文件 memory.md：存在且尚无索引时，迁入 preferences.md 并重建索引 */
export function migrateLegacyMemory(): void {
  try {
    const dir = memoryDir()
    const legacy = join(dir, 'memory.md')
    if (!existsSync(legacy) || existsSync(memoryIndexFile())) return
    const content = readFileSync(legacy, 'utf8').trim()
    if (!content) return
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'preferences.md'), content + '\n', 'utf8')
    rmSync(legacy, { force: true })
    rebuildMemoryIndex()
  } catch {
    // 迁移失败不阻塞
  }
}
