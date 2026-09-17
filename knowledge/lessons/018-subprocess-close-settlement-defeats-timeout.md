---
tags: [nodejs, child-process, timeout, hooks, robustness]
confidence: 0.5
created: 2026-09-17
last_used: 2026-09-17
use_count: 1
source_task: 006
status: active
invalidation_condition: "当 Node 改变子进程结算语义（close 不再受管道持有者影响），或平台不支持进程组 kill（Windows 无 kill(-pid)）时，本条的具体做法需调整；但『超时必须自己结算、不得只 kill 不 resolve』在任何平台都成立"
source_refs: [src/hooks.ts, src/tasks.ts]
---

# 子进程用 `close` 结算会让"超时"形同虚设，并把成功的调用误判为超时

## 场景
用 `spawn` 跑外部命令（hook、脚本、后台任务），并需要超时保护时。

## 问题
`src/hooks.ts` 原实现用 `child.on('close')` 结算 Promise，而超时定时器**只** `kill` 不结算：

```js
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)   // 不 resolve
child.on('close', (code) => finish(code))                                              // 只在这里结算
```

`close` 要等 stdout/stderr 管道**全部持有者**退出——hook 命令一旦留下后台子进程（`cmd &`）握着继承来的管道，`close` 永不触发。实测（`timeoutMs: 100`）：

- `sleep 4 & sleep 5` → **5014ms**（超时形同虚设；默认 10s 下挂一个 daemon = **无限挂起 agent loop**）
- `sleep 4 & echo hi`（sh 实际 `exit 0`）→ **4019ms 且被误判「hook 超时」**，PreToolUse 下变成**错误阻塞工具调用**

## 解决方案
1. 以 **`exit`**（进程自身退出）为结算信号，而非 `close`；
2. 超时回调**自己结算**（`timedOut = true` → kill → resolve），保证墙钟上界 ≈ `timeoutMs`；
3. `exit` 之后给 stdout/stderr 一个**有界** flush 宽限（本项目取 50ms）等自己的输出排空，**不无界等待**被孙进程继承的管道关闭；
4. `detached: true` 使 `sh` 成为进程组组长（pgid === pid，已实测），结算时 `kill(-pid)` **连孙进程一起回收**（与 `src/tasks.ts` 的既有做法同构）。

修复后同一探针 **103ms**，且 `exit 0` 不再被误报。

**已声明的副作用**：hook 里 `cmd &` 起的后台进程不再跨调用存活——这与"超时不可被后台进程绕过"**不可兼得**；需要长驻进程应改用 `bash(run_in_background)` / `/jobs`。
