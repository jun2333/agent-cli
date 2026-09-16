import fs from 'fs/promises'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { glob as globFiles } from 'glob'
import type { OpenAI } from 'openai'
import { projectRoot, config } from '../config.js'
import { agentCliDir, imageToDataUrl, resolveImagePath } from '../images.js'
import { getCapabilities } from '../models.js'
import { readMemoryIndex, readMemoryTopic, appendMemory, writeMemory } from '../session.js'

const execAsync = promisify(exec)

/** 工具定义（OpenAI 兼容 JSON Schema），注入 LLM */
export const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: '在项目目录下执行 shell 命令，返回 stdout、stderr 和退出码。用于编译、测试、运行、git 操作等。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: '读取项目内文件的完整内容。路径相对于项目根目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对项目根的文件路径，如 src/index.ts' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: '写入或覆盖项目内文件，自动创建父目录。用于创建新文件或整文件重写。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对项目根的文件路径，如 src/hello.ts' },
          content: { type: 'string', description: '要写入的完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description: '精确替换项目内文件的一段文本。用于小范围修改，比 write 整文件重写更省 token。old_string 必须在文件中唯一。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对项目根的文件路径' },
          old_string: { type: 'string', description: '要被替换的原文，必须精确匹配且唯一' },
          new_string: { type: 'string', description: '替换后的内容' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出项目内目录的条目（文件/子目录）。路径相对于项目根目录，默认当前目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对项目根的目录路径，默认 .' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: '按 glob 模式查找项目内文件，返回匹配的文件路径列表。用于定位文件，如 **/*.ts、src/**/*.vue。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，相对于项目根目录' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: '在项目文件中搜索文本/正则，返回匹配的文件和行。用于定位"某函数/某关键词在哪"。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '要搜索的正则表达式或关键词' },
          path: { type: 'string', description: '搜索起始目录（相对项目根），默认整个项目' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '在互联网上搜索信息，返回相关结果的标题、链接和摘要。当用户问题需要实时/最新信息、或超出你的知识范围时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_image',
      description:
        '读取并理解**尚未在对话中显示**的图片文件（需要当前模型支持视觉）。路径可为项目内的图片文件，或 ~/.agent-cli/images/ 下的图片（用户 Ctrl+V 粘贴的图片存放在这里）。' +
        '⚠️ 若图片已随用户消息附带（你能直接看到图），请直接基于它回答，**不要**调用本工具，也不要凭空猜测路径。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '图片路径，如 docs/shot.png 或 ~/.agent-cli/images/20260916-112233-123.png' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description: '读取长期记忆：无 topic 返回记忆索引（类型 + 每条一句话摘要）；有 topic 返回对应类型记忆的完整内容。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '记忆类型名（如 preferences/project），可选；缺省返回索引' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_memory',
      description: '向指定类型的长期记忆追加一条内容，并自动更新记忆索引。用于记录用户偏好、项目约定等。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '记忆类型名（如 preferences/project）' },
          content: { type: 'string', description: '要追加的记忆内容（一句话）' },
          summary: { type: 'string', description: '可选的一句话摘要；缺省用 content 前 40 字' },
        },
        required: ['topic', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_memory',
      description: '覆盖指定类型的长期记忆内容，并自动重建记忆索引。用于修正/重写某类记忆。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '记忆类型名（如 preferences/project）' },
          content: { type: 'string', description: '覆盖后的完整内容（可多行，每行一条记忆）' },
        },
        required: ['topic', 'content'],
      },
    },
  },
]

/** 多模态内容部件（与 OpenAI ChatCompletionContentPart 对齐） */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 工具执行结果：content 回传给 LLM，支持纯文本或多模态数组（如图片） */
export type ToolResult = { content: string | ContentPart[] }

export type ToolImplementations = Record<string, (args: any) => Promise<ToolResult>>

/** 危险命令拦截（L1 最小安全） */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
  { pattern: /^rm\s+(-rf?)?\s+(\/|~)/, hint: '删除根目录或家目录' },
  { pattern: /^sudo\b/, hint: 'sudo 提权' },
  { pattern: /^(shutdown|poweroff|reboot|halt)\b/, hint: '关机/重启' },
  { pattern: /^mkfs\./, hint: '格式化磁盘' },
]

/** 遍历时跳过的目录 */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.harness'])

/** 路径穿越防护：解析后必须位于项目根内 */
function resolveSafe(p: string): { ok: true; resolved: string; relative: string } | { ok: false; error: string } {
  const resolved = path.resolve(projectRoot, p)
  const root = projectRoot + path.sep
  if (resolved !== projectRoot && !resolved.startsWith(root)) {
    return { ok: false, error: `非法路径：不允许访问项目根目录之外的文件（${p}）` }
  }
  return { ok: true, resolved, relative: path.relative(projectRoot, resolved) }
}

/**
 * 把开头的 `~` 展开为 **agent-cli 基址**（`AGENT_CLI_DIR` 或家目录，同 images.agentCliDir）：
 * 图片目录在项目根之外，用户/LLM 常按 `~/images/x.png` 书写，而 `path.resolve` 不会展开 `~`
 * （会被当成名为 `~` 的目录）。基址必须与 `imageDir()` 一致，否则设置 `AGENT_CLI_DIR` 后
 * 工具描述承诺的路径会被白名单拒绝（审查发现 I-5）。展开后再交给 images.resolveImagePath 校验。
 */
function expandHome(p: string): string {
  if (p === '~') return agentCliDir()
  return p.startsWith('~/') ? path.join(agentCliDir(), p.slice(2)) : p
}

/** 递归遍历目录收集文本文件（跳过忽略目录、二进制、大文件） */
async function collectTextFiles(
  dir: string,
  base: string,
  limit: number,
): Promise<Array<{ abs: string; rel: string }>> {
  const results: Array<{ abs: string; rel: string }> = []
  const entries = await fs.readdir(dir, { withFileTypes: true })

  for (const e of entries) {
    if (results.length >= limit) break
    const abs = path.join(dir, e.name)
    const rel = path.relative(base, abs)

    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue
      results.push(...(await collectTextFiles(abs, base, limit)))
    } else if (e.isFile()) {
      // 只看常见文本文件扩展名，跳过二进制/大文件
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|vue|css|scss|html|yaml|yml|toml|sh|ts)$/i.test(e.name)) continue
      const stat = await fs.stat(abs)
      if (stat.size > 1024 * 1024) continue
      results.push({ abs, rel })
    }
  }
  return results
}

/**
 * createTools 的可选参数。
 *
 * `currentModel` 用于 `view_image` 的能力预检：运行时模型会被 `/model` 切换，
 * 若工具内部直接读 `config.chatModel`，切换后预检就会按旧模型判断（切到无 vision 的模型仍放行，
 * 反之误拒）。因此由调用方（`runTurn`）把本轮真实使用的模型**注入**进来，
 * 保持「注入参数」而非「全局可变状态」——避免多轮/多会话之间互相污染。
 */
export type CreateToolsOptions = {
  /** 当前运行时模型；缺省回落 `config.chatModel`（非交互单轮模式） */
  currentModel?: string
}

export function createTools(opts: CreateToolsOptions = {}): {
  definitions: typeof toolDefinitions
  implementations: ToolImplementations
} {
  // 本轮的工具集绑定同一个模型值：view_image 预检读它，不再读 config.chatModel
  const currentModel = opts.currentModel ?? config.chatModel

  const implementations: ToolImplementations = {
    bash: async ({ command }: { command: string }) => {
      if (typeof command !== 'string' || !command.trim()) {
        return { content: JSON.stringify({ error: 'command 参数必须是非空字符串' }) }
      }
      const trimmed = command.trim()
      for (const { pattern, hint } of DANGEROUS_PATTERNS) {
        if (pattern.test(trimmed)) {
          return { content: JSON.stringify({ error: `危险命令已拦截：${hint}` }) }
        }
      }
      try {
        const { stdout, stderr } = await execAsync(trimmed, {
          cwd: projectRoot,
          timeout: config.bashTimeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        })
        return { content: JSON.stringify({ exitCode: 0, stdout, stderr }) }
      } catch (e: any) {
        return {
          content: JSON.stringify({
            exitCode: e.code ?? 1,
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? String(e.message ?? e),
          }),
        }
      }
    },

    read: async ({ path: p }: { path: string }) => {
      if (typeof p !== 'string') {
        return { content: JSON.stringify({ error: 'path 参数必须是字符串' }) }
      }
      const safe = resolveSafe(p)
      if (!safe.ok) return { content: JSON.stringify({ error: safe.error }) }
      try {
        const content = await fs.readFile(safe.resolved, 'utf-8')
        return { content: JSON.stringify({ path: safe.relative, content }) }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `读取失败: ${e.message}` }) }
      }
    },

    write: async ({ path: p, content }: { path: string; content: string }) => {
      if (typeof p !== 'string' || typeof content !== 'string') {
        return { content: JSON.stringify({ error: 'path 和 content 参数必须是字符串' }) }
      }
      const safe = resolveSafe(p)
      if (!safe.ok) return { content: JSON.stringify({ error: safe.error }) }
      try {
        await fs.mkdir(path.dirname(safe.resolved), { recursive: true })
        await fs.writeFile(safe.resolved, content, 'utf-8')
        return { content: JSON.stringify({ ok: true, path: safe.relative, bytes: Buffer.byteLength(content) }) }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `写入失败: ${e.message}` }) }
      }
    },

    edit: async ({ path: p, old_string, new_string }: { path: string; old_string: string; new_string: string }) => {
      if (typeof p !== 'string' || typeof old_string !== 'string' || typeof new_string !== 'string') {
        return { content: JSON.stringify({ error: 'path/old_string/new_string 参数必须是字符串' }) }
      }
      if (!old_string) {
        return { content: JSON.stringify({ error: 'old_string 不能为空' }) }
      }
      const safe = resolveSafe(p)
      if (!safe.ok) return { content: JSON.stringify({ error: safe.error }) }
      try {
        const content = await fs.readFile(safe.resolved, 'utf-8')
        const count = content.split(old_string).length - 1
        if (count === 0) {
          return { content: JSON.stringify({ error: 'old_string 未在文件中找到' }) }
        }
        if (count > 1) {
          return { content: JSON.stringify({ error: `old_string 在文件中出现 ${count} 次，不唯一；请扩大匹配范围` }) }
        }
        const updated = content.replace(old_string, new_string)
        await fs.writeFile(safe.resolved, updated, 'utf-8')
        return { content: JSON.stringify({ ok: true, path: safe.relative }) }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `编辑失败: ${e.message}` }) }
      }
    },

    list_dir: async ({ path: p = '.' }: { path?: string }) => {
      const safe = resolveSafe(p)
      if (!safe.ok) return { content: JSON.stringify({ error: safe.error }) }
      try {
        const entries = await fs.readdir(safe.resolved, { withFileTypes: true })
        const items = entries
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file',
            path: path.join(safe.relative === '.' ? '' : safe.relative, e.name),
          }))
        return { content: JSON.stringify(items) }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `列目录失败: ${e.message}` }) }
      }
    },

    glob: async ({ pattern }: { pattern: string }) => {
      if (typeof pattern !== 'string' || !pattern.trim()) {
        return { content: JSON.stringify({ error: 'pattern 参数必须是非空字符串' }) }
      }
      try {
        const files = await globFiles(pattern, {
          cwd: projectRoot,
          ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**', 'coverage/**'],
          nodir: true,
        })
        return { content: JSON.stringify(files.slice(0, 200)) }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `glob 失败: ${e.message}` }) }
      }
    },

    grep: async ({ pattern, path: p = '.' }: { pattern: string; path?: string }) => {
      if (typeof pattern !== 'string' || !pattern.trim()) {
        return { content: JSON.stringify({ error: 'pattern 参数必须是非空字符串' }) }
      }
      const safe = resolveSafe(p)
      if (!safe.ok) return { content: JSON.stringify({ error: safe.error }) }
      try {
        let re: RegExp
        try {
          re = new RegExp(pattern)
        } catch {
          return { content: JSON.stringify({ error: `正则表达式无效: ${pattern}` }) }
        }
        const files = await collectTextFiles(safe.resolved, projectRoot, 500)
        const matches: Array<{ file: string; line: number; text: string }> = []
        for (const f of files) {
          if (matches.length >= 100) break
          const content = await fs.readFile(f.abs, 'utf-8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              matches.push({ file: f.rel, line: i + 1, text: lines[i].trim().slice(0, 200) })
              if (matches.length >= 100) break
            }
          }
        }
        return { content: JSON.stringify(matches) }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `搜索失败: ${e.message}` }) }
      }
    },

    web_search: async ({ query }: { query: string }) => {
      if (typeof query !== 'string' || !query.trim()) {
        return { content: JSON.stringify({ error: 'query 参数必须是非空字符串' }) }
      }
      try {
        // Bing 国内可访问（DuckDuckGo 等可能被墙）
        const url = `https://cn.bing.com/search?q=${encodeURIComponent(query.trim())}`
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(15000),
        })
        const html = await res.text()
        const results: Array<{ title: string; url: string; snippet: string }> = []
        // Bing 结果：<li class="b_algo">...<h2><a href="url">title</a></h2>...<p>snippet</p>
        const re =
          /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a><\/h2>[\s\S]*?(?:<p[^>]*>(.*?)<\/p>)?/g
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) && results.length < 5) {
          const title = m[2].replace(/<[^>]+>/g, '').trim()
          if (!title) continue
          results.push({
            title,
            url: m[1],
            snippet: (m[3] || '').replace(/<[^>]+>/g, '').trim(),
          })
        }
        return {
          content: JSON.stringify(
            results.length > 0 ? results : { error: '没有搜索到相关结果，请尝试更换关键词' },
          ),
        }
      } catch (e: any) {
        return { content: JSON.stringify({ error: `搜索失败: ${e.message}` }) }
      }
    },

    view_image: async ({ path: p }: { path: string }) => {
      if (typeof p !== 'string' || !p.trim()) {
        return { content: JSON.stringify({ error: 'path 参数必须是非空字符串' }) }
      }

      // 能力预检：探测失败（null = 能力未知）或明确无 vision 都直接拒绝，且不读取图片——
      // 避免把图塞给不支持视觉的模型，导致上游报错或图片被静默丢弃。
      // 用注入的运行时模型（/model 切换后立即生效），而非 config.chatModel。
      const caps = await getCapabilities(currentModel)
      if (!caps) {
        return {
          content: JSON.stringify({
            error: `无法探测模型能力（${currentModel}）：Ollama 可能未启动或模型不存在，请确认后再试`,
          }),
        }
      }
      if (!caps.vision) {
        return {
          content: JSON.stringify({
            error: `当前模型 ${currentModel} 不支持视觉（vision）能力，无法读取图片；可用 /model 切换到支持视觉的模型`,
          }),
        }
      }

      // 路径校验统一复用 images.resolveImagePath（项目根内 或 图片目录内），不另写一套
      const safe = resolveImagePath(expandHome(p.trim()))
      if (!safe.ok) return { content: JSON.stringify({ error: safe.error }) }

      // 读取 + 大小校验（>10MB 拒绝）+ base64 编码为 data URL，全部由 images 承担
      const encoded = imageToDataUrl(safe.abs)
      if (!encoded.ok) {
        // 真实用户反馈的失败链之一：图片已直投进用户消息，模型却仍想"再读一次"，
        // 而直投消息里没有路径文本 → 它会**凭空猜一个路径**，这里报"不存在"后
        // 又白花一轮去纠错。故在路径不存在时把它拉回正轨。
        const hint = encoded.error.startsWith('图片不存在')
          ? '。若该图已随用户消息附带（你能直接看到），请直接基于它回答，无需调用本工具'
          : ''
        return { content: JSON.stringify({ error: encoded.error + hint }) }
      }

      return {
        content: [
          { type: 'text', text: `图片 ${safe.display}（${encoded.bytes} 字节）如下：` },
          { type: 'image_url', image_url: { url: encoded.url } },
        ],
      }
    },

    read_memory: async ({ topic }: { topic?: string }) => {
      if (topic === undefined) {
        const idx = readMemoryIndex()
        return { content: idx.trim() ? idx : JSON.stringify({ note: '暂无记忆' }) }
      }
      const r = readMemoryTopic(String(topic))
      return r.ok ? { content: r.content } : { content: JSON.stringify({ error: r.error }) }
    },

    append_memory: async ({ topic, content }: { topic: string; content: string }) => {
      if (typeof topic !== 'string' || typeof content !== 'string') {
        return { content: JSON.stringify({ error: 'topic/content 参数必须是字符串' }) }
      }
      const r = appendMemory(topic, content)
      return r.ok ? { content: JSON.stringify({ ok: true, topic }) } : { content: JSON.stringify({ error: r.error }) }
    },

    write_memory: async ({ topic, content }: { topic: string; content: string }) => {
      if (typeof topic !== 'string' || typeof content !== 'string') {
        return { content: JSON.stringify({ error: 'topic/content 参数必须是字符串' }) }
      }
      const r = writeMemory(topic, content)
      return r.ok ? { content: JSON.stringify({ ok: true, topic }) } : { content: JSON.stringify({ error: r.error }) }
    },
  }

  return { definitions: toolDefinitions, implementations }
}
