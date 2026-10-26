/** 当前事项的计划投影与已有历史分页读面。 */

import { describe, expect, test } from 'bun:test'
import type { Entry, NewEntry, PlanNote, RecordId } from '@magic/contracts'
import { makeFauxRecords } from '@magic/faux'
import { planContext } from '../src/context.ts'
import {
  HISTORY_ENTRY_CHARS,
  HISTORY_PAGE_ENTRIES,
  createPlanReader,
  readHistoryOf,
  readPlanOf,
} from '../src/plan.ts'

const SESSION = 's-plan'
const AT = 1_700_000_000_000

const PLAN: PlanNote = {
  goal: '让登录失败提示说得清哪儿错了',
  steps: [
    { text: '定位登录失败提示', status: 'completed' },
    { text: '覆盖四个失败分支', status: 'in_progress' },
  ],
  notes: '约束：保留已输入内容',
}

/** 造一个记录桩 ＋ 逐条落账的小助手（id 由桩按序发）。 */
function ledger(): {
  records: ReturnType<typeof makeFauxRecords>
  add: (entry: Omit<NewEntry, 'at'>, at?: number) => RecordId
} {
  const records = makeFauxRecords()
  let clock = AT

  return {
    records,
    add(entry, at) {
      clock = at ?? clock + 1
      return records.appendEntry({ ...entry, at: clock })
    },
  }
}

// ══ ① 当前计划 ════════════════════════════════════════════════════════

function seedPlan(records: ReturnType<typeof makeFauxRecords>, entry: number) {
  const base = { evidence: 'fact' as const, status: 'active' as const, sources: [{ session: SESSION, entry }] }
  return records.memory.update({ expectedRevision: 0, changes: [
    { ...base, id: 'goal', kind: 'goal', text: PLAN.goal! },
    ...PLAN.steps.map((step, order) => ({ ...base, id: `step-${order}`, kind: 'step' as const, text: step.text, progress: step.status, order })),
    { ...base, id: 'requirement', kind: 'requirement', text: PLAN.notes },
  ] })
}

describe('当前计划只从工作记忆投影', () => {
  test('没有目标或步骤时只返回空计划，不附未返回的旁支知识', async () => {
    const { records, add } = ledger()
    const entry = add({ kind: 'user', content: { text: '调查旁支' } })
    records.memory.update({ expectedRevision: 0, changes: [{ id: 'side', kind: 'question', text: '旁支问题', evidence: 'unresolved', status: 'active', sources: [{ session: SESSION, entry }], knowledge: [{ id: 'K', revision: 1 }] }] })
    expect(await readPlanOf(records)).toEqual({ revision: 1, entry, plan: null })
  })
  test('无记忆返回空投影，既有原始计划记录不自动迁入', async () => {
    const { records, add } = ledger()
    const original = add({ kind: 'tool-result', content: { text: '原始计划记录' }, payload: { ok: true, output: { text: '原始计划记录' }, plan: PLAN } })
    expect(await readPlanOf(records)).toEqual({ revision: 0, entry: null, plan: null })
    expect(records.memory.read().revision).toBe(0)
    expect((await readHistoryOf(records, SESSION, 0, { entry: original })).entries[0]?.text).toBe('原始计划记录')
  })

  test('增量修改步骤不会覆盖目标和要求，计划读取不产生另一份状态', async () => {
    const { records, add } = ledger()
    const entry = add({ kind: 'user', content: { text: '明确目标和要求' } })
    expect(seedPlan(records, entry).ok).toBe(true)
    expect(await readPlanOf(records)).toEqual({ revision: 1, entry, plan: PLAN })
    const step = records.memory.read().items.find(item => item.id === 'step-1')!
    expect(records.memory.update({ expectedRevision: 1, changes: [{ ...step, progress: 'completed' }] }).ok).toBe(true)
    expect((await readPlanOf(records)).plan).toEqual({ ...PLAN, steps: PLAN.steps.map(item => ({ ...item, status: 'completed' })) })
    expect(records.memory.read().revision).toBe(2)
  })
})

// ══ ② 窗口边界 ════════════════════════════════════════════════════════

describe('活动窗口边界与 planContext 同一条算术', () => {
  /** 造一条压过的会话：12 条记录 ＋ 一条摘要。 */
  function compactedOnce(): ReturnType<typeof ledger> {
    const stage = ledger()
    for (let index = 0; index < 12; index += 1) {
      stage.add({ kind: 'user', content: { text: `第 ${index} 条` } })
    }
    stage.add({ kind: 'summary', content: { text: '摘要' } })
    return stage
  }

  /**
   * **对照**（对表：每个下结论的方法先在已知答案的样本上跑通）：
   * 同一批条目，一边走 `planContext`（装配那一侧的口径），一边走回查默认读的那一页——
   * 页里**不能有**窗口内的条目，且整页严格落在窗口起点之前。
   * 合不上就说明边界有两套，而那正是「摘要 ＋ 近段」最怕出的事。
   */
  test('压过的会话：回查那一页与当前窗口不重叠，且严格落在窗口之前', async () => {
    // 12 条记录 ＋ 1 条摘要：近段取到 8 时窗口之外还剩 4 条（再大就整条会话都在窗口里了）
    for (const near of [1, 3, 8]) {
      const { records } = compactedOnce()

      const all: Entry[] = []
      for await (const entry of records.readEntries(SESSION)) all.push(entry)
      const plan = planContext({ entries: all, nearEntries: near })
      const window = new Set(plan.entries.map((entry) => entry.id))
      const start = plan.entries[0]?.id

      const page = await readHistoryOf(records, SESSION, near, {})
      expect(page.entries.length).toBeGreaterThan(0)
      for (const entry of page.entries) expect(window.has(entry.id)).toBe(false)

      const lastOfPage = page.entries[page.entries.length - 1]?.id
      expect(lastOfPage).toBe((start ?? 0) - 1)
    }
  })

  /**
   * **近段为零那一支**（`nearEntries: 0` 是合法策略）：窗口里只有摘要之后的条目，
   * 于是压缩掉的那一整段都该读得回来——一直到摘要那一条（它是这段历史的尽头）。
   */
  test('近段为零：压缩掉的那一段仍读得回来（页一直铺到摘要那一条）', async () => {
    const { records } = compactedOnce()
    const page = await readHistoryOf(records, SESSION, 0, {})

    const all: Entry[] = []
    for await (const entry of records.readEntries(SESSION)) all.push(entry)
    const summary = all[all.length - 1]

    expect(page.entries.length).toBeGreaterThan(0)
    expect(page.entries[page.entries.length - 1]?.id).toBe(summary?.id)
    // 摘要之前那些条目的正文都在页里（压缩掉的那一段确实读得回来）
    expect(page.entries.some((entry) => entry.text.includes('第 11 条'))).toBe(true)
  })

  test('没压过：整条会话都在窗口里——窗口之前没有更早的记录（返回空 ＋ 说明）', async () => {
    const { records, add } = ledger()
    for (let index = 0; index < 5; index += 1) add({ kind: 'user', content: { text: `第 ${index} 条` } })

    const page = await readHistoryOf(records, SESSION, 20, {})
    expect(page.entries).toEqual([])
    expect(page.note).toContain('还没压缩过')
  })
})

// ══ ③ 回查 ════════════════════════════════════════════════════════════

/** 造一条压过的会话：`count` 条记录 ＋ 一条摘要（于是窗口之前那一堆都可回查）。 */
function compacted(count: number): ReturnType<typeof ledger> {
  const stage = ledger()
  for (let index = 0; index < count; index += 1) {
    stage.add({ kind: 'user', content: { text: `第 ${index} 条` } })
  }
  stage.add({ kind: 'summary', content: { text: '摘要' } })
  return stage
}

describe('历史回查是有界的', () => {
  test('一页至多十条，按记录序交回，并给出继续往前的 `nextBefore`', async () => {
    const { records } = compacted(30)
    const page = await readHistoryOf(records, SESSION, 0, {})

    expect(page.entries).toHaveLength(HISTORY_PAGE_ENTRIES)
    const ids = page.entries.map((entry) => entry.id)
    expect([...ids].sort((left, right) => left - right)).toEqual(ids)
    expect(page.nextBefore).toBe(ids[0])

    // 按 `nextBefore` 继续往前：**不跳过任何一条**（新一页的最后一条紧邻上一页的第一条）
    const older = await readHistoryOf(records, SESSION, 0, { before: page.nextBefore })
    const lastOfOlder = older.entries[older.entries.length - 1]?.id
    expect(lastOfOlder).toBe((page.nextBefore ?? 0) - 1)
  })

  test('到头了：页末尾给空 ＋ 一句说明（不假装还有）', async () => {
    // 3 条记录 ＋ 1 条摘要：近段为零时窗口之外就是这四条（摘要也在可读范围里）
    const { records } = compacted(3)
    const page = await readHistoryOf(records, SESSION, 0, {})
    expect(page.entries).toHaveLength(4)

    const nothing = await readHistoryOf(records, SESSION, 0, { before: page.entries[0]?.id })
    expect(nothing.entries).toEqual([])
    expect(nothing.note).toContain('开头')
  })

  test('长内容：标截断 ＋ 给 `nextOffset`，按它续读能取到后半段（并到末尾即止）', async () => {
    const long = '甲'.repeat(HISTORY_ENTRY_CHARS + 500)
    const { records, add } = ledger()
    add({ kind: 'assistant', content: { text: long } })
    add({ kind: 'summary', content: { text: '摘要' } })

    const page = await readHistoryOf(records, SESSION, 0, {})
    const first = page.entries[0]
    expect(first?.text).toHaveLength(HISTORY_ENTRY_CHARS)
    expect(first?.truncated).toBe(true)
    expect(first?.nextOffset).toBe(HISTORY_ENTRY_CHARS)

    const rest = await readHistoryOf(records, SESSION, 0, {
      entry: first?.id,
      offset: first?.nextOffset,
    })
    expect(rest.entries[0]?.text).toHaveLength(500)
    expect(rest.entries[0]?.truncated).toBeUndefined()

    // 读过了头：如实说末尾，不给一段空白让人猜
    const past = await readHistoryOf(records, SESSION, 0, { entry: first?.id, offset: long.length })
    expect(past.entries[0]?.text).toBe('')
    expect(past.note).toContain('末尾')
  })

  test('两种定位不混用、offset 不单独用——各说各的一句，不静默挑一个', async () => {
    const { records } = compacted(3)

    const both = await readHistoryOf(records, SESSION, 0, { before: 2, entry: 1 })
    expect(both.entries).toEqual([])
    expect(both.note).toContain('不能一起给')

    const lone = await readHistoryOf(records, SESSION, 0, { offset: 100 })
    expect(lone.entries).toEqual([])
    expect(lone.note).toContain('只配合 entry')
  })

  test('别条会话的记录读不到（`entry` 也只认本会话）', async () => {
    // 桩按单会话处理，但**真实现按会话分束**——这条在 app 集成用例里另有真库那条（见 `@magic/app`）
    const { records, add } = ledger()
    add({ kind: 'user', content: { text: '这一条' } })

    const page = await readHistoryOf(records, SESSION, 0, { entry: 999 })
    expect(page.entries).toEqual([])
    expect(page.note).toContain('不在这个会话里')
  })

  test('工具调用的回查取的是**调用内容**（名 ＋ 参数），不是那条空正文', async () => {
    const { records, add } = ledger()
    add({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
    })
    add({ kind: 'summary', content: { text: '摘要' } })

    const page = await readHistoryOf(records, SESSION, 0, {})
    expect(page.entries[0]?.kind).toBe('tool-call')
    expect(page.entries[0]?.text).toContain('exec')
    expect(page.entries[0]?.text).toContain('ls')
  })
})

// ══ 端口形态 ══════════════════════════════════════════════════════════

describe('PlanReader 端口', () => {
  test('两个读口都在，且都绑定本条会话（模型给不出第二个）', async () => {
    const { records, add } = ledger()
    const entry = add({ kind: 'user', content: { text: '开始吧' } })
    seedPlan(records, entry)
    add({ kind: 'summary', content: { text: '摘要' } })
    const reader = createPlanReader({ records, session: SESSION, nearEntries: 0 })

    expect((await reader.readPlan()).plan).toEqual(PLAN)
    expect((await reader.readHistory({})).entries.length).toBeGreaterThan(0)

    // 两个方法**都不收会话参数**——这是端口形态本身，不是调用方的自觉
    expect(reader.readPlan.length).toBe(0)
    expect(reader.readHistory.length).toBe(1)
  })
})
