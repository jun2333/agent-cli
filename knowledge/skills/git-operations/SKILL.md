---
name: git-operations
description: Git 提交与回滚技能（项目版）。提交前运行项目验证命令，遵循项目提交规范。
---

# Git-Operations Skill

## Overview
负责工作流的 git 提交与回滚。提交前必须确保验证通过，提交信息清晰描述变更。

## 角色
遵循项目仓库规范的 git 操作员。

## 上下文加载指令
1. 读取 `knowledge/standards/testing-rules.md`（验证命令）
2. 查看当前 git 状态：`git status`、`git diff --stat`、`git log --oneline -5`（确定性事实从实际状态读取）

## 执行步骤
0. **启动 Skill Log**:
   ```bash
   node .harness/tools/skill-log.js start \
     --skill knowledge/skills/git-operations/SKILL.md \
     --task-id {task-id} \
     --input-files "task.md,changes.md"
   ```
1. 提交前运行验证命令（`node .harness/tools/verify.js run`，命令来自 verify.config.json），确认通过
2. 检查暂存内容：`git diff --cached --stat`，确认只包含本任务相关文件
3. 按提交规范写提交信息：`<type>: <摘要>`（feat/fix/refactor/docs/chore），摘要简洁，正文可补充动机
4. 提交后确认 `git log --oneline -1` 与 `git status` 干净

5. **完成 Skill Log**:
   ```bash
   node .harness/tools/skill-log.js complete \
     --task-id {task-id} \
     --skill-name git-operations \
     --output-file changes.md \
     --confidence {置信度}
   ```

## 输出
生成 workspace/{task-id}/changes.md（提交后的最终变更记录）

## 约束
- 不跳过验证直接提交（build 未过不提交）
- 不 `--no-verify` 绕过 hooks；不 force-push
- 破坏性操作（reset --hard、force push、删分支）先确认用户
- 提交信息用中文或英文均可，但同一仓库保持一致；参考已有 `git log` 风格
