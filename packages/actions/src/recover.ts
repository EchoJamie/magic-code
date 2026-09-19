/**
 * 用例 · **恢复** —— 以会话为入口**重建现场续跑**（技术方案 · 记录 ·「恢复（阶段 2 · 细部）」五条；
 * 领域划分 ·「域之上：应用层」：首站唯一用例）。
 *
 * ```
 *   ① 在途识别        —— 有 tool.call 无 tool.result（**记录域的查询面**给：`records.scanInFlight`）
 *   ② 处置            —— ★ 首站**不自动重放**（见下）：一律交用户裁决（重跑 / 记失败）
 *   ③ 未完成流式消息  —— 丢弃（半截正文本就不落账——U04 既定行为）＋ 记中止
 *   ④ 未答复裁决      —— 按「拒绝」落账（保守）
 *   ⑤ 上下文由条目重建 —— 不在本文件：归对话域的**重建面**（`ConversationService.rebuild`），
 *                          由 `./index.ts` 的用例入口接着走（本文件只管①②③④）
 * ```
 *
 * ## 为什么这五步在这儿（应用层），不在对话域
 *
 * 恢复**不是任何一个域的能力**，是**跨域的一次协同**：记录域出「哪几笔在途」（查询），
 * 对话域出「重建面」（⑤），处置那三步要落条目（记录域）、铸事件（`EventSink`）、
 * 必要时经工具域重放。U15 时它整段长在对话域里——于是对话域既是核心域（ReAct 的
 * 领域逻辑）又兼编排者，**「域之上」那一层一直空着**（审计第 1 条：恢复入口没有归处）。
 * U25 把这一层立起来，恢复是它的第一个真用例。
 *
 * ## ② 首站为什么不自动重放（2026-09-19 裁 · 审计发现）
 *
 * 设计的原话是「幂等 > 补偿 > 拒绝自动恢复」：**幂等 → 静默重放**；非幂等 → 拒绝自动恢复、
 * 提交用户裁决（重跑 / 记失败）。而 **`ToolSpec` 里没有幂等声明位**——「这一件幂不幂等」
 * **无从判定** ⇒ 首站**一律走「提交用户裁决」那一路**。**设计不承诺做不到的事。**
 *
 * 缺省从严（`ALWAYS_EFFECTFUL`）：没接线、没声明、判不出——一律当**非幂等**（绝不静默重放）。
 * 唯一的接线位是 `IdempotencyJudge`（见其注）；**生产装配不传它**，故重放那一支
 * **首站在产品上不可达**——补声明位是补上以后的事。
 *
 * ## 处置只由记录里的事实决定
 *
 * ```
 *   裁决轨迹（记录里读得到）              处置
 *   ────────────────────────────────────  ──────────────────────────────────────
 *   未答复（问了没答 / 压根没问）   ④      按「拒绝」落账——**不重放**
 *   已拒绝                                按拒绝落账——**不重放**（闸门没放行，压根没执行）
 *   已批准 × 非幂等（含未声明）   ②      拒绝自动恢复——**不重跑**，落失败交用户裁决
 *   已批准 × 幂等                 ②      静默重放（经工具域 `invoke`）★ 首站不可达，见上
 * ```
 *
 * **未答复与已拒绝为什么可以「按拒绝落账」而不重放**——这不是判断，是结构：
 * 工具域的分发是「问闸门 → **批准才可能执行**」（`dispatch.ts` · `settle`），
 * 裁决没落定时执行那一步**根本不存在**。故这两种情形下那次调用**确定没跑过**，
 * 给它补一条「未执行」的结果即与事实相符。
 *
 * **已批准 × 非幂等为什么一次都不能重跑**（本单元最硬的一条）——「已批准」只说明
 * 崩溃前那次**有没有资格跑**，不说明它跑没跑到哪一步。非幂等操作重跑会产生第二次副作用
 * （`mkdir` 无妨，`rm` / 外发 / 半截写就有妨），故一律**交回用户**：记录里落一条
 * 「未重跑」，明说可以重跑（用户说一声即再来一次，届时照常过闸门）。
 *
 * ## 重放也走闸门（不可绕过）
 *
 * 重放经 `ToolRuntime.invoke`——与正常调用同一条路（**闸门在执行路径内**是结构性的，
 * 恢复不给自己开后门）。代价如实记：**闸门会再问一次**（原批准不复用）。
 * 另一处如实记：重放自己会铸一对 `tool.call` / `tool.result`（工具域的产出），
 * 于是记录里那一笔会看到**两条**调用事件——原笔（恢复补记了结果，就此了结）
 * 与重放那一次（自带结果）。条目侧只有一条（模型看到的仍是「一次调用一个结果」）。
 *
 * ## 补记的落点
 *
 * 结果**追加**在条目尾部——在途调用恒是记录尾部那一段（分发按序逐个、崩溃是瞬时的），
 * 故追加即成对。事件侧同理：`tool.result` 的 `call` 指回**原笔**的 `tool.call` id，
 * 四事件链（请求 → 询问 → 裁决 → 结果）就此闭合，下次启动不会再认它作在途。
 * 无链引用的半笔（只有条目、事件没铸出来）**不编造**链引用——只补条目。
 */

import type {
  Content,
  EventSink,
  EventStamper,
  InFlightCall,
  RecordId,
  RecordsService,
  RecoveryScan,
  SessionId,
  Timestamp,
  ToolCall,
  ToolRuntime,
  TurnEndReason,
  TurnId,
} from '@magic/contracts'

// ══ 形态 ══════════════════════════════════════════════════════════════

/**
 * **幂等判定**——「重放这次调用安全吗」。
 *
 * **权威来源＝工具定义**（`ToolSpec` 的幂等声明位；与「危险归类」同层——都是工具的
 * 静态属性）。契约尚未载这一位，故做成**注入的判定面**，并由**缺省从严**兜底：
 * 没接线、没声明、声明读不懂——一律**当非幂等**（绝不静默重放）。
 *
 * ⚠️ **不押模型自述**（设计准则 2）——判据取自工具定义，不看模型在参数里说了什么。
 */
export type IdempotencyJudge = (call: {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}) => boolean

// 缺省判定——**一律非幂等**（未声明即不重放；从严方向安全）。域内件，不出公开面：
// 装配拿不到声明时**不传这个键**即可，没有「显式传一个一律 false」的用处。
const ALWAYS_EFFECTFUL: IdempotencyJudge = () => false

/** 未重放的缘由——三选一，措辞与报告各按它分。 */
export type NotReplayedReason =
  | 'unanswered' // ④ 未答复裁决（含没问过） → 按「拒绝」落账
  | 'rejected' // 已被拒（崩在回填窗口） → 按拒绝落账
  | 'non-idempotent' // ② 已批准但非幂等 → 拒绝自动恢复、交用户裁决

/** 一笔在途的处置。 */
export type CallDisposition = {
  /** 链引用（原笔 `tool.call` 事件 id）；缺则 `null`。 */
  readonly call: RecordId | null
  /** 条目侧配对键（原笔 `tool-call` 条目 id）；缺则 `null`。 */
  readonly entry: RecordId | null
  readonly name: string
  readonly action:
    | { readonly kind: 'replayed'; readonly ok: boolean }
    | { readonly kind: 'not-replayed'; readonly why: NotReplayedReason }
  /** 补记的结果条目 id（这条在途就此了结）；没补成则 `null`。 */
  readonly resultEntry: RecordId | null
}

/** 恢复的报告——用例的返回（判别式：这一趟到底干了什么，逐笔列清）。 */
export type RecoveryReport = {
  readonly session: SessionId
  /** 补记**中止**的那个轮（③）；没有＝`null`。 */
  readonly turn: TurnId | null
  /** 记录里出现过的最大轮号——续跑接着它走（递手给对话域的重建面）。 */
  readonly lastTurn: TurnId | null
  readonly dispositions: readonly CallDisposition[]
  /**
   * 本趟**有没有开工**（在途 / 中断的轮）——即「`agent.start` 是否已经替本实例宣告过」。
   *
   * 它是⑤的递手件之一（`RebuildHandoff.announced`）：**干净会话一个事件都不发**，
   * 故开工位得原样交回，对话域才不会漏发或重发那一条 `agent.start`。
   */
  readonly announced: boolean
}

/**
 * 一次恢复的现场——**各域端口 ＋ 这一条会话的实例件**（装配的 `open` 工厂产）。
 *
 * 域内形态：`createActions` 用它把进程级那几件（扇出 / 时钟 / 判定）与调用级那几件拼起来，
 * **不上公开面**（没出，就没承诺——同 `recoverSession`）。
 */
export type RecoveryRuntime = {
  readonly session: SessionId
  readonly records: RecordsService
  readonly tools: ToolRuntime
  readonly sink: EventSink
  readonly stamper: EventStamper
  /** 时钟——补记的条目（记录域不取时钟）。 */
  readonly now: () => Timestamp
  /** 幂等判定——缺省 `ALWAYS_EFFECTFUL`（见其注；生产装配不传）。 */
  readonly idempotent?: IdempotencyJudge | undefined
}

// ══ 恢复 ══════════════════════════════════════════════════════════════

/** 中止的措辞——`turn.end` 只载 `reason`，这条是给人看的注脚（进补记结果的正文）。 */
const ABORTED: TurnEndReason = 'aborted'

/**
 * 恢复一次会话的**①②③④**——**有活才干，干完必回到「等待输入」**。
 *
 * 顺序：`agent.start`（本实例第一次开工）→ 逐笔处置在途 → 补 `turn.end{aborted}`（③）
 * → `agent.state{waiting}`。干净会话（无在途、无中断的轮）**一个事件都不发**
 * ——「没出事」不该在过程流里留下恢复的痕迹。
 *
 * ⑤（上下文由条目重建 / 界面重建展示）**不在本函数**：那是对话域的活，由用例入口
 * 拿着本函数的 `lastTurn` 与 `announced` 接着走（见 `./index.ts` 的 `recover`）。
 * 分界的判据是「**谁的事**」：本函数只碰记录、事件与工具；上下文与界面不归它。
 */
export async function recoverSession(runtime: RecoveryRuntime): Promise<RecoveryReport> {
  const scan = await runtime.records.scanInFlight(runtime.session)
  const announced = scan.openTurn !== null || scan.calls.length > 0

  if (!announced) {
    return {
      session: runtime.session,
      turn: null,
      lastTurn: scan.lastTurn,
      dispositions: [],
      announced: false,
    }
  }

  const idempotent = runtime.idempotent ?? ALWAYS_EFFECTFUL

  // 起——本实例的第一次开工（U04 口径：`agent.start` 在**首次干活前**发）
  runtime.sink.emit(runtime.stamper.stamp('agent.start', {}))

  const dispositions: CallDisposition[] = []
  try {
    for (const call of scan.calls) {
      // 补记算**原笔那一轮**的事（信封的 `turn` 由铸造器持；轮号不明时退回中断那一轮）
      runtime.stamper.beginTurn(turnOf(call, scan))
      dispositions.push(await dispose(runtime, call, idempotent))
    }

    if (scan.openTurn !== null) {
      runtime.stamper.beginTurn(scan.openTurn)
      // ③ 记中止——那一轮起过头、没收过尾（未完成的流式正文本就没落账，故只此一笔补记）
      runtime.sink.emit(runtime.stamper.stamp('turn.end', { reason: ABORTED }))
    }
  } finally {
    runtime.stamper.beginTurn(undefined)
  }

  // 回到等待输入（收束 / 中止 / 出错都回到这里——U04 口径）
  runtime.sink.emit(runtime.stamper.stamp('agent.state', { state: 'waiting' }))

  return {
    session: runtime.session,
    turn: scan.openTurn,
    lastTurn: scan.lastTurn,
    dispositions,
    announced: true,
  }
}

/** 一笔在途的处置——判据只看记录里的事实（见文件头注的对照表）。 */
async function dispose(
  runtime: RecoveryRuntime,
  call: InFlightCall,
  idempotent: IdempotencyJudge,
): Promise<CallDisposition> {
  const base = { call: call.call, entry: call.entry, name: call.name }

  // ① ④ 未答复（含压根没问过）——没批准就谈不上重放
  if (call.decision === null) {
    return {
      ...base,
      action: { kind: 'not-replayed', why: 'unanswered' },
      resultEntry: closeOut(runtime, call, failure(unansweredText(call))),
    }
  }

  // 已被拒——闸门没放行，执行那一步压根不存在
  if (call.decision === 'reject') {
    return {
      ...base,
      action: { kind: 'not-replayed', why: 'rejected' },
      resultEntry: closeOut(runtime, call, failure(rejectedText(call))),
    }
  }

  // ② 已批准——只有**声明过幂等**的才敢静默重放（首站没有声明位 ⇒ 走不到这儿）
  if (!idempotent({ name: call.name, args: call.args })) {
    return {
      ...base,
      action: { kind: 'not-replayed', why: 'non-idempotent' },
      resultEntry: closeOut(runtime, call, failure(nonIdempotentText(call))),
    }
  }

  const outcome = await replay(runtime, call)
  return {
    ...base,
    action: { kind: 'replayed', ok: outcome.ok },
    resultEntry: closeOut(runtime, call, outcome),
  }
}

/**
 * 重放——经工具域 `invoke`（**闸门在路径内，不可绕过**）。
 *
 * `ToolCall.id` 是**供应商侧**调用 id（只用于回填配对），这里给它一个可辨识的合成值
 * ——`recovery_` 前缀与线上的 `call_1` 一眼分得开，不会撞（见契约 `ids.ts` 的三个 id 空间）。
 */
async function replay(runtime: RecoveryRuntime, call: InFlightCall): Promise<ToolOutcome> {
  const toolCall: ToolCall = {
    id: `recovery_${call.entry ?? call.call ?? 0}`,
    name: call.name,
    args: call.args,
  }

  try {
    return toolOutcomeOf(await runtime.tools.invoke(toolCall, {}))
  } catch (error) {
    // 端口承诺「结果，不是异常」；抛了＝工具域违约。不炸恢复：以失败落账（与循环同法）
    return failure(`工具调用异常：${messageOf(error)}`)
  }
}

/**
 * 了结一笔在途——**补条目（配对）＋ 补事件（链）**，两处同源。
 *
 * 事件侧只在有链引用时铸（`call` 指回原笔的 `tool.call`）；没有就不编造（契约的价值取向：
 * 静默的哨兵比缺参更坏）——那半笔只补条目。
 */
function closeOut(runtime: RecoveryRuntime, call: InFlightCall, outcome: ToolOutcome): RecordId {
  const entry = runtime.records.appendEntry({
    kind: 'tool-result',
    // 正文＝**面向模型的那份**（重放时逐字复原模型当时看到的东西，与循环落账同源）
    content: { text: outcome.text },
    // 载荷＝**记录侧形态**（与该次 `tool.result` 事件的 `output` 同物）
    payload: { ok: outcome.ok, output: outcome.content },
    at: runtime.now(),
  })

  if (call.call !== null) {
    runtime.sink.emit(
      runtime.stamper.stamp('tool.result', {
        call: call.call,
        ok: outcome.ok,
        output: outcome.content,
      }),
    )
  }

  return entry
}

/**
 * 一条工具结果的**落账形态**——两样输出各归其位：
 * `text` → 条目正文（面向模型）· `content` → 条目载荷（记录侧形态）。
 *
 * 与对话域 `entries.ts` 的同名形态同源（两处都从 `ToolResult` 归一而来）——**不共享类型**
 * 是因为域间不得互 import；**同形**是因为契约的 `ToolResult` 就那两样输出。
 * 落账只用到这两样：中间的形态差由本类型吸收——**不编造链引用**（`callRef` 在违约路径上
 * 无从取得；本用例的链引用另走 `InFlightCall.call`）。
 */
type ToolOutcome = {
  readonly ok: boolean
  /** 面向模型的文本——条目正文（重放时逐字复原模型看到的那份）。 */
  readonly text: string
  /** 记录侧形态——条目载荷（与该次 `tool.result` 事件的 `output` 同物）。 */
  readonly content: Content
}

/** 端口结果 → 落账形态——两样输出各取各的，改名不改义。 */
function toolOutcomeOf(result: { ok: boolean; output: string; content: Content }): ToolOutcome {
  return { ok: result.ok, text: result.output, content: result.content }
}

/** 失败形态——两样输出同源（拒绝 / 未重跑没有「给模型看 vs 记录侧」的分叉）。 */
function failure(text: string): ToolOutcome {
  return { ok: false, text, content: { text } }
}

// —— 措辞（给模型看的那份——恢复的原委要说清楚，模型才接得上话）——

function unansweredText(call: InFlightCall): string {
  const asked = call.requested ? '裁决**未答复**' : '未走到裁决'
  return (
    `（恢复）进程崩溃时该次调用在途，且${asked}——按「拒绝」落账（保守）：` +
    `${call.name} 未执行、未重放。若确有需要，请重新发起。`
  )
}

function rejectedText(call: InFlightCall): string {
  return `（恢复）进程崩溃时该次调用已被**拒绝**——${call.name} 未执行（按拒绝落账）。`
}

function nonIdempotentText(call: InFlightCall): string {
  return (
    `（恢复）进程崩溃时该次调用（${call.name}）**在途**（已获批准、未回填结果），` +
    `而该工具未声明为幂等` +
    `——故**未自动重跑**（绝不静默重试非幂等操作）。请与用户确认后再决定是否重跑；` +
    `本次已按「未重跑」记入记录。`
  )
}

// —— 小件 ——

/** 该笔补记算哪一轮——原笔的轮号优先，退回中断那一轮，再退回轮外（`undefined`）。 */
function turnOf(call: InFlightCall, scan: RecoveryScan): TurnId | undefined {
  return call.turn ?? scan.openTurn ?? undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
