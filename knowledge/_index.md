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
- [用户输入 → 文件名的安全映射（防路径穿越）](lessons/004-topic-to-file-safe-mapping.md) — 工具接受用户/LLM 提供的字符串参数（如 memory 的 `topic`）并拼成文件路径。
- [verify 捕获的日志需禁用 ANSI 颜色](lessons/005-verify-log-no-ansi.md) — verify 通道用 `execSync` 捕获子命令（vitest/tsc）stdout 到 log 文件。
- [工作流 sections 校验是精确标题匹配](lessons/006-workflow-sections-exact-match.md) — validate 检查阶段产出物的必含区块（workflow.yaml 的 sections）。
- [e2e 的"输入建模"必须与生产输入逐字段一致](lessons/007-e2e-input-modeling-must-match-production.md) — 用模拟器（TermSim）在进程内驱动 TUI 做端到端测试，被测逻辑由键盘/粘贴输入驱动。
- [修复引入新代码时，安全边界必须复用既有校验函数](lessons/008-reuse-existing-security-boundary-in-fixes.md) — 修一个功能缺陷时，新写的代码需要做"路径/权限/输入合法性"判断。
- [循环必须把"结束了但没产出"当成一等事件上报](lessons/009-loop-must-report-empty-completion.md) — 任何"多轮迭代直到产出结果"的循环（agent loop、构建流水线、重试器）。
- [长诊断文本必须折行渲染；断言屏幕文本要按"整屏拼接"匹配](lessons/010-wrap-long-diagnostic-text.md) — 在固定宽度终端里渲染错误/提示这类可能很长的文本。
- [注入式 mock 会掩盖集成缺陷；真实环境测试是不可省的独立一层](lessons/011-injected-mocks-hide-integration-defects.md) — 代码要与操作系统/外部命令/真实终端交互，而单测里用注入的假实现替换了这些调用。
- [阈值与计数类逻辑要统一单位，且行数统计必须认所有行尾](lessons/012-unify-threshold-and-count-units.md) — 对用户输入做长度/行数判定并据此改变展示（折叠、截断、分页）。
- [平台能力"能不能按请求调整"必须实测，不能按文档或直觉假设](lessons/013-probe-platform-capability-adjustability.md) — 设计要依赖某个外部服务/运行时的可调参数（上下文长度、并发、超时）。
- [独立审查能抓到实现者与测试者结构性看不见的缺陷](lessons/014-independent-review-catches-structural-blindspots.md) — 一个功能已由实现者自测 + 测试阶段验证全绿，准备收尾。
- [需求阶段先实测本地推理引擎的隐式能力，再设计上下文/缓存方案](lessons/015-probe-local-engine-capability-before-design.md) — 设计上下文管理、缓存、性能优化类需求时；尤其当用户问"别人（云端 CLI）的缓存是怎么做的"。
- [参考云端 CLI 设计时，必须显式区分「可迁移机制」与「平台特有约束」](lessons/016-distinguish-transferable-mechanisms-from-platform-constraints.md) — 需求里出现"参考 Claude Code / Codex 等主流 CLI 的设计"这类指示时（用户常见要求）。
- [测试报告"全绿"不等于真实路径可用 —— 断言锁了格式却没锁数值/行为](lessons/017-all-green-tests-may-not-cover-real-path.md) — 实现阶段自测全绿、独立测试阶段复查也全绿，准备放行收尾时。
- [子进程用 `close` 结算会让"超时"形同虚设，并把成功的调用误判为超时](lessons/018-subprocess-close-settlement-defeats-timeout.md) — 用 `spawn` 跑外部命令（hook、脚本、后台任务），并需要超时保护时。
- [对抗性/边界性的声明没有实测证据就不许写](lessons/019-adversarial-claims-need-measured-evidence.md) — 在 `changes.md`、测试报告或审查报告里描述"某处风险已被控制"时。
- [修一个路径上的缺陷时，必须同时检查同族路径；返工后要派定点复审](lessons/020-fix-one-path-check-same-family.md) — 审查提出缺陷、定点修复完成、准备放行时。
- [写 AC 要区分「机制可验」与「端到端可验」，否则会造出假的 NOT-RUN](lessons/021-separate-mechanism-verifiable-from-capability-verifiable-ac.md) — 需求阶段为某条能力写验收标准，而该能力的完整实现落在下游期。
- [动态布局的固有代价 —— 缓解规则是"浮层高度在生命周期内恒定"](lessons/022-dynamic-layout-cost-keep-overlay-height-constant.md) — 在基于 DECSTBM 滚动区的自研 TUI 里做内联浮层（补全菜单、权限审批、任务列表、信任确认）。

## 归档 (Archive)

_暂无_
