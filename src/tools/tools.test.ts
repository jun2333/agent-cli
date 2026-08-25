import { describe, it, expect } from 'vitest'
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
