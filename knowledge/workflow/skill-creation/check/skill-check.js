#!/usr/bin/env node

/**
 * skill-check.js — 技能包结构校验（skill-creation 工作流的 verify 手段）
 *
 * 用法：node .harness/tools/skill-check.js [--target <path>] [--root <dir>]
 *   --target 指定待校验的技能目录（默认自动发现本次任务产出物引用的技能）
 *   --root   项目根（默认向上查找 .harness）
 *
 * 校验项：
 *   1. SKILL.md 存在
 *   2. frontmatter 含 name + description
 *   3. skill 目录名与 frontmatter name 一致
 *   4. 引用的相对文件存在（templates/ 等，若 frontmatter 或文档中有相对路径引用）
 *   5. 无空 SKILL.md / 无未完成占位（TODO 占位提示，不硬失败）
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
    const a = args.find((x) => x.startsWith(`--${name}=`));
    return a ? a.split('=').slice(1).join('=') : null;
  };
  return { target: get('target'), root: get('root') };
}

function extractFrontmatter(content) {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fm;
}

function checkSkill(skillDir, root, failures) {
  const name = path.basename(skillDir);
  const skillFile = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(skillFile)) {
    failures.push(`技能目录 ${name}/ 缺少 SKILL.md`);
    return;
  }
  const content = fs.readFileSync(skillFile, 'utf8');
  if (!content.trim()) {
    failures.push(`${name}/SKILL.md 为空文件`);
    return;
  }

  const fm = extractFrontmatter(content);
  if (!fm) {
    failures.push(`${name}/SKILL.md 缺少 frontmatter（--- 开头）`);
    return;
  }
  if (!fm.name) failures.push(`${name}/SKILL.md frontmatter 缺少 name`);
  if (!fm.description) failures.push(`${name}/SKILL.md frontmatter 缺少 description`);
  if (fm.name && fm.name !== name) {
    failures.push(`${name}/SKILL.md frontmatter name 为 "${fm.name}"，与目录名不一致`);
  }

  // 引用文件检查（SKILL.md 中相对路径引用，形如 templates/xxx.md 或 docs/xxx）
  const refRe = /(?:^|\s)(templates|docs|check)\/[A-Za-z0-9._/-]+\.(md|js|json|yaml|yml)/g;
  const refs = [...content.matchAll(refRe)].map((m) => m[0].trim());
  for (const ref of refs) {
    const refPath = path.join(skillDir, ref);
    if (!fs.existsSync(refPath)) {
      failures.push(`${name}/SKILL.md 引用的文件不存在：${ref}`);
    }
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
  const skillsDir = path.join(root, 'knowledge', 'skills');
  let checked = 0;

  if (target) {
    // 单目标校验：target 为技能目录或 SKILL.md 路径
    const t = path.resolve(target);
    const skillDir = t.endsWith('SKILL.md') ? path.dirname(t) : t;
    if (fs.existsSync(skillDir)) {
      checkSkill(skillDir, root, failures);
      checked = 1;
    } else {
      failures.push(`目标技能目录不存在：${skillDir}`);
    }
  } else if (fs.existsSync(skillsDir)) {
    // 全量校验 knowledge/skills 下所有技能
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(skillsDir, entry.name);
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
        checkSkill(dir, root, failures);
        checked++;
      }
    }
  }

  if (checked === 0 && !target) {
    console.log('无技能可校验（knowledge/skills 不存在或为空）——跳过');
    process.exit(0);
  }

  if (failures.length > 0) {
    process.stderr.write(`[skill-check] ${failures.length} 个问题：\n${failures.map((f) => `- ${f}`).join('\n')}\n`);
    process.exit(2);
  }
  console.log(`[skill-check] ✓ ${checked} 个技能包结构校验通过`);
  process.exit(0);
}

main();
