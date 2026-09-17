---
tags: [rework, review, defect-family, process]
confidence: 0.5
created: 2026-09-17
last_used: 2026-09-17
use_count: 1
source_task: 006
status: active
invalidation_condition: "当修复是真正单点、无同族路径时（例如纯文案调整），本条不适用"
source_refs: [.harness/workspace/006/review-report.md, src/tools/executor.ts]
---

# 修一个路径上的缺陷时，必须同时检查同族路径；返工后要派定点复审

## 场景
审查提出缺陷、定点修复完成、准备放行时。

## 问题
W-3 修好了 `read` 的"截断劈坏 JSON 信封"问题，但**同一族的数组形状输出**（`list_dir` / `grep` / `glob` / `web_search`）走的是另一条代码路径，50KB 阈值仍会把 JSON 劈成非法内容（实测 `list_dir` 4000 条目 → 51302B → `JSON.parse` 在 51200 处报错）。

**没有人在修复时想到要检查同族**——是随后派出的定点复审才抓出来（记为 W-R2）。

## 解决方案
1. 修复清单里每条都追问「**同族还有哪些路径**」，按**数据形状 / 入口 / 调用链**分类（字符串结果 vs 数组结果 vs 多模态结果；不同工具的同一类输出）；
2. 返工后派**定点复审**（只复核该修复及其影响面），而不是采信修复者的自述；
3. 定点复审必须**对修复做反证**：把修复回退成错误版本，确认对应用例会 FAIL。任务 006 的三次反证都成立，证明断言可判定而非恒真：
   - C-1 回退 → 墙钟 5012ms 且 `hooks.test.ts` 新用例 FAIL
   - executor codec 回退 → 2000 行不截断、120KB 文件成非法 JSON，4 条用例 FAIL
   - W-1 codec 回退 → `seq 1 40` 行数退化为 1
