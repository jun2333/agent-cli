# agent-cli 初始需求文档

> 一个运行在终端里的通用编程助手：接本地 Ollama，能执行 shell 命令、读写文件完成开发任务。
> 渐进式学习 AI Agent 内部原理的项目（MVP 阶段）。

## 功能清单（已实现）

### 1. 运行模式
- **交互模式**：`agent-cli`，自研 DECSTBM TUI。
- **单轮模式**：`agent-cli "问题"`，非交互，直接输出到 stdout（便于脚本调用）。
- **恢复会话**：`agent-cli -r` / `--resume`，从历史会话中选择恢复（TTY 箭头键单选，非 TTY 数字输入）。
- **参数**：`--version/-v`、`--help/-h`。

### 2. Agent Loop（`src/agent/loop.ts`）
- LLM 决定调用工具 → 执行 → 结果回传 → 直到无工具调用（默认最多 5 轮）。
- 流式产出事件：`status`（llm_start/tool_start/tool_end）、`reasoning`（思考内容）、`token`（回答文本）、`tool`（工具调用）。
- ESC 可打断当前循环（AbortController）。

### 3. 工具集（`src/tools/`）
| 工具 | 说明 |
|---|---|
| `bash` | 执行 shell 命令（带超时/路径安全约束） |
| `read` | 读取文件 |
| `write` | 写入/覆盖文件 |
| `edit` | 局部替换文件内容 |
| `list_dir` | 列出目录 |
| `glob` | 按 glob 模式匹配文件 |
| `grep` | 内容搜索 |
| `web_search` | 网络搜索 |

### 4. TUI（`src/ui/tui.ts`）
- **备用屏**（Alt Screen）：进入时保存主屏，退出恢复；光标显隐管理。
- **DECSTBM 滚动区**：内容区（1..contentRows）可滚动，状态栏/输入框/预留区固定在滚动区外。
- **消息块**：banner / user / assistant / thinking / tool / error。
- **流式渲染**：整区原地重绘到底部（无闪烁），配合增量滚动把超出行推入终端滚动历史（滚动条可回看）。
- **思考面板**：单行显示 Thinking… / Thinking done。
- **Markdown 轻量渲染**：`**粗体**`、`` `行内代码` ``、```代码块```（青色）、`# 标题`（加粗），样式写死在代码里，不靠提示词约束。
- **状态栏**：`StatusKind` 枚举 + 文案/颜色映射表，统一英文（Ready/Thinking…/Running tool/Answering…/Queued/Interrupted/Error）。
- **输入框**：命令历史（↑↓）、光标移动（←→）、backspace；`/exit`、`/quit`、`/clear`、`/help`。
- **快捷键**：Ctrl+C 退出、Esc 打断、↑↓ 历史、←→ 光标。

### 5. 会话持久化（`src/session.ts`）
- 目录：`~/.agent-cli/`（可用 `AGENT_CLI_DIR` 覆盖）。
  ```
  session/<cwd-sha256>/   会话按工作目录隔离
    session-<ms>.json     会话消息
    session-<ms>.lock     会话锁
  memory/memory.md        长期记忆（启动时拼进 system prompt）
  prompt.md               自定义根提示词（存在则替换默认）
  ```
- **workspace 隔离**：用 cwd hash 定位子目录，`-r` 只列出当前目录的会话。
- **会话锁**：`.lock` 文件记录持有 pid，pid 存活探测防止多进程并发编辑同一会话；被锁会话在列表中不可选；异常退出残留的锁自动接管。
- **内存 sessionId**：不落盘"当前会话"指针，退出无需清空、无异常残留、无跨进程冲突。
- **实时保存**：每条用户消息、每次回答完成后即时写盘（非退出时保存）。
- **恢复**：`-r` 选择会话 → 加载消息 → TUI 渲染历史对话。

### 6. 用户配置
- 根提示词：`~/.agent-cli/prompt.md`，存在则覆盖内置默认提示词。
- memory：`~/.agent-cli/memory/memory.md`，作为 `# Memory` 追加进 system prompt。

## 设计方案（简）

### 架构
```
src/index.ts      入口：参数解析、system prompt 组装、交互/单轮编排
src/agent/loop.ts agent 循环：LLM 流式 → 事件 → 工具执行 → 回传
src/tools/        工具定义与实现（bash/read/write/edit/...）
src/ui/tui.ts     渲染层：DECSTBM 滚动区 + 消息块模型 + 固定区
src/session.ts    会话持久化（workspace 隔离 + 锁）+ 用户配置加载
```

### 渲染方案
- 备用屏 + DECSTBM 滚动区：内容区可滚动产生滚动历史，固定区（状态栏/输入框）不动。
- 流式用"整区原地重绘"（逐行 cursorTo + clearLine + write）保证正确无闪烁；重绘前按溢出增量触发终端滚动，保持滚动条可用。
- 状态/思考/回答/markdown 样式集中在样式常量区，代码写死。

### 会话方案
- 消息以 OpenAI 兼容 JSON 存文件，按 workspace（cwd hash）分目录。
- 无落盘当前指针：本次会话 id 在内存，保存显式传 id。
- 锁文件防并发；pid 存活探测区分"持锁/过期锁"。

### 样式方案
- 前景色层次（暗 → 亮）：思考文字（`\x1b[90m` 暗灰）< 回答正文（终端默认色）< markdown 强调（粗体/青色）。
- 全部由 TUI 代码决定，不靠提示词约束格式，模型自由发挥。

## 待办 / 后续方向
- memory 主动维护（工具：read_memory / append_memory / write_memory）
- 项目级（workspace）memory
