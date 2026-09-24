/**
 * U37 · **送过的图片：查看原图 · 加入本次输入**（外壳那一半）——按键 → 视图 ＋ 命令。
 *
 * 判据全在设计 · 文件与图片 ·「图片输入与历史原图」那一条：
 * - `/attachments` **只承担已发送材料的查找与取回**（不是待发送附件列表）；
 * - 详情两条动作**各走各的**：查看原图＝一条命令（内核取字节落盘）、加入本次输入＝
 *   **本地就把引用放进输入行**（不发送、不读盘——字节来自记录里那份）；
 * - 插入位置是**打开列表前那个位置**（`/attachments` 是命令，草稿已被清空 ⇒ 句首）；
 * - 空表**不接管输入**（既有那条 P0 分寸：0 行时落一行回执、输入照常）。
 *
 * 走的是**真按键 → 外壳**那条路（与真终端同形）；「字节真的到没到模型」在
 * `packages/app/test/attachments.test.ts`（那边才有真装配与真出站请求体）。
 */

import { describe, expect, test } from 'bun:test'
import type { AttachmentRow, Command, KernelEvent } from '@magic/contracts'
import type { DraftRef } from '../src/components/inline.ts'
import { createStage } from './screen.ts'
import type { Stage } from './screen.ts'
import { event } from './events.ts'

const ENTER = { kind: 'enter' } as const
const DOWN = { kind: 'down' } as const
const ESC = { kind: 'escape' } as const

/** 一行「送过的图片」（答复里的行）——`entry` 是那条记录的 id。 */
function row(entry: number, name = '截图.png'): AttachmentRow {
  return {
    entry,
    name,
    mime: 'image/png',
    bytes: 67,
    at: 1_700_000_000_000,
    source: `/ws/${name}`,
    label: name,
    blob: `blob_${entry}`,
  }
}

/** 喂一条 `attachments.catalog`（答复）。 */
function feedAttachments(stage: Stage, rows: readonly AttachmentRow[], note?: string): void {
  stage.feed([
    event('attachments.catalog', { rows, ...(note === undefined ? {} : { note }) }),
  ] as readonly KernelEvent[])
}

/** 打一整个词（一个字符一个字符地打——走的是真按键那条路）。 */
function type(stage: Stage, text: string): void {
  for (const char of text) stage.press({ kind: 'char', char })
}

function sent(stage: Stage): readonly Command[] {
  return stage.commands()
}

function refs(stage: Stage): readonly DraftRef[] {
  return stage.shell.getView().refs
}

/** 记录区里的字（回执也在里面）——「屏上有没有这一行」看它。 */
function said(stage: Stage): string {
  return [...stage.shell.getView().settled, ...stage.shell.getView().rows]
    .filter((row) => row.kind !== 'banner')
    .map((row) => ('text' in row ? row.text : ''))
    .join('\n')
}

/** 进到某一屏：打 `/attachments` → 回车 → 喂答复。 */
function openList(stage: Stage, rows: readonly AttachmentRow[]): void {
  type(stage, '/attachments')
  stage.press(ENTER)
  feedAttachments(stage, rows)
}

describe('U37 · `/attachments` 那一屏', () => {
  test('打命令 ⇒ 问一次内核（无参：问「这条会话送过哪些图」）', () => {
    const stage = createStage()
    openList(stage, [row(1)])

    const asked = sent(stage).filter((command) => command.type === 'attachments.list')
    expect(asked).toHaveLength(1)
    // 命令把这一行整个吃掉了（交互配置型：草稿不留 `/attachments` 那几个字）
    expect(stage.shell.getView().draft).toBe('')
  })

  test('答复到了 ⇒ 开抽屉，一张一行（名字 ＋ 类型 / 大小 / 时间）', () => {
    const stage = createStage()
    openList(stage, [row(1), row(2, '另一个.png')])

    const view = stage.shell.getView()
    expect(view.dock.kind).toBe('picker')
    if (view.dock.kind !== 'picker') return
    expect(view.dock.picker.source).toBe('attachments')
    expect(view.dock.picker.rows.map((one) => one.label)).toEqual(['截图.png', '另一个.png'])
    expect(view.dock.picker.rows[0]?.meta).toContain('png')
    expect(view.dock.picker.rows[0]?.meta).toContain('67 B')
  })

  test('空表 ⇒ **不开抽屉**（输入照常），说明落在记录区一行', () => {
    const stage = createStage()
    openList(stage, [])

    const view = stage.shell.getView()
    expect(view.dock.kind).toBe('input') // 输入没被接管（P0：0 行时不开空抽屉）
    expect(said(stage)).toContain('还没送过图片')
  })
})

describe('U37 · 一张图的详情：两条动作各走各的', () => {
  test('选定一张 ⇒ 进详情（两条动作，且**都还没发生**）', () => {
    const stage = createStage()
    openList(stage, [row(7)])
    stage.press(ENTER)

    const view = stage.shell.getView()
    expect(view.dock.kind === 'picker' && view.dock.picker.source).toBe('attachment-detail')
    if (view.dock.kind !== 'picker') return
    expect(view.dock.picker.rows.map((one) => one.label)).toEqual(['查看原图', '加入本次输入'])
    // 一条命令都没多发
    expect(sent(stage).filter((one) => one.type === 'attachments.export')).toHaveLength(0)
  })

  test('「查看原图」⇒ 按**记录 id** 问内核要导出（不发送、抽屉不关）', () => {
    const stage = createStage()
    openList(stage, [row(7)])
    stage.press(ENTER)
    stage.press(ENTER) // 详情第一行＝查看原图

    const exported = sent(stage).filter((one) => one.type === 'attachments.export')
    expect(exported).toHaveLength(1)
    expect(exported[0]?.type === 'attachments.export' && exported[0].entry).toBe(7)
    // 没有发出任何交代
    expect(sent(stage).filter((one) => one.type === 'input.submit')).toHaveLength(0)
    // 抽屉还开着（结果是一条回执，关掉就看不见「导到哪儿了」）
    expect(stage.shell.getView().dock.kind).toBe('picker')
  })

  test('导出的回执落进记录区（答复带 `note` 时）', () => {
    const stage = createStage()
    openList(stage, [row(7)])
    stage.press(ENTER)
    stage.press(ENTER)
    feedAttachments(stage, [row(7)], '原图已导出 → /tmp/magic-attachments/截图-1.png')

    expect(said(stage)).toContain('原图已导出')
  })

  test('「加入本次输入」⇒ 引用落进输入行（**带 blob**、不发送、不读盘）', () => {
    const stage = createStage()
    openList(stage, [row(7)])
    stage.press(ENTER)
    stage.press(DOWN) // 第二行＝加入本次输入
    stage.press(ENTER)

    const view = stage.shell.getView()
    expect(view.dock.kind).toBe('input') // 抽屉收起（回到输入行）
    // 那一处写的是**编号**（U62）——不是文件名：名字按**内容身份**取（`row.blob`），
    // 同一张图放回来两次、或与 `@` 选进来的同一张并用，都是同一个名字
    expect(view.draft).toBe('Image#1')

    const ref = refs(stage)[0]
    expect(ref?.kind).toBe('image')
    if (ref?.kind !== 'image') return
    // **字节的把手随引用走**——这正是「源文件删了也取得回」那句的落点
    expect(ref.blob).toBe('blob_7')
    expect(ref.mime).toBe('image/png')
    expect(ref.source).toBe('/ws/截图.png')

    // 没发出去（选定一个动作 ≠ 提交这次交代）
    expect(sent(stage).filter((one) => one.type === 'input.submit')).toHaveLength(0)
  })

  test('加入之后回车 ⇒ 交出去的那一份**带 `kind: image` ＋ `blob`**（内核据此取回字节）', () => {
    const stage = createStage()
    openList(stage, [row(7)])
    stage.press(ENTER)
    stage.press(DOWN)
    stage.press(ENTER)

    // 只有引用、没有别的话 ⇒ 也发得出去（「正文或附件任一非空即可提交」）
    stage.press(ENTER)

    const sentInput = sent(stage).filter((one) => one.type === 'input.submit')
    expect(sentInput).toHaveLength(1)
    if (sentInput[0]?.type !== 'input.submit') return

    const wire = sentInput[0].refs?.[0]
    expect(wire?.kind).toBe('image')
    if (wire?.kind !== 'image') return
    expect(wire.blob).toBe('blob_7')
    expect(wire.marker).toBe('Image#1')
    expect(wire.mime).toBe('image/png')
  })

  test('加入之后可以在草稿里接着写字（引用留在原处，一个字不剥）', () => {
    const stage = createStage()
    openList(stage, [row(7)])
    stage.press(ENTER)
    stage.press(DOWN)
    stage.press(ENTER)
    type(stage, '这个报错怎么回事')

    const view = stage.shell.getView()
    expect(view.draft).toBe('Image#1这个报错怎么回事')
    expect(refs(stage)).toHaveLength(1) // 引用还在原处（没被那串字挤掉）
  })

  test('`esc` 收起详情 ⇒ 不留下任何引用（选定之前退出来什么都没发生）', () => {
    const stage = createStage()
    openList(stage, [row(7)])
    stage.press(ENTER)
    stage.press(ESC)

    expect(stage.shell.getView().dock.kind).toBe('input')
    expect(refs(stage)).toHaveLength(0)
    expect(stage.shell.getView().draft).toBe('')
  })
})
