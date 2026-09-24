/**
 * U33 · **终端入口**（第二轮）——`/<技能名>` 直达、`/skills` 浏览与选择、
 * 随交代一次提交、失败按原 ref 保稿。
 *
 * ⚠️ **2026-09-22（U36）改过形，几处断言随设计改了锚**（见各条的「原锚 / 为何变 / 新锚」）：
 * 引用**留在正文原位**（`/pdf` 不再被剥掉、也不再挂一条独立的「当前技能」），
 * 故凡「选定之后草稿里剩什么」「提交出去的那一份长什么样」的断言都换了新锚。
 * 位置编辑本身的判据（左右越过、退格整处、原位替换）在 `spec.u36.test.ts`。
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
import type { DraftRef } from '../src/components/inline.ts'
import { createShell } from '../src/shell.ts'
import { logLines } from '../src/components/log.ts'
import { MAX_CANDIDATES, createView, rebuild } from '../src/view.ts'
import { createStage } from './screen.ts'
import type { Stage } from './screen.ts'
import { event } from './events.ts'

const ENTER = { kind: 'enter' } as const
const ESC = { kind: 'escape' } as const

/**
 * 草稿上一处引用的**名字**（技能与图片各有各的 `name`，文件 / 目录没有）——
 * U37 起 `DraftRef` 是判别联合，`name` 只在那两支上（见其类型注）。
 */
function nameOf(ref: DraftRef | undefined): string | undefined {
  return ref !== undefined && (ref.kind === 'skill' || ref.kind === 'image') ? ref.name : undefined
}

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
    // 候选每项一行：**名称 ＋ 简述**——2026-09-25 起不再印来源那一格（见下一条）
    expect(picker.rows.map((row) => row.label)).toEqual(['pdf', 'debug'])
    expect(picker.rows[0]?.meta).toBe('pdf 的简述')
    expect(picker.rows.every((row) => row.oneLine === true)).toBe(true)
  })

  /**
   * **来源那一格收掉了**（U58 · 2026-09-25 用户定）：它印在行上的由头是「同名并存时把两份
   * 分开」，而**同名只留一条**（判定在上游的发现层）之后，它成了没有信息量的额外显示
   * ——设计 · 技能调用：「来源优先级是**内部规则**，不在界面上呈现」。
   *
   * 记录里仍保留当时用的是哪一份（那是依据，不是显示）；读取失败的话与 `magic --check`
   * 也照旧指明来源。
   */
  test('`/skills` 每项一行：**名称 ＋ 简述**（不带来源）；选定＝在原处留下那一份的身份', () => {
    const stage = createStage()

    openSkills(stage, '/skills', [skill('pdf'), skill('debug', { description: '看日志' })])

    const rows = pickerOf(stage).rows
    expect(rows.map((row) => row.meta)).toEqual(['pdf 的简述', '看日志'])
    expect(rows.map((row) => row.current)).toEqual([false, false])

    // 选定第二条：草稿里留下的是**这一条**的身份（真路径）
    stage.press({ kind: 'down' })
    stage.press(ENTER)
    expect(stage.shell.getView().refs).toEqual([
      { start: 0, end: 6, kind: 'skill', marker: '/debug', name: 'debug', source: '/ws/project/debug' },
    ])
    // 选定之后抽屉收起（选定即离开列表，回去看草稿）
    expect(stage.shell.getView().draft).toBe('/debug')
    expect(stage.shell.getView().dock.kind).toBe('input')
  })

  /**
   * 选定＝**只把那处引用放进草稿**：正文一字不动、一条命令都不发（不发送、不加载主文）。
   *
   * ⚠️ **驱动换了一条路**（U58）：原锚走的是「同名 ⇒ 展开那一屏、在那一屏上选定」，
   * 同名不再并存 ⇒ 那一屏不存在了。真会话里「选定一处引用」现在只有两条路：`/skills`
   * 选一份（锚点在打开列表前那一格），以及**候选栏上 `Tab`**（绑在词的原处）——
   * 「原位」那一形只有后者，故这里走它。
   */
  test('选定＝**在词的原处放一句引用**：正文留着、一条命令都不发（不发送、不加载主文）', () => {
    const stage = createStage()
    stage.type('/pdf')
    feedCatalog(stage, [skill('pdf')])
    const before = stage.commands().length

    stage.press({ kind: 'tab' }) // 候选栏上选定那一条

    const view = stage.shell.getView()
    // **原锚**：选定后正文是「剥掉斜杠词」的 `先打半句`、插入点 4、绑定挂在 `view.bound` 上；
    // **为何变**（U36）：`/pdf` 不再被抽走——它就留在句首那一格，身份随它一起记；
    // **新锚**：正文一字不动、引用区间覆盖 `/pdf` 那四个字，插入点落在它之后。
    expect(view.refs).toEqual([
      { start: 0, end: 4, kind: 'skill', marker: '/pdf', name: 'pdf', source: '/ws/project/pdf' },
    ])
    expect(view.draft).toBe('/pdf')
    expect(view.caret).toBe(4) // 用户原来那一格（词尾）——不搬去别处
    expect(stage.commands()).toHaveLength(before) // 一条命令都不发（「零模型请求」的根就在这儿）
  })

  /**
   * `esc` 取消＝不留痕迹：抽屉收起、草稿一个字不动、**没留下半处引用**。
   *
   * ⚠️ **驱动改了**（U58）：原锚靠「同名展开」那一屏才做得出「抽屉开着而草稿里有正文」
   * （`/skills` 自己是个斜杠命令，打它之前草稿先被清掉），而那一屏不存在了。
   * 这里咬的还是那两件：**取消不写草稿**、**不留引用**。
   */
  test('`esc` 取消＝不留痕迹，草稿一个字不动', () => {
    const stage = createStage()
    openSkills(stage, '/skills', [skill('pdf'), skill('debug')])
    expect(pickerOf(stage).rows).toHaveLength(2)

    stage.press(ESC)

    expect(stage.shell.getView().dock.kind).toBe('input')
    expect(stage.shell.getView().draft).toBe('') // 一个字都没进去
    expect(stage.shell.getView().refs).toEqual([]) // 也没留下半处引用
  })

  test('**不再有「移除当前技能」那一行**：摘它就退格（在引用那一处）', () => {
    const stage = createStage()
    openSkills(stage, '/skills', [skill('pdf')]) // 草稿是空的（命令吃掉那一行）——抽屉开得起来
    const rows = pickerOf(stage).rows

    // **原锚**：抽屉最后一行是「移除当前技能」（`@remove`），选定即摘掉全局绑定；
    // **为何变**（U36）：引用长在正文里，摘掉它就是在那一处按退格——抽屉里再放一行全局的，
    // 既说不出「摘的是哪一处」，又与正文那一处形成两个入口；**新锚**：抽屉只剩技能本身。
    expect(rows.map((row) => row.label)).toEqual(['pdf'])

    // 选定（放进草稿）——摘掉它用的就是**那一处**的退格，不是抽屉里的某一行
    stage.press(ENTER)
    expect(stage.shell.getView().draft).toBe('/pdf')

    stage.press({ kind: 'backspace' }) // 插入点正停在 `/pdf` 的尾巴上

    expect(stage.shell.getView().draft).toBe('')
    expect(stage.shell.getView().refs).toEqual([])
  })

  test('**移除只动那一处**：退格摘掉引用，草稿里别的话一个字不动', () => {
    const stage = createStage()
    directHit(stage, '/pdf', [skill('pdf')]) // 只打名字 ⇒ 只放进草稿
    stage.type(' 帮我看看')
    // 插入点挪到引用尾巴上（`←` 越过引用时是整段跨的，故从末尾按到那一格）
    for (let at = 0; at < 5; at += 1) stage.press({ kind: 'left' })
    expect(stage.shell.getView().caret).toBe(4)
    stage.press({ kind: 'backspace' }) // 插入点停在引用之后 ⇒ 整处摘掉

    // 材料摘掉了；后面那句交代一个字不动（插入点仍在原位）
    expect(stage.shell.getView().refs).toEqual([])
    expect(stage.shell.getView().draft.trim()).toBe('帮我看看')

    stage.press(ESC) // 再按一下才是「清草稿」那条老规矩
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

    // **新锚**（原锚：`view.bound` 有值、草稿被剥成空串）：引用留在句首那一格，
    // 草稿还是那四个字——「只打名字＝只把它放进草稿」这条语义没变，变的是它落在哪儿。
    expect(stage.shell.getView().refs).toEqual([
      { start: 0, end: 4, kind: 'skill', marker: '/pdf', name: 'pdf', source: '/ws/project/pdf' },
    ])
    expect(stage.shell.getView().draft).toBe('/pdf')
    expect(submitted(stage)).toEqual([]) // 一个 `input.submit` 都没发
  })

  test('`/名字 交代` 一次提交：名称留在原位，技能随它走', () => {
    const stage = createStage()
    directHit(stage, '/pdf 帮我看看', [skill('pdf')])

    // **原锚**（`text: '帮我看看'` ＋ `skills: […]`）：名称被剥成独立参数；
    // **为何变**（U36）：引用**留在交代的位置**——`/pdf` 是用户那句话的一部分（前面的话
    // 可能正指着它），故随正文一起走，身份与位置在 `refs` 里；**新锚**见下。
    expect(stage.commands().at(-1)).toEqual({
      type: 'input.submit',
      text: '/pdf 帮我看看',
      refs: [{ kind: 'skill', at: 0, marker: '/pdf', name: 'pdf', source: '/ws/project/pdf' }],
      ref: 'draft-1',
    })
    // 草稿清空、无残留引用、本地回显的是**交代本身**（原样，一字不剥）
    expect(stage.shell.getView().draft).toBe('')
    expect(stage.shell.getView().refs).toEqual([])
    expect(stage.shell.getView().rows.at(-1)).toMatchObject({ kind: 'user', text: '/pdf 帮我看看' })
  })

  /**
   * ⚠️ 样词随 U44 换成 `/clear`：拿一条**已撤掉**的命令当样词，下面那句「没有多出命令」
   * 会**恒真**（认不得的词本来就不会变成命令）——判据当场空转。换成真切存在的那一条才咬得人。
   */
  test('**斜杠之后那一整段不再解析成控制命令**（`/clear` 字样与换行都在正文里）', () => {
    const stage = createStage()
    stage.type('/pdf')
    feedCatalog(stage, [skill('pdf')])
    stage.type(' 看 /clear 那段')
    stage.press({ kind: 'newline' })
    stage.type('还有第二行')
    stage.press(ENTER)

    expect(stage.commands().at(-1)).toMatchObject({
      type: 'input.submit',
      // 内部换行原样留着（多行交代不当场压成一行）；`/pdf` 也在（U36：名称不再剥掉）
      text: '/pdf 看 /clear 那段\n还有第二行',
      refs: [{ kind: 'skill', at: 0, marker: '/pdf', name: 'pdf', source: '/ws/project/pdf' }],
    })
    // 没有多出一条 `session.new`（正文里的 `/clear` 只是正文——它不在句首那个词的位置上）
    expect(stage.commands().some((one) => one.type === 'session.new')).toBe(false)
  })

  /**
   * **同名同档分不出唯一**那一档整条撤了（U58 · 2026-09-25）——原判据是「展开同名候选，
   * 不静默挑一个」。新规矩是**同名在发现那一层就只剩一条**：`/名字 交代` 一次提交，
   * 带走的就是留下那一份的身份（**次序即优先级**：项目 ＞ 用户、`.magic` ＞ `.agents`）。
   *
   * 发现层那一半（谁赢、怎么保证确定）在 `packages/execution/test/skills.test.ts`
   * 与 `packages/app/test/skills.test.ts`；这里钉的是**外壳这一跳**：
   * 拿到唯一那一份 ⇒ 绑上它的身份，一步发出去。
   */
  test('`/名字 交代` 一次提交：绑的是**发现留下的那一份**（同名不再并存）', () => {
    const stage = createStage()
    const rows = [
      skill('pdf', { label: '项目 .magic/skills', path: '/ws/a/.magic/skills/pdf' }),
      skill('pdf', { label: '用户 .magic/skills', path: '/ws/b/.magic/skills/pdf' }),
    ]

    directHit(stage, '/pdf 帮我看看', rows)

    const sent = submitted(stage)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.type === 'input.submit' ? sent[0].refs?.[0]?.source : undefined).toBe(
      '/ws/a/.magic/skills/pdf',
    )
    expect(said(stage)).not.toContain('不认得的命令')
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
    expect(view.draft).toBe('/pdf 帮我看看') // 交代保住了（原样，含那一处引用）
    expect(view.caret).toBe(9)
    expect(nameOf(view.refs[0])).toBe('pdf') // 引用与它的身份也一起回来
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
        text: '/pdf 第一件',
        refs: [{ kind: 'skill', at: 0, marker: '/pdf', name: 'pdf', source: '/ws/project/pdf' }],
        ref: 'draft-1',
      },
      {
        type: 'input.submit',
        text: '/debug 第二件',
        refs: [{ kind: 'skill', at: 0, marker: '/debug', name: 'debug', source: '/ws/project/debug' }],
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

    expect(stage.shell.getView().draft).toBe('/pdf 排着的那条')
    expect(nameOf(stage.shell.getView().refs[0])).toBe('pdf')
  })
})

describe('U33 · 接管（裁决）保护整份草稿', () => {
  test('绑着技能的草稿：接管时三件一起收，答完一起还', () => {
    const stage = createStage()
    directHit(stage, '/pdf', [skill('pdf')])
    stage.type(' 打了一半')

    stage.feed([
      event(
        'tool.decision.request',
        { call: 71, name: 'exec', material: '命令 ls', weight: 'light' },
        { id: 88 },
      ),
    ])

    // 三件一起收：正文 · 插入点 · 它里面的引用（U36——引用是那份草稿的一部分）
    expect(stage.shell.getView().stashed).toEqual({
      draft: '/pdf 打了一半',
      caret: 9,
      refs: [
        { start: 0, end: 4, kind: 'skill', marker: '/pdf', name: 'pdf', source: '/ws/project/pdf' },
      ],
    })

    stage.feed([event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 12 })])

    expect(stage.shell.getView().draft).toBe('/pdf 打了一半')
    expect(nameOf(stage.shell.getView().refs[0])).toBe('pdf')
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

/**
 * 退回①那一组原判「候选的**来源**必须辨得出来（两行不能逐字相同）」——同名的两份各占一条、
 * 各带来源。**整组随「同名只留一条」作废**（U58 · 2026-09-25）：同名不再并存，也就没有
 * 「两行逐字相同」这回事；来源那一格从界面上收掉了（设计 · 技能调用）。
 *
 * 这一组里真正还活着的那条判据是**额度的分法**（独立验收二轮退回的那条「过正」）：
 * 放得下就一个字都不截；放不下**先保住名称**、截断落在简述身上。下面就留这一条。
 */
describe('额度分法 · 名称在先，截断落在简述身上', () => {
  /**
   * **负例回归**（独立验收二轮退回的那条「过正」）：**宽窗下名称放得下就不许截它**。
   *
   * 旧行为：名称**无条件**限在一半列宽（100 列下 47 列），于是 60 字符的名字被截，
   * 而 meta 那边还空着二十来列没用上——把设计「名称在前、简述在后」的优先级倒过来了
   * （截断该落在简述身上）。
   */
  test('**宽窗（100 列）**：名称整串都在，被截的是简述', async () => {
    const stage = createStage()
    const long = 'a'.repeat(60) // front-matter 的名字上限 64——放得下就不该截
    // 简述长到与名字一起装不进整行——放不下时就该轮到它被截
    const note = '这份简述写得很长，长到与名字一起装不下整行，宽窗下该被截断的是它而不是名字'

    openSkills(stage, '/skills', [skill(long, { description: note })])

    const lines = (await stage.screen({ columns: 100, rows: 30 })).dock.map((line) => line.text)
    const row = lines.find((line) => line.includes(long.slice(0, 8)))
    expect(row).toBeDefined()
    if (row === undefined) return

    // 名称**整串**都在（旧行为下这里只剩 `a…`）
    expect(row).toContain(long)
    // 名称之后紧跟的是那个全角分隔——不是省略号
    expect(row[row.indexOf(long) + long.length]).toBe('　')
    // **截断落在简述身上**
    expect(row).not.toContain(note)
    // 来源那一格一个字都不在（U58 收掉的）
    expect(row).not.toContain('.magic/skills')
  })

  /**
   * **窄窗（60 列）＋ 56 字符的名字**：放不下时**名称先吃满整行**，截断落在简述身上。
   *
   * ⚠️ **判据换了**（U58）：原判「名称至多占一半、来源永远留得下」——那一半是给**来源**
   * 扣的额度，来源收掉之后这一扣就没有由头了（设计 · 技能调用：「别把名称无条件限死一半；
   * 窄窗先保住名称、再截断简述」）。现在名称拿到的是整行，简述被挤掉。
   */
  test('窄窗（60 列）＋ 长名字：**名称先吃满**，简述被挤掉（不再给它划一半）', async () => {
    const stage = createStage()
    const long = 'a'.repeat(56)

    openSkills(stage, '/skills', [skill(long, { description: `${long} 的简述` })])

    const lines = (await stage.screen({ columns: 60, rows: 24 })).dock.map((line) => line.text)
    const row = lines.find((line) => line.includes(long.slice(0, 8)))
    expect(row).toBeDefined()
    if (row === undefined) return

    // 仍是**每项一行**（挤掉的是简述，不是折行）
    expect(row.length).toBeLessThanOrEqual(60)
    // 名称拿到的额度比旧行为**多出一大截**（旧行为下它被来源挤到只剩一半）
    expect(row).toContain('a'.repeat(45))
    // 简述**一个字都不留**——它才是被截的那一段
    expect(row).not.toContain('的简述')
    // **整行只有一个省略号**（名称尾巴上那个）：简述那边的额度只剩一位时不给它留字
    // ——孤零零一个「…」不说明任何事（`partsOf` 那一处的分寸）
    expect(row.split('…')).toHaveLength(2)
  })
})

// ══ U57 那一手里**还活着**的一件：已经绑好的引用，回车＝提交 ══════════════

/**
 * U57（D32）那一手做了三件：候选栏同名各占一条 · 那一屏停在挑中的那一份上 ·
 * **回车又走一遍「同名 ⇒ 展开候选」时不再把已经绑好的引用吃掉**。
 *
 * **前两件随本单退回**（U58 · 2026-09-25 用户定）：同名在**发现那一层**就只剩一条，
 * 「分不出唯一 ⇒ 展开候选」这件事整个不存在了——那一屏、那两条候选、`startAt`
 * 一并收掉（见 `view.ts` 的 `skillCommands`、`shell.ts` 的 `submit`）。
 *
 * **第三件不是「同名」那一路的附属品**：它守的是一条独立的不变量——
 * 词上已经贴着一处**绑好的引用**（来源用户已经指明过），回车就该是提交，
 * 不该再问一遍。故它被**提到不依赖同名的那一层**（`submit` 里那道闸），
 * 下面这一条钉的就是它。
 */
describe('U57 · 已经绑好的引用：回车＝提交（D32 第 4 步留下的那条不变量）', () => {
  /**
   * 旧行为（D32 现场）：挑定之后那一处**已经是引用**，回车却又走一遍「展开候选」，
   * **又弹回同一屏**、一条请求都没发——用户以为发出去了，在等一个不会来的回复。
   *
   * 这一条钉的是**结果**（一步发出去、身份就是绑好的那一处、没多出第二处）。
   * ⚠️ 它对**那道闸**并不敏感：`putRef` 本来就把落在同一个区间上的旧引用换掉，
   * 故「绑好的那一处不许被吃掉」在 `one` 那一支里**本来也成立**；
   * 那道闸单独能被咬住的是下一条（名字查不到的那一形）。
   */
  test('**绑好引用的词，回车＝提交**：一步发出去，不再弹回选择器', () => {
    const stage = createStage()
    stage.type('/twins')
    feedCatalog(stage, [skill('twins', { path: '/ws/.magic/skills/twins' })])

    stage.press({ kind: 'tab' }) // 候选栏上选定 ⇒ 词上贴了一处绑好的引用
    expect(stage.shell.getView().refs).toHaveLength(1)

    stage.type(' 帮我看看')
    expect(submitted(stage)).toEqual([]) // 选定不等于发送

    stage.press(ENTER) // 这一下就是提交

    expect(stage.shell.getView().dock.kind).toBe('input') // 没弹出任何选择器
    // 交出去的那一份带着**那一处已经绑好的身份**，且**只有这一处**
    expect(submitted(stage)).toEqual([
      {
        type: 'input.submit',
        text: '/twins 帮我看看',
        refs: [
          { kind: 'skill', at: 0, marker: '/twins', name: 'twins', source: '/ws/.magic/skills/twins' },
        ],
        ref: 'draft-1',
      },
    ])
  })

  /**
   * **名字在目录里已经查不到了，那一处绑好的引用照旧交出去**——这是那道闸**单独**管着的一形
   * （拿掉它，这一条当场转红）。
   *
   * 判据：词上贴着一处已绑好的引用时，**不拿目录去重判它是不是技能**——用户已经指明过来源，
   * 该不该收、收得住收不住是内核那一头按身份宣布的事（设计：「显式选定后绑定该来源，
   * 失效不换同名项」；失败回执也说得出是谁）。这里要的是**把它交出去**，
   * 而不是掉进「不认得的命令」——那等于把用户选过的一处引用当成一句打错的命令。
   */
  test('目录里查不到这个名字了：已绑好的那一处**照旧交出去**（不当成「不认得的命令」）', () => {
    const stage = createStage()
    stage.type('/twins')
    feedCatalog(stage, [skill('twins', { path: '/ws/.magic/skills/twins' })])
    stage.press({ kind: 'tab' }) // 先绑好
    stage.type(' 帮我看看')

    // 目录刷新：这份技能在磁盘上被改名 / 挪走了——名字查不到了
    feedCatalog(stage, [skill('other', { path: '/ws/.magic/skills/other' })])
    stage.press(ENTER)

    expect(submitted(stage)).toHaveLength(1)
    expect(said(stage)).not.toContain('不认得的命令')
  })

  /**
   * **掐掉头空白之后锚点仍在那个词上**：草稿以空格开头时，绑定的引用不该吃掉正文第一格
   * （锚点按掐掉的头几格换算；写死 0 会切错一格）。
   *
   * U57 时这一条走的是「同名 ⇒ 展开那一屏 → 选定」；同名不再并存，改由**直达那一支**钉
   * ——`head` 那段换算在 `one` 那一支里照旧是活的。
   */
  test('草稿以空格开头：绑定的引用仍落在那个词上（切不掉正文第一格）', () => {
    const stage = createStage()
    stage.type(' /twins 帮我看看')
    feedCatalog(stage, [skill('twins', { path: '/ws/.magic/skills/twins' })])
    stage.press(ENTER)

    expect(submitted(stage)).toEqual([
      {
        type: 'input.submit',
        text: '/twins 帮我看看', // 掐掉的那个空格不进正文
        refs: [
          { kind: 'skill', at: 0, marker: '/twins', name: 'twins', source: '/ws/.magic/skills/twins' },
        ],
        ref: 'draft-1',
      },
    ])
  })
})

describe('退回② · 选定不搬正文里的插入点（U36 改形：不再剥前缀）', () => {
  /**
   * **负例回归**：把插入点摆到词里——「选定之后接着打，字得跟在我原来那一格」。
   *
   * **原锚**：`/twins abc|d` 选定之后正文变成 `abcd`、插入点 3（因为开头那截被剥掉了）；
   * **为何变**（U36）：不再剥——`/twins` 留在原位，故插入点是**用户原来那一格**；
   * **新锚**：选定（候选栏上 `Tab`）之后，插入点仍是 `abc|d` 那一格，接着打 `Z`
   * 得到 `abcZd`（而不是被摆到末尾的 `abcdZ`）。
   *
   * ⚠️ **驱动换了**（U58）：原锚走「回车 ⇒ 展开同名候选 ⇒ 选定」，同名不再并存 ⇒
   * 那一屏没了。「选定一处引用」现在只剩候选栏上 `Tab` 与 `/skills` 两条路，这里走前者。
   */
  test('插入点仍是用户原来那一格：`/twins abc|d` 选完接着打 ⇒ `abcZd`', () => {
    const stage = createStage()

    stage.type('/twins abcd')
    feedCatalog(stage, [skill('twins')])
    stage.press({ kind: 'left' }) // 光标到 `abc|d`
    expect(stage.shell.getView().caret).toBe(10)

    stage.press({ kind: 'tab' }) // 候选栏上选定那一条

    const view = stage.shell.getView()
    expect(view.draft).toBe('/twins abcd') // 一字不剥
    expect(view.caret).toBe(10) // 仍是 `abc|d`（被替换的那一段长度没变）

    stage.type('Z')
    expect(stage.shell.getView().draft).toBe('/twins abcZd')
  })

  test('插入点落在被替换的那一段里 ⇒ 落在引用之后（就近落脚，不搬去别处）', () => {
    const stage = createStage()

    // 只打名字（其后没有正文）——插入点停在斜杠词里面
    stage.type('/twins')
    feedCatalog(stage, [skill('twins')])
    for (let at = 0; at < 3; at += 1) stage.press({ kind: 'left' }) // `/tw|ins`
    stage.press(ENTER) // 直达：唯一 ⇒ 只把它放进草稿

    const view = stage.shell.getView()
    expect(view.draft).toBe('/twins')
    expect(view.caret).toBe(6) // 引用之后（那一格已经不在原位了，就近落脚）
    expect(view.refs[0]?.start).toBe(0)
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

  test('当场发的那一次**不挂**这一行（引用就写在回显的那句话里，恢复那一行是给旧记录的）', () => {
    const stage = createStage()
    directHit(stage, '/pdf 帮我看看', [skill('pdf')])

    const echo = stage.shell.getView().rows.find((row) => row.kind === 'user')
    expect(echo?.kind === 'user' ? echo.skills : undefined).toBeUndefined()
  })
})

describe('U33 · 屏上（交互区那一块）', () => {
  test('引用就写在输入行里：`› /pdf`（不再另起一行「待发送」）', async () => {
    const stage = createStage()
    directHit(stage, '/pdf', [skill('pdf')])

    // **原锚**：输入行上方另起一行 `技能：pdf · 项目 .magic/skills（待发送）`；
    // **为何变**（U36）：同一件事只在一处说——引用就在那句交代里（`› /pdf`），
    // 旁边再列一行既是重复，删了正文那处材料还留着（暗带）；**新锚**：那一行不存在，
    // 材料在输入行里看得见。
    const lines = (await dockText(stage)).split('\n')
    expect(lines.some((line) => line.includes('（待发送）'))).toBe(false)
    expect(lines.some((line) => line.includes('›') && line.includes('/pdf'))).toBe(true)
  })

  test('没有引用就一行都不多（普通交代的屏与从前一样）', async () => {
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
  command.type === 'skills.list'
    ? '列技能目录'
    : command.type === 'paths.list'
      ? `列路径候选：${command.query}`
      : command.type
void _probe
