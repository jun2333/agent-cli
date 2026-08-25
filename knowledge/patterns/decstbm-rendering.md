---
tags: [pattern, tui, rendering, decstbm]
confidence: 0.9
created: 2026-08-25
status: active
source_refs: [src/ui/tui.ts]
invalidation_condition: "TUI 渲染层整体重写（如改用 ink/react）时失效"
---

# DECSTBM 滚动区 + 整区重绘渲染模式

## 场景
自研终端 TUI 需要"内容区可滚动、状态栏/输入框固定、流式输出不错乱、保留终端滚动历史（滚动条）"。

## 方案
1. **备用屏**：进入发 `\x1b[?1049h`，退出 `\x1b[?1049l`，退出时终端恢复主屏。
2. **DECSTBM 滚动区**：`\x1b[1;<contentRows>r` 限定滚动只影响内容区；固定区（状态栏/输入框）写在滚动区外，用 `CUP` 绝对定位。
3. **流式 = 整区原地重绘**：每次 token 后用 `CUP + EL + write` 逐行覆写滚动区最后 `contentRows` 行（显示底部最新内容）。不依赖增量光标追踪，杜绝行宽跨越换行点时的错乱。
4. **保留滚动历史**：重绘前按"新增溢出行数"在滚动区底部发 `\r\n` 触发终端真实滚动，把超出的行推进滚动历史（滚动条可回看）。
5. **resize**：清屏 + 清历史（`\x1b[2J\x1b[3J`，避免 alt-screen reflow 残影重复）+ 重建滚动历史 + 显示底部。

## 关键细节
- `outputRows` 表示**逻辑总行数**（含已滚出屏幕部分），用于 `logicalToPhysical` 映射和增量滚动计算；不要只计可见行数。
- 追加单行时"先滚动再写底部"：先 `\r\n` 触发滚动（底部变空），再 `CUP` 到底部写入，保证最后一行始终在 `contentRows`。
- 清历史 `\x1b[3J` 会让滚动条暂时消失，后续流式会重新产生。
