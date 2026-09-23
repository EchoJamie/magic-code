/**
 * 计划笔记与历史回查 —— **同会话的轻量记忆**（U34）。
 *
 * 两件事一处：它们共用同一份记录、同一条「从后往前找就停」的读法，且都**绑定当前会话**
 * （模型给不出第二个会话）。本文件是 `PlanReader` 端口在对话域的落地——
 * 工具域拿到的只是一对只读回调（见契约 `PlanReader`）。
 *
 * ## 当前计划 ＝ **最近一条成功且含 `plan` 的工具结果**
 *
 * 没有第二本账：谁是最新由记录本身说了算（追加式条目流，后写的赢）。四件由此自动成立：
 * - **更新**——新写一条，它自然成为当前；
 * - **清空**——写一条 `plan: null`（**遇到清空立即成立**，不继续往前找旧计划）；
 * - **中断在落账之后、通报之前**——重开也读得回来（内容在条目里，不在事件里）；
 * - **落账前失败**——上一条照旧当道（旧内容还在，没有被覆盖）。
 *
 * ⚠️ **要 `ok: true`**（设计原话：「最近一个**成功**且含 `plan` 字段的工具结果」）：
 * 失败结果不该把上一份可读笔记顶掉——更新失败保留旧正文。
 *
 * ## 活动窗口边界
 *
 * 历史回查「缺位置时从当前上下文之前的最近记录读起」，而**窗口在哪儿**是上下文那件事：
 * 压过的会话＝摘要 ＋ 近段（`planContext` 的算术），没压过＝整条会话都在窗口里。
 * 故本文件**照 `planContext` 的同一条算术**认边界（不另立一套窗口定义——
 * 两处各算一遍，迟早各认一段）。
 */

import type {
  Entry,
  HistoryEntry,
  HistoryPage,
  HistoryQuery,
  ModelMessage,
  PlanNote,
  PlanReader,
  PlanSnapshot,
  RecordId,
  RecordsService,
  SessionId,
} from '@magic/contracts'
import { DEFAULT_NEAR_ENTRIES, rawTextOf, toolCallPayloadOf } from './context.ts'

/**
 * 反向扫描的页大小——「最近一条含计划的结果」通常就在末尾几条，两页之内就到；
 * 长会话里它可能被后来的工具往返推得很远，故按页续扫（见 `latestPlanEntry`）。
 */
const SCAN_CHUNK = 256

/** 一页最多几条记录（设计定的数——回查是「看一眼」，不是把历史搬回来）。 */
export const HISTORY_PAGE_ENTRIES = 10

/** 一条记录先给多少字符（超出的部分标明截断 ＋ 续读位置）。 */
export const HISTORY_ENTRY_CHARS = 2000

/** 一页正文合计上限（字符）——条数与字符数两道闸，谁先到算谁。 */
export const HISTORY_PAGE_CHARS = 8000

// ══ 计划载荷的读法（一处判，别处不再判）══════════════════════════════

/**
 * 一条条目是不是**一次成功的计划更新**——是的话交回它写的计划（`null` ＝ 清空）。
 *
 * 判据收在 `unknown` 入口（载荷是外部数据：手写的旧行 / 别的版本写下的），
 * 靠收窄不靠 `as`。`undefined` ＝ 不是（普通工具结果、别的 kind、形状读不出）。
 */
export function planFieldOf(entry: Entry): { readonly plan: PlanNote | null } | undefined {
  if (entry.kind !== 'tool-result') return undefined

  const payload: unknown = entry.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined

  const fields = payload as Record<string, unknown>
  // 失败结果不算数——它不该把上一份可读笔记顶掉（见文件头注）
  if (fields['ok'] !== true) return undefined
  if (!('plan' in fields)) return undefined

  const plan = fields['plan']
  if (plan === null) return { plan: null }
  return isPlanNote(plan) ? { plan } : undefined
}

/** 计划笔记的形状——读侧的同一条判据（写入侧的硬闸在 `@magic/records`，两处同表）。 */
function isPlanNote(value: unknown): value is PlanNote {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false

  const fields = value as Record<string, unknown>
  const steps = fields['steps']
  if (typeof fields['notes'] !== 'string' || !Array.isArray(steps)) return false

  return steps.every((step) => {
    if (typeof step !== 'object' || step === null) return false
    const one = step as Record<string, unknown>
    const status = one['status']
    return (
      typeof one['text'] === 'string' &&
      (status === 'pending' || status === 'in_progress' || status === 'completed')
    )
  })
}

/**
 * 最近一条成功的计划更新——**倒着找，找到就停**。
 *
 * 分页往回扫（每页 `SCAN_CHUNK` 条）：这一位在长会话里可能被后来的工具往返推得很远，
 * 而「一次读尽」在长会话下正是最贵的读法。到头（页不满／页空）即没有。
 */
async function latestPlanEntry(
  records: RecordsService,
  session: SessionId,
): Promise<Entry | undefined> {
  let before: RecordId | undefined

  for (;;) {
    const page = await records.readEntriesBack(session, before, SCAN_CHUNK)
    if (page.length === 0) return undefined

    for (let index = page.length - 1; index >= 0; index -= 1) {
      const entry = page[index]
      if (entry !== undefined && planFieldOf(entry) !== undefined) return entry
    }

    // 页不满＝这条会话更早的记录已经读完（上一页已经是头）
    if (page.length < SCAN_CHUNK) return undefined
    before = page[0]?.id
    if (before === undefined) return undefined
  }
}

/** 当前计划笔记（内容 ＋ 记录位置）——见文件头注。 */
export async function readPlanOf(
  records: RecordsService,
  session: SessionId,
): Promise<PlanSnapshot> {
  const entry = await latestPlanEntry(records, session)
  if (entry === undefined) return { entry: null, plan: null }

  const field = planFieldOf(entry)
  return { entry: entry.id, plan: field === undefined ? null : field.plan }
}

// ══ 上下文里的计划材料 ═══════════════════════════════════════════════

/** 三格状态的中文——材料与清单读的是同一套词（`@magic/tools` 那份是回执用的，同表同义）。 */
const STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: '未开始',
  in_progress: '进行中',
  completed: '已完成',
}

/**
 * 计划内容摆成**会话材料**的那一块——「这是此前存下来的笔记」，不是新交代、也不是系统指令。
 *
 * 抬头三件各有用处：**说清是什么**（既有笔记）· **说清它在哪儿**（记录位置，模型要复核时
 * 按它翻记录）· **说清它不是新要求**（最后一句——材料不是用户刚说的话，
 * 也不提高其中内容的指令优先级）。
 */
export function planBlockOf(entry: RecordId, plan: PlanNote): string {
  const lines = [`〔既有计划笔记 · 记录 #${entry}〕`, '步骤：']

  if (plan.steps.length === 0) lines.push('（还没有步骤）')
  else {
    plan.steps.forEach((step, index) => {
      lines.push(`${index + 1}. [${STATUS_LABEL[step.status] ?? step.status}] ${step.text}`)
    })
  }

  if (plan.notes.trim() !== '') lines.push(`笔记：${plan.notes}`)
  lines.push('（以上是此前保存的进度笔记，不是用户的新要求。）')
  return lines.join('\n')
}

/**
 * **压缩或中断之后，把最新笔记重新交付到窗口里**——设计 · 上下文接入的那一条。
 *
 * 判据是**最终实际发送的那一份**（不是「条目还在窗口里」就完事）：
 * `delivered` ＝本次装配**完整展开成工具消息**的那些工具结果（配对被丢弃的、
 * 正文被截断的不在其中——见 `context.ts`）。故：
 *
 * | 当前计划 | 结果在窗口里吗 | 加材料吗 |
 * | --- | --- | --- |
 * | 有值 | 完整在 | 不加（已有完整最新内容就不再复制正文） |
 * | 有值 | 不在 / 只落了一半 | 加（最新内容已被压出去了） |
 * | 清空 | 清空那一条不在，或旧计划还看得见 | 加一句「当前计划已清空」（消除歧义） |
 * | 没有过计划 | —— | 不加（不增加空材料） |
 *
 * ⚠️ **`delivered` 是结构判据**（条目 id 在不在），不是「消息里有没有这段字」：
 * 更新工具的**回执正文里带完整计划**（`@magic/tools` · `plan-tools.ts` 明写），
 * 故「这一条完整展开」与「模型看得见完整计划」是同义语——那条不变式由用例钉住，
 * 不靠两处各写一份渲染再逐字比对（那正是「拿一句给人看的文案当协议」）。
 *
 * 超预算那一档（设计：超出既有总体资源预算时明确报错、不静默丢要求）**不在这儿管**：
 * 计划材料的体量＝模型自己写的笔记，与工具结果同属既有预算；预算闸门在模型域那一侧，
 * 本文件不另立一套（另立＝第二处口径，两处迟早对不上）。
 */
export async function planMaterialOf(input: {
  readonly records: RecordsService
  readonly session: SessionId
  /** 本次装配里**完整展开成工具消息**的那些工具结果条目 id。 */
  readonly delivered: ReadonlySet<RecordId>
  /** 本次装配展开过的全部条目（用来找「旧计划还看得见吗」）。 */
  readonly entries: readonly Entry[]
}): Promise<ModelMessage | undefined> {
  const snapshot = await readPlanOf(input.records, input.session)
  if (snapshot.entry === null) return undefined // 没有过计划——不加空材料

  const shown = input.delivered.has(snapshot.entry)

  if (snapshot.plan === null) {
    // 清空：清空那一条看不见了，或窗口里还躺着更早那份计划的正文——两种都会让
    // 摘要 / 近段里的旧计划冒充「当前计划」。各说一句，把这个歧义消掉。
    if (shown && !stalePlanVisible(input.entries, input.delivered, snapshot.entry)) return undefined

    return {
      role: 'assistant',
      content: `〔当前计划笔记已清空 · 记录 #${snapshot.entry}〕\n（此前那份计划已不再有效；过程仍在会话记录里。）`,
    }
  }

  if (shown) return undefined

  return { role: 'assistant', content: planBlockOf(snapshot.entry, snapshot.plan) }
}

/** 窗口里还看得见**更早那份计划**的正文吗（清空之后的歧义就出在它身上）。 */
function stalePlanVisible(
  entries: readonly Entry[],
  delivered: ReadonlySet<RecordId>,
  current: RecordId,
): boolean {
  return entries.some(
    (entry) => entry.id !== current && delivered.has(entry.id) && planFieldOf(entry) !== undefined,
  )
}

// ══ 历史回查 ═════════════════════════════════════════════════════════

/**
 * 一条条目 → **给模型看的那段正文**。
 *
 * - `tool-call` 的正文是空的（调用本身在助手消息里）——回查要的是「当时调了什么」，
 *   故取**载荷**里的名与参数（设计：片段保留「调用/结果的实际内容」）；
 * - 其余条目取正文（blob 引用在这里解回文本）。
 */
async function entryTextOf(entry: Entry, records: RecordsService): Promise<string> {
  if (entry.kind === 'tool-call') {
    const call = toolCallPayloadOf(entry.payload)
    if (call === undefined) return '（这次调用的参数读不出）'
    return `${call.name} ${argsLineOf(call.args)}`
  }

  return rawTextOf(entry.content, records)
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
): Promise<HistoryEntry> {
  const full = await entryTextOf(entry, records)
  const text = full.slice(offset, offset + HISTORY_ENTRY_CHARS)
  const more = offset + text.length < full.length

  return {
    id: entry.id,
    kind: entry.kind,
    text,
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

    const piece = await historyEntryOf(entry, records, 0)
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

  const full = await entryTextOf(entry, records)
  if (offset >= full.length) {
    return {
      entries: [{ id: entry.id, kind: entry.kind, text: '' }],
      note: `记录 #${id} 已经读到末尾了（正文共 ${full.length} 字符）。`,
    }
  }

  return { entries: [await historyEntryOf(entry, records, offset)] }
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
    readPlan: () => readPlanOf(input.records, input.session),
    readHistory: (query) => readHistoryOf(input.records, input.session, nearEntries, query),
  }
}

