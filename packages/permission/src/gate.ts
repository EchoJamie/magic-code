/**
 * 工具执行前唯一权限闸门。调用方先解析本次参数与真实目标，本域统一处理直接禁止、
 * 自动放行、已有规则和人工审批。等待答复属于原决断，不发起第二轮裁决。
 * 删除族直接拒绝优先于 allowAll；其余轻调用默认允许，重调用仅既有域名授权或
 * allowAll 自动放行。工作区外文件/目录操作须明确批准，且不由一次批准扩成宽授权。
 * 取消在原 pending 表中完成拒绝并移除，迟到/重复答复不得再次裁决或记授权。
 * 路径和文件身份由执行域提供；本域不读取文件系统。
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

/** 契约权限端口加上本实例裁决统计；取消信号沿用原 pending，不增加决断状态。 */
export interface PermissionGate extends PermissionGatePort {
  decide(call: ToolCall, ctx: PermissionContext, callRef: RecordId, signal?: AbortSignal): Promise<Decision>
  /**
   * 控制域答复路由至此——配对键＝**请求事件** `id`。
   *
   * 第三参是**结构超集**（契约端口两参照常工作，同 U07 之例）：`options.remember` ＝
   * 外壳的第三个按钮**「总是允许」**——**这个工作区**此后**同类**不再问（见 `ResolveOptions`）。
   */
  resolve(requestId: DecisionId, decision: Decision, options?: ResolveOptions): Promise<void>
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
  readonly rules?: readonly PermissionRule[] | (() => readonly PermissionRule[]) | undefined
  readonly refreshGrants?: (() => void) | undefined
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
  /** 启动时固定的全放行选项：省去人工询问，但不覆盖内核直接禁止。 */
  readonly allowAll?: boolean | undefined
  /** 内核产物的只读目录，仅 read 可免询问；此名单只由闸门持有。路径须由装配规范化。 */
  readonly readOnlyDirs?: readonly string[] | undefined
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
  readonly signal: AbortSignal | undefined
  readonly cleanup: () => void
}

/** 造一个权限闸门——内核的裁决者（契约端口 `PermissionGate` 的落地）。 */
export function createPermissionGate(options: PermissionGateOptions): PermissionGate {
  const { sink, stamper, grants } = options
  const now = options.now ?? Date.now
  const rules = options.rules ?? []
  /** 全放行——**构造时定死**（见 `PermissionGateOptions.allowAll`；本域没有改它的口）。 */
  const allowAll = options.allowAll === true
  /**
   * **内核自己的只读落点**（U80）——读类调用另认的几处（见 `PermissionGateOptions.readOnlyDirs`）。
   * 归零成空数组：缺省不给＝一处都不认，故「没接这一位」与「接了空表」是同一件事。
   */
  const readOnlyDirs = options.readOnlyDirs ?? []

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
    decide(call, ctx, callRef, signal) {
      const started = now() // 度量起点：本域开始处理这次裁决（人工 / 自动同一把尺子）
      const analysis = analyze(call, ctx, readOnlyDirs)

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
      if (analysis.refusal !== undefined || signal?.aborted === true) {
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
      options.refreshGrants?.()
      const configured = matchRule(typeof rules === 'function' ? rules() : rules, face, ctx)
      const granted = configured === undefined ? matchRule(grants.rules(), face, ctx) : undefined
      const hit = configured ?? granted

      tally.total += 1

      // 轻调用默认允许；重调用只由既有域名授权或启动时 allowAll 自动放行。
      // 普通路径规则不覆盖根外目标询问，也不因单次批准扩成目录授权。
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

      const cancel = (): void => {
        const question = pending.get(request.id)
        if (question === undefined) return
        pending.delete(request.id)
        question.cleanup()
        sink.emit(decisionMade(stamper, {
          call: callRef, decision: 'reject', decider: 'kernel', elapsedMs: now() - started,
        }))
        question.settle('reject')
      }

      // **先登记、后扇出**——外壳可能在同一调用栈里答复（答复不必等一轮事件循环），
      // 顺序反了这条答复就落在空表上（丢答复＝永久挂起）。
      const answered = new Promise<Decision>((settle) => {
        pending.set(request.id, {
          call: callRef,
          at: started,
          grant: grantOf(face),
          // 外部操作不给「总是允许」——连记都不记（见 `Pending.rememberable`）
          rememberable: external !== true && landings.every((landing) => landing.inside),
          signal,
          cleanup: () => signal?.removeEventListener('abort', cancel),
          settle,
        })
      })

      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      else sink.emit(request)

      return answered
    },

    async resolve(requestId, decision, options) {
      const question = pending.get(requestId)
      // 陌生 id（迟到 / 重复 / 伪造）＝忽略——不抛、不猜、不改写
      if (question === undefined) return
      pending.delete(requestId)
      question.cleanup()

      // 「总是允许」——只认批准（规则只有「允许」这一形）；同形的已在册＝账本自己不去重，
      // 不重复入册这件事归账本（`remember` 的注）。
      // **外部操作不记**（`rememberable`）——它的效果不由本机裁定，一条「同类自动放行」
      // 记不下那个判断；这一步与外壳给不给 `a` 无关，是记账那一处自己的口径。
      if (question.rememberable && options?.remember === true && decision === 'approve') {
        try { await grants.remember(question.grant) }
        catch (error) { question.settle('reject'); throw error }
      }

      if (question.signal?.aborted) decision = 'reject'

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
      // 与 `decide` **同一次机械分析**（同参同源，见头注那句「一处产出」）
      return analyze(call, ctx, readOnlyDirs).refusal
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
