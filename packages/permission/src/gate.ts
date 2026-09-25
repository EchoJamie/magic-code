/**
 * `PermissionGate` —— 权限域端口（技术方案 · 领域划分：工具域 → 权限域，闸门在 `invoke` 路径内）。
 *
 * 一次裁决的全流程：
 *
 *   机械分析（工具名 ＋ 参数）→ 危险分级 → **规则命中？** → 自动放行（`decider: 'auto'`）
 *     ／否则发 `tool.decision.request`（带材料与呈现轻重）→ 等答复（`resolve`，配对＝请求事件 id）
 *     → 发 `tool.decision` → 返回裁决
 *
 * **优先级链一次留全**（技术方案 · 权限「授权的落点」）：
 *
 * ```
 *   必闸禁区 ＞ 项目规约（留缝·不实现） ＞ 用户手写规则 ＞ 点出来的授权 ＞ 默认问
 * ```
 *
 * 而 **「全放行」**（U73 · `options.allowAll`）**不是这条链上的一格，也不是一个「模式」**
 * ——它是**权限这一维的一个取值**，只动「该不该做」那一问的**默认答什么**：**一个布尔**
 * （全放行 ／ 不全放行），**不给它加档、不留扩展位**（设计明文）。它落在本域的效果只有一件：
 * 判**轻**的调用不必配规则就落进「自动放行」；判**重**的那一格它**够不着**（必闸禁区仍在最左）。
 * 链上每一格的次序因此一字未动，`analyze` 那一刀也一个字没改。
 *
 * 本文件是这条链的**唯一落定处**；括号里标出每一格住在哪儿：
 * - **必闸禁区**——`analyze` 每次当场重判（判据不押规则作者的自觉）；
 * - **项目规约**——**留缝不实现**（设计明文：采纳它要配「首次确认 ＋ 只许收窄」）；
 * - **用户手写规则**——`options.rules`（装配从配置读来、经 `parseRules` 校验）；
 * - **点出来的授权**——`options.grants`（**工作区级**账本，见 `grants.ts`）；
 * - **默认问**——链的底，其余全落空时就是它（阶段 1 姿态）。
 *
 * 规则只在 `analyze` 判**轻**时才有资格放行，判重一律问（清单即禁区，任何规则不可放行）。
 *
 * 纪律（技术方案 · 领域划分 · 权限域）：**裁决独立**（不自证、不押模型自述）·
 * **只走事件、不入条目**——故本域注入面只有 `EventSink`（`emit` 一件）与 `EventStamper`，
 * **结构上拿不到条目面**（`RecordsService` 才是条目面，本域不注入）。
 * ⚠️ **不碰文件系统**——授权账本（`grants`）是**纯内存**的：读盘落盘都归装配，
 * 本域只把「变了」报给账本的回调（见 `GrantLedgerOptions.onChange`）。
 *
 * **调用链引用（`callRef`）必填**（第 2 轮契约对齐 · `PermissionGate.decide` 三参）——
 * 它是「请求 → 询问 → 裁决 → 结果」四事件**串链**的依据（审计与阶段 2 恢复的在途识别
 * 都按它找）；而它产生在本域之外（工具域铸 `tool.call` 时才有），故只能由调用方传入。
 * **不设哨兵兜底**：静默的 `-1` 比缺参更坏——接线漏了应当在**编译期**就报。
 */

import type {
  Decision,
  DecisionId,
  EventSink,
  EventStamper,
  PermissionContext,
  PermissionGate as PermissionGatePort,
  RecordId,
  ToolCall,
} from '@magic/contracts'
import { analyze } from './analyze.ts'
import { decisionMade, decisionRequest } from './events.ts'
import type { GrantLedger } from './grants.ts'
import { grantOf } from './grants.ts'
import type { PermissionRule } from './rules.ts'
import { describeRule, matchRule, type CallFace } from './rules.ts'

/**
 * 权限域公开面——**即契约端口**（`decide` 三参 · `resolve` 两件）＋ 放行区那一笔账。
 *
 * 第 2 轮契约对齐：`callRef` 由可选注入位**升为必填参数**（见 `decide` 头注）。
 *
 * 三处**结构超集**（契约零改动 · 两参照常工作）：
 * - `decide` 的第三参 `callRef`——第四轮由契约补锚（已是端口形态本身）；
 * - `resolve` 的第三参 `options`——「总是允许」的答复位（契约词表里已有，
 *   见控制面 `DecisionAnswer.remember`）；
 * - `tally()`——**度量读面**（U22），契约端口没有它：它说的是本域自己的账，
 *   不是跨域语言（读它的是装配，用于 `/grants` 那一屏，见 `GateTally`）。
 */
export interface PermissionGate extends PermissionGatePort {
  decide(call: ToolCall, ctx: PermissionContext, callRef: RecordId): Promise<Decision>
  /**
   * 控制域答复路由至此——配对键＝**请求事件** `id`。
   *
   * 第三参是**结构超集**（契约端口两参照常工作，同 U07 之例）：`options.remember` ＝
   * 外壳的第三个按钮**「总是允许」**——**这个工作区**此后**同类**不再问（见 `ResolveOptions`）。
   */
  resolve(requestId: DecisionId, decision: Decision, options?: ResolveOptions): void
  /** **放行区那一笔账**（`B10` 口径的原料）——本实例走过的裁决分布，见 `GateTally`。 */
  tally(): GateTally
}

/**
 * `resolve` 的加宽位——「总是允许」（技术方案 · 权限：放行区——「总是允许」按
 * （工具 × 路径模式 × 操作类型）记录）。
 *
 * 落在本域是凝成一条授权，与配置规则同一套匹配、同一关禁区。**落点＝工作区**——
 * 记进注入的账本（`PermissionGateOptions.grants`），由装配落 `~/.magic/grants.json`，
 * **跨会话存活**（技术方案 · 权限「授权的落点」：两层，不是三层）。
 */
export type ResolveOptions = {
  /** 「总是允许」——**只在批准时生效**（规则的条目只有「允许」这一形，没有「总是拒绝」）。 */
  readonly remember?: boolean
}

/**
 * **放行区那一笔账**（`B10` · 技术方案 · 权限「度量」）——「未配规则的调用占比」的原料。
 *
 * 口径（**两句话都要说清，否则这个数会被读成别的东西**）：
 *
 * ```
 *   未配规则的调用占比 ＝ uncovered / total        ← B10 那句的字面义
 *   还得人点一下的占比 ＝ (uncovered + vetoed) / total
 * ```
 *
 * 两个数**只差 `vetoed` 那一格**：规则命中了却被必闸禁区否决的调用，对**用户**是同一个
 * 体验（还是弹了卡），而对**规则作者**不是一件事（他得知道「我配的规则够不着这类」）。
 * 故分两格记，不合并——合成的那个数两边都说不准。
 *
 * ⚠️ **是「本实例」的数，不是历史累计**：闸门按会话实例构造，故它是**本会话**的分布。
 * 累计要读记录库里的 `tool.decision` 事件（裁者在事件上）——那条路归记录域，见回报「待决」。
 * 这正是 B10 要的那件事：**可算**（就这三个数）· **可追**（每一条都对应库里一笔
 * `tool.decision`，`decider` 分得开「没问」与「秒批」）。
 */
export type GateTally = {
  /** 走过的裁决数（每次 `decide` 一件）。 */
  readonly total: number
  /** 其中**一条规则都没命中**的（手写规则与授权都没中）＝「未配规则」。 */
  readonly uncovered: number
  /** 命中了规则却被**必闸禁区**否决的（见上：对用户与 `uncovered` 同一体验）。 */
  readonly vetoed: number
}

export type PermissionGateOptions = {
  /** 事件扇出入口（装配注入；本域只发不收）。 */
  readonly sink: EventSink
  /**
   * 信封铸造器——**产出方铸**（技术方案 · 领域划分 · 信封的归属 v0 锚定）。
   *
   * 对本域是硬约束：请求事件的 `id` 就是答复配对键，id 必须**当场铸**。
   * ⚠️ **必填，本域无缺省**——权限域不自造计数、不自取时钟。
   */
  readonly stamper: EventStamper
  /**
   * **用户手写规则**——（工具 × 路径模式 × 操作类型）→ 允许（技术方案 · 权限「规则化」）。
   *
   * 由装配从配置文件读来、经 `parseRules` 校验后注入（本域不碰文件系统，也不写回）。
   * **缺省＝无规则**：那便是阶段 1 的姿态——每个调用都问。
   */
  readonly rules?: readonly PermissionRule[] | undefined
  /**
   * **授权账本**——「总是允许」点出来的那一类（**工作区级** · U22 迁移的落点）。
   *
   * ⚠️ **必填**（不是可选位）：本单元治的正是「授权记在哪儿」——漏接线＝`a` 写下的东西
   * 无处可去（要么静默丢弃、要么退回会话级）。**缺参应当在编译期就报**（同 `callRef` 之例）。
   *
   * 账本由装配按**工作区**造一次、**跨会话共用**（同一束里的各会话读同一个账本——
   * 这正是「授权跨会话存活」这句话在本进程内的形态）。
   */
  readonly grants: GrantLedger
  /**
   * **全放行**（U73）——**权限这一维的一个取值**（不是「模式」、不是新的一层）：**一个布尔**，
   * **只在起会话那一刻**由命令行给；会话活着的时候**没有任何入口改它**（它是构造入参，
   * 本域不提供 setter——「对话期间切不进去」在代码里就是这个形状）。
   *
   * 落了什么：判**轻**的调用**不再弹卡**——与「规则命中」走**同一条**自动放行路
   * （`decider: 'auto'`、耗时照测、事件照发），只是不必先配一条规则。
   *
   * ⚠️ **必闸类照样挡**：下面那道 `weight === 'light'` 的门**一字不动**——判重的
   * （删 / 覆 / 破坏性 git / 提权 / 外发 / 越界 / 看不懂）**照旧弹卡**。
   * 「全放行 ≠ 连必闸也放」是设计明文，故这里**不写第二套判据**：轻重那一刀仍归 `analyze`，
   * 这一位只是**不押「有没有规则」**——它是**过闸时的输入**，不是判据的一部分。
   *
   * 由头与边界见 `设计/工具执行与权限`·「全放行：**只在起会话那一刻给**」。
   */
  readonly allowAll?: boolean | undefined
  /**
   * 时钟（毫秒）——**度量**用：裁决耗时 ＝ 本域开始处理这次裁决 → 裁决落定
   * （`tool.decision.elapsedMs`；两种路径同一口径，见 `events.ts` · `decisionMade`）。
   * 缺省 `Date.now`；显式注入便于测试（域不各自读时钟，取用经此一处）。
   */
  readonly now?: (() => number) | undefined
}

/** 一件在途询问。 */
type Pending = {
  /** 调用链引用——裁决事件沿用（与配对键不是同一个 id）。 */
  readonly call: RecordId
  /** 度量锚：本域开始处理这次裁决的时刻（`elapsedMs` ＝ 它 → 答复）。 */
  readonly at: number
  /** 这次问的是「同类」里的哪一类——「总是允许」据此凝出授权（当场凝好，答复时不再重判）。 */
  readonly grant: PermissionRule
  /**
   * **这一次答「总是允许」算不算数**（U38）——外部操作**不记账**。
   *
   * 口径在权限域这一层，不押外壳的自觉：`y / n` 之外，答复面上还有一个 `remember` 位
   * （脚本驱动 `--script` 就按得到），故「外部调用不产生『总是允许』」得由**记账那一处**
   * 说了算——不然一条点不出来的授权会从另一条路进名录。
   */
  readonly rememberable: boolean
  readonly settle: (decision: Decision) => void
}

/** 造一个权限闸门——内核的裁决者（契约端口 `PermissionGate` 的落地）。 */
export function createPermissionGate(options: PermissionGateOptions): PermissionGate {
  const { sink, stamper, grants } = options
  const now = options.now ?? Date.now
  const rules = options.rules ?? []
  /** 全放行——**构造时定死**（见 `PermissionGateOptions.allowAll`；本域没有改它的口）。 */
  const allowAll = options.allowAll === true

  /** 在途询问——**请求事件 id** → 待答复（答复按此配对）。 */
  const pending = new Map<DecisionId, Pending>()

  /** 放行区那一笔账（B10）——本实例的裁决分布，见 `GateTally`。 */
  const tally = { total: 0, uncovered: 0, vetoed: 0 }

  /** 自动放行——不发询问（没问），只落一条裁决事件：**裁者是 `auto`，耗时是真实测量**。 */
  function autoAllow(callRef: RecordId, started: number): Promise<Decision> {
    sink.emit(
      decisionMade(stamper, {
        call: callRef,
        decision: 'approve',
        decider: 'auto',
        elapsedMs: now() - started,
      }),
    )
    return Promise.resolve('approve')
  }

  return {
    decide(call, ctx, callRef) {
      const started = now() // 度量起点：本域开始处理这次裁决（人工 / 自动同一把尺子）
      const { weight, material, ops, landings, title, external } = analyze(call, ctx)

      // 规则轴与判定轴读的是**同一份** `analyze` 结论——两条路径结构上无从分叉
      const face: CallFace = { tool: call.name, ops, landings }
      // **优先级链的次序就在这两行**：手写规则在前、点出来的授权在后
      //（项目规约那一格**留缝不实现**——它要在两者之间，见文件头注那条链）
      const configured = matchRule(rules, face, ctx)
      const granted = configured === undefined ? matchRule(grants.rules(), face, ctx) : undefined
      const hit = configured ?? granted

      tally.total += 1

      // **必闸 ＞ 规则与全放行**：命中的规则、或**全放行**，都只在判定为**轻**时才有资格
      // 放行；判重一律问——必闸类是禁区（清单即禁区），任何规则、全放行都不放行。
      // 判据不押规则作者的自觉，**也不押全放行的自觉**：这一行对两条来路是同一句话。
      //
      // ⚠️ 轻重那一刀仍归 `analyze`（上面那一行），本行**不另立判据**——「全放行会不会
      // 放掉必闸」因此不是一句承诺，是这一行的形状：`weight` 不是 `light` 就落不到这儿。
      if (weight === 'light' && (hit !== undefined || allowAll)) {
        // 授权**真省了一次点击**才记账（`hit` 的语义见 `grants.ts`）——
        // 命中却被否决的不记：那条授权并没有替用户挡下什么。
        // ⚠️ **全放行下也不记**：这一笔放行不是它挣来的（判轻就放，与命没命中无关），
        //    记了等于替一条**此刻并没在起作用**的授权续命——陈旧那一格正是据 `hit` 判的。
        if (granted !== undefined && !allowAll) grants.hit(granted)
        return autoAllow(callRef, started)
      }

      // 落到这儿＝要问。问之前先把这一笔记进**放行区那笔账**（B10 口径的两个分子）：
      // 命中了却被禁区否决的是 `vetoed`，一条都没命中的是 `uncovered`（见 `GateTally`）
      if (hit === undefined) tally.uncovered += 1
      else tally.vetoed += 1

      const request = decisionRequest(stamper, {
        call: callRef,
        // 卡上那个名字：外部工具＝`服务器 / 工具`（身份由注册表来），内置工具＝工具名
        name: title ?? call.name,
        // 规则命中却被禁区否决时说清缘由——配了规则的人第一个会问的就是「为什么还问我」
        material: hit === undefined ? material : vetoed(material, hit),
        weight,
        ...(external === true ? { external: true } : {}),
      })

      // **先登记、后扇出**——外壳可能在同一调用栈里答复（答复不必等一轮事件循环），
      // 顺序反了这条答复就落在空表上（丢答复＝永久挂起）。
      const answered = new Promise<Decision>((settle) => {
        pending.set(request.id, {
          call: callRef,
          at: started,
          grant: grantOf(face),
          // 外部操作不给「总是允许」——连记都不记（见 `Pending.rememberable`）
          rememberable: external !== true,
          settle,
        })
      })

      sink.emit(request)

      return answered
    },

    resolve(requestId, decision, options) {
      const question = pending.get(requestId)
      // 陌生 id（迟到 / 重复 / 伪造）＝忽略——不抛、不猜、不改写
      if (question === undefined) return
      pending.delete(requestId)

      // 「总是允许」——只认批准（规则只有「允许」这一形）；同形的已在册＝账本自己不去重，
      // 不重复入册这件事归账本（`remember` 的注）。
      // **外部操作不记**（`rememberable`）——它的效果不由本机裁定，一条「同类自动放行」
      // 记不下那个判断；这一步与外壳给不给 `a` 无关，是记账那一处自己的口径。
      if (question.rememberable && options?.remember === true && decision === 'approve') {
        grants.remember(question.grant)
      }

      // 裁决只走事件、不入条目（技术方案 · 领域划分 · 权限域）；耗时＝本域开始处理 → 答复（度量埋点）
      sink.emit(
        decisionMade(stamper, {
          call: question.call,
          decision,
          decider: 'user', // 人答的——自动放行走 `autoAllow`，两条路径的裁者分得开
          elapsedMs: now() - question.at,
        }),
      )

      question.settle(decision)
    },

    tally: () => ({ ...tally }),
  }
}

/**
 * 规则命中却被禁区否决——把缘由写进材料。
 *
 * 这一句是给**配规则的人**的：规则写宽了、碰到必闸类时，界面上的询问会照着材料显示，
 * 没有这一句，用户只会看到「配了规则还是问」而不知道规则其实命中了（且**本该**被否决）。
 */
function vetoed(material: string, rule: PermissionRule): string {
  return [
    material,
    `规则：命中「${describeRule(rule)}」但被必闸禁区否决（必闸 ＞ 规则——必闸类任何规则不可放行）。`,
  ].join('\n')
}
