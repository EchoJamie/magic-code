/**
 * 模型特征标记 —— 生效判定（技术方案 · 模型策略 · 模型特征标记）。
 *
 * 常规模型的思考走**独立通道**（供应商字段 / SDK 已归一）；**内嵌在正文里**
 * （`<think>…</think>` 标签）是**少数模型的行为**，不当通例处理——无条件切分＝对正常模型的
 * 无谓改写。故三件定「生效标记」，归一据它决定是否切：
 *
 * ① **内置表**——模型域持有，按**型号主干（家族）**匹配（首站一条：`MiniMax-M3`）。
 *    出厂即对、随代码版本升级——新模型不必等用户先知道它的怪癖（R1 / R2 / 准则 3）。
 * ② **认下的那些**——`LearnedTraits`（见下）：**这个模型名真出过内嵌思考** ⇒ 直接按它办。
 *    内置表按家族覆盖不到的（供应商新推的名字）由这条路随用生长，不必等新版本。
 * ③ **覆盖位**——`providers.<id>.traits`（共享语言 · 配置形制）：**表外模型**（本地 / 私有端点 /
 *    供应商改了行为）的唯一出口；配置**非空则整组覆盖**上面两条的判定。
 * ④ **皆未命中** → 按常规行为处理，**但先过一道探针**（见 `inline-thinking.ts` 的
 *    `probingSplitter`）：**模型输出以已知标签开头**才认（认下并留存），否则正文原样走 `text`。
 *
 * `ModelTraits` 的形态在 `@magic/contracts`（端口内类型）——**内置表不入契约**（模型域持有）。
 */

import type { ModelTraits } from '@magic/contracts'

/**
 * 内置表——键是**型号主干（家族）**，不是完整型号名、更不是供应商 id。
 *
 * 两条由头合一：
 *
 * - **不是供应商 id**——同一家可挂行为不同的模型，**怪癖跟着模型走**（供应商当键会把
 *   「这一家有内嵌思考」错安到全家的每一个模型上）；
 * - **是主干而不是完整名**——**同一个病犯过三次**：09-16 表里只有 `M3`、09-18 `M2` 漏了、
 *   09-25 `M2.7-highspeed` 又漏了。三次都是**同一个模型线换了版本号**，而每一次都靠用户
 *   真跑撞出来（夹具的模型名是写死的）——**再加一行治不了下一次**。
 *   故判据从「名字一模一样」换成「**同类行为、不同版本号**」：`M2` 这条同时盖住
 *   `MiniMax-M2` / `MiniMax-M2.5-highspeed` / `MiniMax-M2.7-highspeed` 与将来的小改款。
 *
 * 匹配规则见 `belongsToFamily`：**相等，或主干后面接一个分隔符（`.` / `-`）**。
 * 分隔符那一条是**必需的**——没有它，`MiniMax-M2` 会连 `MiniMax-M20` 一并吞掉。
 *
 * 生长方向（技术方案：「标记集合随用生长」）：是否支持工具调用 / 上下文窗等；
 * 首站只落「内嵌思考」一条。
 */
export const MODEL_TRAITS_BUILTIN: Readonly<Record<string, ModelTraits>> = {
  // 真端点实测（2026-09-16）：MiniMax-M3 经 OpenAI 兼容端点**不回** `reasoning_content`，
  // 而是把思考写在 `content` 里、用 `<think>…</think>` 包住。
  'MiniMax-M3': { inlineThinking: { tag: 'think' } },
  // 真端点实测（2026-09-18 · 第 17 轮真跑暴露）：**M2 同样内嵌正文**——
  // 当时表里只有 M3，M2 的思考原样混进 `text` 通道（屏上看得见裸的 `<think>` 标签）。
  // 加表即按「出厂即对」处置：用户不必先知道这个怪癖才用得上它。
  //
  // 这条键同时是 **M2 那一线的主干**（U65）：`M2.5-highspeed` / `M2.7-highspeed` 等
  // 小改款落在这里，不再各要一行（09-25 真机取证：用户用 `MiniMax-M2.7-highspeed`，
  // 整段 `<think>…</think>` 当正文落库也印屏，而那一轮是 settled、不是报错）。
  'MiniMax-M2': { inlineThinking: { tag: 'think' } },
}

/** 家族分隔符——主干后面接它才算「同一个模型线的小改款」。 */
const FAMILY_SEPARATORS = ['.', '-'] as const

/**
 * 这个键算不算 `model` **那一线**的主干——相等，或后面紧跟一个分隔符。
 *
 * ⚠️ **分隔符不是装饰**：只要 `startsWith` 的话，`MiniMax-M2` 会连 `MiniMax-M20` 一并认下——
 * 那是另一个模型名，不是一个版本号。
 */
function belongsToFamily(model: string, family: string): boolean {
  if (!model.startsWith(family)) return false
  const rest = model.slice(family.length)
  return rest.length === 0 || FAMILY_SEPARATORS.some((one) => rest.startsWith(one))
}

/**
 * 查内置表（**家族匹配**）——`MiniMax-M2.7-highspeed` 落 `MiniMax-M2` 那一条。
 *
 * **最长的那条主干胜**：将来若为某个小改款单列一条更具体的行为，它盖得住主干的判定
 * （次序不靠表的书写顺序，靠键长本身——写表的人换一下行序不会改判据）。
 *
 * 用 `Object.keys` 而不是直接下标：条目名 / 模型名都是外面来的字符串，
 * 普通下标会从 `Object.prototype` 上摸到东西（同 `capacity.ts` 的 `ownOf` 注）。
 */
export function matchBuiltinTraits(model: string): ModelTraits | undefined {
  let best: string | undefined
  for (const family of Object.keys(MODEL_TRAITS_BUILTIN)) {
    if (!belongsToFamily(model, family)) continue
    if (best === undefined || family.length > best.length) best = family
  }
  return best === undefined ? undefined : MODEL_TRAITS_BUILTIN[best]
}

/**
 * **已知的内嵌思考标签**——从内置表**现取**（不另立一张名单）。
 *
 * 用处只有一个：探针拿它判「模型输出是不是以**已知标签**开头」（见 `probingSplitter`）。
 * 另写一份字面量就会与表分叉——表里加了新标签而探针不认，正是本单要治的那种漏。
 */
export function knownInlineTags(): readonly string[] {
  const tags = new Set<string>()
  for (const traits of Object.values(MODEL_TRAITS_BUILTIN)) {
    const tag = traits.inlineThinking?.tag
    if (tag !== undefined && tag.length > 0) tags.add(tag)
  }
  return [...tags]
}

/**
 * **认下的那些**——模型特征标记「随用生长」的落点（U65 第二层）。
 *
 * 由头：内置表是**出厂**那份，供应商每推一个新名字就漏一次（那个病犯过三次）。
 * 光靠加家族主干仍要**有人先写一行**；而真跑里本来就有强信号：**模型输出以某个已知标签
 * 开头**（见 `inline-thinking.ts` 的 `probingSplitter`）。认出来就记在这儿——
 * **这个模型名出现过内嵌思考 ⇒ 下一次直接按它办**，不必等表、不必等新版本。
 *
 * 三条边界：
 * - **按精确模型名记**（不是家族）——认下的是**这一个模型**的行为，同线的另一个名字
 *   该由它自己的输出说了算；
 * - **进程内**，不落盘：它是「这次用下来学到的东西」，不是配置、不是缓存文件
 *   （设计：不为新机制再维护一份平行名单）。**真活的出口仍是覆盖位**——认错了、
 *   或这一版不再这么干，配置里写 `traits` 就压得住（且跨进程有效）；
 * - **有读面**（`entries()`）——「认下了什么」看得见，别做成黑箱。
 */
export type LearnedTraits = {
  get(model: string): ModelTraits | undefined
  /** 认下一条——同一个模型名再认一次＝**覆盖**（以最近一次观察为准）。 */
  remember(model: string, traits: ModelTraits): void
  /** 读面（可查）——按认下的次序。 */
  entries(): readonly (readonly [string, ModelTraits])[]
}

/** 造一份空的——装配根造一份、各条目的网关共用它（认下的是模型的行为，与走哪条连接无关）。 */
export function createLearnedTraits(): LearnedTraits {
  const known = new Map<string, ModelTraits>()
  return {
    get: (model) => known.get(model),
    remember: (model, traits) => {
      known.set(model, traits)
    },
    entries: () => [...known.entries()],
  }
}

/**
 * 生效标记——**查认下的那些 → 查内置表（家族）→ 配置有则接管**（技术方案 · 模型策略）。
 *
 * 判据＝「**键在即接管**」：`traits` **存在就整组覆盖**（含 `{}` ＝**显式声明无特征**）。
 * 理由（锚定原文）——一条规则胜过一个二级判据，且**内置表判错时用户关得掉**：
 * 若 `{}` 回落内置表，错的模型就没有出口。
 *
 * 覆盖位排在最后一位读：**它连「认下的那些」也压得住**——那正是认错时的出口
 * （见 `LearnedTraits` 的注）。
 *
 * 两处皆无（`undefined`）→ 返回 `undefined`，调用方走**探针**那条路（见文件头注 ④）。
 */
export function resolveModelTraits(
  model: string,
  override?: ModelTraits | undefined,
  learned?: LearnedTraits | undefined,
): ModelTraits | undefined {
  if (override !== undefined) return override

  const fromUse = learned?.get(model)
  if (fromUse !== undefined) return fromUse

  return matchBuiltinTraits(model)
}
