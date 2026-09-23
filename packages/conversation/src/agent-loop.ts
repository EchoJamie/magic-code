/**
 * 主循环 —— `agentLoop`：模型调用（流式）→ 工具调用 → 结果回填 → 往复，直到收束。
 *
 * 出处：技术方案 · 主循环（轮 ＝ 一次模型调用 ＋ 它请求的工具执行〔可为 0 个〕·
 * 中断 · 同轮多工具按序逐个）。
 *
 * ```
 *   一个用户输入 ─→ 落账（message.user）─┐
 *                                        ↓
 *      ┌───────────── 轮 ──────────────┐ │   轮 = 一次模型调用 + 它请求的工具
 *      │  turn.start                   │ │
 *      │  模型流（事件原样转发）        │ │
 *      │  message.assistant（落账）     │ │
 *      │  tool.call → tool.result ×n    │ │   闸门在执行路径内（工具域的事）
 *      │  turn.end                     │ │
 *      └───────────────────────────────┘ │
 *                                        ↓
 *              无工具调用 → 收束（回到等待输入）／被中止／出错
 * ```
 *
 * **本域发的事件**（技术方案 · 领域划分 · 事件产出）——`message.user` · `message.assistant`
 * · `turn.start` · `turn.end` · 兜底 `error`。模型域的事件（`model.*`）**原样转发**；
 * 工具域 / 权限域的事件（`tool.*`）由它们各自直发 `EventSink`——**本域不越俎**。
 *
 * **轮起止由本域调**（`stamper.beginTurn`）——信封的归属 v0 锚定：「对话域在轮起止时调」。
 * 模型域被测试钉死「不调 `beginTurn`」（M02 备案），接上时必须自己调：轮外的事件
 * （`message.user`）信封 `turn` 为 `null`，轮内的都带本轮号。
 *
 * **上下文每轮由条目重建**（`./context.ts`）——记录即真源：中途被中止 / 崩掉，
 * 下一轮装配出来的仍是记录里那个现场（恢复〔阶段 2〕走同一条路）。
 *
 * **中断**（`signal`）——模型流停止（`signal` 交给接缝）· 执行中命令终止（交给工具域）
 * · 本轮以 `turn.end{reason:'aborted'}` 收束 · 回到等待输入。中断**不是**错误：
 * 半截流式消息丢弃（技术方案 · 恢复：「未完成流式消息丢弃、记中止」）。
 *
 * **错误分档的处置**——瞬时档（退避重试）在**模型域的接缝之下**（见 `@magic/model` 的
 * `retry.ts`：本域看不见重试，只看得到 `model.retry` 这条实时信号）；`context-limit`
 * （上下文超限）**归本域**：压一次再重发（见下）；终态档一律停下报告用户
 * （`turn.end{reason:'error'}` ＋ 模型域的 `model.error` 已在事件流里）。
 *
 * ## 压缩的两条触发路径（阶段 3 · U19）
 *
 * - **用量达阈值**——开一轮之前问一次（`shouldCompact()`）：上一次调用报回的用量到了
 *   阈值就先压后跑。**先压后跑**而不是「撞了再压」，是因为撞上超限要白搭一次调用。
 * - **上下文超限错误**——`model.error{tier:'context-limit'}`：压一次、**本轮重发**
 *   （不换模型）。只给一次机会（压完还超限＝这条会话确实塞不下了，如实停下报告）。
 *
 * 两条路都**不降级**：压不成，本轮照常走原来的上下文（B5——原文本就在，读不完也得接着读）。
 */

import type {
  EventKind,
  EventSink,
  EventStamper,
  InputRef,
  InputRefEntry,
  ModelErrorTier,
  ModelGateway,
  ModelResult,
  RecordId,
  RecordsService,
  SessionId,
  Timestamp,
  ToolCall,
  ToolRuntime,
  TurnEndReason,
  TurnId,
  UserInput,
  UsedSkill,
} from '@magic/contracts'
import type { Compactor } from './compact.ts'
import { DEFAULT_NEAR_ENTRIES, assembleContext } from './context.ts'
import type { EntryLog, ToolOutcome } from './entries.ts'
import {
  appendTextEntry,
  appendToolCallEntry,
  appendToolResultEntry,
  appendUserEntry,
  toolOutcomeOf,
} from './entries.ts'
import type { RefDelivery } from './refs.ts'
import type { RulesDelivery } from './rules.ts'
import { needsReviewText, overflowText } from './rules.ts'
import type { SkillsDelivery } from './skills.ts'

/**
 * 一次交代的收场——三种**轮次收场**（`TurnEndReason`，会写进 `turn.end`）
 * ＋ 一种**没开轮的**：`rejected` ＝这一条压根没跑（显式选定的技能取不到）。
 *
 * 它**不产 `turn.end`**（那一轮压根没起），故不能塞进 `TurnEndReason` 那个契约词表里
 * ——那是「轮怎么结束的」，而这里说的是「轮没开始」。
 */
export type InputOutcome = TurnEndReason | 'rejected'

/**
 * 循环的构造入参（**域内形态**）——端口实现（`./service.ts`）按它装配。
 * 每个字段都是一件「不知道自己是谁的」依赖：模型 / 工具 / 记录皆经端口，实现在别处。
 */
export type LoopRuntime = {
  /** 会话——条目按会话读（信封的 `session` 由铸造器持，两处同源）。 */
  readonly session: SessionId
  /** 模型名——随每次调用送模型域（`ModelRequest.model`）。 */
  readonly model: string
  /** 系统提示词全文——已由提示词部件装配好（本文件不认知段结构）。 */
  readonly systemPrompt: string
  readonly gateway: ModelGateway
  readonly tools: ToolRuntime
  readonly records: RecordsService
  readonly sink: EventSink
  readonly stamper: EventStamper
  /**
   * 轮号发号器——阶段 1 单调自增（端口实现持计数器）。
   * **留缝**：阶段 2 恢复改由记录派生（同一会话续跑要接着那串轮号）。
   */
  readonly nextTurnId: () => TurnId
  /** 时钟——条目时间戳（见 `./entries.ts`）。 */
  readonly now: () => Timestamp
  readonly blobThreshold: number
  readonly blobTextLimit: number
  /**
   * 压缩器（阶段 3 · U19）——**不接线＝不压缩**（首站无压缩那几轮的行为一字不动；
   * 用例只想验循环时也不必拖一个压缩器进来）。真装配一律给（见 `./service.ts`）。
   *
   * 「近段」条数**不从别处另给**——装配照它的 `nearEntries` 认（见 `Compactor` 的注）。
   */
  readonly compact?: Compactor | undefined
  /**
   * 项目规约的送达账（U32）——**不接线＝不加载规约**（没有规约的那些工作区行为一字不动；
   * 用例只想验循环时也不必拖一份规约进来）。真装配一律给（见 `./service.ts`）。
   *
   * 它是**有状态**的（作用域 ＋ 最近一次请求送达的那份材料），故按会话实例各造一份——见其注。
   */
  readonly rules?: RulesDelivery | undefined
  /**
   * 技能送达（U33）——**不接线＝既发现也不加载技能**（没有技能的那些工作区行为一字不动）。
   * 真装配一律给（见 `./service.ts`）。
   *
   * 与 `rules` 不同，它**不存状态**：目录每趟现扫、主文取一次用一次（执行域那一条
   * 「不设全仓 watcher」在这儿的形态）。故按会话实例造一份只是因为它跟着运行时走。
   */
  readonly skills?: SkillsDelivery | undefined
  /**
   * **引用送达**（U36）——正文里的 `@文件` / `@目录` / `/技能` 各取各的那一份。
   *
   * **不接线＝带引用的一律不跑**（`rejected`）：那种装配压根取不到材料，静默丢掉引用继续
   * 就是「把用户那句话删掉一半」。它与 `skills` 那一支不重叠——旧形（无位置）走 `skills`，
   * 新形（带位置）走这里（见 `refs.ts` 的文件头注）。
   */
  readonly refs?: RefDelivery | undefined
}

/**
 * 一轮的收场。
 * `reason` 进 `turn.end`；`continues` ＝本轮请求了工具且都处置完——**须再开一轮**。
 */
export type TurnOutcome = {
  readonly reason: TurnEndReason
  readonly continues: boolean
}

/**
 * 跑一个用户输入——从落账到收束（可含多轮）。
 *
 * 返回**这次交代的收场**：`settled`（收束 · 回到等待输入）· `aborted`（被中止）·
 * `error`（出错 / 内核自身异常）· **`rejected`**（这一条**压根没跑**，见下）。
 *
 * ## `rejected`——选定的材料取不到时，这一条不跑（U33 技能 / U36 文件目录同理）
 *
 * 「不跑」是三层意思，三层都要做到：
 * - **不落 `user` 条目**（没有「用户说了什么」这回事——那句话内核没接住）；
 * - **不发 `message.user`**、**不进模型请求**（正文一个字都不送）；
 * - **不换同名项、不忽略那一处继续**（工单明写）——文件读不了、是二进制、超了上限，
 *   与技能主文取不到走**同一条出口**：整条不跑、原稿还回输入区（`input.settled{ok:false}`）。
 *
 * **排队里别的交代照跑**：错的是一条（它选的技能失效了），不是这一队。
 * 把整队清掉＝用户后面那几条**没做错任何事的话**被静默吞了——比多跑一条坏得多。
 * （与「中断清队」的分野也在这儿：那是用户在说「都停下」，这是内核在说「这条不成」。）
 */
export async function agentLoop(
  runtime: LoopRuntime,
  input: UserInput,
  signal: AbortSignal,
): Promise<InputOutcome> {
  const log = entryLogOf(runtime)

  // **按引用取材料**（U36）——正文里的每一处引用各取各的那一份，取不到就停在这一条上
  // （见函数头注）。旧形（`skills`，无位置）走另一条老路：材料统一前置、照旧落旧键。
  const refs = input.refs ?? []
  const selected = input.skills ?? []
  const delivery = await loadRefs(runtime, refs)
  if (!delivery.ok) {
    // 材料取不到＝这一份输入**没进会话**：配对一次 false（说得出是哪一份、为什么）
    refuse(runtime, input, delivery.reason)
    return 'rejected'
  }

  const legacy =
    selected.length === 0
      ? { ok: true as const, used: [] }
      : runtime.skills === undefined
        ? // **没接技能来源**（这次装配压根没装）不是「当作没有技能照跑」——
          // 那正是「丢掉技能后继续这条显式调用」，故与取不到同一条出口
          { ok: false as const, reason: '这次装配没有接技能来源——选定的技能取不了，所以这一条没跑' }
        : runtime.skills.load(selected)

  if (!legacy.ok) {
    refuse(runtime, input, legacy.reason)
    return 'rejected'
  }

  try {
    // 用户输入落账——**轮外**（信封 `turn` 为 `null`：输入先于轮）
    const entryId = await appendUserEntry(log, input.text, {
      refs: delivery.refs,
      skills: legacy.used,
    })
    runtime.sink.emit(runtime.stamper.stamp('message.user', { entry: entryId }))
  } catch (error) {
    // 落账失败＝同样**没进会话**——配对一次 false（不给的话，给了 ref 的那一份草稿
    // 就永远等不到终态）
    refuse(runtime, input, `这一条没能记下来（${messageOf(error)}）——请重新发送`)
    return reportError(runtime, error)
  }

  // **收下了**（U33）——完整输入（正文 ＋ 技能正文）已经落进会话，**落账那一刻就成立**。
  //
  // ⚠️ 它与 `skill.used` **不是同一件事**（2026-09-21 规划裁）：这一条说的是「会话收下了」，
  // 那一条说的是「送进了模型」。故此后模型那边再怎么失败（SDK 参数错 / 网络断 / 被停止），
  // **照模型失败报**（`model.error` · `turn.end{reason:'error'}`），**不撤销这一条**、
  // 也不暗示用户重发——已经进了会话的话，重发就是把同一件事说两遍。
  if (input.ref !== undefined) {
    runtime.sink.emit(runtime.stamper.stamp('input.settled', { ref: input.ref, ok: true }))
  }

  // **回执的兑现点**（收下 ＋ 用到的技能）——**按「这一次交代」记一份账，跨轮不重来**
  // （见 `createAnnouncer`：首轮报过一次就不再报，工具轮再多也只有那一次）。
  // 两形合在一处报：正文里的技能引用（U36）与旧形的 `skills`（U33）——**身份那一栏**
  // （名字 ＋ 来源 ＋ 来源标签）两形都给得出，回执因此不分成两句。
  const announce = createAnnouncer(runtime, [
    ...legacy.used,
    ...delivery.refs
      .filter((ref): ref is Extract<InputRefEntry, { kind: 'skill' }> => ref.kind === 'skill')
      .map((ref) => ({ name: ref.name, source: ref.source, label: ref.label })),
  ])

  for (;;) {
    // 轮间中止——不再开新轮（「回到等待输入」）
    if (signal.aborted) return 'aborted'

    const turn = await runTurn(runtime, signal, announce)
    if (turn.reason !== 'settled' || !turn.continues) return turn.reason
  }
}

/**
 * **「这一次请求真回来了」的证据事件**（U33 · 回执的兑现判据）——只认这三种。
 *
 * 判据是**产出方**：这三种**只能来自供应商的流式响应**——
 * - `model.delta` —— 供应商给的增量（正文 / 思考 / 工具调用）；
 * - `model.usage` —— 收束那一段报的回用量；
 * - `model.call.end` —— 收束（供应商流的 `finish` 那一段到了才吐）。
 *
 * ⚠️ **反过来那三种一律不算**（它们**本地**就产得出来，请求可能压根没发出去）：
 * - `model.call.start` —— 迭代供应商流**之前**就吐了（`normalize.ts`）；
 * - `model.retry` —— 本地退避，一次失败尝试里的信号；
 * - `model.error` —— 本地失败（SDK 参数校验 / 未派发就中止）与远端失败**同形**，
 *   分不出是哪一种，故不能当送达凭据。
 *
 * **空成功、纯工具响应照样闭合**：供应商流收束时一定给 `finish` 那一段，
 * 故「正文一个字都没有」「只有工具调用」这两种也都会走到 `model.call.end`。
 */
const RESPONSE_EVENTS: ReadonlySet<EventKind> = new Set<EventKind>([
  'model.delta',
  'model.usage',
  'model.call.end',
])

/**
 * 系统提示词的两处追加——规约在前、技能目录在后（次序的由头见 `prompt/skills.ts`）。
 *
 * 拆成两个小函数只是为了让上面那行读得出来「谁先谁后」；两处都**不接线就原样交回**。
 */
function withRules(runtime: LoopRuntime): string {
  return runtime.rules?.promptFor(runtime.systemPrompt) ?? runtime.systemPrompt
}

function withSkills(runtime: LoopRuntime, base: string): string {
  return runtime.skills?.promptFor(base) ?? base
}

/**
 * **一次交代的技能回执账**（U33）——只记 `skill.used`，**每个身份只报一次**：
 *
 * | 报什么 | 什么时候 |
 * | --- | --- |
 * | 显式选定的 | 这一次请求**真回来**之后（一次） |
 * | 模型自主取到的 | 带着那份材料的请求**真回来**之后（每个身份一次） |
 *
 * ⚠️ **`input.settled` 不在这儿**（2026-09-21 规划裁）：那条报的是「会话收下了完整输入」，
 * 落账那一刻就成立，与「送没送进模型」是两件事。两者早先绑在同一个时点上，
 * 后果是本地失败（请求压根没发）时两条都不发——`input.settled` 因此违背了
 * 「给了 `ref` 必有终态」那条契约。
 *
 * ## 为什么每个身份只报一次（首轮在这儿栽过）
 *
 * 首轮把「只报一次」写成了 `once(owed)`，而那个包装**造在每一轮的循环里**——
 * 于是每开一轮就多一个「尚未兑现」的新包装，**一条普通的多轮工作会报好几次**
 * 「本次使用技能」。兑现状态因此必须挂在**这一次交代**上：记账的 scope 是
 * `agentLoop` 的一次调用，不是一轮。
 *
 * ## 为什么都在「请求真回来」之后报
 *
 * 「已使用」是一句**当时为真**的话——材料得真的在**这一次发出去的请求**里。两件证据缺一不可：
 * **消息里得有它**（`assembleContext` 那一趟装进去的）＋ **这一趟真回来了**
 * （`RESPONSE_EVENTS`，见 `runTurn`）。装好了不等于发出去；发出去了没有，只有另一端说了算。
 *
 * 自主取到的那些走同一条路：工具结果这一轮才落账，**下一轮**请求才把它装进去，
 * 故它们的兑现点是**下一趟请求真回来**那一刻。
 *
 * ## 自主那条不靠正文推断身份
 *
 * 身份从**工具结果的结构化那一位**来（`ToolResult.skill`，由读技能的那件工具填），
 * 不是从回填正文的抬头里抠出来的——那是拿一句给人看的文案当跨域协议，改个措辞就断。
 * 取**引用**那一趟不带这一位，故「后续引用不重复报整项技能」是结构上就成立的。
 */
/** 一次交代的技能回执账——见 `createAnnouncer`。 */
export type Announcer = {
  /** 工具取到一份技能主文——记着，等它进了下一趟请求、那趟真回来了再报。 */
  deliver(skill: UsedSkill): void
  /** 一趟请求真回来了——把该报的报掉（报过的身份不再报）。 */
  flush(): void
}

function createAnnouncer(runtime: LoopRuntime, selected: readonly UsedSkill[]): Announcer {
  /** 已报过的身份——**同一份材料不报第二遍**（同一次交代里取两次也只报一次）。 */
  const announced = new Set<string>()
  /** 刚取到、还没进过任何请求的那些——攒到下一趟请求真回来再报。 */
  let pending: UsedSkill[] = []
  /** 显式选定那一批是否已经兑现。 */
  let opened = false

  return {
    deliver(skill: UsedSkill): void {
      pending.push(skill)
    },

    flush(): void {
      const fresh: UsedSkill[] = []
      if (!opened) {
        opened = true
        fresh.push(...selected)
      }

      fresh.push(...pending)
      pending = []

      const tell = fresh
        .filter((one) => !announced.has(identityOf(one)))
        .map((one) => {
          announced.add(identityOf(one))
          return one
        })

      if (tell.length > 0) {
        runtime.sink.emit(runtime.stamper.stamp('skill.used', { skills: tell }))
      }
    },
  }
}

/**
 * 取齐这一条交代里的引用（U36）——**没接引用送达＝没有引用可取**。
 *
 * 三态收在一处：给了引用但这次装配没接送达（`rejected`，与「取不到」同一条出口——
 * 那正是「丢掉材料继续跑」）· 取不到（`rejected`）· 取齐了。
 */
async function loadRefs(
  runtime: LoopRuntime,
  refs: readonly InputRef[],
): Promise<{ readonly ok: true; readonly refs: readonly InputRefEntry[] } | { readonly ok: false; readonly reason: string }> {
  if (refs.length === 0) return { ok: true, refs: [] }
  if (runtime.refs === undefined) {
    return { ok: false, reason: '这次装配没有接材料来源——交代里的引用取不了，所以这一条没跑' }
  }

  return runtime.refs.load(refs)
}

/** 一份输入**没进会话**——配对一次 `ok:false`（给了 `ref` 才发；失败不静默）。 */
function refuse(runtime: LoopRuntime, input: UserInput, reason: string): void {
  runtime.sink.emit(
    runtime.stamper.stamp('input.settled', {
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      ok: false,
      reason,
    }),
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 技能的身份（报重了没有按它判）：名字 ＋ 来源路径，两件缺一都不是同一份。 */
function identityOf(skill: UsedSkill): string {
  return [skill.name, skill.source].join('\u0000')
}

// ══ 一轮 ══════════════════════════════════════════════════════════════

async function runTurn(
  runtime: LoopRuntime,
  signal: AbortSignal,
  /**
   * 这次交代的回执账——**每趟请求的第一条事件到手时** `flush()` 一次（见 `createAnnouncer`）。
   * 报什么、报几次由账自己判，故逐条调也无妨。
   */
  announce: Announcer,
): Promise<TurnOutcome> {
  const { gateway, tools, sink, stamper } = runtime

  // 轮起——铸造器的 `turn` 自此生效（轮内所有事件共用它）
  stamper.beginTurn(runtime.nextTurnId())

  try {
    sink.emit(stamper.stamp('turn.start', {}))

    // **触发之一：用量达阈值**——压了再跑（见文件头注：撞上超限要白搭一次调用）。
    // 压不成也照常往下走：这是「尽力收敛上下文」，不是本轮的前置条件（B5）
    const compact = runtime.compact
    if (compact !== undefined && compact.needed()) {
      await compact.run({ trigger: 'threshold', signal })
    }

    let text = ''
    /** 思考通道的正文——**只为 D6 的判据攒着**（不落条目，条目只载正文）。 */
    let thinking = ''
    /** 本轮的聚合结果——超限重发时会被下一次调用覆盖（上一次的结论已作废）。 */
    let result: ModelResult
    /** 超限重发**只给一次机会**（见文件头注）——压完还超限就是真塞不下了。 */
    let retried = false

    // 一次调用 ＋ 消费（超限时整体重来：重装配 → 重发——这才是「压缩后重发」）
    for (;;) {
      const messages = await assembleContext({
        records: runtime.records,
        session: runtime.session,
        // **项目规约 ＋ 技能目录**在装配这一步接上（U32 · U33）——都现取现接：
        // 改过的下一趟就是新的。次序＝环境块 → 规约块 → 技能目录块（见 `prompt/skills.ts`）；
        // 规约那一趟还顺带记账「这一趟送出去哪几版」（预查据它判「拦不拦」）
        systemPrompt: withSkills(runtime, withRules(runtime)),
        blobTextLimit: runtime.blobTextLimit,
        // 近段条数取压缩器那个数（没接压缩器＝按缺省认，与策略缺省同源）
        nearEntries: runtime.compact?.nearEntries ?? DEFAULT_NEAR_ENTRIES,
      })

      const stream = gateway.stream(
        { model: runtime.model, messages, tools: tools.definitions() },
        { signal },
      )

      text = ''
      thinking = ''
      let errored = false
      let tier: ModelErrorTier | undefined
      /**
       * 这一趟请求的**回执欠账还没还**——还的时机是**它真回来了**（见下）。
       */
      let owed = true

      for await (const event of stream.events) {
        // 模型域的事件**原样转发**（`model.call.start` / `model.delta` / `model.usage` /
        // `model.call.end` / `model.error`）——过程流的消费者（渲染 / 记录）按 kind 收窄
        sink.emit(event)

        // **回执在这儿发**（U33）——**这一次请求真回来了**之后，不是「有事件」就发。
        //
        // ⚠️ **首轮在这儿栽过**，记下来免得再犯：当时的判据是「第一条事件到手」，
        // 而真实模型域的第一条**恒为 `model.call.start`**——它是**本地**产的
        // （`normalize.ts`：先 yield 它，之后才去迭代供应商流；`retry.ts`：迭代才调
        // SDK 的 streamer，参数校验与 fetch 都在其后）。于是三条全是假阳性：
        // SDK 参数校验失败（`fetchCalls=0`，请求压根没发）、`call.start` 之后被中止、
        // 本地抛错——它们都**已经发过了 `call.start`**，回执照报成功。
        //
        // 判据因此收紧成「**这一次请求真回来了**」：只有**供应商那边产出的**事件才算数
        // （见 `RESPONSE_EVENTS`）。材料确实在这一次的消息里（`messages` 就是刚装出来、
        // 交给 `gateway.stream` 的那一份），而「回来了」是另一端给的证据——
        // 两边都成立，「这份材料进了实际请求」才是一句有据的话。
        //
        // 报什么由账自己判（报过的身份不再报、`input.settled` 只报一次）——
        // 故逐条调都行，重发那一趟（超限重试）也照旧只报一次。
        if (owed && RESPONSE_EVENTS.has(event.kind)) {
          owed = false
          announce.flush()
        }

        if (event.kind === 'model.delta' && event.data.channel === 'text') text += event.data.text
        if (event.kind === 'model.delta' && event.data.channel === 'thinking') thinking += event.data.text
        // 用量是**压缩的触发读数**（分子 / 分母一次到齐——D10 的口径）
        if (event.kind === 'model.usage') compact?.observe(event.data)
        // `model.error` 是本轮定论的信号（不变式 ④：其后无事件）；聚合结果里没有错误位
        if (event.kind === 'model.error') {
          errored = true
          tier = event.data.tier
        }
      }

      result = await stream.result

      // 被中止——半截流式消息**丢弃**，本轮就此收束
      if (signal.aborted) return close(runtime, 'aborted', false)
      if (!errored) break

      // **触发之二：上下文超限**——压一次再重发（不换模型）。
      // 压成了才重发：压不动（或本就没接压缩）就没什么可重发的，照旧停下报告用户
      if (tier === 'context-limit' && !retried && compact !== undefined) {
        retried = true
        const outcome = await compact.run({ trigger: 'context-limit', signal })
        if (outcome.ok) continue
      }

      return close(runtime, 'error', false)
    }

    const calls = result.toolCalls ?? []

    // 正文落账 ＋ `message.assistant`（事件只记「发生 + 引用」）
    //
    // ⚠️ **D6：整轮什么都没产出（正文空 · 思考空 · 没有工具调用）⇒ 不落条目、不发事件**
    // ——那种轮次毫无内容，落了就是条目流里的一行噪声、上下文里的一条空消息，
    // 屏上还会多一个孤零零的标记（外壳侧另有一道「空内容不渲染」的兜底）。
    //
    // ⚠️ **但有工具调用时这条条目必须落**——它是上下文装配**配对的锚**：
    // 装配自 `assistant` 条目往后扫「`tool-call` ＋ 紧随的 `tool-result`」对
    // （见 `context.ts`）；锚没了，这一轮的工具往返**整段进不了上下文**
    // （实测：第 2 次模型调用的 messages 里连 `role:'tool'` 都没有）。
    const blank = text.trim() === '' && thinking.trim() === '' && calls.length === 0
    const assistantId = blank ? undefined : await appendTextEntry(entryLogOf(runtime), 'assistant', text)
    if (assistantId !== undefined) {
      sink.emit(stamper.stamp('message.assistant', { entry: assistantId }))
    }

    if (calls.length === 0) return close(runtime, 'settled', false) // 收束——回到等待输入

    // **目标预查（U32）**——动手**之前**看这一批的目标上有没有**还没送达**的规约。
    // 有：这一批**一份都不执行**（全都还没执行，故全都回填「需重审」），让模型照新规约
    // 复核后重提。整批一起拦而不是逐条拦：同一批里前几条已经动过、后几条才拦住的话，
    // 「照新规约重新提」这句话就只对一半的调用成立——那比整批重提更费解。
    //
    // 三选一（`PreflightResult`）：放行 / 需重审 / **材料超限、这批停在这儿**。
    // 后两种都**不执行**，但**回填的话不同**——超限那种要让模型去告诉用户，不是重提。
    const check = runtime.rules?.preflight(calls) ?? { kind: 'pass' as const }
    const heldText =
      check.kind === 'review'
        ? needsReviewText(check.blocking)
        : check.kind === 'overflow'
          ? overflowText()
          : undefined

    // 同轮多工具——**按序逐个**（并行执行留后评估）；一个被拒只影响该调用
    for (const call of calls) {
      if (signal.aborted) return close(runtime, 'aborted', false)
      if (heldText !== undefined) withholds(runtime, call, heldText)
      else await runToolCall(runtime, call, signal, announce)
    }

    return close(runtime, signal.aborted ? 'aborted' : 'settled', !signal.aborted)
  } catch (error) {
    // 兜底——内核自身异常（非模型 / 工具域）：产生方就近发 `error`，本轮以「错误」收束
    return close(runtime, 'error', false, error)
  } finally {
    // 轮止——`undefined` ＝轮外（信封的 `turn` 落 `null`）
    stamper.beginTurn(undefined)
  }
}

/**
 * 一次工具调用——调用条目落账 → `invoke`（闸门在路径内）→ 结果条目落账。
 *
 * 对话域**不经手闸门、不经手沙箱**：`ToolRuntime.invoke` 内部才是「请求 → 闸门 →
 * 执行 → 回填」（技术方案 · 工具域）——本域只把结果回填给模型。
 *
 * 结果的两样输出（第 2 轮 · 契约补锚）由 `toolOutcomeOf` 各归其位：面向模型的文本进条目
 * 正文、记录侧形态进载荷（见 `./entries.ts`）。
 */
async function runToolCall(
  runtime: LoopRuntime,
  call: ToolCall,
  signal: AbortSignal,
  announce: Announcer,
): Promise<void> {
  const log = entryLogOf(runtime)

  // 调用条目先落账——它与结果条目成对，「有调用无结果」＝在途（阶段 2 恢复按它找）
  appendToolCallEntry(log, call)

  let outcome: ToolOutcome
  try {
    // `opts.onOutput` 留空：`tool.output.delta` 是**工具域**的产出（事件产出表）——
    // 本域不越俎；该位留给将来的消费方（如外壳侧的实时视图）。
    outcome = toolOutcomeOf(await runtime.tools.invoke(call, { signal }))
    // **模型自主取到一份技能主文**（U33）——记进回执账，等它进了下一趟请求再报
    // （身份由工具结构化给出，不从回填正文里认；取引用那一趟不带这一位）
    if (outcome.skill !== undefined) announce.deliver(outcome.skill)
  } catch (error) {
    // 端口承诺「结果，不是异常」（与沙箱同法）；抛了＝工具域违约。
    // 不炸掉整轮：以失败回填——模型与用户都看得到「这次没成」。
    // 违约路径**编不出** `ToolResult`（链引用无从取得），故就地造落账形态：两样都内联
    const text = `工具调用异常：${describeError(error)}`
    outcome = { ok: false, text, content: { text } }
  }

  const resultId = appendToolResultEntry(log, outcome)
  announcePlan(runtime, outcome, resultId)
}

/**
 * **计划变更的通报**（U34）——**条目成功追加之后**才发（`appendToolResultEntry` 已经返回
 * 才走到这里；它抛了就轮不到这一行）。
 *
 * 为什么是这个时机（设计 · 技术实现方案 3 的那一条）：
 * - 工具域早先发的 `tool.result` **不能**当「计划已保存」的证明——那只说明调用跑完了，
 *   条目还没影；
 * - 追加失败**不能**对模型或界面报更新成功——落账前失败＝保持旧计划（旧内容还在记录里），
 *   而界面照旧看着上一份清单，两边说的是同一件事。
 *
 * 判据是 `undefined`（不在场）而非真假：`plan: null` 是**清空**，也要报（界面据它移除清单）。
 */
function announcePlan(runtime: LoopRuntime, outcome: ToolOutcome, entry: RecordId): void {
  if (outcome.plan === undefined) return

  runtime.sink.emit(runtime.stamper.stamp('plan.changed', { entry, plan: outcome.plan }))
}

/**
 * **扣下**一次调用（U32 · 目标预查拦下的那一批）——落账一对条目 ＋ **发一对事件**，
 * **不碰工具域**（连闸门都没问）。
 *
 * - **配对要闭合**（设计 · 项目规约第 4 条明写）——条目上照样落 `tool-call` ＋ `tool-result`
 *   一对。少落一个，上下文装配那边会把它当成**在途调用**（`context.ts` 的文件头注 2），
 *   这一批就从模型眼前整段消失，连「为什么没执行」都看不见了。
 * - **事件上同样要闭合**（2026-09-20 裁，改了首轮的口径）：首轮**一个事件都不发**，
 *   理由是「那两个是工具域的产出，而这次没到工具域」。那个理由在**记录**那一面站得住，
 *   在**界面**那一面站不住——真流式增量会先按 toolcall 通道建出一行工具
 *   （`model.delta`），而这一行等的是 `tool.call` 来认领；不发的后果是**屏上留一个
 *   永远转圈的幽灵工具**（`running · call: null`），外头早就空闲了它还在那儿转，
 *   而用户永远不知道那几个文件**压根没写**。
 *
 *   故**复用现有的工具事件与结果**（工单 6 的裁法）：`tool.call` ＋ 紧跟着的 `tool.result`，
 *   一对**齐来齐走**。恢复的「在途识别」找的是「有 `tool.call` 无 `tool.result`」那几笔
 *   （`scanForRecovery`），**成对发**进去的是一笔**已了结**的调用，不是假在途。
 *   也不新立「未执行」这种第二套在途状态——外壳照既有那一套画，只是结果写着没执行。
 * - **不宣称副作用已执行**：结果 `ok: false` ＋ `notExecuted`（见函数体），正文照
 *   `needsReviewText`（或超限那份 `overflowText`）说清**没执行 · 为什么 · 下一步怎么办**。
 */
function withholds(runtime: LoopRuntime, call: ToolCall, text: string): void {
  const log = entryLogOf(runtime)

  appendToolCallEntry(log, call)
  const opened = runtime.stamper.stamp('tool.call', { name: call.name, args: call.args })
  runtime.sink.emit(opened)

  // **「没跑」由产生处写死**（`notExecuted`）：条目与事件**同源同带**——外壳实时看事件、
  // 切会话回来看条目，两路读的是这一位。此前谁都没记，下游只好拿结果正文首行去猜
  // （2026-09-20 三轮裁，改的正是那条正文协议）。
  appendToolResultEntry(log, { ok: false, text, content: { text }, notExecuted: true })
  runtime.sink.emit(
    runtime.stamper.stamp('tool.result', {
      call: opened.id,
      ok: false,
      output: { text },
      notExecuted: true,
    }),
  )
}

// ══ 收场 ══════════════════════════════════════════════════════════════

/** 本轮收束——发 `turn.end` 并交回结束方式。`error` 给了就顺带发兜底的 `error` 事件。 */
function close(
  runtime: LoopRuntime,
  reason: TurnEndReason,
  continues: boolean,
  error?: unknown,
): TurnOutcome {
  if (error !== undefined) {
    runtime.sink.emit(
      runtime.stamper.stamp('error', { message: `对话域异常：${describeError(error)}` }),
    )
  }

  runtime.sink.emit(runtime.stamper.stamp('turn.end', { reason }))
  return { reason, continues }
}

/** 兜底（轮外）——内核自身异常：发 `error` 事件并交回结束方式。 */
function reportError(runtime: LoopRuntime, error: unknown): TurnEndReason {
  runtime.sink.emit(
    runtime.stamper.stamp('error', { message: `对话域异常：${describeError(error)}` }),
  )
  return 'error'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 落账依赖束——由运行时装配（时钟与阈值只此一处传给条目侧）。 */
function entryLogOf(runtime: LoopRuntime): EntryLog {
  return {
    records: runtime.records,
    now: runtime.now,
    blobThreshold: runtime.blobThreshold,
  }
}
