/**
 * skills.test.ts — 技能最小发现层（V-6 / AC-23）
 *
 * 覆盖：
 * - D29 的 frontmatter 解析（必填 name/description、可选 allowed-tools、容忍未知键/引号/CRLF）
 * - 格式不符的文件**跳过 + 告警而不抛**（无 frontmatter / 未闭合 / 缺必填字段 / 不可读）
 * - 两个扫描根（用户级 + 项目级）的合并、确定性顺序、同名去重（用户级胜出）
 * - `createSkillCompletionSource` 的候选形状（label 自带 `/`、`kind='skill'`）与告警去重
 *
 * 隔离：全部用例把扫描根注入到 `mkdtempSync` 的临时目录（`/tmp` 下，测试后删除），
 * **不读也不写真实的 `~/.agent-cli`**；`skillDirs()` 默认路径的用例用临时 `AGENT_CLI_DIR` 断言。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { projectRoot } from './config.js'
import {
  createSkillCompletionSource,
  discoverSkills,
  parseSkillFrontmatter,
  SKILL_FILE_NAME,
  skillCandidates,
  skillDirs,
} from './skills.js'

let tmp: string
let userDir: string
let projectDir: string
let origEnv: string | undefined

/** 写一个技能目录（内容原样写入 `SKILL.md`） */
function writeSkill(root: string, dirName: string, content: string) {
  mkdirSync(join(root, dirName), { recursive: true })
  writeFileSync(join(root, dirName, SKILL_FILE_NAME), content)
}

const VALID = '---\nname: demo-skill\ndescription: 演示技能\n---\n正文\n'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-cli-skills-'))
  userDir = join(tmp, 'user-skills')
  projectDir = join(tmp, 'project-skills')
  mkdirSync(userDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  if (origEnv === undefined) delete process.env.AGENT_CLI_DIR
  else process.env.AGENT_CLI_DIR = origEnv
  origEnv = undefined
  rmSync(tmp, { recursive: true, force: true })
})

describe('技能 frontmatter 解析（D29）', () => {
  it('合法文件：取到 name 与 description', () => {
    expect(parseSkillFrontmatter(VALID)).toEqual({
      ok: true,
      frontmatter: { name: 'demo-skill', description: '演示技能' },
    })
  })

  it('allowed-tools 可选：逗号分隔与 JSON 数组两种写法都能解析', () => {
    const comma = parseSkillFrontmatter('---\nname: a\ndescription: b\nallowed-tools: read, write\n---\n')
    expect(comma).toEqual({ ok: true, frontmatter: { name: 'a', description: 'b', allowedTools: ['read', 'write'] } })

    const json = parseSkillFrontmatter('---\nname: a\ndescription: b\nallowed-tools: ["read","bash"]\n---\n')
    expect(json).toEqual({ ok: true, frontmatter: { name: 'a', description: 'b', allowedTools: ['read', 'bash'] } })
  })

  it('容忍：引号包裹的值、CRLF 行尾、未知键、注释、name 前导 `/`', () => {
    const text = '---\r\n# 注释\r\nname: "/demo-skill"\r\ndescription: \'演示\'\r\nunknown-key: x\r\n---\r\n'
    expect(parseSkillFrontmatter(text)).toEqual({
      ok: true,
      frontmatter: { name: 'demo-skill', description: '演示' },
    })
  })

  it('无 frontmatter / 未闭合 / 缺必填字段 → 失败且原因面向用户', () => {
    expect(parseSkillFrontmatter('# 只有正文\n')).toEqual({
      ok: false,
      reason: '缺少 frontmatter（文件第一行必须是 ---）',
    })
    expect(parseSkillFrontmatter('---\nname: a\n')).toEqual({
      ok: false,
      reason: 'frontmatter 未闭合（缺少结束的 ---）',
    })
    expect(parseSkillFrontmatter('---\ndescription: b\n---\n')).toEqual({ ok: false, reason: '缺少必填字段 name' })
    expect(parseSkillFrontmatter('---\nname: a\n---\n')).toEqual({ ok: false, reason: '缺少必填字段 description' })
    expect(parseSkillFrontmatter('')).toEqual({ ok: false, reason: '缺少 frontmatter（文件第一行必须是 ---）' })
  })
})

describe('技能扫描：discoverSkills（两个根 + 跳过 + 告警）', () => {
  it('用户级 + 项目级合并；顺序确定（用户级在前，根内按目录名排序）', () => {
    writeSkill(projectDir, 'proj-b', '---\nname: proj-b\ndescription: pb\n---\n')
    writeSkill(projectDir, 'proj-a', '---\nname: proj-a\ndescription: pa\n---\n')
    writeSkill(userDir, 'user-z', '---\nname: user-z\ndescription: uz\n---\n')

    const skills = discoverSkills({ userDir, projectDir })
    expect(skills.map((s) => s.name)).toEqual(['user-z', 'proj-a', 'proj-b'])
    expect(skills[0]).toMatchObject({ source: 'user', path: join(userDir, 'user-z', SKILL_FILE_NAME) })
    expect(skills[1]).toMatchObject({ source: 'project' })
  })

  it('目录不存在 → 静默返回空（未装技能是常态，不是错误）', () => {
    const warnings: string[] = []
    const skills = discoverSkills({
      userDir: join(tmp, 'nope-user'),
      projectDir: join(tmp, 'nope-project'),
      warn: (m) => warnings.push(m),
    })
    expect(skills).toEqual([])
    expect(warnings).toEqual([])
  })

  it('目录里没有 SKILL.md / 非目录项 → 静默跳过', () => {
    mkdirSync(join(userDir, 'empty-dir'), { recursive: true })
    writeFileSync(join(userDir, 'loose.md'), VALID)
    expect(discoverSkills({ userDir, projectDir })).toEqual([])
  })

  it('无 frontmatter / 缺必填字段 → 跳过并告警，不抛、不影响其他技能', () => {
    writeSkill(userDir, 'ok', VALID)
    writeSkill(userDir, 'no-fm', '# 没有 frontmatter\n')
    writeSkill(userDir, 'no-desc', '---\nname: no-desc\n---\n')
    const warnings: string[] = []

    const skills = discoverSkills({ userDir, projectDir, warn: (m) => warnings.push(m) })
    expect(skills.map((s) => s.name)).toEqual(['demo-skill'])
    const log = warnings.join('\n')
    expect(log).toContain('缺少 frontmatter')
    expect(log).toContain('缺少必填字段 description')
    expect(log).toContain(join(userDir, 'no-fm', SKILL_FILE_NAME)) // 告警带路径，便于排查
  })

  it('同名技能 → 只保留先扫到的（用户级胜出），并告警（不静默丢弃）', () => {
    writeSkill(userDir, 'a', '---\nname: same\ndescription: 用户级\n---\n')
    writeSkill(projectDir, 'b', '---\nname: same\ndescription: 项目级\n---\n')
    const warnings: string[] = []

    const skills = discoverSkills({ userDir, projectDir, warn: (m) => warnings.push(m) })
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ description: '用户级', source: 'user' })
    expect(warnings.join('\n')).toContain('技能名重复')
  })
})

describe('技能扫描根的默认路径（AGENT_CLI_DIR 覆盖）', () => {
  it('用户级 = agentCliDir()/skills；项目级 = <项目根>/.agent-cli/skills', () => {
    origEnv = process.env.AGENT_CLI_DIR
    process.env.AGENT_CLI_DIR = tmp
    expect(skillDirs()).toEqual([
      { dir: join(tmp, 'skills'), source: 'user' },
      { dir: join(projectRoot, '.agent-cli', 'skills'), source: 'project' },
    ])
  })
})

describe('createSkillCompletionSource（AC-23 的候选源）', () => {
  it('id 固定 skills；候选 label 自带 `/`、detail=description、kind=skill', () => {
    writeSkill(userDir, 'demo-skill', '---\nname: demo-skill\ndescription: 演示技能\n---\n')
    const src = createSkillCompletionSource({ userDir, projectDir })
    expect(src.id).toBe('skills')
    expect(src.list()).toEqual([{ label: '/demo-skill', detail: '演示技能', kind: 'skill' }])
  })

  it('每次 list() 重新扫盘（新增技能文件无需重启）', () => {
    const src = createSkillCompletionSource({ userDir, projectDir })
    expect(src.list()).toEqual([])
    writeSkill(userDir, 'late', '---\nname: late\ndescription: 后来加的\n---\n')
    expect(src.list()).toEqual([{ label: '/late', detail: '后来加的', kind: 'skill' }])
  })

  it('告警去重：坏文件在多次 list() 中只报一次（菜单反复打开不刷屏）', () => {
    writeSkill(userDir, 'bad', '# 没有 frontmatter\n')
    const warnings: string[] = []
    const src = createSkillCompletionSource({ userDir, projectDir, warn: (m) => warnings.push(m) })

    src.list()
    src.list()
    src.list()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('缺少 frontmatter')
  })

  it('skillCandidates 是纯函数（不改入参、顺序原样）', () => {
    const skills = discoverSkillsSeed()
    const snapshot = JSON.stringify(skills)
    expect(skillCandidates(skills).map((c) => c.label)).toEqual(['/b', '/a'])
    expect(JSON.stringify(skills)).toBe(snapshot)
  })
})

/** 供纯函数用例使用的两条已发现技能（顺序刻意非字典序，锁定"原样保留"） */
function discoverSkillsSeed() {
  return [
    { name: 'b', description: 'B', path: '/x/b/SKILL.md', source: 'user' as const },
    { name: 'a', description: 'A', path: '/x/a/SKILL.md', source: 'project' as const },
  ]
}
