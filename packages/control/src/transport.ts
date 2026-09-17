/**
 * 传输 —— 控制域的**换插缝**（技术方案 · 领域划分：实验面「传输（同进程 / IPC / WS）」）。
 *
 * 一条传输＝两端配对：**外壳侧一端**（契约 `ControlTransport`）与**内核侧一端**
 * （`ControlHub.attach` 所收）。首站＝同进程直连（本文件）；跨进程（第二站）与
 * 跨设备（第三站）接同一对接口——两端各换各的实现，`ControlHub` 与外壳都不动。
 *
 * 两端的动作同名同理——**「往对端送」与「收对端来的」**，只是载荷方向相反：
 *
 * | 端 | `send` | `subscribe` |
 * | --- | --- | --- |
 * | 外壳侧 | 发命令（外壳 → 内核） | 收事件（内核 → 外壳） |
 * | 内核侧 | 出事件（内核 → 外壳） | 收命令（外壳 → 内核） |
 *
 * ⚠️ 契约只写了**外壳侧**一端的形状（`ControlTransport`）；内核侧与之镜像，契约未给此形态
 * ——按并行规约 4「只增不改 · 随回报备案」由本域自定（M03 回报 · 待决 1）。
 */

import type { Command, ControlTransport, KernelEvent } from '@magic/contracts'
import { createControlChannel } from './channel.ts'
import type { Unsubscribe } from './channel.ts'

export type { Unsubscribe }

/**
 * 内核侧传输——`ControlHub.attach` 收的一端。
 *
 * 换传输（第二站跨进程）：本端实现成**桥**即可——`send` 把事件写到对端，
 * `subscribe` 把对端来信喂进内核；`ControlHub` 一字不动。
 */
export type KernelTransport = {
  /** 内核 → 外壳：推一条事件。 */
  readonly send: (event: KernelEvent) => void
  /** 外壳 → 内核：收命令；返回退订。 */
  readonly subscribe: (handler: (command: Command) => void) => Unsubscribe
}

/** 同进程传输对——两端配对。 */
export type InProcessTransportPair = {
  /** 内核侧一端——交给 `ControlHub.attach`。 */
  readonly kernel: KernelTransport
  /** 外壳侧一端——交给外壳（U09 / U11）。 */
  readonly shell: ControlTransport
}

/**
 * 建一对同进程传输（首站）——两端经一条控制面通道直连。
 *
 * 直连＝无线程、无 socket、不建常驻服务；消息仍走**可序列化协议**（投递前校验，
 * 见 `channel.ts`）——「即便同进程也不走内部直调」（技术方案 · 接入）。
 */
export function createInProcessTransportPair(): InProcessTransportPair {
  const channel = createControlChannel()

  return {
    kernel: {
      send: (event) => {
        channel.publish(event)
      },
      subscribe: (handler) => channel.onCommand(handler),
    },
    shell: {
      send: (command) => {
        channel.send(command)
      },
      subscribe: (listener) => channel.subscribe(listener),
    },
  }
}
