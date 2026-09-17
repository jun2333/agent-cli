/**
 * skills.ts — 技能的**最小发现层**（V-6 用户拍板 2026-09-17）
 *
 * 为什么需要它：AC-23（"已发现的技能出现在 `/` 候选列表"）原本被绑死为
 * 「FR-4 + FR-10」，而 FR-10 在 P4 → 表面上不可验。用户裁决 V-6：在本任务里
 * **顺带实现最小技能发现**，把 AC-23 从 NOT-RUN 变成可 PASS；P4（FR-10）只需要接上
 * 索引注入 / `read_skill` / `write_skill`，**发现层不得重做**。
 *
 * 职责边界（与 `commands.ts` / `ui/completion-menu.ts` 同一分层约定）：
 * - 本模块只做「技能文件在哪、怎么解析、怎么变成候选」，**不碰 stdin/stdout**；
 * - 唯一扩展点是 `commands.ts` 的 `CompletionSource`（B5 已交付）——本模块产出的源
 *   `id='skills'`，与 `builtin` 源并列注册进 `CompletionRegistry`；
 * - **不实现** FR-10 的其余部分（索引注入 system prompt / `read_skill` / `write_skill` /
 *   内置技能本体），那些是 P4。
 *
 * 技能文件格式（design D29，**不得偏离**，否则 P4 返工）：
 * ```
 * ---
 * name: demo-skill            # 必填
 * description: 一句话说明       # 必填
 * allowed-tools: read, write  # 可选
 * ---
 * 正文（本次不解析）
 * ```
 * 无 frontmatter / 缺必填字段 / 不可读的文件 → **跳过并告警，绝不抛异常**：
 * 技能是候选的增强，一个坏文件不该让 `/` 菜单整体消失（与 `CompletionRegistry` 的
 * "单源失败只跳过"同一取向）。
 *
 * 安全边界（lesson 004/008）：本模块只**读**技能文件、只产出候选 label（写回输入缓冲的
 * 文本），不做任何路径拼接、不执行任何命令；扫描根固定为 `~/.agent-cli/skills` 与
 * `<projectRoot>/.agent-cli/skills` 两个基址。
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'fs'
import { join } from 'path'
import { agentCliDir } from './images.js'
import { projectRoot } from './config.js'
import type { CompletionCandidate, CompletionSource } from './commands.js'

/** 技能目录名（`~/.agent-cli/skills` 与 `<项目根>/.agent-cli/skills`） */
export const SKILLS_DIR_NAME = 'skills'

/** 技能入口文件名（D29：每个技能一个目录，目录下的 `SKILL.md`） */
export const SKILL_FILE_NAME = 'SKILL.md'

/** 项目级技能目录相对项目根的路径（`<projectRoot>/.agent-cli/skills`） */
export const PROJECT_SKILLS_RELATIVE = join('.agent-cli', SKILLS_DIR_NAME)

/** 扫描来源：用户级（`~/.agent-cli/skills`）与项目级（`<项目根>/.agent-cli/skills`） */
export type SkillSourceKind = 'user' | 'project'

/** 一条被发现的技能（`path` 保留给 P4 的 `read_skill` 与告警文案） */
export type DiscoveredSkill = {
  /** frontmatter 的 `name`（去掉前导 `/`；不含 `/`，候选 label = `/${name}`） */
  name: string
  /** frontmatter 的 `description`（必填，作为候选的 detail） */
  description: string
  /** frontmatter 的可选 `allowed-tools`（逗号分隔字符串或 JSON 数组；P4 才消费） */
  allowedTools?: string[]
  /** 技能入口文件的绝对路径 */
  path: string
  /** 来自哪个扫描根 */
  source: SkillSourceKind
}

/** frontmatter 的必填/可选字段（D29） */
export type SkillFrontmatter = {
  name: string
  description: string
  allowedTools?: string[]
}

/** `parseSkillFrontmatter` 的结果：失败携带**面向用户的**原因（用于告警文案） */
export type SkillParseResult = { ok: true; frontmatter: SkillFrontmatter } | { ok: false; reason: string }

export type SkillDiscoveryOptions = {
  /** 用户级技能目录（缺省 `agentCliDir()/skills`；注入用于测试隔离） */
  userDir?: string
  /** 项目级技能目录（缺省 `<projectRoot>/.agent-cli/skills`；注入用于测试隔离） */
  projectDir?: string
  /** 告警通道（缺省 stderr）。发现层只告警、不抛，且同一句只报一次（见 createSkillCompletionSource） */
  warn?: (message: string) => void
}

/** 去掉包裹的成对引号（`"x"` / `'x'`）——frontmatter 里两种写法都常见 */
function unquote(value: string): string {
  const m = /^(["'])([\s\S]*)\1$/.exec(value)
  return m ? m[2] : value
}

/**
 * 解析可选的 `allowed-tools`：支持 `read, write`（逗号分隔）与 `["read","write"]`（JSON 数组）。
 * 解析不出来时返回 undefined（**不因此拒绝整个技能**——它是可选字段）。
 */
function parseAllowedTools(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const value = raw.trim()
  if (!value) return undefined
  if (value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) {
        const items = parsed.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
        return items.length > 0 ? items : undefined
      }
    } catch {
      return undefined
    }
    return undefined
  }
  const items = value.split(',').map((s) => unquote(s.trim())).filter(Boolean)
  return items.length > 0 ? items : undefined
}

/**
 * 解析技能文件的 frontmatter（D29）。
 *
 * 严格点：**第一行必须是 `---`**，且存在结束的 `---`；否则视为"无 frontmatter"。
 * 宽松点：字段只认 `key: value` 行，未知键/注释/空行忽略（P4 可能加字段，不该让旧代码报错）。
 */
export function parseSkillFrontmatter(text: string): SkillParseResult {
  const body = text.replace(/^\uFEFF/, '')
  const lines = body.split(/\r\n|\r|\n/)
  if (lines[0]?.trim() !== '---') {
    return { ok: false, reason: '缺少 frontmatter（文件第一行必须是 ---）' }
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) {
    return { ok: false, reason: 'frontmatter 未闭合（缺少结束的 ---）' }
  }

  const fields: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue // 未知行（非 key: value）忽略；D29 只要求下面两个必填字段
    fields[m[1].toLowerCase()] = unquote(m[2].trim())
  }

  const name = (fields['name'] ?? '').replace(/^\//, '').trim()
  if (!name) return { ok: false, reason: '缺少必填字段 name' }
  const description = (fields['description'] ?? '').trim()
  if (!description) return { ok: false, reason: '缺少必填字段 description' }

  const allowedTools = parseAllowedTools(fields['allowed-tools'])
  return { ok: true, frontmatter: { name, description, ...(allowedTools ? { allowedTools } : {}) } }
}

/** 两个扫描根（**顺序即优先级**：用户级在前 → 同名去重时用户级胜出） */
export function skillDirs(opts: SkillDiscoveryOptions = {}): Array<{ dir: string; source: SkillSourceKind }> {
  return [
    { dir: opts.userDir ?? join(agentCliDir(), SKILLS_DIR_NAME), source: 'user' },
    { dir: opts.projectDir ?? join(projectRoot, PROJECT_SKILLS_RELATIVE), source: 'project' },
  ]
}

/** 目录项按名字排序（确定性：候选顺序不能随 `readdir` 的返回顺序漂移） */
function byName(a: Dirent, b: Dirent): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * 扫描两个技能根，返回全部**格式合法**的技能。
 *
 * 失败语义（全部是"跳过 + 告警"，绝不抛）：
 * - 目录不存在（未装技能）→ 静默返回（这是常态，不是错误）；
 * - 目录不可读 / 文件不可读 → 告警并跳过该根/该文件；
 * - 无 frontmatter、缺 name/description → 告警并跳过该文件；
 * - 同名（`name` 重复）→ 告警并跳过**后者**（用户级先扫 → 用户级胜出）。
 */
export function discoverSkills(opts: SkillDiscoveryOptions = {}): DiscoveredSkill[] {
  const warn = opts.warn ?? (() => {})
  const found: DiscoveredSkill[] = []
  const seen = new Set<string>()

  for (const { dir, source } of skillDirs(opts)) {
    if (!existsSync(dir)) continue
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (e: any) {
      warn(`技能目录不可读，已跳过：${dir}（${e?.message ?? e}）`)
      continue
    }

    for (const entry of [...entries].sort(byName)) {
      if (!entry.isDirectory()) continue
      const file = join(dir, entry.name, SKILL_FILE_NAME)
      if (!existsSync(file)) continue // 目录里没有 SKILL.md → 不是技能，静默跳过

      let text: string
      try {
        text = readFileSync(file, 'utf-8')
      } catch (e: any) {
        warn(`技能文件不可读，已跳过：${file}（${e?.message ?? e}）`)
        continue
      }

      const parsed = parseSkillFrontmatter(text)
      if (!parsed.ok) {
        warn(`技能文件格式不符（${parsed.reason}），已跳过：${file}`)
        continue
      }
      if (seen.has(parsed.frontmatter.name)) {
        warn(`技能名重复，已跳过后者：${parsed.frontmatter.name}（${file}）`)
        continue
      }
      seen.add(parsed.frontmatter.name)
      found.push({ ...parsed.frontmatter, path: file, source })
    }
  }
  return found
}

/** 技能 → 补全候选（label 必须自带 `/`，否则 Tab/Enter 填入后命令前缀丢失，同 commands.ts 的口径） */
export function skillCandidates(skills: DiscoveredSkill[]): CompletionCandidate[] {
  return skills.map((s) => ({ label: `/${s.name}`, detail: s.description, kind: 'skill' as const }))
}

/**
 * 技能候选源（AC-23 / V-6）——注册进 B5 的 `CompletionRegistry`，与内置命令源并列。
 *
 * 每次 `list()` 都重新扫盘（新增技能文件无需重启），但**同一句告警只报一次**：
 * 菜单每次打开都会收集一次，否则一个坏文件会在用户每次输入 `/` 时刷屏。
 */
export function createSkillCompletionSource(opts: SkillDiscoveryOptions = {}): CompletionSource {
  const reported = new Set<string>()
  const warn = (message: string) => {
    if (reported.has(message)) return
    reported.add(message)
    ;(opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`)))(message)
  }
  return {
    id: 'skills',
    list: () => skillCandidates(discoverSkills({ ...opts, warn })),
  }
}
