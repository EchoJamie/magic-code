import { materialTextOf } from './material.ts'
import { projectMemoryPlan } from './memory.ts'
/**
 * 计划只从当前事项投影。
 * 历史分页沿实际摘要覆盖边界读取公开材料，旧摘要仍按原记录结构兼容读取。
 */

import type {
  Entry,
  HistoryEntry,
  HistoryPage,
  HistoryQuery,
  PlanReader,
  PlanSnapshot,
  RecordId,
  RecordsService,
  SessionId,
} from '@magic/contracts'
import { DEFAULT_NEAR_ENTRIES, toolCallPayloadOf } from './context.ts'

/**
 * 历史回查定位摘要的反向扫描页大小。
 */
const SCAN_CHUNK = 256

/** 一页最多几条记录（设计定的数——回查是「看一眼」，不是把历史搬回来）。 */
export const HISTORY_PAGE_ENTRIES = 10

/** 一条记录先给多少字符（超出的部分标明截断 ＋ 续读位置）。 */
export const HISTORY_ENTRY_CHARS = 2000

/** 一页正文合计上限（字符）——条数与字符数两道闸，谁先到算谁。 */
export const HISTORY_PAGE_CHARS = 8000

/** 当前计划从同一份工作记忆投影，读取不迁移或修改记录。 */
export async function readPlanOf(records: RecordsService): Promise<PlanSnapshot> {
  const memory = records.memory.read()
  const plan = projectMemoryPlan(memory)
  const knowledge = plan === null ? [] : memory.items.filter(item => item.status === 'active').flatMap(item => item.knowledge ?? [])
  return { ...(knowledge.length ? { knowledge } : {}), revision: memory.revision,
    entry: memory.inspectedThrough ?? memory.items.flatMap(item => item.sources.map(source => source.entry)).at(-1) ?? null,
    plan }
}

// ══ 历史回查 ═════════════════════════════════════════════════════════

/**
 * 一条条目 → **给模型看的那段正文**。
 *
 * - `tool-call` 的正文是空的（调用本身在助手消息里）——回查要的是「当时调了什么」，
 *   故取**载荷**里的名与参数（设计：片段保留「调用/结果的实际内容」）；
 * - 其余条目取正文（blob 引用在这里解回文本）。
 */
async function entryTextOf(entry: Entry, records: RecordsService, session: SessionId): Promise<string> {
  if (entry.kind === 'tool-call') {
    const call = toolCallPayloadOf(entry.payload)
    if (call === undefined) return '（这次调用的参数读不出）'
    return `${call.name} ${argsLineOf(call.args)}`
  }

  return (await materialTextOf(entry, records, session)).text
}

/** 调用参数 → 一行（与压缩摘要请求里的同一写法：摘要要的是「干了什么」，不是能复现的命令）。 */
function argsLineOf(args: Readonly<Record<string, unknown>>): string {
  try {
    return JSON.stringify(args) ?? ''
  } catch {
    return '(参数无法序列化)'
  }
}

/** 一条条目 → 节选（`offset` 起，至多 `HISTORY_ENTRY_CHARS` 字符）＋ 续读位置。 */
async function historyEntryOf(
  entry: Entry,
  records: RecordsService,
  offset: number,
  session: SessionId,
): Promise<HistoryEntry> {
  const full = await entryTextOf(entry, records, session)
  const text = full.slice(offset, offset + HISTORY_ENTRY_CHARS)
  const more = offset + text.length < full.length
  const knowledge = (await materialTextOf(entry, records, session)).knowledge

  return {
    id: entry.id,
    kind: entry.kind,
    text,
    ...(knowledge.length ? { knowledge } : {}),
    ...(more ? { truncated: true as const, nextOffset: offset + text.length } : {}),
  }
}

/**
 * 当前**活动窗口**在记录里的位置——回查据此知道「打到哪儿为止」。
 *
 * 三支各对应 `planContext` 的一支（**同一个答案，只是不必把整条会话读进来**）：
 *
 * | 会话 | `planContext.entries[0]` | 这一支 |
 * | --- | --- | --- |
 * | 没压过 | 会话第一条 | `none`——整条会话都在窗口里，更早的一条没有 |
 * | 压过、留了 K 条近段 | 摘要之前第 K 条 | `before: 它`——那之前的都在窗口之外 |
 * | 压过、近段为空（`nearEntries: 0`） | 摘要之后第一条 | 那一支同上；**一条都没有**（窗口是空的）时给 `anywhere` |
 *
 * ⚠️ **「近段为空」不能漏**（`nearEntries: 0` 是合法策略）：漏了就会把下沿算成
 * 「摘要之前那一条」，于是压缩掉的历史**一条都读不回来**——而它正是回查要去的地方。
 * ⚠️ **`none` 与 `anywhere` 是两回事**，别都写成一个 `undefined`：
 * 前者是「更早的没有」，后者是「窗口里一条都没有，随你从头读」。
 */
type WindowStart =
  | { readonly mode: 'none' }
  | { readonly mode: 'anywhere' }
  | { readonly mode: 'before'; readonly id: RecordId }

async function windowStart(
  records: RecordsService,
  session: SessionId,
  nearEntries: number,
): Promise<WindowStart> {
  const memory = records.memory.read()
  if (memory.coveredThrough !== null) return { mode: 'before', id: memory.coveredThrough + 1 }
  const summary = await latestSummaryId(records, session)
  // 没压过＝整条会话都在窗口里 ⇒ 窗口之前没有更早的记录
  if (summary === undefined) return { mode: 'none' }

  if (nearEntries > 0) {
    const near = await records.readEntriesBack(session, summary, nearEntries)
    const earliest = near[0]
    if (earliest !== undefined) return { mode: 'before', id: earliest.id }
  }

  const after = await firstEntryAfter(records, session, summary)
  return after === undefined ? { mode: 'anywhere' } : { mode: 'before', id: after.id }
}

/** 摘要之后的第一条条目（近段为空时，窗口就是从它起的）。 */
async function firstEntryAfter(
  records: RecordsService,
  session: SessionId,
  id: RecordId,
): Promise<Entry | undefined> {
  for await (const entry of records.readEntries(session, { from: id + 1 })) return entry
  return undefined
}

/** 最近一条 `summary` 条目（压过几次就以最新那次为准——与 `planContext` 同一条）。 */
async function latestSummaryId(
  records: RecordsService,
  session: SessionId,
): Promise<RecordId | undefined> {
  let before: RecordId | undefined

  for (;;) {
    const page = await records.readEntriesBack(session, before, SCAN_CHUNK)
    if (page.length === 0) return undefined

    for (let index = page.length - 1; index >= 0; index -= 1) {
      const entry = page[index]
      if (entry?.kind === 'summary') return entry.id
    }

    if (page.length < SCAN_CHUNK) return undefined
    before = page[0]?.id
    if (before === undefined) return undefined
  }
}

/** 缺位置时读的那一页——`before` 之前最近的一页（到头了就是空页 ＋ 一句说明）。 */
async function readPage(
  records: RecordsService,
  session: SessionId,
  nearEntries: number,
  before: RecordId | undefined,
): Promise<HistoryPage> {
  const window = before === undefined ? await windowStart(records, session, nearEntries) : undefined
  if (window?.mode === 'none') {
    return {
      entries: [],
      note: '当前上下文之前还没有更早的记录（还没压缩过；以前发生的事都在现在的上下文里）。',
    }
  }

  const floor = before ?? (window?.mode === 'before' ? window.id : undefined)
  const page = await records.readEntriesBack(session, floor, HISTORY_PAGE_ENTRIES)
  if (page.length === 0) {
    return { entries: [], note: '再往前没有更早的记录了（这条会话的开头就是这个位置）。' }
  }

  // **从近到远收，到篇幅上限为止**（近的比远的要紧）——这样被丢下的那几条**更早**，
  // 而 `nextBefore` 给的是本页最早那一条：下一页从它往前读，**不跳过任何一条**
  // （若反过来从最早的收，丢下的就落在两页之间的缝里）。
  const picked: HistoryEntry[] = []
  let used = 0

  for (let index = page.length - 1; index >= 0; index -= 1) {
    const entry = page[index]
    if (entry === undefined) continue

    const piece = await historyEntryOf(entry, records, 0, session)
    if (picked.length > 0 && used + piece.text.length > HISTORY_PAGE_CHARS) break

    picked.push(piece)
    used += piece.text.length
  }

  picked.reverse()
  const earliest = picked[0]

  return {
    entries: picked,
    ...(earliest === undefined ? {} : { nextBefore: earliest.id }),
  }
}

/** 一条已知记录（`entry` 定位）——`offset` 用于该条长内容的续读。 */
async function readOne(
  records: RecordsService,
  session: SessionId,
  id: RecordId,
  offset: number,
): Promise<HistoryPage> {
  const found: Entry[] = []
  // 闭区间含端点（`readEntries` 的既定口径）——顺带把「这条在不在**本条会话**里」判掉
  for await (const entry of records.readEntries(session, { from: id, to: id })) found.push(entry)

  const entry = found[0]
  if (entry === undefined) {
    return { entries: [], note: `记录 #${id} 不在这个会话里（回查只看当前会话）。` }
  }

  const full = await entryTextOf(entry, records, session)
  if (offset >= full.length) {
    return {
      entries: [{ id: entry.id, kind: entry.kind, text: '' }],
      note: `记录 #${id} 已经读到末尾了（正文共 ${full.length} 字符）。`,
    }
  }

  return { entries: [await historyEntryOf(entry, records, offset, session)] }
}

/** 回查（两种定位不混用；错用**说清**而不是静默挑一个——见契约 `HistoryQuery`）。 */
export async function readHistoryOf(
  records: RecordsService,
  session: SessionId,
  nearEntries: number,
  query: HistoryQuery,
): Promise<HistoryPage> {
  if (query.before !== undefined && query.entry !== undefined) {
    return { entries: [], note: 'before（往前翻页）与 entry（看某一条）不能一起给——要哪种定位就只给哪种。' }
  }
  if (query.offset !== undefined && query.entry === undefined) {
    return { entries: [], note: 'offset 只配合 entry 用（单独给一个 offset 不知道该读哪一条）。' }
  }

  return query.entry === undefined
    ? readPage(records, session, nearEntries, query.before)
    : readOne(records, session, query.entry, query.offset ?? 0)
}

// ══ 端口落地 ═════════════════════════════════════════════════════════

/**
 * 造一对**会话绑定**的只读回调（契约 `PlanReader`）——装配按会话各造一份，交给工具域。
 *
 * `nearEntries` 要与对话域那份上下文策略**同一个数**（窗口边界照它认）：装配把
 * `ContextPolicy` 的覆盖位同时递给两处，两处因此不会各认一段（见 `./policy.ts`）。
 */
export function createPlanReader(input: {
  readonly records: RecordsService
  readonly session: SessionId
  /** 「近段」条数——缺省与上下文装配同源（`DEFAULT_NEAR_ENTRIES`）。 */
  readonly nearEntries?: number | undefined
}): PlanReader {
  const nearEntries = input.nearEntries ?? DEFAULT_NEAR_ENTRIES

  return {
    readPlan: () => readPlanOf(input.records),
    readHistory: (query) => readHistoryOf(input.records, input.session, nearEntries, query),
  }
}

