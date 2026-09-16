/**
 * editor.ts — Ctrl+G：在外部编辑器里撰写提示词
 *
 * 流程（task-plan Step 10 / Decision D-1）：
 *   当前输入 → 写 `~/.agent-cli/tmp/prompt-<ts>-<rand>.md` → 用 $EDITOR（其次 $VISUAL，
 *   缺省 `code --wait`）打开并等待退出 → 读回内容 → 删除临时文件。
 * - 文件名带随机后缀（同 clipboard.tmpPngPath 的做法）避免同毫秒并发碰撞；
 *   落盘用 `flag:'wx'` 排他创建，避免预置符号链接把写入劫持到别处（审查发现 I-6）。
 * - 内容与初始值相同视为"取消"（用户没写东西就退出）。
 * - 编辑器不存在/异常退出返回明确错误，由调用方提示用户。
 * - 本模块不直接读写 process.stdin/stdout：子进程交互收敛在可注入的 `runEditor`，
 *   单测注入假实现即可验证临时文件往返、$EDITOR 优先级、编辑器缺失报错。
 */
import { spawn } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type EditorResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'cancel' | 'error'; error?: string }

/** 打开编辑器并等待其退出（薄封装；单测可注入假实现） */
export type RunEditorFn = (
  command: string,
  args: string[],
  file: string,
) => Promise<{ ok: true } | { ok: false; error: string }>

export type EditorOptions = {
  /** 临时文件目录（缺省 ~/.agent-cli/tmp） */
  tmpDir?: string
  /** 环境变量来源（缺省 process.env），决定 $EDITOR/$VISUAL 的取值 */
  env?: NodeJS.ProcessEnv
  /** 编辑器执行器（缺省走 child_process.spawn） */
  runEditor?: RunEditorFn
}

/** 缺省编辑器：VS Code 的 --wait 才能阻塞到用户关闭标签页 */
const DEFAULT_EDITOR = 'code --wait'

/** ~/.agent-cli 根目录（运行时读取，方便测试隔离） */
const agentCliDir = () => process.env.AGENT_CLI_DIR || join(homedir(), '.agent-cli')

/** 默认执行器：stdio 交给子进程（编辑器需要真实终端），非 0 退出码视为失败 */
const spawnEditor: RunEditorFn = (command, args, file) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args, file], { stdio: 'inherit' })
    child.on('error', (e: Error) => {
      const code = (e as NodeJS.ErrnoException).code
      resolve({
        ok: false,
        error: code === 'ENOENT' ? `编辑器不存在：${command}` : `启动编辑器失败：${e.message}`,
      })
    })
    child.on('exit', (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, error: `编辑器异常退出（退出码 ${code}）` })
    })
  })

/** 解析编辑器命令：允许 `code --wait` 这类「命令 + 参数」写法（不做 shell 展开） */
function parseEditorCommand(raw: string | undefined): { command: string; args: string[] } {
  const parts = ((raw || '').trim() || DEFAULT_EDITOR).split(/\s+/).filter(Boolean)
  return { command: parts[0], args: parts.slice(1) }
}

/** 在外部编辑器中编辑初始文本；取消/失败均返回结构化结果，不抛异常 */
export async function editInExternalEditor(
  initial: string,
  opts: EditorOptions = {},
): Promise<EditorResult> {
  const tmpDir = opts.tmpDir ?? join(agentCliDir(), 'tmp')
  const env = opts.env ?? process.env
  const runEditor = opts.runEditor ?? spawnEditor
  // $EDITOR 优先于 $VISUAL，两者都缺省时用 code --wait
  const { command, args } = parseEditorCommand(env.EDITOR || env.VISUAL)
  const file = join(tmpDir, `prompt-${Date.now()}-${Math.floor(Math.random() * 1e6)}.md`)

  try {
    mkdirSync(tmpDir, { recursive: true })
    // 'wx'：文件已存在（含预置符号链接）直接失败，绝不覆盖既有文件
    writeFileSync(file, initial, { encoding: 'utf8', flag: 'wx' })
  } catch (e: any) {
    return { ok: false, reason: 'error', error: `创建临时文件失败：${e.message}` }
  }

  try {
    const run = await runEditor(command, args, file)
    if (!run.ok) return { ok: false, reason: 'error', error: run.error }

    const content = readFileSync(file, 'utf8')
    if (content === initial) return { ok: false, reason: 'cancel' } // 未改动 = 放弃
    return { ok: true, content }
  } catch (e: any) {
    return { ok: false, reason: 'error', error: `读取编辑结果失败：${e.message}` }
  } finally {
    try {
      rmSync(file, { force: true })
    } catch {
      // 删除失败不致命（临时目录会被下次清理覆盖）
    }
  }
}
