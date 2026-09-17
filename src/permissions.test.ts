/**
 * permissions.test.ts — 权限系统与预设模式（FR-6 / AC-31~37 + V-2）
 *
 * 全部走**纯函数** `decidePermission(meta, args, mode)` 与其唯一来源
 * `matchDangerousCommand`（V-2：4 条危险命令正则已从 `tools/registry.ts` 整体迁入
 * `src/permissions.ts`，`bash.impl` 的硬拦截已删除）。真实 executor 的集成行为
 * （审批浮层、引用注入、AC-39 的假工具）在 `tools/executor.test.ts` 与 `index.e2e.test.ts`。
 *
 * 元数据一律取**生产 `TOOL_SPECS`**（而不是测试自造的 meta）：这样"判定读元数据"这条
 * 结构性要求（AC-39）与真实工具登记表绑定，元数据被改错时这里会先红。
 */
import { describe, it, expect } from 'vitest'
import {
  BYPASS_WARNING,
  DANGEROUS_REASON,
  isPermissionMode,
  matchDangerousCommand,
  PermissionController,
  PERMISSION_MODE_DESCRIPTIONS,
  PERMISSION_MODES,
  decidePermission,
  type PermissionMode,
} from './permissions.js'
import { TOOL_SPECS } from './tools/registry.js'
import type { ToolMeta } from './tools/registry.js'

/** 取生产元数据（找不到即测试失败——防止工具被改名后这些用例静默失去意义） */
function metaOf(name: string): ToolMeta {
  const spec = TOOL_SPECS.find((s) => s.meta.name === name)
  if (!spec) throw new Error(`TOOL_SPECS 里没有工具 ${name}`)
  return spec.meta
}
const decide = (name: string, args: Record<string, unknown>, mode: PermissionMode) =>
  decidePermission(metaOf(name), args, mode)

describe('权限：matchDangerousCommand（V-2 的唯一危险命令来源）', () => {
  it('4 条规则各自命中并带 ruleId', () => {
    expect(matchDangerousCommand('rm -rf /')).toMatchObject({ ruleId: 'rm-root' })
    expect(matchDangerousCommand('rm -rf ~/x')).toMatchObject({ ruleId: 'rm-root' })
    expect(matchDangerousCommand('rm -r ~')).toMatchObject({ ruleId: 'rm-root' })
    expect(matchDangerousCommand('sudo rm -rf /etc')).toMatchObject({ ruleId: 'sudo' })
    expect(matchDangerousCommand('reboot')).toMatchObject({ ruleId: 'power' })
    expect(matchDangerousCommand('shutdown -h now')).toMatchObject({ ruleId: 'power' })
    expect(matchDangerousCommand('mkfs.ext4 /dev/sda1')).toMatchObject({ ruleId: 'mkfs' })
  })

  it('普通命令与"形似但不同"的命令不命中（边界不放松）', () => {
    expect(matchDangerousCommand('echo hello')).toBeNull()
    expect(matchDangerousCommand('ls /')).toBeNull()
    expect(matchDangerousCommand('rm file.txt')).toBeNull()
    expect(matchDangerousCommand('echo sudo')).toBeNull() // 只拦行首 sudo
    expect(matchDangerousCommand('npm run shutdown')).toBeNull()
  })

  it('rm -rf 指向任何绝对路径/家目录都命中（与迁入前正则逐字一致，语义未收紧未放松）', () => {
    // 原正则 ^rm\s+(-rf?)?\s+(\/|~) 拦的是"rm -rf <以 / 或 ~ 开头的路径>"，
    // 不限于根/家目录本身 —— V-2 要求"整体迁入"，此处锁定迁入前后语义一致。
    expect(matchDangerousCommand('rm -rf /tmp/foo')).toMatchObject({ ruleId: 'rm-root' })
  })

  it('首尾空白被裁剪（与迁入前 bash.impl 的 trim 同口径）', () => {
    expect(matchDangerousCommand('  sudo ls')).toMatchObject({ ruleId: 'sudo' })
    expect(matchDangerousCommand('\trm -rf /\n')).toMatchObject({ ruleId: 'rm-root' })
  })
})

describe('权限：AC-31 只读工具在 default 模式不触发审批', () => {
  it('read / glob / grep / list_dir → allow', () => {
    expect(decide('read', { path: 'src/index.ts' }, 'default')).toEqual({ type: 'allow' })
    expect(decide('glob', { pattern: '**/*.ts' }, 'default')).toEqual({ type: 'allow' })
    expect(decide('grep', { pattern: 'foo' }, 'default')).toEqual({ type: 'allow' })
    expect(decide('list_dir', { path: '.' }, 'default')).toEqual({ type: 'allow' })
  })

  it('其余 requiresApproval:false 的工具（记忆/搜索/图片/任务读取/ask_user）同样 allow', () => {
    for (const name of ['web_search', 'view_image', 'read_memory', 'append_memory', 'write_memory', 'bash_output', 'ask_user']) {
      expect(decide(name, {}, 'default')).toEqual({ type: 'allow' })
    }
  })
})

describe('权限：AC-32 default 模式下 write / edit 触发审批', () => {
  it('write / edit → ask（reason 含工具名）', () => {
    const w = decide('write', { path: 'a.txt', content: 'x' }, 'default')
    expect(w.type).toBe('ask')
    expect(w.type === 'ask' && w.reason).toContain('write')
    expect(w.type === 'ask' && w.mode).toBe('default')

    const e = decide('edit', { path: 'a.txt', old_string: 'a', new_string: 'b' }, 'default')
    expect(e.type).toBe('ask')
    expect(e.type === 'ask' && e.reason).toContain('edit')
  })
})

describe('权限：AC-33 acceptEdits 下文件编辑免审批、bash 仍审批', () => {
  it('write / edit → allow；bash（非危险） → ask', () => {
    expect(decide('write', { path: 'a.txt', content: 'x' }, 'acceptEdits')).toEqual({ type: 'allow' })
    expect(decide('edit', { path: 'a.txt', old_string: 'a', new_string: 'b' }, 'acceptEdits')).toEqual({ type: 'allow' })

    const b = decide('bash', { command: 'npm run build' }, 'acceptEdits')
    expect(b.type).toBe('ask')
    expect(b.type === 'ask' && b.ruleId).toBe('exec')
    expect(b.type === 'ask' && b.forced).toBeUndefined() // catch-all 规则不是 forced
  })
})

describe('权限：AC-34 plan 模式写类直接拒绝（不弹审批浮层）', () => {
  it('write / edit / bash（bash 是 mutating）→ deny，reason 说明 plan 只读', () => {
    for (const [name, args] of [
      ['write', { path: 'a.txt', content: 'x' }],
      ['edit', { path: 'a.txt', old_string: 'a', new_string: 'b' }],
      ['bash', { command: 'echo hi' }],
    ] as const) {
      const d = decide(name, args, 'plan')
      expect(d.type).toBe('deny')
      expect(d.type === 'deny' && d.reason).toContain('plan')
      expect(d.type === 'deny' && d.reason).toContain(name)
    }
  })

  it('只读工具在 plan 下照常 allow；危险命令在 plan 下也走 deny（mutating 优先）', () => {
    expect(decide('read', { path: 'x' }, 'plan')).toEqual({ type: 'allow' })
    expect(decide('bash', { command: 'sudo rm -rf /' }, 'plan').type).toBe('deny')
  })

  it('kill_task / append_memory 等 mutating 但 requiredApproval:false 的工具在 plan 下被拒（设计取舍）', () => {
    expect(decide('kill_task', { task_id: 'task-1' }, 'plan').type).toBe('deny')
    expect(decide('append_memory', { topic: 't', content: 'c' }, 'plan').type).toBe('deny')
  })
})

describe('权限：AC-35 bypass 模式一律不审批（+ 醒目警告文案）', () => {
  it('全部工具在 bypass 下 allow（含危险命令）', () => {
    for (const name of TOOL_SPECS.map((s) => s.meta.name)) {
      expect(decide(name, { command: 'sudo rm -rf /', path: 'a', content: 'c' }, 'bypass')).toEqual({ type: 'allow' })
    }
  })

  it('BYPASS_WARNING 是醒目且可读的文案（启动与 /mode 共用）', () => {
    expect(BYPASS_WARNING).toContain('bypass')
    expect(BYPASS_WARNING).toContain('不再请求确认')
  })
})

describe('权限：AC-36 危险命令在任何非 bypass 模式都强制审批（V-2）', () => {
  it('default / acceptEdits 下 sudo rm -rf / → ask 且 forced=true（不可豁免）', () => {
    for (const mode of ['default', 'acceptEdits'] as const) {
      const d = decide('bash', { command: 'sudo rm -rf /' }, mode)
      expect(d.type).toBe('ask')
      expect(d.type === 'ask' && d.forced).toBe(true)
      expect(d.type === 'ask' && d.ruleId).toBe('dangerous')
      expect(d.type === 'ask' && d.reason).toBe(DANGEROUS_REASON)
      expect(d.type === 'ask' && d.mode).toBe(mode)
    }
  })

  it('4 条规则都能在 acceptEdits 下产出 forced ask（规则没被 catch-all 抢先）', () => {
    for (const cmd of ['rm -rf /', 'sudo ls', 'reboot', 'mkfs.ext4 /dev/sda']) {
      const d = decide('bash', { command: cmd }, 'acceptEdits')
      expect(d.type === 'ask' && d.forced).toBe(true)
    }
  })
})

describe('权限：AC-37 PermissionController 引用注入，setMode 立即生效', () => {
  it('同一实例 setMode 后判定结果立刻改变（不需要重建任何对象）', () => {
    const c = new PermissionController('default')
    expect(c.mode).toBe('default')
    expect(c.decide(metaOf('write'), { path: 'a', content: 'x' })).toMatchObject({ type: 'ask' })

    c.setMode('acceptEdits')
    expect(c.mode).toBe('acceptEdits')
    expect(c.decide(metaOf('write'), { path: 'a', content: 'x' })).toEqual({ type: 'allow' })

    c.setMode('plan')
    expect(c.decide(metaOf('write'), { path: 'a', content: 'x' })).toMatchObject({ type: 'deny' })

    c.setMode('bypass')
    expect(c.decide(metaOf('bash'), { command: 'sudo rm -rf /' })).toEqual({ type: 'allow' })
  })

  it('缺省模式是 default（不显式指定时不静默放宽）', () => {
    expect(new PermissionController().mode).toBe('default')
  })
})

describe('权限：模式取值与文案（CLI 校验 / `/mode` 浮层共用）', () => {
  it('PERMISSION_MODES 恰为四种模式', () => {
    expect([...PERMISSION_MODES]).toEqual(['default', 'acceptEdits', 'plan', 'bypass'])
  })

  it('isPermissionMode 只接受四种模式（非法值必须被拒，不静默回落）', () => {
    for (const m of PERMISSION_MODES) expect(isPermissionMode(m)).toBe(true)
    for (const bad of ['Default', 'accept', 'yolo', '', undefined, null, 1]) expect(isPermissionMode(bad)).toBe(false)
  })

  it('每种模式都有非空说明文案（/mode 与 /permissions 共用同一份）', () => {
    for (const m of PERMISSION_MODES) expect(PERMISSION_MODE_DESCRIPTIONS[m].length).toBeGreaterThan(0)
  })
})
