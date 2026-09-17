/**
 * tasks.ts — 后台任务的生命周期与输出留存（FR-2 / AC-7~AC-13）
 *
 * 为什么要有中央 `TaskManager`（design.md Decision 4 / Option B）：
 * `bash_output`/`kill_task` 是**独立工具**，无法访问 `bash.impl` 闭包里的子进程状态；
 * 退出时还要能**枚举**全部存活任务（AC-13）。中央注册表是唯一可行结构。
 *
 * 进程组回收（AC-13 的核心，**已实测**，见 changes.md 的平台探针结论）：
 * ```
 * spawn('sh',['-c',cmd],{detached:true,stdio:['ignore','pipe','pipe']})
 *   → detached 使子进程成为新进程组组长：pgid === child.pid      （探针确认）
 * kill(id):  process.kill(-pid,'SIGTERM')  // 负 pid = 整组，含 sh 下的孙进程（探针确认）
 *            等 exit，最多 taskKillGraceMs
 *            仍未退出 → process.kill(-pid,'SIGKILL')            （trap '' TERM 的组必须靠它）
 * ```
 * `ESRCH`（组已不存在 / 对非组长用负 pid）与 `EPERM`（无权）都按"已退出"处理，不抛。
 * **已知不可迁移项**：子进程若自己 `setsid()` 另开会话，就脱离了本进程组、无法回收
 * （与 Claude Code 的同类限制一致）；不做 Windows 进程组回收（`kill(-pid)` 是 POSIX 语义）。
 *
 * 安全边界（lesson 004 / lesson 008）：
 * - `<task-id>` **只由代码生成**（`task-<base36 时间>-<seq>`）并做 `^[a-z0-9-]+$` 白名单校验；
 * - `task_id` 参数**只做 `Map` 查表**（`get`/`readOutput`/`kill`），未命中返回 null；
 *   绝不用它去拼路径 → 路径穿越在结构上不可能（`../` 一定查不到表）。
 */
import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, type WriteStream } from 'fs'
import { join } from 'path'
import { agentCliDir } from './images.js'

/** task id 白名单（与 `task-<时间>-<seq>` 的生成规则同源） */
export const TASK_ID_PATTERN = /^[a-z0-9-]+$/

/** 任务日志目录名（`agentCliDir()/tasks`，与 FR-8 的 hooks 配置同级） */
export const TASKS_DIR_NAME = 'tasks'

/** 后台任务的日志目录（受 `AGENT_CLI_DIR` 覆盖，便于测试隔离） */
export function tasksDir(): string {
  return join(agentCliDir(), TASKS_DIR_NAME)
}

/** 行尾：CRLF 必须整体匹配，否则会多算一行（与 truncate.ts 同一口径，lesson 012） */
const LINE_END = /\r\n|\r|\n/

export type TaskState = 'running' | 'exited' | 'killed'

export type TaskRecord = {
  /** `task-<base36 时间>-<seq>`（代码生成 + 白名单校验） */
  id: string
  command: string
  /** detached → 同时是进程组 id（pgid） */
  pid: number
  startedAt: number
  state: TaskState
  exitCode: number | null
  signal: string | null
  buffer: RingBuffer
  /** 日志绝对路径；落盘不可用（磁盘/权限）时为 null → 降级为仅内存缓冲 */
  logPath: string | null
  /** `bash_output` 的增量游标（AC-8） */
  readCursor: number
  /** 子进程句柄（`kill` 的幂等判定与退出事件都靠它） */
  child: ChildProcess
  stream: WriteStream | null
  /** 只在进程退出时唤醒（`kill` 的等待） */
  exitWaiters: Array<() => void>
  /** 有输出**或**退出时唤醒（`bash_output` 的 `wait_ms`） */
  activityWaiters: Array<() => void>
}

/**
 * 内存环形缓冲：保留最近 `maxLines` 行 / `maxBytes` 字节（D18 的 2000 行 / 256KB）。
 *
 * 单位口径与 `truncate.ts` 完全一致（行 = 行尾切分元素数；字节 = utf8 字节数）。
 * **未换行的末行**单独存放（`partial`）：既参与 `tail`/`readSince`（否则 `printf` 无换行的
 * 输出永远看不到），又不算作已完成行（保证 `droppedLines` 只统计真正被淘汰的行）。
 */
export class RingBuffer {
  /** 已完成的完整行 */
  private lines: string[] = []
  /** 未换行的末行（可能被后续 push 续写） */
  private partial = ''
  /** `partial` 中已通过 `readSince` 发出去的长度 → 续写时只发新增部分（不重复） */
  private partialEmitted = 0
  /** `lines.join('\n')` 的字节数（增量维护，避免每次 push 重算 O(n)） */
  private retainedLines = 0
  /** 已完成行总数（单调递增；`droppedLines = totalLines - lines.length`） */
  private _totalLines = 0
  /** 已接收字节总数（单调递增） */
  private _totalBytes = 0
  private _droppedBytes = 0

  constructor(
    private readonly maxLines = 2000,
    private readonly maxBytes = 256 * 1024,
  ) {}

  /** 接收一段输出（chunk 边界与行边界无关：可能停在半个行/半个字符上） */
  push(chunk: string): void {
    if (!chunk) return
    this._totalBytes += Buffer.byteLength(chunk, 'utf8')
    const parts = chunk.split(LINE_END)
    if (parts.length === 1) {
      this.partial += chunk
    } else {
      // parts[0] 一定被某个行尾终止 → 强制落成一行（含空串：`"\n\n"` 是两条空行）
      this.commitLine(this.partial + parts[0])
      this.partial = ''
      this.partialEmitted = 0
      for (let i = 1; i < parts.length - 1; i++) this.commitLine(parts[i])
      // 末段是新的未完成行（chunk 以行尾结束时为 ''，即"暂无未完成行"）
      this.partial = parts[parts.length - 1]
      if (!this.partial) this.partialEmitted = 0
    }
    this.trim()
  }

  /**
   * 自 `cursor` 起的增量（AC-8）。
   * `cursor` 是**已完成行**的绝对序号；返回新 cursor 与"是否因环形淘汰丢了内容"。
   * 未换行的末行按"已发长度"续传：多次读取之间不重复已发内容。
   */
  readSince(cursor: number): { text: string; cursor: number; dropped: boolean } {
    const base = this._totalLines - this.lines.length // lines[0] 的绝对序号
    const from = Math.max(cursor, base)
    const dropped = cursor < base
    const taken = this.lines.slice(from - base)

    const segments: string[] = []
    if (taken.length > 0) segments.push(taken.join('\n'))
    if (this.partial) {
      const start = Math.min(this.partialEmitted, this.partial.length)
      const rest = this.partial.slice(start)
      if (rest) segments.push(rest)
      this.partialEmitted = this.partial.length
    }
    return { text: segments.join('\n'), cursor: this._totalLines, dropped }
  }

  /** 最近 n 行（含未换行的末行；**不推进**读取游标，供 `/jobs` 查看用） */
  tail(n: number): string {
    const k = Math.max(0, Math.floor(n) || 0)
    if (k === 0) return ''
    const all = this.partial ? [...this.lines, this.partial] : this.lines
    return all.slice(-k).join('\n')
  }

  /** 已完成行总数（单调） */
  get totalLines(): number {
    return this._totalLines
  }

  /** 已接收字节总数（单调） */
  get totalBytes(): number {
    return this._totalBytes
  }

  /** 因行/字节上限被淘汰的行数 */
  get droppedLines(): number {
    return this._totalLines - this.lines.length
  }

  /** 因行/字节上限被淘汰的字节数 */
  get droppedBytes(): number {
    return this._droppedBytes
  }

  // === 内部 ===

  private commitLine(line: string): void {
    if (this.lines.length > 0) this.retainedLines += 1 // 与上一行之间的 '\n'
    this.lines.push(line)
    this.retainedLines += Buffer.byteLength(line, 'utf8')
    this._totalLines++
  }

  private byteSize(): number {
    if (!this.partial) return this.retainedLines
    const sep = this.lines.length > 0 ? 1 : 0
    return this.retainedLines + sep + Buffer.byteLength(this.partial, 'utf8')
  }

  /** 按上限淘汰最旧的行；单行超字节时按字节裁该行（design §FR-2 边界 B2） */
  private trim(): void {
    const before = this.byteSize()
    while (this.lines.length > this.maxLines) this.dropFirst()
    while (this.byteSize() > this.maxBytes && this.lines.length > 1) this.dropFirst()
    if (this.byteSize() > this.maxBytes && this.lines.length === 1) {
      const head = sliceUtf8(this.lines[0], this.maxBytes)
      this.retainedLines = Buffer.byteLength(head, 'utf8')
      this.lines[0] = head
    }
    if (this.byteSize() > this.maxBytes && this.lines.length === 0 && this.partial) {
      this.partial = sliceUtf8(this.partial, this.maxBytes)
    }
    this._droppedBytes += before - this.byteSize()
  }

  private dropFirst(): void {
    const removed = this.lines.shift()
    if (removed === undefined) return
    this.retainedLines -= Buffer.byteLength(removed, 'utf8')
    if (this.lines.length > 0) this.retainedLines -= 1 // 少了一个分隔符
  }
}

/** UTF-8 安全截断（不劈开多字节字符；与 truncate.ts 同一实现意图） */
function sliceUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

/** `bash_output` 的返回形状（AC-8：增量 + 是否仍在运行 + 退出码） */
export type TaskOutput = {
  taskId: string
  /** 已量化的状态（'running' | 'exited' | 'killed'） */
  state: TaskState
  running: boolean
  exitCode: number | null
  signal: string | null
  /** 自上次读取之后的新增输出 */
  output: string
  /** 环形缓冲是否已把尚未读取的内容淘汰掉（读到的不是全部） */
  dropped: boolean
  droppedLines: number
  droppedBytes: number
}

export type KillResult = { taskId: string; killed: boolean; alreadyExited: boolean }

export type TaskManagerOptions = {
  /** 子进程 cwd（生产传入 `projectRoot`，与前台 bash 一致） */
  cwd: string
  /** 内存缓冲上限（D18：2000 行 / 256KB） */
  bufferMaxLines?: number
  bufferMaxBytes?: number
  /** SIGTERM 后的宽限期，超时升级 SIGKILL（默认 2000ms） */
  killGraceMs?: number
  /** 子进程环境（默认继承；测试可注入） */
  env?: NodeJS.ProcessEnv
}

/** `bash_output` 的 `wait_ms` 上限（避免模型传一个把工具调用挂死的值） */
export const MAX_OUTPUT_WAIT_MS = 10_000

/**
 * 后台任务注册表。**唯一的跨调用状态**：`bash` / `bash_output` / `kill_task` / `/jobs` /
 * 退出收尾（`killAll`）全部经它读写。
 */
export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>()
  private seq = 0

  constructor(private readonly opts: TaskManagerOptions) {}

  /** 存活（未被终止）的任务数 */
  get size(): number {
    return this.tasks.size
  }

  /**
   * 启动后台任务并**立即返回**（AC-7：不 await 进程结束）。<1s 返回由"只做同步的
   * spawn + 建流"保证；输出的采集/落盘全部走事件回调。
   */
  start(command: string): { taskId: string; pid: number; running: true } {
    const id = this.newId()
    const buffer = new RingBuffer(
      this.opts.bufferMaxLines ?? 2000,
      this.opts.bufferMaxBytes ?? 256 * 1024,
    )
    const logPath = this.resolveLogPath(id)
    const stream = logPath ? this.openLogStream(logPath) : null
    const child = spawn('sh', ['-c', command], {
      cwd: this.opts.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(this.opts.env ? { env: this.opts.env } : {}),
    })

    const rec: TaskRecord = {
      id,
      command,
      pid: child.pid ?? -1,
      startedAt: Date.now(),
      state: 'running',
      exitCode: null,
      signal: null,
      buffer,
      logPath,
      readCursor: 0,
      child,
      stream,
      exitWaiters: [],
      activityWaiters: [],
    }
    this.tasks.set(id, rec)

    // 落盘流的**异步 open 失败**防御（B6b 曾出现 1 次未捕获的 ENOENT/EINVAL unhandled error）：
    // createWriteStream 的 open 在线程池里进行，目录被并发删除/磁盘故障等只会以 'error' 事件出现，
    // 不监听会成为进程级 unhandled exception。落盘失败不影响任务本身（内存缓冲仍有完整输出），
    // 故处置 = 置空 rec.stream 降级为仅内存缓冲，后续 write/end 全部变为 no-op。
    if (stream) {
      stream.on('error', () => {
        rec.stream = null
      })
    }

    const onData = (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      buffer.push(s)
      rec.stream?.write(s)
      this.wakeActivity(rec)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', (code, signal) => {
      rec.exitCode = code
      rec.signal = signal
      if (rec.state === 'running') rec.state = 'exited'
      rec.stream?.end()
      this.wakeExit(rec)
      this.wakeActivity(rec)
    })
    child.on('error', (err) => {
      buffer.push(`\n[启动失败] ${err.message}\n`)
      rec.exitCode = -1
      if (rec.state === 'running') rec.state = 'exited'
      rec.stream?.end()
      this.wakeExit(rec)
      this.wakeActivity(rec)
    })

    // 刻意**不** unref：输出管道要在任务存活期间持续采集，进程存活由交互 mode 的 stdin 维持；
    // 退出时一律 killAll（AC-13），单轮模式由 process.exit 收尾。
    return { taskId: id, pid: rec.pid, running: true }
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()]
  }

  /** 只做 Map 查表（未命中即 undefined；绝不据此拼路径） */
  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id)
  }

  /** AC-8：读增量 + 标注是否仍在运行；未知 id 返回 null */
  readOutput(id: string): TaskOutput | null {
    const rec = this.tasks.get(id)
    if (!rec) return null
    const r = rec.buffer.readSince(rec.readCursor)
    rec.readCursor = r.cursor
    return {
      taskId: id,
      state: rec.state,
      running: rec.state === 'running',
      exitCode: rec.exitCode,
      signal: rec.signal,
      output: r.text,
      dropped: r.dropped,
      droppedLines: rec.buffer.droppedLines,
      droppedBytes: rec.buffer.droppedBytes,
    }
  }

  /** `/jobs` 查看用：最近 n 行（**不推进** `bash_output` 的读取游标，避免偷走 LLM 的增量） */
  tailOutput(id: string, n: number): string | null {
    const rec = this.tasks.get(id)
    if (!rec) return null
    return rec.buffer.tail(n)
  }

  /**
   * `bash_output` 的 `wait_ms`：等"有新输出或任务退出"最多 `timeoutMs`。
   * 事件驱动（非轮询）→ 不空转 CPU，也不引入常驻定时器。
   */
  async waitForActivity(id: string, timeoutMs: number): Promise<void> {
    const rec = this.tasks.get(id)
    if (!rec || rec.state !== 'running') return
    const ms = Math.max(0, Math.min(timeoutMs, MAX_OUTPUT_WAIT_MS))
    if (ms === 0) return
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        const i = rec.activityWaiters.indexOf(wake)
        if (i >= 0) rec.activityWaiters.splice(i, 1)
        resolve()
      }
      const wake = () => finish()
      const timer = setTimeout(finish, ms)
      rec.activityWaiters.push(wake)
    })
  }

  /**
   * 终止任务（AC-9）。**幂等**：已退出/已终止 → `{killed:false, alreadyExited:true}`，不抛。
   * 未知 id → null（由调用方转成错误结果）。
   */
  async kill(id: string): Promise<KillResult | null> {
    const rec = this.tasks.get(id)
    if (!rec) return null
    if (rec.state !== 'running') return { taskId: id, killed: false, alreadyExited: true }

    const signalled = this.signalGroup(rec, 'SIGTERM')
    if (!signalled) {
      // ESRCH/EPERM：组已不可达（进程早已退出）→ 按已退出处理
      if (rec.state === 'running') rec.state = 'exited'
      return { taskId: id, killed: false, alreadyExited: true }
    }

    const grace = this.opts.killGraceMs ?? 2000
    if (!(await this.waitExit(rec, grace))) {
      this.signalGroup(rec, 'SIGKILL') // trap '' TERM 的顽固组必须靠这一步（探针 B 已证明）
      await this.waitExit(rec, 1000)
    }
    rec.state = 'killed'
    rec.stream?.end()
    return { taskId: id, killed: true, alreadyExited: false }
  }

  /**
   * FR-3/AC-13：退出时**一律**终止存活任务，返回"被终止清单"（打印用）。
   * 并发执行（互不依赖）；返回顺序 = 任务创建顺序（Promise.all 保序）。
   * 只包含**本次真的在运行**的任务 → 已退出的不会被谎报成"已终止"。
   */
  async killAll(): Promise<Array<{ taskId: string; command: string; killed: boolean }>> {
    const alive = [...this.tasks.values()].filter((r) => r.state === 'running')
    return Promise.all(
      alive.map(async (r) => {
        const res = await this.kill(r.id)
        return { taskId: r.id, command: r.command, killed: res?.killed ?? false }
      }),
    )
  }

  // === 内部 ===

  /** task id 生成：`task-<base36 时间>-<base36 序号>` → 天然匹配白名单 */
  private newId(): string {
    this.seq += 1
    const id = `task-${Date.now().toString(36)}-${this.seq.toString(36)}`
    if (!TASK_ID_PATTERN.test(id)) throw new Error(`内部错误：生成的 task id 非法（${id}）`)
    return id
  }

  /** 日志路径：`<tasks>/<id>.log`；id 必过白名单（越权在结构上不可能） */
  private resolveLogPath(id: string): string | null {
    if (!TASK_ID_PATTERN.test(id)) return null
    try {
      mkdirSync(tasksDir(), { recursive: true })
      return join(tasksDir(), `${id}.log`)
    } catch {
      return null // 只读 home / 路径被占 → 降级为仅内存缓冲（design §FR-2 边界 B4）
    }
  }

  private openLogStream(logPath: string): WriteStream | null {
    try {
      return createWriteStream(logPath, { flags: 'a' })
    } catch {
      return null
    }
  }

  /** 向**进程组**发信号；`ESRCH`/`EPERM` → 视为"已不可达"返回 false，不抛 */
  private signalGroup(rec: TaskRecord, signal: NodeJS.Signals): boolean {
    try {
      process.kill(-rec.pid, signal)
      return true
    } catch (e: any) {
      if (e?.code === 'ESRCH' || e?.code === 'EPERM') return false
      return false
    }
  }

  /** 等进程退出；超时返回 false（调用方据此升级 SIGKILL） */
  private waitExit(rec: TaskRecord, timeoutMs: number): Promise<boolean> {
    if (rec.state !== 'running') return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (v: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        const i = rec.exitWaiters.indexOf(wake)
        if (i >= 0) rec.exitWaiters.splice(i, 1)
        resolve(v)
      }
      const wake = () => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      rec.exitWaiters.push(wake)
    })
  }

  private wakeExit(rec: TaskRecord): void {
    const waiters = rec.exitWaiters
    rec.exitWaiters = []
    for (const w of waiters) w()
  }

  private wakeActivity(rec: TaskRecord): void {
    const waiters = rec.activityWaiters
    rec.activityWaiters = []
    for (const w of waiters) w()
  }
}

/**
 * 删除 `tasks/` 下 mtime 超过 `retentionDays` 的 `.log`（D18：保留 7 天）。
 * 启动时调用；返回删除数量（便于测试与日志）。
 * 失败一律吞掉：清理是尽力而为，不能阻断启动（与 `images.cleanupImages` 同一取向）。
 */
export function cleanupTaskLogs(retentionDays = 7, now = Date.now()): number {
  const dir = tasksDir()
  if (!existsSync(dir)) return 0
  let removed = 0
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.log')) continue
      const abs = join(dir, e.name)
      try {
        if (now - statSync(abs).mtimeMs > retentionDays * 86400_000) {
          rmSync(abs, { force: true })
          removed++
        }
      } catch {
        // 单个文件失败不影响其余
      }
    }
  } catch {
    // 目录不可读：忽略
  }
  return removed
}
