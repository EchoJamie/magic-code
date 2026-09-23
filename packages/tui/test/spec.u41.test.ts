/**
 * U41 · **供应商与模型管理的终端交互**——`/model` 那一条线在外壳这一侧的判据。
 *
 * 出处：[[设计/模型与上下文]]·「用户如何接入、选择与管理」＋ [[设计/终端交互]]·「共用入口与状态」。
 *
 * ## 这个文件判什么（以及什么都不判）
 *
 * 判的是**按键 → 视图 ＋ 命令**（外壳那一半）：开抽屉发的是不是读面命令、选定之后抽屉关不关、
 * `esc` 到底动没动东西、窄窗下一条候选占几行。**不判**的事情同样写死在这儿——
 * 真终端上那几屏（列表长什么样、出站报文对不对、凭据有没有溜进记录）归**同名装置**
 * `packages/app/scripts/frames-provider-models.ts`（真 PTY ＋ 真 HTTP 夹具），
 * 夹具自己的行为归 `packages/app/test/frames-provider-models.test.ts`（尺子先自证）。
 *
 * ## 这几条为什么现在就要写
 *
 * 内核线交付「接口发现 / 缓存 / 管理控制入口」之后，`/model` 那一段要**换血**：
 * 列表的取材从「配置条目」换成「供应商信息缓存」。换血最容易碰坏的不是新功能，
 * 是**已经成立的那几条分寸**——取消不留痕迹、选定不等于发送、换模型不动用户默认。
 * 故先把它们钉住（**换血之后它们一条都不许改**），新形制的判据另加在下半段。
 *
 * 2026-09-23 记：内核契约尚未落地（工单写「内核第一笔先交可复用公共契约」），
 * 故此刻钉的是**基线**；契约到了之后本文件继续长（那时补接入 / 刷新 / 维护 / 默认那几组）。
 */

import { describe, expect, test } from 'bun:test'
import type { ModelCatalogRow } from '@magic/contracts'
import type { Command } from '@magic/contracts'
import { HINT_PICKER } from '../src/view.ts'
import { createStage } from './screen.ts'
import type { Stage } from './screen.ts'
import type { Dock } from '../src/view.ts'
import { event } from './events.ts'

/** 一条长得**在 46 列下会被截**的模型名——窄窗那两条判据靠它把「截断」与「折行」分开。 */
const LONG_MODEL = 'MiniMax-Text-01-with-a-very-long-suffix'
/** 被截掉的那一截（只在名字的**后半段**出现）——它上屏＝折行了，没上屏＝截断了。 */
const LONG_TAIL = 'long-suffix'

/** 一条条目（旧形：一个条目 ＝ 连接 ＋ 它的默认模型）。 */
function entry(provider: string, model: string): ModelCatalogRow {
  return { provider, model }
}

/** 打开 `/model` 那一屏：打字 → 回车 → 喂答复（真会话里答复是内核给的，用例里得有人代发）。 */
function open(stage: Stage, rows: readonly ModelCatalogRow[], current?: ModelCatalogRow): void {
  stage.type('/model')
  stage.press({ kind: 'enter' })
  stage.feed([
    event('model.catalog', {
      entries: rows,
      ...(current === undefined ? {} : { current: { provider: current.provider, model: current.model } }),
    }),
  ])
}

/**
 * 发往内核的命令里**与模型这一摊有关的**那些。
 *
 * ⚠️ 为什么要滤一道：打 `/` 那一下外壳会顺手问一次**技能目录**（`askSkills`——输入行候选要它），
 * 于是命令流里总夹着一条 `skills.list`。它与本文件判的事无关，滤掉它判据才说得清
 * （不滤的话每条断言都要拖一个无关的尾巴，改天那条路一变就集体红）。
 */
const sent = (stage: Stage): readonly Command[] =>
  stage.commands().filter((one) => one.type === 'model.list' || one.type === 'model.switch')

/** 此刻那一屏开着的是哪个抽屉（没开＝`undefined`）——**取一次**再收窄（分两次取不算收窄）。 */
function pickerOf(stage: Stage): Extract<Dock, { kind: 'picker' }>['picker'] | undefined {
  const dock = stage.shell.getView().dock

  return dock.kind === 'picker' ? dock.picker : undefined
}

describe('① 开抽屉走的是**读面**命令', () => {
  test('不带参数的 `/model` 发 `model.list`——不是空参的 `model.switch`', () => {
    // 由头（D10 · 第 3 样）：拿「换失败了」的缘由当列表说明不是读面，还会白落一笔
    // `model.switched`。读面命令只读、不落库、不改任何东西。
    const stage = createStage()

    stage.type('/model')
    stage.press({ kind: 'enter' })

    expect(sent(stage)).toEqual([{ type: 'model.list' }])
  })

  test('答复到了才开抽屉（没答复之前一个候选都没有）', () => {
    const stage = createStage()

    stage.type('/model')
    stage.press({ kind: 'enter' })

    expect(stage.shell.getView().dock.kind).toBe('input')
  })

  test('答复一到就开，且**正在用的那条**被选中、右位换成选择器键位', () => {
    const stage = createStage()
    // 「正在用」的取材是**真跑过的那一格**（`view.status.model` ← `model.call.start`）——
    // 不是答复里那个 `current`。故先把「正在用」造出来，再开列表。
    stage.feed([event('model.call.start', { provider: 'backup', model: 'deepseek-chat' })])
    open(stage, [entry('personal', 'MiniMax-M3'), entry('backup', 'deepseek-chat')])

    const view = stage.shell.getView()
    const picker = pickerOf(stage)

    expect(picker?.source).toBe('model')
    expect(picker?.rows.map((row) => row.value)).toEqual(['personal', 'backup'])
    expect(picker?.rows[1]?.current).toBe(true)
    expect(picker?.selected).toBe(1) // 落在当前那条上（开列表不用手挪）
    expect(view.status.hint).toBe(HINT_PICKER)
  })

  test('**没调用过时谁都不是「正在用」**——不许拿列表首项冒充当前', () => {
    // 由头（设计 · 「没有保存默认时，不把列表首项/最新项偷偷设为默认」那一条的同族）：
    // 一次都还没跑过时，屏上没有任何一条是「此刻在用的」。把第 0 行标成当前＝编一个事实。
    const stage = createStage()
    open(stage, [entry('personal', 'MiniMax-M3'), entry('backup', 'deepseek-chat')])

    const picker = pickerOf(stage)

    expect(picker?.rows.some((row) => row.current)).toBe(false)
  })
})

describe('② 候选**每项一行**（设计 · 终端交互）', () => {
  test('模型行挂着 `oneLine`——截断交给渲染层按列宽做，高度账照旧一条一行', () => {
    // 由头：没这一位的话，长模型名在窄窗里由 Ink 折行 ⇒ 交互区高度账少算一行
    // ⇒ 矮终端上真光标错位（U31 那一族的账）。设计与规格都写死了「候选每项一行」。
    const stage = createStage()
    open(stage, [entry('personal', LONG_MODEL)])

    const picker = pickerOf(stage)
    expect(picker?.rows.every((row) => row.oneLine === true)).toBe(true)
  })

  test('窄窗（46 列）下**截断**：名字被裁、后面那截不上屏，行不折', async () => {
    const stage = createStage()
    open(stage, [entry('personal', LONG_MODEL)])

    const frame = await stage.screen({ columns: 46, rows: 24 })

    expect(frame.has(LONG_TAIL)).toBe(false)
    expect(frame.has('…')).toBe(true)
    expect(frame.has('personal')).toBe(true) // 名称那半截先保住
  })

  test('**反例**：宽窗（100 列）下一个字都不截——上面那条不许把「截」变成无条件', async () => {
    // 对表·C 组：「修 A 要交 B 的反例」——窄窗那条修法最容易的过头是**宽窗也去截**
    // （二轮退回过的正是这一形）。故同一份行，宽窗下必须原样全出。
    const stage = createStage()
    open(stage, [entry('personal', LONG_MODEL)])

    const frame = await stage.screen({ columns: 100, rows: 30 })

    expect(frame.has(LONG_MODEL)).toBe(true)
  })
})

describe('③ 选定＝换模型，**不是发送**', () => {
  test('回车发一条换模型命令、把抽屉收起；草稿一个字都不往模型那儿发', () => {
    const stage = createStage()
    open(stage, [entry('personal', 'MiniMax-M3'), entry('backup', 'deepseek-chat')])

    stage.press({ kind: 'down' }) // 挪到 backup
    stage.press({ kind: 'enter' })

    const commands = sent(stage)
    expect(commands.filter((one) => one.type === 'model.switch')).toHaveLength(1)
    expect(commands.some((one) => one.type === 'input.submit')).toBe(false)
    expect(stage.shell.getView().dock.kind).toBe('input')
  })

  test('回执由内核那一条 `model.switched` 给——外壳**不先报**成功', () => {
    const stage = createStage()
    open(stage, [entry('personal', 'MiniMax-M3')])
    stage.press({ kind: 'enter' })

    const before = stage.shell.getView().settled.length
    stage.feed([event('model.switched', { ok: true, provider: 'personal', model: 'MiniMax-M3' })])

    expect(stage.shell.getView().settled.length).toBe(before + 1)
    expect(stage.shell.getView().status.model).toBe('MiniMax-M3')
  })
})

describe('④ 取消**不留痕迹**、不动任何东西', () => {
  test('`esc` 收起抽屉：没有回执、没有换模型命令、右位回常态', () => {
    const stage = createStage()
    const before = sent(stage).length
    open(stage, [entry('personal', 'MiniMax-M3')])

    stage.press({ kind: 'escape' })

    const after = sent(stage)
    expect(after.slice(before)).toEqual([{ type: 'model.list' }]) // 只有那次读面——没有别的
    expect(stage.shell.getView().dock.kind).toBe('input')
    expect(stage.shell.getView().settled.some((row) => row.kind === 'receipt')).toBe(false)
  })

  test('取消之后模型还是原来那条（没换过）', () => {
    const stage = createStage()
    open(stage, [entry('personal', 'MiniMax-M3'), entry('backup', 'deepseek-chat')])
    stage.press({ kind: 'down' })
    stage.press({ kind: 'escape' })

    expect(stage.shell.getView().status.model).toBeNull() // 没调用过＝没有选中的事实
  })
})

describe('⑤ 换模型**不动用户默认**（两件事分开）', () => {
  test('选定不发任何「保存默认」那一类的命令', () => {
    // 设计（模型与上下文 · 4）：选模型只改当前 Agent；保存默认是**另一次明确动作**。
    // 故这一条判的是「**没有多余的写盘**」——发出去的命令里只有那次读面与这次切换。
    const stage = createStage()
    open(stage, [entry('personal', 'MiniMax-M3')])
    stage.press({ kind: 'enter' })

    expect(sent(stage).map((one) => one.type)).toEqual(['model.list', 'model.switch'])
  })
})
