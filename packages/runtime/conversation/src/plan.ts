import { materialTextOf } from './material.ts'
/**
 * 计划从真实 plan_update 工具结果读取。
 * 历史分页沿已提交覆盖边界读取原始材料。
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
import { toolCallPayloadOf } from './context.ts'

/**
 * 历史回查定位摘要的反向扫描页大小。
 */
const SCAN_CHUNK = 256

/** 一页最多几条记录（设计定的数——回查是「看一眼」，不是把历史搬回来）。 */
export const HISTORY_PAGE_ENTRIES = 10

/** 一条记录先给多少字符（超出的部分标明截断 ＋ 续读位置）。 */
export const HISTORY_ENTRY_CHARS = 2000

/** 一页正文合计上限（字符）——条数与字符数两道闸，谁先到算谁。 */
const HISTORY_PAGE_CHARS = 8000

/** 当前计划独立保存，读取不迁移或修改记录。 */
export function readPlanOf(records: RecordsService, session: SessionId): PlanSnapshot {
  let before: number | undefined
  for (;;) {
    const entries = records.readEntriesBack(session, before, SCAN_CHUNK)
    for (const entry of entries.toReversed()) {
      if (entry.kind === 'tool-result' && entry.payload !== undefined && 'plan' in entry.payload && entry.payload.ok && entry.payload.plan !== undefined) {
        return { entry: entry.id, plan: entry.payload.plan }
      }
    }
    if (entries.length < SCAN_CHUNK) return { entry: null, plan: null }
    before = entries[0]!.id
  }
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

/** 缺位置时读的那一页——`before` 之前最近的一页（到头了就是空页 ＋ 一句说明）。 */
async function readPage(
  records: RecordsService,
  session: SessionId,
  before: RecordId | undefined,
): Promise<HistoryPage> {
  const covered = records.coverage.read().coveredThrough
  if (before === undefined && covered === null) return { entries: [], note: '当前上下文之前还没有更早的记录（还没压缩过）。' }
  const floor = before ?? covered! + 1
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
  query: HistoryQuery,
): Promise<HistoryPage> {
  if (query.before !== undefined && query.entry !== undefined) {
    return { entries: [], note: 'before（往前翻页）与 entry（看某一条）不能一起给——要哪种定位就只给哪种。' }
  }
  if (query.offset !== undefined && query.entry === undefined) {
    return { entries: [], note: 'offset 只配合 entry 用（单独给一个 offset 不知道该读哪一条）。' }
  }

  return query.entry === undefined
    ? readPage(records, session, query.before)
    : readOne(records, session, query.entry, query.offset ?? 0)
}

// ══ 端口落地 ═════════════════════════════════════════════════════════

/** 会话绑定的独立计划与有界历史读取。 */
export function createPlanReader(input: {
  readonly records: RecordsService
  readonly session: SessionId
}): PlanReader {

  return {
    readPlan: async () => readPlanOf(input.records, input.session),
    readHistory: (query) => readHistoryOf(input.records, input.session, query),
  }
}

