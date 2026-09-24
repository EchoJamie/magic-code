/**
 * 界面验收 · **被测对象那一侧的词汇表**（U51 第九条）。
 *
 * ## 为什么单有一份、为什么在这儿
 *
 * 驱动（`driver.ts`）是**通用**的：它认的是「往 PTY 写字节、从 VT 读屏」，**不该认识
 * Magic 的文案**。可它有几步必须知道**某个词**才能成立——最典型的是
 * 「**什么时候算放开输入了**」与「**按第一下 ctrl+c 之后哪句话该出现**」。
 *
 * 故那些词**由调用方传进来**（`UiSessionOptions.anchors`），本文件就是 Magic 这一侧的
 * 那份答案。判据一句话：**换个被测命令，机制那一层不用改**——换的正是本文件。
 *
 * ⚠️ **它属于「场景与夹具」那一侧，不属于机制**（`研发/界面验收工具`·分层与依赖界线）。
 * 机制那几个文件（`driver` · `vt` · `artifacts` · `viewer` · `control` · 入口脚本）里
 * **一个 `@magic/` 都没有**，跑一次 grep 就能证。
 *
 * ⚠️ **缺省走沙地**（`sandbox.ts` 把它挂在 `Sandbox.anchors` 上）：`scenarios.ts` 那条路
 * 不显式传锚（那个文件这一轮归别的单），靠这一条拿到 Magic 这份——于是**行为和以前一字不差**。
 */

import { HINT_EXIT_ARMED, HINT_IDLE } from '@magic/tui'
import type { UiAnchors } from './driver.ts'

/**
 * **状态行左位那两个字的锚**（`○ 空闲`）。
 *
 * ⚠️ **不能换成右位那句 `HINT_IDLE`**：状态行「窄窗从右往左省」，右位最先让位——
 * 46 列上它还在，30 列上就整段没了（本单实测：见下 `READY_MIN_COLUMNS`）。
 * 左位那一格是**视觉锚**（`status.ts`：① 状态**永不省**），故只有它够窄。
 *
 * 出包面里没有这个常量（它是 `status.ts` 拼出来的），故按**字面量**锚在这里——
 * 改了它，真帧套件会红，不会静默过期。
 */
export const MAGIC_IDLE_MARK = '○ 空闲'

/**
 * **起手那道闸**在该宽度上等不等得到——**40 是量出来的**，不是拍的。
 *
 * 由头：`HINT_IDLE`（`/ 命令 · ctrl+c 退出`）是**右位**那句，窄了就被省掉；省掉之后
 * 「等它出现」永远等不到，起手当场超时（本单实测：**30 列等不到、40 列等得到**，之间未逐列测，
 * 故阈值取保守的 40）。判它放不放得下的规则在 `tui` 的 `status.ts`·`fitting`
 * （`显示宽 + 左位宽 + 8 ≤ 列数 − 2`）——**那条规则是产品那一侧的事，本层不复制它**，
 * 只记一个观测到的下界，宁可早一点承认「这一档没有这道闸」。
 *
 * 低于它的那一档**不是「闸开了」**：驱动会记一步 `ready-gate-absent`，明说这一趟没有闸
 * （见 `driver.ts`·`waitForFrame`）——**不假装等到**。
 */
export const READY_MIN_COLUMNS = 40

/**
 * **状态行那一格**（左下最后一行，U54）——判据落到**那一格**上，不落到全屏。
 *
 * 取法：屏底那一条分隔线（U45 加的「状态行之下」那一条）**上面**那一行。
 *
 * ⚠️ **不能拿「全屏找那几个字」代替**：
 *
 * - 输入行那句占位在「工作中」时写着 `（工作中——想插话可以打…）`——全屏找「工作中」
 *   在**还没跑完**时也是真的，量的就成了「这一屏上有没有这三个字」；
 * - 回执 / 列表那一行的详情里也可能出现同一个词（「这一轮没跑完就停了」那类）。
 *
 * 而这一格恰恰是本单要判的那一件（缺陷 D34：回执说「停了」而这一格还写着「工作中」）。
 */
export function statusLineOf(lines: readonly string[]): string {
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at] ?? ''
    if (line.trim() === '') continue
    // 最后那个非空行应当是屏底那条分隔线（`─` 一串）；它上面那一行就是状态行
    return /^─+$/u.test(line.trim()) ? (lines[at - 1] ?? '') : ''
  }

  return ''
}

/** Magic 这一侧的锚。 */
export const MAGIC_ANCHORS: UiAnchors = {
  ready: (columns) => (columns >= READY_MIN_COLUMNS ? { text: HINT_IDLE } : null),
  idle: MAGIC_IDLE_MARK,
  exitArmed: HINT_EXIT_ARMED,
}
