/**
 * `PermissionGate` —— 权限域端口（技术方案 · 领域划分：工具域 → 权限域，闸门在 `invoke` 路径内）。
 *
 * 一次裁决的全流程：
 *
 *   机械分析（工具名 ＋ 参数）→ 危险分级 → **在不在名单里 ／ 规则命中？** → 自动放行（`decider: 'auto'`）
 *     ／否则发 `tool.decision.request`（带材料与呈现轻重）→ 等答复（`resolve`，配对＝请求事件 id）
 *     → 发 `tool.decision` → 返回裁决
 *
 * **默认是通；这一层控的是「禁止」**（2026-09-25 用户定 · 反向）——次序是这条链：
 *
 * ```
 *   内核直接拒（删除那一类） ＞ 内置禁止名单（＝改权限那一类） ＞ 项目规约（留缝·不实现）
 *     ＞ 用户手写规则 ＞ 点出来的授权 ＞ （其余一律默认通）
 * ```
 *
 * ⚠️ **链的底换过一次**（U76）：从前是「**默认问**」（阶段 1 全人工门——判轻的也要先配规则
 * 才通），现在是「**默认通**」——**不在名单里就不问**（设计 · 权限「默认是通；这一层控的是
 * 「禁止」」）。跟着来的是：判轻的不必配规则 · 全放行连名单也放 · 判不出来的（`unknown`）
 * 按默认通。
 *
 * ⚠️ **链首换过一次**（U77）：**删除那一类**从"要授权"整类移出，改成**直接拒**
 * （设计 · 权限「`rm` 直接拒，指路 `trash`」）——**不问、也不放**（连全放行也放不动它，
 * 理由见 `decide` 里那一段）。⇒ **名单里只剩改权限那一类**（`commands.ts` 的 `PERMISSION`），
 * 那是**产品的安全承诺**（设计明写），故它归 `analyze` 一处判。
 *
 * 而 **「全放行」**（U73 立 · **U76 改定**）**不是这条链上的一格，也不是一个「模式」**
 * ——它是**权限这一维的一个取值**，只动「该不该做」那一问的**默认答什么**：**一个布尔**
 * （全放行 ／ 不全放行），**不给它加档、不留扩展位**（设计明文）。它落在本域的效果只有一件：
 * **什么都不问**（连名单那两条也放）。⚠️ **产品在这一档下不再作「漏拦」那个承诺**
 * ——必闸本来是产品的安全承诺；**危险模式是用户显式要的一次性决定**（设计明文）。
 *
 * 本文件是这条链的**唯一落定处**；括号里标出每一格住在哪儿：
 * - **名单**（判重的那两类）——`analyze` 每次当场重判（判据不押规则作者的自觉）；
 * - **项目规约**——**留缝不实现**（设计明文：采纳它要配「首次确认 ＋ 只许收窄」）；
 * - **用户手写规则**——`options.rules`（装配从配置读来、经 `parseRules` 校验）；
 * - **点出来的授权**——`options.grants`（**工作区级**账本，见 `grants.ts`）；
 * - **默认通**——链的底：不在名单里就是它。
 *
 * 规则如今只在一处还够得着判重的调用：**判重却带域名**的那一件（外发按域名，U72 · `byHost`）
 * ——那是规则作者明确点过的去向。除此之外判重一律问（名单即禁区，任何规则不可放行）。
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
  RefusalKind,
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
  /**
   * **内核直接拒的那一笔，理由是哪一条**（U77 · 见契约 `RefusalKind`）。
   *
   * 工具域据此给模型一句有用的话（「用 `trash` 删」那一句）——**它不解析命令**，
   * 判据只在权限域这一处（与 `decide` 同一次机械分析）。
   */
  refusalOf(call: ToolCall, ctx: PermissionContext): RefusalKind | undefined
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
 * 两个数**只差 `vetoed` 那一格**：规则命中了却被名单否决的调用，对**用户**是同一个
 * 体验（还是弹了卡），而对**规则作者**不是一件事（他得知道「我配的规则够不着这类」）。
 * 故分两格记，不合并——合成的那个数两边都说不准。
 *
 * ⚠️ **默认通之后，这两个数的分母变了**（U76）：判轻的调用**不再经过这里**（它们不问），
 * 故 `total` 里只有判重的那些会走上面两支。这一档下的账**读不回去**（`uncovered` 恒等于
 * 「问了且没配规则」，而不是「大部分调用」）——要与历史比，得先知道比的是哪一版口径。
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
   * **全放行**（U73 立 · **U76 改定**）——**权限这一维的一个取值**（不是「模式」、不是新的一层）：
   * **一个布尔**，**只在起会话那一刻**由命令行给；会话活着的时候**没有任何入口改它**
   * （它是构造入参，本域不提供 setter——「对话期间切不进去」在代码里就是这个形状）。
   *
   * 落了什么：**连必闸也放——真的什么都不问**（删除 · 改权限族 · 以及一切判重的调用），
   * 全都走**同一条**自动放行路（`decider: 'auto'`、耗时照测、事件照发）。
   *
   * ⚠️ **这条改过一次**（2026-09-25 用户定）：U73 落的是「放轻的、必闸照样挡」——**那是旧版**。
   * 由头：默认已经是「通」，只剩名单那两条要问；**若全放行也不放它，两者一模一样 ⇒ 这一档
   * 就是个空开关**。**它必须比默认更放，才有存在理由。**
   *
   * ⚠️ **产品在这一档下不再作「漏拦」那个承诺**——名单本来是**产品的安全承诺**；
   * **危险模式是用户显式要的一次性决定**，不是产品偷偷松的（设计明文）。
   * 护栏是**过程上的三条**，不是判据上的：**入口只在启动那一刻 · 状态行常驻报着 ·
   * 要改得先退出去**——前两条在装配与外壳，后一条就是"没有 setter"这件事本身。
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
      const analysis = analyze(call, ctx)

      // ⓪ **删除那一类：内核直接拒**（U77）——**这一步必须排在最前**。
      //
      // ⚠️ **次序是这一段的全部内容**：拒的那一笔若落到下面任何一条支上，
      // 「默认通」或「全放行」就会**把 `rm` 放过去**——而这一单要的恰恰是
      // **全放行也照拒**（拒的理由是"这个命令不可逆"，不是"你该问我"；`--allow-all`
      // 只动「问不问」那一维）。
      //
      // 结构上还有一道保险：`AnalysisRefused` 这一形**没有 `weight`**——
      // 想读它就得先分支（`analyze.ts` 那两个型的注里写着），"忘了先判拒"编译期就报。
      //
      // **不发询问**（没有卡）：拒不是问，模型那边收到的是回执里那句话（工具域写的）。
      // 落一条 `decision: 'reject'` 的裁决事件——**裁者是 `kernel`**：内核按规则自己定的，
      // 没人被问过。
      //
      // ⚠️ **不能写成 `auto`**（U77 补的那一格）：`DecisionHistory` 那本账的口径是
      // 「**没问**就怎样」，而 `auto` 那一格说的是「没问就**放行**」——写成它，
      // 这一笔"拒"会被读成"放行"（**正好反着**）。`Decider.kernel` 就是为这一笔加的。
      if (analysis.refusal !== undefined) {
        sink.emit(
          decisionMade(stamper, {
            call: callRef,
            decision: 'reject',
            decider: 'kernel',
            elapsedMs: now() - started,
          }),
        )
        tally.total += 1 // 只记总数（既没问、也没放行——`uncovered`/`vetoed` 两格都说不准它）
        return Promise.resolve('reject')
      }

      const { weight, material, ops, landings, title, external, host } = analysis

      // 规则轴与判定轴读的是**同一份** `analyze` 结论——两条路径结构上无从分叉
      const face: CallFace = {
        tool: call.name,
        ops,
        landings,
        ...(host === undefined ? {} : { host }),
      }
      // **优先级链的次序就在这两行**：手写规则在前、点出来的授权在后
      //（项目规约那一格**留缝不实现**——它要在两者之间，见文件头注那条链）
      const configured = matchRule(rules, face, ctx)
      const granted = configured === undefined ? matchRule(grants.rules(), face, ctx) : undefined
      const hit = configured ?? granted

      tally.total += 1

      // **默认通；这一层控的是「禁止」**（2026-09-25 用户定 · 反向）——放行判据只有三条来路：
      //
      // 1. **不在名单里 ⇒ 通**（`weight === 'light'`）：**不必先配一条规则**。
      //    名单只剩两条（删除 · 改权限/属主/属性/ACL，见 `commands.ts`），判重的一律问。
      //    ⚠️ 判据不押规则作者的自觉——`weight` 那一刀归 `analyze`，本行**不另立判据**。
      // 2. **规则命中**：判**轻**时本就通（见上），故规则在这里只剩**一个**用处——
      //    **外发那一件按域名**（U72 · `byHost`）：那是规则作者明确点过的域名，
      //    与"轻重"无关，故它与 `weight` 是**或**的关系。
      //    ⚠️ **别把它顺手删掉**：那是 U72 的「取网页」，判重（外发），全靠这一条放行。
      // 3. **全放行**（U73 立 · **U76 改定**）：**连必闸也放——真的什么都不问**。
      //    ⚠️ **它替的是「那一问的默认答什么」**，不是"绕过"：入口只在起会话那一刻
      //    （`options.allowAll` 是构造入参，本域没有改它的口），状态行常驻报着。
      //    由头：默认已经是「通」，只剩名单那两条要问；若全放行也不放它，这一档就是个空开关。
      if (weight === 'light' || (hit !== undefined && byHost(hit, face)) || allowAll) {
        // 授权**真省了一次点击**才记账（`hit` 的语义见 `grants.ts`）——命中却被否决的不记：
        // 那条授权并没有替用户挡下什么。
        // ⚠️ **两条不记**：判**轻**的那一类（默认就通，**根本不需要它**）与**全放行**下
        //    （这一笔放行不是它挣来的）——记了等于替一条**此刻并没在起作用**的授权续命
        //    （陈旧那一格正是据 `hit` 判的）。
        if (granted !== undefined && weight !== 'light' && !allowAll) grants.hit(granted)
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
        // **这一次发往哪个域名**（U72）——卡上写清去向，也是「总是允许」那一格对不对得上的依据
        ...(host === undefined ? {} : { host }),
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

    /**
     * **这一笔是不是内核直接拒的、理由是哪一条**（U77 · 见契约 `PermissionGate.refusalOf`）。
     *
     * 与 `decide` **同一处产出**（同一次 `analyze`——纯机械分析，没有副作用，算两遍无妨）：
     * 工具域据它挑那句话，**自己一个字都不解析**（域间不 import，它也不该会解析 shell）。
     *
     * ⚠️ **它只是"为什么"，不是"放不放"**：放不放由 `decide` 说了算，且那条路一律不放。
     * 调用方**不该**拿这一位去替 `decide` 做判断（问了就是两次裁决）。
     */
    refusalOf(call, ctx) {
      return analyze(call, ctx).refusal
    },
  }
}

/**
 * **按域名放行**（U72）——「必闸 ＞ 规则」那一条的**唯一例外**，也是「总是允许按域名给」
 * 在判定上的那一半。
 *
 * ## 它凭什么算例外
 *
 * 必闸之所以是禁区，是**规则表达不了那个判断**：一条 `{tool:'exec', op:['delete']}`
 * 说的是「这一类事别再问」，可用户当时答的是**某一次删除**——宽窄对不上，所以不放行。
 * 域名这一格恰恰把宽窄补上了：命中它**必须**是一次带域名的调用 ＋ 一条**写明域名**的规则
 * （`matchesHost`：这一侧有域名时，没写域名的规则根本不命中）。于是放行的这一条
 * 说的就是**用户点头的那一件事本身**——「往 `example.com` 发」。
 *
 * ## 判据是**这一次调用**带没带域名，不是规则带了没
 *
 * 两件都要（`face.host !== undefined` 与 `rule.host !== undefined`）：
 * 只看规则那一侧的话，一条写给 `exec` 的 `{tool:'exec', host:'x.com'}` 会顺带把
 * **所有** `exec` 调用都放行（`exec` 的 face 没有域名这一维，`matchesHost` 对它恒真）——
 * 那是把一个必闸类的口子开到最大。故判据落在**这一次调用**上。
 */
function byHost(rule: PermissionRule, face: CallFace): boolean {
  return face.host !== undefined && rule.host !== undefined
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
