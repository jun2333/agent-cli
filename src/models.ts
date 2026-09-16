/**
 * models.ts — Ollama 模型清单与能力探测（供 /model 切换与 view_image 预检使用）
 *
 * 设计约定（design.md §接口设计 6）：
 * - `ollama list` 的输出不含能力字段，故对每个模型再调 `/api/show` 取 `capabilities`；
 *   **过滤 embedding 类的唯一判据是 capabilities 不含 'completion'**（如 bge-m3 只有 'embedding'）。
 * - 探测失败返回 `null` 表示"能力未知"，此时**保守保留**模型而非隐藏——
 *   避免 Ollama 抖动/网络超时把可用模型从列表里藏掉。
 * - 子进程与网络调用收敛在可注入的 `ModelsDeps` 薄封装里，单测替换为假实现，
 *   不真跑 `ollama list`、不真连 Ollama。
 * - 本模块不碰 process.stdin/stdout。
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { config } from './config.js'

const execFileAsync = promisify(execFile)

export type ModelCapabilities = {
  completion: boolean
  vision: boolean
  tools: boolean
  thinking: boolean
}

export type ModelInfo = {
  name: string
  sizeBytes: number
  /** null = 探测失败（能力未知），调用方应保守当作"可能有能力"处理 */
  capabilities: ModelCapabilities | null
}

/** 外部 IO 依赖（薄封装）：生产走真实实现，单测注入假实现 */
export type ModelsDeps = {
  /** 执行 `ollama list` 并返回 stdout */
  listModels: () => Promise<string>
  /** 请求 `/api/show` 并返回解析后的 JSON（形状由 parseCapabilities 校验） */
  showModel: (model: string) => Promise<unknown>
}

/** 从 OpenAI 兼容基址推出 Ollama 原生 API 基址（去掉末尾 /v1） */
function nativeBaseUrl(): string {
  return config.ollamaBaseUrl.replace(/\/v1\/?$/, '')
}

const defaultDeps: ModelsDeps = {
  listModels: async () => {
    // 用 execFile 而非 exec：命令与参数分开传，不经 shell（与 clipboard.ts 的风格统一）
    const { stdout } = await execFileAsync('ollama', ['list'], { timeout: 10000 })
    return stdout
  },
  showModel: async (model: string) => {
    const res = await fetch(`${nativeBaseUrl()}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  },
}

let deps: ModelsDeps = defaultDeps

/** 能力缓存：只存探测成功的结果（进程内 Map） */
const capabilityCache = new Map<string, ModelCapabilities>()

/** 覆盖 IO 依赖（仅供单测注入假实现，生产代码不调用） */
export function setModelsDeps(overrides: Partial<ModelsDeps>): void {
  deps = { ...deps, ...overrides }
}

/** 恢复默认依赖并清空能力缓存（仅供单测清理，避免用例间互相污染） */
export function resetModelsDeps(): void {
  deps = defaultDeps
  capabilityCache.clear()
}

/** 体积单位换算表（`ollama list` 的 SIZE 列形如 "5.2 GB"） */
const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
}

/** 解析 SIZE 列（"5.2 GB" → 字节数）；无法识别返回 0（不阻断列表展示） */
function parseSize(cols: string[]): number {
  // `ollama list` 的体积列会被空格拆成两个 token（"5.2" + "GB"），
  // 也可能粘在一起（"5.2GB"），两种形态都试一遍。
  // 只取 SIZE 及其后一列，避免把模型名里的 "8b"（如 llama3.1:8b）误当成体积。
  const candidates = [`${cols[2] ?? ''} ${cols[3] ?? ''}`.trim(), cols[2] ?? '']
  for (const c of candidates) {
    const m = /^([\d.]+)\s*([KMGT]?B)$/i.exec(c)
    if (!m) continue
    const n = Number(m[1])
    // "1.2.3 GB" 这类畸形数字 Number() 得到 NaN：跳过该候选，别把 NaN 当体积返回
    if (!Number.isFinite(n)) continue
    const unit = SIZE_UNITS[m[2].toUpperCase()] ?? 1
    return Math.round(n * unit)
  }
  return 0
}

/**
 * 合法模型名形态：`名字[:标签]`（如 qwen3:8b、bge-m3、llama3.1:8b、hf.co/user/model:tag）。
 * 首字符必须是字母/数字/下划线，标签不能为空 —— 借此挡掉 ":8b"、"/model"、"Error:" 这类垃圾首列。
 */
const MODEL_NAME_RE = /^[\w][\w./-]*(:[\w.-]+)?$/

/**
 * 解析 `ollama list` 输出：
 *   NAME                    ID              SIZE      MODIFIED
 *   qwen3:8b                500a1f067a9f    5.2 GB    2 weeks ago
 * 首行表头跳过，其余每行首列是模型名、第三列起是体积。
 *
 * 畸形输出必须被挡住：ollama 把告警/错误文本打到 stdout 时，若把首 token 当模型名，
 * 它探测能力必然失败 → 按"探测失败保守保留"的语义混进 /model 列表（用户看到不存在的模型）。
 */
function parseListOutput(stdout: string): Array<{ name: string; sizeBytes: number }> {
  const rows: Array<{ name: string; sizeBytes: number }> = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim() // trim 同时吃掉 CRLF 的 \r
    if (!trimmed) continue
    // 表头：大小写不敏感；容忍退化为单列 "NAME"（无尾随空白）的形态
    if (/^NAME(\s|$)/i.test(trimmed)) continue
    const cols = trimmed.split(/\s+/)
    // 数据行至少要有 NAME + ID 两列，且首列必须是合法模型名；
    // 只有一列（如孤立的 "qwen3:8b"）无法与垃圾行区分，一并丢弃。
    // 体积列畸形不算缺列：交给 parseSize 返回 0，保住模型本身。
    if (cols.length < 2 || !MODEL_NAME_RE.test(cols[0])) continue
    rows.push({ name: cols[0], sizeBytes: parseSize(cols) })
  }
  return rows
}

/** 把 `/api/show` 响应解析为能力集合；字段缺失/形状异常返回 null（能力未知） */
function parseCapabilities(raw: unknown): ModelCapabilities | null {
  if (!raw || typeof raw !== 'object') return null
  const caps = (raw as { capabilities?: unknown }).capabilities
  if (!Array.isArray(caps)) return null
  const set = new Set(caps.filter((c): c is string => typeof c === 'string'))
  return {
    completion: set.has('completion'),
    vision: set.has('vision'),
    tools: set.has('tools'),
    thinking: set.has('thinking'),
  }
}

/**
 * 探测单个模型能力（POST /api/show）；命中缓存则直接返回。
 * 任何异常（Ollama 未启动、模型不存在、超时）都归为 null = 能力未知。
 */
export async function getCapabilities(model: string): Promise<ModelCapabilities | null> {
  const cached = capabilityCache.get(model)
  if (cached) return cached

  let caps: ModelCapabilities | null = null
  try {
    caps = parseCapabilities(await deps.showModel(model))
  } catch {
    caps = null
  }
  // 只缓存成功结果：失败不缓存，避免一次抖动把模型永久标记为"能力未知"
  if (caps) capabilityCache.set(model, caps)
  return caps
}

/** 启动时预取并写入缓存（并发探测，失败项静默跳过） */
export async function primeCapabilities(models: string[]): Promise<void> {
  await Promise.all(models.map((m) => getCapabilities(m)))
}

/** 列出可用对话模型：解析 `ollama list`，再按 capabilities 过滤 embedding 类 */
export async function listChatModels(): Promise<ModelInfo[]> {
  let stdout: string
  try {
    stdout = await deps.listModels()
  } catch {
    return [] // ollama 不可用/未安装：返回空列表（不抛异常），由调用方提示用户
  }

  const rows = parseListOutput(stdout)
  const infos = await Promise.all(
    rows.map(async (row) => ({
      name: row.name,
      sizeBytes: row.sizeBytes,
      capabilities: await getCapabilities(row.name),
    })),
  )
  // capabilities 为 null（探测失败）→ 保守保留；只有明确探到「不含 completion」才判定为 embedding 类
  return infos.filter((m) => !m.capabilities || m.capabilities.completion)
}
