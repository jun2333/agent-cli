# agent-cli 需求文档（当前基线）

> 一个运行在终端里的通用编程助手：接本地 Ollama，能执行 shell 命令、读写文件完成开发任务。
> 渐进式学习 AI Agent 内部原理的项目。
>
> **本文档是当前实现的基线**（截至 commit `1eb2215`，2026-09-17）。
> 能力路线图的原始需求、65 条验收标准（AC）与决策记录（D1–D38）见 `.harness/workspace/005/task.md`；
> P1+P2 的技术设计与实施期裁决（V-1~V-8）见 `.harness/workspace/006/design.md`。

## 1. 运行模式

- **交互模式**：`agent-cli`，自研 DECSTBM TUI，多轮对话。
- **单轮模式**：`agent-cli "问题"`，非交互，结果输出到 stdout（便于脚本调用）。
  ⚠️ **破坏性变更（2026-09-17）**：单轮模式现在走**真实权限判定**，默认落 `default` 模式 → `write` / `edit` / `bash` **一律自动拒绝并以退出码 2 结束**。要让它改文件/跑命令，必须显式给 `--yes`（**不覆盖危险命令**）或 `--permission-mode <mode>`。此前"静默执行一切"的行为已移除。
- **恢复会话**：`agent-cli -r` / `--resume`，从历史会话中选择恢复（TTY 箭头键单选，非 TTY 数字输入）。
- **权限模式**：`--permission-mode <default|acceptEdits|plan|bypass>`（缺省 `default`）；`--yes` / `-y` = 自动接受**非危险**审批。
- **参数**：`--version/-v`、`--help/-h`。

## 2. Agent Loop（`src/agent/loop.ts`）

- LLM 决定调用工具 → 执行 → 结果回传 → 直到无工具调用（默认最多 5 轮，`config.maxIterations`）。
- 事件契约（FR-1 重构后）：`status(llm_start)` / `tool_start(callId, name, args)` / `tool_end(callId, name, ok, durationMs, outputLines, outputBytes, error?)` / `reasoning` / `token` / `error`。
  - `tool_start` **只 emit 一次**且发生在 `await 执行` 之前（工具行因此能"开始即渲染"）；`tool_end` 携带耗时与输出行数/字节。
- **三条"静默失败"上报路径**（必须保留，勿回归）：`finish_reason='length'`（上下文/输出预算耗尽）、一个正文字符都没产出、迭代轮次耗尽（`maxIterations`）。
- ESC 可打断当前循环（AbortController）。

## 3. 工具集（`src/tools/`，15 个）

| 工具 | 说明 |
|---|---|
| `bash` | 执行 shell 命令（前台 60s 超时可中断；`run_in_background` 转后台） |
| `bash_output` | 读取后台任务的**增量**输出（并标注是否仍在运行） |
| `kill_task` | 终止后台任务（幂等） |
| `read` / `write` / `edit` | 读写文件（路径限制在项目根内） |
| `list_dir` / `glob` / `grep` | 目录列举 / 模式匹配 / 内容搜索 |
| `web_search` | 网络搜索 |
| `view_image` | 读取图片（多模态 tool 结果直投；仅 `~/.agent-cli/images/` 有受控例外） |
| `read_memory` / `append_memory` / `write_memory` | 长期记忆三件套（索引 + 按需读详情） |
| `ask_user` | 让 LLM 向用户提问/要确认（走通用交互原语） |

- **工具注册表**（FR-7）：`src/tools/registry.ts` 声明式元数据（`mutating` / `requiresApproval` / `backgroundable` / `source`，当前 `source` 只有 `builtin`）+ `src/tools/executor.ts` 统一执行前/后**生命周期事件**（权限与 Hook 的唯一挂载点）。
- **`definitions` 会话内恒定**：工具集无条件注册，禁止按运行期条件增删——请求前缀稳定是**前缀缓存 44×** 的前提。
- **输出截断**：双阈值 **1000 行 / 50KB**（`config.toolOutputMaxLines` / `toolOutputMaxBytes`），作用在真实内容上、不劈坏 JSON 信封，标注数字与截断量同源；`ContentPart[]` 的 `image_url` 部件**豁免**（不计数、不截断）。

## 4. 权限系统（`src/permissions.ts`，FR-6）

| 模式 | 只读工具 | `write`/`edit` | `bash` |
|---|---|---|---|
| `default` | 免问 | **问** | **问** |
| `acceptEdits` | 免问 | 免问 | **问** |
| `plan` | 免问 | **直接拒绝** | **直接拒绝** |
| `bypass` | 免问 | 免问 | 免问（启动醒目警告） |

- **判定 = 工具级静态默认 + 参数级规则覆盖**：`bash` 按命令规则判定；**危险命令**（`rm -rf /`、`sudo`、关机/重启/`halt`、`mkfs.`）在**除 `bypass` 外的所有模式都强制审批**。
- **`--yes` 不覆盖危险命令**（V-1）：非交互 + `--yes` 遇危险命令仍自动拒绝，并提示"需显式使用 `bypass`"。故 `--yes` 与 `bypass` **语义不等价**。
- 交互模式下可用 `/mode` 运行时切换、`/permissions` 查看当前模式。
- **非交互降级 4 种**（`src/interaction.ts`）：正常交互 / 非交互默认拒绝（结构化结果 + 非零退出码）/ `--yes` 自动接受非 forced / `bypass` 全自动。
- ⚠️ **已知覆盖缺口**：`rm -fr`、`rm -rf $HOME`、`cd / && rm -rf /`、`/bin/rm` 目前**不命中**强制审批（只走普通审批）。

## 5. Hook（`src/hooks.ts`，FR-8）

- **4 个时机**：`PreToolUse`（可拦截/改写入参）、`PostToolUse`、`UserPromptSubmit`、`Stop`。**不做 `SessionStart`**（会改写请求前缀）。
- **协议**：配置为内联 shell 命令，stdin 传 JSON 上下文、stdout 回 JSON 决策（`{"decision":"block","reason":...}`）。
- **失败语义**：`PreToolUse` 非 0 → **阻塞**该工具调用并把 stderr 作为原因回给 LLM；其余时机非 0 → 放行 + TUI 告警；超时默认 **10s**（`config.hookTimeoutMs`）按失败处理。
- **挂载顺序**：`PreToolUse` **先于**权限判定（hook 是守卫，先拦可避免无谓弹审批）。
- **进程管理**：以 `exit` 结算（非 `close`）、超时回调**自己结算**、有界 flush 宽限（50ms）、`detached` + `kill(-pid)` 回收整个进程组。**副作用**：hook 里 `cmd &` 起的后台进程不会跨这次调用存活（要长驻请用 `bash(run_in_background)` + `/jobs`）。
- **信任模型**：**项目级** hook 配置（来自仓库）首次加载需**信任确认**（显示来源路径 + 命令全文），拒绝则不加载；信任记录写用户级配置（`trustedHooks`，按内容 hash）；用户级配置无需确认。信任确认本身标 `forced`，`--yes` 不能绕过。
- **未装配**：单轮（非交互）模式不加载 hook（触发点均在交互路径）。

## 6. 通用交互原语（`src/interaction.ts` + `src/ui/overlay.ts`，FR-5）

- 三种形态：**确认**（y/n/Esc）、**选择**（↑↓ + 可选**手动输入**）、**自由问答**。
- **一套底层、两个消费者**：UI 层（权限审批 / `/jobs` / Hook 信任确认）与 LLM 层（`ask_user` 工具）走**同一分派路径**（`InteractionBroker`，`openInteractionOverlay` 调用点唯一）。
- **内联浮层**：不用全屏模态，浮层画在输入框下方预留区、出现时内容区收缩。
- **浮层高度在其生命周期内恒定**（V-5）：候选数/内容变化只改行内容、不改行数——因为改变 `contentRows` 要付一次"清屏 + 清 scrollback + 全量重推历史行"的整区重建。

## 7. 后台任务（`src/tasks.ts`，FR-2）

- `bash` 加 `run_in_background: true` → 立即返回 `{task_id, pid}`（不阻塞）。
- 输出留存：内存**环形缓冲**（最近 2000 行 / 256KB，`config.taskBufferMax*`）+ 落盘 `~/.agent-cli/tasks/<task-id>.log`（保留 7 天，`config.taskLogRetentionDays`；`<task-id>` 由代码生成 + 字符集白名单）。
- `/jobs` 内联浮层二级菜单：列表（label/pid/状态/时长）→ 查看输出 / kill / 返回。
- 终止：先 SIGTERM，宽限 `config.taskKillGraceMs`（2s）后 SIGKILL；按**进程组**回收（连孙进程）。
- **退出时一律 kill 存活任务并打印被终止清单**（AC-13）。

## 8. TUI（`src/ui/`，FR-1 / FR-3 / FR-4）

- **备用屏**（Alt Screen）：进入时保存主屏，退出恢复；光标显隐管理。
- **DECSTBM 滚动区**：内容区（`1..contentRows`）可滚动，状态栏/输入框/预留区固定在滚动区外；`contentRows` 随浮层动态收缩。
- **状态机**（`src/ui/status-machine.ts`）：`StatusKind` 的**单一状态源** + 7×8 穷举迁移表；**唯一**的 ~100ms `Ticker` 驱动 Braille spinner 与**已用时长**（`⠹ Thinking… (12s)` / `⠋ Running bash (3s)`），**idle 时停止**。
- **工具行**：开始执行时即渲染，执行完成后**同一行原地更新**为 `✓ bash 12.3s · 输出 143 行`。tick 每次最多重绘 **2 行**（状态栏 + 运行中的工具行，`config.statusTickMaxRows`），绝不整区重绘。
- **斜杠补全**（`src/ui/completion-menu.ts`）：输入以 `/` 开头即弹内联候选（内置命令 + 已发现技能）；↑↓ 移动、**Tab 只填入**、**Enter 执行**、Esc 关闭并保留输入；候选按前缀过滤、选中重置到首项。
- **斜杠命令**（10 个）：`/exit`、`/quit`（`/exit` 别名）、`/clear`、`/help`、`/memory`、`/model`、`/jobs`、`/mode`、`/permissions`、`/hooks`。
- **Markdown 轻量渲染**：`**粗体**`、`` `行内代码` ``、```代码块```（青色）、`# 标题`（加粗），样式写死在代码里，不靠提示词约束。
- **输入框**：命令历史（↑↓）、光标移动（←→）、backspace、多行编辑与整段粘贴、Ctrl+G 编辑器、Ctrl+V 直投图片。
- **快捷键**：Ctrl+C 退出、Esc 打断、↑↓ 历史、←→ 光标。
- **退出收尾**（FR-3）：所有入口（`/exit`、`/quit`、Ctrl+C、`SIGINT`、`SIGTERM`）走**同一路径** —— 释放会话锁 → 终止后台任务（打印清单）→ **真清屏** → 一行 bye（含 session id 与 `agent-cli -r` 恢复提示）。

## 9. 技能（`src/skills.ts`，**仅发现层**）

- 目录：`~/.agent-cli/skills/<name>/SKILL.md`（用户级）+ `<项目根>/.agent-cli/skills/<name>/SKILL.md`（项目级）。
- 格式：Markdown + frontmatter（`name` / `description` / 可选 `allowed-tools`）；无 frontmatter 或缺必填字段的文件**跳过并告警**。
- 当前只做**最小发现**：把技能名注册为 `/` 补全的一个候选源。
- **属 P4（FR-10）的部分尚未实现**：索引注入、`read_skill`、`write_skill`、内置技能。

## 10. 会话持久化（`src/session.ts`）

- 目录：`~/.agent-cli/`（可用 `AGENT_CLI_DIR` 覆盖）。
  ```
  session/<cwd-sha256>/   会话按工作目录隔离
    session-<ms>.json     会话消息
    session-<ms>.lock     会话锁
  memory/                 长期记忆（索引 + 各 topic 详情）
  tasks/<task-id>.log     后台任务输出（保留 7 天）
  images/                 粘贴的图片（受控例外目录）
  prompt.md               自定义根提示词（存在则替换默认）
  config.json             用户配置（模型 / 思考等级等）
  ```
- **workspace 隔离**：用 cwd hash 定位子目录，`-r` 只列出当前目录的会话。
- **会话锁**：`.lock` 记录持有 pid，pid 存活探测防并发；被锁会话不可选；异常退出残留锁自动接管；退出收尾统一释放。
- **内存 sessionId**：不落盘"当前会话"指针，退出无需清空、无异常残留。
- **实时保存**：每条用户消息、每次回答完成后即时写盘；**图片剥离为路径引用**（不内联 base64）。
- **恢复**：`-r` 选择会话 → 加载消息 → TUI 渲染历史对话。

## 11. 用户配置

- 根提示词：`~/.agent-cli/prompt.md`，存在则覆盖内置默认提示词。
- memory：`~/.agent-cli/memory/`，索引拼进 system prompt；不确定时用 `read_memory(topic)` 按需读详情。`append_memory` / `write_memory` 写入后会**向对话历史追加一条短消息**，使当前会话立即可见（不改写 system prompt）。
- 模型与思考等级：`~/.agent-cli/config.json`，交互中可用 `/model` 切换。
- hooks：用户级 + 项目级；项目级信任记录存于用户级配置。
- 技能：见 §9。

## 12. 上下文与前缀缓存（关键设计前提）

- **Ollama `/v1` 上下文固定 4096**（无法按请求调大，只能用原生 API 的 `options.num_ctx` 或服务端 `OLLAMA_CONTEXT_LENGTH`）。
- **本机 100% GPU 天花板是 16384**（32768 起溢出到 CPU，131072+ 有 85% 跑在 CPU 上——"能加载"≠"能用"）；KV cache ≈ **160 KiB/token**。
- **前缀 KV 缓存实测可用**：同前缀 prefill **8587ms → 192ms（44×）**，破坏前缀（改 system）回落到 8581ms。
- **因此前缀稳定性是硬约束**：请求只在末尾追加；易变内容（技能索引、memory 更新、目录树、时间戳）一律作为**对话消息**追加，**不得改写 system prompt 前部**。system prompt 在启动时组装一次（快照语义，与"中途编辑 CLAUDE.md 不生效"同构）。
- 对话历史目前**零管理**（全量发送），分层压缩属 P3（FR-9）。

## 设计方案（简）

### 架构
```
src/index.ts                入口：参数解析（含权限模式）、system prompt 组装、交互/单轮编排、命令表
src/agent/loop.ts           agent 循环：LLM 流式 → 事件 → 工具执行 → 回传
src/tools/registry.ts       工具注册表（声明式元数据）
src/tools/executor.ts       统一执行 + 生命周期事件（权限/Hook 挂载点）
src/tools/truncate.ts       双阈值截断（内容级，不劈坏信封）
src/permissions.ts          权限判定（工具级 + 参数级，4 种模式）
src/hooks.ts                Hook 协议与进程管理、信任流程
src/tasks.ts                后台任务管理（进程组回收 + 环形缓冲 + 落盘）
src/interaction.ts          交互原语分派中枢（UI 层与 LLM 层共用）
src/commands.ts             命令规格 + 补全候选源注册表
src/skills.ts               技能最小发现层
src/ui/tui.ts               渲染层：DECSTBM 滚动区 + 消息块 + 固定区 + 浮层
src/ui/status-machine.ts    状态机 + Ticker + spinner 帧
src/ui/overlay.ts           内联浮层渲染
src/ui/completion-menu.ts   `/` 补全菜单（高度恒定）
src/session.ts              会话持久化（workspace 隔离 + 锁）+ 用户配置加载
```

### 渲染方案
- 备用屏 + DECSTBM 滚动区：内容区可滚动产生滚动历史，固定区（状态栏/输入框/预留区）不动。
- 流式用"整区原地重绘"保证无闪烁；重绘前按溢出增量触发终端滚动，保持滚动条可用。
- **动画与流式分离**：唯一 Ticker 只重绘状态栏（+ 运行中的工具行），不触碰整区重绘。
- **浮层的代价**：改变 `contentRows` 必须整区重建（清屏 + 清 scrollback + 从 `blocks` 全量重推），因此以"**浮层高度生命周期内恒定**"作为缓解规则。
- 状态/思考/回答/markdown 样式集中在样式常量区，代码写死。

### 会话方案
- 消息以 OpenAI 兼容 JSON 存文件，按 workspace（cwd hash）分目录。
- 无落盘当前指针：会话 id 在内存，保存显式传 id。
- 锁文件防并发；pid 存活探测区分"持锁/过期锁"。

### 样式方案
- 前景色层次（暗 → 亮）：思考文字（`\x1b[90m` 暗灰）< 回答正文（终端默认色）< markdown 强调（粗体/青色）。
- 全部由 TUI 代码决定，不靠提示词约束格式，模型自由发挥。

## 已知问题（未修，留待后续）

- **数组形状结果的"输出 N 行"语义**：`grep` / `glob` / `list_dir` / `web_search` 的行数显示与字符串类工具口径不同（记为 W-R1）。
- **运行中 `/clear` 未加守卫**：会话运行中清空历史可能触发上游 400（复审判为"危险的先存缺陷"，待语义裁决）。
- **危险正则覆盖面**：见 §4 的覆盖缺口。
- **非交互文案未统一**：`bash_output` / `kill_task` 在非交互模式的提示文案与主流程不一致。
- **技能名无字符集校验**：技能名与内置命令同名时会在候选中并列出现。
- **`denied` / `⊘` 为死代码**：设计中的相关视觉未落实。
- 真机体感待验收：含 `&` 的 hook、三端浮层渲染（macOS Terminal / iTerm2 / VSCode）、Braille 字体缺失时的 ASCII 兜底、`default` 模式下"每次 bash 都要按 y"的频率是否可接受。

## 待办 / 后续方向

- **P3（FR-9）上下文管理**：按 token 预算的分层压缩（占用率触发 → 先无损裁剪旧工具结果/旧图片 → 再 LLM 摘要早期历史）、项目级 `AGENTS.md` 按需注入、原始历史完整落盘 + 压缩只做"发送视图"、`/context` 分项占用与 prefill 耗时/缓存命中可视化。
- **P4（FR-10）技能系统**：索引注入（作为对话消息追加）、`read_skill`、`write_skill`（强制确认 + 校验）、内置常用技能。**发现层已实现，勿重做**。
- **MCP**：已移出本轮，后续单独立项（工具元数据的 `source` 字段已预留形状）。
- 项目级（workspace）memory。
