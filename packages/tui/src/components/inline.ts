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
 * 三个 kind 与契约的 `InputRef` 一一对应；`marker` 与 `draft.slice(start, end)` 恒等
 * （区间是那段文字的账，两处不许各说各的——`markerOf` 一处产出，改也是它一处改）。
 */
export type DraftRef = {
  readonly start: number
  readonly end: number
  readonly kind: 'skill' | 'file' | 'dir'
  /** 正文里那一段（`@src/login.ts` / `/review`）——**与区间同物**。 */
  readonly marker: string
  /** 身份：技能＝技能目录真路径，文件 / 目录＝真路径。 */
  readonly source: string
  /** 技能名（`kind: 'skill'` 才有；提交时随引用一起走，报错时指得出是谁）。 */
  readonly name?: string
  /** 取自工作区之外的只读附件（`kind: 'file'` 才有）。 */
  readonly external?: true
}

/** 一处的身份那几格（`marker` 之外的）——造引用时给这个，位置由插入点算。 */
export type RefIdentity = Omit<DraftRef, 'start' | 'end' | 'marker'>

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
    return {
      kind: 'skill',
      at: ref.start,
      marker: ref.marker,
      name: ref.name ?? ref.marker.replace(/^\//, ''),
      source: ref.source,
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
 * **引用文字该怎么写**（一处产出）——文件 / 目录带 `@`，目录带尾斜杠，技能带 `/`。
 *
 * 目录那个尾斜杠：设计 · 文件与图片「目录加 `/` 后向内浏览」——屏上那一处因此一眼看得出
 * 它是个目录（`@src/`），而身份仍只到 `src`（尾斜杠不是路径的一部分）。
 */
export function markerOf(part: {
  readonly kind: 'skill' | 'file' | 'dir'
  readonly name: string
}): string {
  if (part.kind === 'skill') return `/${part.name}`

  return part.kind === 'dir' ? `@${part.name}/` : `@${part.name}`
}
