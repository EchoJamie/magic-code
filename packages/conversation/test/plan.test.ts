/**
 * U34 · 计划笔记与历史回查（对话域那一半）——`./plan.ts`。
 *
 * 四组判据（设计 · 数据与工具契约 ＋ 保存与上下文）：
 * ① **当前计划 ＝ 最近一条成功且含 `plan` 的工具结果**：失败的不算 · 清空立即成立 ·
 *    被后来的条目推开很远也找得到（反向分页）；
 * ② **窗口边界与 `planContext` 同一条算术**（历史默认从活动窗口之前读起）——
 *    这条用**对照**钉：拿同一批条目分别走两处，边界必须是同一个 id；
 * ③ **回查有界**：每页条数与字符数两道闸 · 每条标截断与续读位置 · 分页不跳过 ·
 *    两种定位不混用 · 只认本会话；
 * ④ **上下文里的计划材料**：完整在窗口里就不重复交付；压出去了就补一份；
 *    清空之后旧计划还看得见时消歧义；没有过计划不加空材料。
 */

import { describe, expect, test } from 'bun:test'
import type { Entry, ModelMessage, NewEntry, PlanNote, RecordId, UserMessageContent } from '@magic/contracts'
import { makeFauxRecords } from '@magic/faux'
import { planContext } from '../src/context.ts'
import {
  HISTORY_ENTRY_CHARS,
  HISTORY_PAGE_ENTRIES,
  createPlanReader,
  planMaterialOf,
  readHistoryOf,
  readPlanOf,
} from '../src/plan.ts'

const SESSION = 's-plan'
const AT = 1_700_000_000_000

const PLAN: PlanNote = {
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

/** 材料那一块的正文——`ModelMessage` 是判别联合，取正文前先收窄（不 `as`）。 */
function materialText(message: ModelMessage | undefined): string {
  if (message === undefined) return ''
  if (message.role === 'assistant' || message.role === 'user' || message.role === 'system') {
    return textOfContent(message.content)
  }

  return message.output
}

/** 一条模型消息的正文（U37 起可能是**部件串**——带图那条）——只取文字那几件。 */
function textOfContent(content: UserMessageContent): string {
  return typeof content === 'string'
    ? content
    : content.map((part) => (part.type === 'text' ? part.text : '〔图片〕')).join('')
}

/** 一次成功的计划更新（工具结果 ＋ `plan` 载荷）。 */
function planResult(plan: PlanNote | null, text = '计划笔记已更新'): Omit<NewEntry, 'at'> {
  return { kind: 'tool-result', content: { text }, payload: { ok: true, output: { text }, plan } }
}

/** 一条普通工具结果（无计划字段——「与计划无关」那一路）。 */
function plainResult(text = '跑了 ls'): Omit<NewEntry, 'at'> {
  return { kind: 'tool-result', content: { text }, payload: { ok: true, output: { text } } }
}

// ══ ① 当前计划 ════════════════════════════════════════════════════════

describe('U34 · 当前计划取自记录', () => {
  test('没有过计划：`{ entry: null, plan: null }`——不隔空回一句「已清空」', async () => {
    const { records } = ledger()
    expect(await readPlanOf(records, SESSION)).toEqual({ entry: null, plan: null })
  })

  test('更新之后取回的那一条就是它（内容 ＋ 记录位置一致）', async () => {
    const { records, add } = ledger()
    add({ kind: 'user', content: { text: '开始吧' } })
    const id = add(planResult(PLAN))

    expect(await readPlanOf(records, SESSION)).toEqual({ entry: id, plan: PLAN })
  })

  test('**失败结果不算数**：`ok: false` 的结果带着计划字段也顶不掉上一份', async () => {
    const { records, add } = ledger()
    const good = add(planResult(PLAN))
    // 形状上不合法（写入侧的硬闸会拒），此处直接塞进桩——要验的是**读侧的判据**
    add({
      kind: 'tool-result',
      content: { text: '没能记下来' },
      payload: { ok: false, output: { text: '没能记下来' }, plan: null },
    })

    expect(await readPlanOf(records, SESSION)).toEqual({ entry: good, plan: PLAN })
  })

  test('**清空立即成立**：不回找更早那份计划（`entry` 是清空那一条）', async () => {
    const { records, add } = ledger()
    add(planResult(PLAN))
    const cleared = add(planResult(null, '计划笔记已清空'))

    expect(await readPlanOf(records, SESSION)).toEqual({ entry: cleared, plan: null })
  })

  test('后面的普通工具结果再多，也不算「当前计划变了」', async () => {
    const { records, add } = ledger()
    const id = add(planResult(PLAN))
    for (let index = 0; index < 30; index += 1) add(plainResult(`第 ${index} 条普通结果`))

    expect(await readPlanOf(records, SESSION)).toEqual({ entry: id, plan: PLAN })
  })

  /**
   * **反向分页**：计划条目被后来的条目推得很远（超过一页）也要找得到。
   * 页大小是 `SCAN_CHUNK`（实现级常量）——这里给足两页以上的条目。
   */
  test('计划条目被推到很远（> 一页）仍找得到——反向分页接着扫', async () => {
    const { records, add } = ledger()
    const id = add(planResult(PLAN))
    for (let index = 0; index < 600; index += 1) add(plainResult(`第 ${index} 条`))

    expect(await readPlanOf(records, SESSION)).toEqual({ entry: id, plan: PLAN })
  })

  test('载荷形状读不出的（旧版本 / 手改过的行）当作没有——不猜一份出来', async () => {
    const { records, add } = ledger()
    add({
      kind: 'tool-result',
      content: { text: '像计划但不是' },
      // 故意写坏（状态不在词表里）——要验的是**读侧收窄**
      payload: {
        ok: true,
        output: { text: '像计划但不是' },
        plan: { steps: [{ text: '一步', status: 'doing' }], notes: '' },
      } as unknown as NewEntry['payload'],
    })

    expect(await readPlanOf(records, SESSION)).toEqual({ entry: null, plan: null })
  })
})

// ══ ② 窗口边界 ════════════════════════════════════════════════════════

describe('U34 · 活动窗口边界与 planContext 同一条算术', () => {
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

describe('U34 · 历史回查是有界的', () => {
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

// ══ ④ 上下文里的计划材料 ══════════════════════════════════════════════

describe('U34 · 计划材料（压缩 / 中断之后重新交付）', () => {
  test('没有过计划：不加空材料', async () => {
    const { records, add } = ledger()
    add({ kind: 'user', content: { text: '你好' } })

    const all: Entry[] = []
    for await (const entry of records.readEntries(SESSION)) all.push(entry)
    expect(planMaterialOf({ delivered: new Set(), all })).toBeUndefined()
  })

  test('当前计划那一条**完整落在窗口里**：不再复制一份正文', async () => {
    const { records, add } = ledger()
    const id = add(planResult(PLAN))
    const all: Entry[] = []
    for await (const entry of records.readEntries(SESSION)) all.push(entry)

    const material = await planMaterialOf({ delivered: new Set<RecordId>([id]), all })
    expect(material).toBeUndefined()
  })

  test('压出窗口（或配对丢了）：追加一份**带记录位置**的助手材料，正文完整', async () => {
    const { records, add } = ledger()
    const id = add(planResult(PLAN))
    const all: Entry[] = []
    for await (const entry of records.readEntries(SESSION)) all.push(entry)

    const material = await planMaterialOf({ delivered: new Set(), all })
    expect(material?.role).toBe('assistant')
    expect(materialText(material)).toContain(`#${id}`)
    expect(materialText(material)).toContain('定位登录失败提示')
    expect(materialText(material)).toContain('覆盖四个失败分支')
    expect(materialText(material)).toContain('约束：保留已输入内容')
    // 说清它是什么——且**不是**用户的新要求（也不是系统指令）
    expect(materialText(material)).toContain('既有计划笔记')
    expect(materialText(material)).toContain('不是用户的新要求')
  })

  test('清空之后旧计划的正文还看得见：补一句「已清空」消歧义', async () => {
    const { records, add } = ledger()
    const old = add(planResult(PLAN))
    const cleared = add(planResult(null, '计划笔记已清空'))
    const all: Entry[] = []
    for await (const entry of records.readEntries(SESSION)) all.push(entry)

    const material = await planMaterialOf({
      // 清空那一条在窗口里，但更早那份计划也在（近段还没走出去）
      delivered: new Set<RecordId>([old, cleared]),
      all,
    })
    expect(materialText(material)).toContain('已清空')
  })

  test('清空那一条本身也看不见了：同样补一句（不把旧内容投影成当前清单）', async () => {
    const { records, add } = ledger()
    add(planResult(PLAN))
    add(planResult(null, '计划笔记已清空'))
    const all: Entry[] = []
    for await (const entry of records.readEntries(SESSION)) all.push(entry)

    const material = await planMaterialOf({ delivered: new Set(), all })
    expect(materialText(material)).toContain('已清空')
  })

  test('清空那一条在窗口里、也没有旧计划露在外面：不必再补一句', async () => {
    const { records, add } = ledger()
    add(planResult(PLAN))
    const cleared = add(planResult(null, '计划笔记已清空'))
    const all: Entry[] = []
    for await (const entry of records.readEntries(SESSION)) all.push(entry)

    const material = await planMaterialOf({ delivered: new Set<RecordId>([cleared]), all })
    expect(material).toBeUndefined()
  })
})

// ══ 端口形态 ══════════════════════════════════════════════════════════

describe('U34 · PlanReader 端口', () => {
  test('两个读口都在，且都绑定本条会话（模型给不出第二个）', async () => {
    const { records, add } = ledger()
    add({ kind: 'user', content: { text: '开始吧' } })
    add(planResult(PLAN))
    add({ kind: 'summary', content: { text: '摘要' } })
    const reader = createPlanReader({ records, session: SESSION, nearEntries: 0 })

    expect((await reader.readPlan()).plan).toEqual(PLAN)
    expect((await reader.readHistory({})).entries.length).toBeGreaterThan(0)

    // 两个方法**都不收会话参数**——这是端口形态本身，不是调用方的自觉
    expect(reader.readPlan.length).toBe(0)
    expect(reader.readHistory.length).toBe(1)
  })
})
