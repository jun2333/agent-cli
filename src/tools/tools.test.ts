import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTools } from '../tools/index.js'

function tools() {
  return createTools().implementations
}

function parse(content: string): any {
  return JSON.parse(content)
}

describe('工具：参数校验', () => {
  it('read 传非字符串 path 返回错误', async () => {
    const r = await tools().read({ path: 123 as any })
    expect(parse(r.content).error).toBeTruthy()
  })

  it('write 缺 content 返回错误', async () => {
    const r = await tools().write({ path: 'x.ts' } as any)
    expect(parse(r.content).error).toBeTruthy()
  })

  it('bash 空命令返回错误', async () => {
    const r = await tools().bash({ command: '   ' })
    expect(parse(r.content).error).toBeTruthy()
  })

  it('glob 空 pattern 返回错误', async () => {
    const r = await tools().glob({ pattern: '' })
    expect(parse(r.content).error).toBeTruthy()
  })

  it('grep 无效正则返回错误', async () => {
    const r = await tools().grep({ pattern: '([unclosed' })
    expect(parse(r.content).error).toBeTruthy()
  })
})

describe('工具：路径穿越防护', () => {
  it('拒绝访问项目根之外的路径', async () => {
    const r = await tools().read({ path: '../outside.txt' })
    expect(parse(r.content).error).toContain('非法路径')
  })

  it('拒绝绝对路径指向外部', async () => {
    const r = await tools().read({ path: '/etc/passwd' })
    expect(parse(r.content).error).toContain('非法路径')
  })

  it('项目内相对路径可读', async () => {
    const r = await tools().read({ path: 'src/config.ts' })
    const data = parse(r.content)
    expect(data.path).toBe('src/config.ts')
    expect(data.content).toContain('ollamaBaseUrl')
  })
})

describe('工具：危险命令拦截', () => {
  it('拦截 rm 根目录/家目录', async () => {
    const r = await tools().bash({ command: 'rm -rf /' })
    expect(parse(r.content).error).toContain('危险命令')
  })

  it('拦截 sudo', async () => {
    const r = await tools().bash({ command: 'sudo rm -rf /etc' })
    expect(parse(r.content).error).toContain('危险命令')
  })

  it('拦截关机/重启', async () => {
    const r = await tools().bash({ command: 'reboot' })
    expect(parse(r.content).error).toContain('危险命令')
  })

  it('普通命令不拦截', async () => {
    const r = await tools().bash({ command: 'echo hello' })
    const data = parse(r.content)
    expect(data.exitCode).toBe(0)
    expect(data.stdout).toContain('hello')
  })
})

describe('工具：memory 三件套', () => {
  let tmp: string
  let origEnv: string | undefined
  beforeEach(() => {
    // 隔离 AGENT_CLI_DIR，避免写真实 ~/.agent-cli/memory
    tmp = mkdtempSync(join(tmpdir(), 'agent-cli-tools-'))
    origEnv = process.env.AGENT_CLI_DIR
    process.env.AGENT_CLI_DIR = tmp
  })
  afterEach(() => {
    if (origEnv === undefined) delete process.env.AGENT_CLI_DIR
    else process.env.AGENT_CLI_DIR = origEnv
    rmSync(tmp, { recursive: true, force: true })
  })

  it('read_memory 无 topic 返回索引；有 topic 返回内容', async () => {
    const t = tools()
    await t.append_memory({ topic: 'preferences', content: '用户喜欢 Python' })
    const idx = await t.read_memory({})
    expect(idx.content).toContain('# Memory Index')
    expect(idx.content).toContain('用户喜欢 Python')
    const detail = await t.read_memory({ topic: 'preferences' })
    expect(detail.content).toContain('用户喜欢 Python')
  })

  it('append_memory 追加多条，索引反映', async () => {
    const t = tools()
    await t.append_memory({ topic: 'project', content: '约定一' })
    await t.append_memory({ topic: 'project', content: '约定二' })
    const idx = await t.read_memory({})
    expect(idx.content).toContain('约定一')
    expect(idx.content).toContain('约定二')
  })

  it('write_memory 覆盖旧内容', async () => {
    const t = tools()
    await t.append_memory({ topic: 'project', content: '旧内容' })
    await t.write_memory({ topic: 'project', content: '新内容' })
    const detail = await t.read_memory({ topic: 'project' })
    expect(detail.content).toContain('新内容')
    expect(detail.content).not.toContain('旧内容')
  })

  it('topic 非法被拒绝（路径穿越）', async () => {
    const t = tools()
    const r = await t.append_memory({ topic: '../outside', content: 'x' })
    expect(parse(r.content).error).toBeTruthy()
  })

  it('read_memory 不存在的 topic 返回错误', async () => {
    const r = await tools().read_memory({ topic: 'nonexistent' })
    expect(parse(r.content).error).toBeTruthy()
  })
})
