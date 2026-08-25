#!/usr/bin/env node

/**
 * req-check.js — 需求文档结构校验（requirements 工作流的 verify 手段）
 *
 * 校验对象：workspace/{task-id}/task.md（requirements 流程产出物）
 * 校验项（机械，无 LLM）：
 *   1. task.md 存在
 *   2. 必含区块齐全：背景与目标 / 范围 / 功能需求 / 验收标准 / 待确认问题
 *   3. 功能需求至少 1 个（## 功能需求 下存在 ### FR-）
 *   4. 验收标准至少 1 条（## 验收标准 下存在 - [ ]）
 *   5. 待确认问题区为空（## 待确认问题 下无 - [ ] 条目）——定稿条件
 *
 * 退出码：0 = 通过；2 = 失败（stderr 列出问题）
 */

const fs = require('fs');
const path = require('path');

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
    return eq ? eq.split('=').slice(1).join('=') : null;
  };
  return { taskId: get('task-id'), root: get('root') };
}

/** 按区块标题切分内容，返回 { title, body } 段落数组 */
function splitSections(content) {
  const lines = content.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      current = { title: m[1].trim(), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return sections;
}

function checkTaskFile(taskFile) {
  const failures = [];
  if (!fs.existsSync(taskFile)) {
    return [`需求文档缺失：${taskFile}`];
  }
  const content = fs.readFileSync(taskFile, 'utf8');
  const sections = splitSections(content);

  const REQUIRED = ['背景与目标', '范围', '功能需求', '验收标准', '待确认问题'];
  const titles = sections.map((s) => s.title);
  for (const r of REQUIRED) {
    if (!titles.includes(r)) {
      failures.push(`需求文档缺少必含区块：## ${r}`);
    }
  }

  const body = (title) => {
    const s = sections.find((x) => x.title === title);
    return s ? s.body.join('\n') : '';
  };

  // 功能需求至少 1 个 FR
  const frCount = (body('功能需求').match(/^###\s+FR-/gm) || []).length;
  if (frCount === 0) failures.push('功能需求为空：需至少 1 条 `### FR-x {功能名}`');

  // 验收标准至少 1 条
  const acCount = (body('验收标准').match(/^-\s+\[[ x]\]/gm) || []).length;
  if (acCount === 0) failures.push('验收标准为空：需至少 1 条 `- [ ] {完成条件}`');

  // 待确认问题区必须为空（定稿条件）
  const openCount = (body('待确认问题').match(/^-\s+\[[ x]\]/gm) || []).length;
  if (openCount > 0) {
    failures.push(`待确认问题区仍有 ${openCount} 条未拍板（feature 启动前必须清零）`);
  }

  return failures;
}

function main() {
  const { taskId, root } = parseArgs();
  const harnessRoot = findHarnessRoot(root || process.cwd());
  if (!harnessRoot) {
    console.error(`[req-check] 未找到 .harness：${root || process.cwd()}`);
    process.exit(1);
  }

  // verify.js 执行 check 脚本时不传 --task-id，需自动发现最新活跃 checkpoint 的任务
  let tid = taskId;
  if (!tid) {
    const ws = path.join(harnessRoot, '.harness', 'workspace');
    if (fs.existsSync(ws)) {
      let latest = null;
      let latestMtime = 0;
      for (const entry of fs.readdirSync(ws, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const cp = path.join(ws, entry.name, 'checkpoint.json');
        if (!fs.existsSync(cp)) continue;
        const mtime = fs.statSync(cp).mtimeMs;
        if (mtime > latestMtime) { latestMtime = mtime; latest = entry.name; }
      }
      tid = latest;
    }
  }
  if (!tid) {
    console.error('[req-check] 未指定 --task-id 且找不到活跃任务（checkpoint）');
    process.exit(2);
  }

  const taskFile = path.join(harnessRoot, '.harness', 'workspace', tid, 'task.md');
  const failures = checkTaskFile(taskFile);

  if (failures.length === 0) {
    console.log(`[req-check] 需求文档结构校验通过（task: ${tid}）`);
    process.exit(0);
  }
  console.error(`[req-check] 需求文档校验未通过（task: ${tid}，${failures.length} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(2);
}

if (require.main === module) main();

module.exports = { checkTaskFile, splitSections };
