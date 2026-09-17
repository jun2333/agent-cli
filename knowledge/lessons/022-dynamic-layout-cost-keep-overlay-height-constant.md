---
tags: [tui, decstbm, layout, performance, ux]
confidence: 0.5
created: 2026-09-17
last_used: 2026-09-17
use_count: 1
source_task: 006
status: active
invalidation_condition: "当 TUI 不再依赖 DECSTBM 滚动区（改为完全自管视口 / 增量绘制）时，本条描述的具体代价消失；但『可变布局的每次变化都要付一次整屏重建』这一判断仍成立"
source_refs: [src/ui/tui.ts, src/ui/overlay.ts, .harness/workspace/006/design.md]
---

# 动态布局的固有代价 —— 缓解规则是"浮层高度在生命周期内恒定"

## 场景
在基于 DECSTBM 滚动区的自研 TUI 里做内联浮层（补全菜单、权限审批、任务列表、信任确认）。

## 问题
浮层要占行 → `contentRows` 变化 → 必须**整区重建**，而重建 = 清屏 + 清 scrollback + **从 `blocks` 全量重推全部 overflow 行**（`onResize()` 的既有循环）。

`\x1b[3J`（清 scrollback）在这个机制里是**必需**的——因为重建是**全量重推**，不清就会整段重复。所以这不是冗余代码。

代价：每次开/关整屏重刷、**滚动位置被重置**、长会话下代价线性增长（200 行会话实测 **9.2KB/次**）。若浮层高度还会**随内容变化**（候选数变化、列表→详情切换），打字过程中就会反复触发重建。

## 解决方案
**浮层高度在其生命周期内恒定**——候选数 / 内容变化只改**行内容**，不改**行数**；只在"出现 / 消失"时各重建一次。

任务 006 的落地：`/` 补全菜单高度固定为 `min(候选总数, 8) + 1`，`updateQuery` **绝不触碰高度**；用 e2e 断言（候选 10→3→1→0 全程 `height` / `contentRows` / `reservedRows()` 不变、重建恰好 2 次）+ **故障注入反证**（把 `updateQuery` 改成会改高度 → 3 条用例 FAIL）锁死。

**长期备选**（若整屏重刷在真机上难忍）：改为"浮层覆盖内容区底部、不改 `contentRows`"——零重建、零预留浪费，但浮层会出现在输入框**上方**（偏离"内容区收缩"的原始视觉约定）。
