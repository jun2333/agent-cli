/**
 * user-config.ts — 用户配置持久化（~/.agent-cli/config.json）
 *
 * 只存"跨会话应当记住"的选择：当前模型、思考等级（/model 命令写入）。
 * 设计约定（design.md §接口设计 7）：
 * - 文件不存在/损坏一律返回 `{}`，不抛异常——配置损坏不应阻断启动。
 * - 写入失败静默降级（磁盘满/只读 home），与 session.ts 的持久化风格一致。
 * - 路径受 `AGENT_CLI_DIR` 覆盖，便于测试隔离（同 session.ts:39-41）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

export type UserConfig = {
  /** 当前模型名（缺省用 config.chatModel） */
  model?: string
  /** 思考等级（缺省 'low'） */
  thinkLevel?: 'low' | 'medium' | 'high' | 'max'
  /**
   * Hook 信任记录（FR-8/AC-46/47）：项目根 → 配置内容哈希 + 信任时间。
   * 命令变了哈希变化 → 需重新信任；键固定为 projectRoot（代码生成，不含用户/LLM 输入）。
   */
  trustedHooks?: Record<string, { hash: string; trustedAt: string }>
}

/** 合法的思考等级（服务端全局固定四档，无 per-model 元数据） */
const THINK_LEVELS = ['low', 'medium', 'high', 'max']

/** ~/.agent-cli 根目录（运行时读取，方便测试隔离；导出供 hooks.json 等同基址文件复用） */
export const agentCliDir = () => process.env.AGENT_CLI_DIR || join(homedir(), '.agent-cli')

/** 用户配置文件路径 */
function userConfigPath(): string {
  return join(agentCliDir(), 'config.json')
}

/** 读取用户配置。文件不存在/损坏/字段非法 → 忽略该字段（整体损坏则返回 {}）。 */
export function loadUserConfig(): UserConfig {
  try {
    const f = userConfigPath()
    if (!existsSync(f)) return {}
    const data = JSON.parse(readFileSync(f, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}

    const raw = data as Record<string, unknown>
    const cfg: UserConfig = {}
    if (typeof raw.model === 'string' && raw.model.trim()) {
      cfg.model = raw.model.trim()
    }
    // 手改配置可能写出非法等级，此处白名单校验，非法值直接丢弃
    if (typeof raw.thinkLevel === 'string' && THINK_LEVELS.includes(raw.thinkLevel)) {
      cfg.thinkLevel = raw.thinkLevel as UserConfig['thinkLevel']
    }
    // trustedHooks 形状校验（FR-8）：整体或任一条目不合法 → 忽略该字段（损坏不阻断启动）
    if (raw.trustedHooks !== undefined) {
      if (raw.trustedHooks && typeof raw.trustedHooks === 'object' && !Array.isArray(raw.trustedHooks)) {
        const entries = Object.entries(raw.trustedHooks as Record<string, unknown>)
        const valid = entries.every(
          ([k, v]) =>
            k.trim() !== '' &&
            v !== null &&
            typeof v === 'object' &&
            !Array.isArray(v) &&
            typeof (v as Record<string, unknown>).hash === 'string' &&
            (v as Record<string, unknown>).hash !== '' &&
            typeof (v as Record<string, unknown>).trustedAt === 'string',
        )
        if (valid) cfg.trustedHooks = entries.reduce<Record<string, { hash: string; trustedAt: string }>>((acc, [k, v]) => {
          const rec = v as { hash: string; trustedAt: string }
          acc[k] = { hash: rec.hash, trustedAt: rec.trustedAt }
          return acc
        }, {})
      }
    }
    return cfg
  } catch {
    return {}
  }
}

/** 写入用户配置。失败静默降级（本次选择只在内存生效，不影响对话）。 */
export function saveUserConfig(c: UserConfig): void {
  try {
    const f = userConfigPath()
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(c, null, 2))
  } catch {
    // 写入失败不致命（磁盘满/只读 home）
  }
}
