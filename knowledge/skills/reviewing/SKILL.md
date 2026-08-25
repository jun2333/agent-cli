---
name: reviewing
description: 审查阶段技能（项目版）。审查变更的正确性、完整性，对照代码规范与测试结果。
---

# Reviewing Skill

## Overview
代码审查专家，审查变更是否正确、完整、符合项目规范，产出审查报告（含 Anti-Cherry-Pick 声明）。

## 角色
熟悉 agent-cli 代码规范与架构的审查专家。

## 输入
- 任务描述（task.md）
- 变更清单（changes.md）
- 测试报告（test-report.md）
- 设计文档（design.md）

## 上下文加载指令
1. 精读 changes.md 和 test-report.md，了解变更与验证结果
2. 读取 `knowledge/standards/code-style.md`（对照规范审查）
3. 按需加载变更文件与相关 pattern
4. 对照 design.md 检查实现是否符合设计

## 执行步骤
0. **启动 Skill Log**:
   ```bash
   node .harness/tools/skill-log.js start \
     --skill knowledge/skills/reviewing/SKILL.md \
     --task-id {task-id} \
     --input-files "task.md,changes.md,test-report.md,design.md"
   ```
1. 逐个审查变更文件：逻辑正确性、边界情况、并发/状态一致性
2. 对照 code-style.md 检查：ESM 导入后缀、import type、中文注释、映射表替代大 if/else
3. 审查验证充分性：验证命令是否来自 verify.config.json、纯逻辑是否补了 vitest 用例、TUI 改动是否按 testing-rules.md 补 UI e2e
4. 检查是否引入安全风险（命令注入、路径穿越、XSS 等）
5. 产出审查结论（通过/需修改），列出具体问题与建议
6. 生成审查报告（使用 templates/review-report-output.md）

7. **完成 Skill Log**:
   ```bash
   node .harness/tools/skill-log.js complete \
     --task-id {task-id} \
     --skill-name reviewing \
     --output-file review-report.md \
     --confidence {置信度}
   ```

## 输出
生成 workspace/{task-id}/review-report.md

## 约束
- 必须包含 Summary for downstream 和 Anti-Cherry-Pick Declaration
- 列出全部审查发现（严重/一般/建议），不隐藏
- 验证充分性以测试报告为准，测试报告标"未完成/未通过"时结论不得为"通过"
