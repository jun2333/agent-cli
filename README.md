# Agent CLI

> 终端 AI 编程助手 —— 从 0 实现 Agent 运行时（LLM 循环 / 工具调用 / 会话管理 / TUI）

一个跑在终端里的编程助手，接本地 **Ollama** 模型。

**目标不是"做个能用的工具"，而是把 AI Agent 的运行时机制完整实现一遍**：
LLM 流式响应 → 解析工具调用 → 执行工具 → 结果回传 → 循环，直到任务完成。

## 核心特性

| 能力 | 实现 |
|------|------|
| **Agent 循环** | 流式响应解析 + `tool_calls` 增量累积 + 多轮工具执行（`src/agent/loop.ts`） |
| **工具系统** | 8 个内置工具，可扩展注册机制（`src/tools/`） |
| **会话管理** | 持久化 + workspace 隔离 + 并发锁，支持 `-r` 恢复历史会话（`src/session.ts`） |
| **终端 UI** | 自研 **DECSTBM 滚动区域**渲染（`src/ui/tui.ts`） |
| **测试覆盖** | 纯逻辑单测 + **ANSI 终端模拟器**驱动的 TUI 端到端测试 |

**内置工具**：`bash` · `read` · `write` · `edit` · `list_dir` · `glob` · `grep` · `web_search`

## 技术栈

| 层 | 选型 |
|----|------|
| 运行时 | Node.js + TypeScript（ESM） |
| LLM | 本地 Ollama（OpenAI 兼容接口） |
| TUI | Ink（React for CLI）+ React 19 |
| 测试 | Vitest（单测 + 端到端） |

## 快速开始

### 前置：启动 Ollama

```bash
ollama serve
ollama pull qwen3:8b        # 或换成你喜欢的模型
```

### 安装与运行

```bash
git clone git@github.com:jun2333/agent-cli.git
cd agent-cli
git submodule update --init --recursive    # 拉取工作流引擎（.harness）

pnpm install

pnpm dev                                    # 开发模式（tsx 直跑源码）
pnpm build && node dist/index.js            # 生产模式
node dist/index.js -r                       # 恢复历史会话
```

### 测试

```bash
pnpm test              # 单元测试 + TUI 端到端测试
npx tsc --noEmit       # 类型检查
```

## 项目结构

```
src/
├── index.ts            # 入口：参数解析、system prompt 组装、交互编排
├── agent/
│   └── loop.ts         # Agent 循环：流式 → 事件 → 工具执行 → 回传
├── tools/
│   └── index.ts        # 工具定义与实现（8 个内置工具）
├── ui/
│   └── tui.ts          # DECSTBM 滚动区域 TUI 渲染层
├── session.ts          # 会话持久化（workspace 隔离 + 锁）
├── config.ts           # 配置（Ollama 地址、模型等）
└── testing/
    └── term-sim.ts     # 终端模拟器（e2e 测试基础设施）
```

## 设计说明

### Agent 循环

```
用户输入 → 组装 messages → 调 LLM（stream）
                              ↓
              流式解析：content → 逐块输出
                        tool_calls → 按 index 增量累积
                              ↓
              有工具调用？ ── 否 ──→ 结束
                    │是
                    ↓
              执行工具 → 结果作为 tool 消息回传 → 下一轮
```

关键点：流式响应里的 `tool_calls` 是**分片返回**的（函数名和参数被拆成多个 delta），必须按 index 累积拼接后才能解析参数。

### 工具系统

工具通过 JSON Schema 声明参数（`name` / `description` / `parameters`），注册到工具表。模型返回调用意图后按名称查找并执行。

### TUI 渲染

没有直接用现成的终端 UI 方案，而是基于 **DECSTBM**（`ESC[top;bottom r`，设置终端滚动区域）自研了一套渲染层：

- 上方固定区域显示状态 / 输入，下方为可滚动的内容区
- 这样流式输出时不会把界面顶乱，滚动行为也更接近原生终端

### 测试策略

TUI 的渲染逻辑很难用普通单测覆盖（涉及 ANSI 转义序列、光标控制、流式刷新）。因此实现了一个**终端模拟器**（`src/testing/term-sim.ts`），模拟输入输出流做端到端断言——测的是**交互流程**，而不只是函数返回值。

## 相关项目

- **[DevAgent Harness](https://github.com/jun2333/dev-agent-harness)** —— AI 开发工作流工具箱，本项目通过 git submodule（`.harness/`）接入其工作流引擎

## License

MIT
