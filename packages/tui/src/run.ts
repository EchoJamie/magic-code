/**
 * 外壳 · 启动（U09）——把外壳挂上终端。
 *
 * 装配纪律的落点：**先接订阅、后放开输入**——`createShell` 构造即订阅，订阅之后才
 * `render`（渲染出来输入框才可打）。反过来的话，早发的命令会被内核**丢弃**
 * （控制域语义：无订阅方不排队、不补发）。
 *
 * Ink 的 `exitOnCtrlC` 关掉——**Ctrl+C 语义归外壳**（空闲退出 / 工作中中断）。
 */

import { render } from 'ink'
import { createElement as h } from 'react'
import type { ControlTransport } from '@magic/contracts'
import { TuiApp } from './components/app.ts'
import type { Shell } from './shell.ts'
import { createShell } from './shell.ts'

export type RunTuiOptions = {
  /** **外壳侧一端——装配注入**（技术方案 · 领域划分：`ControlTransport` 外壳侧）。 */
  readonly transport: ControlTransport
  /** 输入流（缺省 `process.stdin`；测试可注入）。 */
  readonly stdin?: NodeJS.ReadStream
  /** 输出流（缺省 `process.stdout`）。 */
  readonly stdout?: NodeJS.WriteStream
}

export type TuiHandle = {
  readonly shell: Shell
  /** 等退出（用户空闲时 Ctrl+C，或装配侧收摊）；退出后自动退订。 */
  waitUntilExit(): Promise<void>
  /** 主动收摊。 */
  unmount(): void
}

export function runTui(options: RunTuiOptions): TuiHandle {
  const stdin = options.stdin ?? process.stdin

  // 不是终端就直说——Ink 会抛 raw mode 的栈（「Raw mode is not supported…」），用户看不懂。
  // 交互与 Ctrl+C 都靠终端；管道输入不是本阶段的形态。
  if (stdin.isTTY !== true) {
    throw new Error('外壳需要一个终端（stdin 不是 TTY）——请在终端里启动。')
  }

  const shell = createShell(options.transport)

  const instance = render(h(TuiApp, { shell }), {
    stdin,
    stdout: options.stdout ?? process.stdout,
    exitOnCtrlC: false,
  })

  const unmount = (): void => {
    instance.unmount()
    shell.dispose()
  }

  return {
    shell,
    waitUntilExit: async () => {
      await instance.waitUntilExit()
      shell.dispose()
    },
    unmount,
  }
}
