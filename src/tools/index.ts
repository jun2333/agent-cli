import type { OpenAI } from 'openai'
import { config } from '../config.js'
import type { InteractionBroker } from '../interaction.js'
import type { TaskManager } from '../tasks.js'
import { createToolExecutor } from './executor.js'
import type { ToolImplementations } from './registry.js'

/**
 * 工具层对外门面（B2 起为**薄聚合层**）。
 *
 * 重构前本文件同时承担三件事：硬编码 OpenAI schema 数组、`implementations` Record、
 * 路径/结果等工具函数。B2 按 D7/FR-7 把它们拆开：
 * - 元数据 + 实现 → `registry.ts`（`TOOL_SPECS` / `buildDefinitions`，AC-38~41）
 * - 执行生命周期（事件、权限/Hook/截断挂载点）→ `executor.ts`（AC-40）
 * - 本文件 → 仅保留 `createTools` 的**兼容签名**与类型再导出
 *
 * 为什么保留 `createTools`：`tools.test.ts` 全量断言 12 个工具的行为（参数校验/路径穿越/
 * 危险命令），都经这个入口。**B7 起生产路径（交互模式与单轮模式）都直接用
 * `createToolExecutor()`**（注入真实 `PermissionController` + `InteractionBroker`，见 index.ts 的
 * `runTurn`），本入口只服务"无审批消费者"的场景（D-3 用户拍板：单轮非交互默认 `default` 模式
 * → `write`/`edit`/`bash` 自动拒绝，不再走这里的 compat 语义）。
 */

// 类型与结果分类的唯一实现在 registry.ts（不在本文件重复定义）；
// 这里再导出，保持 loop.ts 与各测试既有的 `from '../tools/index.js'` 导入点不变。
export type { ContentPart, ToolResult, ToolImplementations } from './registry.js'
export { classifyToolResult } from './registry.js'

/**
 * createTools 的可选参数。
 *
 * `currentModel` 用于 `view_image` 的能力预检：运行时模型会被 `/model` 切换，
 * 若工具内部直接读 `config.chatModel`，切换后预检就会按旧模型判断（切到无 vision 的模型仍放行，
 * 反之误拒）。因此由调用方（`runTurn`）把本轮真实使用的模型**注入**进来，
 * 保持「注入参数」而非「全局可变状态」——避免多轮/多会话之间互相污染。
 */
export type CreateToolsOptions = {
  /** 当前运行时模型；缺省回落 `config.chatModel`（非交互单轮模式） */
  currentModel?: string
  /**
   * 交互原语分派入口（B3/FR-5）。交互模式与单轮模式都注入；不注入时 `ask_user`
   * 返回"没有交互通道"的错误结果（compat 路径的 fail-closed）。
   */
  interaction?: InteractionBroker
  /**
   * 后台任务注册表（B6/FR-2）。交互模式注入真实 `TaskManager`（`bash_output`/`kill_task`
   * 才有意义）；不注入时三个后台入口返回"当前环境不支持后台任务"的错误结果。
   */
  tasks?: TaskManager
}

export function createTools(opts: CreateToolsOptions = {}): {
  definitions: OpenAI.Chat.Completions.ChatCompletionTool[]
  implementations: ToolImplementations
} {
  const { definitions, implementations } = createToolExecutor({
    // 本轮的工具集绑定同一个模型值：view_image 预检读它，不再读 config.chatModel
    currentModel: opts.currentModel ?? config.chatModel,
    // B3：把交互通道透传给 executor，`ask_user` 才能问到用户（AC-27/30 的 LLM 层入口）
    interaction: opts.interaction,
    // B6：把后台任务注册表透传（FR-2）
    tasks: opts.tasks,
    // 刻意**不注入** decidePermission：executor 的默认决策就是 D-2 的
    // compatFailClosedPolicy（forced 规则 deny、其余 allow），与重构前"12 个工具一律可执行"
    // 的行为面一致。生产路径（交互 / 单轮）都由 `runTurn` 注入真实 `PermissionController`
    // （B7 已落地），本入口只剩 `tools.test.ts` 使用 —— 因此这里的 compat 语义**不是**生产语义，
    // 不要据此推断单轮模式会放行写操作（D-3 已把它改为默认 `default` 模式自动拒绝）。
  })
  return { definitions, implementations }
}
