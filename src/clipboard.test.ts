/**
 * clipboard.ts 单测（通过注入 ClipboardDeps 假实现，不真调系统剪贴板）
 *
 * 重点覆盖一次真实剪贴板实测发现的回归：
 * osascript 的多条语句必须放在**同一次**调用里（多个 -e），
 * 分次独立进程会因 AppleScript 变量不跨进程而静默失败（产物 0 字节）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readClipboardImage,
  readClipboardText,
  setClipboardDeps,
  resetClipboardDeps,
  classifyFailure,
  describeExecError,
} from './clipboard.js'

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

let dir: string
let prevAgentCliDir: string | undefined

/**
 * 从 osascript 的 -e 参数里提取目标文件路径。
 * 注意：实现把全部语句放在同一次调用（多个 -e），因此最后一个参数是 `close access f`
 * 而不是文件路径——必须从 `POSIX file "..."` 语句里解析。
 */
function fileFromArgs(args: string[]): string {
  const joined = args.join('\n')
  const m = joined.match(/POSIX file "([^"]+)"/)
  if (!m) throw new Error(`未能从 osascript 参数中解析出文件路径：${joined}`)
  return m[1]
}

/** 构造一个"假装成功把剪贴板图片写到了目标路径"的 run 实现 */
function writeOnRun(payload: Buffer = PNG_1PX, failOn?: string) {
  return async (cmd: string, args: string[]): Promise<string> => {
    if (failOn && cmd === failOn) throw new Error('simulated failure')
    // pngpaste 直接把路径作为唯一参数；osascript 需要从脚本里解析
    const target = cmd === 'pngpaste' ? args[args.length - 1] : fileFromArgs(args)
    writeFileSync(target, payload)
    return ''
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-cli-clip-test-'))
  prevAgentCliDir = process.env.AGENT_CLI_DIR
  process.env.AGENT_CLI_DIR = dir
})

afterEach(() => {
  resetClipboardDeps()
  if (prevAgentCliDir === undefined) delete process.env.AGENT_CLI_DIR
  else process.env.AGENT_CLI_DIR = prevAgentCliDir
  rmSync(dir, { recursive: true, force: true })
})

describe('剪贴板取图：命令调用方式（真实剪贴板实测发现的回归）', () => {
  it('osascript 路径必须把全部语句放在同一次调用里（多个 -e），不能逐行起独立进程', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    setClipboardDeps({
      hasCommand: async (cmd) => cmd === 'osascript',
      run: async (cmd, args) => {
        calls.push({ cmd, args })
        writeFileSync(fileFromArgs(args), PNG_1PX)
        return ''
      },
    })

    const r = await readClipboardImage()

    expect(r.ok).toBe(true)
    const oscalls = calls.filter((c) => c.cmd === 'osascript')
    // 核心断言：只调用一次
    expect(oscalls).toHaveLength(1)
    // 且四条语句都在同一次调用的 -e 参数里
    const args = oscalls[0].args
    expect(args.filter((a) => a === '-e')).toHaveLength(4)
    expect(args.join('\n')).toContain('the clipboard as «class PNGf»')
    expect(args.join('\n')).toContain('write d to f')
  })

  it('osascript 取图失败（非 0 退出）时归为 no-image，且清理临时文件', async () => {
    setClipboardDeps({
      hasCommand: async (cmd) => cmd === 'osascript',
      run: async () => {
        throw new Error('execution error: (-1700)')
      },
    })
    const r = await readClipboardImage()
    expect(r).toEqual({ ok: false, reason: 'no-image' })
  })

  it('pngpaste 存在时优先使用，且成功即返回，不再走 osascript', async () => {
    const calls: string[] = []
    setClipboardDeps({
      hasCommand: async () => true,
      run: async (cmd, args) => {
        calls.push(cmd)
        writeFileSync(args[args.length - 1], PNG_1PX)
        return ''
      },
    })
    const r = await readClipboardImage()
    expect(r.ok).toBe(true)
    expect(calls).toEqual(['pngpaste'])
  })

  it('pngpaste 失败时继续降级到 osascript', async () => {
    const calls: string[] = []
    setClipboardDeps({
      hasCommand: async () => true,
      run: async (cmd, args) => {
        calls.push(cmd)
        if (cmd === 'pngpaste') throw new Error('no image data')
        writeFileSync(fileFromArgs(args), PNG_1PX)
        return ''
      },
    })
    const r = await readClipboardImage()
    expect(r.ok).toBe(true)
    expect(calls).toEqual(['pngpaste', 'osascript'])
  })

  it('两个工具都不可用时返回 unavailable（调用方提示用户，而非退化文本粘贴）', async () => {
    setClipboardDeps({ hasCommand: async () => false })
    const r = await readClipboardImage()
    expect(r).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('工具可用但产出空文件时归为 no-image', async () => {
    setClipboardDeps({
      hasCommand: async (cmd) => cmd === 'osascript',
      run: writeOnRun(Buffer.alloc(0)),
    })
    const r = await readClipboardImage()
    expect(r).toEqual({ ok: false, reason: 'no-image' })
  })

  it('取到的图片落盘到 AGENT_CLI_DIR/images 下', async () => {
    setClipboardDeps({
      hasCommand: async (cmd) => cmd === 'osascript',
      run: writeOnRun(),
    })
    const r = await readClipboardImage()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.path.startsWith(join(dir, 'images'))).toBe(true)
      expect(existsSync(r.path)).toBe(true)
    }
  })
})

describe('剪贴板取图：失败原因判别（W-7）', () => {
  it('osascript 报 -1700（剪贴板无 PNG）归为 no-image', () => {
    expect(classifyFailure(new Error('execution error: (-1700)'))).toBe('no-image')
  })

  it('pngpaste 报 no image data（及其简写 no image）归为 no-image', () => {
    expect(classifyFailure(new Error('pngpaste: no image data'))).toBe('no-image')
    expect(classifyFailure(new Error('no image'))).toBe('no-image')
  })

  it('超时（ETIMEDOUT / killed）归为 failed', () => {
    expect(classifyFailure(new Error('Command failed: pngpaste | code=null | killed'))).toBe('failed')
    expect(classifyFailure(new Error('spawn osascript ETIMEDOUT'))).toBe('failed')
  })

  it('-1743 Automation 权限被拒归为 failed（不会被误判成"无图"）', () => {
    expect(classifyFailure(new Error('execution error: Not authorized to send Apple events (-1743)'))).toBe('failed')
  })

  it('命令不存在（ENOENT）归为 failed', () => {
    expect(classifyFailure(new Error('spawn pngpaste ENOENT | code=ENOENT'))).toBe('failed')
  })

  it('非 Error 值也归为 failed（保守：宁可提示用户也不静默退化）', () => {
    expect(classifyFailure(undefined)).toBe('failed')
    expect(classifyFailure('unknown failure')).toBe('failed')
  })
})

describe('剪贴板取图：execFile 错误对象 → 可判别消息（N-8③ 回归保护）', () => {
  // 说明：此前所有用例都注入「预置 message」的假实现，真实 execFile 错误对象的形状
  // （message 是否内联 stderr、stderr 是否存在、code/killed 挂在哪）从未被固化。
  // 下面用实测到的真实形状（Node v26.3.0 / macOS）构造错误对象，断言拼出的字符串
  // 仍能被 classifyFailure 正确分类。形状实测结果：
  //   非 0 退出 → message 已内联 stderr 且 err.stderr 同时存在；code=1；killed=false
  //   ENOENT    → message='spawn <cmd> ENOENT'；stderr=''；code='ENOENT'；killed=undefined
  //   超时被 kill → message='Command failed: <cmd>\n'；stderr=''；code=null；killed=true
  it('非 0 退出（osascript -1700，message 内联 stderr 且 stderr 存在）→ 归为 no-image', () => {
    const err = {
      message:
        'Command failed: osascript -e set d to (the clipboard as «class PNGf»)\n' +
        'execution error: 不能将某些数据转换为预期的类型。 (-1700)\n',
      stderr: 'execution error: 不能将某些数据转换为预期的类型。 (-1700)\n',
      code: 1,
      killed: false,
    }
    expect(classifyFailure(new Error(describeExecError(err)))).toBe('no-image')
  })

  it('stderr 为 undefined 的形态（message 内联了 stderr）→ 仍归为 no-image', () => {
    const err = {
      message: 'Command failed: osascript -e ...\nexecution error: ... (-1700)\n',
      stderr: undefined,
      code: 1,
      killed: false,
    }
    expect(classifyFailure(new Error(describeExecError(err)))).toBe('no-image')
  })

  it('message 未内联 stderr 的形态 → 由拼装层补上 stderr，仍归为 no-image', () => {
    // 该形态下若不做拼装，message 里只有命令名，会被误判成 failed（"取图失败"而非"无图"）
    const err = {
      message: 'Command failed: pngpaste /tmp/x.png',
      stderr: 'pngpaste: No image data found on the clipboard, or could not convert!\n',
      code: 1,
    }
    expect(classifyFailure(new Error(describeExecError(err)))).toBe('no-image')
  })

  it('超时被 kill → 拼出 killed 标记并归为 failed（killed 只存在于对象上）', () => {
    const err = { message: 'Command failed: pngpaste /tmp/x.png\n', stderr: '', code: null, killed: true }
    const desc = describeExecError(err)
    expect(desc).toContain('killed')
    expect(classifyFailure(new Error(desc))).toBe('failed')
  })

  it('命令不存在（ENOENT）→ 拼出 code=ENOENT 并归为 failed', () => {
    const err = { message: 'spawn pngpaste ENOENT', stderr: '', code: 'ENOENT', killed: undefined }
    const desc = describeExecError(err)
    expect(desc).toContain('code=ENOENT')
    expect(classifyFailure(new Error(desc))).toBe('failed')
  })

  it('-1743 Automation 权限被拒 → 归为 failed（不得误判成"无图"）', () => {
    const err = {
      message: 'Command failed: osascript -e ...\nexecution error: Not authorized (-1743)\n',
      stderr: undefined,
      code: 1,
      killed: false,
    }
    expect(classifyFailure(new Error(describeExecError(err)))).toBe('failed')
  })

  it('拼装规则与顺序固定：message | stderr | code=… | killed，空值丢弃', () => {
    expect(describeExecError({ message: 'm', stderr: 's', code: 3, killed: true })).toBe('m | s | code=3 | killed')
    expect(describeExecError({ message: 'm', stderr: '', code: null, killed: false })).toBe('m')
  })

  it('非 Error / 空值不抛异常，且保守归为 failed', () => {
    expect(() => describeExecError(undefined)).not.toThrow()
    expect(() => describeExecError(null)).not.toThrow()
    expect(describeExecError(undefined)).toBe('')
    expect(classifyFailure(new Error(describeExecError('未知失败')))).toBe('failed')
  })
})

describe('剪贴板取图：取图出错不得静默退化为"无图"（W-7）', () => {
  it('osascript 因 Automation 权限被拒（-1743）时返回 failed，且清理临时文件', async () => {
    let tmpFile = ''
    setClipboardDeps({
      hasCommand: async (cmd) => cmd === 'osascript',
      run: async (_cmd, args) => {
        tmpFile = fileFromArgs(args)
        throw new Error('execution error: Not authorized to send Apple events to System Events. (-1743)')
      },
    })
    const r = await readClipboardImage()
    expect(r).toEqual({ ok: false, reason: 'failed' })
    expect(tmpFile).not.toBe('')
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('osascript 超时被 kill 时返回 failed，而不是 no-image', async () => {
    setClipboardDeps({
      hasCommand: async (cmd) => cmd === 'osascript',
      run: async () => {
        throw new Error('Command failed: osascript | code=null | killed')
      },
    })
    expect(await readClipboardImage()).toEqual({ ok: false, reason: 'failed' })
  })

  it('pngpaste 报 no image data 且 osascript 不可用时归为 no-image（正常业务情形）', async () => {
    setClipboardDeps({
      hasCommand: async (cmd) => cmd === 'pngpaste',
      run: async () => {
        throw new Error('pngpaste: no image data')
      },
    })
    expect(await readClipboardImage()).toEqual({ ok: false, reason: 'no-image' })
  })

  it('pngpaste 出错 + osascript 报无图：出错优先，整体归为 failed', async () => {
    setClipboardDeps({
      hasCommand: async () => true,
      run: async (cmd) => {
        if (cmd === 'pngpaste') throw new Error('spawn pngpaste ETIMEDOUT')
        throw new Error('execution error: (-1700)')
      },
    })
    expect(await readClipboardImage()).toEqual({ ok: false, reason: 'failed' })
  })

  it('工具产物无法读取（落盘/读取出错）时归为 failed，不伪装成"无图"', async () => {
    setClipboardDeps({
      hasCommand: async (cmd) => cmd === 'osascript',
      run: async (_cmd, args) => {
        mkdirSync(fileFromArgs(args), { recursive: true }) // 把"产物"造成目录 → readFileSync 抛 EISDIR
        return ''
      },
    })
    expect(await readClipboardImage()).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('剪贴板取文本（Ctrl+V 无图时的退化路径）', () => {
  it('pbpaste 不可用返回 null', async () => {
    setClipboardDeps({ hasCommand: async () => false })
    expect(await readClipboardText()).toBeNull()
  })

  it('剪贴板为空返回 null', async () => {
    setClipboardDeps({ hasCommand: async () => true, run: async () => '' })
    expect(await readClipboardText()).toBeNull()
  })

  it('有文本时原样返回', async () => {
    setClipboardDeps({ hasCommand: async () => true, run: async () => '粘贴的文本' })
    expect(await readClipboardText()).toBe('粘贴的文本')
  })
})
