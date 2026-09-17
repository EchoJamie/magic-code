/**
 * 外壳 · 一屏（U09）——**对话流 ＋ 输入 ＋ 状态**。
 *
 * 两层分得清：
 * - `AppView`——**纯**：给一个视图就画一屏（快照测试直接取景；U20 换皮只动它）；
 * - `TuiApp`——**活**：订阅会话壳（`useSyncExternalStore`）＋ 管键盘（输入编辑、
 *   审批答复、Ctrl+C 语义）。
 *
 * Ctrl+C 语义（本单元把关）——**空闲 ＝ 退出；工作中（含等裁决）＝ 中断**
 * （`turn.interrupt`）。忙碌位取自状态行，两者同屏可见，用户不必记。
 */

import { Box, useApp, useInput } from 'ink'
import { createElement as h, useState, useSyncExternalStore } from 'react'
import type { Shell } from '../shell.ts'
import type { ShellView } from '../view.ts'
import { Composer } from './composer.ts'
import { DecisionPrompt } from './decision.ts'
import { isPrintable } from './lines.ts'
import { StatusLine } from './status.ts'
import { Transcript } from './transcript.ts'

// —— 纯呈现 ——

export type AppViewProps = {
  readonly view: ShellView
  /** 输入行的草稿（编辑器状态在 `TuiApp`；快照测试可直接给）。 */
  readonly draft: string
}

export function AppView({ view, draft }: AppViewProps) {
  return h(
    Box,
    { flexDirection: 'column' },
    h(Transcript, { items: view.items }),
    view.pending === null
      ? h(Composer, { draft })
      : h(DecisionPrompt, { pending: view.pending }),
    h(StatusLine, { status: view.status }),
  )
}

// —— 活壳 ——

export type TuiAppProps = {
  readonly shell: Shell
}

export function TuiApp({ shell }: TuiAppProps) {
  const view = useSyncExternalStore(shell.subscribe, shell.getView)
  const [draft, setDraft] = useState('')
  const { exit } = useApp()

  /** 工作中＝轮在跑，或悬着一条没答的裁决——此时 Ctrl+C 是中断，不是退出。 */
  const working = view.status.phase === 'busy' || view.pending !== null

  useInput((input, key) => {
    // Ctrl+C——空闲退出 · 工作中中断（首站不设确认）
    if (key.ctrl && input === 'c') {
      if (working) shell.interrupt()
      else exit()

      return
    }

    // 等裁决时输入让位给答复（草稿留着，答完接着打）
    if (view.pending !== null) {
      if (input === 'y') shell.answer('approve')
      else if (input === 'n') shell.answer('reject')

      return
    }

    if (key.return) {
      shell.submit(draft)
      setDraft('')

      return
    }

    if (key.backspace || key.delete) {
      setDraft((current) => current.slice(0, -1))

      return
    }

    // 带 ctrl / meta 的按键不是正文——Ink 把控制字符解成「字母 ＋ ctrl」
    // （Ctrl+D → input 'd'）：不拦就会往输入框里塞字（实测踩过）。
    if (!key.ctrl && !key.meta && isPrintable(input)) setDraft((current) => current + input)
  })

  return h(AppView, { view, draft })
}
