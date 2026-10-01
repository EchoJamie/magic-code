/**
 * **动效**（U112）——一套共用的那几件：**呼吸**（持续，进行中）· **脉冲**（一次，在等你）。
 *
 * 出处：设计 · 终端交互「符号 ＋ 动效：一套」的三条例——① **表示「正在发生」的那一行/那一位
 * 可以动**（2026-10-01 用户把那句「动的只有状态位」说准了：动的范围是
 * **工具行行尾那一位 · 思考行 · 状态格 · 计划步**这四处；**身份符号 `›` `▸` `·` `│` 永不动**）；
 * ②「动 → 静」就是完成信号；③ 一切动效可停、**不用闪烁**、**不为动效新增第二个常驻计时器**。
 *
 * ## 为什么把呼吸从 `plan.ts` 挪到这儿
 *
 * 呼吸原先只服务计划步骤（U34），这一单起它要服务**三处**（计划步骤的方块 · 工具行行尾
 * 那一位 · 状态格里工作中那一位）。三处各写一份「两秒一轮、按亮度取值」迟早会走成三个
 * 数——而设计要的恰恰是**一套**动效。故把**时间**这条（一轮多久、此刻多亮、亮暗怎么折算到
 * 颜色）收在这一处；`plan.ts` 照旧导出它们（既有调用方一个字不改）。
 *
 * ⚠️ **这里只有纯函数**：给一个「此刻」（毫秒）就有一个确定的结果——屏可重放、快照可确定
 * （同 `AppView` 那条「给视图与尺寸就画一屏」）。**走着的钟不在这里**，它归活壳
 * （`components/app.ts` 的 `useLiveClock`，按需 200ms）。
 */

// ══ 呼吸：进行中那一格的亮度（持续） ══════════════════════════════════

/**
 * 一轮呼吸多久（毫秒）——设计：「约两秒一轮轻微亮度呼吸」。
 *
 * ⚠️ 时钟**复用既有的按需 200ms 那一支**（`components/app.ts` 的 `useLiveClock`），
 * 不另开常驻计时器、不用终端 ANSI 闪烁——故 2000 正好是 10 跳一轮，亮度一格一格变。
 */
export const BREATH_MS = 2000

/**
 * **此刻的亮度**（0 暗 → 1 亮，三角波：中点最亮）——给进行中那个方块的色上用。
 *
 * 三角波而不是方波：方波是「闪」，设计要的是「**轻微**亮度呼吸」。两端各停一拍
 * （0 与 BREATH_MS 都取 0），看着才是吸气—呼气，而不是开关。
 */
export function breathOf(now: number): number {
  const phase = (((now % BREATH_MS) + BREATH_MS) % BREATH_MS) / BREATH_MS

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
 * 输入不是 `#rrggbb` 时**原样返回**：色板就那几个字面量，认不出的色不猜也不编。
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

// ══ 脉冲：在等你那一位——**出现时亮一次，此后定住**（不持续） ═════════

/**
 * 「在等你」那一次脉冲走多久（毫秒）——**出现时亮一次就定住**。
 *
 * ⚠️ 由头（设计那句「动效用来说明『正在发生』，不用来证明『还活着』」）：常态在动会变噪音；
 * 「需要你」是**要打断你的**一类，给它**不同形状（`◊`）＋ 出现时脉冲一次**就够。
 *
 * 600 是三条一起量的：比 200ms 那一跳**长**（不然只有两三帧，看着像卡了一下）；比一轮呼吸
 * （2000ms）**短得多**（不然就成了「持续动」，正是设计不要的那一种）；肉眼上是一次「亮了
 * 一下」而不是一段渐变。
 */
export const PULSE_MS = 600

/**
 * **脉冲的亮度**——从暗端**单调升到原色**，走完就停在原色（`t ≥ 1 ⇒ 1`）。
 *
 * ⚠️ **单调、不回摆**（不是「亮—暗—亮」）：回摆就是闪，设计明写「不用闪烁」。升一次之后
 * 定住，读起来正是「它到了，现在轮到你了」。
 *
 * `since` 是**那一刻**（毫秒）；`now < since`（钟回拨过）按刚开始算。
 */
export function pulseOf(since: number, now: number): number {
  return Math.max(0, Math.min((now - since) / PULSE_MS, 1))
}
