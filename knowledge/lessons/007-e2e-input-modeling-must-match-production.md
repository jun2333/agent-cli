---
tags: [testing, tui, terminal, e2e]
confidence: 0.5
created: 2026-09-16
last_used: 2026-09-17
use_count: 2
source_task: 004
status: active
invalidation_condition: "当项目不再用 readline 解析按键（改为直接解析 stdin 字节流，或引入 ink/blessed 等框架）时，本条的具体事件形状结论失效；但『模拟输入形状须与生产一致』这一原则仍成立"
source_refs: [src/ui/tui.ts, src/ui/tui.e2e.test.ts]
---

# e2e 的"输入建模"必须与生产输入逐字段一致

## 场景
用模拟器（TermSim）在进程内驱动 TUI 做端到端测试，被测逻辑由键盘/粘贴输入驱动。

## 问题
任务 004 的 bracketed paste 有一个 Critical 缺陷：粘贴多行文本会**丢掉全部换行**（`l0\nl1\nl2` → `l0l1l2`）。根因是 `Ctrl+J` 分支（`name==='enter' && sequence==='\n'`）排在 `pasting` 守卫之前，真实 readline 把粘贴中的 `\n` 报成 `{name:'enter', sequence:'\n'}`，于是被当成 Ctrl+J 抢先插入缓冲、提交时又被 `trim()` 吃掉。

**286 条用例全绿却完全没抓到**：e2e 写的是 `press(整段粘贴文本, undefined, {sequence: 整段})`——把整段粘贴当**单个** keypress 喂入，而真实 readline **从不这样发**（逐字符派发 + 换行报成 `enter`）。同一建模失真还让「`\n` 仍按 Enter 提交」这条用例成为**假阳性**（它发 `name: undefined`，真实事件里 LF 会命中 Ctrl+J）。只有独立审查者用真实 `readline.emitKeypressEvents` 驱动真实 TUI 才暴露。

## 解决方案
写模拟器用例前，**先用真实解析器跑一次探针，把事件形状抄下来**，再据此构造辅助器。本项目据此新增 `pasteText()`（`src/ui/tui.e2e.test.ts`），按实测形状派发：`paste-start` → 逐字符（`\n` → `{str:'\n', name:'enter', sequence:'\n'}`、`\r` → `{str:'\r', name:'return', sequence:'\r'}`）→ `paste-end`，并在辅助器注释里写明"不要用整段单 keypress 代替"。

判据：**凡是"模拟输入"的测试，都要能回答"这个事件形状是实测抄来的还是我编的"**。
