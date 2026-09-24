/**
 * U33 · **两条新事件在屏上的落点**（第一轮 · 穷尽性连带）。
 *
 * 本轮**不做选择界面**（`/<skill-name>` 与 `/skills` 归第二轮）——这里只钉两件：
 * 内核报回来的事实，外壳**接得住、说得出**：
 * - `skill.used` —— 主文确实进了上下文之后那一次回执；
 * - `input.settled` —— 提交的收场：**只有「没跑」那一格出声**（收下了的由轮次自己说）。
 *
 * 为什么必须钉：`reduce` 的 `default` 是 `assertNever`（事件的判别联合是穷尽的）——
 * 新 kind 落到那儿是**编译期**就报的；这两条用例钉的是**收下之后写对了哪一行**。
 */

import { describe, expect, test } from 'bun:test'
import type { EventDataOf } from '@magic/contracts'
import { logLines } from '../src/components/log.ts'
import { createStage } from './screen.ts'
import { event } from './events.ts'

/** 记录区进了什么（**不含启动字标**——那是装帧，不是「进的」）。 */
function rowsOf(stage: ReturnType<typeof createStage>): readonly string[] {
  return [...stage.shell.getView().settled, ...stage.shell.getView().rows]
    .filter((row) => row.kind !== 'banner')
    .map((row) => ('text' in row ? row.text : ''))
}

describe('U33 · 技能使用回执', () => {
  /**
   * **回执只报名字**（U58 · 2026-09-25 收）：来源那一截的由头是「同名并存时把两份分开」，
   * 同名只留一条之后它没有信息量了（设计 · 技能调用：「本次使用技能：名称」）。
   * 当时用的是哪一份仍在**记录**里（载荷带着来源与正文）——那是依据，不是这一行要说的。
   */
  test('`skill.used` ⇒ 一行「本次使用技能：名称」（不带来源）', () => {
    const stage = createStage()

    stage.feed([
      event('skill.used', {
        skills: [
          { name: 'pdf', source: '/ws/.magic/skills/pdf', label: '项目 .magic/skills' },
        ],
      }),
    ])

    const said = rowsOf(stage).join('\n')
    expect(said).toContain('本次使用技能：pdf')
    expect(said).not.toContain('来源')
  })

  test('一次用了两件——一行里都报出来', () => {
    const stage = createStage()

    stage.feed([
      event('skill.used', {
        skills: [
          { name: 'alpha', source: '/ws/.magic/skills/alpha', label: '项目 .magic/skills' },
          { name: 'beta', source: '/home/me/.magic/skills/beta', label: '用户 .magic/skills' },
        ],
      }),
    ])

    expect(rowsOf(stage).join('\n')).toContain('本次使用技能：alpha · beta')
  })
})

describe('U33 · 提交的收场', () => {
  test('**没跑**那一格出声：说清为什么（哪一份来源出的问题）', () => {
    const stage = createStage()

    stage.feed([
      event('input.settled', {
        ref: 'draft-1',
        ok: false,
        reason: '技能「doomed」在 /ws/.magic/skills/doomed 上不再成立——那一处现在叫「other」',
      }),
    ])

    const said = rowsOf(stage).join('\n')
    expect(said).toContain('没送出')
    expect(said).toContain('doomed')
  })

  test('**收下了**那一格不出声（同一件事轮次自己会说，再补一句就是噪声）', () => {
    const stage = createStage()

    stage.feed([event('input.settled', { ref: 'draft-1', ok: true })])

    expect(rowsOf(stage)).toEqual([])
  })

  test('没给缘由也不留半句（照实说「未说缘由」，不编）', () => {
    const stage = createStage()

    stage.feed([event('input.settled', { ok: false })])

    expect(rowsOf(stage).join('\n')).toContain('未说缘由')
  })
})

describe('U33 · `skill` 那一行怎么报', () => {
  test('回的是**一整份文档**——报**行数**（末行是文档的最后一句话，与「读到什么」无关）', () => {
    const stage = createStage()

    // 调用与结果**按配对键成对**（`call` ＝ 那条 `tool.call` 事件的 id——两个 id 空间之一）
    const call = event('tool.call', { name: 'skill', args: { name: 'pdf' } })
    stage.feed([
      call,
      event('tool.result', {
        call: call.id,
        ok: true,
        output: { text: '〔技能主文：pdf（来源 /ws/.magic/skills/pdf · v1-8）〕\n第一步：先数页数。' },
      }),
    ])

    const lines = logLines(stage.shell.getView().rows, { columns: 100, expanded: false })
    const said = lines.flatMap((line) => line.segments.map((piece) => piece.text)).join('\n')

    expect(said).toContain('2 行')
    // 末行那句话**不占这一格**（它说的是文档的最后一句，不是「读到了什么」）
    expect(said).not.toContain('第一步：先数页数')
  })
})

/** 事件载荷的类型探针——两条新 kind 的 `data` 形态与契约一致（改形时此处先红）。 */
const _probe: [EventDataOf['skill.used'], EventDataOf['input.settled']] = [
  { skills: [] },
  { ok: true },
]
void _probe
