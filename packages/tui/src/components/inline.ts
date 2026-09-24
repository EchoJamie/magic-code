/**
 * **正文里的引用**（U36）——外壳这一半：草稿上的「位置 ＋ 身份」。
 *
 * 出处：设计 · 终端交互 ·「引用留在交代的位置」。
 *
 * ## 草稿＝文字 ＋ 一串引用区间
 *
 * 引用**留在它被说出来的位置**（「先读 `@需求.md`，再按 `/review` 检查 `@src/login.ts`」），
 * 故草稿的形态是：**一个字符串** ＋ **若干 `[start, end)` 区间**。字符串里那一段
 * （`marker`：`@src/login.ts` / `/review`）就是屏上看得见、打得动的那几个字；
 * 区间只多带一样东西——**身份**（`source` 真路径：同名两份技能、同名两个文件靠它分开）。
 *
 * 为什么不把引用抽成「独立参数」再在旁列一行：那样屏上有两处说同一件事（正文一处、
 * 列表一处），删了正文那处材料还在——**暗带**。这里只有一处真源：**删掉那一段文字，
 * 那处材料就没了**（区间随文字一起没）。
 *
 * ## 编辑规则（设计写死的那几条）
 *
 * - **引用是一个可定位的编辑单位**：`←/→` 越过它（不落进去），`退格/删除` 整体移除；
 * - **选区触及引用时包含整个引用**：删掉一段文字若压到某处引用，那一处整个跟着走
 *   （不留下半截 marker）；
 * - **正文照常编辑**：区间跟着位移，一个字都不改写——普通文字仍是普通文字
 *   （**不建设通用块编辑器**：引用只是「一段带身份的文字」，不是另一种文档模型）。
 *
 * 本文件**纯函数**：渲染、按键、提交、撤销都拿它，故规则只有这一处。
 */

import type { InputRef } from '@magic/contracts'
import { stepLeft, stepRight } from './composer.ts'

/**
 * 草稿里的一处引用——**位置（`start`/`end`，UTF-16 码元）＋ 身份**。
 *
 * 四个 kind 与契约的 `InputRef` 一一对应；`marker` 与 `draft.slice(start, end)` 恒等
 * （区间是那段文字的账，两处不许各说各的——`markerOf` 一处产出，改也是它一处改）。
 *
 * ## 为什么是判别联合而不是「一个带可选字段的对象」（U37）
 *
 * 各支要的东西**不一样**：技能要 `name`，图片要 `mime` ＋ `blob`（**字节所在**），
 * 文件 / 目录什么都不要。平铺成可选字段的话，「一张没带 blob 的图」在类型上**是合法的**
 * ——而它根本提交不出去（`wireOf` 只能拿一个空串顶上，或者当场崩）。收成联合：
 * 有 `kind: 'image'` 就必有 `blob`，走错路 tsc 当场报。
 *
 * ⚠️ `blob` **对这里不透明**：它是记录里那份字节的把手，外壳只**原样带着它走**
 * （不解析、不比较）。它存在这里正是为了「源文件删了也取得回」——
 * 那张图从历史里插回输入行时，一路都没回头看那个路径。
 */
export type DraftRef = DraftRefPlace &
  (
    | { readonly kind: 'skill'; readonly name: string }
    | { readonly kind: 'file'; readonly external?: true }
    | { readonly kind: 'dir'; readonly external?: true }
    | {
        readonly kind: 'image'
        readonly name: string
        readonly mime: string
        /** 字节所在（记录里那一份）——**不透明**，见类型注。 */
        readonly blob: string
        /** 来源的人读写法（历史那一行给的；写进记录要用它）。 */
        readonly label: string
        readonly external?: true
      }
  )

/** 引用共有的那几格——位置 ＋ 身份（见 `DraftRef`）。 */
export type DraftRefPlace = {
  readonly start: number
  readonly end: number
  /** 正文里那一段（`@src/login.ts` / `/review`）——**与区间同物**。 */
  readonly marker: string
  /** 身份：技能＝技能目录真路径，文件 / 目录 / 图片＝真路径。 */
  readonly source: string
}

/**
 * 一处的身份那几格（`marker` 之外的）——造引用时给这个，位置由插入点算。
 *
 * 用**分配式** `Omit`（而不是 TS 自带的那个）：自带的 `Omit<A | B, K>` 只取联合的
 * **公共键**，会把四支压成一个空壳——那样 `RefIdentity` 就丢了 `blob` / `name`
 * 这些正是各支要的东西。
 */
export type RefIdentity = DraftRef extends infer One
  ? One extends DraftRef
    ? Omit<One, 'start' | 'end' | 'marker'>
    : never
  : never

/** 按起点排序（各处改完都过它一道——区间表恒有序，后面每一步才好写）。 */
function sorted(refs: readonly DraftRef[]): readonly DraftRef[] {
  return [...refs].sort((left, right) => left.start - right.start)
}

/**
 * 插入点落在哪一处引用上（`start < at < end`）——**严格在里面**才算。
 * 落在边界上（`at === start` / `at === end`）不算「在里面」：那是「紧挨着它」的位置。
 */
export function insideRef(refs: readonly DraftRef[], at: number): DraftRef | undefined {
  return refs.find((ref) => ref.start < at && at < ref.end)
}

/** 起点在这一处的引用（`delete` 键：插入点正停在它头上）。 */
export function refStartingAt(refs: readonly DraftRef[], at: number): DraftRef | undefined {
  return refs.find((ref) => ref.start === at)
}

/** 终点在这一处的引用（退格键：插入点正停在它尾巴上）。 */
export function refEndingAt(refs: readonly DraftRef[], at: number): DraftRef | undefined {
  return refs.find((ref) => ref.end === at)
}

/** 与 `[from, to)` 相交的引用（含**只碰到边界**的那种？不——边界相接不算占用）。 */
function overlapping(refs: readonly DraftRef[], from: number, to: number): readonly DraftRef[] {
  return refs.filter((ref) => ref.start < to && ref.end > from)
}

/**
 * 插一段文字之后，区间怎么走——`from` 之后的整体右移 `delta`。
 *
 * ⚠️ **插入点落在引用内部时先挪到它的尾巴**（`snap`）：真在中间插一刀会把 marker 劈成
 * 两半（身份还在、文字已经不是那一段了）。这不是「用户会常干的事」，而是**不许发生的事**
 * ——故在这一处收口，别处不必各自防。
 */
export function insertText(
  refs: readonly DraftRef[],
  from: number,
  length: number,
): readonly DraftRef[] {
  const moved = refs.map((ref) =>
    ref.start >= from
      ? { ...ref, start: ref.start + length, end: ref.end + length }
      : ref.end > from
        ? // 稳在里面的那一段：整个挪到新文字之后（见上面那条）
          { ...ref, start: from + length, end: ref.end + length }
        : ref,
  )

  return sorted(moved)
}

/** 删掉 `[from, to)` 之后，区间怎么走——被压到的整个去掉，其后的左移。 */
export function removeRange(
  refs: readonly DraftRef[],
  from: number,
  to: number,
): readonly DraftRef[] {
  const length = to - from

  return sorted(
    refs
      .filter((ref) => !(ref.start < to && ref.end > from))
      .map((ref) => (ref.start >= to ? { ...ref, start: ref.start - length, end: ref.end - length } : ref)),
  )
}

/**
 * **把一段删除范围扩到「整个引用」**——设计：选区触及引用时包含整个引用。
 *
 * 场景是退格 / 删除那一下：光标挨着一处引用（`@src/login.ts` 的紧右边），按一下退格——
 * 若只删一个字素，屏上会留下 `@src/login.t` 这样半截 marker，而身份区间还在后面挂着
 * （**暗带**）。故「压到就整个走」：那一下删掉的是整处引用。
 */
export function widen(
  refs: readonly DraftRef[],
  from: number,
  to: number,
): { readonly from: number; readonly to: number } {
  const hit = overlapping(refs, from, to)
  if (hit.length === 0) return { from, to }

  return {
    from: Math.min(from, ...hit.map((ref) => ref.start)),
    to: Math.max(to, ...hit.map((ref) => ref.end)),
  }
}

/**
 * **把几处引用就地换成另一种**（U62）——正文那一段与区间、插入点**一起**跟着走。
 *
 * 由头：`@` 那一栏选定一条**文件**时，那一处先按路径写进正文（那一刻还不知道它是什么）；
 * 「它其实是一张图」是**问过内核之后**才知道的（`paths.identify`）。知道了就要把那一处
 * 改写成图片的样子（`Image#N` ＋ 内容身份）——**改名不是新插一处**：位置、前后文字、
 * 插入点都该停在原处。
 *
 * 三条：
 * - **只动点名的那几处**（`next` 返回 `undefined` ＝ 不动它），其余区间按长度差平移；
 * - **插入点**落在某处被换的那一段**里面**时，挪到新 marker 之后（与 `replaceWith`
 *   同一条分寸：刚换完，接着打的字跟在这一处后面）；
 * - **一处都没换 ⇒ 原样还回去**（一个字节都不动——「没认出图」那一趟因此不留痕）。
 */
export function retype(
  draft: string,
  refs: readonly DraftRef[],
  caret: number,
  next: (ref: DraftRef) => { readonly marker: string; readonly ref: RefIdentity } | undefined,
): { readonly draft: string; readonly refs: readonly DraftRef[]; readonly caret: number } {
  const ordered = sorted(refs)
  /** 换哪几处——按**原来那个区间对象**认（`next` 返回什么就换什么）。 */
  const replacementOf = new Map<DraftRef, { readonly marker: string; readonly ref: RefIdentity }>()
  const swaps: { readonly from: number; readonly to: number; readonly marker: string }[] = []

  for (const ref of ordered) {
    const replacement = next(ref)
    if (replacement === undefined) continue
    replacementOf.set(ref, replacement)
    swaps.push({ from: ref.start, to: ref.end, marker: replacement.marker })
  }

  if (swaps.length === 0) return { draft, refs, caret }

  // 正文：被换掉那几段就地换掉，其余一个字不动
  let text = ''
  let cursor = 0
  for (const swap of swaps) {
    text += draft.slice(cursor, swap.from) + swap.marker
    cursor = swap.to
  }
  text += draft.slice(cursor)

  /** `pos` **之前**那几段带来的长度差（落在某一段里面由 `moved` 单独处置）。 */
  const shiftBefore = (pos: number): number =>
    swaps.reduce((sum, swap) => (swap.to <= pos ? sum + swap.marker.length - (swap.to - swap.from) : sum), 0)

  const moved = (pos: number): number => {
    const inside = swaps.find((swap) => swap.from < pos && pos < swap.to)

    return inside === undefined
      ? pos + shiftBefore(pos)
      : inside.from + shiftBefore(inside.from) + inside.marker.length
  }

  const movedRefs = ordered.map((ref) => {
    const replacement = replacementOf.get(ref)
    if (replacement !== undefined) {
      const start = moved(ref.start)

      return {
        ...replacement.ref,
        marker: replacement.marker,
        start,
        end: start + replacement.marker.length,
      }
    }

    const start = moved(ref.start)

    return { ...ref, start, end: start + (ref.end - ref.start) }
  })

  return { draft: text, refs: movedRefs, caret: moved(Math.max(0, Math.min(caret, draft.length))) }
}

/** 插一处引用（`[start, end)` 是它在正文里的那一段）——与已有区间**不叠**（叠的去掉）。 */
export function putRef(refs: readonly DraftRef[], ref: DraftRef): readonly DraftRef[] {
  return sorted([...refs.filter((one) => one.end <= ref.start || one.start >= ref.end), ref])
}

/**
 * 替换 `[from, to)` 那一段为**一处引用**——「选定只替换当前查询片段」的落点。
 *
 * ## 插入点落在哪（三条）
 *
 * - 原来在**那一段之前**（严格在前面）⇒ 不动；
 * - 原来**落在里面或正好在它头上**（正打着那个词 / 就停在这一格）⇒ 落在引用之后
 *   （`start + marker.length`）——「刚放进去的这一处引用，接着打的字跟在它后面」；
 * - 原来在**那一段之后** ⇒ 跟着长度差平移。
 *
 * ⚠️ **一律摆到末尾**是不行的（U33 返工轮栽过的那条）：用户把光标停在句中某处、
 * 从候选里选一份之后接着打字，字得跟在他原来那一格，而不是跳到整句话的尾巴上。
 */
export function replaceWith(
  draft: string,
  refs: readonly DraftRef[],
  range: { readonly from: number; readonly to: number },
  ref: { readonly marker: string } & RefIdentity,
  caret: number,
): { readonly draft: string; readonly refs: readonly DraftRef[]; readonly caret: number } {
  const next = draft.slice(0, range.from) + ref.marker + draft.slice(range.to)
  const kept = removeRange(refs, range.from, range.to)
  const shifted = insertText(kept, range.from, ref.marker.length)
  const at = Math.max(0, Math.min(caret, draft.length))
  const delta = ref.marker.length - (range.to - range.from)

  return {
    draft: next,
    refs: putRef(shifted, { ...ref, start: range.from, end: range.from + ref.marker.length }),
    caret:
      at < range.from ? at : at > range.to ? at + delta : range.from + ref.marker.length,
  }
}

// —— 插入点的挪动：按**字素**走，遇到引用**整体跨过去** ——

/**
 * 往左一格——引用**作为整体**跨过（设计：左右越过引用）。
 *
 * 判据取「插入点正落在某处引用的尾巴上」：那一下退到它的**开头**（跨过整处）。
 * 其余情形仍是字素（与 U31 同一把尺子，中文 / emoji 不切坏）。
 */
export function stepLeftOver(refs: readonly DraftRef[], text: string, at: number): number {
  const hit = refEndingAt(refs, at)

  return hit === undefined ? stepLeft(text, at) : hit.start
}

/** 往右一格——同理，插入点落在某处引用的开头时整处跨过去。 */
export function stepRightOver(refs: readonly DraftRef[], text: string, at: number): number {
  const hit = refStartingAt(refs, at)

  return hit === undefined ? stepRight(text, at) : hit.end
}

/**
 * 退格那一下要删的范围——**整体是引用就整体删**，否则按字素一格。
 *
 * 用 `widen` 兜一道：光标紧挨着引用右边时字素那格落在引用尾巴的**外面**（`[end-1, end)`），
 * 不扩的话会留下半截 marker（见 `widen` 那条注）。
 */
export function backspaceRange(
  refs: readonly DraftRef[],
  text: string,
  at: number,
): { readonly from: number; readonly to: number } {
  const hit = refEndingAt(refs, at)
  if (hit !== undefined) return { from: hit.start, to: hit.end }

  return widen(refs, stepLeft(text, at), at)
}

/** `delete` 那一下要删的范围——同 `backspaceRange`，方向相反。 */
export function deleteRange(
  refs: readonly DraftRef[],
  text: string,
  at: number,
): { readonly from: number; readonly to: number } {
  const hit = refStartingAt(refs, at)
  if (hit !== undefined) return { from: hit.start, to: hit.end }

  return widen(refs, at, stepRight(text, at))
}

/**
 * 整份引用**平移** `delta` 格——提交那一刻按「掐掉的头几格」与正文对齐用。
 *
 * 由头：交出去的文字是**掐过头尾空白**的（`trim()`），而引用的位置记的是原草稿里的坐标
 * ——不搬的话，头上有空格时那一处材料会展开在错一格的地方。
 *
 * ⚠️ **掐掉的那一段里不可能有引用**（引用的 `marker` 不以空白开头），故平移之后不会出现
 * 负下标；真出现（手搭的视图）也不是这里该悄悄丢掉的理由——那种数据到内核那头会以
 * 「位置对不上」被夹回（见 `context.ts` 的 `inlineOf`），比在这儿静默少送一份材料好。
 */
export function shiftedRefs(refs: readonly DraftRef[], delta: number): readonly DraftRef[] {
  if (delta === 0 || refs.length === 0) return refs

  return refs.map((ref) => ({ ...ref, start: ref.start + delta, end: ref.end + delta }))
}

/** 一处引用 → 命令面上的那一份（`at` ＝ 起点；`marker` 随正文一起走）。 */
export function wireOf(ref: DraftRef): InputRef {
  if (ref.kind === 'skill') {
    return { kind: 'skill', at: ref.start, marker: ref.marker, name: ref.name, source: ref.source }
  }

  if (ref.kind === 'image') {
    // **整份照搬**（含 `blob`）：这一支不按路径现读——字节早在记录里了（见 `DraftRef` 的注）
    return {
      kind: 'image',
      at: ref.start,
      marker: ref.marker,
      source: ref.source,
      label: ref.label,
      name: ref.name,
      mime: ref.mime,
      blob: ref.blob,
      ...(ref.external === true ? { external: true as const } : {}),
    }
  }

  return {
    kind: ref.kind,
    at: ref.start,
    marker: ref.marker,
    source: ref.source,
    ...(ref.external === true ? { external: true as const } : {}),
  }
}

/** 整份草稿的引用 → 命令面上的那一份（按位置）。 */
export function wire(refs: readonly DraftRef[]): readonly InputRef[] {
  return sorted(refs).map((ref) => wireOf(ref))
}

/**
 * **引用文字该怎么写**（一处产出）——文件 / 目录带 `@`（目录带尾斜杠），技能带 `/`，
 * **图片是编号**（`Image#N`）。
 *
 * 目录那个尾斜杠：设计 · 文件与图片「目录加 `/` 后向内浏览」——屏上那一处因此一眼看得出
 * 它是个目录（`@src/`），而身份仍只到 `src`（尾斜杠不是路径的一部分）。
 *
 * ## 图片为什么是编号，不是名字（U62 · 2026-09-25 定）
 *
 * 文件 / 目录那一处写的是**路径**——因为要靠它去读（模型按需自读）。图片**不需要路径**
 * （引用即进，随请求直接成部件），**也不假装有文件名**：图不一定来自文件（剪贴板来的
 * 就没有文件）。所以它写的是一个**一段输入内的编号**，指认得出来即可——
 * **它不是地址**，是给模型和你指认用的（见 `设计 · 文件与图片#图片的身份与名字`）。
 *
 * ⚠️ **编号由调用方给**（`n`），不是这里现算：同一份内容在同一段输入里必须给同一个编号，
 * 而「哪几份内容已经有编号了」是稿子那一侧的事（见 `shell.ts` 的 `imageNumberOf`）。
 * 这里只管**怎么把它写出来**——两处各写一遍就会有一处分叉。
 */
export function markerOf(
  part:
    | { readonly kind: 'skill' | 'file' | 'dir'; readonly name: string }
    | { readonly kind: 'image'; readonly n: number },
): string {
  if (part.kind === 'skill') return `/${part.name}`
  if (part.kind === 'image') return `Image#${part.n}`

  return part.kind === 'dir' ? `@${part.name}/` : `@${part.name}`
}

/**
 * 那一段文字是不是一个图片编号（`Image#N`）——是的话给出 `N`。
 *
 * 由头：编号是**稿子那一侧现编的**（内核不认识它），而稿子有几处会被整份换掉
 * （输入历史翻回来、提交失败把稿子还回来）。换回来那几处的名字已经写在正文里了
 * ——照着把它们认下来，接着新加一张图才**不会又编出同一个号**。
 *
 * 认不出来（用户自己打的字、旧记录里没有编号的那种）⇒ `undefined`：不编。
 */
export function imageIndexOf(marker: string): number | undefined {
  const matched = /^Image#([1-9][0-9]*)$/.exec(marker)

  return matched === null ? undefined : Number(matched[1])
}
