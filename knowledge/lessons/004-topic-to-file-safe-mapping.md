---
tags: [security, pattern, input-validation]
confidence: 0.5
created: 2026-08-25
last_used: 2026-09-17
use_count: 3
source_task: 002
status: active
invalidation_condition: "当引入更严格的路径安全机制（如路径 allowlist）时失效"
source_refs: [src/session.ts, src/tools/index.ts]
---

# 用户输入 → 文件名的安全映射（防路径穿越）

## 场景
工具接受用户/LLM 提供的字符串参数（如 memory 的 `topic`）并拼成文件路径。

## 问题
直接拼接会被 `../`、路径分隔符、保留名利用，导致越界读写（如 `topic='../outside'`）。

## 解决方案
封装 `topicToFile(topic)` 校验函数：拒绝空、保留字（如 `index`）、含 `../`、含 `/` 或 `\`；工具层与存储层双重校验；文件写入统一拼接进受控目录（`~/.agent-cli/memory/`）。
