/**
 * U36 · **引用原位编辑与文件目录输入**（外壳那一半）——按键 → 视图 ＋ 命令。
 *
 * 判据全在设计 · 终端交互 ·「引用留在交代的位置」那一条上：
 * - **选择只替换当前查询片段**（`@` 那一栏选定即把查询那一段换成引用）；
 * - **引用是一个可定位的编辑单位**：`←/→` 整处越过、退格 / 删除整处移除；
 * - **替换在原处发生**，前后文字一个字不动（不搬到开头、不追加到末尾）；
 * - **在引用处删除之后不能仍暗带那份材料**（身份区间随那一段文字一起走）。
 *
 * 内联编辑的纯规则另有 `spec.u36-inline`（在 `spec.u36` 这一支里就近钉住）——
 * 这里走的是**真按键 → 外壳**那条路（与真终端同形）。
 */

import { describe, expect, test } from 'bun:test'
import type { Command, KernelEvent, PathCatalogRow, SkillCatalogRow } from '@magic/contracts'
import type { DraftRef } from '../src/components/inline.ts'
import { composerLayout } from '../src/components/composer.ts'
import { createStage } from './screen.ts'
import type { Stage } from './screen.ts'
import { event } from './events.ts'

const ENTER = { kind: 'enter' } as const
const ESC = { kind: 'escape' } as const
const TAB = { kind: 'tab' } as const
const LEFT = { kind: 'left' } as const
const RIGHT = { kind: 'right' } as const
const BACKSPACE = { kind: 'backspace' } as const
const DELETE = { kind: 'delete' } as const

/** 一条路径候选（答复里的行）。 */
function row(display: string, kind: 'file' | 'directory' = 'file', external = false): PathCatalogRow {
  return { path: `/ws/${display}`, display, kind, external }
}

/** 喂一条 `paths.catalog`（答复）——`query` 是它答复的那一段（外壳据它对上）。 */
function feedPaths(stage: Stage, query: string, rows: readonly PathCatalogRow[], note?: string): void {
  stage.feed([event('paths.catalog', { query, rows, ...(note === undefined ? {} : { note }) })] as readonly KernelEvent[])
}

/** 提交过的交代（`input.submit` 那几条，按序）。 */
function submitted(stage: Stage): readonly Command[] {
  return stage.commands().filter((one) => one.type === 'input.submit')
}

/** 草稿上的引用（视图那一份）。 */
function refs(stage: Stage): readonly DraftRef[] {
  return stage.shell.getView().refs
}

/** 一路选入一个文件引用：`@` → 答复 → 回车。 */
function pickFile(stage: Stage, display: string, kind: 'file' | 'directory' = 'file'): void {
  stage.press({ kind: 'char', char: '@' })
  feedPaths(stage, '', [row(display, kind)])
  stage.press(ENTER)
}

describe('U36 · 输入历史：整份草稿回来（正文 ＋ 引用）', () => {
  const review: SkillCatalogRow = {
    name: 'review',
    description: '检查改动',
    path: '/ws/.magic/skills/review',
    label: '项目 .magic/skills',
    source: 'project',
    origin: 'magic',
  }

  const catalog = (): KernelEvent =>
    event('skills.catalog', { skills: [review], problems: [] })

  /** 提交一条**文件 ＋ 技能 ＋ 重复引用**的交代（三个引用区间，两个身份）。 */
  function submitMixed(stage: Stage): void {
    stage.type('先读 ')
    pickFile(stage, 'a.txt')
    stage.type('，再按 ')
    stage.feed([catalog()])
    stage.type('/rev')
    stage.press(TAB)
    stage.type(' 检查 ')
    pickFile(stage, 'a.txt')
    stage.press(ENTER)
  }

  test('`↑` 召回的是**整份草稿**：正文与三处引用（位置 ＋ 身份）一起回来', () => {
    const stage = createStage()
    submitMixed(stage)
    expect(stage.shell.getView().draft).toBe('') // 交出去了

    stage.press({ kind: 'up' })

    const view = stage.shell.getView()
    expect(view.draft).toBe('先读 @a.txt，再按 /review 检查 @a.txt')
    // 三处引用都在原来的位置、带着原来那份身份（重复的那一处**不去重、不丢位置**）
    expect(refs(stage)).toEqual([
      { start: 3, end: 9, kind: 'file', marker: '@a.txt', source: '/ws/a.txt' },
      {
        start: 13,
        end: 20,
        kind: 'skill',
        marker: '/review',
        name: 'review',
        source: '/ws/.magic/skills/review',
      },
      { start: 24, end: 30, kind: 'file', marker: '@a.txt', source: '/ws/a.txt' },
    ])
    // 位置自证：每一处的 `marker` 与草稿上那一段逐字对得上
    for (const ref of refs(stage)) {
      expect(view.draft.slice(ref.start, ref.end)).toBe(ref.marker)
    }
  })

  test('**翻历史不发命令、不读材料**（本地的一跳）', () => {
    const stage = createStage()
    submitMixed(stage)
    const before = stage.commands().length

    stage.press({ kind: 'up' })
    stage.press({ kind: 'down' })
    stage.press({ kind: 'up' })

    expect(stage.commands()).toHaveLength(before) // 一条命令都没多
    expect(submitted(stage)).toHaveLength(1) // 也没有第二次提交
  })

  test('召回之后接着改、再提交：那几处引用照旧随它走（不必重选）', () => {
    const stage = createStage()
    submitMixed(stage)

    stage.press({ kind: 'up' })
    stage.type(' 再看一遍') // 在末尾接着打
    stage.press(ENTER)

    const sent = submitted(stage).at(-1)
    expect(sent).toBeDefined()
    expect(sent !== undefined && 'refs' in sent ? sent.refs : undefined).toEqual([
      { kind: 'file', at: 3, marker: '@a.txt', source: '/ws/a.txt' },
      {
        kind: 'skill',
        at: 13,
        marker: '/review',
        name: 'review',
        source: '/ws/.magic/skills/review',
      },
      { kind: 'file', at: 24, marker: '@a.txt', source: '/ws/a.txt' },
    ])
  })

  test('**开始浏览前存的那份原稿**：从最新那条按下 `↓` 整份还回来（正文 ＋ 引用 ＋ 插入点）', () => {
    const stage = createStage()
    submitMixed(stage)

    // 用户已经在打新的一条了（正文 ＋ 一处引用），插入点停在句中
    stage.type('先看 ')
    pickFile(stage, 'a.txt')
    stage.type(' 再定')
    for (let at = 0; at < 2; at += 1) stage.press(LEFT)
    const caret = stage.shell.getView().caret

    stage.press({ kind: 'up' }) // 翻到最新那条历史（原稿被收起来）
    expect(stage.shell.getView().draft).toBe('先读 @a.txt，再按 /review 检查 @a.txt')

    stage.press({ kind: 'down' }) // 再往回＝**还回原稿**

    const view = stage.shell.getView()
    expect(view.draft).toBe('先看 @a.txt 再定')
    expect(view.caret).toBe(caret) // 插入点也回到原来那一格
    expect(refs(stage)).toEqual([
      { start: 3, end: 9, kind: 'file', marker: '@a.txt', source: '/ws/a.txt' },
    ])
  })

  test('**已在草稿位置继续按下保持原稿**：不清空、不环绕', () => {
    const stage = createStage()
    stage.type('第一句')
    stage.press(ENTER)
    stage.type('原稿这句话')

    stage.press({ kind: 'up' })
    stage.press({ kind: 'down' }) // 回到原稿
    stage.press({ kind: 'down' }) // 已是草稿位置——**什么都不做**

    expect(stage.shell.getView().draft).toBe('原稿这句话')

    // 往回翻到头也不环绕
    stage.press({ kind: 'up' })
    stage.press({ kind: 'up' })
    expect(stage.shell.getView().draft).toBe('第一句')
  })

  test('**旧纯文本那条仍是纯文本**：召回不带任何引用（不猜引用）', () => {
    const stage = createStage()
    stage.type('就是一句话')
    stage.press(ENTER)

    stage.press({ kind: 'up' })

    expect(stage.shell.getView().draft).toBe('就是一句话')
    expect(refs(stage)).toEqual([])
  })
})

describe('U36 · 几何：引用折到两行上也要上对色', () => {
  /**
   * 折行会把一处引用**劈成两半**（`wrap-ansi` 那一支按宽度折），故区间是**逐行算**的。
   * 这一条钉的就是那个换算：两段加起来正好是那处引用的长度，且不会溢到别的字上去。
   */
  test('跨行的一处引用：两行各拿自己那一段（不多不少）', () => {
    // 40 列 → 内容宽 38；把引用摆在正好会被折开的位置上
    const draft = `${'字'.repeat(15)} @src/login.ts`
    const layout = composerLayout(draft, draft.length, 40, Number.POSITIVE_INFINITY, [
      { start: 16, end: 29 },
    ])

    const spans = layout.rows.flatMap((row) => row.spans ?? [])
    const covered = spans.reduce((sum, span) => sum + (span.end - span.start), 0)
    expect(covered).toBe(13) // `@src/login.ts`
    // 每一段的坐标都落在它自己那一行里
    for (const row of layout.rows) {
      for (const span of row.spans ?? []) {
        expect(span.start).toBeGreaterThanOrEqual(0)
        expect(span.end).toBeLessThanOrEqual(row.text.length)
      }
    }
  })

  test('对不上位置时**不上色**（宁可同色，也不刷到别的字上）', () => {
    const layout = composerLayout('一句话', 3, 40, Number.POSITIVE_INFINITY, [{ start: 99, end: 120 }])
    expect(layout.rows.every((row) => (row.spans ?? []).length === 0)).toBe(true)
  })
})

describe('U36 · `@` 开候选：只在词边界，边上边问', () => {
  test('打一个 `@` 就问一次候选（此时查询是空的）', () => {
    const stage = createStage()

    stage.type('看下 ')
    stage.press({ kind: 'char', char: '@' })

    expect(stage.commands()).toEqual([{ type: 'paths.list', query: '' }])
    expect(stage.shell.getView().draft).toBe('看下 @')
    expect(stage.shell.getView().dock.kind).toBe('picker')
  })

  test('紧挨着字的 `@`（邮箱那种）与转义 `\\@` 都不触发', () => {
    const stage = createStage()

    // 邮箱：`a@b` —— 前一个字不是空白 ⇒ 不开候选
    stage.type('a')
    stage.press({ kind: 'char', char: '@' })
    expect(stage.shell.getView().dock.kind).toBe('input')
    expect(stage.commands()).toEqual([])

    stage.type(' b')
    stage.press(ESC) // 清掉重来
    stage.type('\\')
    stage.press({ kind: 'char', char: '@' })
    expect(stage.shell.getView().dock.kind).toBe('input')
    expect(stage.shell.getView().draft).toBe('\\@')
  })

  test('**边打边问**：抽屉里打的字同时写进草稿（它就是那句话的一部分）', () => {
    const stage = createStage()
    stage.press({ kind: 'char', char: '@' })

    stage.type('src/lo')

    // 草稿里那一串跟着长（`@` 之后就是查询），且每改一次问一次
    expect(stage.shell.getView().draft).toBe('@src/lo')
    expect(stage.commands().slice(0, 3)).toEqual([
      { type: 'paths.list', query: '' },
      { type: 'paths.list', query: 's' },
      { type: 'paths.list', query: 'sr' },
    ])

    // 答复回来 ⇒ 铺行（只认 query 对得上的那一次）
    feedPaths(stage, 'src/lo', [row('src/login.ts')])
    const dock = stage.shell.getView().dock
    expect(dock.kind === 'picker' && dock.picker.rows.map((r) => r.label)).toEqual(['src/login.ts'])

    // 迟到的旧答复（query 对不上）不铺
    feedPaths(stage, 'src/l', [row('src/legacy.ts')])
    const after = stage.shell.getView().dock
    expect(after.kind === 'picker' && after.picker.rows.map((r) => r.label)).toEqual(['src/login.ts'])
  })

  test('退格一格＝放宽查询（草稿与抽屉一起缩）', () => {
    const stage = createStage()
    stage.press({ kind: 'char', char: '@' })
    stage.type('src')

    stage.press(BACKSPACE)

    expect(stage.shell.getView().draft).toBe('@sr')
    expect(stage.commands().at(-1)).toEqual({ type: 'paths.list', query: 'sr' })
  })

  test('查询退空了再退格 ⇒ **撤掉这一处查询**（草稿回到打 `@` 之前）', () => {
    const stage = createStage()
    stage.type('先读 ')
    stage.press({ kind: 'char', char: '@' })
    stage.type('s')

    stage.press(BACKSPACE) // 删掉 `s`
    expect(stage.shell.getView().draft).toBe('先读 @')

    stage.press(BACKSPACE) // 查询空了，再一下＝整个撤回
    expect(stage.shell.getView().draft).toBe('先读 ')
    expect(stage.shell.getView().dock.kind).toBe('input')
  })

  test('`esc` 取消＝**归还原稿**（那一段查询不算用户说的话）', () => {
    const stage = createStage()
    stage.type('先读 ')
    stage.press({ kind: 'char', char: '@' })
    stage.type('src')

    stage.press(ESC)

    expect(stage.shell.getView().draft).toBe('先读 ')
    expect(stage.shell.getView().caret).toBe(3)
    expect(stage.shell.getView().dock.kind).toBe('input')
    expect(refs(stage)).toEqual([])
  })
})

describe('U36 · 句中那个 `/名称`：也在词边界唤起候选', () => {
  test('句中打 `/` 也问一次目录（不限于句首）——问过就认得出技能名', () => {
    const stage = createStage()

    stage.type('先读 ')
    stage.press({ kind: 'char', char: '/' })

    expect(stage.commands()).toEqual([{ type: 'skills.list' }])

    stage.feed([
      event('skills.catalog', {
        skills: [
          {
            name: 'review',
            description: '检查改动',
            path: '/ws/.magic/skills/review',
            label: '项目 .magic/skills',
            source: 'project',
            origin: 'magic',
          },
        ],
        problems: [],
      }),
    ])

    stage.type('re')

    // 候选里**只有技能**（内置命令是整行的入口，不在一句话中间列）
    expect(stage.shell.getView().completion?.candidates.map((one) => one.name)).toEqual(['/review'])
  })

  test('`Tab` 选定＝把 `/名称` 留在原处并绑上身份（不发送）', () => {
    const stage = createStage()
    stage.type('再按 ')
    stage.feed([
      event('skills.catalog', {
        skills: [
          {
            name: 'review',
            description: '检查改动',
            path: '/ws/.magic/skills/review',
            label: '项目 .magic/skills',
            source: 'project',
            origin: 'magic',
          },
        ],
        problems: [],
      }),
    ])

    stage.type('/rev')
    stage.press(TAB)

    const view = stage.shell.getView()
    expect(view.draft).toBe('再按 /review')
    expect(refs(stage)).toEqual([
      {
        start: 3,
        end: 10,
        kind: 'skill',
        marker: '/review',
        name: 'review',
        source: '/ws/.magic/skills/review',
      },
    ])
    expect(submitted(stage)).toEqual([]) // 选定不发送
  })

  test('**选定之后候选收起**：紧接着按回车＝发送（不再被候选吞掉）', () => {
    const stage = createStage()
    stage.type('再按 ')
    stage.feed([
      event('skills.catalog', {
        skills: [
          {
            name: 'review',
            description: '检查改动',
            path: '/ws/.magic/skills/review',
            label: '项目 .magic/skills',
            source: 'project',
            origin: 'magic',
          },
        ],
        problems: [],
      }),
    ])
    stage.type('/rev')
    stage.press(TAB)
    expect(stage.shell.getView().completion).toBeNull() // 选定即收起（那一条已不再自荐）

    stage.type(' 看看')
    stage.press(ENTER)

    // 真 PTY 上栽过：候选没收起时，这一次回车被它吃了（`pickCompletion` 不发东西）
    expect(submitted(stage)).toHaveLength(1)
  })

  test('不选就不算引用：句中的 `/名称` 原样是文字（不扫描正文去猜）', () => {
    const stage = createStage()
    stage.type('再按 /review 检查')

    stage.press(ENTER)

    const sent = submitted(stage)[0]
    expect(sent).toBeDefined()
    // 一个字都没被当成引用——**明确选定**才是那把钥匙（设计：不扫描用户粘贴的路径 / 命令）
    expect(sent !== undefined && 'refs' in sent ? sent.refs : undefined).toBeUndefined()
  })
})

describe('U36 · 选定：引用留在原位', () => {
  test('`Enter` 只选入，不同时发送；引用文字就写在查询那一处', () => {
    const stage = createStage()
    stage.type('先读 ')
    pickFile(stage, 'src/login.ts')

    const view = stage.shell.getView()
    expect(view.draft).toBe('先读 @src/login.ts')
    expect(view.caret).toBe(view.draft.length)
    expect(refs(stage)).toEqual([
      { start: 3, end: 16, kind: 'file', marker: '@src/login.ts', source: '/ws/src/login.ts' },
    ])
    expect(submitted(stage)).toEqual([]) // 选定不发送
  })

  test('**目录**选定写成 `@src/`（一眼分得出），身份是那条目录', () => {
    const stage = createStage()
    pickFile(stage, 'src', 'directory')

    expect(stage.shell.getView().draft).toBe('@src/')
    expect(refs(stage)[0]?.kind).toBe('dir')
    expect(refs(stage)[0]?.source).toBe('/ws/src')
  })

  test('`Tab` 补全：目录再补一个尾斜杠，接着往里看一层', () => {
    const stage = createStage()
    stage.press({ kind: 'char', char: '@' })
    feedPaths(stage, '', [row('src', 'directory')])

    stage.press(TAB)

    expect(stage.shell.getView().draft).toBe('@src/')
    expect(stage.commands().at(-1)).toEqual({ type: 'paths.list', query: 'src/' })
    // 抽屉还开着（补全是接着打，不是选定）
    expect(stage.shell.getView().dock.kind).toBe('picker')
  })

  test('中间那处：前有后有的正文一个字不动，插入点在引用之后', () => {
    const stage = createStage()
    stage.type('先看 ')
    stage.press({ kind: 'char', char: '@' })
    feedPaths(stage, '', [row('a.txt')])
    stage.press(ENTER)
    stage.type(' 再说')

    expect(stage.shell.getView().draft).toBe('先看 @a.txt 再说')
    expect(refs(stage)[0]).toEqual({
      start: 3,
      end: 9,
      kind: 'file',
      marker: '@a.txt',
      source: '/ws/a.txt',
    })
  })

  test('屏上：引用那几个字与普通正文**不同色**（原位看得出来）', async () => {
    const stage = createStage()
    stage.type('先看 ')
    pickFile(stage, 'a.txt')
    stage.type(' 再说')

    const frame = await stage.screen()
    const cells = frame.cellsOf(frame.rowOf('@a.txt')).filter((cell) => cell.text.trim() !== '')
    const colors = (text: string): readonly (string | null)[] =>
      cells.filter((cell) => text.includes(cell.text)).map((cell) => cell.fg)

    // 引用那六个字一色；左近那句正文（`先看`）是另一个色——**原位看得出来了**
    const quote = colors('@a.txt')
    const body = colors('先看')
    expect(new Set(quote).size).toBe(1)
    expect(quote[0]).toBe('#56b6c2') // `PALETTE.user`
    expect(body.length).toBeGreaterThan(0)
    expect(body.every((color) => color !== quote[0])).toBe(true)
  })

  test('工作区外那一条也标得出来（选定＝只读附件）', () => {
    const stage = createStage()
    stage.type('@')
    feedPaths(stage, '', [{ path: '/etc/hosts', display: '/etc/hosts', kind: 'file', external: true }])
    stage.press(ENTER)

    expect(refs(stage)[0]?.external).toBe(true)
    expect(refs(stage)[0]?.marker).toBe('@/etc/hosts')
  })
})

describe('U36 · 编辑：引用是一个可定位的单位', () => {
  /** 草稿：`先看 @a.txt 再说`，`@a.txt` 是引用（[3, 9)）。 */
  function withRef(): Stage {
    const stage = createStage()
    stage.type('先看 ')
    pickFile(stage, 'a.txt')
    stage.type(' 再说')
    return stage
  }

  test('`←` 越过整处引用（不落进它里面）；`→` 同理', () => {
    const stage = withRef()
    // 草稿：`先看 @a.txt 再说`（12 个字）——引用是 [3, 9)
    expect(stage.shell.getView().caret).toBe(12)

    stage.press(LEFT) // 从末尾往左，字素一格
    expect(stage.shell.getView().caret).toBe(11)
    stage.press(LEFT)
    stage.press(LEFT)
    expect(stage.shell.getView().caret).toBe(9) // 引用尾巴

    stage.press(LEFT) // 这一下**整处跨过去**
    expect(stage.shell.getView().caret).toBe(3)

    stage.press(RIGHT) // 再往回：整处跨回来
    expect(stage.shell.getView().caret).toBe(9)
  })

  test('退格在引用尾巴上 ⇒ **整处移除**；前后的字一个字不动', () => {
    const stage = withRef()
    for (let at = 0; at < 3; at += 1) stage.press(LEFT) // 到引用尾巴（9）

    stage.press(BACKSPACE)

    expect(stage.shell.getView().draft).toBe('先看  再说')
    expect(refs(stage)).toEqual([]) // 材料随那一段文字一起走（不暗带）
    expect(stage.shell.getView().caret).toBe(3)
  })

  test('`delete` 在引用头上 ⇒ 也是整处移除', () => {
    const stage = withRef()
    for (let at = 0; at < 4; at += 1) stage.press(LEFT) // 到引用开头（3）——`←` 整处跨过引用

    stage.press(DELETE)

    expect(stage.shell.getView().draft).toBe('先看  再说')
    expect(refs(stage)).toEqual([])
  })

  test('引用之后的普通退格只删一个字（不牵连那处引用）', () => {
    const stage = withRef()

    stage.press(BACKSPACE) // 末尾那一个「说」

    expect(stage.shell.getView().draft).toBe('先看 @a.txt 再')
    expect(refs(stage)[0]?.start).toBe(3) // 区间没动
  })

  test('在引用之前插字：引用跟着右移（身份不丢、位置不错）', () => {
    const stage = withRef()
    for (let at = 0; at < 4; at += 1) stage.press(LEFT) // 到引用开头（3）
    stage.press({ kind: 'char', char: '先' })

    // 插在前面的字把引用推后一格——区间跟着走，`marker` 与草稿仍对得上
    const view = stage.shell.getView()
    expect(view.draft).toBe('先看 先@a.txt 再说')
    expect(refs(stage)[0]?.start).toBe(4)
    expect(view.draft.slice(refs(stage)[0]?.start, refs(stage)[0]?.end)).toBe('@a.txt')
  })

  test('删掉整段正文（`esc`）时引用一起走（同生共死）', () => {
    const stage = withRef()

    stage.press(ESC)

    expect(stage.shell.getView().draft).toBe('')
    expect(refs(stage)).toEqual([])
  })
})

describe('U36 · 提交：位置与身份一起走', () => {
  test('一句里三处（文件 / 技能 / 文件）按原句次序交出位置与身份', () => {
    const stage = createStage()
    // 技能目录：打 `/` 那一下问一次（答复由用例喂）
    stage.type('先读 ')
    pickFile(stage, '需求.md')
    stage.type('，再按 ')
    stage.feed([
      event('skills.catalog', {
        skills: [
          {
            name: 'review',
            description: '检查改动',
            path: '/ws/.magic/skills/review',
            label: '项目 .magic/skills',
            source: 'project',
            origin: 'magic',
          },
        ],
        problems: [],
      }),
    ])
    stage.type('/rev')
    stage.press(TAB) // 候选里补全 ⇒ 在原处放一句引用
    stage.type(' 检查 ')
    pickFile(stage, 'src/login.ts')

    expect(stage.shell.getView().draft).toBe('先读 @需求.md，再按 /review 检查 @src/login.ts')

    stage.press(ENTER)

    expect(submitted(stage)).toEqual([
      {
        type: 'input.submit',
        text: '先读 @需求.md，再按 /review 检查 @src/login.ts',
        refs: [
          { kind: 'file', at: 3, marker: '@需求.md', source: '/ws/需求.md' },
          {
            kind: 'skill',
            at: 13,
            marker: '/review',
            name: 'review',
            source: '/ws/.magic/skills/review',
          },
          { kind: 'file', at: 24, marker: '@src/login.ts', source: '/ws/src/login.ts' },
        ],
        ref: 'draft-1',
      },
    ])
    // 交出去之后草稿清空、引用也清空（下一次从零开始）
    expect(stage.shell.getView().draft).toBe('')
    expect(refs(stage)).toEqual([])
  })

  test('只有**文件**引用、一个字都没有 ⇒ 照样提交（设计：正文或附件任一非空即可）', () => {
    const stage = createStage()
    pickFile(stage, 'a.txt')

    stage.press(ENTER)

    expect(submitted(stage)).toEqual([
      {
        type: 'input.submit',
        text: '@a.txt',
        refs: [{ kind: 'file', at: 0, marker: '@a.txt', source: '/ws/a.txt' }],
        ref: 'draft-1',
      },
    ])
  })

  test('只有**技能**引用 ⇒ 不提交，且当场说一句（技能说的是「怎么做」，不指对象）', () => {
    const stage = createStage()
    stage.feed([
      event('skills.catalog', {
        skills: [
          {
            name: 'review',
            description: '检查改动',
            path: '/ws/.magic/skills/review',
            label: '项目 .magic/skills',
            source: 'project',
            origin: 'magic',
          },
        ],
        problems: [],
      }),
    ])
    stage.type('/rev')
    stage.press(TAB) // 放进草稿（在原处）

    stage.press(ENTER)

    expect(submitted(stage)).toEqual([])
    expect(stage.shell.getView().draft).toBe('/review') // 草稿留着
    expect(stage.shell.getView().flash).toContain('只有一处技能引用')
  })

  test('**同一份材料引用两次**：两处各自留着（不按身份去重、不丢位置）', () => {
    const stage = createStage()
    stage.type('看 ')
    pickFile(stage, 'a.txt')
    stage.type(' 再看 ')
    pickFile(stage, 'a.txt')

    expect(stage.shell.getView().draft).toBe('看 @a.txt 再看 @a.txt')
    expect(refs(stage).map((ref) => ref.start)).toEqual([2, 12])

    stage.press(ENTER)

    const sent = submitted(stage)[0]
    expect(sent !== undefined && 'refs' in sent ? sent.refs : undefined).toEqual([
      { kind: 'file', at: 2, marker: '@a.txt', source: '/ws/a.txt' },
      { kind: 'file', at: 12, marker: '@a.txt', source: '/ws/a.txt' },
    ])
  })

  test('提交失败：正文与**引用**一起还回来（按原 ref 认领）', () => {
    const stage = createStage()
    stage.type('看 ')
    pickFile(stage, 'a.txt')
    stage.press(ENTER)

    stage.feed([
      event('input.settled', { ref: 'draft-1', ok: false, reason: '「a.txt」现在不在了' }),
    ])

    const view = stage.shell.getView()
    expect(view.draft).toBe('看 @a.txt')
    expect(refs(stage)[0]?.source).toBe('/ws/a.txt')
  })
})
