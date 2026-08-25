# 知识库索引

> 本文件由 `.harness/tools/knowledge-index.js` 自动生成，手动修改会被覆盖。

## 规范 (Standards)

- [代码规范（agent-cli）](standards/code-style.md) — 基于项目实际代码提炼，改动代码时必须遵守。
- [测试规范（agent-cli）](standards/testing-rules.md)

## 模式 (Patterns)

- [DECSTBM 滚动区 + 整区重绘渲染模式](patterns/decstbm-rendering.md) — 自研终端 TUI 需要"内容区可滚动、状态栏/输入框固定、流式输出不错乱、保留终端滚动历史（滚动条）"。
- [会话持久化：workspace 隔离 + 文件锁](patterns/session-lock.md) — CLI 工具需要会话落盘、多工作目录隔离、防多进程并发编辑同一会话、异常退出不残留冲突。

## 业务技能 (Skills)

- [designing](skills/designing/SKILL.md) — 设计阶段技能（项目版）。将需求转化为技术方案，决策记录进 design.md，至少 2 个备选方案。
- [git-operations](skills/git-operations/SKILL.md) — Git 提交与回滚技能（项目版）。提交前运行项目验证命令，遵循项目提交规范。
- [implementing](skills/implementing/SKILL.md) — 实施阶段技能（项目版）。按 task-plan.md 执行代码变更，遵循项目代码规范，验证以项目验证配置为准。
- [reviewing](skills/reviewing/SKILL.md) — 审查阶段技能（项目版）。审查变更的正确性、完整性，对照代码规范与测试结果。
- [task-planning](skills/task-planning/SKILL.md) — 任务计划阶段技能（项目版）。把设计拆解为可执行步骤，记录命中的既有经验。
- [testing](skills/testing/SKILL.md) — 测试阶段技能（项目版）。vitest 单测（session/tools/渲染纯函数）+ ANSI 模拟器 UI 端到端（tui.e2e.test.ts），verify 通道执行 build+test。

## 资产索引

- [组件与 API 索引](component-index.md) — 前后端组件、API、工具的结构化清单（tech-audit 技能生成）

## 经验 (Lessons)

- [索引化记忆 + 按需加载](lessons/001-memory-index-loading.md) — CLI agent 需要跨会话长期记忆，但直接全量加载记忆进 system prompt 会随内容膨胀；LLM 需要先知道"有什么"再决定"读什么"。
- [对话式完成工作流阶段后需补编排层状态](lessons/002-orchestrator-stage-result.md) — 用 harness requirements 等工作流时，各阶段产出以对话方式完成（用户逐条拍板、文档定稿），但未逐阶段调用 `core.js` 推进编排层。
- [task 目录命名规范（workspace/{task-id}）](lessons/003-task-dir-naming.md) — harness 工作流的任务目录命名。

## 归档 (Archive)

_暂无_
