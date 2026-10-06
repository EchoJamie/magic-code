/**
 * U107 · **剪贴板取图**（外壳那一半）——按键 → 视图 ＋ 命令。
 *
 * 判据全在设计 · 文件与图片（「图片的身份与名字」那一节）与工单 U107：
 *
 * - **一条入口**：`ctrl+v` ⇒ 发一条 `input.paste`（外壳**不自己读剪贴板**，也看不见它）；
 * - **取到了** ⇒ 在**插入点**放一处 `Image#N`（编号仍由稿子那一侧按**内容身份**发
 *   ——同一张图拿同一个号，`@` 选进来的那张也一样）；
 * - **没取到** ⇒ **不产生块** ＋ **落一句回执**（这一条是**反向判据**：改之前按下去
 *   什么都不发生，屏上一个字都没有）；
 * - **分寸与文本粘贴同一套**：接管着（裁决卡）不收、抽屉开着不收。
 *
 * 走的是**真按键 → 外壳**那条路（与真终端同形）；「那一张真到了模型那一头」在
 * `packages/app/test/frames-u107-tui.ts`（那边才有真装配、真出站请求体与真屏）。
 *
 * ⚠️ 这里**不碰真剪贴板**：剪贴板那一跳归内核（`input.paste` 那一头），
 * 外壳这一半收的只是答复——用例按拍子喂进去就是。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent } from '@magic/contracts'
import type { DraftRef } from '../src/components/inline.ts'
import { createStage } from './screen.ts'
import type { Stage } from './screen.ts'
import { event } from './events.ts'

const CTRL_V = { kind: 'ctrl+v' } as const

/** 内核取回来的那一张（用例里 `blob` 就是那串内容身份）。 */
function pasted(blob: string, name = '剪贴板') {
  return { mime: 'image/png', name, bytes: 67, blob, label: name }
}

/** 喂一条 `input.pasted`——取到了那一形。 */
function feedPasted(stage: Stage, image: ReturnType<typeof pasted>): void {
  stage.feed([event('input.pasted', { image })] as readonly KernelEvent[])
}

/** 喂一条 `input.pasted`——没取到那一形（话由内核备好）。 */
function feedProblem(stage: Stage, problem: string): void {
  stage.feed([event('input.pasted', { problem })] as readonly KernelEvent[])
}

/** 草稿上的引用（视图那一份）。 */
function refs(stage: Stage): readonly DraftRef[] {
  return stage.shell.getView().refs
}

/** 屏上有没有那一行回执（记录区里那句 `·…`——与渲染同形：正文不带那一点，渲染层加）。 */
function receiptOf(stage: Stage, text: string): boolean {
  return stage.shell.getView().settled.some((row) => row.kind === 'receipt' && row.text === text)
}

/** 问过几次剪贴板（命令面上的那一支）。 */
function asks(stage: Stage): number {
  return stage.commands().filter((one) => one.type === 'input.paste').length
}

describe('U107 · 剪贴板取图', () => {
  test('`ctrl+v` ⇒ 发一条 `input.paste`（外壳不自己读剪贴板）', () => {
    const stage = createStage()

    stage.press(CTRL_V)

    expect(asks(stage)).toBe(1)
    // **外壳这一侧不留东西**：草稿没变、一行回执都没落——那一张还没回来
    expect(stage.shell.getView().draft).toBe('')
    expect(stage.shell.getView().refs).toEqual([])
    expect(stage.shell.getView().settled.filter((row) => row.kind === 'receipt')).toEqual([])
  })

  test('取到了 ⇒ 在插入点放一处 `Image#N`，引用带着那份内容身份', () => {
    const stage = createStage()

    stage.press(CTRL_V)
    feedPasted(stage, pasted('B1'))

    expect(stage.shell.getView().draft).toBe('Image#1')
    expect(refs(stage)).toEqual([
      {
        start: 0,
        end: 7,
        kind: 'image',
        marker: 'Image#1',
        // 剪贴板来的那一张**没有落位**：身份那一格写的是出处（内核给的 `label`）
        source: '剪贴板',
        label: '剪贴板',
        name: '剪贴板',
        mime: 'image/png',
        blob: 'B1',
      },
    ])
  })

  test('**位置是插入点**，不是句尾——光标停在句中时贴，那一处就落在句中', () => {
    const stage = createStage()

    stage.type('看看这里')
    stage.press({ kind: 'left' })
    stage.press({ kind: 'left' })
    stage.press(CTRL_V)
    feedPasted(stage, pasted('B1'))

    // 「看看|这里」⇒ 那一处落在插入点上，**不是整句的尾巴上**
    expect(stage.shell.getView().draft).toBe('看看Image#1这里')
  })

  test('**同一张图同一个号**：贴两次 ⇒ 都是 `Image#1`（身份是内容，不是贴了几次）', () => {
    const stage = createStage()

    stage.press(CTRL_V)
    feedPasted(stage, pasted('B1'))
    stage.press(CTRL_V)
    feedPasted(stage, pasted('B1'))

    expect(stage.shell.getView().draft).toBe('Image#1Image#1')
    expect(refs(stage).map((ref) => ref.marker)).toEqual(['Image#1', 'Image#1'])
  })

  test('**两张不同的图两个号**（同内容才同号）', () => {
    const stage = createStage()

    stage.press(CTRL_V)
    feedPasted(stage, pasted('B1'))
    stage.press(CTRL_V)
    feedPasted(stage, pasted('B2'))

    expect(stage.shell.getView().draft).toBe('Image#1Image#2')
  })

  test('**反向判据**：剪贴板空 / 只有文本 ⇒ 不产生块，且**落一句回执**', () => {
    const stage = createStage()

    stage.type('先打两个字')
    stage.press(CTRL_V)
    feedProblem(stage, '剪贴板是空的——先复制一张图，再按一次。')

    // ① **块一个都没有**：草稿原样、引用表空着
    expect(stage.shell.getView().draft).toBe('先打两个字')
    expect(stage.shell.getView().refs).toEqual([])
    // ② **话必须说**：用户按的就是「把图取进来」，取不到**就是这件事的结果**
    expect(receiptOf(stage, '剪贴板是空的——先复制一张图，再按一次。')).toBe(true)
  })

  test('只有文本那一档，回执说的是那一件真事（不是笼统的「没有图」）', () => {
    const stage = createStage()

    stage.press(CTRL_V)
    feedProblem(stage, '剪贴板里没有图（只有文字或文件那一类）——复制一张图，或直接用 @ 引用一个图片文件。')

    expect(stage.shell.getView().draft).toBe('')
    expect(stage.shell.getView().refs).toEqual([])
    expect(
      receiptOf(stage, '剪贴板里没有图（只有文字或文件那一类）——复制一张图，或直接用 @ 引用一个图片文件。'),
    ).toBe(true)
  })

  test('**接管着（裁决卡）不收**：按下去只说一句话，不发命令、不动草稿', () => {
    const stage = createStage({ inputReady: true })
    // 一张待答的裁决卡（带材料与轻重）——它一挂上，输入区就归它
    stage.feed([
      event('tool.decision.request', { call: 71, name: 'exec', material: 'ls -la', weight: 'light' }, { id: 88 }),
    ] as readonly KernelEvent[])
    expect(stage.shell.getView().dock.kind).toBe('decision')

    stage.press(CTRL_V)

    expect(asks(stage)).toBe(0)
    // 接管期间那一句走的是**那一刻回执**（`flash`，裁决卡上那一行），与文本粘贴同一处置
    expect(stage.shell.getView().flash).toBe('先答复——此刻贴不了图（这一轮在等你）。答完接着贴。')
  })

  test('**抽屉开着不收**（`@` 那一栏开着时，取图不能从旁路插一刀）', () => {
    const stage = createStage()

    stage.type('看 @')
    stage.press({ kind: 'char', char: 'a' })
    expect(stage.shell.getView().dock.kind).toBe('picker')

    stage.press(CTRL_V)

    expect(asks(stage)).toBe(0)
    expect(stage.shell.getView().draft).toBe('看 @a')
  })

  test('**答复回来时抽屉才打开**（按下去之后那一栏才开）⇒ 也不插，且明说', () => {
    const stage = createStage()

    stage.press(CTRL_V)
    // 答复还在路上，用户先把 `@` 那一栏打开了
    stage.type('看 @')
    stage.press({ kind: 'char', char: 'a' })
    expect(stage.shell.getView().dock.kind).toBe('picker')

    feedPasted(stage, pasted('B1'))

    // ① 草稿**没有被插脏**——那一栏记的查询区间因此不会偏
    expect(stage.shell.getView().draft).toBe('看 @a')
    expect(stage.shell.getView().refs).toEqual([])
    // ② **明说**（图取到了、只是没收），不静默
    expect(
      receiptOf(stage, '剪贴板里那一张取到了，但这一栏开着没收——收起之后再按一次 ctrl+v。'),
    ).toBe(true)
  })
})
