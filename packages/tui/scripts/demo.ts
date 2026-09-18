#!/usr/bin/env bun
/**
 * 手动走通 —— 外壳 ＋ **脚本化假内核**（U09）。
 *
 * **为什么有这东西**：真装配归 U11（`@magic/app`）。在那之前，本脚本充当「假装配」——
 * 一端脚本化的内核（回放固定事件序列：流式 → 审批 → 结果），一端就是外壳。
 * 走的仍是**控制面协议**（命令 / 事件），没有内部直调。
 *
 * 用法：
 * ```bash
 * bun run packages/tui/scripts/demo.ts             # 交互：自己打字交代
 * bun run packages/tui/scripts/demo.ts --scripted  # 无人值守走完一轮（看整条链）
 * ```
 *
 * 键位：回车发送 · 审批时 y 批准 / n 拒绝 · 空闲 Ctrl+C 退出 · 工作中 Ctrl+C 中断。
 */

import { runTui } from '../src/run.ts'
import { createScriptedKernel } from '../test/fakes.ts'

// 外壳要一个终端（交互与 Ctrl+C 都靠它）。没有终端时给条可行的路，而不是抛栈。
if (process.stdin.isTTY !== true) {
  console.error('外壳需要一个终端。没有终端时，可以借一个 pty 跑：')
  console.error('  script -q /dev/null bun run packages/tui/scripts/demo.ts --scripted')
  process.exit(1)
}

const scripted = process.argv.includes('--scripted')
// 交互模式下步子慢些，看得出「流式」；无人值守模式快些
const kernel = createScriptedKernel({ stepMs: scripted ? 120 : 60 })
const handle = await runTui({ transport: kernel.shell })

if (!scripted) {
  console.log('假内核已就位——交代一件事试试（Ctrl+C 退出 / 工作中 Ctrl+C 中断）。')
} else {
  // 无人值守：经会话壳走一遍「交代 → 审批（自动批准）→ 结果」，然后收摊。
  // 注意：这条路绕开了键盘（键盘那一跳由 test/interaction.test.ts 覆盖）。
  const done = handle.shell.subscribe(() => {
    if (handle.shell.getView().pending !== null) handle.shell.answer('approve')
  })

  handle.shell.submit('看下工作区')

  setTimeout(() => {
    done()
    handle.unmount()
    kernel.stop()
    // Ink 收摊后 stdin 仍挂着监听，显式退出更干净
    process.exit(0)
  }, 3000)
}

await handle.waitUntilExit()
