---
tags: [tui, rendering, error-message, testing]
confidence: 0.5
created: 2026-09-16
last_used: 2026-09-17
use_count: 2
source_task: 004
status: active
invalidation_condition: "当渲染层改为对错误/提示文本自动折行时，本条第①点不再需要人工处理；第②点的断言方式仍建议沿用"
source_refs: [src/ui/tui.ts, src/index.e2e.test.ts]
---

# 长诊断文本必须折行渲染；断言屏幕文本要按"整屏拼接"匹配

## 场景
在固定宽度终端里渲染错误/提示这类可能很长的文本。

## 问题
为"静默失败上报"加的截断提示约 230 显示列，而 `showError` 与 `flattenBlocks` 的 `error` 分支都用**单行**渲染（`appendLine` 内部 `truncateTo`）。实测屏幕上只显示到「…上下文固定 4096，无」——**后面最关键的"可操作建议"（`/model`、`OLLAMA_CONTEXT_LENGTH`）整段不可见**，等于提示白写。

写回归用例时又踩了第二层：用 `term.contains('模型输出被截断')` 断言**永远失败**，因为它只查**单行**，而长文本会折行。

## 解决方案
1. **渲染侧**：错误/提示类文本一律按列宽 `wrapText` 逐行输出。`showError` 与 `flattenBlocks` 的 `error` 分支都要改；同区域的 `tool` 分支若也承载多行内容（如 `addInfo` 输出 `/help`）需一并处理——否则全量重绘后会出现阶梯状错乱排版。
2. **测试侧**：断言长文本时把整屏行**拼接**后再做子串匹配（`term.dump().join('').includes(text)`），否则会在折行边界处漏判。
3. **文案设计**：把"可操作建议"放在**靠前**位置，避免被截断吃掉。
