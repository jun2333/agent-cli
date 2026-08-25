---
tags: [harness, verify, tooling]
confidence: 0.5
created: 2026-08-25
last_used: 2026-08-25
use_count: 1
source_task: 002
status: active
invalidation_condition: "当 verify.js 改用其他日志采集方式（如流式剥离 ANSI）时失效"
source_refs: [.harness/tools/verify.js]
---

# verify 捕获的日志需禁用 ANSI 颜色

## 场景
verify 通道用 `execSync` 捕获子命令（vitest/tsc）stdout 到 log 文件。

## 问题
vitest 默认输出大量 ANSI 颜色码（`\x1b` 字节），log 在 VSCode/日志面板显示为乱码，看不出 pass 结果（用户误以为测试没通过）。

## 解决方案
执行命令时设 `env: { FORCE_COLOR: '0', NO_COLOR: '1' }`，子命令输出纯文本，log 可直接阅读（基座 verify.js 已修复）。
