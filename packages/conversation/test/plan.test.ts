/** 独立计划与原始历史分页读面。 */

import { describe, expect, test } from 'bun:test'
import type { NewEntry, PlanNote, RecordId } from '@magic/contracts'
import { makeFauxRecords } from '@magic/faux'
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

function seedPlan(records: ReturnType<typeof makeFauxRecords>, _entry: number) {
  return records.appendEntry({ kind: 'tool-result', content: { text: '已保存计划' }, payload: { ok: true, output: { text: '已保存计划' }, plan: PLAN }, at: AT })
}

describe('独立计划与覆盖边界', () => {
  test('只认最新真实plan结果；清空步骤保留其他计划字段', async () => {
    const { records, add } = ledger()
    expect(await readPlanOf(records, SESSION)).toEqual({ entry: null, plan: null })
    const first = seedPlan(records, 0)
    expect(await readPlanOf(records, SESSION)).toEqual({ entry: first, plan: PLAN })
    add({ kind: 'assistant', content: { text: '普通笔记不改计划' } })
    expect(await readPlanOf(records, SESSION)).toEqual({ entry: first, plan: PLAN })
    add({ kind: 'tool-result', content: { text: '失败结果不能保存计划' }, payload: { ok: false, output: { text: '' }, plan: null } })
    expect(await readPlanOf(records, SESSION)).toEqual({ entry: first, plan: PLAN })
    const last = add({ kind: 'tool-result', content: { text: '清步骤' }, payload: { ok: true, output: { text: '' }, plan: { ...PLAN, steps: [] } } })
    expect(await readPlanOf(records, SESSION)).toEqual({ entry: last, plan: { ...PLAN, steps: [] } })
  })
  test('默认历史页落在已提交覆盖上界之内', async () => {
    const { records, add } = ledger()
    const ids = Array.from({ length: 12 }, (_, index) => add({ kind: 'user', content: { text: `第${index}条` } }))
    records.coverage.publish({ previousSummary: null, from: ids[0]!, through: ids[7]!, at: AT, notesSaved: true })
    expect((await readHistoryOf(records, SESSION, {})).entries.map(entry => entry.id)).toEqual(ids.slice(0, 8))
  })
})

// ══ ③ 回查 ════════════════════════════════════════════════════════════

/** 造一条压过的会话：`count` 条记录 ＋ 一条摘要（于是窗口之前那一堆都可回查）。 */
function compacted(count: number): ReturnType<typeof ledger> {
  const stage = ledger()
  for (let index = 0; index < count; index += 1) {
    stage.add({ kind: 'user', content: { text: `第 ${index} 条` } })
  }
  stage.records.coverage.publish({ previousSummary: null, from: 1, through: count, at: AT, notesSaved: true })
  return stage
}

describe('历史回查是有界的', () => {
  test('一页至多十条，按记录序交回，并给出继续往前的 `nextBefore`', async () => {
    const { records } = compacted(30)
    const page = await readHistoryOf(records, SESSION, {})

    expect(page.entries).toHaveLength(HISTORY_PAGE_ENTRIES)
    const ids = page.entries.map((entry) => entry.id)
    expect([...ids].sort((left, right) => left - right)).toEqual(ids)
    expect(page.nextBefore).toBe(ids[0])

    // 按 `nextBefore` 继续往前：**不跳过任何一条**（新一页的最后一条紧邻上一页的第一条）
    const older = await readHistoryOf(records, SESSION, { before: page.nextBefore })
    const lastOfOlder = older.entries[older.entries.length - 1]?.id
    expect(lastOfOlder).toBe((page.nextBefore ?? 0) - 1)
  })

  test('到头了：页末尾给空 ＋ 一句说明（不假装还有）', async () => {
    // 只回查已提交覆盖内的三条原文。
    const { records } = compacted(3)
    const page = await readHistoryOf(records, SESSION, {})
    expect(page.entries).toHaveLength(3)

    const nothing = await readHistoryOf(records, SESSION, { before: page.entries[0]?.id })
    expect(nothing.entries).toEqual([])
    expect(nothing.note).toContain('开头')
  })

  test('长内容：标截断 ＋ 给 `nextOffset`，按它续读能取到后半段（并到末尾即止）', async () => {
    const long = '甲'.repeat(HISTORY_ENTRY_CHARS + 500)
    const { records, add } = ledger()
    add({ kind: 'assistant', content: { text: long } })
    records.coverage.publish({ previousSummary: null, from: 1, through: 1, at: AT, notesSaved: true })

    const page = await readHistoryOf(records, SESSION, {})
    const first = page.entries[0]
    expect(first?.text).toHaveLength(HISTORY_ENTRY_CHARS)
    expect(first?.truncated).toBe(true)
    expect(first?.nextOffset).toBe(HISTORY_ENTRY_CHARS)

    const rest = await readHistoryOf(records, SESSION, {
      entry: first?.id,
      offset: first?.nextOffset,
    })
    expect(rest.entries[0]?.text).toHaveLength(500)
    expect(rest.entries[0]?.truncated).toBeUndefined()

    // 读过了头：如实说末尾，不给一段空白让人猜
    const past = await readHistoryOf(records, SESSION, { entry: first?.id, offset: long.length })
    expect(past.entries[0]?.text).toBe('')
    expect(past.note).toContain('末尾')
  })

  test('两种定位不混用、offset 不单独用——各说各的一句，不静默挑一个', async () => {
    const { records } = compacted(3)

    const both = await readHistoryOf(records, SESSION, { before: 2, entry: 1 })
    expect(both.entries).toEqual([])
    expect(both.note).toContain('不能一起给')

    const lone = await readHistoryOf(records, SESSION, { offset: 100 })
    expect(lone.entries).toEqual([])
    expect(lone.note).toContain('只配合 entry')
  })

  test('别条会话的记录读不到（`entry` 也只认本会话）', async () => {
    // 桩按单会话处理，但**真实现按会话分束**——这条在 app 集成用例里另有真库那条（见 `@magic/app`）
    const { records, add } = ledger()
    add({ kind: 'user', content: { text: '这一条' } })

    const page = await readHistoryOf(records, SESSION, { entry: 999 })
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
    records.coverage.publish({ previousSummary: null, from: 1, through: 1, at: AT, notesSaved: true })

    const page = await readHistoryOf(records, SESSION, {})
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
    records.coverage.publish({ previousSummary: null, from: 1, through: 1, at: AT, notesSaved: true })
    const reader = createPlanReader({ records, session: SESSION })

    expect((await reader.readPlan()).plan).toEqual(PLAN)
    expect((await reader.readHistory({})).entries.length).toBeGreaterThan(0)

    // 两个方法**都不收会话参数**——这是端口形态本身，不是调用方的自觉
    expect(reader.readPlan.length).toBe(0)
    expect(reader.readHistory.length).toBe(1)
  })
})
