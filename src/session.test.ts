import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureAgentCliDir,
  newSessionId,
  saveSession,
  loadSession,
  listSessions,
  acquireSessionLock,
  releaseSessionLock,
  isSessionLocked,
  sessionWorkspaceDir,
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
