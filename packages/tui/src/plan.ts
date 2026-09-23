/**
 * 外壳 · **步骤清单的排版与视口**（U34 · 界面线）——纯函数，不认识 Ink。
 *
 * 清单是**动态区末尾、输入区上方**那一块（设计 · 任务推进 · 终端投影与布局）。它的账
 * 一句话说完：**先保证输入/审批区，再给当前回复留够，剩下的才归清单**；放不下时
 * **只在清单内部做行视口**——所有步骤都翻得到，不裁短标题、不限制步骤数。
 *
 * 本文件只答三件：**几行够**（预算与自然高度）、**显示哪几行**（行视口）、
 * **翻一页到哪**（目标位置）。**方块与文字长什么样**由渲染层按这里给的行去画——
 * 两处同取一份行，账与屏才不会分家（U31 三轮那条老账：账 4 行、屏 5 行 ⇒ 真光标高一行）。
 *
 * 为什么这些不写在渲染组件里：**翻页是按键语义**，而按键那层（`shell.ts`）不起终端也要测
 * （同「键位语义全在这层」那条纪律）；更重要的是**预算那一格必须与铺屏那一格同源**——
 * 各算一套的话，矮终端上动态帧正好顶满、真光标高一行。
 */

import type { PlanNote, PlanStep } from '@magic/contracts'
import { PALETTE, truncate, wrap } from './components/lines.ts'

// ══ 预算：动态区的余量怎么分 ══════════════════════════════════════════

/**
 * **给当前回复留几行**（设计 · 终端投影与布局：剩余空间**至少为当前回复保留 3 行**
 * （不足时取实际余量），其余给清单）。
 *
 * 取 3 的由头就写在设计里：活动区是「此刻在发生什么」的唯一去处（流式正文、工具行），
 * 被清单挤成一行——甚至挤没——就本末倒置了：清单是**辅助**，正文才是工作本身。
 *
 * ⚠️ 「不足时取实际余量」＝余量本来就不够 3 行时，**清单一行都不画**（`planBudgetOf`
 * 给 0），全留给回复；恢复高度即还原，不落历史、不清屏（`planBlockOf` 那一段注）。
 */
export const PLAN_KEEP_LINES = 3

/**
 * 清单最多能占几行——**从动态区余量里扣掉留给回复的那几行**，剩下的全给它
 * （「其余给清单」：清单要不要用满是它自己的事，见 `planWindow`）。
 *
 * ⚠️ 减去 3 之后**可能为负**（余量比 3 还少）——那就是 0：一行都不画。
 */
export function planBudgetOf(rest: number): number {
  if (rest <= PLAN_KEEP_LINES) return 0

  return rest - PLAN_KEEP_LINES
}

// ══ 一行步骤：方块 ＋ 文字 ════════════════════════════════════════════

/**
 * 方块那一格的宽度（列）——`■` 自己一列，后面跟一个空格（读起来才是「方块 ＋ 步骤」
 * 两段，而不是「■续写」）。续行照这个宽度悬挂缩进，文字左边缘对得齐。
 *
 * ⚠️ **与记录区的行首对齐**：记录区那些行也是「一个标记 ＋ 一个空格」
 * （`› ` / `⏺ ` 各 2 列，见 `components/log.ts`）——清单就在它们下方，差一列就看着歪。
 */
export const MARK_WIDTH = 2

/**
 * 一条步骤的文字 → 显示行（按显示列宽折，Tab 按终端的规矩展）。
 *
 * 只折**文字**那一截：方块那一格是首行自己的前缀。折行沿用记录区那支 `wrap`
 * （中文算 2 列、Tab 按制表位展开——2026-09-22 那一轮立的规矩：**同一个 `\t` 在三处
 * 量出三个宽度**，故显示层一律先展开再量）。
 */
export function stepLines(text: string, columns: number): readonly string[] {
  return wrap(text, Math.max(1, columns - MARK_WIDTH))
}

// ══ 行视口：放不下时**只在清单内部**滚 ══════════════════════════════

/** 清单那一窗——实际显示的是 `[top, top + visible)` 这几行。 */
export type PlanWindow = {
  /** 这份清单总共有几行（折完之后）。 */
  readonly total: number
  /** 实际显示的第一行（**已夹过**：0 ≤ top ≤ total - visible）。 */
  readonly top: number
  /** 显示几行步骤。 */
  readonly visible: number
  /** 上面还有几行没显示（＝ `top`）。 */
  readonly hiddenAbove: number
  /** 下面还有几行没显示。 */
  readonly hiddenBelow: number
}

/**
 * **这一窗显示哪几行**——`null` ＝**一行都不画**（没有清单、没地方、或连一行都放不下）。
 *
 * 三条：
 * - **放得下就全显示**（`total ≤ budget`）——「能放下时显示全部步骤」，**不加提示行**
 *   （没有溢出就没有「还有 N 行」这回事）；
 * - **放不下才起视口**：留 **1 行**给提示（`planMoreLabel`：上下未显示行数 ＋ 翻页键），
 *   其余归步骤；`top` 夹回 `[0, total - visible]`——**夹在这儿**（渲染层每次都过这一处，
 *   于是计划变短、窗口变小都不会把视口留在半空）；
 * - **`budget` 只剩 1 行给不出视口**（总得显示点什么才配叫视口）⇒ 一行都不画：极矮窗口
 *   无余量时**暂不绘清单**，恢复高度即还原（设计明写，不作别的补救）。
 */
export function planWindow(total: number, budget: number, top: number): PlanWindow | null {
  if (total <= 0 || budget <= 0) return null
  if (total <= budget) return { total, top: 0, visible: total, hiddenAbove: 0, hiddenBelow: 0 }

  const visible = budget - 1
  if (visible <= 0) return null

  const at = Math.max(0, Math.min(Math.trunc(top) || 0, total - visible))

  return { total, top: at, visible, hiddenAbove: at, hiddenBelow: total - at - visible }
}

/**
 * **翻一页之后视口该在的第一行**——`delta` 为 `-1`（上翻）/ `+1`（下翻）。
 *
 * 这一跳**不是**「`top` 加减一屏」：到了两端就得停住（再按没有反应），而**总行数与
 * 屏上放得下几行只有渲染那一层知道**（列数、终端高度、交互区的高度账都在那儿）。
 * 故这个目标位置由**渲染层**按它手里那一窗算好，再交给外壳存下（`ShellKey.planTop`）——
 * 外壳不猜屏有多高。
 *
 * ⚠️ **一页 ＝ 当前这一窗显示的步骤行数**（不是「屏高」）：`visible` 已经把提示行扣掉了，
 * 照它翻才不会一翻就漏掉一行。
 */
export function planScrolled(window: PlanWindow, delta: number): number {
  const last = Math.max(0, window.total - window.visible)

  return Math.max(0, Math.min(window.top + delta * window.visible, last))
}

/**
 * 溢出时清单末尾那一行提示——**上面/下面还有几行 ＋ 翻页键**（设计：上下未显示行数与
 * `PgUp/PgDn` 提示**随溢出出现**）。
 *
 * 只报**真还有的那一头**：滚到顶上时不提「上面还有 0 行」（那句话没有信息量）；
 * 两头都有才都报（此时那一行最满，窄窗由渲染层截断——**行数在前，先丢的是那句键位**）。
 */
export function planMoreLabel(hiddenAbove: number, hiddenBelow: number): string {
  // 单头时用「还有」把这半句说圆（「上面还有 3 行」）；两头都有时那个字省掉
  // （「上面 3 行 · 下面 5 行」——同一句里说两遍反而绕）
  const both = hiddenAbove > 0 && hiddenBelow > 0
  const tail = both ? '' : '还有'

  const above = hiddenAbove > 0 ? `上面${tail} ${hiddenAbove} 行` : ''
  const below = hiddenBelow > 0 ? `下面${tail} ${hiddenBelow} 行` : ''

  return `${[above, below].filter((piece) => piece !== '').join(' · ')} · PgUp/PgDn 翻页`
}

/** 提示行**保证占一行**：窄窗按显示列宽截断（折行了高度账当场分家——U31 那条老账）。 */
export function planMoreLine(hiddenAbove: number, hiddenBelow: number, columns: number): string {
  return truncate(planMoreLabel(hiddenAbove, hiddenBelow), columns)
}

// ══ 方块：状态怎么落在那一格上 ════════════════════════════════════════

/**
 * 状态 → 字形（设计 · 任务推进：**未开始为空心、进行中与已完成为实心方块**）。
 *
 * 只两个字：**空心**与**实心**——「未开始 / 进行中 / 已完成」三态靠**字形 ＋ 颜色 ＋
 * 文字强调**一起分（无色环境里剩下的正是字形与强调，见 `planStyleOf`）。
 * 具体字形以终端实际可辨、对齐稳定为准（设计留的那一句），取 `□` / `■`：
 * 同一个方块族的空心与实心，一比一宽，不会一列一列地错开。
 */
export const GLYPHS: Readonly<Record<PlanStep['status'], string>> = {
  pending: '□',
  in_progress: '■',
  completed: '■',
}

/** 一格方块长什么样——颜色与那两件强调（**无形**，好让用例直接咬）。 */
export type PlanStyle = {
  /** 方块的颜色；`null` ＝**继承终端前景色**（不指定＝不占色）。 */
  readonly glyph: string | null
  /** 步骤文字加粗没有——无色环境里这是「进行中」唯一还站得住的区别。 */
  readonly bold: boolean
  /**
   * 这一行**压暗**没有——「已完成」那一档用它弱化（层级：做完的退后、当前那步最显眼）。
   *
   * ⚠️ **压暗不是颜色**（`SGR 2`，一种强度）：色仍是**继承终端前景色**（设计：
   * 已完成为继承前景色的静态实心方块）——弱化只说「这一行的字淡一点」，不改它是什么色。
   * 参考面：Claude 的步骤清单（用户 2026-09-23 给的呈现参考）——**只借层级**，
   * 不照搬勾号与删除线（那是它的记号，我们的记号是方块）。
   */
  readonly dim: boolean
}

/**
 * 三态各自的样式（设计 · 任务推进）：
 * - **未开始**——空心，**继承终端前景色**；
 * - **进行中**——**主题色实心方块**（亮度由呼吸给，见 `breathColor`），**步骤文字适度强调**；
 * - **已完成**——**继承前景色的静态实心方块**（不呼吸、不强调——「静态」是设计明写的）。
 *
 * `brightness` 只作用在**方块**上：文字那一路若跟着一亮一暗，就成了整行在闪，
 * 而「适度强调」要的是**一直在那儿**（无色环境里它还是唯一分得出进行中的那一件）。
 */
export function planStyleOf(status: PlanStep['status'], brightness = 1): PlanStyle {
  // 未开始——空心、原色、不强调：它是「还没轮到」的那一档，安静地占着位
  if (status === 'pending') return { glyph: null, bold: false, dim: false }

  // 已完成——实心、原色、**压暗**（做完的退后；不划掉——那是别人的记号）
  if (status === 'completed') return { glyph: null, bold: false, dim: true }

  // 进行中＝主题色 ＋ 加粗。取 `warn`：状态行「工作中」用的就是它（`stateColor('working')`）
  // ——同一个含义在同一屏上用同一个色，是色板那条「颜色只表语义」的应有之义。
  return { glyph: breathColor(PALETTE.warn, brightness), bold: true, dim: false }
}

/** 收起时那一行——**Ctrl T 的可见把手**（没有它，按了第二次就没人知道该怎么展开）。 */
export const PLAN_FOLDED = '计划已收起 · ctrl+t 展开'

// ══ 一块清单：行、视口、高度 ══════════════════════════════════════════

/**
 * 清单上的一行——**渲染层照着画就行**（画什么、画几行都定死在这一处）。
 *
 * `head` 是「这一行带方块」：一条步骤的文字折成几行时，**只有第一行顶方块**，
 * 续行悬挂缩进对齐文字（`MARK_WIDTH` 那一段注）。
 */
export type PlanRow =
  | {
      readonly kind: 'step'
      readonly key: string
      /** 第几条步骤（从 0 起）——用例与渲染色都据它认「这是哪一步」。 */
      readonly at: number
      readonly status: PlanStep['status']
      readonly text: string
      readonly head: boolean
    }
  /** 溢出那一行（上面/下面还有几行 ＋ 翻页键）。 */
  | { readonly kind: 'more'; readonly key: string; readonly text: string }
  /** 收起那一行（`PLAN_FOLDED`）。 */
  | { readonly kind: 'folded'; readonly key: string; readonly text: string }

/** 一块清单：画出来的行 ＋ 高度 ＋ 翻页要用的那一窗。 */
export type PlanBlock = {
  readonly rows: readonly PlanRow[]
  /** 占几行（＝ `rows.length`——**账与屏同一个数**，别处别再数一遍）。 */
  readonly height: number
  /** 行视口那一窗（没有清单 / 没地方 / 收起了 ⇒ `null`）。 */
  readonly window: PlanWindow | null
}

/** 空块——**不占位**（没有计划时不占位，也不为显示而强制生成计划）。 */
const NO_BLOCK: PlanBlock = { rows: [], height: 0, window: null }

/**
 * **一整块清单**——**布局、高度与渲染同取这一处**（设计：「同一布局函数负责换行、
 * 高度测量与实际渲染」）。
 *
 * 四条按次序：
 * 1. 没有计划 / 一条步骤都没有 ⇒ **空块**（辅助笔记不铺在清单里，故只有笔记也算没有）；
 * 2. **没地方**（`budget ≤ 0`，见 `planBudgetOf`）⇒ 空块——极矮窗口暂不绘清单，
 *    恢复高度即还原（**不落历史、不清屏补救**：那是「重挂历史区」那条老账）；
 * 3. **收起** ⇒ 一行（`PLAN_FOLDED`）——收起是用户自己按的，得留个把手告诉他怎么展开；
 * 4. 展开 ⇒ 折行 → 起视口 → 铺行（溢出时末尾补一行 `planMoreLine`）。
 *
 * ⚠️ **每一行都保证占一行**（折行在这儿做完、提示行在这儿截断）：终端自己折的那一行
 * 不在这笔账里，矮终端上动态帧就会顶满 ⇒ 真光标高一行（U31 三轮那条老账）。
 */
export function planBlockOf(input: {
  readonly plan: PlanNote | null
  readonly collapsed: boolean
  readonly top: number
  readonly columns: number
  readonly budget: number
}): PlanBlock {
  const steps = input.plan?.steps ?? []
  if (steps.length === 0) return NO_BLOCK
  if (input.budget <= 0) return NO_BLOCK
  if (input.collapsed) {
    return { rows: [{ kind: 'folded', key: 'plan:folded', text: PLAN_FOLDED }], height: 1, window: null }
  }

  /** 折完之后的每一步：`[步骤下标, 状态, 这一行是不是首行, 文字]`。 */
  const lines: { readonly at: number; readonly status: PlanStep['status']; readonly head: boolean; readonly text: string }[] = []

  steps.forEach((step, at) => {
    stepLines(step.text, input.columns).forEach((text, line) => {
      lines.push({ at, status: step.status, head: line === 0, text })
    })
  })

  const window = planWindow(lines.length, input.budget, input.top)
  if (window === null) return NO_BLOCK

  const rows: PlanRow[] = []
  for (let index = window.top; index < window.top + window.visible; index += 1) {
    const line = lines[index]
    if (line === undefined) continue

    rows.push({
      kind: 'step',
      key: `plan:${line.at}:${index}`,
      at: line.at,
      status: line.status,
      text: line.text,
      head: line.head,
    })
  }

  // 溢出提示**随溢出出现**（没溢出就没有这一行——放得下时那一格归步骤）
  if (window.hiddenAbove + window.hiddenBelow > 0) {
    rows.push({
      kind: 'more',
      key: 'plan:more',
      text: planMoreLine(window.hiddenAbove, window.hiddenBelow, input.columns),
    })
  }

  return { rows, height: rows.length, window }
}

// ══ 呼吸：进行中那一格的亮度 ══════════════════════════════════════════

/**
 * 一轮呼吸多久（毫秒）——设计：「约两秒一轮轻微亮度呼吸」。
 *
 * ⚠️ 时钟**复用既有的按需 200ms 那一支**（`components/app.ts` 的 `useLiveClock`），
 * 不另开常驻计时器、不用终端 ANSI 闪烁——故 2000 正好是 10 跳一轮，亮度一格一格变。
 */
export const BREATH_MS = 2000

/**
 * **此刻的亮度**（0 暗 → 1 亮，三角波：中点最亮）——给进行中那个方块上色用。
 *
 * 三角波而不是方波：方波是「闪」，设计要的是「**轻微**亮度呼吸」。两端各停一拍
 * （0 与 2000 都取 0），看着才是吸气—呼气，而不是开关。
 *
 * ⚠️ 纯函数：给一个「此刻」（毫秒）就有一个确定的亮度——屏可重放、快照可确定
 * （同 `AppView` 那条「给视图与尺寸就画一屏」）。
 */
export function breathOf(now: number): number {
  const phase = ((now % BREATH_MS) + BREATH_MS) % BREATH_MS / BREATH_MS

  return 1 - Math.abs(2 * phase - 1)
}

/**
 * 呼吸的暗端占主题色的几成——**「轻微」的落点**：不熄灭、不闪，只是亮一档暗一档。
 *
 * 0.45 是量出来的观感：再亮（如 0.7）在深底上看不出在动，再暗（如 0.2）就从「呼吸」
 * 变成了「闪烁」——那是设计明写不要的（「不用终端 ANSI 闪烁」）。
 */
const BREATH_FLOOR = 0.45

/**
 * **主题色按亮度取值**——亮度 1 ＝**原色本身**（不是「差不多」：不呼吸的那些状态用的
 * 就是原色，取不到原色，进行中与已完成在色上就对不齐了）。
 *
 * 输入不是 `#rrggbb` 时**原样返回**：色板就那几个字面量，认不出的色不猜也不编
 * （改一个色板不该让屏上出现一个拼出来的颜色）。
 */
export function breathColor(base: string, brightness: number): string {
  const rgb = parseHex(base)
  if (rgb === null) return base

  const t = Math.max(0, Math.min(brightness, 1))
  const scale = BREATH_FLOOR + (1 - BREATH_FLOOR) * t

  return (
    '#' +
    rgb
      .map((channel) => Math.round(channel * scale).toString(16).padStart(2, '0'))
      .join('')
  )
}

/** `#rrggbb` → 三个通道；别的写法一律 `null`（见 `breathColor`）。 */
function parseHex(color: string): readonly [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return null

  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ]
}
