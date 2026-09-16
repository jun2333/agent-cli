import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadUserConfig, saveUserConfig } from './user-config.js'

let tmp: string
let origEnv: string | undefined

const configPath = () => join(tmp, 'config.json')

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-cli-usercfg-'))
  origEnv = process.env.AGENT_CLI_DIR
  process.env.AGENT_CLI_DIR = tmp
})

afterEach(() => {
  if (origEnv === undefined) delete process.env.AGENT_CLI_DIR
  else process.env.AGENT_CLI_DIR = origEnv
  rmSync(tmp, { recursive: true, force: true })
})

describe('用户配置读写', () => {
  it('文件不存在返回 {}', () => {
    expect(loadUserConfig()).toEqual({})
  })

  it('saveUserConfig → loadUserConfig 往返一致', () => {
    saveUserConfig({ model: 'qwen3-vl:8b-thinking', thinkLevel: 'high' })
    expect(loadUserConfig()).toEqual({ model: 'qwen3-vl:8b-thinking', thinkLevel: 'high' })
  })

  it('只写 model 时 thinkLevel 缺省为空（未设置）', () => {
    saveUserConfig({ model: 'qwen3:8b' })
    const cfg = loadUserConfig()
    expect(cfg.model).toBe('qwen3:8b')
    expect(cfg.thinkLevel).toBeUndefined()
  })

  it('saveUserConfig 自动创建不存在的 ~/.agent-cli 目录', () => {
    const nested = join(tmp, 'a', 'b')
    process.env.AGENT_CLI_DIR = nested
    saveUserConfig({ model: 'qwen3:8b' })
    expect(existsSync(join(nested, 'config.json'))).toBe(true)
  })
})

describe('用户配置容错', () => {
  it('文件内容损坏（非法 JSON）返回 {}', () => {
    writeFileSync(configPath(), '{ not json')
    expect(loadUserConfig()).toEqual({})
  })

  it('顶层是数组时返回 {}', () => {
    writeFileSync(configPath(), '["x"]')
    expect(loadUserConfig()).toEqual({})
  })

  it('非法 thinkLevel 被丢弃，合法 model 保留', () => {
    writeFileSync(configPath(), JSON.stringify({ model: 'qwen3:8b', thinkLevel: 'ultra' }))
    expect(loadUserConfig()).toEqual({ model: 'qwen3:8b' })
  })

  it('model 非字符串被丢弃', () => {
    writeFileSync(configPath(), JSON.stringify({ model: 123, thinkLevel: 'max' }))
    expect(loadUserConfig()).toEqual({ thinkLevel: 'max' })
  })

  it('空白 model 被丢弃', () => {
    writeFileSync(configPath(), JSON.stringify({ model: '   ' }))
    expect(loadUserConfig()).toEqual({})
  })

  it('写入失败静默降级（目录位置被文件占用）', () => {
    const blocker = join(tmp, 'blocker')
    writeFileSync(blocker, 'not a dir')
    process.env.AGENT_CLI_DIR = blocker
    expect(() => saveUserConfig({ model: 'qwen3:8b' })).not.toThrow()
    expect(existsSync(join(blocker, 'config.json'))).toBe(false)
  })

  it('写入内容为格式化 JSON', () => {
    saveUserConfig({ model: 'qwen3:8b', thinkLevel: 'low' })
    const raw = readFileSync(configPath(), 'utf8')
    expect(raw).toContain('\n  "model": "qwen3:8b"')
  })
})

describe('用户配置路径', () => {
  it('配置写在 AGENT_CLI_DIR 覆盖后的目录下', () => {
    const custom = join(tmp, 'custom')
    mkdirSync(custom)
    process.env.AGENT_CLI_DIR = custom
    saveUserConfig({ model: 'qwen3:8b' })
    expect(existsSync(join(custom, 'config.json'))).toBe(true)
  })
})
