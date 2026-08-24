import fs from 'fs/promises'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { glob as globFiles } from 'glob'
import type { OpenAI } from 'openai'
import { projectRoot, config } from '../config.js'

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
]

/** 工具执行结果：content 回传给 LLM */
export type ToolResult = { content: string }

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

export function createTools(): { definitions: typeof toolDefinitions; implementations: ToolImplementations } {
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
  }

  return { definitions: toolDefinitions, implementations }
}
