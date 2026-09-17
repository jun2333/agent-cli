---
tags: [security, path-traversal, fix-regression]
confidence: 0.5
created: 2026-09-16
last_used: 2026-09-17
use_count: 2
source_task: 004
status: active
invalidation_condition: "当项目把路径校验下沉到统一中间件（所有文件访问强制走 safe-fs 层）后，本条的具体做法被该机制取代"
source_refs: [src/ui/tui.ts, src/images.ts, src/ui/tui.e2e.test.ts]
---

# 修复引入新代码时，安全边界必须复用既有校验函数

## 场景
修一个功能缺陷时，新写的代码需要做"路径/权限/输入合法性"判断。

## 问题
修 `Ctrl+G` 丢图（占位符往返）时，新写的 resolver 用 `join(imageDir(), name)` + `existsSync` 判断"图片是否存在"，**没有复用项目既有的 `images.resolveImagePath`**。而 `name` 来自用户在编辑器里手打的 `[image: ...]`，可含 `..` → 复审者实测 `[image: ../../../../etc/passwd]` 把 `/etc/passwd` 读成图片、base64 后作为 `image_url` 发进消息，**完全跳过白名单**（对比：`view_image` 与 `Ctrl+V` 都必经白名单）。

即：**修复功能缺陷的动作，自己开了一个新的越权面**。

## 解决方案
修复涉及路径/权限判断时，**只允许复用既有的边界函数**——本例改为 `resolveImagePath(join(imageDir(), name))`（白名单 + 软链二次校验都在里面），必要时叠加条件（如再要求 `existsSync` 以保留"手写占位符不存在则保留字面量"的既有语义），但不得绕开。

配套：给新路径补一条**越权回归用例**（含 `..` 的占位符必须被拒），并做**反证**（还原修复后该用例应 FAIL）。
