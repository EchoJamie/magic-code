/**
 * 恢复查询面 —— **在途识别**（技术方案 · 记录 ·「恢复（阶段 2 · 细部）」①；领域划分：
 * 「恢复的查询面（在途识别）由它提供」）。
 *
 * 恢复要处置什么，**只能从记录里读出来**——本文件把那件事说全，且**只说不判**：
 * 判定「哪几笔在途、属于哪一轮、裁决走到了哪一步」，处置（重放 / 落账）归对话域。
 *
 * ```
 *   有 `tool.call` 无 `tool.result`   ← 在途（①的原话）
 *   有 `turn.start` 无 `turn.end`     ← 中断的轮（③「记中止」的落点）
 * ```
 *
 * **两处判据互为补足，故两处都扫**：
 * - **事件侧**（链引用）——说得出「问过闸门吗、裁决是什么」（`tool.decision.request` /
 *   `tool.decision` 的 `call` 指向该次 `tool.call` 的 id）。**处置要的就是这条轨迹**：
 *   未答复＝按「拒绝」落账（④）、已批准才谈得上重放（②）。
 * - **条目侧**（配对）——上下文由条目重建（⑤），而「助手消息的 `toolCalls` 与工具消息成对」
 *   是条目侧的事：有 `tool-call` 条目而无对应的 `tool-result` 条目＝这笔在上下文里**落单**
 *   （U04 装配遇之即跳过）。恢复给它补一条结果条目，上下文才重新合法。
 *
 * **条目侧按「顺序」配对**（第 i 个 `tool-call` 配第 i 个 `tool-result`，**不要求紧邻**）——
 * 常态下与「紧邻即成对」等价（会话是「调用 → 结果 → 再调用」的序），而异常形状下只有它
 * 站得住：恢复补记的结果条目**追加**在尾部（append-only），两笔落单同时存在时尾随的那笔
 * 紧邻判据永远认它没结——那会让恢复每次启动都重复处置同一笔。**代价如实记**：装配侧仍按
 * 紧邻拼消息，故这种（不该出现的）形状下助手消息的 `toolCalls` 会被整批丢掉——**合法但不完整**，
 * 比拼出一条供应商会拒的消息好。
 *
 * **配对靠「名 ＋ 参数」的规范化文本**（两边的 `args` 都是同一个对象经 JSON 落库再取回，
 * 故按**键序无关**的规范化比较）。一笔对不上时如实报 `null`（条目侧 / 事件侧缺一边），
 * **不猜**——恢复宁可见到「这笔说不全」，也不要一个看着圆满的错配对。
 *
 * **调用恒在尾部**（分发按序逐个、崩溃是瞬时的）——故本文件不假设、但下游可依赖：
 * 结果条目**追加**即成对（恢复不必往中间插行）。
 *
 * 内存：一次把会话的事件与条目读进数组——与上下文装配同一姿势（U04 备案 7）。
 * 长会话的流式扫描留后（真要时按 id 分页读，端口已支持）。
 */

import type {
  Decision,
  Decider,
  Entry,
  InFlightCall,
  KernelEvent,
  RecordId,
  RecoveryScan,
  SessionId,
  TurnId,
} from '@magic/contracts'

// `InFlightCall` / `RecoveryScan` 的**形态归契约**（U25）：恢复的消费方是应用层
// （`@magic/actions`），而应用层只认 `@magic/contracts`——再让每个消费方各持一份镜像
// （U15 时对话域就是这么干的）＝ N 处形态各写一遍、靠接线处对齐。形搬到契约，两处同源。
export type { InFlightCall, RecoveryScan }

/** 扫描入参——事件与条目由调用方读好后交进来（本函数**纯**：不碰库、不碰 fs）。 */
export type ScanInput = {
  readonly session: SessionId
  readonly events: readonly KernelEvent[]
  readonly entries: readonly Entry[]
}

/** 扫一遍——在途调用 ＋ 中断的轮 ＋ 轮号水位。 */
export function scanForRecovery(input: ScanInput): RecoveryScan {
  const fromEvents = scanEvents(input.events)
  const fromEntries = scanEntries(input.entries)

  return {
    session: input.session,
    openTurn: fromEvents.openTurn,
    lastTurn: fromEvents.lastTurn,
    calls: merge(fromEvents.calls, fromEntries),
  }
}

// ══ 事件侧：链引用与轮 ══════════════════════════════════════════════════

/** 事件侧的一笔在途调用——链引用（`call`）＋ 它的**裁决轨迹**（`requested` / `decision`）。 */
type TracedCall = {
  readonly call: RecordId
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly turn: TurnId | null
  /** 问过闸门吗（`tool.decision.request` 在）。 */
  readonly requested: boolean
  /** 裁决结论；未答复 / 未问 ＝ `null`。 */
  readonly decision: Decision | null
  readonly decider: Decider | null
}

/** 事件侧的一次扫描——在途调用（链引用齐全）＋ 中断的轮 ＋ 最大轮号。 */
function scanEvents(events: readonly KernelEvent[]): {
  readonly calls: readonly TracedCall[]
  readonly openTurn: TurnId | null
  readonly lastTurn: TurnId | null
} {
  const calls: { call: RecordId; name: string; args: Readonly<Record<string, unknown>>; turn: TurnId | null }[] = []
  const withResult = new Set<RecordId>()
  const requested = new Set<RecordId>()
  const decided = new Map<RecordId, { decision: Decision; decider: Decider }>()
  const open = new Set<TurnId>()
  let lastTurn: TurnId | null = null

  for (const event of events) {
    if (event.turn !== null) lastTurn = Math.max(lastTurn ?? event.turn, event.turn)

    switch (event.kind) {
      case 'turn.start':
        if (event.turn !== null) open.add(event.turn)
        break
      case 'turn.end':
        if (event.turn !== null) open.delete(event.turn)
        break
      case 'tool.call':
        calls.push({
          call: event.id,
          name: event.data.name,
          args: event.data.args,
          turn: event.turn,
        })
        break
      case 'tool.result':
        withResult.add(event.data.call)
        break
      case 'tool.decision.request':
        requested.add(event.data.call)
        break
      case 'tool.decision':
        decided.set(event.data.call, { decision: event.data.decision, decider: event.data.decider })
        break
      default:
        break
    }
  }

  return {
    // 有调用、无结果＝在途（①）；轨迹随行（供处置措辞与判定）
    calls: calls
      .filter((call) => !withResult.has(call.call))
      .map((call) => ({
        ...call,
        requested: requested.has(call.call),
        decision: decided.get(call.call)?.decision ?? null,
        decider: decided.get(call.call)?.decider ?? null,
      })),
    openTurn: open.size === 0 ? null : Math.max(...open),
    lastTurn,
  }
}

// ══ 条目侧：配对 ════════════════════════════════════════════════════════

type EntrySideCall = {
  readonly entry: RecordId
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

/**
 * 条目侧的落单调用——**第 i 个 `tool-call` 配第 i 个 `tool-result`**（顺序配对，见文件头注），
 * 配不满的那些即落单。
 */
function scanEntries(entries: readonly Entry[]): readonly EntrySideCall[] {
  const callEntries: Entry[] = []
  let results = 0

  for (const entry of entries) {
    if (entry.kind === 'tool-call') callEntries.push(entry)
    else if (entry.kind === 'tool-result') results += 1
  }

  const dangling: EntrySideCall[] = []
  for (const entry of callEntries.slice(results)) {
    const payload = callPayloadOf(entry)
    if (payload === undefined) continue // 形态不符＝不是本域能认的调用（写入侧硬闸下不该出现）
    dangling.push({ entry: entry.id, ...payload })
  }

  return dangling
}

/** 拿 `tool-call` 条目的载荷——形态不符给 `undefined`（本包写入侧已硬闸，此处只作防御）。 */
function callPayloadOf(entry: Entry): { name: string; args: Readonly<Record<string, unknown>> } | undefined {
  const payload: unknown = entry.payload
  if (typeof payload !== 'object' || payload === null) return undefined

  const { name, args } = payload as { name?: unknown; args?: unknown }
  if (typeof name !== 'string' || typeof args !== 'object' || args === null) return undefined

  return { name, args: args as Readonly<Record<string, unknown>> }
}

// ══ 合并：一条在途调用一行 ══════════════════════════════════════════════

/**
 * 两侧合一——按「名 ＋ 参数」配对，各自剩下的是「只此一侧」的半笔（如实报 `null`）。
 *
 * 全须一一对应才是常态（崩溃窗口里两侧同时成立）；对不上的两路各有其因：
 * - **只有条目**——崩在条目落账与 `tool.call` 铸出之间（毫秒级窗口）；
 * - **只有事件**——崩在工具域铸了 `tool.call` 而条目未落（或条目已由恢复补过）。
 */
function merge(
  eventCalls: readonly TracedCall[],
  entryCalls: readonly EntrySideCall[],
): readonly InFlightCall[] {
  const takenEvents = new Set<number>()
  const merged: InFlightCall[] = []

  for (const entryCall of entryCalls) {
    const at = eventCalls.findIndex(
      (candidate, index) =>
        !takenEvents.has(index) &&
        candidate.name === entryCall.name &&
        sameArgs(candidate.args, entryCall.args),
    )

    if (at < 0) {
      merged.push({
        call: null,
        entry: entryCall.entry,
        name: entryCall.name,
        args: entryCall.args,
        turn: null,
        requested: false,
        decision: null,
        decider: null,
      })
      continue
    }

    takenEvents.add(at)
    const eventCall = eventCalls[at]
    if (eventCall === undefined) continue // findIndex 已保证在界内，此处只为类型收窄
    merged.push({
      call: eventCall.call,
      entry: entryCall.entry,
      name: eventCall.name,
      args: eventCall.args,
      turn: eventCall.turn,
      requested: eventCall.requested,
      decision: eventCall.decision,
      decider: eventCall.decider,
    })
  }

  for (const [index, eventCall] of eventCalls.entries()) {
    if (takenEvents.has(index)) continue
    merged.push({
      call: eventCall.call,
      entry: null,
      name: eventCall.name,
      args: eventCall.args,
      turn: eventCall.turn,
      requested: eventCall.requested,
      decision: eventCall.decision,
      decider: eventCall.decider,
    })
  }

  // 出现序＝id 序（条目 / 事件共用同一 id 空间）——两头的号取小的那个
  return merged.sort((left, right) => anchorOf(left) - anchorOf(right))
}

function anchorOf(call: InFlightCall): RecordId {
  return call.entry ?? call.call ?? 0
}

/** 参数相等——**键序无关**（两边的 `args` 都经 JSON 落库再取回，键序不保证同）。 */
function sameArgs(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  return canonical(left) === canonical(right)
}

/** 规范化文本——键按字典序拼（**非 JSON 值**不在契约承诺内，落库前已被拒）。 */
function canonical(value: Readonly<Record<string, unknown>>): string {
  return stable(value)
}

/** 值的规范形——对象键排序、数组按序，标量走 JSON。 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const fields = Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)

    return `{${fields.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
