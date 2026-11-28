import { pendingViews } from '@magic/contracts'
import type { InputManage, CompactState } from '@magic/contracts'
/**
 * **一条会话的实例**（`ConversationSession`）——`ConversationService` 的**单会话那一半**。
 *
 * 「`ConversationService`」这个名字在 U16 之后指**会话主面**（`./sessions.ts`）——
 * 设计原话（技术方案 · 领域划分 · 端口签名）：「多会话（阶段 2）的新建 / 切换 / 列表在此
 * 扩展」，故端口由主面实现（单活跃：它持一个活跃会话，`submit` / `interrupt` 转发过去）。
 * 本文件产出的就是**被它持有的那一条**——名字取 `Session` 以免与端口撞脸
 * （U04 时两者是一件事，U16 起不是了）。
 *
 * **本类只做五件**（其余在 `./agent-loop.ts`）：排队 · 中断 · 状态转场 ·
 * **重建**（`rebuild()`——恢复的第 ⑤ 步：装载 ＋ 认下水位于开工位，编排归应用层）·
 * **忙碌位**（`busy()`——主面据以拒绝「忙时切会话」）。
 *
 * - **排队**——一次只干一件；干活时又来交代，排着（收束后接着跑）。端口是 `void`：
 *   工作异步跑，调用方不等。
 * - **中断**——在途打断（`signal` 落到模型流与工具）＋ **排队中的交代保留并标为未执行**
 *   （U50）：停止后不接着跑（否则与「回到等待输入」相抵），但也不丢（见 `holdQueued`）。
 *   **空闲时打断＝无事**——「空闲时 Ctrl+C ＝ 退出」由外壳发起（首站不设确认），本域不猜。
 * - **状态转场**——`agent.start`（**首次开工前**发，构造期不发：外壳那时还没订上——装配
 *   纪律「先接订阅、后放开输入」）· `agent.state{resumed}`（干活）· `agent.state{waiting}`
 *   （回到等待输入）。`paused` 是阶段 2 的留位（恢复流程 / 人在环的长暂停），首站不产。
 *
 * 域内件（不上公开面）：提示词部件的读取面 · 装配（`assembleContext`）· 循环（`agentLoop`）·
 * 条目落账——域外本不该看见（深链由守护拦）。
 *
 * ⚠️ **恢复本域只做第 ⑤ 步**（U25 起）——① 在途识别（记录域的查询面）· ②③④ 处置
 * （重放 / 落账 / 记中止）由**应用层**（`@magic/actions`）编排。此前那五步全在本域
 * （U15 的 `recovery.ts`），于是「对话域既当核心域、又兼编排者」——「域之上」那一层
 * 因此一直空着（审计第 1 条：恢复入口没有归处）。
 */

import type {
  BackgroundRunning,
  EventSink,
  EventStamper,
  Materials,
  ModelGateway,
  ProjectRules,
  RecordsService,
  RebuildHandoff,
  SessionId,
  Skills,
  Timestamp,
  ToolRuntime,
  TurnId,
  UserInput,
} from '@magic/contracts'
import type { LoopRuntime } from './loop-runtime.ts'
import type { CollaborationBoundary } from './collaboration.ts'
import { agentLoop } from './agent-loop.ts'
import { messageOf, prepareInput } from './input-intake.ts'
import { acceptInput, manageInput, type QueueItem } from './input-ledger.ts'
import { createCompactor } from './compact.ts'
import { DEFAULT_CONTEXT_POLICY } from './policy.ts'
import type { ContextPolicy } from './policy.ts'
import { buildSystemPrompt } from './prompt/index.ts'
import type { PromptVars } from './prompt/index.ts'
import { createRefDelivery } from './refs.ts'
import { createRulesDelivery } from './rules.ts'
import { createSkillsDelivery } from './skills.ts'
import { createSessionTitleService } from './session-title.ts'

/**
 * 装配期构造入参——一切「谁来实现」的选择由装配根给出（本域不知道背后是谁：
 * 模型域 / 工具域 / 记录域皆经契约端口）。
 */
export type ConversationDeps = {
  readonly knowledge?: import('@magic/contracts').KnowledgeRecords
  readonly notes?: import('@magic/contracts').WorkingNotes
  readonly noteTools?: (notes: import('@magic/contracts').WorkingNotes) => ToolRuntime
  readonly capacity?: () => import('./organize.ts').PreparationCapacity
  readonly onInput?: (input: UserInput) => void
  readonly collaboration?: CollaborationBoundary | undefined
  readonly purpose?: 'consultation' | undefined
  readonly consultationAvailable?: boolean | undefined
  /** 会话——条目按会话读；信封的 `session` 由铸造器持（装配按会话实例构造，两处同源）。 */
  readonly session: SessionId
  /** 当前模型身份（用后留痕到 steps.provider/model）；缺省不记。 */
  readonly stepIdentity?: (() => { readonly provider: string; readonly model: string } | undefined) | undefined
  /** 提示词运行时注入值（`cwd` / `platform` / `date`）——**缺项在构造期就报错**。 */
  readonly prompt: PromptVars
  readonly gateway: ModelGateway
  readonly continuationGateway?: ModelGateway
  readonly tools: ToolRuntime
  readonly records: RecordsService
  readonly sink: EventSink
  /** 信封铸造器——**产出方铸**（装配按会话实例构造；`turn` 由本域在轮起止时调）。 */
  readonly stamper: EventStamper
  /**
   * 时钟——条目时间戳（记录域不取时钟，U02 备案）；缺省 `Date.now`。
   * 显式注入便于测试（域不各自读时钟，取用经此一处——与权限域的 `now` 同法）。
   */
  readonly now?: (() => Timestamp) | undefined
  /** 上下文策略——缺省 `DEFAULT_CONTEXT_POLICY`（含压缩的触发阈值与近段边界）。 */
  readonly context?: Partial<ContextPolicy> | undefined
  /**
   * **项目规约的来源面**（U32 · 执行域实现）——缺省＝这个工作区不加载规约
   * （**行为与加这一条之前一字不动**：没有系统提示词追加块、没有工具预查拦截）。
   *
   * 只出「读」的那一半：**什么时候送、送哪些**归本域（见 `./rules.ts`），
   * **允许读哪些**归装配（它拿用户配置的 `rules.sources` 去造这个实现）。
   */
  readonly rules?: ProjectRules | undefined
  /**
   * **技能来源面**（U33 · 执行域实现）——缺省＝这个工作区不发现也不加载技能
   * （**行为与加这一条之前一字不动**：没有目录块、显式选定的技能也不取）。
   *
   * 与 `rules` 同一分工：**什么时候送、送哪一份**归本域（见 `./skills.ts`），
   * **允许读哪些**归装配（它拿 `skills.sources` 与用户目录去造这个实现）。
   *
   * ⚠️ **同一份实现还要交给工具域**（模型自主选用走 `skill` 工具）——「同一个来源口」
   * 是工单明写的：两条选用路径读的是**同一个 `Skills` 实例**，故「有什么、在哪儿」
   * 两边不会各说一套。
   */
  readonly skills?: Skills | undefined
  /**
   * **材料来源面**（U36 · 执行域实现）——正文里的 `@文件` / `@目录` 由它取。
   *
   * 与 `skills` 同一分工（**什么时候送**归本域，**允许读哪些**归装配），
   * 且**只出读的那一半**：工作区外的路径不因输入 `@` 而获准，唯一进口是用户明确选定的
   * 那一个只读附件（见契约 `Materials` 的三条边界）。
   *
   * 缺省＝这个工作区不取文件 / 目录材料：带引用的那一条交代**不跑**（`rejected`），
   * 不当作没有引用照跑。
   */
  readonly materials?: Materials | undefined
  /**
   * **当前模型吃不吃图**（U37）——三态探针（明确支持 / **明确不支持** / 不知道），
   * 由装配给（注册表与模型信息缓存在它那一层，本域不认识模型）。
   *
   * 缺省＝不知道：带图照发，请求真失败再如实报错（见 `LoopRuntime.acceptsImages`）。
   */
  readonly acceptsImages?: (() => boolean | undefined) | undefined
  /**
   * **这一条交代此刻发得出去吗**（U60）——发不出去就回一句**给人看的话**
   * （`undefined` ＝发得出去）。
   *
   * 由装配给（「有没有可走的连接」是它那一层的账，本域不认识供应商）。用途只有一个：
   * **压根没有可走的模型时**，在落账之前把这一条拦下来——不给它开一轮、
   * 不落 `user` 条目、屏上不出现「工作中」（见 `LoopRuntime.submitRefusal`）。
   *
   * 不给这一位（旧装配、用例）＝恒 `undefined`（行为与加它之前一字不动）。
   */
  readonly submitRefusal?: (() => SubmitRefusal | undefined) | undefined
  /**
   * **这条会话此刻还在跑的后台命令**（U89）——每请求现取一次，接成一个追加块
   * （见 `./prompt/background.ts`）。
   *
   * 由装配给，理由同 `acceptsImages`：**「哪几条是这条会话交出去的」只有它知道**
   * （登记是进程级的，它只知道「哪些进程还站着」，不知道那是谁交的），本域不认识会话之外的东西。
   *
   * 不给这一位（旧装配、用例）＝**这一块压根不接线**（行为与加它之前一字不动）；
   * 给了一位而它这一趟回空表＝**这一块不出现**（没有后台任务就不占位，工单明文）。
   */
  readonly background?: (() => readonly BackgroundRunning[]) | undefined
  /**
   * **AI 标题的写面**（docs/会话标题方案.md）——首条真实用户交代落账后，旁路调一次当前模型
   * 起标题，写入与改名**同一个字段**（`sessions.title`）。装配接 `recordsStore.setSessionTitle`。
   *
   * 缺省＝这条会话**不做 AI 标题**（行为与加它之前一字不动——既有用例的脚本对齐不受影响）。
   */
  readonly setTitle?: ((session: SessionId, title: string, at: Timestamp) => void) | undefined
}

/**
 * **一条交代被拦下来的结论**（U60）——为什么，以及那一份稿子怎么处置。
 *
 * 形态定在这儿（而不是主循环那一边）：它是**构造入参**的一部分，而本文件就是入参形态的
 * 落点（见 `index.ts` 那张表；`LoopRuntime` 只是它的一个视图，用 `import type` 取）。
 */
export type SubmitRefusal = {
  /** **为什么**——给人看的一句话（本域一个字都不加工，原样落进 `input.settled.reason`）。 */
  readonly reason: string
  /**
   * **这一份草稿还回输入行吗**——缺省还（U33 起的老规矩：没送出就不丢稿）。
   *
   * `false` 只有一个由头：**下一步要敲的是一条命令**（还没接供应商时得先去
   * `/model connect`）——稿子还回输入行的话，那条命令会接在稿子尾巴上
   * （`你好/model connect`），成了一句谁也不认的话。稿子**不丢**：它在 `↑` 历史里
   * （`sendInput` 交出去那一刻就记下了），故这儿的取舍是「换个地方放着」，不是「丢掉」。
   */
  readonly keepDraft?: boolean
}

/**
 * 一条会话的实例（域内形态）——主面持它、转发控制面的 `submit` / `interrupt`。
 *
 * **`rebuild()` 的触发点**（恢复的第 ⑤ 步）：它**不发事件**（回来的那两句 `agent.start` /
 * 补记的事件都是应用层发的），故不比谁先谁后；但**干活时不许调**——那会与循环抢同一条
 * 记录流（这道闸在本文件里落成一次抛，见 `rebuild()` 的实现；契约那面只写了
 * 「①②③④ 归应用层、⑤ 归本面」的分工）。
 *
 * **`busy()`** 是主面的判据（U16）：忙时不许切会话——半途切＝一轮的事记到两条会话上。
 * 它只是**读**一个内部位，不改变任何行为（域内件，不外承诺）。
 */
export type ConversationSession = {
  /** 同一压缩链；忙时等待完整交互边界，空闲时不启动业务循环。 */
  compact(request: { requestId: string; focus?: string }, signal: AbortSignal, started: () => void): Promise<CompactState>
  /** 收件唤起，不伪造用户消息。 */
  wake(): void
  supplement(input: UserInput, shared: boolean): Promise<void>
  manage(command: InputManage): void
  submit(input: UserInput): void
  interrupt(): void
  shutdown(): Promise<void>
  /** 重建这条会话的现场——装载 ＋ 认下水位于开工位（见 `RebuildHandoff`）。 */
  rebuild(handoff: RebuildHandoff): RebuildReport
  /** 正在干活（一轮在跑 / 排队中的交代还在）——主面据以「忙时切不动」。 */
  busy(): boolean
}

/** 重建的回报（域内形态，不进契约）——认下了什么，如实说回来。 */
export type RebuildReport = {
  readonly session: SessionId
  /** 认下的轮号水位（下一轮接着它走）。`null` ＝记录里还没有过轮。 */
  readonly lastTurn: TurnId | null
}

/**
 * 造**一条会话**的实例——装配的 `open` 工厂按会话各造一份（主面经它持有活跃那条）。
 *
 * **构造期即装配提示词**：注入值缺项（未给 / 空串 / 纯空白）当场抛 `PromptVarsError`
 * ——不静默降级，也不拖到第一轮才炸（「缺值报错不降级」，提示词部件的既定口径）。
 */
export function createConversationSession(deps: ConversationDeps): ConversationSession {
  const { sink, stamper } = deps
  const policy: ContextPolicy = { ...DEFAULT_CONTEXT_POLICY, ...deps.context }

  /**
   * 轮号下限——恢复时由记录里的最大轮号抬起；记录域分配时取 `max(库内 seq, 下限) + 1`。
   * 库内水位与恢复水位同源，这里只负责把「崩溃点之后接着走」的语义传下去。
   */
  let turnFloor = 0
  let started = false
  let flight: Promise<void> = Promise.resolve()

  /**
   * **队列状态束**（T2.5 第四刀 · 分治的载体）——消费队列的共享可变状态收拢一处，
   * 供输入受理（`input-ledger.ts`）与队列本体（本文件）共用：布尔位按对象属性共享
   * （原始值传参不共享），队列数组按引用共享。
   */
  const state = {
    closed: false,
    running: false,
    /** 在途工作的中止手柄——`interrupt` 的唯一着力点（空闲时为 `undefined`）。 */
    current: undefined as AbortController | undefined,
  }
  /**
   * 排队中的交代——**整份 `UserInput`**（U33 起；此前是 `string[]`）。
   *
   * 每一份都**固定着它自己绑的技能**：排着的时候不与别条共享任何可变状态
   * （没有「当前技能」那种东西可读），故忙时两条不同技能的交代出队后**各自身份不串**。
   */
  const pending: {input:UserInput|undefined;shared:boolean;done?:()=>void}[] = []
  // 在模型/工具边界读取补充，避免将 user 条目插入在途 tool-call/result 中间。
  const supplements: { input: UserInput; shared: boolean; done: () => void }[] = []
  /** **打断插入式**的队列（option+回车）：只在下一请求边界（工具结果之后、下一请求之前）并入。 */
  const inserts: { input: UserInput; shared: boolean; done: () => void }[] = []
  const collaboration: CollaborationBoundary = {
    context: () => Promise.resolve(undefined),
    requested: () => {},
    ...deps.collaboration,
    admit: call => state.current?.signal.aborted === true ? '已停止，未消费输入' : deps.collaboration?.admit(call),
    async consume() {
      await flushCompact()
      let changed = false
      for (const next of supplements.splice(0)) {
        try {
          const prepared = await prepareInput(runtime, next.input, entry => deps.collaboration?.userInput?.(entry, next.shared), state.current?.signal)
          changed ||= prepared !== undefined
        } finally { next.done() }
      }
      return (await deps.collaboration?.consume()) || changed
    },
  }

  // 压缩用量与准备状态随会话实例持有。
  let inputVersion = 0
  const compactor = createCompactor({
    records: deps.records, session: deps.session, gateway: deps.continuationGateway ?? deps.gateway,
    ...(deps.notes ? { notes: deps.notes } : {}), ...(deps.noteTools ? { noteTools: deps.noteTools } : {}),
    ...(deps.capacity ? { capacity: deps.capacity } : {}), inputVersion: () => inputVersion,
    sink, stamper, now: deps.now ?? Date.now, ...(policy.nearTokens === undefined ? {} : { nearTokens: policy.nearTokens }),
    compactAtFraction: policy.compactAtFraction, compactAtTokens: policy.compactAtTokens,
  })

  /**
   * **AI 标题**（docs/会话标题方案.md）——写面接了才造（缺省＝这条会话不做，行为与
   * 加它之前一字不动）。网关与压缩摘要同路（`continuationGateway ?? gateway`——旁路
   * 调用不走协作包装：不登记执行、不参与停点核销，见 `title.ts` 头注）。
   */
  const titles = deps.setTitle === undefined ? undefined : createSessionTitleService({
    session: deps.session, gateway: deps.continuationGateway ?? deps.gateway,
    records: deps.records, setTitle: deps.setTitle, now: deps.now ?? Date.now,
  })

  /**
   * **规约的送达账**（U32）——按会话实例各一份（作用域与最近一次请求送达的材料都随会话走：
   * 切到别的会话，那一头碰过哪些目录、手里握着哪份材料，与这一头无关）。
   * 不给规约来源＝不造这份账（见 `ConversationDeps.rules`）。
   */
  const rules = deps.rules === undefined ? undefined : createRulesDelivery(deps.rules)

  /**
   * **技能送达**（U33）——按会话实例各造一份（它不存状态，「各一份」只是跟着运行时走）。
   * 不给技能来源＝不造（见 `ConversationDeps.skills`）。
   */
  const skills = deps.skills === undefined ? undefined : createSkillsDelivery(deps.skills)

  /**
   * **引用送达**（U36）——正文里带位置的那一份（技能 / 文件 / 目录一并）。
   *
   * 与 `skills` 各管一形：旧形（`UserInput.skills`，无位置）走上面那一份、照旧统一前置；
   * 新形（`UserInput.refs`）走这一份、**按位置展开**。两份都由同一对来源面喂
   * （`deps.skills` 与 `deps.materials`）——两形读的是同一棵树，不会各说一套。
   */
  const refs = createRefDelivery({
    records: deps.records, session: deps.session, knowledge: deps.knowledge, notes: deps.notes,
    skills: deps.skills,
    materials: deps.materials,
    // 图片的字节要进记录（U37）——写权唯一归记录域，故经它的公开面
    blobs: deps.records.blobs,
  })

  let compactPending: {
    request: { requestId: string; focus?: string }; controller: AbortController
    signal: AbortSignal; started: () => void; finish: (state: CompactState) => void; notesSaved: boolean; awaitInput: boolean
  } | undefined
  let compactFlight: Promise<void> | undefined
  function flushCompact(): Promise<void> {
    if (compactFlight !== undefined) return compactFlight
    const operation = compactPending
    if (operation === undefined) return Promise.resolve()
    // **「下一件」被委派收束持有的停顿就是边界**（P0 修复）：轮队列停在
    // waitingForDelegations 上时不会再有条目落账——把「pending 非空」当「还有输入要落」
    // 会让压缩永远等不到边界，而 startDrainIfIdle / wake 又闸在 compactPending 上，
    // 双方互相卡死（busy 恒真）。此时放行压缩；队列继续等委派收束。
    const heldForDelegations = !state.running && waitingForDelegations(pending[0]?.input)
    if (!operation.signal.aborted && (supplements.length > 0 || (pending.length > 0 && !heldForDelegations) || (operation.awaitInput && state.running))) return Promise.resolve()
    compactFlight = Promise.resolve().then(async () => {
      const base = { requestId: operation.request.requestId, ...(operation.request.focus === undefined ? {} : { focus: operation.request.focus }), accepted: true as const }
      try {
        operation.signal.throwIfAborted()
        operation.started()
        operation.started = () => {}
        for (;;) {
          const outcome = await compactor.run({ trigger: 'threshold', signal: operation.signal, compact: operation.request })
          operation.notesSaved ||= outcome.notesSaved
          if (!outcome.ok && outcome.kind === 'changed' && !operation.signal.aborted) {
            if (pending.length > 0 || supplements.length > 0) { operation.awaitInput = true; return }
            continue
          }
          operation.finish(outcome.ok ? { ...base, state: 'completed', summary: outcome.summary, notesSaved: operation.notesSaved } : {
            ...base, state: outcome.kind === 'canceled' ? 'cancelled' : outcome.kind === 'no-material' ? 'no-material' : 'failed', reason: outcome.reason, notesSaved: operation.notesSaved,
          })
          if (compactPending === operation) compactPending = undefined
          break
        }
      } catch (error) { operation.finish({ ...base, state: operation.signal.aborted ? 'cancelled' : 'failed', reason: messageOf(error), notesSaved: operation.notesSaved }); if (compactPending === operation) compactPending = undefined }
      finally {
        compactFlight = undefined
        if (!state.closed && !state.running && pending.length > 0) startDrain()
      }
    })
    return compactFlight
  }

  /** 输入受理的依赖束——账本操作（input-ledger.ts）经它拿队列状态与触发排空。 */
  const bundle = {
    deps, sink, stamper, state, pending, supplements, inserts,
    onVersionBump: () => { inputVersion++ },
    startDrainIfIdle: () => { if (!state.running && compactPending === undefined) startDrain() },
  }

  const runtime: LoopRuntime = {
    knowledge: deps.knowledge,
    session: deps.session,
    systemPrompt: buildSystemPrompt(deps.prompt, deps.purpose, deps.consultationAvailable) + (deps.notes ? `\n\n自身工作笔记目录：${deps.notes.directory}。进入新上下文或恢复工作时，通过 read/ls 读取实际笔记（通常 MEMORY.md），通过 plan_read 取得独立计划。此目录只供自身笔记文件工具使用，不扩大业务权限或 exec 范围；没有笔记时使用原始记录，不强制建文件。` : ''),
    gateway: deps.gateway,
    tools: deps.tools,
    records: deps.records,
    stepIdentity: deps.stepIdentity,
    sink,
    stamper,
    // 轮号归记录域：`turns.seq` 由库按会话取 max+1，重启后自然接着走。
    nextTurnId: (): TurnId => deps.records.allocateTurn((deps.now ?? Date.now)(), turnFloor),
    now: deps.now ?? Date.now,
    blobThreshold: policy.blobThreshold,
    compact: compactor,
    ...(deps.capacity ? { capacity: deps.capacity } : {}),
    rules,
    skills,
    refs,
    acceptsImages: deps.acceptsImages,
    submitRefusal: deps.submitRefusal,
    background: deps.background,
    collaboration,
    consumeInserts,
  }

  /**
   * **可并入合并的排队交代**（一期）：纯文本、无材料、无插入位、非协作位——
   * 多条这样的排队项在处理时换行合并为一条消息。
   */
  function mergeableTextOf(input: UserInput): boolean {
    return input.insert !== true && input.notice === undefined && input.background === undefined
      && input.purpose !== 'next' && input.text.trim() !== ''
      && (input.refs === undefined || input.refs.length === 0)
      && (input.skills === undefined || input.skills.length === 0)
  }

  /**
   * **打断插入式的消费**（一期 · 唯一消费点）：把插入队列里的话逐条并入会话。
   * 只在 prepareModelContext（工具结果之后、下一请求装配之前）与收束判定处被调，
   * 工具批内（gateToolBatch）绝不调用——已派发的工具不拦截、不被打断。
   */
  async function consumeInserts(): Promise<boolean> {
    let changed = false
    for (const next of inserts.splice(0)) {
      try {
        const prepared = await prepareInput(runtime, next.input, entry => deps.collaboration?.userInput?.(entry, next.shared), state.current?.signal)
        changed ||= prepared !== undefined
      } finally { next.done() }
    }
    return changed
  }

  /** 停止只撤销本次消费意图；未消费正文和停点继续由记录域保存。 */
  function holdQueued(): void {
    const stopped = pending.splice(0)
    for (const next of supplements.splice(0)) { stopped.push({input:next.input,shared:next.shared}); next.done() }
    for (const next of inserts.splice(0)) { stopped.push({input:next.input,shared:next.shared}); next.done() }
    if (stopped.length === 0) return

    for (const {input,done} of stopped) {
      done?.()
      if (input?.ref === undefined) continue
      deps.records.inputs.hold(input.ref,'未执行，等待明确继续')
      sink.emit(
        stamper.stamp('input.settled', {
          ref: input.ref,
          ok: false,
          reason: '停下了——这一条还没轮到，标着「未执行」留着（没有接着跑）',
        }),
      )
    }
    sink.emit(stamper.stamp('input.pending',{inputs:pendingViews(deps.records.inputs.list())}))
  }

  async function drain(): Promise<void> {
    const controller = new AbortController()
    state.current = controller
    state.running = true

    // 起 · 干活——转场**当场**发生（首个 `await` 之前），外壳不必等模型
    if (!started) {
      started = true
      sink.emit(stamper.stamp('agent.start', {}))
    }
    sink.emit(stamper.stamp('agent.state', { state: 'resumed' }))

    try {
      for (;;) {
        if (state.closed || controller.signal.aborted) break
        // 包括阶段整理等待期间受理的补充；每次消费前统一收取。
        pending.unshift(...supplements.splice(0))
        if (pending.length === 0) break
        const first=pending[0]?.input
        // **圈尾闸 · 轮队列层**（边界方案 §七 C）：待答责任未收束 ⇒ 这条工作周期暂停
        //（与 executor 的进程层 `workOpen` 同一判据的两个实例——轮内一拍 / 进程一拍）。
        if (waitingForDelegations(first)) break
        const queued = pending.shift()!
        let input = queued.input
        if (input?.ref !== undefined) {
          const stored = deps.records.inputs.get(input.ref)
          // **executing 也消费**（T1.1b/T2.1 dequeue 流）：那是本执行者刚出队的行，
          // 消费迁移（executing→consumed，与落条目原子）归执行者——单活执行者前提下
          // executing 行只属于这一代；其余终态（consumed/withdrawn/failed…）不重放。
          if (stored?.state !== 'pending' && stored?.state !== 'executing') { queued.done?.(); continue }
          input = stored.input
        }
        if (input === undefined && !(await collaboration?.consume())) continue

        // **队列合并**（一期）：紧随其后的排队纯文本交代并入这一条——一次交代处理一批，
        // 省交互轮次。带材料／插入位／协作位的条目不并，各自按序处理。
        const mergedExtras: { item: QueueItem; ref: string; revision: number }[] = []
        if (input !== undefined && mergeableTextOf(input)) {
          for (;;) {
            const next = pending[0]
            if (next === undefined || next.shared || next.input === undefined || !mergeableTextOf(next.input)) break
            const row = next.input.ref === undefined ? undefined : deps.records.inputs.get(next.input.ref)
            if (row === undefined || (row.state !== 'pending' && row.state !== 'executing')) break
            pending.shift()
            mergedExtras.push({ item: next, ref: row.ref, revision: row.revision })
            input = { ...input, text: `${input.text}\n\n${next.input.text}`, mergedRefs: [...(input.mergedRefs ?? []), row.ref] }
          }
        }

        const outcome = await agentLoop(runtime, input, controller.signal, async entry => {
          try {
            // 合并进来的后续行指向同一条条目（账本上不再重复落条目），排队条随之清空。
            for (const extra of mergedExtras) {
              const ok = deps.records.inputs.attach(extra.ref, extra.revision, entry, runtime.turn ?? null)
              if (ok) extra.item.done?.()
            }
            if (mergedExtras.length > 0) sink.emit(stamper.stamp('input.pending', { inputs: pendingViews(deps.records.inputs.list()) }))
            try {
              await deps.collaboration?.userInput?.(entry,queued.shared)
              // **首条真实交代落账**——条件成立就后台起一次 AI 标题（fire-and-forget，
              // 不阻塞轮次；notice 输入不算用户开场白，见 `session-title.ts`）
              if (titles !== undefined && input !== undefined && input.notice !== true) titles.onUserEntry(input.text)
            } finally { queued.done?.() }
          } finally { for (const extra of mergedExtras) extra.item.done?.() }
        })
        // 合并的后续行回到队首（这一条没跑成，它们按序各自再试）
        if (outcome !== 'settled' && mergedExtras.length > 0) pending.unshift(...mergedExtras.map(extra => extra.item))
        queued.done?.()
        if (compactPending?.awaitInput) compactPending.awaitInput = false
        // **这一条没跑**（显式选定的技能取不到，U33）——停下的是**它**，不是这一队：
        // 后面那几条没做错任何事，清掉＝静默吞了用户的交代（见 `InputOutcome` 的注）
        if (outcome === 'rejected') continue
        // 中止 / 出错＝停下：排队中的交代**不再续跑**（「回到等待输入」是当场的），
        // 并**逐条配对**（没进会话＝明确失败，见 `holdQueued`）
        if (outcome !== 'settled') {
          holdQueued()
          break
        }

      }
    } catch (error) {
      // 兜底（保险 · 正常不可达：循环各处已各自兜底）——走到这里＝扇出 / 铸造器本身炸了。
      // 端口是 `void`，不兜则调用方那头永远看不见这次拒绝
      sink.emit(stamper.stamp('error', { message: `对话域异常：${messageOf(error)}` }))
    } finally {
      state.running = false
      state.current = undefined
      if (compactPending !== undefined) void flushCompact()
      // 回到等待输入——收束 / 中止 / 出错**都**回到这里（首站只有这一个稳定态）
      sink.emit(stamper.stamp('agent.state', { state: 'waiting' }))
    }
  }

  function startDrain(): void {
    // 保存已处理拒绝的 Promise，关闭实例时等待它落定。
    flight = drain().catch(error => { failure = error })
  }
  let failure: unknown


  function wake(): void {
    if (state.closed || deps.collaboration === undefined || pending.some(one=>one.input===undefined) || state.current?.signal.aborted===true) return
    if (!state.running && waitingForDelegations(pending[0]?.input)) return
    pending.unshift({input:undefined,shared:false})
    if (!state.running && compactPending === undefined) startDrain()
  }
  function waitingForDelegations(input:UserInput|undefined):boolean {
    if(input?.purpose!=='next')return false
    const work=deps.records.collaboration.collaborationForSession(deps.session)
    if(work===undefined)return false
    const member=deps.records.collaboration.agentForSession(deps.session)
    return deps.records.collaboration.listDelegations(work.collaborationId).some(one=>
      (member?.agentId===work.coordinatorId || one.assigneeId===member?.agentId) && !['received','rejected','cancelled'].includes(one.state))
  }
  return {
    compact(request, signal, started) {
      if (state.closed || compactPending !== undefined) return Promise.resolve({ requestId: request.requestId, state: 'failed', reason: state.closed ? '执行实例已关闭' : '已有压缩请求' })
      return new Promise(resolve => {
        const controller = new AbortController()
        const combined = AbortSignal.any([signal, controller.signal, ...(state.current === undefined ? [] : [state.current.signal])])
        const onAbort = () => { if (compactFlight === undefined) void flushCompact() }
        compactPending = { request, controller, signal: combined, started, notesSaved: false, awaitInput: false, finish: state => { combined.removeEventListener('abort', onAbort); resolve(state) } }
        combined.addEventListener('abort', onAbort, { once: true })
        if (!state.running || combined.aborted) void flushCompact()
      })
    },
    supplement(input, shared) {
      return new Promise(resolve => acceptInput(bundle, input, shared, resolve))
    },
    wake,

    manage(command) {
      manageInput(bundle, command)
    },
    submit(input: UserInput): void {
      if (state.closed) return
      if (input.local === true) {
        sink.emit(stamper.stamp('input.local',{text:input.text,refs:input.refs??[],ref:input.ref??crypto.randomUUID()}))
        return
      }
      acceptInput(bundle, input, false)
    },

    interrupt(): void {
      state.current?.abort()
      compactPending?.controller.abort()
      // 「停下」就是停下——排队那几条**保留并标为未执行**（U50 · 见 `holdQueued`）：
      // 不丢、不接着跑、逐条说清它们还没轮到
      holdQueued()
    },

    async shutdown() {
      state.closed = true
      compactPending?.controller.abort()
      state.current?.abort()
      holdQueued()
      await flight
      await compactFlight
      if (failure !== undefined) throw failure
    },

    busy: () => state.running || pending.length > 0 || compactPending !== undefined,

    /**
     * 重建（恢复 ⑤）——**认下应用层算好的两件**，其余什么都不做。
     *
     * 上下文**不必搬**：它每轮由条目装配（`./context.ts`），本面只把「活的那部分」与记录
     * 对齐。真正要认的只有两件，都在 `RebuildHandoff` 里：
     *
     * - **轮号水位**——记录里的最大轮号抬到这里（同一会话重启两回，不该把两轮都叫第 1 轮）。
     * - **开工位**——恢复那趟有活可干时，应用层已经替本实例发过 `agent.start`；认下它，
     *   首次 `submit` 就**不再发第二遍**（U04 口径：`agent.start` 每个实例一条）。
     *
     * **不发事件**：本面只是记账，过程流里那几笔归应用层（它编排了②③④）。
     */
    rebuild(handoff: RebuildHandoff): RebuildReport {
      if (state.running) {
        throw new Error(
          '重建要在**放开输入之前**调（装配纪律：先接订阅、后放开输入）——在干活时重建会与循环抢同一条记录流',
        )
      }

      if (handoff.lastTurn !== null) turnFloor = Math.max(turnFloor, handoff.lastTurn)
      if (handoff.announced) started = true

      return { session: deps.session, lastTurn: handoff.lastTurn }
    },
  }
}

