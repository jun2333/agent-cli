import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureAgentCliDir,
  newSessionId,
  saveSession,
  loadSession,
  hydrateImages,
  listSessions,
  acquireSessionLock,
  releaseSessionLock,
  isSessionLocked,
  sessionWorkspaceDir,
  memoryTopicToFile,
  readMemoryIndex,
  readMemoryTopic,
  appendMemory,
  writeMemory,
  migrateLegacyMemory,
} from './session.js'

let tmp: string
let origEnv: string | undefined
let origCwd: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-cli-test-'))
  origEnv = process.env.AGENT_CLI_DIR
  process.env.AGENT_CLI_DIR = tmp
  origCwd = process.cwd()
  ensureAgentCliDir()
})

afterEach(() => {
  if (origEnv === undefined) delete process.env.AGENT_CLI_DIR
  else process.env.AGENT_CLI_DIR = origEnv
  process.chdir(origCwd)
  rmSync(tmp, { recursive: true, force: true })
})

describe('会话读写', () => {
  it('saveSession → loadSession 往返一致，且过滤 system 消息', () => {
    const id = newSessionId()
    const msgs = [
      { role: 'system', content: 'should-drop' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
    ]
    saveSession(msgs as any, id)
    const loaded = loadSession(id)
    expect(loaded).toHaveLength(2)
    expect(loaded?.[0]).toEqual({ role: 'user', content: '你好' })
  })

  it('loadSession 不存在的 id 返回 null', () => {
    expect(loadSession('session-nonexistent')).toBeNull()
  })

  it('newSessionId 生成唯一 id', () => {
    expect(newSessionId()).not.toBe(newSessionId())
  })
})

describe('图片剥离与恢复', () => {
  const imgPath = () => join(process.env.AGENT_CLI_DIR!, 'a.png')

  /** 造一条带图片的 user 消息（图片部件携带 path/name，与 ui/input-buffer 的产出格式一致） */
  const withImage = (path: string, name = 'a.png') => ({
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, path, name },
      { type: 'text', text: '说明' },
    ],
  })

  const writePng = () => writeFileSync(imgPath(), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  it('写盘内容不含 data:image，图片被替换为 image_ref', () => {
    writePng()
    const id = newSessionId()
    saveSession([withImage(imgPath())] as any, id)
    const raw = readFileSync(join(sessionWorkspaceDir(), `${id}.json`), 'utf8')
    expect(raw).not.toContain('data:image')
    expect(raw).toContain('image_ref')
    expect(raw).toContain('a.png')
  })

  it('hydrateImages 在文件仍在时还原为 image_url，且位置不变', () => {
    writePng()
    const id = newSessionId()
    saveSession([withImage(imgPath())] as any, id)
    const restored = hydrateImages(loadSession(id)!)
    const content = (restored[0] as any).content
    expect(content.map((p: any) => p.type)).toEqual(['text', 'image_url', 'text'])
    expect(content[1].image_url.url.startsWith('data:image/png;base64,')).toBe(true)
    expect(content[1].path).toBe(imgPath())
    expect(content[2].text).toBe('说明')
  })

  it('图片文件已删除时降级为 [图片已失效: 文件名] 文本', () => {
    const id = newSessionId()
    saveSession([withImage(join(tmp, 'gone.png'), 'gone.png')] as any, id)
    const restored = hydrateImages(loadSession(id)!)
    const content = (restored[0] as any).content
    expect(content.map((p: any) => p.type)).toEqual(['text', 'text', 'text'])
    expect(content[1].text).toBe('[图片已失效: gone.png]')
  })

  it('恢复后再保存不会退化为失效标记（幂等往返）', () => {
    writePng()
    const id = newSessionId()
    saveSession([withImage(imgPath())] as any, id)
    const restored = hydrateImages(loadSession(id)!)
    saveSession(restored, id)
    const again = hydrateImages(loadSession(id)!)
    const content = (again[0] as any).content
    expect(content.map((p: any) => p.type)).toEqual(['text', 'image_url', 'text'])
    const raw = readFileSync(join(sessionWorkspaceDir(), `${id}.json`), 'utf8')
    expect(raw).not.toContain('data:image')
  })

  it('tool 消息里的图片同样被剥离', () => {
    writePng()
    const id = newSessionId()
    const toolMsg = {
      role: 'tool',
      tool_call_id: 'call_1',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, path: imgPath(), name: 'a.png' }],
    }
    saveSession([toolMsg] as any, id)
    const raw = readFileSync(join(sessionWorkspaceDir(), `${id}.json`), 'utf8')
    expect(raw).not.toContain('data:image')
    const restored = hydrateImages(loadSession(id)!)
    expect((restored[0] as any).content[0].type).toBe('image_url')
  })

  it('无图片的消息不受影响（回归：纯文本与 content=null 原样保留）', () => {
    const id = newSessionId()
    const msgs = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ]
    saveSession(msgs as any, id)
    const loaded = loadSession(id)
    expect(loaded).toEqual(msgs)
    const hydrated = hydrateImages(loaded!)
    expect(hydrated).toEqual(msgs)
    // 纯文本数组内容（无图片）也不受影响
    const textParts = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]
    saveSession(textParts as any, id)
    expect(hydrateImages(loadSession(id)!)).toEqual(textParts)
  })
})

describe('workspace 隔离', () => {
  it('不同 cwd 的会话互相隔离', () => {
    const wsA = join(tmp, 'ws-a')
    const wsB = join(tmp, 'ws-b')
    mkdirSync(wsA)
    mkdirSync(wsB)

    process.chdir(wsA)
    const idA = newSessionId()
    saveSession([{ role: 'user', content: 'A 的会话' }], idA)

    process.chdir(wsB)
    const idB = newSessionId()
    saveSession([{ role: 'user', content: 'B 的会话' }], idB)

    // A 目录只看到自己的会话
    process.chdir(wsA)
    const listA = listSessions()
    expect(listA).toHaveLength(1)
    expect(listA[0].id).toBe(idA)

    // B 目录只看到自己的会话
    process.chdir(wsB)
    const listB = listSessions()
    expect(listB).toHaveLength(1)
    expect(listB[0].id).toBe(idB)
  })
})

describe('会话锁', () => {
  it('首次获取成功，自己持有的锁对自身不算锁', () => {
    const id = newSessionId()
    expect(acquireSessionLock(id)).toBe(true)
    expect(isSessionLocked(id)).toBe(false) // 排除自身 pid
  })

  it('其他活进程持锁时拒绝获取，且 isSessionLocked 为 true', () => {
    const id = newSessionId()
    // 用父进程 pid 模拟"他人持有"（父进程一定存活）
    writeFileSync(join(sessionWorkspaceDir(), `${id}.lock`), JSON.stringify({ pid: process.ppid }))
    expect(isSessionLocked(id)).toBe(true)
    expect(acquireSessionLock(id)).toBe(false)
  })

  it('过期锁（持有者已死）可接管', () => {
    const id = newSessionId()
    writeFileSync(join(sessionWorkspaceDir(), `${id}.lock`), JSON.stringify({ pid: 999999999 }))
    expect(isSessionLocked(id)).toBe(false)
    expect(acquireSessionLock(id)).toBe(true) // 接管成功
  })

  it('releaseSessionLock 释放后他人可获取', () => {
    const id = newSessionId()
    acquireSessionLock(id)
    releaseSessionLock(id)
    // 释放后锁文件删除，他人视角 isSessionLocked 为 false
    expect(isSessionLocked(id)).toBe(false)
  })

  it('releaseSessionLock 不影响他人持有的锁', () => {
    const id = newSessionId()
    writeFileSync(join(sessionWorkspaceDir(), `${id}.lock`), JSON.stringify({ pid: process.ppid }))
    releaseSessionLock(id) // 锁持有者不是自己，不应删除
    expect(isSessionLocked(id)).toBe(true)
  })

  it('listSessions 标记被锁会话', () => {
    const id = newSessionId()
    saveSession([{ role: 'user', content: 'hi' }], id)
    writeFileSync(join(sessionWorkspaceDir(), `${id}.lock`), JSON.stringify({ pid: process.ppid }))
    const list = listSessions()
    expect(list[0].locked).toBe(true)
  })
})

describe('memory 索引化', () => {
  it('memoryTopicToFile 安全校验', () => {
    expect(memoryTopicToFile('preferences')).toBe('preferences.md')
    expect(memoryTopicToFile('')).toBeNull()
    expect(memoryTopicToFile('index')).toBeNull()
    expect(memoryTopicToFile('../etc')).toBeNull()
    expect(memoryTopicToFile('a/b')).toBeNull()
    expect(memoryTopicToFile('a\\b')).toBeNull()
  })

  it('appendMemory 追加并自动更新索引', () => {
    const r1 = appendMemory('preferences', '用户喜欢 Python')
    expect(r1.ok).toBe(true)
    const r2 = appendMemory('preferences', '回答用中文')
    expect(r2.ok).toBe(true)
    const idx = readMemoryIndex()
    expect(idx).toContain('# Memory Index')
    expect(idx).toContain('## preferences')
    expect(idx).toContain('用户喜欢 Python')
    expect(idx).toContain('回答用中文')
  })

  it('writeMemory 覆盖并重建索引', () => {
    appendMemory('project', '旧约定')
    writeMemory('project', '新约定：验证用 pnpm build')
    const idx = readMemoryIndex()
    expect(idx).toContain('新约定：验证用 pnpm build')
    expect(idx).not.toContain('旧约定')
  })

  it('readMemoryTopic 返回内容；不存在返回错误', () => {
    appendMemory('preferences', '测试记忆')
    const r = readMemoryTopic('preferences')
    expect(r.ok && r.content).toContain('测试记忆')
    const missing = readMemoryTopic('nonexistent-topic')
    expect(missing.ok).toBe(false)
    const bad = readMemoryTopic('../etc')
    expect(bad.ok).toBe(false)
  })

  it('migrateLegacyMemory 迁移旧版 memory.md', () => {
    const dir = join(process.env.AGENT_CLI_DIR!, 'memory')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'memory.md'), '旧版记忆内容')
    migrateLegacyMemory()
    expect(readMemoryIndex()).toContain('旧版记忆内容')
    expect(existsSync(join(dir, 'preferences.md'))).toBe(true)
    expect(existsSync(join(dir, 'memory.md'))).toBe(false)
  })
})
