/**
 * U32 · 项目规约的来源面 —— 判据：**发现对不对 · 取舍说得清 · 读不懂的不扩大**。
 *
 * 本文件只咬**执行域这一半**（有什么、在哪儿、是哪一版）：发现四类入口 · 去重与优先 ·
 * 条件模式 · 诊断。「什么时候送进模型」归对话域与装配，判据在 `@magic/conversation` 与
 * `packages/app/test/rules.test.ts`。
 *
 * 判定法：临时目录当真工作区（**测试用 fs 不受守护拦**——守护面收窄至各包 `src/`），
 * 每例把目录摆好再断言产物：`documents`（进来了哪几条、都是什么来源）与
 * `problems`（没进来的那些**连同缘由**）。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { ProjectRule, RulesLoad } from '@magic/contracts'
import { createProjectRules } from '../src/rules.ts'
import { createWorkspaceService } from '../src/workspace.ts'

// —— 夹具 ——

/** 一块沙地——一个真临时目录，用完删干净。 */
function sandbox(): { readonly at: string; dispose: () => void } {
  const at = mkdtempSync(join(tmpdir(), 'magic-rules-'))
  return { at, dispose: () => rmSync(at, { recursive: true, force: true }) }
}

/** 在沙地里写一个文件（中间目录自动建）。 */
function put(root: string, relative: string, text: string): string {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

/** 造规约面——`roots` 是工作区根（第一项＝默认根），`sources` 是用户点名的补充来源。 */
function rulesOf(
  roots: readonly string[],
  sources?: readonly string[],
  linkSources?: readonly string[],
) {
  return createProjectRules({
    workspace: createWorkspaceService({ roots }),
    ...(sources === undefined ? {} : { sources }),
    ...(linkSources === undefined ? {} : { linkSources }),
  })
}

/** 进来的那几条抬头（断言「都是什么来源、叫什么」最省事）。 */
function namesOf(load: RulesLoad): readonly string[] {
  return load.documents.map((rule) => `${rule.kind}:${rule.name}`)
}

/** 按抬头名取一条——取不到即抛（免得断在 `undefined` 上）。 */
function ruleNamed(load: RulesLoad, name: string): ProjectRule {
  const found = load.documents.find((rule) => rule.name === name)
  if (found === undefined) throw new Error(`没进来：${name}（进来的是 ${namesOf(load).join(' · ')}）`)
  return found
}

/** 诊断里有没有哪一条提到某个片段——「说不说得清」的断言读起来最省事。 */
function saidSomething(load: RulesLoad, fragment: string): boolean {
  return load.problems.some((problem) => problem.message.includes(fragment))
}

describe('没有规约时——原行为一字不动', () => {
  test('空工作区：没有文档，也没有问题（不是「读失败」，是本来就没有）', () => {
    const box = sandbox()
    try {
      const load = rulesOf([box.at]).load([])

      expect(load.documents).toEqual([])
      expect(load.problems).toEqual([])
    } finally {
      box.dispose()
    }
  })

  test('没有目标时，带 paths 的规则不送（那一趟只取「根一级」）', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/ts.md', '---\npaths:\n  - "src/**"\n---\n只对 src 生效')

      expect(rulesOf([box.at]).load([]).documents).toEqual([])
    } finally {
      box.dispose()
    }
  })
})

describe('目录规约——根与目标祖先目录', () => {
  test('根级 AGENTS.md 在无目标时就在（首次模型调用前载入）', () => {
    const box = sandbox()
    try {
      put(box.at, 'AGENTS.md', '本项目一律中文')
      const load = rulesOf([box.at]).load([])

      expect(namesOf(load)).toEqual(['agents:AGENTS.md'])
      expect(load.documents[0]?.text).toBe('本项目一律中文')
      expect(load.documents[0]?.scope).toBe(realpathSync(box.at))
      expect(load.problems).toEqual([])
    } finally {
      box.dispose()
    }
  })

  test('子目录 AGENTS.md 只在**目标落进它子树**时才进来（近目录约定细化其子树）', () => {
    const box = sandbox()
    try {
      put(box.at, 'AGENTS.md', '根：一律中文')
      put(box.at, 'src/AGENTS.md', 'src：先跑 bun run check')

      const outside = rulesOf([box.at]).load(['README.md'])
      expect(namesOf(outside)).toEqual(['agents:AGENTS.md'])

      const inside = rulesOf([box.at]).load(['src/a.ts'])
      expect(namesOf(inside)).toEqual(['agents:AGENTS.md', `agents:src${'/'}AGENTS.md`])
      expect(ruleNamed(inside, `src${'/'}AGENTS.md`).text).toBe('src：先跑 bun run check')
    } finally {
      box.dispose()
    }
  })

  test('目标是目录时从它自己起算（`ls src` 也拿得到 src/AGENTS.md）', () => {
    const box = sandbox()
    try {
      put(box.at, 'src/AGENTS.md', 'src：先跑校验')
      mkdirSync(join(box.at, 'src'), { recursive: true })

      expect(namesOf(rulesOf([box.at]).load(['src']))).toContain(`agents:src${'/'}AGENTS.md`)
    } finally {
      box.dispose()
    }
  })

  test('同目录没有 AGENTS.md 时回退 CLAUDE.md', () => {
    const box = sandbox()
    try {
      put(box.at, 'CLAUDE.md', '兼容入口')
      const load = rulesOf([box.at]).load([])

      expect(namesOf(load)).toEqual(['claude-md:CLAUDE.md'])
      expect(load.problems).toEqual([])
    } finally {
      box.dispose()
    }
  })

  test('**软链接指同实体**：两个入口一份文件，只入一次', () => {
    const box = sandbox()
    try {
      put(box.at, 'AGENTS.md', '一份实体两个名字')
      symlinkSync(join(box.at, 'AGENTS.md'), join(box.at, 'CLAUDE.md'))

      const load = rulesOf([box.at]).load([])

      expect(load.documents).toHaveLength(1)
      expect(load.problems).toEqual([]) // 同实体不是取舍，没什么可说的
    } finally {
      box.dispose()
    }
  })

  test('**同目录两份不同实体**：采用 AGENTS.md，并说清落选的那份怎么才能读', () => {
    const box = sandbox()
    try {
      put(box.at, 'AGENTS.md', '甲')
      put(box.at, 'CLAUDE.md', '乙')

      const load = rulesOf([box.at]).load([])

      expect(namesOf(load)).toEqual(['agents:AGENTS.md'])
      expect(ruleNamed(load, 'AGENTS.md').text).toBe('甲')
      // 不只是「没读」——还要说清为什么、以及出口在哪
      expect(saidSomething(load, '未采用 CLAUDE.md')).toBe(true)
      expect(saidSomething(load, 'rules.sources')).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('同目录两份不同实体 + 用户点名了 CLAUDE.md ⇒ 两份都读得进来', () => {
    const box = sandbox()
    try {
      put(box.at, 'AGENTS.md', '甲')
      const claude = put(box.at, 'CLAUDE.md', '乙')

      const load = rulesOf([box.at], [claude]).load([])

      expect(namesOf(load)).toEqual(['agents:AGENTS.md', `source:CLAUDE.md`])
      expect(ruleNamed(load, 'CLAUDE.md').text).toBe('乙')
    } finally {
      box.dispose()
    }
  })

  test('**只走到根为止**——根之外的家目录规约不是这个工作区的规约面', () => {
    const box = sandbox()
    try {
      const root = join(box.at, 'proj')
      mkdirSync(root, { recursive: true })
      put(box.at, 'AGENTS.md', '外面那份：不该进来')
      put(root, 'AGENTS.md', '里面那份：该进来')

      const load = rulesOf([root]).load(['a.ts'])

      expect(namesOf(load)).toEqual(['agents:AGENTS.md'])
      expect(ruleNamed(load, 'AGENTS.md').text).toBe('里面那份：该进来')
    } finally {
      box.dispose()
    }
  })
})

describe('原生规则 —— .magic/rules 无条件与条件', () => {
  test('纯 Markdown 无条件规则：无目标也在（根一级）', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/style.md', '提交信息用中文')
      const load = rulesOf([box.at]).load([])

      expect(namesOf(load)).toEqual([`magic-rules:.magic${'/'}rules${'/'}style.md`])
      expect(ruleNamed(load, `.magic${'/'}rules${'/'}style.md`).text).toBe('提交信息用中文')
      // 作用域＝**所属根**（规则子目录只是组织方式，基准仍是项目根）
      expect(load.documents[0]?.scope).toBe(realpathSync(box.at))
    } finally {
      box.dispose()
    }
  })

  test('条件规则：命中送、不命中不送', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/ts.md', '---\npaths:\n  - "src/**/*.ts"\n---\nts 那摊的约定')

      const missed = rulesOf([box.at]).load(['docs/readme.md'])
      expect(missed.documents).toEqual([])

      const hit = rulesOf([box.at]).load(['src/a.ts'])
      expect(namesOf(hit)).toEqual([`magic-rules:.magic${'/'}rules${'/'}ts.md`])
    } finally {
      box.dispose()
    }
  })

  test('**规则子目录是组织方式**——路径基准仍是所属项目根', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/web/react.md', '---\npaths:\n  - "web/**/*.tsx"\n---\n前端约定')

      const load = rulesOf([box.at]).load(['web/app/page.tsx'])

      expect(namesOf(load)).toEqual([`magic-rules:.magic${'/'}rules${'/'}web${'/'}react.md`])
    } finally {
      box.dispose()
    }
  })

  test('模式：`**` 跨段 · `*` 段内 · `?` 单字符 · 多模式取并 · 大括号展开', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/deep.md', '---\npaths:\n  - "src/**/*.ts"\n---\n深处')
      put(box.at, '.magic/rules/one.md', '---\npaths:\n  - "*.md"\n---\n一层')
      put(box.at, '.magic/rules/brace.md', '---\npaths:\n  - "lib/*.{ts,tsx}"\n---\n大括号')
      put(box.at, '.magic/rules/many.md', '---\npaths:\n  - "api/**"\n  - "cli/**"\n---\n多模式')

      const names = (target: string): readonly string[] => namesOf(rulesOf([box.at]).load([target]))

      // `**` 之后的斜杠表示「零层或多层目录」——`src/a.ts` 一层都没有也要命中
      expect(names('src/a.ts')).toContain(`magic-rules:.magic${'/'}rules${'/'}deep.md`)
      expect(names('src/x/y/a.ts')).toContain(`magic-rules:.magic${'/'}rules${'/'}deep.md`)
      // `*` 不跨段
      expect(names('note.md')).toContain(`magic-rules:.magic${'/'}rules${'/'}one.md`)
      expect(names('docs/note.md')).not.toContain(`magic-rules:.magic${'/'}rules${'/'}one.md`)
      // 大括号
      expect(names('lib/a.tsx')).toContain(`magic-rules:.magic${'/'}rules${'/'}brace.md`)
      expect(names('lib/a.js')).not.toContain(`magic-rules:.magic${'/'}rules${'/'}brace.md`)
      // 多模式取并
      expect(names('api/x.ts')).toContain(`magic-rules:.magic${'/'}rules${'/'}many.md`)
      expect(names('cli/x.ts')).toContain(`magic-rules:.magic${'/'}rules${'/'}many.md`)
    } finally {
      box.dispose()
    }
  })

  test('无 paths 与空 paths 是两回事：不写＝无条件；空列表＝读不懂，**不加载**', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/always.md', '无条件的')
      put(box.at, '.magic/rules/empty.md', '---\npaths:\n---\n不该生效')

      const load = rulesOf([box.at]).load([])

      expect(namesOf(load)).toEqual([`magic-rules:.magic${'/'}rules${'/'}always.md`])
      expect(saidSomething(load, '空列表')).toBe(true)
    } finally {
      box.dispose()
    }
  })
})

describe('读不懂的——不扩大为全匹配，且说得出为什么', () => {
  const cases: readonly { readonly label: string; readonly front: string; readonly fragment: string }[] = [
    { label: '绝对模式', front: 'paths:\n  - "/src/**"', fragment: '项目根相对' },
    { label: '出根模式', front: 'paths:\n  - "../outside/**"', fragment: '..' },
    { label: '嵌套大括号', front: 'paths:\n  - "src/{a,{b,c}}/**"', fragment: '嵌套大括号' },
    { label: '大括号不成对', front: 'paths:\n  - "src/{a,b/**"', fragment: '不成对' },
    { label: '大括号里有空项', front: 'paths:\n  - "src/{a,}/**"', fragment: '空的' },
    { label: '不认识的键', front: 'path:\n  - "src/**"', fragment: '不认识的键' },
    { label: '非列表写法', front: 'paths: src/**', fragment: '只认列表写法' },
  ]

  for (const probe of cases) {
    test(`坏 front-matter（${probe.label}）——不加载，且指出缘由`, () => {
      const box = sandbox()
      try {
        put(box.at, '.magic/rules/bad.md', `---\n${probe.front}\n---\n正文`)

        const load = rulesOf([box.at]).load(['src/a.ts'])

        expect(load.documents).toEqual([])
        expect(saidSomething(load, probe.fragment)).toBe(true)
      } finally {
        box.dispose()
      }
    })
  }

  test('**合法的 inline 列表照收**（手写词法把它拒了——2026-09-20 换成内置解析器）', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/inline.md', '---\npaths: ["src/**", "lib/*.ts"]\n---\ninline 写法')
      put(box.at, '.magic/rules/flow.md', '---\npaths:\n  - \'lib/**\' # 单引号也是合法 YAML\n---\n单引导')

      const load = rulesOf([box.at]).load(['src/a.ts', 'lib/b.ts'])

      expect(namesOf(load)).toEqual([
        `magic-rules:.magic${'/'}rules${'/'}flow.md`,
        `magic-rules:.magic${'/'}rules${'/'}inline.md`,
      ])
      expect(load.problems).toEqual([])
    } finally {
      box.dispose()
    }
  })

  test('**没闭合的引号**明确报错（手写词法会把它当内容收下：模式带着半截引号去匹配）', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/broken.md', '---\npaths:\n  - "src/**\n---\n少一个引号')

      const load = rulesOf([box.at]).load(['src/a.ts'])

      expect(load.documents).toEqual([])
      expect(saidSomething(load, 'YAML')).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('**没闭合的 front-matter**明确报错（旧口径是「当它不存在、整篇按正文收下」）', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/unclosed.md', '---\npaths:\n  - "src/**"\n正文，收尾那条 --- 忘了写')

      const load = rulesOf([box.at]).load(['src/a.ts'])

      expect(load.documents).toEqual([])
      expect(saidSomething(load, '没闭合')).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('`paths:` 后面什么都不写（YAML 读成 null）＝空列表，与 `paths: []` 同一句话', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/nil.md', '---\npaths:\n---\n正文')
      put(box.at, '.magic/rules/empty.md', '---\npaths: []\n---\n正文')

      const load = rulesOf([box.at]).load([])

      expect(load.documents).toEqual([])
      expect(load.problems.filter((problem) => problem.message.includes('空列表'))).toHaveLength(2)
    } finally {
      box.dispose()
    }
  })

  test('展开过多——报出来，**不**悄悄砍成前几条', () => {
    const box = sandbox()
    try {
      put(
        box.at,
        '.magic/rules/huge.md',
        '---\npaths:\n  - "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}/**"\n---\n爆炸',
      )

      const load = rulesOf([box.at]).load([])

      expect(load.documents).toEqual([])
      expect(saidSomething(load, '展开')).toBe(true)
      expect(saidSomething(load, `上限 ${64}`)).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('**组数过多**：在展开**之前**就退回——深度优先的展开会先把栈坐穿', () => {
    const box = sandbox()
    try {
      // 24000 组 × 5 字符 ≈ 120KB，**还在单份 128KB 上限之内**——故这不是「文档太大」，
      // 是「递归太深」。组数上限若在展开之后才判，这一条会崩在栈上（不是红，是崩）
      put(box.at, '.magic/rules/deep.md', `---\npaths:\n  - "${'{a,b}'.repeat(24000)}"\n---\n深`)

      const load = rulesOf([box.at]).load([])

      expect(load.documents).toEqual([])
      expect(saidSomething(load, '组')).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('**同层的多组大括号**照常展开（`src/{a,b}/*.{ts,tsx}` 是两组，不是嵌套）', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/two.md', '---\npaths:\n  - "lib/{a,b}/*.{ts,tsx}"\n---\n两组')

      expect(namesOf(rulesOf([box.at]).load(['lib/a/x.ts']))).toEqual([
        `magic-rules:.magic${'/'}rules${'/'}two.md`,
      ])
      expect(namesOf(rulesOf([box.at]).load(['lib/b/y.tsx']))).toEqual([
        `magic-rules:.magic${'/'}rules${'/'}two.md`,
      ])
      expect(rulesOf([box.at]).load(['lib/c/y.ts']).documents).toEqual([])
    } finally {
      box.dispose()
    }
  })

  test('坏 front-matter 的对象是**那一份**，不是整棵树（其余照常进来）', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/good.md', '好的那份')
      put(box.at, '.magic/rules/bad.md', '---\npaths:\n  - "/abs/**"\n---\n坏的')

      const load = rulesOf([box.at]).load([])

      expect(namesOf(load)).toEqual([`magic-rules:.magic${'/'}rules${'/'}good.md`])
      expect(load.problems).toHaveLength(1)
    } finally {
      box.dispose()
    }
  })

  test('正文里的 `---` 分隔线不算 front-matter（没有闭合就不切）', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/doc.md', '开头\n\n---\n\n下面还是正文')

      const load = rulesOf([box.at]).load([])

      expect(load.documents[0]?.text).toBe('开头\n\n---\n\n下面还是正文')
      expect(load.problems).toEqual([])
    } finally {
      box.dispose()
    }
  })

  test('目录规约**整篇照收**——它的头部不按 front-matter 切', () => {
    const box = sandbox()
    try {
      put(box.at, 'AGENTS.md', '---\npaths:\n  - "src/**"\n---\n正文')

      const load = rulesOf([box.at]).load([])

      expect(load.documents).toHaveLength(1)
      expect(load.documents[0]?.text).toContain('paths:')
    } finally {
      box.dispose()
    }
  })

  test('注释与引号——`#` 在引号里是内容，在空白后才是注释', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/quoted.md', '---\n# 说明\npaths:\n  - "a#b/**" # 行尾注释\n---\n带井号')
      put(box.at, 'a#b/x.md', '目标')

      const load = rulesOf([box.at]).load(['a#b/x.md'])

      expect(namesOf(load)).toContain(`magic-rules:.magic${'/'}rules${'/'}quoted.md`)
    } finally {
      box.dispose()
    }
  })
})

describe('物理去重 —— 范围不同就是两条', () => {
  test('同一份文件经两处进来、管两摊 ⇒ **两条**（首轮按真路径一刀切，src 那条整个消失）', () => {
    const box = sandbox()
    try {
      // 根 AGENTS.md 与 src/AGENTS.md 都软链到同一份团队规约——常见的组织方式
      const shared = put(box.at, 'shared/team.md', '团队约定：先跑 check')
      mkdirSync(join(box.at, 'src'), { recursive: true })
      symlinkSync(shared, join(box.at, 'AGENTS.md'))
      symlinkSync(shared, join(box.at, 'src/AGENTS.md'))

      const load = rulesOf([box.at], undefined, [shared]).load(['src/a.ts'])

      expect(load.documents.map((rule) => rule.name)).toEqual(['AGENTS.md', `src${sep}AGENTS.md`])
      // **两份是不同的规则**：管的地方不同 ⇒ 版本也不同（不然送过一条就等于两条都送过）
      expect(load.documents[0]?.version).not.toBe(load.documents[1]?.version)
      expect(load.documents[1]?.scope).toBe(join(realpathSync(box.at), 'src'))
    } finally {
      box.dispose()
    }
  })
})

describe('Claude 兼容入口 —— 同一套机制，原生优先', () => {
  test('`.claude/rules` 与原生同形：无条件与条件都认', () => {
    const box = sandbox()
    try {
      put(box.at, '.claude/rules/always.md', '兼容的：无条件')
      put(box.at, '.claude/rules/ts.md', '---\npaths:\n  - "src/**/*.ts"\n---\n兼容的：条件')

      const load = rulesOf([box.at]).load(['src/a.ts'])

      expect(namesOf(load)).toEqual([
        `claude-rules:.claude${'/'}rules${'/'}always.md`,
        `claude-rules:.claude${'/'}rules${'/'}ts.md`,
      ])
    } finally {
      box.dispose()
    }
  })

  test('**同根同相对规则名，Magic 优先**——落选的那份报出来', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/style.md', '原生那份')
      put(box.at, '.claude/rules/style.md', '兼容那份')

      const load = rulesOf([box.at]).load([])

      expect(namesOf(load)).toEqual([`magic-rules:.magic${'/'}rules${'/'}style.md`])
      expect(ruleNamed(load, `.magic${'/'}rules${'/'}style.md`).text).toBe('原生那份')
      expect(saidSomething(load, '原生优先')).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('原生那份**读不懂**时，兼容那份也不许接管（占位在解析之前就定了）', () => {
    const box = sandbox()
    try {
      // 原生这条的 paths 写坏了（出根）⇒ 它自己不加载；但**这个名字已经归它**——
      // 首轮实测的洞：占位放在「读懂了才算数」的位置，于是 `.claude` 那份悄悄顶了上来
      put(box.at, '.magic/rules/same.md', '---\npaths:\n  - "../bad/**"\n---\n原生那份')
      put(box.at, '.claude/rules/same.md', '兼容那份不该赢')

      const load = rulesOf([box.at]).load([])

      expect(load.documents).toEqual([]) // 两条都没进来
      expect(saidSomething(load, '原生优先')).toBe(true) // 兼容那条：说得清为什么
      expect(saidSomething(load, '模式不成立')).toBe(true) // 原生那条：它自己的错照报
    } finally {
      box.dispose()
    }
  })

  test('原生那份**不可读**时，兼容那份也不许接管', () => {
    const box = sandbox()
    try {
      // 原生那份链到工作区之外（没配来源 ⇒ 读不到）——占位照旧归它
      const root = join(box.at, 'proj')
      const outside = put(box.at, 'outside/x.md', '外面的东西')
      mkdirSync(join(root, '.magic/rules'), { recursive: true })
      symlinkSync(outside, join(root, '.magic/rules/same.md'))
      put(root, '.claude/rules/same.md', '兼容那份不该赢')

      const load = rulesOf([root]).load([])

      expect(load.documents).toEqual([])
      expect(saidSomething(load, '原生优先')).toBe(true)
      expect(saidSomething(load, '工作区之外')).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('原生那份**是断链**时，兼容那份也不许接管；断链本身明确报问题（二轮退回第二条）', () => {
    const box = sandbox()
    try {
      // 软链指着**不存在**的目标：文件项在、目标取不到（与上一条不同——那条目标是真的）
      mkdirSync(join(box.at, '.magic/rules'), { recursive: true })
      symlinkSync(join(box.at, 'missing.md'), join(box.at, '.magic/rules/same.md'))
      put(box.at, '.claude/rules/same.md', '兼容那份不该赢')

      const load = rulesOf([box.at]).load([])

      // 二轮实测的洞：walk 在 `statSync` 失败那一支直接 `continue` ⇒ 它**连候选都不是**
      // ⇒ 这个名字不归原生 ⇒ 兼容那份**实际接管**且 `problems` 为空（静默回退）
      expect(load.documents).toEqual([]) // 断链那份读不到，兼容那份也不许顶上来
      expect(saidSomething(load, '取不到')).toBe(true) // 断链本身：坏原生不许静默
      expect(saidSomething(load, '原生优先')).toBe(true) // 兼容那条：说得清为什么不加载
    } finally {
      box.dispose()
    }
  })

  test('原生与兼容**是同一个实体**时，兼容那份也不许接管', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/shared.md', '同一份实体')
      mkdirSync(join(box.at, '.claude', 'rules'), { recursive: true })
      symlinkSync(join(box.at, '.magic/rules/shared.md'), join(box.at, '.claude/rules/shared.md'))

      const load = rulesOf([box.at]).load([])

      // 只有原生那一条（兼容那条被占位挡下，不是被物理去重悄悄吞掉）
      expect(namesOf(load)).toEqual([`magic-rules:.magic${'/'}rules${'/'}shared.md`])
      expect(saidSomething(load, '原生优先')).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('**相对规则名不同就分别加载**——不是「同名才共存」', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/a.md', '原生的 a')
      put(box.at, '.claude/rules/b.md', '兼容的 b')

      const load = rulesOf([box.at]).load([])

      // 同深度按**来源序**（原生在前）摆——不是按目录名字母序（`.claude` 恰好排在前面）
      expect(namesOf(load)).toEqual([
        `magic-rules:.magic${'/'}rules${'/'}a.md`,
        `claude-rules:.claude${'/'}rules${'/'}b.md`,
      ])
    } finally {
      box.dispose()
    }
  })

  test('**物理同源**（软链接指同一份）只注入一次——原生那一头赢，且**有交代**', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/shared.md', '同一份实体')
      mkdirSync(join(box.at, '.claude', 'rules'), { recursive: true })
      symlinkSync(
        join(box.at, '.magic/rules/shared.md'),
        join(box.at, '.claude/rules/shared.md'),
      )

      const load = rulesOf([box.at]).load([])

      expect(namesOf(load)).toEqual([`magic-rules:.magic${'/'}rules${'/'}shared.md`])
      // 原锚：`problems` 为空（同实体被物理去重**悄悄**吞掉）。为何变（2026-09-20 裁）：
      // 原生占位现在跑在物理去重**之前**，故「这个相对名归 Magic 那份」这句话说得出来——
      // 一条 `choice`（不是错误、不报警），用户在 `--check` 里查得着「我那条为什么没在管」。
      expect(load.problems.map((problem) => problem.kind)).toEqual(['choice'])
      expect(saidSomething(load, '原生优先')).toBe(true)
    } finally {
      box.dispose()
    }
  })
})

describe('只读来源的边界 —— 不因它是个链接就自动可读', () => {
  test('指向工作区之外的符号链接：**不加载**，并说清出口在哪', () => {
    const box = sandbox()
    try {
      const root = join(box.at, 'proj')
      const outside = put(box.at, 'outside/secret.md', '外面的东西')
      mkdirSync(join(root, '.magic/rules'), { recursive: true })
      symlinkSync(outside, join(root, '.magic/rules/linked.md'))

      const load = rulesOf([root]).load([])

      expect(load.documents).toEqual([])
      expect(saidSomething(load, '工作区之外')).toBe(true)
      // 出口是 **linkSources** 而不是 sources（2026-09-20 裁）：这里要的是「放行这条路」，
      // 不是「把这一份当规约读进来」——两个键的分水岭见契约 `RulesConfig`。
      expect(saidSomething(load, 'rules.linkSources')).toBe(true)
      expect(load.problems.every((problem) => problem.kind === 'error')).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('linkSources 点了名 ⇒ 链接跟得出去，**作用范围照旧是链接所在的那一处**', () => {
    const box = sandbox()
    try {
      const root = join(box.at, 'proj')
      const outside = put(box.at, 'outside/secret.md', '外面的东西')
      mkdirSync(join(root, '.magic/rules'), { recursive: true })
      symlinkSync(outside, join(root, '.magic/rules/linked.md'))

      const load = rulesOf([root], undefined, [outside]).load([])

      expect(namesOf(load)).toEqual([`magic-rules:.magic${'/'}rules${'/'}linked.md`])
      expect(ruleNamed(load, `.magic${'/'}rules${'/'}linked.md`).text).toBe('外面的东西')
      // **不是一条全局规约**：根与作用目录还是这条链接所在的那处（真身在根外不作数）
      expect(ruleNamed(load, `.magic${'/'}rules${'/'}linked.md`).root).toBe(realpathSync(root))
      expect(load.problems).toEqual([])
    } finally {
      box.dispose()
    }
  })

  test('child 目录里的 AGENTS.md 软链到根外 ⇒ 规约**保持 src 作用域**，不变成开局全局规约', () => {
    const box = sandbox()
    try {
      const root = join(box.at, 'proj')
      const outside = put(box.at, 'outside/team.md', 'CHILD_ONLY')
      mkdirSync(join(root, 'src'), { recursive: true })
      symlinkSync(outside, join(root, 'src/AGENTS.md'))

      // 没放行：读不到（且说得出为什么）
      const denied = rulesOf([root]).load([])
      expect(denied.documents).toEqual([])

      // 放行之后：**开局那一趟（无目标）不带它**——它只管 src
      const rules = createProjectRules({
        workspace: createWorkspaceService({ roots: [root] }),
        linkSources: [outside],
      })
      expect(rules.load([]).documents).toEqual([])

      // 碰 src 时它才进来，而且**根与作用目录都是 src 那一处**（不是真身所在的根外）
      const scoped = rules.load(['src/a.ts']).documents
      expect(scoped.map((rule) => rule.name)).toEqual([`src${sep}AGENTS.md`])
      expect(scoped[0]?.scope).toBe(join(realpathSync(root), 'src'))
      expect(scoped[0]?.root).toBe(realpathSync(root))
    } finally {
      box.dispose()
    }
  })

  test('sources 点名一份根外文件 ⇒ **正文读进来**（kind=source，不分根）', () => {
    const box = sandbox()
    try {
      const root = join(box.at, 'proj')
      const outside = put(box.at, 'outside/team.md', '用户点名要读的')
      mkdirSync(root, { recursive: true })

      const load = rulesOf([root], [outside]).load([])

      // 抬头一律报**真路径**（`realpath` 之后）——本机 `/var/…` 实为 `/private/var/…`
      expect(namesOf(load)).toEqual([`source:${realpathSync(outside)}`])
      expect(load.documents[0]?.root).toBe(null)
      expect(load.documents[0]?.text).toBe('用户点名要读的')
    } finally {
      box.dispose()
    }
  })

  test('补充来源是**目录**时递归其下 `*.md`；是文件时就是一份', () => {
    const box = sandbox()
    try {
      const shared = join(box.at, 'shared')
      put(shared, 'a.md', '甲')
      put(shared, 'deep/b.md', '乙')
      const single = put(box.at, 'single.md', '丙')

      const load = rulesOf([box.at], [shared, single]).load([])

      // 抬头一律**相对所属根**（同其余来源的口径）——补充来源若落在某条根内，也照这条
      expect(namesOf(load)).toEqual([
        'source:single.md',
        `source:shared${'/'}a.md`,
        `source:shared${'/'}deep${'/'}b.md`,
      ])
      expect(ruleNamed(load, `shared${'/'}deep${'/'}b.md`).text).toBe('乙')
      expect(ruleNamed(load, 'single.md').text).toBe('丙')
    } finally {
      box.dispose()
    }
  })

  test('补充来源写**相对路径**＝拒（与工作区根同一条规矩：基准是进程当前目录）', () => {
    const box = sandbox()
    try {
      const load = rulesOf([box.at], ['shared/rules']).load([])

      expect(load.documents).toEqual([])
      expect(saidSomething(load, '绝对路径')).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('补充来源不存在——报出来（不静默当作「没有」）', () => {
    const box = sandbox()
    try {
      const load = rulesOf([box.at], [join(box.at, 'nowhere')]).load([])

      expect(load.documents).toEqual([])
      expect(saidSomething(load, 'rules.sources')).toBe(true)
      expect(saidSomething(load, '不存在或不可达')).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('指向工作区之外的**目录**符号链接：连进都不进（不是逐文件略过——广度没有兜底）', () => {
    const box = sandbox()
    try {
      const root = join(box.at, 'proj')
      // 外面那一摊里放一份「不该被看见」的规约，再把整个目录链进规则目录
      const outside = join(box.at, 'outside')
      put(outside, 'secret.md', '外面的东西')
      put(outside, 'deep/deeper/also.md', '更深处的东西')
      mkdirSync(join(root, '.magic/rules'), { recursive: true })
      symlinkSync(outside, join(root, '.magic/rules/linked'))

      const load = rulesOf([root]).load([])

      expect(load.documents).toEqual([])
      // **按目录报一次**，不是按文件报两次——说明压根没往里边走
      expect(load.problems).toHaveLength(1)
      expect(saidSomething(load, '指向工作区之外的目录')).toBe(true)
      expect(saidSomething(load, 'rules.linkSources')).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('目录循环——诊断说得出绕回哪儿，且**转得出来**（不挂）', () => {
    const box = sandbox()
    try {
      const rulesDir = join(box.at, '.magic/rules')
      put(box.at, '.magic/rules/a.md', '一份')
      symlinkSync(rulesDir, join(rulesDir, 'loop'))

      const load = rulesOf([box.at]).load([])

      expect(namesOf(load)).toEqual([`magic-rules:.magic${'/'}rules${'/'}a.md`])
      expect(saidSomething(load, '目录循环')).toBe(true)
    } finally {
      box.dispose()
    }
  })
})

describe('根是文件系统顶（`/`）——相对写法不吃字符', () => {
  test('`paths` 按「根相对」写对的照旧命中（吃了首字符就会**静默**一条都不中）', () => {
    const box = sandbox()
    try {
      const real = realpathSync(box.at)
      // 从 `/` 数起的前两段——正是调试时最容易写出的那种相对模式。
      // ⚠️ 目标与模式都取**规范形**：根是 `/` 时它自己身兼两张表，`/var` → `/private/var`
      // 这条桥搭不起来（两张表只桥声明的那几条根，不是任意软链接）——那不是本用例要测的
      const head = real.split(sep).filter((part) => part !== '').slice(0, 2).join('/')
      const shared = put(box.at, 'shared/deep.md', `---\npaths:\n  - "${head}/**"\n---\n顶层根`)

      const load = rulesOf(['/'], [shared]).load([join(real, 'a.ts')])

      expect(namesOf(load)).toEqual([`source:${real.slice(1)}${sep}shared${sep}deep.md`])
    } finally {
      box.dispose()
    }
  })
})

describe('多根 —— 各自的作用域，不互相顶替', () => {
  test('两条根各有各的规约，各标各的根（不把甲根的说成乙根的）', () => {
    const box = sandbox()
    try {
      const first = join(box.at, 'a')
      const second = join(box.at, 'b')
      mkdirSync(first, { recursive: true })
      mkdirSync(second, { recursive: true })
      put(first, 'AGENTS.md', '甲根的约定')
      put(second, 'AGENTS.md', '乙根的约定')
      put(first, '.magic/rules/native.md', '甲根的原生规则')
      put(second, '.magic/rules/native.md', '乙根的原生规则')

      const load = rulesOf([first, second]).load([])

      // 摆法是**一个根一块**（抬头已标明根）——「甲根那一摊」连着摆才看得出是一摊
      expect(load.documents.map((rule) => [rule.root, rule.text])).toEqual([
        [realpathSync(first), '甲根的约定'],
        [realpathSync(first), '甲根的原生规则'],
        [realpathSync(second), '乙根的约定'],
        [realpathSync(second), '乙根的原生规则'],
      ])
    } finally {
      box.dispose()
    }
  })

  test('甲根的条件规则不因乙根的目标而触发', () => {
    const box = sandbox()
    try {
      const first = join(box.at, 'a')
      const second = join(box.at, 'b')
      mkdirSync(join(first, 'src'), { recursive: true })
      mkdirSync(join(second, 'src'), { recursive: true })
      put(first, '.magic/rules/ts.md', '---\npaths:\n  - "src/**"\n---\n甲根的 ts 规则')

      const inSecond = rulesOf([first, second]).load([join(second, 'src/x.ts')])
      expect(inSecond.documents).toEqual([])

      const inFirst = rulesOf([first, second]).load([join(first, 'src/x.ts')])
      expect(namesOf(inFirst)).toEqual([`magic-rules:.magic${'/'}rules${'/'}ts.md`])
    } finally {
      box.dispose()
    }
  })

  test('**声明原形**下的目标也认得出来（用户写 `/tmp/…`、真身 `/private/tmp/…`）', () => {
    const box = sandbox()
    try {
      const root = realpathSync(box.at)
      mkdirSync(join(root, 'src'), { recursive: true })
      put(root, '.magic/rules/ts.md', '---\npaths:\n  - "src/**"\n---\n命中')

      // 声明原形与规范形不同时（macOS 的 /var ↔ /private/var 就是现成的例子）
      const workspace = createWorkspaceService({ roots: [box.at] })
      const declared = workspace.declaredRoots()[0] as string

      const load = createProjectRules({ workspace }).load([join(declared, 'src/x.ts')])

      expect(namesOf(load)).toEqual([`magic-rules:.magic${'/'}rules${'/'}ts.md`])
    } finally {
      box.dispose()
    }
  })
})

describe('上限 —— 超了报出来，不静默截', () => {
  test('单份过大：不加载，且报出实际大小', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/big.md', 'x'.repeat(2048))
      put(box.at, '.magic/rules/small.md', '小的')

      const load = createProjectRules({
        workspace: createWorkspaceService({ roots: [box.at] }),
        limits: { maxDocumentBytes: 1024 },
      }).load([])

      expect(namesOf(load)).toEqual([`magic-rules:.magic${'/'}rules${'/'}small.md`])
      expect(saidSomething(load, '超过单份上限')).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('份数上限：到此为止，且明说「从这一份起不再加载」', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/a.md', '甲')
      put(box.at, '.magic/rules/b.md', '乙')
      put(box.at, '.magic/rules/c.md', '丙')

      const load = createProjectRules({
        workspace: createWorkspaceService({ roots: [box.at] }),
        limits: { maxDocuments: 2 },
      }).load([])

      expect(load.documents).toHaveLength(2)
      expect(saidSomething(load, '上限 2')).toBe(true)
      // **回来的是不是全的**——光看 `documents` 看不出来（被挡在外面的压根不在列表里），
      // 故这一位单报。对话域据它把「材料没齐」当成未送达处理（2026-09-20 裁）。
      expect(load.truncated).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('**没到上限就是全的**（`truncated` 为假——不误报）', () => {
    const box = sandbox()
    try {
      put(box.at, '.magic/rules/a.md', '甲')
      put(box.at, '.magic/rules/b.md', '乙')

      const load = rulesOf([box.at]).load([])

      expect(load.documents).toHaveLength(2)
      expect(load.truncated).toBe(false)
    } finally {
      box.dispose()
    }
  })
})

describe('内容版本 —— 判「是不是同一版」的锚', () => {
  test('同内容同版本 · 改一个字换版本 · 改模式也换版本', () => {
    const box = sandbox()
    try {
      const file = join(box.at, 'AGENTS.md')
      put(box.at, 'AGENTS.md', '甲')
      const first = rulesOf([box.at]).load([]).documents[0]?.version

      expect(rulesOf([box.at]).load([]).documents[0]?.version).toBe(first)

      writeFileSync(file, '乙', 'utf8')
      const changed = rulesOf([box.at]).load([]).documents[0]?.version
      expect(changed).not.toBe(first)

      put(box.at, '.magic/rules/ts.md', '---\npaths:\n  - "src/**"\n---\n正文')
      const narrow = rulesOf([box.at]).load(['src/a.ts']).documents.find(
        (rule) => rule.kind === 'magic-rules',
      )
      put(box.at, '.magic/rules/ts.md', '---\npaths:\n  - "lib/**"\n---\n正文')
      const other = rulesOf([box.at]).load(['lib/a.ts']).documents.find(
        (rule) => rule.kind === 'magic-rules',
      )

      expect(other?.text).toBe(narrow?.text) // 正文一字未动
      expect(other?.version).not.toBe(narrow?.version) // 但适用面变了 ⇒ 另算一版
    } finally {
      box.dispose()
    }
  })

  test('**正文一模一样的两个文件是两个版本**（身份也进版本号）', () => {
    const box = sandbox()
    try {
      // 同一套约定按目录铺开——复制粘贴起手最常见的写法
      const same = '本目录的约定：先跑 bun run check'
      put(box.at, 'AGENTS.md', same)
      put(box.at, 'src/AGENTS.md', same)

      const load = rulesOf([box.at]).load(['src/a.ts'])
      const versions = load.documents.map((rule) => rule.version)

      expect(load.documents).toHaveLength(2)
      // 版本不含路径的话两条会撞成一个号——下游「按版本判送过没有」就会把
      // 子目录那份当成「已送达」，它**永远不送也不拦**（有用例在对话域钉着）
      expect(new Set(versions).size).toBe(2)
    } finally {
      box.dispose()
    }
  })

  test('`path` 报的是**真路径**（软链接那头归到它自己）', () => {
    const box = sandbox()
    try {
      const real = put(box.at, 'real.md', '真身')
      mkdirSync(join(box.at, '.magic/rules'), { recursive: true })
      symlinkSync(real, join(box.at, '.magic/rules/alias.md'))

      const load = rulesOf([box.at]).load([])

      expect(load.documents[0]?.path).toBe(realpathSync(real))
    } finally {
      box.dispose()
    }
  })
})
