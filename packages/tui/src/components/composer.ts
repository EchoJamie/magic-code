/**
 * 输入行（缺陷轮 II 重画 · U20 补多行 · U31 接**真光标**）——左下交互区的**默认形态**。
 *
 * 面孔（原型 · 场景 1/3/4/14）：
 * - **常态**：`› ` 青 ＋ 占位或草稿；
 * - **工作中 / 退避中**：提示词转暗 ＋ 占位换成一句「现在打也发不出去」的实话；
 * ⚠️ **接管态（待裁决）不画这一行**（D29）：那一刻打不进字，整行收走（见 `components/app.ts`
 * 的 `dockOf`）——草稿与插入点照旧收在 `view.stashed` 里，答完原样归还（`view.ts` 的
 * `takeOver` / `undock`）。
 *
 * ## 光标（U31）
 *
 * **真终端的光标就是插入点的提示**——`useCursor()` ＋ `measureElement()`（都是 Ink 自带），
 * 不再画那个 `inverse` 空格（那是**第二个光标**：同一格既反显又顶着终端光标）。
 * 两件事分工写清楚，别混：
 *
 * - **在哪**——`composerLayout()` 算：草稿折成视觉行之后，插入点落在第几行第几列。
 *   折行**必须用 Ink 内那一支**（`wrap-ansi` 同参数）——实测反例：40 列 ·
 *   `z`×30 ＋ ` abcdefghij`，仓里那个按宽度硬切的 `wrap()` 把 `abcdefghij` 切成两半，
 *   而 Ink 是**词界**折行（整词落到下一行）⇒ 行号列号全错。自己按宽度取模算**站不住**。
 * - **画在哪**——`<Box ref>` 量到的**活动帧内**坐标（`measureElement`；⚠️ **不是**
 *   `useBoxMetrics`，那个给的是父节点的相对坐标）＋ 上面的行号列号。
 *
 * `setCursorPosition` **在渲染里调**（Ink 文档的用法）：它的传播走 `useInsertionEffect`，
 * 摆在被动 effect 里要等下一帧才生效。量的那一下在 effect 里（量要等布局算完），
 * 结果存进 state——**值没变就还回原对象**，否则「量 → setState → 再渲染」会自激。
 * 输入行不在屏上时（选择器接管）传 `undefined` ＝ 把真光标藏回去；**组件卸载**时 Ink 自己
 * 也会收（`useCursor` 的 `useInsertionEffect` 清理），故不画它的那些档不会留下光标。
 *
 * ## ⚠️ 量宽只有**一把尺**（返工轮 · 2026-09-20 首轮验收退回①）
 *
 * **折出来的行与插入点的列必须是同一把尺量的**——折行那一支（`wrap-ansi`）内部用
 * `string-width`，而且它**先把正文规范化成 NFC**（`e` ＋ 组合重音到屏上是一个 `é`）。
 * 早先落点按仓里那个**逐码点**的 `displayWidth`（`lines.ts`：组合符算 1 列、每个 emoji
 * 码点各算 1 列）量，于是两个后果：
 *
 * - `e` ＋ 重音：折行正文 2 个码点缩成 1 个 ⇒「插入点的偏移」比「那一行的宽度」还大 ⇒
 *   `caretRow` **找不到** ⇒ 真光标掉到状态行底下（用户报的那一条）；
 * - `👨👩👧👦`：按码点量成 7 列、按**字素**量成 2 列 ⇒ 列号偏出去。
 *
 * 故这里一律 `string-width`（**与 Ink 同源**：Ink 排版与 `wrap-ansi` 量宽都是它），
 * 插入点那一段**先按折行的同一条规则规范化再量**。**不叠字符特例**——「组合符算 0 列」
 * 那种补丁一处也补不全（emoji / 区域指示符 / 变体选择符各是一个坑），还会与折行那支再分家。
 *
 * ## 多行草稿（U20 · 差距 4）
 *
 * `shift+回车` 换行，草稿因此可以多行——**高度与折叠都按「视觉行」算**（U31 改，
 * 原先是按 `\n` 数的逻辑行：100 个 x 的草稿报 1 行、屏上其实占 2 行）。
 * 三条形态上的定夺：
 * - **续行缩进 2 列**（与 `› ` 同宽）：悬挂缩进那条规格的老姿势（正文从标记之后起）；
 * - **越上限就收起**（不是尾部）：**插入点那一行必须看得见**；收起来的**如实报行数**
 *   （`… 上面还有 N 行` / `… 下面还有 M 行`）——不装作画全了。**上限是整片输入区的**
 *   （正文 ＋ 那两行提示一起算，U31 二轮退回）——由头见下面「折叠」那一节；
 * - **一行一个 `<Text>`**（不在一段文本里写 `\n`）：Ink 的竖排 Box 本来就一个子节点一行，
 *   在 `Text` 里塞换行会让**行数账目**对不上（D11 的根因，见 `log.ts` 文件头注）。
 *   折行因此**在这里做**（折完每行都短于内容宽，Ink 不会再折）——渲染与算账同取一处。
 */

import { Box, Text, measureElement, useCursor } from 'ink'
import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import { PALETTE, expandTabs } from './lines.ts'

/** 输入行的面孔——由外壳按状态算好（显示层不判断）。 */
export type ComposerTone = 'idle' | 'working' | 'waiting' | 'retrying'

export type ComposerProps = {
  readonly draft: string
  /**
   * **插入点**（草稿里的下标，按 UTF-16 码元——与 `String.prototype.slice` 同一把尺）。
   * `null` ＝ 这一屏没有插入点（接管态）：不摆真光标，也不画落点。
   */
  readonly caret: number | null
  /**
   * 草稿里那几处**引用**的区间（U36）——**画的时候上另一种颜色**（见 `ComposerRow.spans`）。
   *
   * 缺省不给＝照旧画（标本 / 几何用例一字不动）：那时引用与普通文字同色。
   */
  readonly refs?: readonly { readonly start: number; readonly end: number }[] | undefined
  readonly tone: ComposerTone
  /**
   * 输入区最多占几行（**半屏**）——超了就收起并如实报行数。
   *
   * ⚠️ 量的是**整片输入区**：正文**与**「… 上面/下面还有 N 行」那两行提示一起算
   * （U31 二轮退回；早先提示是另加的，屏上比预算多出两行）。缺省不限
   * （只给「草稿 → 一屏里的几行」的用例与快照留的口子）。
   */
  readonly maxLines?: number
  /**
   * 一屏多少列——折行与列号都按它算（与 Ink 给这个盒子算的可用宽度同源：
   * 盒子 `paddingX: 1` ⇒ 内容宽 ＝ 列数 − 2）。**必给**：不给就算不出视觉行。
   */
  readonly columns: number
}

/** 占位文字（每个面孔一句实话）。 */
export function placeholderOf(tone: ComposerTone): string {
  switch (tone) {
    case 'idle':
      return '交代一件事，回车发送'
    case 'working':
      // 工具在跑——「想插话可以打」是原型场景 3 的原话
      return '（工作中——想插话可以打，发不出去就排队）'
    case 'waiting':
      // **等模型回来**（U20 · 差距 3「进度感」）——与「工具在跑」分开：那一刻屏上
      // 没有转圈的行，只有这句话说明「球在它那边」。措辞借原型场景 14 的原话「等模型回来」。
      return '（等模型回来——想插话可以打，发不出去就排队）'
    case 'retrying':
      return '（等模型回来——不用管，退避重试会自动重发）'
  }
}

// —— 几何：折行、插入点、折叠（渲染与算账**同取这一处**）——

/** 左留白（列）——盒子的 `paddingX`。列号与内容宽都要它。 */
const PAD = 1
/** 提示符——续行按它的宽度悬挂缩进。 */
const PROMPT = '› '
const INDENT = '  '
/** 内容可用宽度（列）——Ink 给这个盒子的文字算的宽度就是这个。 */
export function contentWidthOf(columns: number): number {
  return Math.max(1, columns - 2 * PAD)
}

/** 折行——**与 Ink 内同一支**（`wrapAnsi` 同参数）；一行一个视觉行。 */
function wrapVisual(text: string, width: number): readonly string[] {
  return wrapAnsi(text, width, { trim: false, hard: true }).split('\n')
}

/**
 * 一段文字占几列——**与折行那一支同一把尺**（`string-width`：`wrap-ansi` 内部量的就是它，
 * Ink 排版也用它）。按**字素**算：组合符跟它的字基算一个、ZWJ 串算一个 emoji。
 *
 * ⚠️ 别拿 `lines.ts` 的 `displayWidth`（那是**逐码点**的，记录区自己折行时用）：两者对
 * 组合字符 / emoji 给出的数不一样——输入行这里的行是 `wrap-ansi` 折的，量法必须跟它一致，
 * 否则「行有多宽」与「插入点在行里第几列」会是两本账（理由见文件头那一节）。
 */
function widthOf(text: string): number {
  return stringWidth(text)
}

/** 一段文字按 Ink 的尺子占几列——给**输入区之外**那些也归 Ink 排版的行量宽用（见 `clip`）。 */
export function inkWidth(text: string): number {
  return widthOf(text)
}

/**
 * 一段文字**按 Ink 的尺子裁成一行**——超宽加 `…`，行内的空白一并抹平。
 *
 * ⚠️ **两把尺子别混**（见文件头那一节）：这里量的必须与 Ink 排版那一支同源
 * （`string-width`），不然「裁到刚好」与「Ink 又折了一行」会各说各的——而交互区的
 * 高度账是**一行一条**数的（`app.ts` 的 `dockHeightOf`），多折一行就是账与屏分家
 * （U31 三轮那条「真光标高一行」走的正是这条缝）。记录区那一支是
 * `lines.ts` 的 `truncate`（**逐码点**的 `displayWidth`）——那是给记录区自己折行用的，
 * 别拿到这半边来。
 *
 * **换行与连续空白抹成一个空格**的理由同上：一行就是一行——候选的简述取自 YAML，
 * 可以是个多行块；留着换行，Ink 就照它多画几行。
 *
 * ⚠️ **只抹平、不裁两头**：首尾那个空格**可能是排版**（草稿材料那一行分成两段画，
 * 中间那个 ` · ` 的分隔就落在第二段的头上）。裁掉它，屏上就成了 `技能：pdf· 项目…`
 * ——两段贴在一起，读起来像另一个词。
 *
 * 按**字素**走（`GRAPHEMES`）：emoji 的 ZWJ 串是一个整体，逐码点累加会把它算胖。
 */
export function clip(text: string, width: number): string {
  if (width <= 0) return ''
  const flat = text.replace(/\s+/g, ' ')
  if (widthOf(flat) <= width) return flat

  let kept = ''
  let used = 0
  for (const piece of GRAPHEMES.segment(flat)) {
    const size = widthOf(piece.segment)
    if (used + size > width - 1) break
    kept += piece.segment
    used += size
  }

  return `${kept}…`
}

/** 画出来的**一行**：行首那一段（上色）＋ 正文（已折；续行没有行首那一段）。 */
export type ComposerRow = {
  /** 行首那一段（`› ` 或悬挂缩进的 `  `）——**上色**的那一段；续行是空串。 */
  readonly prefix: string
  /** 行首之后的正文。 */
  readonly text: string
  /** 这一行是不是「上面 / 下面还有 N 行」那种**如实报行数**的提示行。 */
  readonly notice: boolean
  /**
   * 这一行里属于**引用**的那几段（`text` 里的下标，UTF-16 码元）——画的时候上另一种颜色。
   *
   * 由头（U36）：引用那几个字与普通正文**长得一样**（都是用户那句话里的一段），
   * 而它们是**带着材料的**——屏上得看得出「这一段是有身份的」。不上色的话，
   * 用户没法一眼分辨「我选进来的 `@src/login.ts`」与「我手打的 `@src/login.ts`」。
   *
   * 折行会把一处引用**劈到两行**上，故区间是**逐行算**的（`refSpansOf`）；
   * 算不出来（对不上位置）就空着——**宁可不上色，也不上错位置**。
   */
  readonly spans?: readonly { readonly start: number; readonly end: number }[]
}

export type ComposerLayout = {
  readonly rows: readonly ComposerRow[]
  /** 插入点在第几行（`rows` 的下标；`null` ＝ 没有插入点，或它落在别处）。 */
  readonly caretRow: number | null
  /** 插入点在那一行的第几列（**显示宽度**，从行首内容起算——不含左留白）。 */
  readonly caretCol: number
}

/**
 * 草稿 → 一屏要画的那几行（**纯函数**：渲染、高度预算、用例都拿它）。
 *
 * 折行在这里做完，Ink 拿到的每一行都不超过内容宽——故**屏上的行数就是这里的行数**
 * （`draftHeight` 直接数它，两处不会各算一套）。
 */
export function composerLayout(
  draft: string,
  caret: number | null,
  columns: number,
  maxLines: number = Number.POSITIVE_INFINITY,
  /**
   * 草稿里那几处**引用**的区间（U36）——**只用来上色**（见 `ComposerRow.spans`）。
   *
   * 它**不参与**几何：折哪一行、插入点在第几列，与引用无关（引用只是正文里的一段字符）。
   * 参数放在最后、可以不给：不给＝照旧画（标本与纯几何用例一字不动）。
   */
  refs: readonly { readonly start: number; readonly end: number }[] = [],
): ComposerLayout {
  const width = contentWidthOf(columns)

  // —— 折：逻辑行 → 视觉行（顺带定出插入点落在哪一行哪一列）——
  const rows: ComposerRow[] = []
  let caretRow: number | null = null
  let caretCol = 0

  if (draft === '') {
    // 空草稿：占位那一行，插入点紧跟在 `› ` 之后（用户 2026-09-20 定的落点）
    rows.push({ prefix: PROMPT, text: '', notice: false })
    if (caret !== null) {
      caretRow = 0
      caretCol = widthOf(PROMPT)
    }
  } else {
    // 插入点在哪一条逻辑行、行内第几列
    const at = caret === null ? -1 : Math.max(0, Math.min(caret, draft.length))
    const before = at === -1 ? '' : draft.slice(0, at)
    const caretLine = before === '' ? 0 : before.split('\n').length - 1
    const caretInLine = caretLine === 0 ? before.length : before.length - (before.lastIndexOf('\n') + 1)

    let lineStart = 0

    draft.split('\n').forEach((line, index) => {
      const prefix = index === 0 ? PROMPT : INDENT
      const source = prefix + line
      const wrapped = wrapVisual(source, width)
      const spans = refSpansOf(source, wrapped, refs, lineStart, prefix.length)

      if (index === caretLine) {
        // 插入点落在第几行第几列——**与折行同一把尺**（`widthOf`）、**同一条口径**
        // （先规范化：折行进门就 `normalize()`，见文件头那一节）。量的是**屏上**那一行里
        // 插入点之前那一段占的列数；与折出来的各行宽度是同一本账，故下面那趟累加必能落到一行上。
        //
        // ⚠️ **Tab 也要按折行那一支的规矩展开**（2026-09-22 · Tab 多行重印那一轮）：
        // `wrap-ansi` 把 `\t` 展成「到下一张 8 列制表位」的空格，而 `string-width` 把 `\t`
        // 量成 **0 列**——直接量的话，插入点会落在**文本里面**（实测：`left⇥right` 尾巴上
        // 差 2 列；行首 Tab 那一档差 8 列）。
        // 尺子按**字素**喂（`expandTabs` 一次给一段）——`string-width` 认 ZWJ 串，
        // 逐码点拆开量会把 `👩‍💻` 算成 4 列（实际 2 列）
        const offset = widthOf(expandTabs((prefix + line.slice(0, caretInLine)).normalize(), 0, widthOf))
        let used = 0
        wrapped.forEach((row, at) => {
          const size = widthOf(row)
          // 落在这一行即定（`<=`：正好在行尾时**留在本行末尾**，跟手不跳下一行）
          if (caretRow === null && offset <= used + size) {
            caretRow = rows.length + at
            caretCol = offset - used
          }
          used += size
        })

        // 兜底（不该走到）：两把尺若哪天又分了家，插入点宁可落在**这一条逻辑行的最后一行行尾**，
        // 也不掉出输入区——`caretRow === null` 的后果是真光标跑到状态行底下，用户看着就是
        // 「光标没了」（首轮验收退回①报的正是这个症状）。落点成一格半格的偏差，比整个丢掉轻。
        if (caretRow === null && wrapped.length > 0) {
          caretRow = rows.length + wrapped.length - 1
          caretCol = widthOf(wrapped[wrapped.length - 1] ?? '')
        }
      }

      wrapped.forEach((row, at) => {
        // 首行那一段行首（`› `）不在 `row.text` 里，故它的区间要**减掉行首那几格**
        // （区间是 `text` 的下标——两处各按各的坐标，混了就会上错色）
        const onRow = spans[at]
        rows.push(
          at === 0
            ? {
                prefix,
                text: row.slice(prefix.length),
                notice: false,
                spans: onRow?.map((span) => ({
                  start: span.start - prefix.length,
                  end: span.end - prefix.length,
                })),
              }
            : { prefix: '', text: row, notice: false, spans: onRow },
        )
      })

      // 下一条逻辑行的起点（引用区间是**草稿坐标**，逐行换算、见 `refSpansOf`）
      lineStart += line.length + 1
    })
  }

  // —— 折叠：插入点必须看得见（它在哪，窗口就跟着移到哪）——
  //
  // ⚠️ **正文与两行提示共用这一份预算**（U31 二轮验收退回）——`maxLines` 是**整个输入区**
  // 的行数上限，不是「正文的上限、提示另算」。早先先取满预算的正文、再把「… 上面/下面还有
  // N 行」两条接在两头，输入区就比账上多出两行；**账**（`app.ts` 的 `dock`）按 `maxLines`
  // 算、**屏**多两行 ⇒ 矮窗上动态帧正好顶到终端高度 ⇒ **Ink 省掉末尾那个换行**
  // （`outputHeight >= viewportRows` 时它只写正文，见 `ink.js` 的 `renderInteractiveFrame`），
  // 而它的光标后缀仍按「正文之下还有一行」回退 ⇒ **真光标高一行**（40×10 · 插入点 200
  // 实测 (13,6)、应为 (13,7)；160/280 那两档交互区 6 行、够不着终端高度，故看着是好的）。
  // 根因是**账与屏分家**，不是「少减了一行」——故修法是让提示行占它自己那一格，
  // **不**在别处加一行补偿、也不给窄终端开特例分支。
  const total = rows.length
  const budget = Math.max(1, Math.floor(maxLines))
  let start = 0
  let count = total
  /** 两头那两条提示画不画——极小预算的兜底那一档要让位（见下）。 */
  let notices = true

  if (total > budget) {
    // 窗口**从宽到窄**试：第一个「正文 ＋ 它实际要画的提示行 ≤ 预算」的就是要的那一扇。
    // ⚠️ 提示行只在**真折了**的那一头才画——窗口贴住某一头时那一头不占格子
    //    （故现算，不一律按「两头各留一行」扣：那样会白扔一格正文）。
    count = 0
    for (let size = Math.min(total, budget); size >= 1; size -= 1) {
      const from = Math.min(Math.max((caretRow ?? total - 1) - size + 1, 0), total - size)
      const used = size + (from > 0 ? 1 : 0) + (from + size < total ? 1 : 0)

      if (used <= budget) {
        start = from
        count = size
        break
      }
    }

    // 兜底（护栏——`maxDraftLines` 给的是半屏，实际到不了这一档）：预算窄到
    // 「一行正文 ＋ 两条提示」都放不下时，**插入点那一行优先**（真光标要摆在那儿，
    // 它不在窗口里就没地方放），两头提示如实让位——宁可少报，也不把帧撑过账。
    if (count === 0) {
      start = Math.min(Math.max(caretRow ?? total - 1, 0), total - 1)
      count = 1
      notices = false
    }
  }

  const shown = rows.slice(start, start + count)
  const foldedAbove = start
  const foldedBelow = total - (start + count)

  return {
    rows: [
      ...(notices && foldedAbove > 0
        ? [{ prefix: '', text: `… 上面还有 ${foldedAbove} 行`, notice: true }]
        : []),
      ...shown,
      ...(notices && foldedBelow > 0
        ? [{ prefix: '', text: `… 下面还有 ${foldedBelow} 行`, notice: true }]
        : []),
    ],
    // 上头那条提示占一行——插入点的行号跟着下移
    caretRow: caretRow === null ? null : caretRow - start + (notices && foldedAbove > 0 ? 1 : 0),
    caretCol,
  }
}

/** 草稿要占几行（含「折掉了几行」那两行）——布局预算与渲染同取这一处。 */
export function draftHeight(
  draft: string,
  caret: number | null,
  columns: number,
  maxLines: number = Number.POSITIVE_INFINITY,
): number {
  // 高度与引用无关（引用只是正文里的一段字符，不占额外的行）——故不传那一位
  return composerLayout(draft, caret, columns, maxLines).rows.length
}

/**
 * **一处引用折到几行上**——把草稿坐标的区间切给这一条逻辑行折出来的每一个视觉行。
 *
 * 三件要制服：
 * - **折行会把引用劈成两半**（`@src/very/long/path.ts` 落在行尾），故区间是**逐行算**的；
 * - **折出来的行与原文是同一串字符**（`wrapAnsi` 那条约束），故用**顺序查找**把每一行
 *   对回它在原文里的起点——`trim: false` 之下行首行尾的空白都留着，查找是确定的；
 * - **归一化**（NFC）：`wrapAnsi` 进门就把正文规范化（`e` ＋ 组合重音合成一个 `é`），
 *   长度会变。故区间与原文**都按同一个规范化**换算（`normalize()` 只在字素边界上分段做
 *   ——引用起止都落在字素边界上，故分段归一化与整体归一化在这里等价）。
 *
 * **对不上就不上色**（返回空）：宁可引用看起来与普通文字一样，也不能把颜色刷到别的字上。
 */
function refSpansOf(
  source: string,
  wrapped: readonly string[],
  refs: readonly { readonly start: number; readonly end: number }[],
  lineStart: number,
  headLength: number,
): readonly (readonly { readonly start: number; readonly end: number }[] | undefined)[] {
  const none = (): readonly undefined[] => wrapped.map(() => undefined)
  if (refs.length === 0) return none()

  // 折行那一支（`wrapAnsi`）进门就把正文规范化成 NFC，故行的下标都在**规范化之后**那一串上
  const body = source.normalize()
  /** 原文坐标 → 规范化坐标——**按边界分段归一**（引用起止都在字素边界上，故与整体归一等价）。 */
  const normalizedAt = (at: number): number => source.slice(0, at).normalize().length

  const spans: { readonly start: number; readonly end: number }[] = []
  for (const ref of refs) {
    // 草稿坐标 → 这一条逻辑行的原文坐标（减本行起点、加行首那一段）
    const start = headLength + ref.start - lineStart
    const end = headLength + ref.end - lineStart
    if (end <= headLength || start >= source.length) continue // 这一处在别的逻辑行上

    const from = normalizedAt(Math.max(headLength, Math.min(start, source.length)))
    const to = normalizedAt(Math.max(headLength, Math.min(end, source.length)))
    if (to > from) spans.push({ start: from, end: to })
  }

  if (spans.length === 0) return none()

  const rows: (readonly { readonly start: number; readonly end: number }[] | undefined)[] = []
  let cursor = 0

  for (const row of wrapped) {
    const at = body.indexOf(row, cursor)
    if (at < 0) return none() // 对不上（理论不可达）——**宁可不上色**

    const hits = spans
      .map((span) => ({
        start: Math.max(span.start, at) - at,
        end: Math.min(span.end, at + row.length) - at,
      }))
      .filter((span) => span.end > span.start && span.start >= 0 && span.end <= row.length)

    rows.push(hits.length === 0 ? undefined : hits)
    cursor = at + row.length
  }

  return rows
}

// —— 插入点的挪动：按**字素**走，中文 / emoji 不切坏 ——

/**
 * 字素分段器（`Intl.Segmenter`）——**按字素**而不是按码元挪插入点。
 *
 * 由头：`'👍🏽'.length === 4`、`'é'.length === 2`——按码元退一格会**把一个字切成两半**
 * （屏上出现半个字符或一个孤立代理项）。退格 / 左右移动都走这两件。
 */
const GRAPHEMES = new Intl.Segmenter('zh', { granularity: 'grapheme' })

/** 往左退一个**字素**（到头就停在 0）。 */
export function stepLeft(text: string, at: number): number {
  const stop = Math.max(0, Math.min(at, text.length))
  let previous = 0

  for (const piece of GRAPHEMES.segment(text.slice(0, stop))) {
    const end = piece.index + piece.segment.length
    // 这一格跨过（或正好落在）插入点 ⇒ 停在**它的起点**（＝上一个字素的边界）
    if (end >= stop) break
    previous = end
  }

  return previous
}

/** 往右进一个**字素**（到头就停在末尾）。 */
export function stepRight(text: string, at: number): number {
  const from = Math.max(0, Math.min(at, text.length))
  // 只看第一段：`slice(from)` 的头一段就是「插入点右边那一个字素」；
  // 到头（`from === 末尾`）时切片为空、一段都没有 ⇒ 原地不动
  for (const piece of GRAPHEMES.segment(text.slice(from))) return from + piece.segment.length

  return from
}

/**
 * 插入点**左边**那一个字素占哪一段——给退格用。
 * 返回 `[起点, 插入点)`；到头就是空段（那一下什么都不删）。
 */
export function leftSpan(text: string, at: number): readonly [number, number] {
  return [stepLeft(text, at), Math.max(0, Math.min(at, text.length))]
}

/** 插入点右边那一个字素占哪一段——给 `delete` 用。返回 `[插入点, 终点)`。 */
export function rightSpan(text: string, at: number): readonly [number, number] {
  const from = Math.max(0, Math.min(at, text.length))
  return [from, stepRight(text, from)]
}

// —— 画 ——

/**
 * 一行正文 → 要画的几段（引用上色，其余原色）。
 *
 * 形态上**不动一行一行那个账**：出来的还是同一个 `<Text>`，只是里面分段——行数不变
 * （高度账那一处数的仍是 `rows.length`）。
 *
 * 引用那一色取 `PALETTE.user`（青，与用户标记同族）：**这几个字是「你选进来的」**，
 * 与 `›` 那个标记说的是同一件事的两半。
 */
function refPieces(
  text: string,
  spans: readonly { readonly start: number; readonly end: number }[] | undefined,
): readonly (string | ReactElement)[] | string {
  if (spans === undefined || spans.length === 0) return text

  const pieces: (string | ReactElement)[] = []
  let cursor = 0

  spans.forEach((span, index) => {
    // 引用之外那几段**不另给色**——外层 `<Text>` 给什么就什么（两处各写一遍迟早分家）
    if (span.start > cursor) pieces.push(text.slice(cursor, span.start))
    pieces.push(h(Text, { key: `r:${index}`, color: PALETTE.user }, text.slice(span.start, span.end)))
    cursor = span.end
  })

  if (cursor < text.length) pieces.push(text.slice(cursor))

  return pieces
}

/** 量到的锚——活动帧内的坐标（`measureElement` 那一支），与尺寸一起存。 */
type Anchor = {
  readonly x: number
  readonly y: number
}

export function Composer({
  draft,
  caret,
  refs = [],
  tone,
  maxLines = Number.POSITIVE_INFINITY,
  columns,
}: ComposerProps): ReactElement {
  const promptColor = tone === 'idle' ? PALETTE.user : PALETTE.dim
  const box = useRef(null)
  const { setCursorPosition } = useCursor()
  const [anchor, setAnchor] = useState<Anchor | null>(null)

  // 量：**活动帧内**的坐标（`measureElement`——祖先偏移一路累加）。值没变就还回原对象：
  // 「量 → setState → 再渲染 → 再量」这条链靠它收敛（不然每次提交都白排一次渲染）。
  useEffect(() => {
    const found = measureElement(box.current as never)

    setAnchor((previous) =>
      previous !== null && previous.x === found.x && previous.y === found.y
        ? previous
        : { x: found.x, y: found.y },
    )
  })

  const layout = composerLayout(draft, caret, columns, maxLines, refs)

  // 摆真光标——**在渲染里调**（理由见文件头注）。没有插入点（接管态）就藏回去。
  const spot =
    caret === null || layout.caretRow === null || anchor === null
      ? undefined
      : { x: anchor.x + PAD + layout.caretCol, y: anchor.y + layout.caretRow }
  setCursorPosition(spot)

  return h(
    Box,
    { ref: box, paddingX: PAD, flexDirection: 'column' },
    ...layout.rows.map((row, at) =>
      row.notice
        ? h(Text, { key: `n:${at}`, color: PALETTE.faint }, row.text)
        : h(
            Text,
            { key: `d:${at}` },
            row.prefix === ''
              ? null
              : h(Text, { color: promptColor }, row.prefix),
            // ⚠️ 空行得给一个「有东西」的孩子——Ink 会把内容为空串的 `<Text>` 整行丢掉，
            //    行数就少一行（D19 同款；见 `log.ts` 里那处同样的处理）。空草稿那一行的
            //    正文位置留给占位（占位不是草稿的一部分，故不在这里拼）。
            h(
              Text,
              { color: row.notice ? PALETTE.faint : PALETTE.fg },
              row.text === ''
                ? draft === '' && at === 0
                  ? placeholderOf(tone)
                  : ' '
                : refPieces(row.text, row.spans),
            ),
          ),
    ),
  )
}
