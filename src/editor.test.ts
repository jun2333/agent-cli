import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { editInExternalEditor } from './editor.js'
import type { RunEditorFn } from './editor.js'

let tmp: string
let origEnv: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-cli-editor-'))
  origEnv = process.env.AGENT_CLI_DIR
  process.env.AGENT_CLI_DIR = tmp
})

afterEach(() => {
  vi.restoreAllMocks()
  if (origEnv === undefined) delete process.env.AGENT_CLI_DIR
  else process.env.AGENT_CLI_DIR = origEnv
  rmSync(tmp, { recursive: true, force: true })
})

/** 记录调用参数的假执行器；可选地改写临时文件内容 */
function fakeEditor(onRun?: (file: string) => void): { fn: RunEditorFn; calls: Array<{ command: string; args: string[]; file: string }> } {
  const calls: Array<{ command: string; args: string[]; file: string }> = []
  const fn: RunEditorFn = async (command, args, file) => {
    calls.push({ command, args, file })
    onRun?.(file)
    return { ok: true }
  }
  return { fn, calls }
}

const tmpDir = () => join(tmp, 'tmp')

describe('编辑器往返：临时文件', () => {
  it('写初始内容 → 编辑器改动 → 返回新内容，并删除临时文件', async () => {
    const { fn, calls } = fakeEditor((f) => writeFileSync(f, '# 新提示词\n内容', 'utf8'))
    const r = await editInExternalEditor('初始内容', { tmpDir: tmpDir(), env: {}, runEditor: fn })

    expect(r).toEqual({ ok: true, content: '# 新提示词\n内容' })
    expect(calls).toHaveLength(1)
    expect(basename(calls[0].file)).toMatch(/^prompt-\d+-\d+\.md$/)
    expect(existsSync(calls[0].file)).toBe(false)
  })

  it('临时文件写在注入的 tmpDir 下，且初始内容已写入', async () => {
    let seen = ''
    const { fn } = fakeEditor((f) => {
      seen = readFileSync(f, 'utf8')
      writeFileSync(f, 'changed', 'utf8')
    })
    await editInExternalEditor('原始输入', { tmpDir: tmpDir(), env: {}, runEditor: fn })
    expect(seen).toBe('原始输入')
  })

  it('自动创建不存在的 tmpDir', async () => {
    const nested = join(tmp, 'a', 'b', 'tmp')
    const { fn, calls } = fakeEditor((f) => writeFileSync(f, 'x', 'utf8'))
    await editInExternalEditor('init', { tmpDir: nested, env: {}, runEditor: fn })
    expect(calls[0].file.startsWith(nested + '/')).toBe(true)
  })

  it('内容未改动视为取消', async () => {
    const { fn, calls } = fakeEditor() // 不改文件
    const r = await editInExternalEditor('原样退出', { tmpDir: tmpDir(), env: {}, runEditor: fn })
    expect(r).toEqual({ ok: false, reason: 'cancel' })
    expect(existsSync(calls[0].file)).toBe(false)
  })

  it('创建临时文件失败时返回错误（tmpDir 被文件占用）', async () => {
    const blocker = join(tmp, 'blocker')
    writeFileSync(blocker, 'not a dir')
    const { fn } = fakeEditor((f) => writeFileSync(f, 'x', 'utf8'))
    const r = await editInExternalEditor('init', { tmpDir: blocker, env: {}, runEditor: fn })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('error')
    expect(r.error).toContain('创建临时文件失败')
  })

  it('临时文件名含随机成分：同毫秒两次调用不重名（I-6）', async () => {
    // 固定时间戳、只让随机后缀不同 —— 证明"不重名"来自随机成分而非时间推进
    vi.spyOn(Date, 'now').mockReturnValue(1758000000000)
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0.9)

    const names: string[] = []
    for (const content of ['第一次', '第二次']) {
      const { fn, calls } = fakeEditor((f) => writeFileSync(f, content, 'utf8'))
      await editInExternalEditor('init', { tmpDir: tmpDir(), env: {}, runEditor: fn })
      names.push(basename(calls[0].file))
    }

    expect(names[0]).toMatch(/^prompt-1758000000000-\d+\.md$/)
    expect(names[1]).toMatch(/^prompt-1758000000000-\d+\.md$/)
    expect(names[0]).not.toBe(names[1])
  })

  it('已存在同名临时文件时排他创建失败，返回结构化错误且不覆盖（I-6）', async () => {
    const ts = 1758000000000
    vi.spyOn(Date, 'now').mockReturnValue(ts)
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // 后缀固定为 500000，便于预置同名文件

    mkdirSync(tmpDir(), { recursive: true })
    const occupied = join(tmpDir(), `prompt-${ts}-500000.md`)
    writeFileSync(occupied, '已被占用的内容', 'utf8')

    const { fn, calls } = fakeEditor((f) => writeFileSync(f, 'x', 'utf8'))
    const r = await editInExternalEditor('init', { tmpDir: tmpDir(), env: {}, runEditor: fn })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('error')
    expect(r.error).toContain('创建临时文件失败')
    expect(readFileSync(occupied, 'utf8')).toBe('已被占用的内容') // 未被覆盖
    expect(calls).toHaveLength(0) // 未启动编辑器
  })
})

describe('编辑器往返：编辑器解析', () => {
  it('$EDITOR 优先于 $VISUAL', async () => {
    const { fn, calls } = fakeEditor((f) => writeFileSync(f, 'x', 'utf8'))
    await editInExternalEditor('i', {
      tmpDir: tmpDir(),
      env: { EDITOR: 'vim', VISUAL: 'nano' },
      runEditor: fn,
    })
    expect(calls[0].command).toBe('vim')
    expect(calls[0].args).toEqual([])
  })

  it('只有 $VISUAL 时用 $VISUAL', async () => {
    const { fn, calls } = fakeEditor((f) => writeFileSync(f, 'x', 'utf8'))
    await editInExternalEditor('i', { tmpDir: tmpDir(), env: { VISUAL: 'nano' }, runEditor: fn })
    expect(calls[0].command).toBe('nano')
  })

  it('两者都缺省时用 code --wait', async () => {
    const { fn, calls } = fakeEditor((f) => writeFileSync(f, 'x', 'utf8'))
    await editInExternalEditor('i', { tmpDir: tmpDir(), env: {}, runEditor: fn })
    expect(calls[0].command).toBe('code')
    expect(calls[0].args).toEqual(['--wait'])
  })

  it('编辑器命令支持带参数（"code --wait"）', async () => {
    const { fn, calls } = fakeEditor((f) => writeFileSync(f, 'x', 'utf8'))
    await editInExternalEditor('i', {
      tmpDir: tmpDir(),
      env: { EDITOR: 'code --wait --reuse-window' },
      runEditor: fn,
    })
    expect(calls[0].command).toBe('code')
    expect(calls[0].args).toEqual(['--wait', '--reuse-window'])
  })

  it('$EDITOR 为空白字符串时回退缺省值', async () => {
    const { fn, calls } = fakeEditor((f) => writeFileSync(f, 'x', 'utf8'))
    await editInExternalEditor('i', { tmpDir: tmpDir(), env: { EDITOR: '   ' }, runEditor: fn })
    expect(calls[0].command).toBe('code')
  })
})

describe('编辑器往返：错误处理', () => {
  it('编辑器不存在时返回明确错误（真实 spawn ENOENT）', async () => {
    const r = await editInExternalEditor('init', {
      tmpDir: tmpDir(),
      env: { EDITOR: 'definitely-not-an-editor-xyz' },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('error')
    expect(r.error).toContain('编辑器不存在')
    expect(readdirSync(tmpDir())).toHaveLength(0) // 临时文件已清理
  })

  it('编辑器非 0 退出码视为错误（真实 spawn false）', async () => {
    const r = await editInExternalEditor('init', { tmpDir: tmpDir(), env: { EDITOR: 'false' } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('error')
    expect(r.error).toContain('异常退出')
  })

  it('执行器返回失败时透传错误信息', async () => {
    const r = await editInExternalEditor('init', {
      tmpDir: tmpDir(),
      env: {},
      runEditor: async () => ({ ok: false, error: '自定义失败原因' }),
    })
    expect(r).toEqual({ ok: false, reason: 'error', error: '自定义失败原因' })
  })
})
