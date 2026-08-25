# Agent Instructions

本项目使用 DevAgent Harness 工作流（`.harness` 为 submodule）。

## 何时使用 Harness

判断标准是**任务复杂度**：

- **需要走 harness**：任务涉及多步决策、有明确产出物、需要用户审批、或可能影响多个文件/模块
- **可以跳过 harness**：简单的单步操作（改个配置、修个 typo、回答一个问题）

## 首次使用（初始化知识库与工作流）

项目首次接入 harness 时，必须先完成初始化，否则 `harness workflows` 为空、`knowledge/` 缺失：

1. **初始化知识库**（技能见 `.harness/skills/tools/knowledge-init/SKILL.md`）：
   - `knowledge-init scan`：扫描项目，生成 `knowledge/standards/`、`knowledge/patterns/`、`knowledge/_index.md`，更新 `AGENTS.md`
   - `knowledge-init skills`：基于 scan 产出生成 `knowledge/skills/`（6 个阶段技能）+ `knowledge/verify.config.json` + `knowledge/env-check.config.json`
2. **初始化工作流**：`node .harness/tools/workflow-init.js init <name>` 把 `.harness/workflows/` 模板实例化到 `knowledge/workflow/`；缺命令池 key 时补 `knowledge/verify.config.json` 的 commands 或编辑项目副本 `verify.checks` 绑定项目实际验证命令
3. **校验**：`node .harness/harness workflows` 能看到工作流；`node .harness/workflows/workflow-creation/check/workflow-check.js --target <name>` 校验通过

**判定是否已初始化**：执行 `node .harness/harness workflows`，若提示"无可用工作流（knowledge/workflow 为空）"，说明知识库/工作流未初始化，按上面步骤先初始化，不要直接 `harness start`。

## 如何启动

需要走 harness 流程时，从 `.harness/harness.md` 启动，**第一步是选择工作流**：

- 做新功能或重构 → `feature.yaml`
- 修 bug → `bugfix.yaml`
- 创建/重构技能 → `skill-creation.yaml`
- 项目初始化 → `project-init.yaml`

现有工作流都不匹配时，询问用户应该使用哪个工作流。不要跳过 harness 直接动手做复杂任务。

## 项目结构

- `src/` — 源码（TypeScript ESM，Node + tsx）
  - `src/index.ts` — 入口：参数解析、system prompt 组装、交互/单轮编排、`-r` 会话选择
  - `src/agent/loop.ts` — agent loop（LLM 流式 → 事件 → 工具执行 → 回传）
  - `src/tools/` — 工具定义与实现（bash/read/write/edit/list_dir/glob/grep/web_search）
  - `src/ui/tui.ts` — 自研 DECSTBM TUI 渲染层
  - `src/session.ts` — 会话持久化（workspace 隔离 + 锁）+ 用户配置加载
  - `src/config.ts` — 配置（ollama 地址、模型等）
- `docs/` — 项目文档（初始需求文档等）
- `knowledge/` — 项目知识库（standards/patterns/skills/workflow，由 knowledge-init 生成）
- `.harness/` — DevAgent Harness submodule（工作流引擎，勿直接改动；有演进需求走 harness 流程）

## 运行

```
pnpm dev              # 启动交互 TUI（tsx 直跑源码）
pnpm build            # tsc 编译到 dist/
node dist/index.js    # 用编译产物运行
node dist/index.js -r # 选择历史会话恢复
```

## 验证

- `pnpm test`（vitest）：纯逻辑单测（session/tools/渲染纯函数）+ TUI 端到端（ANSI 模拟器，`src/ui/tui.e2e.test.ts`）。
- `npx tsc --noEmit` 类型检查；`pnpm build` 编译。
- 验证命令见 `knowledge/verify.config.json`（verify 通道执行 build + test），工作流阶段 gate 据此他证。
- 测试规范见 `knowledge/standards/testing-rules.md`；TUI 测试基础设施为 `src/testing/term-sim.ts`。

## 知识库

项目知识库在 `knowledge/`（已用 knowledge-init 初始化）。框架通用技能在 `.harness/skills/`。
