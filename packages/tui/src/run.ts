/**
 * 外壳 · 启动（缺陷轮 II 重画）——把一屏挂上终端。
 *
 * **内联渲染（经典）· 不接管整屏 · 不捕获鼠标**（原型开篇的渲染模型注）：
 * 内容写进终端**主缓冲** ⇒ 滚轮滚终端自己的 scrollback ✓ · 原生拖选复制 ✓ ——两个都免费。
 * （互斥的从来不是「滚轮 ↔ 拖选」，而是「**捕获鼠标** ↔ 原生拖选」。）
 *
 * **代价三条（用户已认下）**：输入框**不钉底**（跟内容走）· resize **不重排已滚出的历史** ·
 * 退出后内容**留在终端**。
 *
 * `useWindowSize` 仍在——尺寸一变，交互区与状态行按新尺寸重算（活动区那一小段就地重绘）；
 * **已滚出的历史不动**（它们在 `Static` 里，见 `components/app.ts`）。
 *
 * `exitOnCtrlC: false` —— Ctrl+C 归**外壳**判（空闲＝退出 · 工作中＝中断，原型 · 键盘）。
 */

import { render } from 'ink'
import { createElement as h } from 'react'
import { createShell } from './shell.ts'
import { TuiApp } from './components/app.ts'
import type { ControlTransport } from '@magic/contracts'

/** 启动入参——传输由装配注入；`boot` 是「订阅之后、放开输入之前」那一跳。 */
export type RunTuiOptions = {
  readonly transport: ControlTransport
  /**
   * 启动流转（装配给）——恢复 / 重建要发事件，故**必须在订阅之后**跑
   * （技术方案 · 控制域：无订阅方时命令与事件都丢）。
   */
  readonly boot?: (() => Promise<void>) | undefined
  /** 注入终端流（测试用）——缺省＝真 stdin / stdout。 */
  readonly stdin?: NodeJS.ReadStream | undefined
  readonly stdout?: NodeJS.WriteStream | undefined
}

/** 挂上终端之后的把手。 */
export type TuiHandle = {
  /** 等外壳收摊（用户退出 / Ctrl+C）。 */
  waitUntilExit(): Promise<void>
}

export async function runTui(options: RunTuiOptions): Promise<TuiHandle> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout

  // **不是终端就说人话**（Ink 在非 TTY 上抛 raw mode 的栈——用户看不懂，也不是他的错）
  if (stdin.isTTY !== true) {
    throw new Error('外壳需要一个终端（stdin 不是 TTY）——请在终端里启动。')
  }

  const shell = createShell(options.transport)

  const app = render(h(TuiApp, { shell }), {
    stdin,
    stdout,
    // ⚠️ **不接管整屏**（第 21 轮 · 渲染模型＝内联）：内容写进终端主缓冲 ⇒
    // 滚轮滚终端自己的 scrollback ✓ · 原生拖选复制 ✓ ——两个都免费。
    // 代价（用户已认下）：输入框不钉底、resize 不重排已滚出的历史、退出后内容留在终端。
    // 也不捕获鼠标（Ink 默认不捕获；`usePaste` 开的是 bracketed paste `?2004h`，
    // 那是**粘贴**不是鼠标上报——拖选照旧可用）。
    alternateScreen: false,
    // Ctrl+C 由外壳判（空闲退出 / 工作中中断）
    exitOnCtrlC: false,
  })

  try {
    // **先接订阅（构造即订阅）、后放开输入**——中间这一跳是启动流转
    await options.boot?.()
    // 接续 / 恢复之后读一次历史：记录区按条目**重建**（缺陷 D1）
    shell.readHistory()
  } catch (error) {
    app.unmount()
    shell.dispose()
    throw error
  }

  return {
    waitUntilExit: async () => {
      await app.waitUntilExit()
      shell.dispose()
    },
  }
}
