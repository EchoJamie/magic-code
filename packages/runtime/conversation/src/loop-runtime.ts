/** 主循环的共享类型与小件 —— 从 agent-loop.ts 拆出的公共面（行为不变）。
 *
 * 拆它的由头：输入受理（`input-intake.ts`）、两本回执账（`receipt-accounts.ts`）与
 * 轮循环本体（`agent-loop.ts`）三方共用这些类型与落账依赖束——类型收拢一处，
 * 三方 type-only 引用，运行时依赖保持单向（agent-loop → input-intake → 本文件）。
 */
import type {
  EventSink,
  EventStamper,
  ModelGateway,
  RecordsService,
  SessionId,
  Timestamp,
  ToolRuntime,
  TurnEndReason,
  TurnId,
  UserInput,
} from '@magic/contracts'
import type { Compactor } from './compact.ts'
import type { CollaborationBoundary } from './collaboration.ts'
import type { EntryLog } from './entries.ts'
import type { RefDelivery } from './refs.ts'
import type { RulesDelivery } from './rules.ts'
// ⚠️ **只取类型**（`import type`）：入参那几件的形态住在 `./service.ts`（构造入参的落点），
// 而本文件是它的一个**视图**——真值那条线是 `service.ts → agent-loop.ts`，这一条不回头。
import type { SubmitRefusal } from './service.ts'
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
  readonly knowledge?: import('@magic/contracts').KnowledgeRecords
  readonly collaboration?: CollaborationBoundary | undefined
  /** 会话——条目按会话读（信封的 `session` 由铸造器持，两处同源）。 */
  readonly session: SessionId
  /** 系统提示词全文——已由提示词部件装配好（本文件不认知段结构）。 */
  readonly systemPrompt: string
  /** 当前交代——轮起时设、轮止时清；条目落账据此带 `turn_id`。 */
  turn?: TurnId
  readonly gateway: ModelGateway
  readonly tools: ToolRuntime
  readonly records: RecordsService
  /** 当前模型身份（用后留痕到 steps）；缺省不记。 */
  readonly stepIdentity?: (() => { readonly provider: string; readonly model: string } | undefined) | undefined
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
  /**
   * 压缩器（阶段 3 · U19）——**不接线＝不压缩**（首站无压缩那几轮的行为一字不动；
   * 用例只想验循环时也不必拖一个压缩器进来）。真装配一律给（见 `./service.ts`）。
   *
   * 「近段」保留多少**不从别处另给**——压缩器按当前输入预算推导（`nearTokens` 只给受控场景）。
   */
  readonly compact?: Compactor | undefined
  /**
   * **打断插入式的消费点**（一期）——option+回车提交的话在此并入会话：
   * 每趟请求的装配前调用（工具结果之后、下一请求之前），**工具批内绝不调用**。
   * 返回是否有话并入了（收束判定据此续跑）。
   */
  consumeInserts?: (() => Promise<boolean>) | undefined
  /**
   * 当前模型的输入预算——压缩闭环与装配兜底共用这一读数（D74）。
   * 不给＝不核对预算：压缩只压一次，装配照旧全量（旧行为，供只验循环的用例）。
   */
  readonly capacity?: (() => { readonly inputBudget?: number | undefined }) | undefined
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
  /**
   * **当前模型吃不吃图**（U37）——三态：`true` 明确支持 · `false` **明确不支持** ·
   * `undefined` **不知道**（缺省）。
   *
   * 由装配给（它握着注册表与模型信息缓存——本域不认识模型）。用途只有一个：
   * **带图的那一条交代在发出去之前**拦下来（设计 · 文件与图片：「模型明确不支持图像时
   * 保留输入，提示换模型或移除图片，不能静默丢图发文字」）。
   *
   * ⚠️ **`undefined` 照发**：不知道就按不知道办，请求真失败再如实报错——
   * 把未知当「不支持」拦下来，等于凭空禁掉一批其实能看图的模型。
   *
   * 不给这一位（旧装配、用例）＝恒 `undefined`（行为与加它之前一字不动）。
   */
  readonly acceptsImages?: (() => boolean | undefined) | undefined
  /**
   * **这一条交代此刻发得出去吗**（U60）——发不出去就回一句**给人看的话**
   * （`undefined` ＝发得出去）。
   *
   * 与 `acceptsImages` 同一个姿势、同一条理由：本域不认识供应商，而「此刻有没有可走的
   * 模型」只有装配答得上来（注册表在它那一层）。
   *
   * 用途只有一个：**一条连接都没接**（或接了但没选走哪个）时，在落账之前把整条交代拦下来。
   * 「不跑」照 `rejected` 那三层办（不落 `user` 条目 · 不进模型请求 · 原稿还回输入区）——
   * 但比那三层多一层：**那一轮压根不开**，屏上因此不会先闪一下「工作中」再报错。
   * 「装作在跑」比不报更坏（工单原话）。
   *
   * ⚠️ **拦在取材料之前**（本函数第一件）：发都发不出去，去读那几份文件只是白读；
   * 而且用户此刻要修的是**更靠前的那一件**（先接供应商），不是某处引用。
   *
   * 不给这一位（旧装配、用例）＝恒 `undefined`（行为与加它之前一字不动）。
   */
  readonly submitRefusal?: (() => SubmitRefusal | undefined) | undefined
  /**
   * **这条会话此刻还在跑的后台命令**（U89）——每请求现取一次，接成一个追加块
   * （见 `./prompt/background.ts`）。
   *
   * 与 `rules` / `skills` 同一处接上、同一个姿势（**现取现接**）：它答的是「此刻」，
   * 而**一条命令在这一轮里跑完了**正是常态——抓一份快照，下一轮就会把已经结束的
   * 说成还在跑（那比不报更坏：模型据此以为还能等到它的输出）。
   *
   * 不给这一位（旧装配、用例）＝这一块压根不接线（行为与加它之前一字不动）。
   */
  readonly background?: (() => readonly import('@magic/contracts').BackgroundRunning[]) | undefined
}

/** 一轮的收场。`reason` 进 `turn.end`；`continues` ＝本轮请求了工具且都处置完——**须再开一轮**。 */
export type TurnOutcome = {
  readonly reason: TurnEndReason
  readonly continues: boolean
}

/**
 * **一次交代里「引用了、但没被读过」的那几份**（U63）——见 `createMaterialWatch`。
 */
export type MaterialWatch = {
  /** 一次工具调用回来了——按结果记「哪几份材料这一趟被读到了」。 */
  see(outcome: import('./entries.ts').ToolOutcome): void
  /** 收束时问一次：还有哪几份**没被读过**（按交代里的次序，同一处只算一次）。 */
  unread(): readonly string[]
}

/** 一次交代的技能回执账——见 `createAnnouncer`。 */
export type Announcer = {
  /** 工具取到一份技能主文——记着，等它进了下一趟请求、那趟真回来了再报。 */
  deliver(skill: import('@magic/contracts').UsedSkill): void
  /** 一趟请求真回来了——把该报的报掉（报过的身份不再报）。 */
  flush(): void
}

/** 落账依赖束——由运行时装配（时钟与阈值只此一处传给条目侧）。 */
export function entryLogOf(runtime: LoopRuntime): EntryLog {
  return {
    records: runtime.records,
    now: runtime.now,
    blobThreshold: runtime.blobThreshold,
    ...(runtime.turn === undefined ? {} : { turn: runtime.turn }),
  }
}

/** 用户输入的别名——输入受理与循环共用同一形态，此处只留一个出处。 */
export type LoopInput = UserInput
