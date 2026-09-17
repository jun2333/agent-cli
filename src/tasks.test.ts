/**
 * tasks.test.ts — FR-2 后台任务管理（AC-7 / AC-8 / AC-9 / AC-12 / AC-13 的进程组部分）
 *
 * ⚠️ 本文件跑的是**真实子进程**（真 `sleep`、真长输出、真 `kill`、真 `ps` 复核）。
 * 理由见 lesson 011 / task-plan D-8：进程组回收（`detached` + `kill(-pid)`）是 POSIX 语义，
 * 注入式 mock 会 100% 掩盖"只杀了 sh、留下孙子进程"这类缺陷。
 *
 * 平台探针结论（B6 实测，macOS + node v26.3.0；探针脚本见 changes.md）：
 * - `spawn('sh',['-c',cmd],{detached:true})` → **pgid === child.pid**（子进程成为组长）；
 * - `process.kill(-pid, SIGTERM)` 连 `sh` 下的孙进程一起收到（探针里 `sleep 300 && x` 的孙进程被收掉）；
 * - `ESRCH` 形状 = `Error{ code:'ESRCH', message:'kill ESRCH' }`（组已空 / 对非组长用负 pid）；
 * - 组长被 `SIGKILL` 后若组内已无成员 → 组消失，`kill(-pgid)` 抛 `ESRCH`（按"已退出"处理）；
 * - `trap '' TERM` 的组会**忽略 SIGTERM** → 必须有 SIGKILL 兜底（否则 AC-13 会留孤儿）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cleanupTaskLogs, RingBuffer, TASK_ID_PATTERN, TaskManager, tasksDir } from './tasks.js'

let tmp: string
let origEnv: string | undefined
let mgr: TaskManager

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 轮询直到条件成立（真实进程的退出/输出落盘是异步的，固定 sleep 会脆弱） */
async function waitFor(fn: () => boolean, timeoutMs = 8000, label = '条件'): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时：${label}`)
    await sleep(20)
  }
}

/** 该进程组当前的存活成员（`ps -ax` 必须带 -ax：detached 子进程在别的 session，裸 ps 看不到） */
function groupMembers(pgid: number): Array<{ pid: number; command: string }> {
  const out = execSync('ps -o pid=,pgid=,command= -ax', { encoding: 'utf8' })
  return out
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null && Number(m[2]) === pgid)
    .map((m) => ({ pid: Number(m[1]), command: m[3] }))
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-cli-tasks-'))
  origEnv = process.env.AGENT_CLI_DIR
  process.env.AGENT_CLI_DIR = tmp
  mgr = new TaskManager({ cwd: process.cwd() })
})

afterEach(async () => {
  // 兜底清理：任何用例失败/超时都不留僵尸进程（否则 `ps` 复核会假阳性、vitest 也可能挂住）
  await mgr.killAll().catch(() => {})
  if (origEnv === undefined) delete process.env.AGENT_CLI_DIR
  else process.env.AGENT_CLI_DIR = origEnv
  rmSync(tmp, { recursive: true, force: true })
})

describe('FR-2/AC-7：start 立即返回 {taskId,pid} 且进程仍在运行', () => {
  it('1s 内返回，task_id 只由代码生成且匹配 ^[a-z0-9-]+$', async () => {
    const t0 = Date.now()
    const info = mgr.start('sleep 30')
    const elapsed = Date.now() - t0

    expect(elapsed).toBeLessThan(1000) // AC-7 的硬指标：不阻塞
    expect(info.taskId).toMatch(TASK_ID_PATTERN)
    expect(info.pid).toBeGreaterThan(0)

    const rec = mgr.get(info.taskId)
    expect(rec).toBeDefined()
    expect(rec!.state).toBe('running')
    expect(rec!.command).toBe('sleep 30')
    expect(mgr.size).toBe(1)

    // 进程真的在（`process.kill(pid,0)` = 探活）；顺带确认 detached 生效（pgid === pid）
    expect(groupMembers(info.pid).length).toBeGreaterThan(0)
    const pg = execFileSync('ps', ['-o', 'pgid=', '-p', String(info.pid)], { encoding: 'utf8' }).trim()
    expect(Number(pg)).toBe(info.pid)
  })

  it('命令立即失败（command-not-found）也不抛：仍返回 task，随后读到非 0 退出码与 stderr', async () => {
    const info = mgr.start('definitely-not-a-command-xyz')
    expect(info.pid).toBeGreaterThan(0)
    await waitFor(() => mgr.get(info.taskId)!.state !== 'running', 8000, '任务退出')
    const out = mgr.readOutput(info.taskId)!
    expect(out.running).toBe(false)
    expect(out.exitCode).not.toBe(0)
    expect(out.output).toContain('definitely-not-a-command-xyz')
  })
})

describe('FR-2/AC-8：bash_output 的增量语义', () => {
  it('第二次读取只含新增输出，并始终标注是否仍在运行', async () => {
    const info = mgr.start(`printf 'one\\n'; sleep 0.4; printf 'two\\n'; sleep 30`)

    // 注意：用 buffer.tail 探测，**不要**用 readOutput 探测 —— readOutput 会推进读取游标，
    // 那样第一次 readOutput 就只剩"新内容"，增量断言会假失败。
    await waitFor(() => mgr.get(info.taskId)!.buffer.tail(5).includes('one'), 8000, '第一段输出')
    const first = mgr.readOutput(info.taskId)!
    expect(first.output).toContain('one')
    expect(first.running).toBe(true)
    expect(first.exitCode).toBeNull()

    await waitFor(() => mgr.get(info.taskId)!.buffer.tail(5).includes('two'), 8000, '第二段输出')
    const second = mgr.readOutput(info.taskId)!
    expect(second.output).toContain('two')
    expect(second.output).not.toContain('one') // 增量：不重发已读过的内容
    expect(second.running).toBe(true)
  })

  it('任务退出后 running=false 且带退出码；再次读取不再重复旧内容', async () => {
    const info = mgr.start(`printf 'done\\n'`)
    await waitFor(() => mgr.get(info.taskId)!.state !== 'running', 8000, '任务退出')

    const first = mgr.readOutput(info.taskId)!
    expect(first.output).toContain('done')
    expect(first.running).toBe(false)
    expect(first.exitCode).toBe(0)

    const second = mgr.readOutput(info.taskId)!
    expect(second.output).toBe('')
  })

  it('未命中的 task_id（含路径穿越形状）返回 null，不触达文件系统', () => {
    for (const bad of ['nope', '../escape', 'task-1-0/../../etc/passwd', '/etc/passwd', '', 'TASK-1-0']) {
      expect(mgr.readOutput(bad)).toBeNull()
      expect(mgr.get(bad)).toBeUndefined()
    }
  })
})

describe('FR-2/AC-9：kill_task 终止并幂等', () => {
  it('kill 后进程组内无存活成员，state=killed；重复 kill 返回 alreadyExited 不抛', async () => {
    const info = mgr.start('sleep 60')
    expect(groupMembers(info.pid).length).toBeGreaterThan(0)

    const r1 = await mgr.kill(info.taskId)
    expect(r1).toEqual({ taskId: info.taskId, killed: true, alreadyExited: false })
    expect(groupMembers(info.pid)).toEqual([]) // AC-13 的核心：不留孤儿
    expect(mgr.get(info.taskId)!.state).toBe('killed')

    const r2 = await mgr.kill(info.taskId)
    expect(r2).toEqual({ taskId: info.taskId, killed: false, alreadyExited: true })

    const out = mgr.readOutput(info.taskId)!
    expect(out.running).toBe(false)
  })

  it('已自然退出的任务：kill 返回 alreadyExited，不抛', async () => {
    const info = mgr.start('true')
    await waitFor(() => mgr.get(info.taskId)!.state !== 'running', 8000, '任务退出')
    const r = await mgr.kill(info.taskId)
    expect(r).toEqual({ taskId: info.taskId, killed: false, alreadyExited: true })
  })

  it('未知 task_id 返回 null（调用方转成错误结果；绝不拼路径）', async () => {
    expect(await mgr.kill('task-not-exist-0')).toBeNull()
    expect(await mgr.kill('../etc/passwd')).toBeNull()
  })

  it('SIGTERM 被忽略时用 SIGKILL 兜底（依赖 trap 的顽固进程也能收掉）', async () => {
    const info = mgr.start(`trap '' TERM; while :; do sleep 1; done`)
    await waitFor(() => groupMembers(info.pid).length > 0, 8000, '进程起来')
    expect(groupMembers(info.pid).length).toBeGreaterThanOrEqual(2) // sh + 至少一个 sleep 孙进程

    const r = await mgr.kill(info.taskId)
    expect(r!.killed).toBe(true)
    expect(groupMembers(info.pid)).toEqual([])
  })

  it('连带孙进程一起收（sh -c 的进程树，AC-13 的真正难点）', async () => {
    const info = mgr.start('sleep 59 & sleep 58')
    await waitFor(() => groupMembers(info.pid).length >= 3, 8000, '进程树长起来')
    expect(groupMembers(info.pid).length).toBeGreaterThanOrEqual(3)

    await mgr.kill(info.taskId)
    expect(groupMembers(info.pid)).toEqual([])
  })
})

describe('FR-2/AC-12：内存环形缓冲 2000 行 / 256KB + 落盘 tasks/<id>.log', () => {
  it('3000 行输出：缓冲只留最近 2000 行且记 droppedLines，日志文件保留全部 3000 行', async () => {
    const info = mgr.start(`i=0; while [ $i -lt 3000 ]; do printf 'line-%s\\n' "$i"; i=$((i+1)); done`)
    await waitFor(() => mgr.get(info.taskId)!.state !== 'running', 15000, '任务退出')

    const rec = mgr.get(info.taskId)!
    expect(rec.logPath).not.toBeNull()
    expect(rec.logPath!.startsWith(tasksDir())).toBe(true)
    // 缓冲与日志落盘都是异步的 → 各自轮询到位再断言（固定 sleep 会脆弱）
    await waitFor(() => rec.buffer.totalLines === 3000, 15000, '缓冲收齐 3000 行')
    await waitFor(() => {
      try {
        return readFileSync(rec.logPath!, 'utf8').split('\n').filter((l) => l.trim()).length === 3000
      } catch {
        return false
      }
    }, 15000, '日志落盘 3000 行')

    expect(rec.buffer.totalLines).toBe(3000)
    expect(rec.buffer.droppedLines).toBe(1000)
    expect(rec.buffer.tail(1)).toBe('line-2999')
    expect(rec.buffer.tail(2000)).toContain('line-1000')
    expect(rec.buffer.tail(2000)).not.toContain('line-999\n')

    // 日志落盘不截断（磁盘上是完整输出）
    const logLines = readFileSync(rec.logPath!, 'utf8').split('\n').filter((l) => l.trim())
    expect(logLines).toHaveLength(3000)
    expect(logLines[2999]).toBe('line-2999')
  })

  it('300 行 × 2001B（≈600KB）：按字节裁剪（不超 256KB），droppedBytes > 0', async () => {
    const info = mgr.start(`i=0; while [ $i -lt 300 ]; do printf '%2000s\\n' x; i=$((i+1)); done`)
    await waitFor(() => mgr.get(info.taskId)!.state !== 'running', 15000, '任务退出')

    const rec = mgr.get(info.taskId)!
    expect(rec.buffer.totalBytes).toBeGreaterThan(256 * 1024)
    expect(rec.buffer.droppedBytes).toBeGreaterThan(0)
    expect(rec.buffer.totalBytes - rec.buffer.droppedBytes).toBeLessThanOrEqual(256 * 1024)
  })

  it('日志落盘不可用（AGENT_CLI_DIR 指向一个文件）时降级为仅内存缓冲，不抛', async () => {
    const blocked = join(tmp, 'not-a-dir')
    writeFileSync(blocked, 'x')
    process.env.AGENT_CLI_DIR = blocked
    const m = new TaskManager({ cwd: process.cwd() })
    try {
      const info = m.start(`printf 'still-works\\n'`)
      expect(m.get(info.taskId)!.logPath).toBeNull()
      await waitFor(() => m.get(info.taskId)!.state !== 'running', 8000, '任务退出')
      expect(m.readOutput(info.taskId)!.output).toContain('still-works')
    } finally {
      await m.killAll().catch(() => {})
    }
  })

  it('回归（B7）：日志流的异步 open 失败（tasks 目录被并发删除）→ 降级为仅内存缓冲，无 unhandled error', async () => {
    // 复现 B6b 的竞态：createWriteStream 的 open 在线程池里异步进行，start() 返回后立刻删掉
    // tasks 目录 → open 以 ENOENT/EINVAL 'error' 事件落地。修复前它成为进程级 unhandled error
    //（整轮测试报错）；修复后降级为仅内存缓冲。rmSync 在主线程同步执行、open 在更晚的线程池
    // tick 里进行，因此这里的失败是确定性触发的。
    const info = mgr.start(`printf 'buffer-only\\n'; sleep 5`)
    rmSync(join(tmp, 'tasks'), { recursive: true, force: true })

    await waitFor(() => mgr.get(info.taskId)!.buffer.totalLines > 0, 8000, '内存缓冲收到输出')
    const rec = mgr.get(info.taskId)!
    expect(rec.buffer.tail(1)).toBe('buffer-only')
    // readOutput 正常工作（读的是内存缓冲，不依赖日志流）
    expect(mgr.readOutput(info.taskId)!.output).toContain('buffer-only')
  })
})

describe('FR-2/AC-13：killAll 返回被终止清单（真实进程 + ps 复核）', () => {
  it('两个后台任务全部被终止，清单含 id/命令，ps 复核无孤儿', async () => {
    const a = mgr.start('sleep 56')
    const b = mgr.start('sleep 55 & sleep 54')
    await waitFor(() => groupMembers(a.pid).length > 0 && groupMembers(b.pid).length >= 3, 8000, '任务起来')

    const killed = await mgr.killAll()

    expect(killed).toHaveLength(2)
    expect(killed.map((k) => k.taskId).sort()).toEqual([a.taskId, b.taskId].sort())
    expect(killed.every((k) => k.killed)).toBe(true)
    expect(killed.find((k) => k.taskId === a.taskId)!.command).toBe('sleep 56')
    expect(groupMembers(a.pid)).toEqual([])
    expect(groupMembers(b.pid)).toEqual([])
    expect(mgr.size).toBe(2) // 记录仍可查询（用于列表展示），但都已非 running
    expect(mgr.list().every((r) => r.state !== 'running')).toBe(true)
  })

  it('没有存活任务时 killAll 返回空数组（退出时清单不打印，保 AC-15 的"只剩一行 bye"）', async () => {
    expect(await mgr.killAll()).toEqual([])
  })
})

describe('FR-2：日志清理（保留 7 天）', () => {
  it('只删 mtime 超过保留期的 .log，不影响新日志与非日志文件', () => {
    const dir = tasksDir()
    mkdirSync(dir, { recursive: true })
    const oldLog = join(dir, 'task-old-1.log')
    const newLog = join(dir, 'task-new-1.log')
    const other = join(dir, 'keep.txt')
    writeFileSync(oldLog, 'old')
    writeFileSync(newLog, 'new')
    writeFileSync(other, 'x')
    const tenDaysAgo = new Date(Date.now() - 10 * 86400_000)
    utimesSync(oldLog, tenDaysAgo, tenDaysAgo)

    const removed = cleanupTaskLogs(7, Date.now())

    expect(removed).toBe(1)
    expect(existsSync(oldLog)).toBe(false)
    expect(existsSync(newLog)).toBe(true)
    expect(existsSync(other)).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(['keep.txt', 'task-new-1.log'])
  })
})

describe('RingBuffer：纯逻辑边界（单测，AC-12 的口径）', () => {
  it('行数上限：超出即丢最旧的，droppedLines 累计', () => {
    const b = new RingBuffer(3, 1024 * 1024)
    b.push('a\nb\nc\nd\n')
    expect(b.totalLines).toBe(4)
    expect(b.droppedLines).toBe(1)
    expect(b.tail(10)).toBe('b\nc\nd')
  })

  it('未换行的末行也参与读取；续写时增量读取只给新增的尾巴（不重复已发内容）', () => {
    const b = new RingBuffer(10, 1024)
    b.push('par')
    b.push('tial')
    b.push('\nnext')
    expect(b.totalLines).toBe(1) // 'partial' 已换行结束；'next' 仍未完成
    expect(b.tail(10)).toBe('partial\nnext')

    const r1 = b.readSince(0)
    expect(r1.text).toBe('partial\nnext')
    expect(r1.cursor).toBe(1)

    b.push('-tail') // 续写同一个未完成行
    const r2 = b.readSince(r1.cursor)
    expect(r2.text).toBe('-tail') // 只发新增部分，不重发 'next'
    expect(b.tail(10)).toBe('partial\nnext-tail')
  })

  it('readSince：cursor 落后于环形窗口时标记 dropped', () => {
    const b = new RingBuffer(2, 1024 * 1024)
    b.push('a\nb\nc\n')
    const r = b.readSince(0)
    expect(r.dropped).toBe(true)
    expect(r.text).toBe('b\nc')
    expect(r.cursor).toBe(3)
  })

  it('字节上限：单行超上限时按字节裁该行，不无限增长', () => {
    const b = new RingBuffer(100, 10)
    b.push('x'.repeat(100)) // 单行 100B > 10B
    expect(b.totalBytes - b.droppedBytes).toBeLessThanOrEqual(10)
    expect(b.tail(1).length).toBeLessThanOrEqual(10)
  })

  it('tail(0) 返回空串（/jobs 的退化输入不炸）', () => {
    const b = new RingBuffer()
    b.push('a\nb\n')
    expect(b.tail(0)).toBe('')
  })
})
