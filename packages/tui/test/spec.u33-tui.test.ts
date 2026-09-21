/**
 * U33 · **终端入口**（第二轮）——`/<技能名>` 直达、`/skills` 浏览与选择、
 * 草稿绑定与移除、随交代一次提交、失败按原 ref 保稿。
 *
 * 内核那一半（发现 / 按需读取 / 完整输入 / 两条回执）在第一轮已验并合主干；
 * 这里钉的是**外壳那一半**：按键 → 视图 ＋ 命令。
 *
 * 三条贯穿本文件的判据（都是工单写死的）：
 * - **选定只绑草稿**：不加载主文、不发模型请求、**不顺手把草稿发出去**；
 * - **正文与技能同一次提交**，且斜杠之后那一整段**不再当控制命令解析**；
 * - **失败保住交代**：按原 `ref` 认回原稿，**不覆盖用户后来编辑的新稿**。
 *
 * 真终端上那几屏（真 PTY ＋ 本地模型夹具）另见 `packages/app/test/frames-u33-tui.ts`
 * ——那里才量得出「零主文加载 / 零模型请求」那条（夹具的请求表）。
 *
 * ## 目录什么时候到手（用例里的次序）
 *
 * 真会话里，**打 `/` 那一下外壳就问一次目录**（`shell.ts` 的 `askSkills`），答复是同步回来的
 * ——等用户把 `/pdf` 打完，目录早就在手上了。用例这边那个答复没人代发（间谍传输只记不发），
 * 故**直达那一路要显式喂一条 `skills.catalog`**，位置摆在最后那次回车之前
 * （＝「答复在按下回车之前到了」，正是真会话里发生的事）。
 */

import { describe, expect, test } from 'bun:test'
import type { Command, Entry, KernelEvent, SkillCatalogRow } from '@magic/contracts'
import { createShell } from '../src/shell.ts'
import { logLines } from '../src/components/log.ts'
import { MAX_CANDIDATES, createView, rebuild } from '../src/view.ts'
import { createStage } from './screen.ts'
import type { Stage } from './screen.ts'
import { event } from './events.ts'

const ENTER = { kind: 'enter' } as const
const ESC = { kind: 'escape' } as const

/** 一份技能（目录真路径即身份——同名两份靠它分开）。 */
function skill(
  name: string,
  options: { label?: string; description?: string; path?: string } = {},
): SkillCatalogRow {
  const label = options.label ?? '项目 .magic/skills'
  const scope = label.startsWith('项目') ? 'project' : 'user'

  return {
    name,
    description: options.description ?? `${name} 的简述`,
    path: options.path ?? `/ws/${scope}/${name}`,
    label,
    source: scope,
    origin: label.includes('.agents') ? 'agents' : 'magic',
  }
}

/** 喂一条 `skills.catalog`（答复）。 */
function feedCatalog(stage: Stage, rows: readonly SkillCatalogRow[]): void {
  stage.feed([event('skills.catalog', { skills: rows, problems: [] })])
}

/**
 * **直达一次**：打 `/名字 交代…`，目录到手，回车。
 *
 * 次序照真会话——答复（目录）在最后那次回车之前到。
 */
function directHit(stage: Stage, line: string, rows: readonly SkillCatalogRow[]): void {
  stage.type(line)
  feedCatalog(stage, rows)
  stage.press(ENTER)
}

/** **开 `/skills`**：打那条命令、回车、等目录答复（抽屉由答复那一下开）。 */
function openSkills(stage: Stage, word: string, rows: readonly SkillCatalogRow[]): void {
  stage.type(word)
  stage.press(ENTER)
  feedCatalog(stage, rows)
}

/** 抽屉（没开就当场炸——省得每条用例各写一遍判断）。 */
function pickerOf(stage: Stage) {
  const dock = stage.shell.getView().dock
  if (dock.kind !== 'picker') throw new Error(`抽屉没开：dock＝${dock.kind}`)

  return dock.picker
}

/** 提交过的交代（`input.submit` 那几条，按序）。 */
function submitted(stage: Stage): readonly Command[] {
  return stage.commands().filter((one) => one.type === 'input.submit')
}

/** 记录区（定局 ＋ 本轮）里人看得见的那几行字。 */
function said(stage: Stage): string {
  return [...stage.shell.getView().settled, ...stage.shell.getView().rows]
    .filter((row) => row.kind !== 'banner')
    .map((row) => ('text' in row ? row.text : ''))
    .join('\n')
}

/** 交互区那一块的字（分隔线之下）——「屏上有没有这一行」看它。 */
async function dockText(stage: Stage): Promise<string> {
  return (await stage.screen()).dock.map((line) => line.text).join('\n')
}

describe('U33 · 打 `/` 那一下问一次目录（输入行的候选取材）', () => {
  test('**每屏只问一次**——此后接着打斜杠不再问', () => {
    const stage = createStage()

    stage.type('/')
    expect(stage.commands()).toEqual([{ type: 'skills.list' }])

    stage.type('x')
    stage.press(ESC) // 清掉重打：又是一条新的斜杠草稿
    stage.type('/y')

    expect(stage.commands()).toEqual([{ type: 'skills.list' }])
  })

  test('技能够进候选：`/ui` 认得出 `/ui-review`（目录到手之后）', () => {
    const stage = createStage()

    stage.type('/ui')
    // 目录还没回来——此刻一条技能都不列（拿不到的不编）
    expect(stage.shell.getView().completion?.candidates.map((one) => one.name) ?? []).toEqual([])

    feedCatalog(stage, [skill('ui-review', { description: '检查布局、文案、层级' })])

    expect(stage.shell.getView().completion?.candidates.map((one) => one.name)).toEqual(['/ui-review'])
  })

  test('非斜杠草稿不问；放开输入之前也不问（命令进不去内核，问了白问）', () => {
    const stage = createStage({ inputReady: false })

    stage.type('看下目录')
    expect(stage.commands()).toEqual([])

    stage.type('/skills')
    expect(stage.commands()).toEqual([]) // 启动中：一个命令都不发
  })
})

describe('U33 · `/skills` 的抽屉', () => {
  test('发一次 `skills.list`，记录区什么都不进；答复回来才开', () => {
    const stage = createStage()

    stage.type('/skills')
    stage.press(ENTER)

    // 打 `/` 那一下已经问过一次（每屏一次）；这里再问一次是**浏览面**该有的现况
    expect(stage.commands()).toEqual([{ type: 'skills.list' }, { type: 'skills.list' }])
    expect(stage.shell.getView().dock.kind).toBe('input') // 没回来之前不开（拿不到的不编）

    feedCatalog(stage, [skill('pdf'), skill('debug')])

    const picker = pickerOf(stage)
    // 候选每项一行：名称（label）＋ 来源 · 简述（meta）——同名两份靠来源分得开
    expect(picker.rows.map((row) => row.label)).toEqual(['pdf', 'debug'])
    expect(picker.rows[0]?.meta).toBe('项目 .magic/skills · pdf 的简述')
    expect(picker.rows.every((row) => row.oneLine === true)).toBe(true)
  })

  test('同名两份各占一行、来源可辨；绑着的那份标「当前」', () => {
    const stage = createStage()
    const two = [
      skill('pdf', { label: '项目 .magic/skills' }),
      skill('pdf', { label: '用户 .magic/skills' }),
    ]

    openSkills(stage, '/skills', two)
    expect(pickerOf(stage).rows.map((row) => row.meta.split(' · ')[0])).toEqual([
      '项目 .magic/skills',
      '用户 .magic/skills',
    ])

    stage.press(ENTER) // 选定头一份
    expect(stage.shell.getView().bound?.ref.path).toBe('/ws/project/pdf')

    openSkills(stage, '/skills', two)
    // 两份技能 ＋ 末尾那条「移除当前技能」——只有绑着的那份标「当前」
    expect(pickerOf(stage).rows.map((row) => row.current)).toEqual([true, false, false])
  })

  test('选定＝**只绑草稿**：正文留着、一条命令都不发（不发送、不加载主文）', () => {
    const stage = createStage()
    // 走**同名展开**那一路：它是唯一「抽屉开着而草稿里有正文」的形态
    // （`/skills` 自己是个斜杠命令，打它之前草稿先被清掉了）
    const tied = [
      { ...skill('pdf'), path: '/ws/a/pdf' },
      { ...skill('pdf'), path: '/ws/b/pdf' },
    ]
    directHit(stage, '/pdf 先打半句', tied)
    const before = stage.commands().length

    stage.press(ENTER) // 选定

    const view = stage.shell.getView()
    expect(view.bound).toEqual({ ref: { name: 'pdf', path: '/ws/a/pdf' }, label: '项目 .magic/skills' })
    expect(view.draft).toBe('先打半句') // 正文留着（斜杠那一截是入口语法，不是正文）
    expect(view.caret).toBe(4)
    expect(view.dock.kind).toBe('input') // 抽屉收起
    expect(stage.commands()).toHaveLength(before) // 一条命令都不发（「零模型请求」的根就在这儿）
  })

  test('`esc` 取消＝不留痕迹，草稿一个字不动', () => {
    const stage = createStage()
    // 走**同名展开**那一路：它是唯一「抽屉开着而草稿里有正文」的形态
    // （`/skills` 自己是个斜杠命令，打它之前草稿先被清掉了）
    const tied = [
      { ...skill('pdf'), path: '/ws/a/pdf' },
      { ...skill('pdf'), path: '/ws/b/pdf' },
    ]
    directHit(stage, '/pdf 半句话', tied)
    expect(pickerOf(stage).rows).toHaveLength(2)

    stage.press(ESC)

    expect(stage.shell.getView().dock.kind).toBe('input')
    expect(stage.shell.getView().draft).toBe('/pdf 半句话') // 一个字都没动
    expect(stage.shell.getView().bound).toBeNull()
  })

  test('**移除当前技能**那一行在最后（默认选中项是第一条技能——摆头里一按回车就误删）', () => {
    const stage = createStage()
    directHit(stage, '/pdf', [skill('pdf')]) // 直达：只打名字＝只绑定

    openSkills(stage, '/skills', [skill('pdf')])
    const rows = pickerOf(stage).rows

    expect(rows.at(-1)?.label).toBe('移除当前技能')
    expect(rows.at(-1)?.value).toBe('@remove')
    expect(rows.at(-1)?.meta).toBe('保留正文（pdf）')
    expect(rows[0]?.current).toBe(true) // 绑着的那份在前面、标着「当前」

    stage.press({ kind: 'up' }) // 环形：从 0 往上＝绕到末尾那一条
    stage.press(ENTER)

    expect(stage.shell.getView().bound).toBeNull()
  })

  test('**移除保留正文**：`esc` 摘材料，草稿里的话一个字不动', () => {
    const stage = createStage()
    directHit(stage, '/pdf', [skill('pdf')])
    stage.type('帮我看看')

    stage.press(ESC)

    // 材料摘掉了，正文与插入点一个字不动
    expect(stage.shell.getView().bound).toBeNull()
    expect(stage.shell.getView().draft).toBe('帮我看看')
    expect(stage.shell.getView().caret).toBe(4)

    stage.press(ESC) // 第二下才是「清草稿」那条老规矩
    expect(stage.shell.getView().draft).toBe('')
  })
})

describe('U33 · `/skills` 的搜索', () => {
  test('打字收窄、退格放宽（筛词写在列表下方）', () => {
    const stage = createStage()
    openSkills(stage, '/skills', [skill('pdf'), skill('ui-review', { description: '检查布局' })])

    stage.type('ui')
    expect(pickerOf(stage).rows.map((row) => row.label)).toEqual(['ui-review'])
    expect(pickerOf(stage).filter).toBe('ui')
    expect(pickerOf(stage).hint).toContain('筛选「ui」')

    // 退格放宽（删到空＝全目录又回来了）
    stage.press({ kind: 'backspace' })
    stage.press({ kind: 'backspace' })
    expect(pickerOf(stage).filter).toBe('')
    expect(pickerOf(stage).rows.map((row) => row.label)).toEqual(['pdf', 'ui-review'])
  })

  test('**筛空了抽屉仍开着**（正在筛不是死胡同：接着打、退格、esc 都有动作）', () => {
    const stage = createStage()
    openSkills(stage, '/skills', [skill('pdf')])

    stage.type('zzz')

    const picker = pickerOf(stage)
    expect(picker.rows).toEqual([])
    expect(picker.hint).toContain('没有匹配「zzz」的技能')
    // 回执行里**没有**多出一句（抽屉开着就说在抽屉里，别两处各说一遍）
    expect(stage.shell.getView().settled.filter((row) => row.kind === 'receipt')).toEqual([])
  })

  test('`/skills <词>` 预置筛词', () => {
    const stage = createStage()
    openSkills(stage, '/skills ui', [skill('pdf'), skill('ui-review')])

    expect(pickerOf(stage).rows.map((row) => row.label)).toEqual(['ui-review'])
  })

  test('**空名录不开空抽屉**：那句话落成记录区的一行回执', () => {
    const stage = createStage()
    openSkills(stage, '/skills', [])

    expect(stage.shell.getView().dock.kind).toBe('input') // 抽屉不开
    expect(said(stage)).toContain('.magic/skills/<名称>/SKILL.md')
  })

  test('目录里没读进来的那些：只报**份数** ＋ 指路（逐条的话在 `magic --check` 里）', () => {
    const stage = createStage()
    stage.type('/skills')
    stage.press(ENTER)
    stage.feed([
      event('skills.catalog', {
        skills: [skill('pdf')],
        problems: [
          { path: '/ws/.magic/skills/doomed/SKILL.md', message: 'front-matter 缺 `description`', kind: 'error' },
        ],
      }),
    ])

    expect(pickerOf(stage).hint).toContain('有 1 份没能读进来')
    expect(pickerOf(stage).hint).toContain('--check')
  })
})

describe('U33 · `/<技能名>` 直达', () => {
  test('**只打名字 ＝ 只绑不提交**（后面接着补交代）', () => {
    const stage = createStage()
    directHit(stage, '/pdf', [skill('pdf')])

    expect(stage.shell.getView().bound?.ref.name).toBe('pdf')
    expect(stage.shell.getView().draft).toBe('')
    expect(submitted(stage)).toEqual([]) // 一个 `input.submit` 都没发
  })

  test('`/名字 交代` 一次提交：正文只带交代，技能随它走', () => {
    const stage = createStage()
    directHit(stage, '/pdf 帮我看看', [skill('pdf')])

    expect(stage.commands().at(-1)).toEqual({
      type: 'input.submit',
      text: '帮我看看',
      skills: [{ name: 'pdf', path: '/ws/project/pdf' }],
      ref: 'draft-1',
    })
    // 空草稿、无绑定、本地回显的是**交代本身**（`/pdf` 是入口语法，不是用户说的话）
    expect(stage.shell.getView().draft).toBe('')
    expect(stage.shell.getView().bound).toBeNull()
    expect(stage.shell.getView().rows.at(-1)).toMatchObject({ kind: 'user', text: '帮我看看' })
  })

  test('**斜杠之后那一整段不再解析成控制命令**（`/session` 字样与换行都在正文里）', () => {
    const stage = createStage()
    stage.type('/pdf')
    feedCatalog(stage, [skill('pdf')])
    stage.type(' 看 /session 那段')
    stage.press({ kind: 'newline' })
    stage.type('还有第二行')
    stage.press(ENTER)

    expect(stage.commands().at(-1)).toMatchObject({
      type: 'input.submit',
      // 内部换行原样留着（多行交代不当场压成一行）
      text: '看 /session 那段\n还有第二行',
      skills: [{ name: 'pdf', path: '/ws/project/pdf' }],
    })
    // 没有多出一条 `session.list`（正文里的 `/session` 只是正文）
    expect(stage.commands().some((one) => one.type === 'session.list')).toBe(false)
  })

  test('**同名同档分不出唯一** ⇒ 展开同名候选，不静默挑一个', () => {
    const stage = createStage()
    // 两处都是 project ＋ magic（多根工作区那种）——档位一样，排不出先后
    const tied = [
      { ...skill('pdf'), path: '/ws/a/.magic/skills/pdf' },
      { ...skill('pdf'), path: '/ws/b/.magic/skills/pdf' },
    ]

    directHit(stage, '/pdf 帮我看看', tied)

    expect(submitted(stage)).toEqual([]) // 没提交
    expect(stage.shell.getView().bound).toBeNull() // 也没静默挑一个

    const picker = pickerOf(stage)
    expect(picker.rows.map((row) => row.value)).toEqual([
      '/ws/a/.magic/skills/pdf',
      '/ws/b/.magic/skills/pdf',
    ])
    expect(picker.hint).toContain('同名的')

    stage.press(ENTER) // 选定头一份
    expect(stage.shell.getView().bound?.ref.path).toBe('/ws/a/.magic/skills/pdf')
    expect(stage.shell.getView().draft).toBe('帮我看看') // 斜杠那一截剥掉，正文留着
  })

  test('**内置命令保留**：`/model` 仍是换模型；同名技能从 `/skills` 里选', () => {
    const stage = createStage()
    stage.type('/model')
    stage.press(ENTER)

    expect(stage.commands().at(-1)).toEqual({ type: 'model.list' })

    // 同名技能没被吞掉：`/skills` 列得出来
    stage.press(ESC)
    openSkills(stage, '/skills', [skill('model', { description: '我自己写的' })])
    expect(pickerOf(stage).rows[0]?.label).toBe('model')
  })

  test('目录里没有这个名字 ⇒ 照旧「不认得的命令」，不发东西出去', () => {
    const stage = createStage()
    directHit(stage, '/nope', [skill('pdf')])

    expect(submitted(stage)).toEqual([])
    expect(said(stage)).toContain('不认得的命令')
  })
})

describe('U33 · 提交与失败保稿', () => {
  test('失败按原 `ref` 认回原稿：正文 ＋ 技能一起回来', () => {
    const stage = createStage()
    directHit(stage, '/pdf 帮我看看', [skill('pdf')])
    expect(stage.shell.getView().draft).toBe('')

    stage.feed([
      event('input.settled', {
        ref: 'draft-1',
        ok: false,
        reason: '技能「pdf」在 /ws/project/pdf 上不再成立',
      }),
    ])

    const view = stage.shell.getView()
    expect(view.draft).toBe('帮我看看') // 交代保住了
    expect(view.caret).toBe(4)
    expect(view.bound?.ref.name).toBe('pdf') // 技能也一起回来
    // 缘由**出声**（哪一份来源出的问题）
    expect(said(stage)).toContain('没送出')
    expect(said(stage)).toContain('不再成立')
  })

  test('**拒收在 `send` 之内同步回来**时照样还稿（进程内传输的真样子）', () => {
    const listeners: ((event: KernelEvent) => void)[] = []
    const transport = {
      send: (command: Command) => {
        // 显式选定的技能取不到那一条，内核是**当场**配对 `ok:false` 的（`rejected` 那条路
        // 在 `drain` 的第一个 await 之前就跑完了）——故这里同步回一发
        if (command.type !== 'input.submit') return
        const reply = event('input.settled', {
          ...(command.ref === undefined ? {} : { ref: command.ref }),
          ok: false,
          reason: '技能取不到，这一条没跑',
        })
        for (const listener of [...listeners]) listener(reply)
      },
      subscribe: (listener: (event: KernelEvent) => void) => {
        listeners.push(listener)
        return () => {}
      },
    }

    const shell = createShell(transport as never)
    for (const char of '照它做') shell.key({ kind: 'char', char })
    shell.key({ kind: 'enter' })

    expect(shell.getView().draft).toBe('照它做') // 交代回到了草稿上
    expect(shell.getView().caret).toBe(3)
  })

  test('**不覆盖后来编辑的新稿**：交出去之后又打了字，失败就不动草稿', () => {
    const stage = createStage()
    stage.type('第一份交代')
    stage.press(ENTER)
    stage.type('第二份') // 用户已经在打新的了

    stage.feed([event('input.settled', { ref: 'draft-1', ok: false, reason: '没轮到' })])

    expect(stage.shell.getView().draft).toBe('第二份')
    // 回执照留（失败不静默），只是不往回搬
    expect(said(stage)).toContain('没送出')
  })

  test('收下了（`ok: true`）不动草稿、不留回执', () => {
    const stage = createStage()
    stage.type('一句话')
    stage.press(ENTER)
    stage.type('新的')

    stage.feed([event('input.settled', { ref: 'draft-1', ok: true })])

    expect(stage.shell.getView().draft).toBe('新的')
    expect(stage.shell.getView().settled.filter((row) => row.kind === 'receipt')).toEqual([])
  })

  test('**忙时两条各带各的技能**：不共用一个可变「当前技能」', () => {
    const stage = createStage()
    const rows = [skill('pdf'), skill('debug')]

    directHit(stage, '/pdf 第一件', rows)
    directHit(stage, '/debug 第二件', rows)

    expect(submitted(stage)).toEqual([
      {
        type: 'input.submit',
        text: '第一件',
        skills: [{ name: 'pdf', path: '/ws/project/pdf' }],
        ref: 'draft-1',
      },
      {
        type: 'input.submit',
        text: '第二件',
        skills: [{ name: 'debug', path: '/ws/project/debug' }],
        ref: 'draft-2',
      },
    ])
  })

  test('两条失败各认各的：只有**最后**那一条还认得回草稿', () => {
    const stage = createStage()
    stage.type('第一条')
    stage.press(ENTER)
    stage.type('第二条')
    stage.press(ENTER)

    stage.feed([event('input.settled', { ref: 'draft-1', ok: false, reason: '第一条没成' })])

    // 第二条已经交出去了，草稿是空的——第一条那份不往回搬（`ref` 对不上就不是这一次）
    expect(stage.shell.getView().draft).toBe('')

    stage.feed([event('input.settled', { ref: 'draft-2', ok: false, reason: '第二条没成' })])
    expect(stage.shell.getView().draft).toBe('第二条')
  })

  test('停止清队的那一条（排队没轮到）照样按原 ref 还稿', () => {
    const stage = createStage()
    directHit(stage, '/pdf 排着的那条', [skill('pdf')])

    stage.feed([
      event('input.settled', { ref: 'draft-1', ok: false, reason: '停下了——这一条还没轮到' }),
    ])

    expect(stage.shell.getView().draft).toBe('排着的那条')
    expect(stage.shell.getView().bound?.ref.name).toBe('pdf')
  })
})

describe('U33 · 接管（裁决）保护整份草稿', () => {
  test('绑着技能的草稿：接管时三件一起收，答完一起还', () => {
    const stage = createStage()
    directHit(stage, '/pdf', [skill('pdf')])
    stage.type('打了一半')

    stage.feed([
      event(
        'tool.decision.request',
        { call: 71, name: 'exec', material: '命令 ls', weight: 'light' },
        { id: 88 },
      ),
    ])

    expect(stage.shell.getView().stashed).toEqual({
      draft: '打了一半',
      caret: 4,
      bound: { ref: { name: 'pdf', path: '/ws/project/pdf' }, label: '项目 .magic/skills' },
    })

    stage.feed([event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 12 })])

    expect(stage.shell.getView().draft).toBe('打了一半')
    expect(stage.shell.getView().bound?.ref.name).toBe('pdf')
  })

  test('接管期间打字不进草稿（喂给裁决作答）——不认的键当场说一句', () => {
    const stage = createStage()
    stage.type('草稿')
    stage.feed([
      event('tool.decision.request', { call: 71, name: 'exec', material: 'm', weight: 'light' }, { id: 88 }),
    ])

    stage.press({ kind: 'char', char: 'x' })

    expect(stage.shell.getView().draft).toBe('')
    expect(stage.shell.getView().flash).toContain('先答复')
  })
})

// ══ 独立验收退回的三处（真 PTY 反例 —— 逐条固化成负例回归）══════════════

describe('退回① · 候选的来源必须辨得出来（两行不能逐字相同）', () => {
  /**
   * **负例回归**：同一处两份同名（`first/` 与 `second/` 都自称 `twins`）。
   *
   * 旧行为：两行都是 `twins　项目 .magic/skills · …`——**逐字相同**，用户没有依据挑一份。
   * 来源的细分由**发现处**产出（`Skill.label`，见 `execution/src/skills.ts` 的
   * `sourceLabelOf`）；这一条钉的是「那一串到屏上真的分成两行」。
   */
  test('同档同名两份：两行的来源不同', () => {
    const stage = createStage()
    const twins = [
      skill('twins', { label: '项目 .magic/skills/first', description: '同一句简述' }),
      skill('twins', { label: '项目 .magic/skills/second', description: '同一句简述' }),
    ]

    directHit(stage, '/twins body', twins)

    const rows = pickerOf(stage).rows
    expect(rows).toHaveLength(2)
    expect(rows[0]?.meta).not.toBe(rows[1]?.meta) // 旧行为下这两串一模一样
    expect(rows[0]?.meta).toContain('first')
    expect(rows[1]?.meta).toContain('second')
  })

  /**
   * **负例回归**（独立验收二轮退回的那条「过正」）：**宽窗下名称放得下就不许截它**。
   *
   * 旧行为：名称**无条件**限在一半列宽（100 列下 47 列），于是 60 字符的名字被截，
   * 而 meta 那边还空着二十来列没用上——把设计「名称/来源在前，简述在后」的优先级
   * 倒过来了（截断该落在简述身上）。
   */
  test('**宽窗（100 列）**：名称整串都在，被截的是简述', async () => {
    const stage = createStage()
    const long = 'a'.repeat(60) // front-matter 的名字上限 64——放得下就不该截
    const note = '这份简述写得很长，长到整行装不下，宽窗下该被截断的是它'

    openSkills(stage, '/skills', [skill(long, { description: note })])

    const lines = (await stage.screen({ columns: 100, rows: 30 })).dock.map((line) => line.text)
    const row = lines.find((line) => line.includes(long.slice(0, 8)))
    expect(row).toBeDefined()
    if (row === undefined) return

    // 名称**整串**都在（旧行为下这里只剩 `a…`）
    expect(row).toContain(long)
    // 名称之后紧跟的是那个全角分隔——不是省略号
    expect(row[row.indexOf(long) + long.length]).toBe('　')
    // 来源照旧在（它也是「必留」的那一段）
    expect(row).toContain('项目 .magic/skills')
    // **截断落在简述身上**
    expect(row).not.toContain(note)
  })

  /**
   * **负例回归**：起手即窄（60 列）＋ 56 字符的技能名，来源被名字挤没了。
   *
   * 旧行为：名称优先裁至全宽 ⇒ 两行都只剩同一串截断的名字，连「项目 / 用户」都没了。
   * 新判据：**名称至多占一半**，来源永远留得下——两行的来源仍要分得开。
   */
  test('窄窗（60 列）＋ 长名字：来源仍分得开（项目 / 用户）', async () => {
    const stage = createStage()
    const long = 'a'.repeat(56)

    openSkills(stage, '/skills', [
      skill(long, { label: '项目 .magic/skills', description: `${long} 的简述` }),
      skill(long, { label: '用户 .magic/skills', description: `${long} 的简述` }),
    ])

    const lines = (await stage.screen({ columns: 60, rows: 24 })).dock.map((line) => line.text)
    const rows = lines.filter((line) => line.includes(long.slice(0, 8)))

    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('项目 .magic/skills')
    expect(rows[1]).toContain('用户 .magic/skills')
    // 仍是**每项一行**（挤掉的是简述，不是折行）
    expect(rows[0]?.length).toBeLessThanOrEqual(60)
    expect(rows[1]?.length).toBeLessThanOrEqual(60)
  })
})

describe('退回② · 选定技能不搬正文里的插入点', () => {
  /**
   * **负例回归**：`/twins abc|d` 选定之后插入点被摆到末尾。
   *
   * 旧行为：`caret: body.length` ⇒ 接着打 `Z` 得到 `abcdZ`；新判据：原位插入
   * ⇒ `abcZd`。剥掉的只是开头那一截 `/twins `，插入点跟着左移那么多。
   */
  test('剥前缀时插入点左移：`/twins abc|d` 选完接着打 ⇒ `abcZd`', () => {
    const stage = createStage()
    const twins = [
      { ...skill('twins'), path: '/ws/a/twins' },
      { ...skill('twins'), path: '/ws/b/twins' },
    ]

    stage.type('/twins abcd')
    feedCatalog(stage, twins)
    stage.press({ kind: 'left' }) // 光标到 `abc|d`
    expect(stage.shell.getView().caret).toBe(10)

    stage.press(ENTER) // 姓名分不出唯一 ⇒ 展开同名候选
    expect(pickerOf(stage).rows).toHaveLength(2)
    stage.press(ENTER) // 选定头一份

    const view = stage.shell.getView()
    expect(view.draft).toBe('abcd')
    expect(view.caret).toBe(3) // 旧行为下是 4（＝正文末尾）

    stage.type('Z')
    expect(stage.shell.getView().draft).toBe('abcZd')
  })

  test('插入点落在被剥掉的那一截里 ⇒ 落到正文开头（就近落脚）', () => {
    const stage = createStage()

    // 只打名字（其后没有正文）——那样才是「只绑定」，插入点也才停在斜杠词里面
    stage.type('/twins')
    feedCatalog(stage, [skill('twins')])
    for (let at = 0; at < 3; at += 1) stage.press({ kind: 'left' }) // `/tw|ins`
    stage.press(ENTER) // 直达：唯一 ⇒ 只绑定

    const view = stage.shell.getView()
    expect(view.draft).toBe('')
    expect(view.caret).toBe(0)
  })
})

describe('退回③ · 恢复之后那条消息仍认得出它的技能来源', () => {
  /** 一条真记录里的 `user` 条目（载荷里带着当时送出去的技能）。 */
  const sent: Entry = {
    id: 7,
    kind: 'user',
    content: { text: '把这份 PDF 处理一下' },
    payload: {
      skills: [
        {
          name: 'pdf',
          source: '/ws/.magic/skills/pdf',
          label: '项目 .magic/skills',
          text: '第一步：先数页数。',
        },
      ],
    },
    at: 0,
  }

  /**
   * **负例回归**：`rebuild` 只读条目正文，技能依据不见了。
   *
   * 旧行为：重建出来的 user 行只有那句话——设计与验收都要「恢复后来源可辨」。
   */
  test('重建的 user 行带着 `技能：名称 · 来源`（读记录里那一份）', () => {
    const view = rebuild(createView(), [sent])
    const said = logLines(view.settled, { columns: 100, expanded: false })
      .map((line) => line.segments.map((piece) => piece.text).join(''))
      .join('\n')

    expect(said).toContain('把这份 PDF 处理一下')
    expect(said).toContain('技能：pdf · 项目 .magic/skills')
    // **不冒充使用回执**：那一条说的是「模型真用上了」（当时的事），恢复时不重放
    expect(said).not.toContain('本次使用技能')
  })

  test('纯文本交代**一行都不多**（载荷缺席＝什么都不加）', () => {
    const view = rebuild(createView(), [{ id: 8, kind: 'user', content: { text: '随便聊一句' }, at: 0 }])
    const said = logLines(view.settled, { columns: 100, expanded: false })
      .map((line) => line.segments.map((piece) => piece.text).join(''))
      .join('\n')

    expect(said).not.toContain('技能：')
  })

  test('当场发的那一次**不挂**这一行（现场有草稿材料行与使用回执两处说着它）', () => {
    const stage = createStage()
    directHit(stage, '/pdf 帮我看看', [skill('pdf')])

    const echo = stage.shell.getView().rows.find((row) => row.kind === 'user')
    expect(echo?.kind === 'user' ? echo.skills : undefined).toBeUndefined()
  })
})

describe('U33 · 屏上（交互区那一块）', () => {
  test('绑着的那一行：`技能：名称 · 来源（待发送）`——紧挨输入行上方', async () => {
    const stage = createStage()
    directHit(stage, '/pdf', [skill('pdf')])

    const lines = (await dockText(stage)).split('\n')
    const boundAt = lines.findIndex((line) => line.includes('技能：pdf · 项目 .magic/skills（待发送）'))
    expect(boundAt).toBeGreaterThanOrEqual(0)
    // 输入行紧跟在它下面（原型：选择器 → 草稿材料 → 输入行）
    expect(lines[boundAt + 1]).toContain('›')
  })

  test('没绑就一行都不多（普通交代的屏与从前一样）', async () => {
    const stage = createStage()

    expect(await dockText(stage)).not.toContain('技能：')
  })

  test('候选封顶：截掉的条数在右位如实报出来', () => {
    const stage = createStage()
    const many = Array.from({ length: MAX_CANDIDATES + 3 }, (_, at) =>
      skill(`build-${String(at).padStart(2, '0')}`),
    )

    stage.type('/build')
    feedCatalog(stage, many)

    const view = stage.shell.getView()
    expect(view.completion?.candidates).toHaveLength(MAX_CANDIDATES)
    expect(view.status.hint).toContain('还有 3 条')
  })
})

/** 命令面穷尽——新加一支时这里编译不过（`Command` 是判别联合）。 */
const _probe: (command: Command) => string = (command) =>
  command.type === 'skills.list' ? '列技能目录' : command.type
void _probe
