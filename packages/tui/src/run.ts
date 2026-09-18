/**
 * 外壳 · 启动（缺陷轮 II 重画）——把一屏挂上终端。
 *
 * **全屏 ＋ 备用屏**（原型 · 交互逻辑：铺满窗口，resize 整体重绘）：
 * - Ink 原生支持 `alternateScreen` —— 接管整屏、退出时**原样还给终端**；
 * - `useWindowSize` 在 resize 时让组件重渲染，尺寸一变，记录区可视行数 / 抽屉上限 /
 *   状态行两段**全部按新尺寸重算**（那是纯函数，见 `components/app.ts`）。
 *
 * **代价如实记**：接管整屏＝终端自身的滚动历史没了（备用屏没有回滚），
 * 滚动归我们——记录区自己管视口（只渲染视口内的行，见 `components/log.ts`）。
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
    // 铺满窗口：接管整屏（退出即还）
    alternateScreen: true,
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
