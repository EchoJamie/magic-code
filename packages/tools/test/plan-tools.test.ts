/**
 * U34 · 计划与历史三件（工具域这一半）——`./plan-tools.ts`。
 *
 * 判据（设计 · 数据与工具契约那张表 ＋ 「参数仅校验可读取的结构与状态取值」）：
 * ① 读的回执**带完整正文**（上下文据「这条结果完整在不在窗口里」判送达，见 `@magic/conversation`）；
 * ② 更新只**核对参数并交回载荷**（`plan` 三态：有值 / `null` / 不给），**不自行写记录**；
 * ③ **不做长度、步数、语义检查**——二十字只是参数说明里的一句建议；
 * ④ 回查的参数只认那三格，两种定位不混用、错用说清。
 *
 * 本文件用**桩 `PlanReader`**（工具域不认识记录与上下文）——真装配那条路（真记录、
 * 真事件、真上下文）由 `packages/app/test/plan.test.ts` 咬。
 */

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
  return toolOf(reader, name).run(args, { sandbox: undefined as never, signal: undefined, onOutput: undefined })
}

describe('U34 · 三件的形态', () => {
  test('三个名字齐，且权限域与装配按同一串名字认它们', () => {
    const { reader } = stubReader()
    expect(definePlanTools(reader).map((tool) => tool.spec.name)).toEqual([
      'plan_read',
      'plan_update',
      'history_read',
    ])
    expect([...PLAN_TOOL_NAMES]).toEqual(['plan_read', 'plan_update', 'history_read'])
  })

  test('三件的静态归类都是 light（只动协作笔记与会话记录，不碰工作区）', () => {
    const { reader } = stubReader()
    for (const tool of definePlanTools(reader)) expect(tool.spec.danger.level).toBe('light')
  })

  test('二十字的建议**只在步骤文本的参数说明里**——不加 maxLength、不设步数上限', () => {
    const { reader } = stubReader()
    const parameters = toolOf(reader, 'plan_update').spec.parameters as {
      properties: { plan: { properties: { steps: { items: { properties: { text: { description: string; maxLength?: number } } } } } } }
    }
    const step = parameters.properties.plan.properties.steps.items.properties

    expect(step.text.description).toBe('简短说明这一步要做成什么，建议二十个字左右。')
    expect(step.text.maxLength).toBeUndefined()
  })
})

describe('U34 · plan_read', () => {
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

describe('U34 · plan_update', () => {
  test('整体替换：交回的那一份就是载荷（工具不自行写记录）', async () => {
    const { reader } = stubReader()
    const result = await run(reader, 'plan_update', { plan: PLAN })

    expect(result.ok).toBe(true)
    expect(result.plan).toEqual(PLAN)
    expect(result.output).toContain('定位登录失败提示')
  })

  test('**清空＝`null`**（与「没给这一位」分得开：没给是调用不成立）', async () => {
    const { reader } = stubReader()

    const cleared = await run(reader, 'plan_update', { plan: null })
    expect(cleared.ok).toBe(true)
    expect(cleared.plan).toBeNull()

    const missing = await run(reader, 'plan_update', {})
    expect(missing.ok).toBe(false)
    expect(missing.plan).toBeUndefined()
  })

  test('notes 缺省＝空串（可读的结构）；steps 空数组照收（**不设步数下限**）', async () => {
    const { reader } = stubReader()
    const result = await run(reader, 'plan_update', { plan: { steps: [] } })

    expect(result.ok).toBe(true)
    expect(result.plan).toEqual({ steps: [], notes: '' })
  })

  test('步骤文本再长也照收（**不做长度检查、不截断、不警告**）', async () => {
    const { reader } = stubReader()
    const long = '把登录失败提示改清楚并且覆盖空密码与网络失败两类分支'
    const result = await run(reader, 'plan_update', {
      plan: { steps: [{ text: long, status: 'pending' }], notes: '' },
    })

    expect(result.ok).toBe(true)
    expect((result.plan as PlanNote).steps[0]?.text).toBe(long)
  })

  test('错结构与错状态**整条拒绝**（不落半份计划），且说清是第几步', async () => {
    const { reader } = stubReader()

    const badStatus = await run(reader, 'plan_update', {
      plan: { steps: [{ text: '一步', status: 'doing' }], notes: '' },
    })
    expect(badStatus.ok).toBe(false)
    expect(badStatus.output).toContain('status')
    expect(badStatus.plan).toBeUndefined()

    const noText = await run(reader, 'plan_update', {
      plan: { steps: [{ status: 'pending' }, { text: '二步', status: 'pending' }], notes: '' },
    })
    expect(noText.ok).toBe(false)
    expect(noText.output).toContain('第 1 个步骤')

    const badShape = await run(reader, 'plan_update', { plan: '帮我修登录' })
    expect(badShape.ok).toBe(false)
    expect(badShape.plan).toBeUndefined()
  })
})

// ══ U90 · 目标那一格 ══════════════════════════════════════════════════

describe('U90 · 目标那一格（`goal`）', () => {
  test('参数说明**说清它是什么**（模型读得到才会填），且**不要求必填**', () => {
    const { reader } = stubReader()
    const parameters = toolOf(reader, 'plan_update').spec.parameters as {
      properties: {
        plan: {
          properties: { goal: { type: string; description: string } }
          required: readonly string[]
        }
      }
    }
    const plan = parameters.properties.plan

    // 是字符串那一格，且说明里点明了**三件**：是什么 · 给谁看 · 可选
    expect(plan.properties.goal.type).toBe('string')
    expect(plan.properties.goal.description).toContain('结果')
    expect(plan.properties.goal.description).toContain('用户会看到')
    expect(plan.properties.goal.description).toContain('不给')
    // **不在必填那一栏**——没有目标是一件合法的事（那一行不出现）
    expect(plan.required).not.toContain('goal')
  })

  test('给了目标：载荷带上它，回执**头一行**就是「目标：…」', async () => {
    const { reader } = stubReader()
    const result = await run(reader, 'plan_update', {
      plan: { goal: '修好登录失败提示', steps: [{ text: '一步', status: 'pending' }], notes: '' },
    })

    expect(result.ok).toBe(true)
    expect((result.plan as PlanNote).goal).toBe('修好登录失败提示')
    expect((result.output as string).split('\n')).toContain('目标：修好登录失败提示')
    // 次序：目标在步骤之前（与界面同一份）
    expect((result.output as string).indexOf('目标：')).toBeLessThan((result.output as string).indexOf('步骤：'))
  })

  test('⚠️ 反面：没给目标 ⇒ 载荷里**压根没有这个键**，回执里也没有那一行', async () => {
    const { reader } = stubReader()
    const result = await run(reader, 'plan_update', {
      plan: { steps: [{ text: '一步', status: 'pending' }], notes: '' },
    })

    expect(result.ok).toBe(true)
    // **判据是键在不在场**：写成 `goal: undefined` 与「没有这一格」对读侧是两件事
    expect(Object.hasOwn(result.plan as object, 'goal')).toBe(false)
    expect(result.output).not.toContain('目标：')
  })

  test('⚠️ 反面：给了空白（空格 / 空串）＝**与没给同义**（不写一个空的进来）', async () => {
    const { reader } = stubReader()

    for (const blank of ['', '   ', '\t']) {
      const result = await run(reader, 'plan_update', {
        plan: { goal: blank, steps: [{ text: '一步', status: 'pending' }], notes: '' },
      })

      expect(result.ok).toBe(true)
      expect(Object.hasOwn(result.plan as object, 'goal')).toBe(false)
      expect(result.output).not.toContain('目标：')
    }
  })

  test('给了非字符串 ⇒ **整条拒绝**（不落半份计划），且指到那一格', async () => {
    const { reader } = stubReader()
    const result = await run(reader, 'plan_update', {
      plan: { goal: 42, steps: [{ text: '一步', status: 'pending' }], notes: '' },
    })

    expect(result.ok).toBe(false)
    expect(result.output).toContain('goal')
    expect(result.plan).toBeUndefined()
  })

  test('读的回执也带目标（模型回查时看得到自己写的目标）', async () => {
    const { reader } = stubReader({ entry: 7, plan: { ...PLAN, goal: '修好登录失败提示' } })
    const result = await run(reader, 'plan_read')

    expect(result.output).toContain('目标：修好登录失败提示')
  })
})

describe('U34 · history_read', () => {
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
