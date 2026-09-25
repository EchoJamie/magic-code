/**
 * **本机系统通知**（U50）——设计那一句里的「**无人连接时**可使用本机系统通知」。
 *
 * 三条口径：
 * - **只在那一个时刻用**：**没有窗口正看着这条会话**的时候（U86 起三类同此）——有人看着，
 *   屏上那一行就是通知，弹第二份是复述；而「A 页开着、B 出的事」按这条尺子**是没人看着**
 *   （连着不算），故它照弹（D38 那半）；
 * - **它只是提醒，不是结果**：设计明文「**权限未授予不影响持久结果**」——这一跳发不出去
 *   （用户没授权 / 没装 `osascript` / 平台没有这一路），未读那一份**照旧在盘上**，
 *   下一次打开照样汇总。故这里**一律不抛、不重试**；
 * - **一句话，不带会话 id**：管理者认不得标题（目录在窗口那一头），而把一个内部 id 弹到
 *   用户桌面上是最该避免的那种「实现细节漏出去」。故弹的是**类别 ＋ 指路**，
 *   具体是哪一条由用户打开 Magic 之后那张汇总说（那时外壳手上有标题）。
 */

/** 发一条系统通知——**发不出去就算了**（见文件头注）。 */
export type SystemNotifier = (text: string) => void

/** 通知的标题（应用名）——用户桌面上认得出是谁在说话。 */
const APP_TITLE = 'Magic'

/**
 * **macOS 那一支**——`osascript -e 'display notification …'`。
 *
 * 为什么不用 `terminal-notifier` 一类：那要用户另装东西（设计：不引入远端服务与额外依赖）。
 * `osascript` 是系统自带的，权限由系统的通知中心管。
 */
export function osNotifier(title: string = APP_TITLE): SystemNotifier {
  return (text) => {
    // 别的平台这一版没有这一路——**如实不做**（不假装发过了）
    if (process.platform !== 'darwin') return

    try {
      // AppleScript 的字符串字面量：`JSON.stringify` 出来的转义（引号 / 反斜杠 / 控制符）
      // 与它那一套是兼容的，故直接用它，不另写一个转义函数
      const script = `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`
      const child = Bun.spawn(['osascript', '-e', script], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })
      // 不等它（收尾那几条路不该被一次弹窗拖住）；也不留句柄
      child.unref()
    } catch {
      // 没有 osascript / 不给起进程——**未读还在盘上**，这一跳失败不改变任何结果
    }
  }
}
