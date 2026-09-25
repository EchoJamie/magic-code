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
import type { LoopRuntime } from './agent-loop.ts'
import { agentLoop } from './agent-loop.ts'
import { createCompactor } from './compact.ts'
import { DEFAULT_CONTEXT_POLICY } from './policy.ts'
import type { ContextPolicy } from './policy.ts'
import { buildSystemPrompt } from './prompt/index.ts'
import type { PromptVars } from './prompt/index.ts'
import { createRefDelivery } from './refs.ts'
import { createRulesDelivery } from './rules.ts'
import { createSkillsDelivery } from './skills.ts'

/**
 * 装配期构造入参——一切「谁来实现」的选择由装配根给出（本域不知道背后是谁：
 * 模型域 / 工具域 / 记录域皆经契约端口）。
 */
export type ConversationDeps = {
  /** 会话——条目按会话读；信封的 `session` 由铸造器持（装配按会话实例构造，两处同源）。 */
  readonly session: SessionId
  /** 模型名——随每次调用送模型域。 */
  readonly model: string
  /** 提示词运行时注入值（`cwd` / `platform` / `date`）——**缺项在构造期就报错**。 */
  readonly prompt: PromptVars
  readonly gateway: ModelGateway
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
  submit(input: UserInput): void
  interrupt(): void
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

  let turnSeq = 0
  let started = false
  let running = false
  /** 在途工作的中止手柄——`interrupt` 的唯一着力点（空闲时为 `undefined`）。 */
  let current: AbortController | undefined
  /**
   * 排队中的交代——**整份 `UserInput`**（U33 起；此前是 `string[]`）。
   *
   * 每一份都**固定着它自己绑的技能**：排着的时候不与别条共享任何可变状态
   * （没有「当前技能」那种东西可读），故忙时两条不同技能的交代出队后**各自身份不串**。
   */
  const pending: UserInput[] = []
  /**
   * **停下那一刻从队里挪出来的那几条**（U50）——**未执行**、也**不会再被消费**。
   *
   * 与 `pending` 分开是有由头的：`pending` 是**要跑的**（`drain` 一趟接一趟地取），
   * 而这几条**不跑**——它们只是留着，等用户重新交代（`submit` 一到就清掉，见 `holdQueued`）。
   * 混在一个队里，下一次 `submit` 就会把它们一并送出——那正是设计不许的「停止后继续消费」。
   */
  const held: UserInput[] = []

  /**
   * **压缩器**（阶段 3 · U19）——按会话实例各一份，故它记得的用量读数**随会话走**
   * （切到别的会话，读数是那条会话自己的）。
   *
   * 记账的两处（`blobThreshold` / `blobTextLimit`）与循环同源：摘要条目也是条目，
   * 该转 blob 就转 blob、该截断就截断（见 `./compact.ts`）。
   */
  const compactor = createCompactor({
    records: deps.records,
    session: deps.session,
    gateway: deps.gateway,
    model: deps.model,
    sink,
    stamper,
    now: deps.now ?? Date.now,
    blobThreshold: policy.blobThreshold,
    blobTextLimit: policy.blobTextLimit,
    nearEntries: policy.nearEntries,
    compactAtFraction: policy.compactAtFraction,
    compactAtTokens: policy.compactAtTokens,
    compactFailureLimit: policy.compactFailureLimit,
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
    skills: deps.skills,
    materials: deps.materials,
    // 图片的字节要进记录（U37）——写权唯一归记录域，故经它的公开面
    blobs: deps.records.blobs,
  })

  const runtime: LoopRuntime = {
    session: deps.session,
    model: deps.model,
    systemPrompt: buildSystemPrompt(deps.prompt),
    gateway: deps.gateway,
    tools: deps.tools,
    records: deps.records,
    sink,
    stamper,
    // 单调自增；**续跑接着记录里那串轮号**——`rebuild()` 把记录里的水位抬到这里
    // （U04 留的那道缝，U15 填上：同一会话重启后不从 1 重来）
    nextTurnId: (): TurnId => (turnSeq += 1),
    now: deps.now ?? Date.now,
    blobThreshold: policy.blobThreshold,
    blobTextLimit: policy.blobTextLimit,
    compact: compactor,
    rules,
    skills,
    refs,
    acceptsImages: deps.acceptsImages,
    submitRefusal: deps.submitRefusal,
    background: deps.background,
  }

  /**
   * **停下那一刻，排队里的交代**（U50）——**保留并标为未执行**。
   *
   * 设计（会话与运行管理 · 离开、停止与异常退出）：
   *
   * > 停止时还有已接收输入 ｜ **保留并标为未执行，不在停止后继续消费**；用户以后
   * > **明确继续/取消**。
   *
   * 三条各落一处：
   * - **不在停止后继续消费**——它们从 `pending` 挪进 `held`，而 `drain` 只读 `pending`
   *   ⇒ 停止之后没有任何一条路会把它们送出去（**要跑只有一条路：用户重新交代**）；
   * - **保留**——`held` 留着它们（正文 ＋ 它绑的那几件原样），外壳那一侧另有把正文还给
   *   草稿的那一条（`restoreDraft`），用户手上那份交代因此**不丢**；
   * - **标为未执行**——逐条配对 `input.settled{ok:false}`（给了 `ref` 的才发），话里
   *   **明写着「未执行」**：这不是失败，是**还没轮到**。
   *
   * 由头（2026-09-21 规划裁，一字不改）：`input.settled` 的契约是「给了 `ref` 必有终态」
   * ——白名单式的「成了才回」会让外壳永等一份草稿。故终态照给，只是**话变了**：
   * 从前那句「请重新发送」把它说成一次**丢失**（用户得重打一遍），而现在它是**留着的**。
   *
   * ⚠️ 发的事件用的是**当下活跃那条会话**的信封（它们本来就没能进任何会话——
   * 说得出「这一条没成」就够，不编一条会话出来）。
   *
   * **限度（如实记）**：完整的「未执行交代」界面（列出来、逐条继续或撤销、入队即保存
   * 到重启不丢）归 [[设计/运行中输入]]，**那一块未授权实施**。本处只做到设计这一行要的
   * 那三件：不丢、不接着跑、说得出来；`held` 在一次新的交代到来时清掉（用户已经用行动
   * 说了「那几件我不等了」）。
   */
  function holdQueued(): void {
    const stopped = pending.splice(0)
    if (stopped.length === 0) return

    held.push(...stopped)
    for (const input of stopped) {
      if (input.ref === undefined) continue
      sink.emit(
        stamper.stamp('input.settled', {
          ref: input.ref,
          ok: false,
          reason: '停下了——这一条还没轮到，标着「未执行」留着（没有接着跑）',
        }),
      )
    }
  }

  async function drain(): Promise<void> {
    const controller = new AbortController()
    current = controller
    running = true

    // 起 · 干活——转场**当场**发生（首个 `await` 之前），外壳不必等模型
    if (!started) {
      started = true
      sink.emit(stamper.stamp('agent.start', {}))
    }
    sink.emit(stamper.stamp('agent.state', { state: 'resumed' }))

    try {
      for (;;) {
        const input = pending.shift()
        if (input === undefined) break

        const outcome = await agentLoop(runtime, input, controller.signal)
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
      running = false
      current = undefined
      // 回到等待输入——收束 / 中止 / 出错**都**回到这里（首站只有这一个稳定态）
      sink.emit(stamper.stamp('agent.state', { state: 'waiting' }))
    }
  }

  return {
    submit(input: UserInput): void {
      // **整份入队**（正文 ＋ 它绑的技能 ＋ 配对键）——不是只留正文：
      // 忙时两条交代各绑各的技能，出队后不能被串成同一条（U33 工单明写）
      // 用户又交代了一句 ⇒ **那几件他不要了**（留着的未执行交代到此为止——完整语义见
      // `holdQueued` 的限度那一句）。摆在入队之前：这一句是新的开始，不是上一次的续。
      held.length = 0
      pending.push(input)
      if (!running) void drain()
    },

    interrupt(): void {
      current?.abort()
      // 「停下」就是停下——排队那几条**保留并标为未执行**（U50 · 见 `holdQueued`）：
      // 不丢、不接着跑、逐条说清它们还没轮到
      holdQueued()
    },

    busy: () => running,

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
      if (running) {
        throw new Error(
          '重建要在**放开输入之前**调（装配纪律：先接订阅、后放开输入）——在干活时重建会与循环抢同一条记录流',
        )
      }

      if (handoff.lastTurn !== null) turnSeq = Math.max(turnSeq, handoff.lastTurn)
      if (handoff.announced) started = true

      return { session: deps.session, lastTurn: handoff.lastTurn }
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
