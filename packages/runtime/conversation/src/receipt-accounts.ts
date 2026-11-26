/** 一次交代的回执账 —— 从 agent-loop.ts 按职责拆出（行为不变）。
 *
 * 两本账与一份判据：
 * - **技能回执账**（`createAnnouncer`，U33）——`skill.used` 每个身份只报一次，
 *   且都在「带着那份材料的请求**真回来**之后」；
 * - **材料账**（`createMaterialWatch`，U63）——「引用了、却没被读过」收束时要说出来；
 * - **「请求真回来了」的判据**（`RESPONSE_EVENTS`）——只认产出方是供应商流的那三种事件。
 */
import type { EventKind, InputRefEntry, UsedSkill } from '@magic/contracts'
import type { TextRefEntry } from './context.ts'
import type { Announcer, LoopRuntime, MaterialWatch } from './loop-runtime.ts'

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
export const RESPONSE_EVENTS: ReadonlySet<EventKind> = new Set<EventKind>([
  'model.delta',
  'model.usage',
  'model.call.end',
])

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
export function createAnnouncer(runtime: LoopRuntime, selected: readonly UsedSkill[]): Announcer {
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

/** 技能的身份（报重了没有按它判）：名字 ＋ 来源路径，两件缺一都不是同一份。 */
function identityOf(skill: UsedSkill): string {
  return [skill.name, skill.source].join('\u0000')
}

/**
 * **一次交代里「引用了、但没被读过」的那几份**（U63）。
 *
 * ## 认「读过」的判据是结构化的，不是比字符串
 *
 * 两处证据，各按各自的身份：
 * - **技能**——工具结果上那一位 `skill.name`（`ToolResult.skill`，U33 起就有的那条通道）；
 * - **文件 / 目录**——工具结果上的**落点**（`ToolResult.read`：已归位的真路径 ＋ 读多宽）。
 *
 * ⚠️ **为什么不让对话域拿模型的原话去比**：模型给的是相对写法（`src/login.ts`），
 * 材料记的是真路径（`/ws/src/login.ts`）——中间那一步归位只有沙箱那一层做得对。
 * 靠字符串比对的话，改个写法就认不出（错向「说它没读」——一句当场为假的话）。
 *
 * ## 只看那几份「自读」的
 *
 * 图片、以及工作区外那份只读附件**照旧引用即进**（它们的条目里带着正文）——
 * 那几份随请求展开，没有「读没读」这回事，不进这份账。
 *
 * ## 一份材料被同一句话引用两次
 *
 * 按**身份**记（技能是名字、文件是目录是那一条真路径），故同一份读一次就算读过
 * （设计：「重复引用也不能因按身份去重而丢掉出现位置」说的是**位置**，账是另一回事）；
 * 报出来时按 `marker` 去重，免得同一串字在那一行里出现两遍。
 */
export function createMaterialWatch(refs: readonly InputRefEntry[]): MaterialWatch {
  // 自读那一份＝没有条目正文的那几支（见契约 `InputRefEntry`：正文在＝引用即进）
  const watched = refs.filter(
    (ref): ref is TextRefEntry => ref.kind !== 'image' && ref.text === undefined,
  )
  const done = new Set<string>()

  return {
    see(outcome): void {
      if (!outcome.ok) return

      // 技能——身份由工具交回（名字即完整地址，同名在发现那一层已只剩一条）
      if (outcome.skill !== undefined) done.add(skillKey(outcome.skill.name))

      const at = outcome.read
      if (at === undefined) return

      for (const ref of watched) {
        if (ref.kind === 'skill') continue
        if (touched(ref.source, at)) done.add(placeKey(ref.source))
      }
    },

    unread(): readonly string[] {
      const markers: string[] = []
      for (const ref of watched) {
        if (done.has(identityKeyOf(ref))) continue
        if (!markers.includes(ref.marker)) markers.push(ref.marker)
      }

      return markers
    },
  }
}

/** 一份材料的身份键——技能按名字，文件 / 目录按那条真路径（两处都用整串比，不拼前缀误伤）。 */
function identityKeyOf(ref: TextRefEntry): string {
  return ref.kind === 'skill' ? skillKey(ref.name) : placeKey(ref.source)
}

function skillKey(name: string): string {
  return `skill\0${name}`
}

function placeKey(source: string): string {
  return `place\0${source}`
}

/**
 * 这一趟读的落在这一份材料的范围里吗——**两向都算**（判据见 `createMaterialWatch`）。
 *
 * - **落在它里面**（`at.path` 起于 `source` 之下）：读了一个目录里的文件 / 列了一个子目录
 *   ——那一份材料确实被用上了；
 * - **在它外面那一处以内搜过内容**（`covers: 'subtree'`，`grep` 那种）：范围内的都算碰过。
 *
 * ⚠️ **`exact` 那一档不向外扩**：`ls` 一个父目录只看见名字、没看见内容（`glob` 同理），
 * 把那说成「读过」会让用户以为材料进了模型眼前，而它没有。
 */
function touched(source: string, at: { readonly path: string; readonly covers: 'exact' | 'subtree' }): boolean {
  return under(at.path, source) || (at.covers === 'subtree' && under(source, at.path))
}

/** `child` 落在 `parent` 里（含同一处）——按**段边界**判，不认字符串前缀相邻（同工作区那一把尺子）。 */
function under(child: string, parent: string): boolean {
  if (child === parent) return true
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}
