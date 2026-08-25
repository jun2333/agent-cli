---
tags: [pattern, session, concurrency, locking]
confidence: 0.9
created: 2026-08-25
status: active
source_refs: [src/session.ts]
invalidation_condition: "会话存储迁移到数据库等非文件系统方案时失效"
---

# 会话持久化：workspace 隔离 + 文件锁

## 场景
CLI 工具需要会话落盘、多工作目录隔离、防多进程并发编辑同一会话、异常退出不残留冲突。

## 方案
1. **workspace 隔离**：`session/<cwd-sha256前16位>/`，用启动目录 hash 定位子目录，天然只列出当前目录的会话，无需筛选。
2. **无落盘"当前会话"指针**：本次会话 id 只存进程内存，保存显式传 id → 无退出清空、异常残留、跨进程"当前会话"冲突问题。
3. **文件锁**：每个会话旁 `.lock` 文件存 `{ pid, startedAt }`：
   - 获取：持有者 pid 存活 → 拒绝；无锁/pid 已死 → 接管。
   - 存活探测：`process.kill(pid, 0)` 只探测不实际发信号（`ESRCH`=不存在，`EPERM`=存在）。
   - 释放：只删除自己持有的锁（pid 匹配）；正常退出路径统一释放。
   - 被锁会话在 `-r` 列表中不可选（灰色 + 跳过）。
4. **实时保存**：每条用户消息、每次回答完成后写盘，不是退出时保存 → 异常退出最多丢半截流式回答。

## 关键细节
- `isSessionLocked` 要排除当前进程自己的 pid（自己编辑的会话对自己不算锁）。
- 锁文件损坏（parse 失败）视为可接管。
- 交互选择会话用 TTY 箭头键单选（`readline.emitKeypressEvents` + rawMode），非 TTY 降级数字输入。
