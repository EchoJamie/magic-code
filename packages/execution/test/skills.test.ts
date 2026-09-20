/**
 * U33 · 技能的来源面 —— 判据：**发现对不对 · 身份分得开 · 读不懂的不扩大**。
 *
 * 本文件只咬**执行域这一半**（有什么、在哪儿、是哪一版）：三类来源 · 去重与优先 ·
 * 同名照列 · 按身份读取 · 来源内的引用边界 · 诊断。「什么时候送进模型」归对话域与装配，
 * 判据在 `@magic/conversation` 与 `packages/app/test/skills.test.ts`。
 *
 * 判定法同 `rules.test.ts`：临时目录当真工作区（**测试用 fs 不受守护拦**——守护面收窄至
 * 各包 `src/`），每例把目录摆好再断言产物。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillCatalog, Skills } from '@magic/contracts'
import { createSkills } from '../src/skills.ts'
import { createWorkspaceService } from '../src/workspace.ts'

// —— 夹具 ——

/** 一块沙地——一个真临时目录，用完删干净。 */
function sandbox(): { readonly at: string; dispose: () => void } {
  const at = mkdtempSync(join(tmpdir(), 'magic-skills-'))
  return { at, dispose: () => rmSync(at, { recursive: true, force: true }) }
}

/** 在沙地里写一个文件（中间目录自动建）。 */
function put(root: string, relative: string, text: string): string {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

/** 一份讲道理的 `SKILL.md`。 */
function skillText(name: string, description = `关于 ${name} 的专项做法`, body = `照 ${name} 做。`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

/** 造技能面——`roots` 是工作区根，`home` 是用户目录，`sources` 是点名的补充目录。 */
function skillsOf(
  roots: readonly string[],
  home: string,
  sources?: readonly string[],
): Skills {
  return createSkills({
    workspace: createWorkspaceService({ roots }),
    home,
    ...(sources === undefined ? {} : { sources }),
  })
}

/** 发现的抬头——「都是谁、从哪来」一眼看全。 */
function namesOf(catalog: SkillCatalog): readonly string[] {
  return catalog.skills.map((skill) => `${skill.name}@${skill.source}/${skill.origin}`)
}

/** 第一条错误诊断的话（断言「为什么没进来」最省事）。 */
function firstError(catalog: SkillCatalog): string {
  return catalog.problems.find((problem) => problem.kind === 'error')?.message ?? '（没有错误诊断）'
}

// —— ① 三类来源与次序 ——

describe('U33 · 发现', () => {
  test('项目与用户两处默认来源都发现得了；次序＝项目 → 用户，同作用域内 magic → agents', () => {
    const land = sandbox()
    try {
      const home = join(land.at, 'home')
      put(land.at, '.magic/skills/proj-magic/SKILL.md', skillText('proj-magic'))
      put(land.at, '.agents/skills/proj-agents/SKILL.md', skillText('proj-agents'))
      put(home, '.magic/skills/user-magic/SKILL.md', skillText('user-magic'))
      put(home, '.agents/skills/user-agents/SKILL.md', skillText('user-agents'))

      const catalog = skillsOf([land.at], home).discover()

      expect(namesOf(catalog)).toEqual([
        'proj-magic@project/magic',
        'proj-agents@project/agents',
        'user-magic@user/magic',
        'user-agents@user/agents',
      ])
      expect(catalog.problems).toEqual([])
    } finally {
      land.dispose()
    }
  })

  test('点名的补充目录也算一个来源；**同名时默认两处赢**（补充排最后）', () => {
    const land = sandbox()
    try {
      const home = join(land.at, 'home')
      const extra = join(land.at, 'shared-skills')
      put(land.at, '.magic/skills/dup/SKILL.md', skillText('dup', '项目那一份'))
      put(extra, 'dup/SKILL.md', skillText('dup', '共享盘那一份'))

      const catalog = skillsOf([land.at], home, [extra]).discover()

      // 两条都在（同名照列——「其他同名项显示来源并可明确选取」）
      expect(namesOf(catalog)).toEqual(['dup@project/magic', 'dup@configured/magic'])
      // 次序即优先级：靠前那条是 `/dup` 直达取到的那一个
      expect(catalog.skills[0]?.description).toBe('项目那一份')
    } finally {
      land.dispose()
    }
  })

  test('点名的目录**直接是一份技能**也认（不只有「一摞技能」那一种写法）', () => {
    const land = sandbox()
    try {
      const one = join(land.at, 'one-skill')
      put(one, 'SKILL.md', skillText('solo'))

      const catalog = skillsOf([land.at], join(land.at, 'home'), [one]).discover()

      expect(namesOf(catalog)).toEqual(['solo@configured/magic'])
      expect(catalog.skills[0]?.path).toBe(realpathSync(one))
    } finally {
      land.dispose()
    }
  })

  test('默认那几处**不是技能本身**——`.magic/skills` 里躺一份 SKILL.md 只算摆错了地方', () => {
    const land = sandbox()
    try {
      // 默认来源是**容器**：它自己不是技能（点名的那一类才允许直接指技能目录）
      put(land.at, '.magic/skills/SKILL.md', skillText('loose'))

      const catalog = skillsOf([land.at], join(land.at, 'home')).discover()

      expect(catalog.skills).toEqual([])
      expect(firstError(catalog)).toContain('只认子目录')
    } finally {
      land.dispose()
    }
  })

  test('点名的目录不存在——报错（那是用户写下的那一行，不能静默）', () => {
    const land = sandbox()
    try {
      const catalog = skillsOf([land.at], join(land.at, 'home'), [join(land.at, 'nope')]).discover()

      expect(catalog.skills).toEqual([])
      expect(firstError(catalog)).toContain('skills.sources')
    } finally {
      land.dispose()
    }
  })

  test('默认那几处不在——**不报**（多数项目没有 .magic/skills，每次开屏报一句是噪音）', () => {
    const land = sandbox()
    try {
      const catalog = skillsOf([land.at], join(land.at, 'home')).discover()

      expect(catalog).toEqual({ skills: [], problems: [] })
    } finally {
      land.dispose()
    }
  })

  test('物理同源只发现一次（软链接指到同一份技能目录）', () => {
    const land = sandbox()
    try {
      const home = join(land.at, 'home')
      const real = join(land.at, 'shared', 'dup')
      put(land.at, 'shared/dup/SKILL.md', skillText('dup'))

      mkdirSync(join(land.at, '.magic/skills'), { recursive: true })
      symlinkSync(real, join(land.at, '.magic/skills/dup'))

      const catalog = skillsOf([land.at], home).discover()

      expect(catalog.skills).toHaveLength(1)
      // 身份是**真路径**（跟出去之后那一处，且 tmp 目录自己也解析了软链接）——
      // 不扩大执行范围，但读的是它
      expect(catalog.skills[0]?.path).toBe(realpathSync(real))
    } finally {
      land.dispose()
    }
  })

  test('发现只读元数据——**正文一个字节都不进产物**', () => {
    const land = sandbox()
    try {
      const secret = '这段正文不该在发现这一步被读出来'
      put(land.at, '.magic/skills/one/SKILL.md', skillText('one', '一句话说明', secret))

      const catalog = skillsOf([land.at], join(land.at, 'home')).discover()
      const serialized = JSON.stringify(catalog)

      expect(catalog.skills[0]?.description).toBe('一句话说明')
      expect(serialized).not.toContain(secret)
    } finally {
      land.dispose()
    }
  })
})

// —— ② 来源标签（一处产出，多处照印） ——

describe('U33 · 来源标签', () => {
  test('作用域 ＋ 入口两段（同名时人才分得清）；由**发现**产出', () => {
    const land = sandbox()
    try {
      const home = join(land.at, 'home')
      const extra = join(land.at, 'shared-skills')
      put(land.at, '.magic/skills/proj-magic/SKILL.md', skillText('proj-magic'))
      put(land.at, '.agents/skills/proj-agents/SKILL.md', skillText('proj-agents'))
      put(home, '.magic/skills/user-magic/SKILL.md', skillText('user-magic'))
      put(home, '.agents/skills/user-agents/SKILL.md', skillText('user-agents'))
      put(extra, 'extra/SKILL.md', skillText('extra'))

      const labels = skillsOf([land.at], home, [extra])
        .discover()
        .skills.map((skill) => `${skill.name}=${skill.label}`)

      expect(labels).toEqual([
        'proj-magic=项目 .magic/skills',
        'proj-agents=项目 .agents/skills',
        'user-magic=用户 .magic/skills',
        'user-agents=用户 .agents/skills',
        'extra=配置来源 .magic/skills',
      ])
    } finally {
      land.dispose()
    }
  })
})

// —— ③ 读不懂的不认（有诊断） ——

describe('U33 · 诊断', () => {
  test('缺 SKILL.md / front-matter 缺失 / name 不成立 / description 缺失——逐条报，且都不加载', () => {
    const land = sandbox()
    try {
      const home = join(land.at, 'home')
      mkdirSync(join(land.at, '.magic/skills/empty'), { recursive: true })
      put(land.at, '.magic/skills/no-front/SKILL.md', '就是一段正文，没有 front-matter\n')
      put(land.at, '.magic/skills/bad-name/SKILL.md', skillText('Bad_Name'))
      put(land.at, '.magic/skills/no-desc/SKILL.md', '---\nname: no-desc\n---\n\n正文\n')

      const catalog = skillsOf([land.at], home).discover()

      expect(catalog.skills).toEqual([])
      const messages = catalog.problems.map((problem) => problem.message).join('\n')
      expect(messages).toContain('没有 SKILL.md')
      expect(messages).toContain('开头没有 front-matter')
      expect(messages).toContain('name')
      expect(messages).toContain('description')
      // 一条都不静默：四份坏技能＝四条诊断
      expect(catalog.problems).toHaveLength(4)
    } finally {
      land.dispose()
    }
  })

  test('上游的可选字段（含 allowed-tools）**读都不读**——它们不进 Magic 的形态', () => {
    const land = sandbox()
    try {
      put(
        land.at,
        '.magic/skills/risky/SKILL.md',
        '---\nname: risky\ndescription: 想给自己放权的技能\nallowed-tools: Bash(rm:*) Write\nlicense: MIT\nmetadata:\n  author: 谁\n---\n\n正文\n',
      )

      const catalog = skillsOf([land.at], join(land.at, 'home')).discover()
      const skill = catalog.skills[0]
      const shape = Object.keys(skill ?? {}).sort()

      expect(catalog.problems).toEqual([])
      // 只有六件：名字 · 描述 · 身份（真路径）· 来历（作用域 / 入口 / 人读标签）
      expect(shape).toEqual(['description', 'label', 'name', 'origin', 'path', 'source'])
    } finally {
      land.dispose()
    }
  })
})

// —— ③ 按身份读取 ——

describe('U33 · 按需读取', () => {
  test('主文＝去掉 front-matter 的正文；版本随正文变', () => {
    const land = sandbox()
    try {
      const path = join(land.at, '.magic/skills/one')
      put(land.at, '.magic/skills/one/SKILL.md', skillText('one', '说明', '正文第一版'))
      const skills = skillsOf([land.at], join(land.at, 'home'))

      const first = skills.readMain('one', path)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      expect(first.material.text).toBe('正文第一版\n')
      expect(first.material.skill.name).toBe('one')
      // 材料上**没有**「哪一版」这一位（2026-09-21 用户已定：材料动态读取，不算 hash）
      expect(Object.keys(first.material).sort()).toEqual(['skill', 'text'])

      put(land.at, '.magic/skills/one/SKILL.md', skillText('one', '说明', '正文第二版'))
      const second = skills.readMain('one', path)
      expect(second.ok).toBe(true)
      if (!second.ok) return
      // 现扫现读：改了就是新的（不缓存、不订阅）
      expect(second.material.text).toBe('正文第二版\n')
    } finally {
      land.dispose()
    }
  })

  test('来源变了就不认——**不退回同名项**', () => {
    const land = sandbox()
    try {
      put(land.at, '.magic/skills/one/SKILL.md', skillText('one'))
      put(land.at, '.magic/skills/two/SKILL.md', skillText('two'))
      const skills = skillsOf([land.at], join(land.at, 'home'))

      // 那一处现在叫别的名字了（用户换了技能）——身份对不上，照失败
      const read = skills.readMain('one', join(land.at, '.magic/skills/two'))
      expect(read.ok).toBe(false)
      if (read.ok) return
      // 给用户的话只有三件：**哪个技能 · 哪份来源 · 下一步**（不讲发现面怎么认）
      expect(read.reason).toContain('「one」')
      expect(read.reason).toContain(join(land.at, '.magic/skills/two'))
      expect(read.reason).toContain('请重新选择技能')
    } finally {
      land.dispose()
    }
  })

  test('技能被删掉——明确失败（说得出是谁、在哪）', () => {
    const land = sandbox()
    try {
      const path = join(land.at, '.magic/skills/one')
      put(land.at, '.magic/skills/one/SKILL.md', skillText('one'))
      const skills = skillsOf([land.at], join(land.at, 'home'))

      rmSync(path, { recursive: true, force: true })

      const read = skills.readMain('one', path)
      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(read.reason).toContain('「one」')
      expect(read.reason).toContain(path)
      expect(read.reason).toContain('请重新选择技能')
    } finally {
      land.dispose()
    }
  })

  test('**发现给了什么身份，就按那个身份读得回来**（目录软链接 / 直接点名的单技能目录）', () => {
    // 返工一条：首轮发现跟出去返回**真身**，读取却按「父目录是不是来源容器」认——
    // 两把尺子不同，于是自己返回的身份自己不认识（验收 `discovered_sources_readback`）。
    const land = sandbox()
    try {
      const home = join(land.at, 'home')
      // ① 项目里一个目录软链接，指到沙地别处的一份技能
      const external = join(land.at, 'external', 'linked')
      put(land.at, 'external/linked/SKILL.md', skillText('linked', '链过来的那份', '链过来的正文'))
      mkdirSync(join(land.at, '.magic/skills'), { recursive: true })
      symlinkSync(external, join(land.at, '.magic/skills/linked'))
      // ② 点名的补充目录，它自己就是一份技能
      const solo = join(land.at, 'standalone')
      put(solo, 'SKILL.md', skillText('solo', '单独一份', '单独的正文'))

      const skills = skillsOf([land.at], home, [solo])
      const catalog = skills.discover()

      expect(catalog.skills.map((skill) => skill.name)).toEqual(['linked', 'solo'])
      // 发现返回的身份 → 原样交回读取：两条都得成
      for (const skill of catalog.skills) {
        const read = skills.readMain(skill.name, skill.path)
        expect({ name: skill.name, ok: read.ok }).toEqual({ name: skill.name, ok: true })
      }
      // 身份是**真身**（软链接那条跟出去之后那一处）——发现与读取同一串
      expect(catalog.skills[0]?.path).toBe(realpathSync(external))
      // 引用同样走得通（同一份身份底下）
      put(land.at, 'external/linked/references/x.md', '引用正文')
      expect(skills.readReference('linked', catalog.skills[0]?.path ?? '', 'references/x.md').ok).toBe(true)
    } finally {
      land.dispose()
    }
  })

  test('**来源之外的目录**读不了（加载器不是「读任意文件」的口子）', () => {
    const land = sandbox()
    try {
      const outside = join(land.at, 'elsewhere')
      put(land.at, 'elsewhere/SKILL.md', skillText('elsewhere'))
      const skills = skillsOf([land.at], join(land.at, 'home'))

      const read = skills.readMain('elsewhere', outside)
      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(read.reason).toContain('来源没了')
    } finally {
      land.dispose()
    }
  })

  test('来源内的引用读得到；绝对路径 / `..` 越出 / 经软链接绕出去——一律拒', () => {
    const land = sandbox()
    try {
      const path = join(land.at, '.magic/skills/one')
      put(land.at, '.magic/skills/one/SKILL.md', skillText('one'))
      put(land.at, '.magic/skills/one/references/guide.md', '引用正文')
      put(land.at, 'secret.md', '不该读到的东西')

      const skills = skillsOf([land.at], join(land.at, 'home'))

      const good = skills.readReference('one', path, 'references/guide.md')
      expect(good.ok).toBe(true)
      if (good.ok) expect(good.material.text).toBe('引用正文')

      for (const relative of ['../secret.md', '../../secret.md', join(land.at, 'secret.md')]) {
        expect(skills.readReference('one', path, relative).ok).toBe(false)
      }

      // 目录里放一个软链接指到外面——**词法上没毛病，真身上越界**，同样拒
      symlinkSync(join(land.at, 'secret.md'), join(path, 'sneak.md'))
      expect(skills.readReference('one', path, 'sneak.md').ok).toBe(false)
    } finally {
      land.dispose()
    }
  })

  test('单份材料超上限——明确失败（**不给半截正文**）', () => {
    const land = sandbox()
    try {
      const path = join(land.at, '.magic/skills/big')
      put(land.at, '.magic/skills/big/SKILL.md', skillText('big', '说明', 'x'.repeat(200)))
      const skills = createSkills({
        workspace: createWorkspaceService({ roots: [land.at] }),
        home: join(land.at, 'home'),
        limits: { maxMaterialChars: 50 },
      })

      const read = skills.readMain('big', path)
      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(read.reason).toContain('太长')
      expect(read.reason).toContain('没有送出去')
    } finally {
      land.dispose()
    }
  })

  test('份数到顶——**报出来**（不静默丢）', () => {
    const land = sandbox()
    try {
      put(land.at, '.magic/skills/one/SKILL.md', skillText('one'))
      put(land.at, '.magic/skills/two/SKILL.md', skillText('two'))
      const skills = createSkills({
        workspace: createWorkspaceService({ roots: [land.at] }),
        home: join(land.at, 'home'),
        limits: { maxSkills: 1 },
      })

      const catalog = skills.discover()
      expect(catalog.skills).toHaveLength(1)
      expect(firstError(catalog)).toContain('上限 1')
    } finally {
      land.dispose()
    }
  })
})
