/**
 * Faux Provider —— `ModelGateway` 的**假实现**（技术方案 · 模型策略 · 测试）。
 *
 * 一个不碰网络、不要 key 的模型：喂它一段脚本（`FauxTurn[]`），它按**真实接缝的不变式**
 * 吐出一串内核事件 ＋ 聚合结果。循环 / 恢复 / 渲染因此无 key 可测。
 *
 * **不变式照真实现**（技术方案 · 模型策略 · 接缝自留：`@magic/model` 的 `normalize.ts` 文件头）——
 * Faux 与真实现**必须同形**，否则拿 Faux 测出来的绿是假绿：
 * ① 首条恒为 `model.call.start`；
 * ② 中段零至多条 `model.delta`（思考 → 正文 → 工具调用）；
 * ③ 收束为 `model.usage`? → `model.call.end`；
 * ④ 出错以 `model.error` **终结**（其后无事件、无 `model.call.end`）；
 * ⑤ 中断**静默结束**（无 `model.error`、无 `model.call.end`——中断不是模型错误）。
 *
 * 聚合结果的语义照真实现的**双出口**：`result` 随 `events` 被消费完而落定；
 * 提前 `break` 亦落定（`complete: false`）；`events` 从未被迭代则不落定
 * ——**接缝不替消费方缓冲整条流**。
 *
 * ⚠️ 本包是**测试层**：这里没有生产逻辑（守护拦「域 import 本包」）。
 */

import type {
  EventStamper,
  KernelEvent,
  ModelErrorTier,
  ModelFinishReason,
  ModelGateway,
  ModelRequest,
  ModelResult,
  ToolCall,
} from '@magic/contracts'
import type { FauxToolCall, FauxTurn } from './script.ts'
import { argsJsonOf, toPieces } from './script.ts'

/** 缺省模型名——`model.call.start` 的载荷（Faux 不看请求里的模型名，脚本说了算）。 */
export const FAUX_MODEL = 'faux-1'

// —— 聚合结果 ——

/**
 * 一次 Faux 调用的聚合结果。
 *
 * 契约 `ModelResult` 四项（`finishReason` / `usage` / `complete` / `toolCalls`）**原样**，
 * 另加**内容视图**（`model` / `text` / `thinking` / `error` / `aborted`）——
 * **与模型域 `ModelCallResult` 同形**（该域不在本包可 import 之列，故在此自持一份；
 * 两处形态对齐由「拿 Faux 换真实现」的用例守）。
 */
export type FauxResult = ModelResult & {
  readonly model: string
  /** 正文全量（`text` 通道拼合）。Faux 不做内嵌思考切分——那是模型域特征标记的活。 */
  readonly text: string
  /** 思考全量（`thinking` 通道拼合）。 */
  readonly thinking: string
  /** 与 `model.error` 事件同一份结论；无错为 `undefined`。 */
  readonly error: { readonly tier: ModelErrorTier; readonly message: string } | undefined
  /** 被调用方中断（`signal` 触发）——**不是**模型错误，故不发 `model.error`。 */
  readonly aborted: boolean
}

/** Faux 的流——契约 `ModelStream` 的落地（事件流 ＋ 聚合结果）。 */
export type FauxStream = {
  readonly events: AsyncIterable<KernelEvent>
  readonly result: Promise<FauxResult>
}

/**
 * Faux 网关——契约端口 `ModelGateway` 的落地。
 *
 * 两处放宽（与模型域 `@magic/model` 的 `ModelGateway` 同法——**结构超集**）：
 * ① `options` 可省（测试里多半不关心中断信号）；
 * ② 聚合结果是 `FauxResult`（契约四项 ＋ 内容视图）。
 * 消费者按契约端口取用即可；换插真实现时两边同形。
 */
export interface FauxGateway extends ModelGateway {
  stream(request: ModelRequest, options?: { signal?: AbortSignal }): FauxStream
  /**
   * **请求留痕**（按调用序）——观察面，不是回放依据。
   *
   * Faux 的产出**只看脚本、不看请求**（假模型不必理解上下文）；留痕是给测试用的：
   * 「回填送达模型了吗」「这轮带上了哪些工具规格」——循环测试绕不开这几问。
   *
   * 存的是**快照**（`messages` / `tools` 各拷一份）——循环多半持有同一个数组继续回填，
   * 存引用会让留痕随后续 push 一起变。
   */
  readonly requests: readonly ModelRequest[]
}

// —— 构造 ——

export type FauxGatewayOptions = {
  /** 信封铸造器——**产出方铸**（信封四件由它盖；测试里通常给 `makeTestStamper()`）。 */
  readonly stamper: EventStamper
  /**
   * 脚本——**一段一轮**：第 n 次 `stream()` 取第 n 段。
   * 用尽后再调**报错**（多调一轮通常是循环的 bug，静默重复上一段会让测试假绿）。
   */
  readonly turns: readonly FauxTurn[]
  /** `model.call.start` 报的模型名——缺省 `'faux-1'`。 */
  readonly model?: string
  /**
   * 每步之间的等待（毫秒）——缺省 0。
   * 给消费方留出触发 `signal` 的窗口（测中断路径时用）。
   */
  readonly stepDelayMs?: number
}

/**
 * 脚本用尽——第 `attempted` 次 `stream()` 无脚本可用。
 * 消息直接说人话：多半是循环该收束而没收。
 */
export class FauxScriptExhaustedError extends Error {
  readonly attempted: number
  readonly scripted: number

  constructor(attempted: number, scripted: number) {
    super(
      `Faux 脚本已用尽：第 ${attempted} 次 stream() 无脚本可用（共写了 ${scripted} 段）——` +
        `多调一轮通常是循环的 bug；补一段脚本，或检查循环何时该收束。`,
    )
    this.name = 'FauxScriptExhaustedError'
    this.attempted = attempted
    this.scripted = scripted
  }
}

/**
 * 造一个 Faux Provider——**`ModelGateway` 的一个实现**。
 *
 * 与模型域的 `createModelGateway` 换插：消费者按契约端口取用，其余零改动。
 */
export function createFauxGateway(options: FauxGatewayOptions): FauxGateway {
  const { stamper, turns } = options
  const model = options.model ?? FAUX_MODEL
  const stepDelayMs = options.stepDelayMs ?? 0

  let cursor = 0
  const requests: ModelRequest[] = []

  return {
    get requests(): readonly ModelRequest[] {
      return requests
    },

    stream(request: ModelRequest, streamOptions?: { signal?: AbortSignal }): FauxStream {
      // **快照**，不是存引用——循环通常持有同一个 `messages` 数组继续回填，
      // 存引用会让「第一轮请求长什么样」随后续 push 一起变（测试抓到的第一处真问题）。
      requests.push({
        ...request,
        messages: [...request.messages],
        ...(request.tools === undefined ? {} : { tools: [...request.tools] }),
      })

      const turn = turns[cursor]
      cursor += 1
      if (turn === undefined) throw new FauxScriptExhaustedError(cursor, turns.length)

      return runTurn({ stamper, model, stepDelayMs, turn, signal: streamOptions?.signal })
    },
  }
}

// —— 一段脚本的展开与产出 ——

type TurnContext = {
  readonly stamper: EventStamper
  readonly model: string
  readonly stepDelayMs: number
  readonly turn: FauxTurn
  readonly signal: AbortSignal | undefined
}

function runTurn(context: TurnContext): FauxStream {
  const { stamper, model, turn, signal } = context

  const toolCalls: readonly ToolCall[] = (turn.toolCalls ?? []).map((call, index) => ({
    id: callIdOf(call, index),
    name: call.name,
    args: call.args ?? {},
  }))

  // 聚合的活状态——随事件被消费而推进（提前 break 则停在半路，正是「未完成态」）
  const state = {
    text: '',
    thinking: '',
    aborted: false,
    complete: false,
  }
  let settle!: (result: FauxResult) => void
  const result = new Promise<FauxResult>((resolve) => {
    settle = resolve
  })

  const snapshot = (): FauxResult => ({
    model,
    text: state.text,
    thinking: state.thinking,
    toolCalls,
    usage: turn.usage,
    finishReason: finishReasonOf(turn, toolCalls),
    error: turn.error,
    aborted: state.aborted,
    complete: state.complete,
  })

  /** 中断收场——静默（不变式 ⑤）：不发 `model.error`、不发 `model.call.end`。 */
  const abandon = (): void => {
    state.aborted = true
    state.complete = true
  }

  async function* pump(): AsyncGenerator<KernelEvent> {
    try {
      // ① 首条恒为 call.start——**即便已中止也发**（「调用已发起」是事实）
      yield stamper.stamp('model.call.start', { model })

      for (const piece of piecesOf(turn)) {
        await pace(context.stepDelayMs, signal)
        if (signal?.aborted === true) return abandon()

        // 增量片段同时攒进聚合（与真实现同源：事件流与结果不是两套结论）
        if (piece.channel === 'text') state.text += piece.text
        if (piece.channel === 'thinking') state.thinking += piece.text

        yield stampPiece(stamper, piece)
      }

      // ④ 出错以 `model.error` 终结——其后无事件（故 error 段没有 call.end）
      if (turn.error !== undefined) {
        yield stamper.stamp('model.error', {
          tier: turn.error.tier,
          message: turn.error.message,
        })
        state.complete = true
        return
      }

      // ③ 收束：usage? → call.end
      if (turn.usage !== undefined) {
        yield stamper.stamp('model.usage', {
          inputTokens: turn.usage.inputTokens,
          outputTokens: turn.usage.outputTokens,
        })
      }
      yield stamper.stamp('model.call.end', {})

      // 走到这里＝本轮已定论。消费方提前 break 则到不了此行——`complete` 留 false。
      state.complete = true
    } finally {
      settle(snapshot())
    }
  }

  return { events: pump(), result }
}

/** 收束原因——出错缺省（供应商未给）；有工具调用＝`tool-calls`；其余＝`stop`。 */
function finishReasonOf(
  turn: FauxTurn,
  toolCalls: readonly ToolCall[],
): ModelFinishReason | undefined {
  if (turn.error !== undefined) return undefined
  return toolCalls.length > 0 ? 'tool-calls' : 'stop'
}

// —— 事件规格（展开是一回事，铸造是另一回事——信封只在产出时盖）——

/** 一个 `model.delta` 的规格——信封只在产出时盖，这里只管「发什么」。 */
type Piece =
  | { readonly channel: 'text' | 'thinking'; readonly text: string }
  | {
      readonly channel: 'toolcall'
      readonly text: string
      readonly name: string
      readonly id: string
    }

/** 调用 id——缺省按段内序号造（**两处（规格化 / 展开）同源**，不必各自推一遍）。 */
const callIdOf = (call: FauxToolCall, index: number): string => call.id ?? `call_${index + 1}`

/** 一段脚本 → 增量片段序列（次序照真端点：思考 → 正文 → 工具调用）。 */
function piecesOf(turn: FauxTurn): readonly Piece[] {
  const pieces: Piece[] = []

  for (const text of toPieces(turn.thinking)) pieces.push({ channel: 'thinking', text })
  for (const text of toPieces(turn.text)) pieces.push({ channel: 'text', text })

  for (const [index, call] of (turn.toolCalls ?? []).entries()) {
    const id = callIdOf(call, index)
    // 名字先于参数——零参工具也见得着名字（真实现的 `tool-input-start` 即发空文本增量）
    pieces.push({ channel: 'toolcall', text: '', name: call.name, id })
    pieces.push({ channel: 'toolcall', text: argsJsonOf(call), name: call.name, id })
  }

  return pieces
}

function stampPiece(stamper: EventStamper, piece: Piece): KernelEvent {
  if (piece.channel === 'toolcall') {
    return stamper.stamp('model.delta', {
      channel: 'toolcall',
      text: piece.text,
      name: piece.name,
      id: piece.id,
    })
  }

  return stamper.stamp('model.delta', { channel: piece.channel, text: piece.text })
}

// —— 等一拍（中断即时返回——不给测试白等）——

function pace(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) return Promise.resolve()

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
