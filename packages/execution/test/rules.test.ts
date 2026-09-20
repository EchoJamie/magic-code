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
import { join } from 'node:path'
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
function rulesOf(roots: readonly string[], sources?: readonly string[]) {
  return createProjectRules({
    workspace: createWorkspaceService({ roots }),
    ...(sources === undefined ? {} : { sources }),
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

  test('**物理同源**（软链接指同一份）只注入一次——原生那一头赢', () => {
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
      expect(load.problems).toEqual([])
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
      expect(saidSomething(load, 'rules.sources')).toBe(true)
    } finally {
      box.dispose()
    }
  })

  test('用户显式点了名 ⇒ 同一份外部文件读得进来', () => {
    const box = sandbox()
    try {
      const root = join(box.at, 'proj')
      const outside = put(box.at, 'outside/secret.md', '外面的东西')
      mkdirSync(join(root, '.magic/rules'), { recursive: true })
      symlinkSync(outside, join(root, '.magic/rules/linked.md'))

      const load = rulesOf([root], [outside]).load([])

      expect(namesOf(load)).toEqual([`magic-rules:.magic${'/'}rules${'/'}linked.md`])
      expect(ruleNamed(load, `.magic${'/'}rules${'/'}linked.md`).text).toBe('外面的东西')
      expect(load.problems).toEqual([])
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

  test('补充来源不存在——报出来（不静默当作「没有」）', () => {
    const box = sandbox()
    try {
      const load = rulesOf([box.at], [join(box.at, 'nowhere')]).load([])

      expect(load.documents).toEqual([])
      expect(saidSomething(load, '补充来源不存在')).toBe(true)
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
      expect(saidSomething(load, 'rules.sources')).toBe(true)
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
