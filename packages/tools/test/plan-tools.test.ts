/** 计划投影与历史读取；事项增量由 memory-tools 的真实记录检查覆盖。 */

import { describe, expect, test } from 'bun:test'
import type { HistoryPage, PlanNote, PlanReader, PlanSnapshot } from '@magic/contracts'
import { PLAN_TOOL_NAMES, definePlanTools } from '../src/plan-tools.ts'

const PLAN: PlanNote = {
  steps: [
    { text: '定位登录失败提示', status: 'completed' },
    { text: '覆盖四个失败分支', status: 'in_progress' },
  ],
  notes: '约束：保留已输入内容',
}

type Log = { readonly asked: unknown[] }

/** 一个记着「问了什么」的桩——判据看它（工具有没有把模型的意图原样转过去）。 */
function stubReader(
  snapshot: PlanSnapshot = { entry: 7, plan: PLAN },
  page: HistoryPage = { entries: [{ id: 3, kind: 'user', text: '帮我修登录' }] },
  log: Log = { asked: [] },
): { readonly reader: PlanReader; readonly log: Log } {
  return {
    log,
    reader: {
      readPlan: async () => snapshot,
      readHistory: async (query) => {
        log.asked.push(query)
        return page
      },
    },
  }
}

/** 取三件里的一件（按名字——与装配追加放行规则用的是同一串名字）。 */
function toolOf(reader: PlanReader, name: string) {
  const tool = definePlanTools(reader).find((one) => one.spec.name === name)
  if (tool === undefined) throw new Error(`没有 ${name} 这一件`)
  return tool
}

async function run(reader: PlanReader, name: string, args: Readonly<Record<string, unknown>> = {}) {
  const tool = toolOf(reader, name)
  try { return await tool.run(tool.prepare(args), { sandbox: undefined as never, signal: undefined, onOutput: undefined }) }
  catch (error) { return { ok: false, output: (error as Error).message } }
}

describe('两个读取工具的形态', () => {
  test('两个读取名字齐，且权限域与装配按同一串名字认它们', () => {
    const { reader } = stubReader()
    expect(definePlanTools(reader).map((tool) => tool.spec.name)).toEqual([
      'plan_read',
      'history_read',
    ])
    expect([...PLAN_TOOL_NAMES]).toEqual(['plan_read', 'history_read'])
  })

  test('读取工具的静态归类都是 light（只动协作笔记与会话记录，不碰工作区）', () => {
    const { reader } = stubReader()
    for (const tool of definePlanTools(reader)) expect(tool.spec.danger.level).toBe('light')
  })


})

describe('plan_read', () => {
  test('有笔记：回执带**完整正文**（模型据此接着干活）', async () => {
    const { reader } = stubReader()
    const result = await run(reader, 'plan_read')

    expect(result.ok).toBe(true)
    expect(result.output).toContain('定位登录失败提示')
    expect(result.output).toContain('覆盖四个失败分支')
    expect(result.output).toContain('约束：保留已输入内容')
    expect(result.output).toContain('#7')
    // **查询结果不带更新载荷**（契约：只有更新那件的成功结果能带）
    expect(result.plan).toBeUndefined()
  })

  test('没有过计划：如实说没有（不编一份空的）', async () => {
    const { reader } = stubReader({ entry: null, plan: null })
    const result = await run(reader, 'plan_read')

    expect(result.ok).toBe(true)
    expect(result.output).toContain('还没有计划笔记')
    expect(result.plan).toBeUndefined()
  })

  test('清空过：说清「已清空 ＋ 记在哪一条」，并指出过程仍可回查', async () => {
    const { reader } = stubReader({ entry: 9, plan: null })
    const result = await run(reader, 'plan_read')

    expect(result.output).toContain('已清空')
    expect(result.output).toContain('#9')
    expect(result.output).toContain('history_read')
  })
})

test('计划读取仍带目标投影', async () => {
  const { reader } = stubReader({ entry: 7, plan: { ...PLAN, goal: '修好登录失败提示' } })
  expect((await run(reader, 'plan_read')).output).toContain('目标：修好登录失败提示')
})

describe('history_read', () => {
  test('不给参数＝从活动窗口之前读起（把空查询原样交给读面）', async () => {
    const { reader, log } = stubReader()
    const result = await run(reader, 'history_read')

    expect(result.ok).toBe(true)
    expect(log.asked).toEqual([{}])
    expect(result.output).toContain('#3')
    expect(result.output).toContain('帮我修登录')
  })

  test('定位原样转过去（before / entry ＋ offset），并按返回给出继续往前的位置', async () => {
    const page: HistoryPage = { entries: [{ id: 3, kind: 'user', text: '这一条' }], nextBefore: 3 }
    const { reader, log } = stubReader({ entry: 7, plan: PLAN }, page)

    const paged = await run(reader, 'history_read', { before: 12 })
    expect(log.asked).toEqual([{ before: 12 }])
    // 继续往前的入口要写在回执里（模型据此翻页）
    expect(paged.output).toContain('before=3')

    await run(reader, 'history_read', { entry: 3, offset: 2000 })
    expect(log.asked[1]).toEqual({ entry: 3, offset: 2000 })
  })

  /**
   * **节选那一条要交出续读的两格参数**（U34 返修 · 独立验收退回的第二条）：
   * 只写「节选」而不说怎么接着读，等于把「这里还有」变成一句没法行动的话——
   * 模型手上只有半条正文，只能猜偏移量。
   */
  test('节选那一条把 `entry` 与 `offset` 原样写给模型（照着重读就是后半段）', async () => {
    const typed = stubReader(
      { entry: 7, plan: PLAN },
      { entries: [{ id: 3, kind: 'user', text: '前一段', truncated: true, nextOffset: 2000 }] },
    )
    const output = (await run(typed.reader, 'history_read')).output

    expect(output).toContain('节选')
    expect(output).toContain('entry=3')
    expect(output).toContain('offset=2000')

    // 只来了一半（标了截断却没给续读位置）：退回一句「节选」，**不编**一个偏移量出来
    const half = stubReader({ entry: 7, plan: PLAN }, {
      entries: [{ id: 3, kind: 'user', text: '前一段', truncated: true }],
    })
    const halfOutput = (await run(half.reader, 'history_read')).output
    expect(halfOutput).toContain('节选')
    expect(halfOutput).not.toContain('offset=')

    // 没截断的那一条**一句都不多**（别给模型添没用的提示）
    const whole = stubReader({ entry: 7, plan: PLAN }, {
      entries: [{ id: 4, kind: 'user', text: '完整一条' }],
    })
    expect((await run(whole.reader, 'history_read')).output).not.toContain('节选')
  })

  test('长内容那一页标「节选」；空页如实说没有', async () => {
    const typed = stubReader(
      { entry: 7, plan: PLAN },
      { entries: [{ id: 3, kind: 'user', text: '前一段', truncated: true, nextOffset: 2000 }] },
    )
    expect((await run(typed.reader, 'history_read')).output).toContain('节选')

    const empty = stubReader({ entry: 7, plan: PLAN }, { entries: [], note: '这条会话的开头就是这个位置。' }).
      reader
    const result = await run(empty, 'history_read')
    expect(result.output).toContain('这段没有可读的记录')
    expect(result.output).toContain('开头')
  })

  test('两种定位不混用 · offset 不单独用 · 记录号要正整数——各说各的一句', async () => {
    const { reader, log } = stubReader()

    const both = await run(reader, 'history_read', { before: 12, entry: 3 })
    expect(both.ok).toBe(false)
    expect(both.output).toContain('不能一起给')

    const lone = await run(reader, 'history_read', { offset: 10 })
    expect(lone.ok).toBe(false)
    expect(lone.output).toContain('只配合 entry')

    const bad = await run(reader, 'history_read', { entry: -1 })
    expect(bad.ok).toBe(false)
    expect(bad.output).toContain('正整数')

    // 错的那几次**一次都没问过读面**（参数不成立就不往下走）
    expect(log.asked).toEqual([])
  })
})
