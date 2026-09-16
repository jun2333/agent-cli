---
tags: [testing, integration, mock, real-environment]
confidence: 0.5
created: 2026-09-16
last_used: 2026-09-16
use_count: 1
source_task: 004
status: active
invalidation_condition: "当项目引入完整的容器化集成测试环境并把 OS 依赖纳入 CI 后，手工 PTY 冒烟的必要性下降；但『注入式 mock 不能替代真实环境』的判断仍成立"
source_refs: [src/clipboard.ts, src/index.ts, .harness/workspace/004/test-report.md]
---

# 注入式 mock 会掩盖集成缺陷；真实环境测试是不可省的独立一层

## 场景
代码要与操作系统/外部命令/真实终端交互，而单测里用注入的假实现替换了这些调用。

## 问题
任务 004 中**只有真实环境测试**才能发现的缺陷至少 5 个：

1. `osascript` 的多行脚本被拆成**多次独立进程**执行（AppleScript 变量不跨进程 → 取图恒失败、产物 0 字节）。注入式 mock 直接写文件、永远成功
2. 输入框含图片时 `onEnter` 收到的是 `ContentPart[]` 而非 `string`，导致所有斜杠命令失效（`/exit` 被当成消息发送）。只有真实 PTY 驱动才暴露
3. 直投路径缺视觉能力预检，泄漏原始 HTTP 400
4. 独立审查者用真实 `readline` 事件形状发现 Critical 丢换行（见 007）
5. 复审者用真实文件系统发现占位符路径穿越（见 008）

## 解决方案
分三层测试并明确各层职责：

| 层次 | 抓什么 |
|---|---|
| 纯逻辑单测 | 算法与边界 |
| 注入式 e2e | 组件编排与渲染 |
| **真实环境冒烟** | OS / 外部命令 / 真实终端的集成契约 |

真实层要能**驱动真实产物**：本项目用 `script -q /dev/null <cmd>` 分配 PTY 驱动 `dist`、用 `osascript` 真实写入剪贴板、用假编辑器脚本走**真实 spawn** 覆盖 `Ctrl+G` 往返。

断言尽量落在**可机读的持久化产物**上（如读会话 JSON 校验内容逐字一致），而不是靠肉眼看终端画面。
