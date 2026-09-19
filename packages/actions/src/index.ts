/**
 * `@magic/actions` —— **应用层**（技术方案 · 领域划分 ·「域之上：应用层」，2026-09-19 定）。
 *
 * ## 这一层是什么
 *
 * **把一个用例翻成跨域的几步**（DDD 的标准层）。**不含**领域逻辑（那是域的）·
 * **不含**传输（那是控制域的）· **不含**装配（那是装配根的）。
 *
 * 拿四层对一遍：用户接口层＝外壳（TUI 起步）· **应用层＝本包** · 领域层＝七个域 ·
 * 基础设施层＝记录域的 SQLite / 模型域的供应商客户端 / 执行域的沙箱。
 *
 * ## 它为什么存在（缺口是什么）
 *
 * 「把一件事翻成跨域几步」的编排**原先全在对话域里** ⇒ 对话域既是核心域（ReAct 的
 * 领域逻辑），又兼着编排者。**后果已现形一次**——**恢复没有归处**（它不是任何一个域的
 * 能力，是跨域的一次协同；阶段 2 因此三个单元各做对一半，见 `缺陷/D1` 与审计第 1 条）。
 * **第二站要加新用例时，也没有地方放。**
 *
 * ## 纪律三条
 *
 * ① **只依赖 `@magic/contracts`**（端口 ＋ 共享语言）——同各域的纪律：**不认知任何域的
 *    内部**。它拿到的是一组**端口**，由装配根注入。
 * ② **每个用例一个入口**——收下命令（或其参数）→ 编排跨域的几步 → 返回**判别式**。
 * ③ **不持状态**（状态在各域）· **不自己发事件**（经 `EventSink`）。
 *
 * ## 包名为什么叫 `actions`
 *
 * **不叫 `application`**（与装配根 `@magic/app` 撞）· **也不叫 `usecase`**（那是方法学术语，
 * 不是这个产品的话——按词典规则 9 那把尺子，说话时不会用它）。**「动作」描述的是它在这个
 * 产品里的角色**（外壳发起的动作由它受理）；它属 DDD 的哪一层写在设计里，不靠包名背诵。
 *
 * ## 首站放什么
 *
 * **恢复**（第一个真用例，见 `./recover.ts`）。**主循环不动**：它是核心域的**领域逻辑**
 * （ReAct 就是这个产品的业务本身），**不是用例**——这是「哪些该搬、哪些该留」的分界。
 *
 * **入口也归它**——这层在首站存在的意义：审计第 1 条那个悬案（恢复入口没有归处）由它解。
 * 启动参数（`--session <id>`）或另一条把 id 喂进启动流转的路，由它受理（`./src/cli.ts`
 * 收参数 → 装配递给本层）。
 */

import type {
  ConversationService,
  EventSink,
  EventStamper,
  RecordsService,
  SessionId,
  Timestamp,
  ToolRuntime,
} from '@magic/contracts'
import type { IdempotencyJudge, RecoveryReport } from './recover.ts'
import { recoverSession } from './recover.ts'

/**
 * **一条会话的现场束**（各域端口 ＋ 这一条会话的实例件）——装配的 `open` 工厂产。
 *
 * 为什么按会话给而不是构造期一次绑好：`records` / `tools` / `stamper` 都是**随会话实例
 * 各一份**的（记录实例带会话绑定、铸造器按会话实例构造——契约 · 信封的归属）。
 * 装配开一条会话时就产出这一束，用例按调用取用——**本层不持状态**，正在于此。
 */
export type SessionPorts = {
  readonly session: SessionId
  readonly records: RecordsService
  readonly tools: ToolRuntime
  readonly stamper: EventStamper
}

/**
 * 本层的进程级注入面（装配给）——**不随会话漂**的那几件。
 *
 * 会话级的那几件（`SessionPorts`）按调用给：装配的 `open` 工厂已经把它们绑在一起了，
 * 本层另存一份就是第二真源。
 */
export type ActionsDeps = {
  /** 对话域端口——⑤ 上下文由条目重建（`ConversationService.rebuild`）。 */
  readonly conversation: ConversationService
  /** 事件扇出——各域直发（技术方案 · 领域划分：「不自己发事件」）；瞬时 / 落库由装配分派。 */
  readonly sink: EventSink
  /** 时钟（记录域不取时钟）——补记条目的时间戳。 */
  readonly now: () => Timestamp
  /**
   * 幂等判定——**生产装配不传**（`ToolSpec` 没有幂等声明位，「幂等 → 静默重放」无从判定
   * ⇒ 首站一律交用户裁决）。见 `./recover.ts` 文件头注「② 首站为什么不自动重放」。
   */
  readonly idempotent?: IdempotencyJudge | undefined
}

/** 本层的面——**每个用例一个入口**。 */
export type Actions = {
  /**
   * **用例 · 恢复**（首站唯一）——以会话为入口重建现场续跑。
   *
   * 五步的分工（技术方案 · 记录 ·「恢复（阶段 2 · 细部）」）：
   * ①②③④ 在本层（`recoverSession`）· ⑤ 递手给对话域的重建面。
   * 顺序要紧：**处置在前、重建在后**——重建的那一下要按**补记之后**的记录来
   * （外壳据 `session.state` 重开一屏、按条目重建展示，落单的调用那时已经成对）。
   *
   * 干净会话照走⑤：**①-④什么都不做**（一个事件都不发），但**装载与「你在这儿」仍要发生**
   * ——接续一条旧会话时外壳得知道自己落在哪条上。
   *
   * 调用时机：**接好订阅之后、放开输入之前**（装配纪律）。恢复要发事件，反了就是
   * 「事件发了没人收」＋「用户能在恢复跑完前打字」。
   */
  recover(ports: SessionPorts): Promise<RecoveryReport>
}

/** 造应用层——装配在装配期调一次，把域实例与扇出绑进来。 */
export function createActions(deps: ActionsDeps): Actions {
  return {
    async recover(ports: SessionPorts): Promise<RecoveryReport> {
      // ①②③④ 在途识别 → 处置 → 记中止 → 未答复按拒（记录域的查询面 ＋ 事件扇出）
      const report = await recoverSession({
        session: ports.session,
        records: ports.records,
        tools: ports.tools,
        stamper: ports.stamper,
        sink: deps.sink,
        now: deps.now,
        idempotent: deps.idempotent,
      })

      // ⑤ 上下文由条目重建 ＋ 界面重建展示（装载 · 认下水位与开工位 · 通知外壳「你在这儿」）
      await deps.conversation.rebuild(ports.session, {
        lastTurn: report.lastTurn,
        announced: report.announced,
      })

      return report
    },
  }
}

// —— 公开面（技术方案 · 代码治理 · 公开面：端口实现 ＋ 装配期构造入参形态）——
//
// 出的是**用例入口**（`createActions`）与**它要的那几个形态**；`recoverSession` 也出——
// 它是用例本体，装配之外的消费者（验收脚本 / 别的入口）可能直接要那一步（不带⑤）。
export { recoverSession } from './recover.ts'
export type {
  CallDisposition,
  IdempotencyJudge,
  NotReplayedReason,
  RecoveryReport,
  RecoveryRuntime,
} from './recover.ts'
