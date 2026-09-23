/**
 * 上下文压缩 —— **长会话不爆**（技术方案 · 上下文压缩（阶段 3））。
 *
 * 四件照设计逐条落：
 *
 * | 设计条款 | 落点 |
 * | --- | --- |
 * | **触发**——用量达阈值 **或** 上下文超限错误 | `needed()`（阈值）· 调用方（超限，见 `./agent-loop.ts`） |
 * | **机制**——旧段交模型生成摘要 → 以 `summary` 条目入库 | `run()` ＋ `summarize()` |
 * | **摘要要素**——任务与状态 · 关键决定 · 未完成事项 · 触碰文件面 | `SUMMARY_INSTRUCTION` |
 * | **摘要不是第二份计划**（U34）——不另造任务清单、不重复计划笔记、不把计划当成已发生 | `SUMMARY_INSTRUCTION` |
 * | **失败不降级**——本轮不压缩、照常推进；连续失败报 `error` | `fail()` |
 * | **反复压缩**——`summary` 可被再次摘要 | 旧摘要落在旧段里，照压（无需特判） |
 *
 * ## 「压缩只是上下文装配」——记录一条不动
 *
 * 压完，记录里**一条都没少**：旧段那些条目原样躺在库里，多的只是那条 `summary`
 * （append-only 不破）。少的是**送模型的那一份**——装配照 `planContext` 把旧段换成摘要头
 * （见 `./context.ts` 的文件头注）。故本文件**只做两件写入**：追加一条 `summary` 条目、
 * 发一条 `context.compacted` 事件——**没有任何删除 / 改写**，也不该有。
 *
 * ## 「任务」是个总结出来的词，不是内核的字段
 *
 * 摘要要素里的「**任务与状态**」——内核里**没有**对应的概念（词典明写 Agent Loop
 * 「不承载意图 / 目标 / 进度」）。它是**从对话内容里读出来的**：模型看一遍旧段，自己说
 * 「这个人在做什么、做到哪了」。故此处**不为它造字段、不立 task 概念**（首站不立，
 * 但也不写死——见 `SUMMARY_INSTRUCTION` 的措辞：只说要写什么，没说要照着哪个字段填）。
 *
 * ## 失败不降级（B5）
 *
 * 压缩失败——取摘要出错 / 模型没给正文 / 旧段为空 / 被中断——一律**原样交回**：
 * 调用方照常推进（**不删原文、不写坏摘要**）。「压缩失败就别干活了」是最坏的取向：
 * 原文本就在，读不完也得接着读。**连败 `compactFailureLimit` 次**才报一条 `error`
 * ——让「这条会话快要爆了」这件事有人知道，又不必每轮刷屏（报后清零）。
 */

import type {
  Entry,
  EventSink,
  EventStamper,
  InputRefEntry,
  ModelErrorTier,
  ModelGateway,
  ModelMessage,
  RecordId,
  RecordsService,
  SessionId,
  Timestamp,
} from '@magic/contracts'
import {
  contentTextOf,
  refsPayloadOf,
  toolCallPayloadOf,
  toolResultPayloadOf,
  userPayloadOf,
} from './context.ts'
import type { EntryLog } from './entries.ts'
import { appendSummaryEntry } from './entries.ts'

/**
 * 摘要请求的**输入上限**（字符）——旧段可能比上下文窗还大（那正是要压它的原因），
 * 原样喂给模型会把「压缩」这一步自己先撑爆。取 4 万字符（中文约合几万 token）——
 * 够装下一条长会话的骨架，又不至于让摘要请求本身撞超限。
 */
const SUMMARY_INPUT_LIMIT = 40_000

/** 单条工具调用参数的字符上限——参数串是给摘要看「干了什么」，不是给人复现命令。 */
const SUMMARY_ARGS_LIMIT = 500

/**
 * 摘要指令（**措辞属实现级**——技术方案 · 系统提示词：「段结构冻结；具体文字属实现级」，
 * 此处是它的一份同类：结构（四要素）是设计定的，话怎么说由实现定）。
 *
 * 四要素逐条对应设计原话：任务与状态 · 关键决定 · 未完成事项 · 触碰文件面。
 * 措辞里刻意**不出现任何字段名**——见文件头注（「任务」不是内核的字段）。
 */
const SUMMARY_INSTRUCTION = [
  '你是会话压缩器。下面是一段智能体与用户的对话记录（含工具调用与结果）。',
  '它马上会被你写的摘要取代：往后只有摘要留在上下文里，更早的原文不再送达。',
  '写一份简短交接摘要，供接下来接着干活的你继续理解这项工作。必须含四件：',
  '① 任务与状态：用户在做什么、要得到什么结果、仍有效的重要约束（含最新的纠正）、进行到哪一步；',
  '② 关键决定：已经定下的做法与理由，含已放弃的路线及其必要理由；',
  '③ 未完成事项：还没做完、待确认、待用户答复的，以及当前停点与下一步；',
  // ④ 的措辞自 U34 起收窄（原锚：「动过或读过的文件 / 目录 / 命令，按路径列出」）：
  // 计划笔记另有渠道独立送达（见 `./plan.ts`），逐条罗列读写会把真正该留的约束挤出去。
  '④ 触碰文件面：只列会影响后续判断或回查的路径、数值与记录位置，不罗列所有读写和命令。',
  // 以下三条自 U34 起（设计 · 压缩摘要的配套指导）：摘要仍是**交接材料**，不是第二份计划——
  // 计划里写的只是「当时打算做的」，勾选与摘要都不构成完成证明；而「久未提及」也不等于撤回。
  '要求：区分原始要求、你的假设、已确认结果与未验证事项——不把准备做、尝试过或未经验证的判断写成已完成；',
  '不要把计划里写的事当成已经发生，也不要因为某项久未提及就当成用户撤回；',
  '不要另造完整任务清单，也不要重复整份计划笔记（最新笔记另有渠道独立送达）；',
  '直接给摘要正文；只写记录里真有的东西——不确定的写「未确认」，不要编造来源，不要复述这份指示。',
  // 篇幅这一句不是客套：摘要与它顶掉的旧段**等长**时，压缩就白做了（真跑实测：
  // 不写这一句，模型会照着四要素铺开成长文，压完的上下文比压前还长）
  '篇幅宁短勿长——通常几百字；旧段很长时可放宽，但不能用笼统的「已处理」吞掉尚未解决的要求。',
].join('\n')

/** 触发来路——进失败缘由（「为什么这次要压」在报错里说得清）。 */
export type CompactTrigger = 'threshold' | 'context-limit'

/** 一次压缩的收场——成或不成，都如实说。 */
export type CompactOutcome =
  | {
      readonly ok: true
      /** 落库的那条 `summary` 条目（`context.compacted` 的载荷取它）。 */
      readonly summary: RecordId
      /** 被压掉的旧段条目数。 */
      readonly summarized: number
      /** 留下来的近段条目数（原文照送的那批）。 */
      readonly kept: number
    }
  | {
      readonly ok: false
      /** 没压成的原因（已脱敏 / 已限长——模型域的消息可直接示人）。 */
      readonly reason: string
      /**
       * **算不算一次失败**——被中断不算（用户按了 Ctrl+C，不是压缩坏了）。
       * 只有算数的那种才推进「连续失败」计数。
       */
      readonly counted: boolean
    }

/**
 * 压缩器 —— 域内件（不上公开面）。
 *
 * 它替循环记着**上一次模型调用报回的用量**（触发判据的分子 / 分母），并据此决定该不该压；
 * 状态跨轮、跨用户输入存活（构造一次，随会话实例）。
 */
export type Compactor = {
  /**
   * 「近段」条数——**这个数的源头在这里**：留多少条原文是压缩那一侧定的（它压了什么，
   * 剩下的就是近段）。装配照它认回来（`assembleContext` 的 `nearEntries`）——
   * 两处各存一个数＝迟早各认一段，那正是「摘要＋近段」最不该出的错。
   */
  readonly nearEntries: number
  /**
   * 记一次 `model.usage` 读数——**触发判据的唯一来处**（不另猜上下文有多长）。
   *
   * ⚠️ `inputTokens` **未上报**（U41 起用量各字段分别允许未知）＝这一次**不观察**：
   * 不伪造一次零用量（那会让压缩阈值永远够不着），也不单方面换掉分母。
   */
  observe(usage: {
    readonly inputTokens?: number | undefined
    readonly contextWindow?: number | undefined
  }): void
  /** 用量到阈值了吗（在开一轮之前问一次）。 */
  needed(): boolean
  /** 压一次——成 / 不成都如实报，**不抛**（失败不降级是调用方的姿势，不是异常）。 */
  run(input: { readonly trigger: CompactTrigger; readonly signal?: AbortSignal | undefined }): Promise<CompactOutcome>
}

export type CompactorDeps = {
  readonly records: RecordsService
  readonly session: SessionId
  /** 摘要由**同一个网关**生成（同一个模型）——不另开一条接缝，也不引第二个供应商。 */
  readonly gateway: ModelGateway
  /** 模型名——随摘要请求送模型域（与循环同源）。 */
  readonly model: string
  readonly sink: EventSink
  readonly stamper: EventStamper
  readonly now: () => Timestamp
  readonly blobThreshold: number
  readonly blobTextLimit: number
  /** 「近段」条数（`ContextPolicy.nearEntries`）——压缩留多少条原文。 */
  readonly nearEntries: number
  /** 用量占窗长多少即压（`ContextPolicy.compactAtFraction`）。 */
  readonly compactAtFraction: number
  /** 窗长没声明时的绝对阈值（`ContextPolicy.compactAtTokens`）。 */
  readonly compactAtTokens: number
  /** 连续失败上限（`ContextPolicy.compactFailureLimit`）。 */
  readonly compactFailureLimit: number
}

/** 造一个压缩器——按会话实例各一份（用量读数随会话走）。 */
export function createCompactor(deps: CompactorDeps): Compactor {
  /** 上一次调用报回的用量——**没报过就没有**（不猜、不估；Faux 与真实现未上报时都缺）。 */
  let usage: number | undefined
  /** 那一次报回的窗长——**条目没声明就没有**（分母缺席时走绝对阈值）。 */
  let contextWindow: number | undefined
  /** 连续失败计数（报过 `error` 即清零）。 */
  let failures = 0

  const log: EntryLog = {
    records: deps.records,
    now: deps.now,
    blobThreshold: deps.blobThreshold,
  }

  /** 失败的统一出口——计数、够数就报 `error`（见文件头注）。 */
  function fail(reason: string, counted: boolean): CompactOutcome {
    if (!counted) return { ok: false, reason, counted: false }

    failures += 1
    if (failures >= deps.compactFailureLimit) {
      deps.sink.emit(
        deps.stamper.stamp('error', {
          message:
            `上下文压缩连续失败 ${failures} 次：${reason}` +
            '——本轮不压缩、照常推进（原文一条未动；这条会话迟早会撞上上下文超限）',
        }),
      )
      failures = 0
    }

    return { ok: false, reason, counted: true }
  }

  async function readAll(): Promise<Entry[]> {
    const entries: Entry[] = []
    for await (const entry of deps.records.readEntries(deps.session)) entries.push(entry)
    return entries
  }

  return {
    nearEntries: deps.nearEntries,

    observe(reading): void {
      // **没报输入用量就不观察**——既不留一次假的零，也不只换分母（U41）
      if (reading.inputTokens === undefined) return

      usage = reading.inputTokens
      // 分母跟着分子走（D10 的口径）：两条同刻同源，不拿一个滞后的窗长配一个新用量
      contextWindow = reading.contextWindow
    },

    needed(): boolean {
      if (usage === undefined) return false

      const limit =
        contextWindow === undefined
          ? deps.compactAtTokens
          : Math.floor(contextWindow * deps.compactAtFraction)

      return usage >= limit
    },

    async run({ trigger, signal }): Promise<CompactOutcome> {
      const why = trigger === 'threshold' ? '用量达阈值' : '上下文超限'

      try {
        const all = await readAll()

        // 近段＝最后 `nearEntries` 条——**与 `planContext` 同一算术**（那边按「摘要前 K 条」
        // 认回来，两处算的必须是同一段；同源的理由见 `./context.ts` 文件头注）
        const start = Math.max(0, all.length - deps.nearEntries)
        const old = all.slice(0, start)
        if (old.length === 0) {
          return fail(`${why}，但近段之外没有可压的旧段（共 ${all.length} 条 ≤ 近段边界）`, true)
        }

        const text = await summarize(deps, old, signal)
        // **拿到正文才落条目**——失败路径上一条都不写（不删原文、不写坏摘要）
        const summary = await appendSummaryEntry(log, text)

        failures = 0
        deps.sink.emit(deps.stamper.stamp('context.compacted', { summary }))

        return { ok: true, summary, summarized: old.length, kept: all.length - old.length }
      } catch (error) {
        // 被中断不算失败：用户按了 Ctrl+C，不是压缩坏了（理由见 `CompactOutcome.counted`）
        const aborted = signal?.aborted === true
        return fail(`${why}，${describeError(error)}`, !aborted)
      }
    },
  }
}

/**
 * 旧段 → 摘要正文——**一次模型调用**（同一个网关），失败即抛（由 `run` 收容）。
 *
 * ⚠️ **本流的模型事件一条都不转发**（不 `sink.emit`）：这是内核自己的一次内务调用，
 * 不是会话里的一轮——转发了，外壳会把摘要正文当成助手的答复渲染出来，用量也会被
 * 记成「用户这一轮花的」。
 *
 * 事件流要**拉到底**（`ModelStream` 的约定）：不拉完，聚合结果不落定（见 `call.ts`）。
 */
async function summarize(
  deps: CompactorDeps,
  old: readonly Entry[],
  signal?: AbortSignal,
): Promise<string> {
  const messages: ModelMessage[] = [
    { role: 'system', content: SUMMARY_INSTRUCTION },
    { role: 'user', content: await renderSegment(old, deps) },
  ]

  const stream = deps.gateway.stream(
    { model: deps.model, messages },
    signal === undefined ? {} : { signal },
  )

  let text = ''
  let failure: { readonly tier: ModelErrorTier; readonly message: string } | undefined

  for await (const event of stream.events) {
    if (event.kind === 'model.delta' && event.data.channel === 'text') text += event.data.text
    // `model.error` 是本流的定论信号（其后无事件、无 `call.end`）——看的是**事件**，
    // 不是聚合结果：后者是模型域的域内形态（含 `error` / `aborted`），域间不得互 import
    if (event.kind === 'model.error') failure = event.data
  }
  const settled = await stream.result

  if (signal?.aborted === true) throw new Error('压缩期间被中断')
  if (failure !== undefined) throw new Error(`摘要生成失败（${failure.tier}）：${failure.message}`)
  if (settled.complete !== true) throw new Error('摘要生成未走完（流被掐断）')

  const trimmed = text.trim()
  // 空摘要＝坏摘要：落一条空条目，下一轮装配出来的上下文就是「什么都没有」
  if (trimmed === '') throw new Error('模型没给出摘要正文——不落空条目')

  return trimmed
}

/**
 * 旧段 → 一段文本（摘要请求的正文）。
 *
 * 用**人读得懂的标签**逐条铺开，不追求还原成 `ModelMessage`：摘要要的是「发生过什么」，
 * 而消息形态里的工具配对（`callId`）对摘要毫无用处——为此担一次「配对拆散就被供应商拒」
 * 的风险不值当。
 */
async function renderSegment(entries: readonly Entry[], deps: CompactorDeps): Promise<string> {
  const rendered = await Promise.all(entries.map((entry) => renderEntry(entry, deps)))

  // 从**近到远**收，直到篇幅上限——近的比远的要紧（远的那一头，摘要本来也糊）
  const picked: string[] = []
  let used = 0
  let dropped = 0

  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const piece = rendered[index] ?? ''
    if (used + piece.length > SUMMARY_INPUT_LIMIT && picked.length > 0) {
      dropped = index + 1
      break
    }
    picked.push(piece)
    used += piece.length
  }

  picked.reverse()
  const head = dropped === 0 ? '' : `（更早的 ${dropped} 条未展开——按篇幅上限截取）\n\n`
  return head + picked.join('\n\n')
}

/**
 * 一处引用 → 报名字的那一格（U36）。
 *
 * 技能报技能名；文件 / 目录报**用户写的那一处**（`marker`，`@` 已在里面）——
 * 那是材料在正文里的样子，也是「这一处指的是哪一份」的唯一说法（同名的两份文件靠路径分）。
 */
function refNameOf(ref: InputRefEntry): string {
  return ref.kind === 'skill' ? ref.name : ref.marker
}

/** 一条条目 → 一段文本。 */
async function renderEntry(entry: Entry, deps: CompactorDeps): Promise<string> {
  const text = await contentTextOf(entry.content, deps.records, deps.blobTextLimit)

  if (entry.kind === 'user') {
    // **技能材料只报名字**（U33）——正文不展开：摘要要的是「发生过什么」，
    // 而那份材料本来就是长文，铺进来会把真正该压的旧段挤出去（`SUMMARY_INPUT_LIMIT`）。
    // 报名字仍有用：摘要里因此留得下「这一轮是照哪份技能做的」这条线索，
    // 而**正文一个字不少**——它在条目载荷里，压缩只动送模型的那一份（append-only 不破）。
    //
    // **两形都只报名字**（U36 把带位置的那一份接上同一条口径）：`refs` 里的技能报名字，
    // 文件 / 目录报「带的是哪几条路径」——摘要里因此留得下「这一轮是拿哪几份材料做的」
    // 这条线索，而正文与材料一个字不少（它们在条目与载荷里，压缩只动送模型的那一份）。
    const refs = refsPayloadOf(entry.payload)
    const refHead =
      refs.length === 0
        ? ''
        : `〔本次引用：${refs.map((one) => refNameOf(one)).join(' · ')}〕\n`

    const skills = userPayloadOf(entry.payload)
    const head =
      refHead === '' && skills.length === 0
        ? ''
        : refHead + (skills.length === 0 ? '' : `〔本次使用技能：${skills.map((one) => one.name).join(' · ')}〕\n`)

    return `【用户】\n${head}${text}`
  }
  if (entry.kind === 'assistant') return `【助手】\n${text}`
  // 反复压缩（B6）：这份旧摘要落在待压的旧段里，照旧当一段正文喂进去——摘要的摘要
  if (entry.kind === 'summary') return `【此前的摘要】\n${text}`

  if (entry.kind === 'tool-call') {
    const call = toolCallPayloadOf(entry.payload)
    if (call === undefined) return '【工具调用】（载荷读不出）'
    return `【工具调用】${call.name} ${argsText(call.args)}`
  }

  const result = toolResultPayloadOf(entry.payload)
  return `【工具结果：${result?.ok === false ? '失败' : '成功'}】\n${text}`
}

/** 调用参数 → 一行文本（截断——摘要要的是「干了什么」，不是能复现的命令）。 */
function argsText(args: Readonly<Record<string, unknown>>): string {
  let text: string
  try {
    text = JSON.stringify(args) ?? ''
  } catch {
    // 循环引用等——摘要不该因此整段失败
    text = '(参数无法序列化)'
  }
  return text.length <= SUMMARY_ARGS_LIMIT ? text : `${text.slice(0, SUMMARY_ARGS_LIMIT)}…`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
