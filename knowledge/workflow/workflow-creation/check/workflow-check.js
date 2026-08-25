#!/usr/bin/env node

/**
 * workflow-check.js — 工作流校验（workflow-creation 工作流的 verify 手段）
 *
 * 用法：node .harness/tools/workflow-check.js [--target <name>] [--root <dir>]
 *   --target 校验单个工作流（默认校验 .harness/workflows/ 下全部）
 *   --root   项目根（默认向上查找 .harness）
 *
 * 校验项（与 workflow-schema.json 语义一致）：
 *   1. workflow.yaml 存在且可解析
 *   2. name 与目录名一致（kebab-case）
 *   3. stages 数组存在，每阶段含 name/skill/output
 *   4. 阶段 name 唯一；gate 枚举（user_approval/none）；require_verify 布尔
 *   5. sections 为二维数组（每组"任一满足"）
 *   6. verify.checks 可解析（内置 check 或命令池 key，或为空）
 *
 * 退出码：0 = 通过；2 = 失败（stderr 列出问题）
 */

const fs = require('fs');
const path = require('path');
// 工作流 check/ 脚本共享 harness 基础设施（相对 __dirname 定位，不依赖调用 cwd）
const { loadWorkflowDefinition, resolveVerifyCommands } = require(path.join(__dirname, '..', '..', '..', 'tools', 'workflow-lib.js'));

function findHarnessRoot(startDir) {
  const candidates = [startDir, process.cwd()];
  for (const dir of candidates) {
    let current = path.resolve(dir || '.');
    while (true) {
      if (fs.existsSync(path.join(current, '.harness'))) return current;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const eq = args.find((x) => x.startsWith(`--${name}=`));
    if (eq) return eq.slice(`--${name}=`.length);
    const idx = args.indexOf(`--${name}`);
    if (idx !== -1 && args[idx + 1] !== undefined) return args[idx + 1];
    return null;
  };
  return { target: get('target'), root: get('root') };
}

function checkWorkflow(root, name, failures) {
  const def = loadWorkflowDefinition(root, name);
  if (!def) {
    failures.push(`工作流 ${name} 加载失败（workflow.yaml 缺失或不可解析）`);
    return;
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(def.name)) {
    failures.push(`工作流 ${name} 的 name "${def.name}" 不符合 kebab-case`);
  }
  if (def.name !== name) {
    failures.push(`工作流目录 ${name} 与 workflow.yaml 的 name "${def.name}" 不一致`);
  }
  if (!def.description) {
    failures.push(`工作流 ${name} 缺少 description`);
  }

  const stages = Object.keys(def.stages);
  if (stages.length === 0) {
    failures.push(`工作流 ${name} 没有 stages`);
  }

  for (const stageName of stages) {
    const st = def.stages[stageName];
    if (!st.skill) failures.push(`工作流 ${name} 阶段 ${stageName} 缺少 skill`);
    if (!st.output) failures.push(`工作流 ${name} 阶段 ${stageName} 缺少 output`);
    if (st.gate && !['user_approval', 'none'].includes(st.gate)) {
      failures.push(`工作流 ${name} 阶段 ${stageName} 的 gate "${st.gate}" 非法（user_approval/none）`);
    }
    if (st.require_verify !== undefined && typeof st.require_verify !== 'boolean') {
      failures.push(`工作流 ${name} 阶段 ${stageName} 的 require_verify 必须为布尔`);
    }
    if (st.sections !== undefined && !Array.isArray(st.sections)) {
      failures.push(`工作流 ${name} 阶段 ${stageName} 的 sections 必须为数组`);
    } else if (Array.isArray(st.sections)) {
      for (const group of st.sections) {
        if (!Array.isArray(group)) {
          failures.push(`工作流 ${name} 阶段 ${stageName} 的 sections 元素必须为数组（每组任一满足）`);
        }
      }
    }
  }

  // verify.checks 可解析性（未定义手段 → 失败）
  try {
    resolveVerifyCommands(root, def);
  } catch (e) {
    failures.push(`工作流 ${name} 的 verify 手段：${e.message}`);
  }
}

function main() {
  const { target, root: rootArg } = parseArgs();
  const root = rootArg ? path.resolve(rootArg) : findHarnessRoot(process.cwd());
  if (!root) {
    console.error('未找到 harness 根（无 .harness 目录）');
    process.exit(2);
  }

  const failures = [];
  const workflowsDir = path.join(root, '.harness', 'workflows');
  const projectDir = path.join(root, 'knowledge/workflow');
  const checkedNames = [];
  let checked = 0;

  if (target) {
    checkWorkflow(root, target, failures);
    checkedNames.push(target);
    checked = 1;
  } else {
    // 项目层 + 通用层全量（同名只校验项目版一次：loadWorkflowDefinition 项目优先）
    const scan = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || checkedNames.includes(entry.name)) continue;
        checkWorkflow(root, entry.name, failures);
        checkedNames.push(entry.name);
        checked++;
      }
    };
    scan(projectDir);   // 项目层优先
    scan(workflowsDir); // 通用层
  }

  if (checked === 0) {
    console.log('无工作流可校验（.harness/workflows 不存在或为空）——跳过');
    process.exit(0);
  }

  if (failures.length > 0) {
    process.stderr.write(`[workflow-check] ${failures.length} 个问题：\n${failures.map((f) => `- ${f}`).join('\n')}\n`);
    process.exit(2);
  }
  console.log(`[workflow-check] ✓ ${checked} 个工作流校验通过`);
  process.exit(0);
}

main();
