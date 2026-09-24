/**
 * 外壳 · 一屏（缺陷轮 III）——**内联渲染**下的三带结构。
 *
 * 渲染模型（原型开篇那条注）：**内联（经典）· 不接管整屏 · 不捕获鼠标**。
 * 于是滚轮滚**终端自己的** scrollback ✓ · 原生拖选复制 ✓ ——两个都免费。
 * 代价三条（用户已认下）：输入框**不钉底**（跟内容走）· resize **不重排已滚出的历史** ·
 * 退出后内容**留在终端**。
 *
 * 版面对应的三段：
 * - **已定局的行**（上一轮及更早）→ `<Static>`：**写一次就不再重绘**——它们落进终端
 *   scrollback，滚动与复制都归终端 ✓。⚠️ **这也是 D11 的结构性护栏**：写出去的永不重擦。
 * - **本轮的行**（在流式、还会变）→ 活动区：就地重绘（高度按内容，**不填满窗口**）。
 * - **分隔线 ＋ 交互区 ＋ 分隔线 ＋ 状态行** → 活动区尾部（U45 起是**两条**线：上面那条分开
 *   记录区与交互区，下面那条分开交互区与状态行。**U59 把下面那条挪到这儿**——U45 原先加在
 *   状态行**之下**，那是把「输入行 ＋ 状态行」框起来，不是划界，见 `separatorOf`）。
 *
 * ⚠️ **要防的那个 bug**（原型 · 交互逻辑）：内联下重绘擦不干净＝同一段重复堆进 scrollback。
 * 两条护栏：① 已定局的行走 `Static`（不重绘）；② **一行一个 `<Text>`、行内不写换行**
 * （早先多写的那一个换行正是 D11 的根因——Ink 以为的帧高只有实际的一半）。
 *
 * 两层分得清：`AppView` 是**纯**的（给视图与尺寸就画一屏——快照直接取景）；
 * `TuiApp` 是**活**的（订阅外壳、把 Ink 的键喂进外壳、按 `ShellEffect` 退场）。
 */

import { Box, Static, Text, useApp, useInput, usePaste, useStdout, useWindowSize } from 'ink'
import { createElement as h } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { useSyncExternalStore } from 'react'
import { bannerOf } from '../banner.ts'
import { planBudgetOf, planBlockOf, planScrolled } from '../plan.ts'
import type { PlanBlock } from '../plan.ts'
import type { Shell, ShellKey } from '../shell.ts'
import type { CompletionState, LogRow, ShellView } from '../view.ts'
import { HINT_EXIT_ARMED, hasRunningTool } from '../view.ts'
import { Composer, clip, draftHeight, inkWidth, type ComposerTone } from './composer.ts'
import { DecisionCard } from './decision.ts'
import { LogRowView, needsSpacer, needsSpacerAfter, rowLines } from './log.ts'
import { PALETTE, wrap } from './lines.ts'
import { PickerList, pickerBudget, pickerLayout } from './picker.ts'
import { PlanList } from './plan.ts'
import { PromptLine } from './prompt.ts'
import { StatusLine } from './status.ts'

/**
 * `Static` 的**定型**视图——⚠️ 一次断言，理由同包装配的铸造器那处：
 * React 的泛型组件经 `createElement` 用时**推不出** `T`（推成 `unknown`），
 * 而这里 `items` 与 `children` 的对应关系是**代码里写死的**（都是 `LogRow`）。
 */
const StaticList = Static as unknown as (props: {
  readonly key?: string
  readonly items: readonly LogRow[]
  readonly children: (item: LogRow, index: number) => ReactElement
}) => ReactElement

// —— 纯呈现 ——

export type AppViewProps = {
  readonly view: ShellView
  readonly columns: number
  readonly rows: number
  /**
   * **此刻**（毫秒）——跑动中的工具行拿它报「跑到第几秒了」（`⟳ 0.6s`）。
   *
   * 钟归**活壳**（`TuiApp` 按需滴答）；这里是纯的：不给就 `null` ⇒ 屏上回退成
   * 「运行中」——**不编一个秒数**（取景与快照因此是确定的）。
   */
  readonly now?: number | null
}

export function AppView({ view, columns, rows, now = null }: AppViewProps) {
  // 活动区的预算：减去交互区与状态行，**再留一格**（**不填满窗口**——内联模式下内容跟内容走）。
  //
  // ⚠️ 这里的 `dock` 是**账**，`dockOf` 画出来的是**屏**——两者必须相等（U31 二轮退回）：
  //    账按 `maxDraftLines`（半屏）封顶、而输入行多画了两行提示时，屏上的动态帧正好顶到
  //    终端高度 ⇒ Ink 省掉末尾换行 ⇒ 真光标高一行。故「上面/下面还有 N 行」那两行
  //    **也算在 `maxDraftLines` 里**（`composerLayout` 那一处收口），这里不必再补。
  //
  // ⚠️ **留的那一格不是余量，是 Ink 末尾那个换行要落的一行**（U31 三轮退回把账补齐）：
  //    动态帧 ＝ 活动区 ＋ `CHROME_LINES`（分隔线 ＋ 状态行）＋ 交互区；
  //    「帧高 ≥ 视口行数」时 Ink 走**整屏那一支**——只写正文、**不写末尾那个换行**
  //    （`ink.js` 的 `renderInteractiveFrame`：`isFullscreen ? output : output + '\n'`），
  //    而它摆光标的后缀仍按「正文之下还有一行」回退
  //    （`cursor-helpers.js` 的 `buildCursorSuffix`：`moveUp = visibleLineCount - cursor.y`）
  //    ⇒ **真光标高一行**。故账要写**短于这一屏**——`rows - 1` 才是动态帧能占的上限。
  //    早先 `max(1, rows - dock - 2)` 在活动区吃满时正好等于 `rows`：注释写着「不填满窗口」，
  //    算式却正好填满（40×10 · 草稿 300 个 a · 3 行流式 ⇒ 帧 10 行、真光标 (13,6) 而非 (13,7)）。
  // ⚠️ **交互区的高度就是它画出来的那些行**——不许再按「最多半屏」封顶（U31 三轮退回）：
  //    那个封顶只封**账**、不封**屏**（草稿那一片本来就由 `maxDraftLines` 封在半屏，
  //    而裁决卡 / 选择器 / 补全候选是各自算的行数，封顶够不着它们）——于是「账 4 行、
  //    屏 5 行」这号分家又回来了：矮窗上活动区多算了一行 ⇒ 帧正好顶满 ⇒ 真光标高一行
  //    （40×8 的接管屏就是那一格）。账与屏**同取 `dockHeightOf` 一处**，剩下的格子归活动区。
  // 空态那一行**已删**（用户 2026-09-20 定：那句「会话在你按下第一次回车时才建立」没有动作价值，
  // 原型早已删掉）——账里也就不再有这一项：帧的几段只剩活动区、`CHROME_LINES`、交互区。
  //
  // **U34 起，这一段余量还要再分一次**（活动区 ↔ 步骤清单）：先保证交互区，再给当前
  // 回复留够（`PLAN_KEEP_LINES`），剩下的才是清单的——分法与折行都在 `planBlockOf` 一处
  // （`liveLayoutOf` 就干这一件），故「账 4 行、屏 5 行」那号事不会在清单这儿重演。
  const { plan, rest } = liveLayoutOf(view, columns, rows)
  const liveBudget = Math.max(0, rest - plan.height)
  const live = liveAreaOf(view, columns, liveBudget)

  // **字标在放不下的宽度上要「一行都不占」**（设计 · 极窄：「不印，优先保证正文与输入空间」）。
  //
  // ⚠️ 光让它渲染出 0 行**还不够**——`<Static>` 里的**条目数**本身会进 Ink 的版面账：
  // 实测（9 列 · 内容高过视口）留着那条空字标，Ink 就多走一次**整屏清**
  // （`\e[2J\e[3J`，连 scrollback 一起擦）；把它从 `items` 里摘掉，两串字节逐字节相同。
  // 空盒子不是「无害的零」，它是一行账——这一条是量出来的，别凭直觉把它删了。
  //
  // ⚠️ **照常时原样交 `view.settled`**（不新建数组）——U21 那条纪律：`Static` 拿 `items`
  // 做 `useMemo` 的依赖，每帧递一个新数组会让它每帧白算一遍（见下面 `items:` 那一段注）。
  // 新建数组只发生在**极窄**那一档（`bannerOf` 给 0 行），那时屏上本来也没几行。
  const items =
    bannerOf(columns).length > 0 ? view.settled : view.settled.filter((row) => row.kind !== 'banner')

  return h(
    Box,
    { flexDirection: 'column' },
    // **已定局的行走 Static**——写一次即入 scrollback，此后不重绘（D11 的结构性护栏）。
    //
    // `key` 按**页**——记录区整块换掉的那一下（换会话开了新页）才重挂，那一批行才会被写出来
    // （Static 只追加新项：`items` 一变短，它的游标就落在数组外，一行都不印）。
    // ⚠️ **重挂的那一下不重印字标**（U43）：页号一动，写出来的是**这一页里的行**——
    // 换会话开的新页里**没有字标**（见 `ShellView.page` 与 `reduceSessionState`）。
    //
    // ⚠️ **别拿会话 id 当页号**（原写法，缺陷 D25）：会话 id 与「记录区换了一页」是两回事——
    // `/grants` 这类读侧命令会先在装配那边开一张**空壳**会话（信封必带会话），
    // 于是「打开抽屉」就撞上一次 id 到位（`null` → 真 id）：`<Static>` 当场重挂，
    // 已经印进 scrollback 的字标**又印一遍**；那一帧还走 Ink 的「有静态输出」那条路
    // （`log.clear()` ＋ 重写静态输出），擦头正落在上一帧的顶行 ⇒ 记录区少一行。
    // 页的身份见 `pageOf`。
    h(StaticList, {
      key: `static:${pageOf(view)}`,
      // ⚠️ **照常就是 `view.settled` 原样，不 `[...]` 复制**（U21 · 历史区静态化）：
      // Ink 的 `Static` 拿 `[items, index]` 做 `useMemo` 的依赖——每帧递一个新数组，
      // 那个 memo 每帧都白算一遍（`items.slice(index)`）。`settled` 只在**真的加了行**
      // 时才换对象（`settle` / `appendSettled` 都是这么写的），故这一交就是稳定的。
      // 实测这笔账很小（5000 行 0.019ms · `bench-cost.ts`）——**如实记：它不是瓶颈**，
      // 改它是顺手把这条纪律立住，不是优化的大头。
      // （`items` 只在**极窄那一档**才是另建的数组——见上面那一段注。）
      items,
      // `children` 是**函数入参**（Static 的形态如此，不是 JSX 子节点）——故写在 props 里
      children: (row: LogRow, index: number) =>
        h(LogRowView, {
          key: row.key,
          row,
          columns,
          expanded: view.expanded,
          // ⚠️ 问的是 **`items`**（真印出来的那一列），不是 `view.settled`：极窄那一档
          // 字标被摘掉之后，两者差着一位——拿 `settled` 索引会让每条的「上一条」都错位一格
          // （用户消息该有的分段时有时无）。`items === view.settled` 时不差分毫。
          spaced: needsSpacer(items, index),
        }),
    }),
    // ⚠️ **空态那一块已删**（用户 2026-09-20 定：启动屏上「会话在你按下第一次回车时才建立」
    //    这句没有动作价值，原型早已删掉）。删掉之后这一屏就只是：记录区（`Static`）→ 活动区
    //    → 分隔线 → 交互区 → 分隔线 → 状态行——开机屏上不再有那句话，也没有为它单算的高度项
    //    （见上面 `liveBudget` 那一段注）。
    // 本轮的行（还在变）——就地重绘
    //
    // ⚠️ **画哪几条、留不留分段、切哪几行，全由 `liveAreaOf` 一处给**（`live`）——账与屏
    //    同取一处才谈得上「不差分毫」。早先这两件事分在两处：算账那支用 `needsSpacer(rows, i)`
    //    （下标 0 恒为「不留」），渲染那支用 `needsSpacerAfter(settled.at(-1), row)`
    //    （上一条是用户消息就留）——**同一条交界行，两处各判各的**。
    ...live.map((entry) =>
      h(LogRowView, {
        key: entry.row.key,
        row: entry.row,
        columns,
        expanded: view.expanded,
        // 交界那一条的「上一条」在 `settled` 里——同一条规矩（`needsSpacerAfter`），
        // 免得「用户消息之前留一行」在交界处换一副面孔（字标自带的后留白也在这条规矩里）
        spaced: entry.spaced,
        // 头一条自己就超预算时它要跳过的那几行（记录里一行不少，屏上只画放得下的）
        skip: entry.skip,
        now,
      }),
    ),
    // **步骤清单**（U34）——**动态区末尾、输入区上方**（设计）；默认展开、就地刷新。
    // ⚠️ 它在**分隔线之上**：那一块仍属「这一屏正在发生什么」，而分隔线划的是记录区与
    // 交互区之间的界（输入框那一侧才是交互区）。没有清单时一行都不占（`height === 0`）。
    //
    // ⚠️ **`now` 只在呼吸为真时才交出去**（返修⑤）：钟是**共享**的（工具在跑它也走），
    // 无条件递给清单的话，该静止的时候那格方块照样会跟着暗一档亮一档。
    ...(plan.height === 0
      ? []
      : [h(PlanList, { key: 'plan', block: plan, now: breathingOf(view, plan) ? now : null })]),
    // **上面这一条**——记录区与交互区之间的界。
    separatorOf(columns),
    h(Box, { flexDirection: 'column' }, ...dockOf(view, columns, rows)),
    // **下面这一条**（U45 加 · **U59 挪**）——**输入区与状态行之间**的界。状态行之下**不再有线**。
    //
    // ⚠️ **U45 把它加错了位置**：加在状态行**之下**，成了「把输入行 ＋ 状态行框起来」——
    // 那是**装帧**，不是划界（用户原话是「输入区 **与** 底部状态栏」：划开的是**这两块**）。
    // 故它现在在输入区下沿、状态行**之上**：上面那条分开记录区与交互区，这一条分开
    // 交互区与状态行——**每条线都答得出它划开了哪两块**。
    //
    // **两条同形制**（同宽、同色、同一条 `separatorOf`）——一屏**恰好两条**，别再加第三条
    //（线是划界用的，不是装帧）。高度的账**一分没动**：还是两条线 ＋ 状态行（见 `CHROME_LINES`），
    // 换的只是这两行谁在上谁在下。
    separatorOf(columns),
    h(StatusLine, { status: view.status, columns }),
  )
}

/**
 * **一条满宽分隔线**——`AppView` 里一共两条（记录区／交互区之间那条，与**输入区／状态行
 * 之间**那条——后者 U45 加、**U59 挪正位置**），**同一形制**：整宽 ＋ `PALETTE.ghost`，
 * 不加第三种颜色或粗细。
 *
 * 收在一处是为了「两条长得一样」这件事**只有一处可改**——各写一行的话，改了一条忘了另一条
 * 就是两条线看着不像一套（而它们本来就是一条界的两头）。
 *
 * ⚠️ 宽度取 `max(1, columns)`——极窄档也照整宽画（既有那一手，不新造分支）：
 * 那是**划界**，窄屏上更需要它。
 */
function separatorOf(columns: number): ReactElement {
  return h(Text, { color: PALETTE.ghost }, '─'.repeat(Math.max(1, columns)))
}

/**
 * 一页的编号（U29）——`<Static>` 只在**记录区真的换了一页**时重挂（见 `key:` 那一段注）。
 *
 * 页的身份＝`view.page`（U43 改）——**一个随「开页」递增的数**，由归约那一侧给
 * （见 `ShellView.page`：`createView` 给 0，换会话 ＋1）。
 *
 * ⚠️ **原先认的是记录区开头那一行（字标）的对象身份**——那时的由头是「整块换掉 `settled`
 * 的地方都会种一个新字标对象，故开头那一行换对象＝换页」。那套写法把**「换会话」与
 * 「又启动一次」绑成了一件事**：换会话必须种新字标，字标就跟着重印（缺陷 D28 乙，
 * 甲→乙一次切换印 4 份）。摘下来之后就只剩它真正要说的那一句：**页号变了 ⇒ 重挂**。
 *
 * 与「页里有什么」无关：`rebuild` 往已经开着的那一页里填历史，页号不动 ⇒ `Static` 不重挂、
 * 只写新增的那些行；换会话页号 ＋1 ⇒ 重挂、那一批行整批写一遍。
 *
 * 号直接取自视图（不再在渲染里领）——**同一份视图画出来还是同一个 key**，
 * 故取景 / 快照仍是确定的（`AppView` 那条「给视图与尺寸就画一屏」照旧成立）。
 */
function pageOf(view: ShellView): string {
  return String(view.page)
}

/**
 * **翻页**（U44）——换会话（`/clear` 开一条新的 · `/resume` 回到某一条）把**可见屏清掉**，
 * 目标会话的记录从空白页起铺。设计 · 终端呈现「终端呈现 · 翻页」。
 *
 * ## 这一串字节在做什么（三条都要，少一条就不成）
 *
 * `换行 × 屏高` ＋ `光标归位`。逐条说：
 *
 * ① **换行把**屏上还看得见的那几行**推出去**——推进终端**自己的 scrollback**。
 *    切走那条往上翻仍看得到（硬约束：只清可见屏、绝不清 scrollback）。
 *    ⚠️ **不能拿 `CSI 2 J` 代替**：那一下擦的是**显示区**，而此刻显示区里还有
 *    切走那条的**尾几行**——它们没进过 scrollback，擦了就是真丢（试跑实测：
 *    40×10 的一屏 `2J` 之后，缓冲里那 7 行记录只剩 1 行）。`CSI 3 J` 更不行
 *    （连 scrollback 一起擦，Ink 的 `clearTerminal` 就是它）。
 * ② **条数取「屏高」**：从光标那一行往下写，前 `屏高 − 光标行` 个换行只是把光标挪到底，
 *    之后每一个**滚一格** ⇒ 一共滚 `光标行 + 1` 格，正好是「屏上内容到光标为止」那些行。
 *    **不多滚**：多滚的格子会把空行也推进 scrollback（屏没填满时尤其看得出来）。
 *    也不必先把光标挪到底——那样反而会多滚。
 * ③ **归位（`CSI H`）是**「空白页**从顶上**起铺」那一半：不归位的话，新一页会从**屏底**
 *    往下长，等于没清干净。
 *
 * ⚠️ **这不是 D27 那条「不以清历史掩盖残影」禁止的事**（设计明文）：那条禁的是**拿清屏去
 * 掩盖渲染 bug**；翻页是**故意的**产品动作，不是掩盖。别把两者混成一条。
 * ⚠️ **一屏都不重画**：仍是主缓冲与终端原生 scrollback，不接管整屏、不捕获鼠标、不承诺钉底。
 *
 * ## 为什么经 `useStdout().write` 交给 Ink 写，而不是自己往 stdout 灌
 *
 * Ink 对「它写出去的那一帧」有一本账（`LogUpdate` 的 `previousLineCount` / `previousOutput`）。
 * 绕开它直接写字节，屏上就与它记的不是一回事了——**最坏的一种**是：清完之后紧接着那一帧
 * 与上一帧**逐字符相同**，于是它认为「什么都没变」，一个字节都不写 ⇒ 屏上剩下**一张空屏、
 * 连输入行都没有**（不是想出来的：`renderInteractiveFrame` 那一支的判据就是
 * `output !== this.lastOutput`）。
 *
 * `writeToStdout` 是 Ink 给「在帧之上写点东西」的那道门（`useStdout().write` 就是它）：
 * 它先**擦掉自己那一帧**、再写这一串、再**把那一帧按原位重画**（`restoreLastOutput`），
 * 账与屏始终是一回事。故这一串之后屏上是：**空白页 ＋ 紧跟着一帧**（分隔线 / 输入行 /
 * 状态行照旧在），随后新一页的记录一行行铺出来。
 *
 * ## 时机
 *
 * 由 `TuiApp` **订在外壳上**、页号一变就写（见那一处）：外壳 `commit` 里落的视图是**同步**的，
 * 而 React 那一趟重绘在**微任务**里——故这一串必定**写在新一页的头一行之前**。
 * 晚一步（比如放进 `useEffect` 等重绘之后）就是另一种结果：新一页的头几行先写出去，
 * 再被这一串一并推进 scrollback，屏上剩下空页。
 */
export function flipBytes(rows: number): string {
  return '\n'.repeat(Math.max(1, Math.floor(rows))) + '\u001b[H'  // CSI H ＝ 光标归位
}

/**
 * 动态帧里**除活动区之外**的固定行数——**两条分隔线 ＋ 状态行**（各一行，U45 起是三条）。
 *
 * 它是活动区预算那个减法里的一项：动态帧 ＝ 活动区 ＋ `CHROME_LINES` ＋ 交互区。
 * 交互区那一项不在这里（它按内容算，见 `dock` 那一段注）。
 *
 * ⚠️ **下沿那条线也是固定行**（U45）：加了它却不加这里的账，活动区就多算一行 ⇒ 帧正好顶满
 * ⇒ 真光标高一行（U31 那一族的老病：账与屏必须同取一处，见上面 `liveBudget` 那一段注）。
 * **U59 挪这条线时这个数一分没动**——换的是「这两行谁在上谁在下」，行数还是那三行。
 */
const CHROME_LINES = 3

/** 活动区要画的那一条——**画哪几条、留不留分段、跳几行**都在这一处定（账与屏同源）。 */
type LiveEntry = {
  readonly row: LogRow
  /** 这一条之前留不留一行分段（用户消息之前＝留）——**按它在本轮里的真上一条**算。 */
  readonly spaced: boolean
  /**
   * 这一条**开头几行不画**——只有头一条会非零：它自己就比预算高（单条长记录 / 一段长 diff）
   * 时，只画它**末尾**那几行。**记录里一行不少，屏上画不下的就不画**。
   */
  readonly skip: number
}

/**
 * 活动区的那几条——**从尾往前数满预算**（取尾部：屏上留下最近发生的）。
 *
 * ⚠️ **两条都归这里管**（U31 三轮退回）：
 *
 * ① **单条自己就超预算要真切**——早先那一支是「至少留住一条整行」（`kept.length > 0`
 *    才 `break`），于是一条 4 行的流式记录在 3 行的预算里**整条留了下来** ⇒ 动态帧 11 行、
 *    终端 10 行 ⇒ 照样顶满 ⇒ 真光标高一行。预算常量减一减不掉这一条，故**切它的末尾**：
 *    留的那几条加起来**恰好等于预算**（不多一行）。
 * ② **「上一条是谁」按本轮的次序算**——交界那一行（下标 0）的上一条是 `settled` 的末条
 *    **只在它真是头一条时**才成立；窗口从中间截断时，它的上一条是**被截掉的那条本轮行**。
 *    早先账里恒按「无上一条」算（`needsSpacer(rows, 0)` 恒为假）、渲染那处恒按 `settled.at(-1)`
 *    算——同一条交界行两本账，差的正是一行分段。
 */
function liveAreaOf(view: ShellView, columns: number, budget: number): readonly LiveEntry[] {
  // ⚠️ **这儿一行都不摘**（U34 返修①）：安静的那几个工具行也在本轮里，只是**渲染那一处
  // 不出行**（`components/log.ts` 按 `quiet` ＋ `expanded` 判）——故它们的显示行数是 0，
  // 也就自然不占预算（`heightOf` 走的是同一个 `rowLines`）。在这儿滤掉＝它们连
  // 「展开可查」都没了（`ctrl+o` 展开时得能看见）。
  const rows = view.rows
  const spacedAt = (index: number): boolean =>
    needsSpacerAfter(index === 0 ? view.settled.at(-1) : rows[index - 1], rows[index])

  if (budget <= 0) return []

  const entries: LiveEntry[] = []
  let used = 0

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index] as LogRow
    const spaced = spacedAt(index)
    const size = heightOf(row, columns, view.expanded, spaced)
    const room = budget - used

    if (size > room) {
      // 装不下：**只有头一条**（下面那几条都已经装下了）切末尾——更老的整条不画，
      // 「整行保留」那条不变（切一半的老条目比不画更容易读串行）
      if (used === 0) entries.unshift({ row, spaced, skip: size - room })
      break
    }

    entries.unshift({ row, spaced, skip: 0 })
    used += size
  }

  return entries
}

/** 一行的显示行数（只数，不渲染——借记录区的纯函数）。 */
function heightOf(row: LogRow, columns: number, expanded: boolean, spaced: boolean): number {
  return rowLines(row, { columns, expanded, spaced }).length
}

/**
 * **动态区的这一屏怎么分**（U34）——余量先给交互区，再给当前回复留够，**剩下的归清单**。
 *
 * **一处算术、三处取用**：铺屏（`AppView`）、量行（`dockHeightOf` 的那笔账）、
 * **动画开关**（活壳据「清单画不画得出来」决定要不要滴答）。三处各算一套的话，
 * 「清单看得见却不动」或「看不见还在动」这种账当场分家。
 *
 * `rest` 是**分给活动区与清单的总量**（交互区与分隔线、状态行都还没扣）——调用方拿它
 * 减 `plan.height` 就是活动区的预算（清单那一块只吃它自己那一份，活动区不变少）。
 */
export function liveLayoutOf(
  view: ShellView,
  columns: number,
  rows: number,
): { readonly plan: PlanBlock; readonly rest: number } {
  const rest = Math.max(0, rows - 1 - CHROME_LINES - dockHeightOf(view, columns, rows))
  const plan = planBlockOf({
    plan: view.plan.plan,
    collapsed: view.planCollapsed,
    top: view.planTop,
    columns,
    budget: planBudgetOf(rest),
  })

  return { plan, rest }
}

/**
 * **清单那一格的呼吸**（U34）——只在「**进行中那一步真在屏上** · **实际工作中**」时动
 * （设计：空闲、等待、错误、收起或卸载时停止）。
 *
 * 钟不是新开一个：与工具行那个「跑到第几秒」共用活壳里那支按需 200ms 的钟
 * （`useLiveClock`）——两种动都只是「画的时候多个此刻」，合在一起滴答不冲突。
 *
 * ⚠️ 判据落在 `block.hasRunning` 上——**只看真画出来的那几行**（见 `PlanBlock.hasRunning`）：
 * 拿整份 `steps` 扫的话，进行中那一步翻出视口之后屏上全在动；收起 / 极矮窗口没画清单时
 * 同理（返修⑤）。
 *
 * ⚠️ **光让钟停还不够**（同一个返修）：共享的 `now` 若**无条件**递给清单，工具在跑时
 * 那格方块照样会暗一档亮一档——「时钟在走」与「这一块该不该动」是两件事。故调用方
 * （`AppView`）**只在呼吸为真时**才把 `now` 交给 `PlanList`，否则给 `null`（＝画原色、
 * 一动不动）。
 */
export function breathingOf(view: ShellView, block: PlanBlock): boolean {
  return view.status.state === 'working' && block.hasRunning
}

/**
 * **待确认的那一行**（U46）——空闲按 Ctrl+C 的第一下印的那一句，落在**输入行上方**
 * （与「等模型回来…」那类临时提示同一格）。
 *
 * 三处分寸都落在这一格上，别改坏：
 * - **不落记录、不进 scrollback**——它必须**能被清掉**（回执 `·` 那条路印一次就进
 *   scrollback，走不了这一条）；清的理由只有一个（用户又不想走了），收口在 `shell.ts`
 *   的 `key`，此处只管画。
 * - **判决只有一条**（`showsExitArmed`）：`dockOf` 照它画、`dockHeightOf` 照它记 1 行——
 *   两处各判各的，矮窗上就是「账少一行、屏多一行」⇒ 真光标高一行（U31 那一族的老账）。
 * - **位置取「交互区最上面那一格」**（不是「紧贴输入行」）：选择器 / 本地小输入开着时
 *   照样得说得出这句话——「空闲按一次不退出」是一条**不随左下开着什么而变**的规矩
 *   （一个键在一个状态下只有一种走法，那正是本单的由头）。贴着那一片的顶边，三种用法
 *   下都在同一处；常态下它就是输入行正上方那一行。
 *
 * 行首那两个全角空格与本地小输入的标签（`prompt.ts`）同形制——「输入行上方那一行」
 * 就这一副面孔，不另造一种缩进。
 */
function exitArmedLine(view: ShellView): readonly ReactElement[] {
  return showsExitArmed(view)
    ? [h(Text, { key: 'exitArmed', color: PALETTE.dim }, `　${HINT_EXIT_ARMED}`)]
    : []
}

/**
 * **那一行在不在**——渲染与高度账**同取这一处**（见 `exitArmedLine` 那一段注）。
 *
 * ⚠️ **裁决接管那一片不算**：那一屏的键是「答复」的键，`ctrl+c` 在那里是**中断**、
 * 从来不挂这一行（`shell.ts` 的 `exitOrInterrupt`）——排除它，两处才对得上。
 */
function showsExitArmed(view: ShellView): boolean {
  return view.exitArmed && view.dock.kind !== 'decision'
}

/** 左下交互区的内容（四种用法）。 */
function dockOf(view: ShellView, columns: number, rows: number): readonly ReactElement[] {
  const flash =
    view.flash === null ? [] : [h(Text, { key: 'flash', color: PALETTE.warn }, `▲ ${view.flash}`)]
  // 待确认的那一行（U46）——**交互区最上面那一格**（三种用法下都在同一处，见 `exitArmedLine`）
  const exitArmed = exitArmedLine(view)

  if (view.dock.kind === 'decision') {
    // **不画输入行**（D29）：接管期间打不进字，那句「等你的答复」与状态行的「● 等你定夺」
    // 说的是同一件事。材料与键位在卡上、状态与件数在状态行，该说的都在。
    // ⚠️ 真光标不会因此留在屏上：`Composer` 卸载时 Ink 的 `useCursor` 清理把它藏回去；
    //    草稿与插入点归 `view.stashed`（`takeOver` / `undock`），与画不画这一行无关。
    return [h(DecisionCard, { key: 'card', pending: view.dock.pending }), ...flash]
  }

  if (view.dock.kind === 'prompt') {
    return [
      ...exitArmed,
      h(PromptLine, {
        key: 'prompt',
        prompt: view.dock.prompt,
        columns,
        maxLines: maxDraftLines(rows),
      }),
      ...flash,
    ]
  }

  if (view.dock.kind === 'picker') {
    // 候选列在**输入行之上**（与自动补全那一栏同一位置：先看候选，再看自己在打的那句话）。
    return [
      ...exitArmed,
      // `rows` 一路给到候选那一头：**半屏封顶**按它算（`maxPickerLines`），
      // 与高度账同取 `pickerLayout` 一处（见 `dockHeightOf` 里那一段注）
      h(PickerList, { key: 'picker', picker: view.dock.picker, columns, rows }),
      // ⚠️ **`@` 那一栏把输入行留着**（U36）——设计「引用留在交代的位置」：用户打的路径
      // 正长在那句话里，把输入行藏掉，他就看不见它落在哪儿了（别的那几栏不必显示输入行：
      // 它们的查询是抽屉自己的，不写进草稿）。插入点也照旧摆着（真光标就在那句子里）。
      ...(view.dock.picker.source === 'paths'
        ? [
            h(Composer, {
              key: 'composer',
              draft: view.draft,
              caret: view.caret,
              refs: view.refs,
              tone: toneOf(view),
              maxLines: maxDraftLines(rows),
              columns,
            }),
          ]
        : []),
      ...flash,
    ]
  }

  return [
    // **待确认的那一行**（U46）——交互区最上面那一格（常态下就是输入行上方那一行）
    ...exitArmed,
    ...(view.completion === null
      ? []
      : [h(Completion, { key: 'completion', completion: view.completion, columns })]),
    // ⚠️ **U36 起没有「草稿材料」那一行**（U33 的 `SkillLine` 已删）：材料就写在正文里
    // （`@src/login.ts` / `/review`），**原位**那一段自己就是凭据——旁边再列一行「待发送」，
    // 等于同一件事说两遍，而删了正文那处材料还在（暗带）。见 `ShellView.refs` 那条注。
    h(Composer, {
      key: 'composer',
      draft: view.draft,
      caret: view.caret,
      refs: view.refs,
      tone: toneOf(view),
      maxLines: maxDraftLines(rows),
      columns,
    }),
    ...flash,
  ]
}

/**
 * 自动补全的候选（D12）——列在输入行**上方**：名字 ＋ 一句话说明，选中那条高亮。
 *
 * 说明那半截**截到一行装得下**（`clip`）：技能名进了候选之后（U33），说明取自用户写的
 * `description`，可以很长——折一行，交互区的高度账就少算一行（`dockHeightOf` 一行一条数），
 * 矮终端上动态帧正好顶满 ⇒ 真光标高一行（U31 三轮那条老病）。故这一栏**每条都担保一行**。
 */
function Completion({
  completion,
  columns,
}: {
  readonly completion: CompletionState
  readonly columns: number
}): ReactElement {
  return h(
    Box,
    { flexDirection: 'column' },
    ...completion.candidates.map((candidate, index) => {
      const marker = index === completion.selected ? '› ' : '  '
      // 这一栏没有内边距：整行就是屏宽 —— 扣掉标记（2 列）与名字、以及中间那个全角空格（2 列）
      const room = Math.max(0, columns - 4 - inkWidth(candidate.name))
      const summary = clip(candidate.summary, room)

      return h(
        Text,
        // 名字取键就够——候选里**一个名字只出现一次**（技能同名在发现那一层就去重了，
        // 见 `view.ts` 的 `skillCommands`）。U57 那一位次前缀随同名并列一起退回。
        { key: `c:${candidate.name}` },
        h(
          Text,
          { color: index === completion.selected ? PALETTE.user : PALETTE.faint, bold: index === completion.selected },
          `${marker}${candidate.name}`,
        ),
        h(Text, { color: index === completion.selected ? PALETTE.dim : PALETTE.faint }, `　${summary}`),
      )
    }),
  )
}

/**
 * 输入行的面孔——按状态给（显示层不判断业务，只翻状态）。
 *
 * `working` 还要再分一次（U20 · 差距 3「进度感：**工具跑动 / 等待模型 / 退避重试**，
 * 屏上都要看得出」）：**有工具在跑**时说的是「工作中」（此刻有 `⟳` 那行在动），
 * **没有工具在跑**时球在模型那边——说的是「等模型回来」。两句话分开，三种状态就
 * 各自有各自的**屏上痕迹**，不用去看状态行才分得出。
 */
function toneOf(view: ShellView): ComposerTone {
  if (view.status.state === 'retrying') return 'retrying'
  if (view.status.state === 'working') return hasRunningTool(view) ? 'working' : 'waiting'

  return 'idle'
}

/**
 * 草稿那一片最多占几行——**半屏**（原型 · 键盘：多行草稿的高度随内容长，上限半屏）。
 *
 * ⚠️ 这一份预算**含**「… 上面/下面还有 N 行」那两行提示（U31 二轮退回）——
 * 它同时是 `dockOf` 渲染用的 `maxLines` 与 `dockHeightOf` 算账用的那一个，
 * 两处同源，账与屏才不差分毫（由头见 `dock` 那一段注）。
 */
function maxDraftLines(rows: number): number {
  return Math.max(1, Math.floor(rows / 2))
}

/**
 * 交互区要几行——**按内容算**（原型：展开高度＝内容所需，最多半屏）。纯函数：布局与用例都拿它。
 */
export function dockHeightOf(view: ShellView, columns: number, rows = Number.POSITIVE_INFINITY): number {
  const flash = view.flash === null ? 0 : 1
  // 待确认的那一行（U46）——**与 `dockOf` 同取 `showsExitArmed` 一处**（那一处画、这里记 1 行）
  const exitArmed = showsExitArmed(view) ? 1 : 0
  const completing = completionLines(view)

  if (view.dock.kind === 'decision') {
    const material = view.dock.pending.material
      .split('\n')
      .reduce((sum, line) => sum + Math.max(1, wrap(line, Math.max(8, columns - 4)).length), 0)

    // `+ 3` ＝ 卡自己那三行：标题前那一行 `marginTop` · 标题 · 键位行。
    // ⚠️ 账与屏同源：这里比屏上多算一行，活动区就少一行，矮窗上**真光标高一行**
    //    （见本文件 `dock` 那一段注）。
    return material + 3 + flash
  }

  if (view.dock.kind === 'prompt') {
    // 标签那一行 ＋ 输入行那一片（与草稿同取 `draftHeight`）＋ 说明（按实际折几行算）＋ 闪一句
    const note =
      view.dock.prompt.note === undefined
        ? 0
        : wrap(view.dock.prompt.note, Math.max(8, columns - 4)).length

    return (
      exitArmed +
      1 +
      draftHeight(view.dock.prompt.display, view.dock.prompt.caret, columns, maxDraftLines(rows)) +
      note +
      flash
    )
  }

  if (view.dock.kind === 'picker') {
    // 候选那一头**数的是窗口**（不是全量行数）——候选超过半屏时，`pickerLayout` 会折起来
    // 并画一条「… 上面/下面还有 N 条」，三者（行 ＋ 分组头 ＋ 提示）都在它交出来的 `items` 里。
    // ⚠️ **账与屏同取这一处**（`pickerLayout`）：分头算一次就会重演「账 N 行、屏 N+1 行」
    // ⇒ 矮终端上真光标高一行（U31 那一族的老账，本文件上面那一段注写的就是它）。
    const candidates = pickerLayout(
      view.dock.picker,
      pickerBudget(view.dock.picker, columns, rows),
    ).items.length
    // 那行说明**按实际占几行算**（U22）：`/grants` 的说明比 `/resume` 的长得多
    // （怎么用 ＋ 那笔账），超宽会由 Ink 折行——照 1 行算，交互区就少算了一行
    // （D11 那条「行高与实际不符」的老账，正是这么来的）
    const hint =
      view.dock.picker.hint === undefined
        ? 0
        : wrap(view.dock.picker.hint, Math.max(8, columns - 4)).length

    // `@` 那一栏**多一行输入行**（U36：草稿照旧露着，见 `dockOf`）——与渲染**同取一处**
    // （`draftHeight`）。这一格漏了，账与屏当场分家（矮终端上真光标高一行，U31 那条老病）。
    const composer =
      view.dock.picker.source === 'paths'
        ? draftHeight(view.draft, view.caret, columns, maxDraftLines(rows))
        : 0

    return exitArmed + candidates + hint + composer + flash
  }

  // 输入行那一片：草稿有几**视觉行**就占几行（多行草稿 —— 半屏封顶；见 `draftHeight`）。
  // ⚠️ 与渲染**同一处**算（`composerLayout`）——折行、折叠、「上面/下面还有 N 行」
  //    那两行都算在内；各算一套迟早对不上（D11 那条「行高与实际不符」就是这么来的）。
  // ⚠️ **U36 起没有「草稿材料」那一行**（U33 的 `SkillLine` 已删，账里那一格随之去掉）：
  //    引用就长在草稿那几行里，不另占一行。
  return draftHeight(view.draft, view.caret, columns, maxDraftLines(rows)) + completing + exitArmed + flash
}

/** 自动补全的候选行数（D12）——零条时不出。 */
function completionLines(view: ShellView): number {
  return view.completion === null ? 0 : view.completion.candidates.length
}

// —— 活壳 ——

export type TuiAppProps = {
  readonly shell: Shell
}

/**
 * 跑动中滴答的间隔（毫秒）——实现级常量。
 *
 * 取 200 的由头：屏上报的是 `0.6s` / `1.2s` 这一档（一位小数），200ms 一跳看着是**连着走**的，
 * 而不是一格一格蹦；比这更密只是白烧重绘（受控渲染是 U21 的账）。**没有东西在跑就停表**——
 * 闲着的屏一格都不重绘。
 */
const TICK_MS = 200

/**
 * 活钟（U20 · 差距 3）——**工具跑动时**才滴答；给屏上那行 `⟳ 0.6s` 一个「此刻」。
 *
 * 为什么钟归这一层（而不是视图或外壳）：它是**渲染**的事（同一条视图，此刻画出来与
 * 半秒后画出来不同），而视图要可重放、外壳要可测——两者都不该带一个走着的钟。
 */
function useLiveClock(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    if (!active) {
      setNow(null)
      return
    }

    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)

    return () => clearInterval(timer)
  }, [active])

  return now
}

/**
 * **页号一变就清屏**（U44 · 翻页）——订在外壳上，**不在重绘之后补**。
 *
 * 时机是这一手唯一容易做错的地方，两条路只差一步，结果完全不同：
 *
 * - **订在外壳上（这里）**：外壳改视图是同步的（`commit` 里先落 `view` 再叫醒订阅者），
 *   而 React 那一趟重绘排在**微任务**里（`useSyncExternalStore` 的 `forceStoreRerender`）。
 *   故这一串必定落在**新一页的头一行写出去之前** ✓
 * - **放进 `useEffect` 等重绘之后**：那一下新一页的头几行**已经写出去**了（`<Static>` 重挂
 *   会把它们整批写一遍），随后清屏把它们一并推进 scrollback——屏上剩一张**空页**，
 *   那一页的记录反而看不见了 ✗
 *
 * ⚠️ **只认页号**（`ShellView.page`）：页号只在「记录区整块换掉」时加一——而「加不加」由
 * 归约那一侧判（`reduceSessionState`：会话身份真换了，**或**外壳发过 `/clear` 那一跳）。
 * 这里**不必**再判「是 `/clear` 还是 `/resume`」：**页动了就是换页**。
 * 反例那一格归它管：首条消息开张（`null → 头一条会话`）**不加页**——那时记录区没换，
 * 屏上正是用户刚敲的那句话，清了才是错的。
 *
 * ⚠️ 屏高**从 ref 里取**：订阅那一趟跑在重绘之外，闭包里直接抓 `rows` 会一直用挂载时那个数
 * （窗口改过大小之后，清屏就会少推几行）。ref 每次重绘跟着更新，读到的就是当下这一屏。
 */
function useFlipOnNewPage(shell: Shell, rows: number): void {
  const { write } = useStdout()
  const flipped = useRef<number | null>(null)
  const height = useRef(rows)

  useEffect(() => {
    height.current = rows
  }, [rows])

  useEffect(() => {
    // 挂载时先记下当下这一页——**不许**把开机那一屏当成「刚换了一页」清掉
    flipped.current = shell.getView().page

    return shell.subscribe(() => {
      const next = shell.getView()
      if (next.page === flipped.current) return

      flipped.current = next.page
      write(flipBytes(height.current))
    })
  }, [shell, write])
}

export function TuiApp({ shell }: TuiAppProps) {
  const view = useSyncExternalStore(shell.subscribe, shell.getView)
  const { columns, rows } = useWindowSize()
  const { exit } = useApp()
  // 清单那一块与铺屏同取一处（`liveLayoutOf`）——钟据它判「看不看得见」，
  // 清单翻页据它算「一页到哪」（见下）
  const { plan } = liveLayoutOf(view, columns, rows)
  const now = useLiveClock(hasRunningTool(view) || breathingOf(view, plan))

  useFlipOnNewPage(shell, rows)

  /**
   * **`/exit` 放行了 ⇒ 收摊**（U52）——**不在按键那一刻**（那一下只是把停止的意图发出去），
   * 而在外壳判定「可以走了」那一跳：会话停到 `done`（或到点没停成、实话已经说过）之后，
   * `view.leaving` 置上，界面到这儿才退（设计：「**资源确认退出之后**才退界面」）。
   *
   * 为什么由这一层落成 `exit()`：收摊是 Ink 的事（`useApp` 的 `exit` 才卸载），外壳那一层
   * 够不着它；外壳只说「可以走了」，怎么走归这儿。
   */
  useEffect(() => {
    if (!view.leaving) return
    const timer = setTimeout(() => exit(), 0)
    return () => clearTimeout(timer)
  }, [view.leaving, exit])

  const feed = (key: ShellKey): void => {
    if (shell.key(key).exit) exit()
  }

  useInput((input, key) => {
    // **清单翻页**（U34）——`PgUp` / `PgDn`。
    //
    // ⚠️ 这一跳**只有这一层做得了**：一页几行＝屏上放得下几行，而列数、终端高度、
    // 交互区的高度账都在这儿（外壳不猜屏有多高，见 `ShellKey.planTop`）。
    // 故这里算**目标位置**，外壳只存；「没有选择器/审批接管时才生效」那条规矩归外壳判
    // （它才知道此刻左下开着什么）。
    if (key.pageUp === true || key.pageDown === true) {
      if (plan.window !== null) {
        feed({ kind: 'planTop', top: planScrolled(plan.window, key.pageDown === true ? 1 : -1) })
      }
      return
    }

    for (const mapped of toShellKeys(input, key)) feed(mapped)
  })

  // 粘贴走**另一条信道**（bracketed paste）——接管期间一律拒并提示
  usePaste((text) => feed({ kind: 'paste', text }))

  return h(AppView, { view, columns, rows, now })
}

/** Ink 的 `(input, key)` → 外壳认得的按键（0 到多条——一次回调可能带一串正文）。 */
export function toShellKeys(
  input: string,
  key: {
    readonly ctrl?: boolean
    readonly meta?: boolean
    readonly shift?: boolean
    readonly return?: boolean
    readonly backspace?: boolean
    readonly delete?: boolean
    readonly escape?: boolean
    readonly upArrow?: boolean
    readonly downArrow?: boolean
    readonly leftArrow?: boolean
    readonly rightArrow?: boolean
    readonly tab?: boolean
  },
): readonly ShellKey[] {
  if (key.ctrl === true && input === 'c') return [{ kind: 'ctrl+c' }]
  if (key.ctrl === true && input === 'o') return [{ kind: 'ctrl+o' }]
  // `Ctrl T`——收起/展开当前清单（U34）。两条来路同形：裸控制码 `\x14`（Ink 解成
  // `ctrl＋字母 t`）与 kitty 协议下的 `CSI 116;5u`（`use-input` 那两支都归到 `input === 't'`）。
  if (key.ctrl === true && input === 't') return [{ kind: 'ctrl+t' }]
  // `Ctrl X` / `Ctrl W`——会话列表里停选中的那一条（U50）：整体 / 局部两档。
  // 只在 `/resume` 那一屏有意义（见 `shell.ts` 那两个键的注），别处按下去是无声的。
  if (key.ctrl === true && input === 'x') return [{ kind: 'ctrl+x' }]
  if (key.ctrl === true && input === 'w') return [{ kind: 'ctrl+w' }]
  if (key.tab === true) return [{ kind: 'tab' }]

  // **`shift+回车` ＝ 换行**（原型 · 键盘）。两条来路都要认（这就是「两条来路」那件事）：
  // ① **kitty 键盘协议**（`run.ts` 开了）——终端把它报成独立的 `CSI 13;2u`，
  //    Ink 解出 `return ＋ shift`；
  // ② **裸 LF**——有的终端 `shift+回车` 就发一个 `\n`（而 `\n` 在 Ink 那儿**本来就不是**
  //    `return`：它名字叫 `enter`；今天落到下面的分支会被当成一个正文字符塞进草稿）。
  if (key.return === true && key.shift === true) return [{ kind: 'newline' }]
  if (input === '\n') return [{ kind: 'newline' }]

  if (key.return === true) return [{ kind: 'enter' }]
  // ⚠️ **退格与前向删除是两个键**（U31）——早先并成「退格」，插入点一动就露馅：
  //    两个键删的是**两边**（`⌫` 删插入点左边、`delete` 删右边）
  if (key.backspace === true) return [{ kind: 'backspace' }]
  if (key.delete === true) return [{ kind: 'delete' }]
  if (key.escape === true) return [{ kind: 'escape' }]
  if (key.upArrow === true) return [{ kind: 'up' }]
  if (key.downArrow === true) return [{ kind: 'down' }]
  // 左右键（U31）——Ink 给的形态：`input === ''` ＋ `key.leftArrow / rightArrow`
  if (key.leftArrow === true) return [{ kind: 'left' }]
  if (key.rightArrow === true) return [{ kind: 'right' }]

  // 带 ctrl / meta 的其余键不是正文（Ink 把控制字符解成「字母 ＋ ctrl」）
  if (key.ctrl === true || key.meta === true) {
    return input === '' ? [] : [{ kind: 'other', label: `${key.ctrl === true ? 'ctrl+' : 'meta+'}${input}` }]
  }

  if (input === '') return []

  // 一次来一串＝**攒块**——来路两条（都不是「只有粘贴」）：
  // ① **敲的键被合块**（D35 的主角）：应用的读没跟上手，`/exit` 与紧接的回车并成一个读块；
  // ② 终端不认 bracketed paste 时的**粘贴**。
  //
  // ⚠️ **一个字符都不改**（2026-09-22 独立复核）：早先这里逐字符摊开时不落控制字符，
  // 结果**粘贴里的 Tab 被悄悄删掉**（`if ready:\n\tprint(1)` 到模型手上成了不带缩进的
  // 两行）——Tab 是**合法的粘贴内容**，不是「用户打不出来」的东西。**原文照收**：
  // 是正文就原样进草稿；换行那一条由上面 `input === '\n'` 与 `key.return` 两处管。
  //
  // ⚠️ **D35**：末尾那一个 `\r` 得认回来——但**只在能自证的那一形**上（见 `trailingEnterOf`）。
  //    它是**唯一**从这一支里长出来的非正文键；其余每一个字符照旧原样摊开。
  const body = trailingEnterOf(input)
  const chars = [...(body ?? input)].map((char) => ({ kind: 'char', char }) as const)

  return body === null ? chars : [...chars, { kind: 'enter' }]
}

/**
 * 攒块**末尾**那一个 `\r` 算不算回车（缺陷 D35）——**只认能自证的那一形**。
 *
 * 返回该当回车的那种块里**减掉末尾 `\r` 的正文**；不算回车时返回 `null`（那个块原样是正文）。
 *
 * ## 那个缺陷
 *
 * 正文与回车**挤进同一个读块**时（`/exit\r`），Ink 的 `parseKeypress` 把整块当**一串正文**
 * （`name: ''`）⇒ `key.return` 不成立 ⇒ `toShellKeys` 给出 6 个字符键、**没有回车**：
 * 那一按不提交，屏上什么也不发生。底下所有命令都受影响，不止 `/exit`。
 *
 * ⚠️ **合块与终端的写边界无关**：真 PTY 实测——**六次写、每字一次、间隔 0ms**，仍然并成一个
 * `/exit\r` 读块。合块取决于**应用读得快不快**（`readable` 一响就 `stdin.read()`，读得慢就攒着），
 * 而「**App 正忙、敲完立刻回车**」正是它——那正是交互最快的用法。
 *
 * ## 为什么只能认这么窄
 *
 * 「敲的正文＋回车」与「粘贴进来的一段带换行的文字」**在同一个读块里长得一样**——三处都问了，
 * 无处可用：
 *
 * - **`useInput` 那一头只有一串字符**：实测 `/exit\r` ⇒ `input` 是整串、`key` 十几个布尔全假。
 *   没有来源、没有边界；时序（读块是什么时候攒的）也不外传。
 * - **粘贴那条信道**（`usePaste`）**只在终端认 bracketed paste 时才走**：那时
 *   `\x1b[200~ … \x1b[201~` 由 Ink 的解析器切成 `paste` 事件、与读块无关（marker 跨块也认）。
 *   终端不认它时（`?2004h` 被忽略），粘贴就是一块**裸正文**落进这里，与敲的键同形。
 * - **Bun 的 PTY 那头给不出**：`Bun.Terminal` 只有 `write` / `resize` / `setRawMode` / `data`，
 *   没有粘贴或输入事件这一说；`process.stdin` 同样没有。字节流里唯一的粘贴边界就是那对 marker，
 *   而它已经被 Ink 消费掉了。
 *
 * 于是只剩**字符形状**可判，而形状里有且只有一条能自证——三条全中才认：
 *
 * 1. **块以 `\r` 结尾**（敲出来的回车就是 `\r`）；
 * 2. **块里 `\r` 只这一个**——挡住「一段 CR 结尾的多行」（`a\rb\r` 是两个）；
 * 3. **块里没有 `\n`**——**多行粘贴必然带 `\n`**（LF 与 CRLF 都带），而带换行的块本来就该
 *    原样进草稿（`\n` 在正文里是**真换行**，见 `case 'char'` 那一支）。
 *
 * 三条之外的任何块**一律原样是正文**：宁可不修，也不把粘贴切碎——**切碎比这个缺陷更坏**。
 *
 * ⚠️ **代价（如实记）**：敲多行草稿（`shift+回车` 的 `\n`）之后**立刻**回车的话，那一块同样
 * 带 `\n` ⇒ 那一下仍然不提交（**与今天一样，不是新坏**）。要更宽只剩「问终端 bracketed paste
 * 开没开」（`CSI ? 2004 $ p`）那一条路——多数终端根本不答，还多一次开机时序的赌，故不做。
 */
export function trailingEnterOf(input: string): string | null {
  if (input.length < 2 || !input.endsWith('\r')) return null
  if (input.includes('\n')) return null
  if (input.slice(0, -1).includes('\r')) return null

  return input.slice(0, -1)
}
