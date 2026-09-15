/**
 * 控制面通道 —— **命令进 · 事件出**（技术方案 · 接入：控制面与外壳）。
 *
 * 形态——类型化接口 + 事件订阅；首站同进程直连（本文件即直连实现：无线程、无 socket、
 * 不建常驻服务）。**即便同进程也走此协议**（不走内部直调）——壳只经此处碰内核，
 * 内核只经此处被碰；换壳（第二站多形态）与换传输（跨设备）都不动两侧代码。
 *
 * 方向与持有者：
 * - 外壳（U09 起）——`send` 发命令 · `subscribe` 收事件；
 * - 内核（主循环 U04 · 权限 U07）——`onCommand` 收命令 · `publish` 出事件。
 *
 * 纪律：
 * - **消息是纯数据**——`send` / `publish` 投递前经 `assertSerializable` 校验（见 `serializable.ts`），
 *   不是纯数据就抛，**不投递**；
 * - 消息形态**不在本目录另立**——`Command` / `KernelEvent` 以契约（`../contracts/control.ts`）为准；
 * - 订阅方抛错照常上抛（不吞——吞错掩盖缺陷）；投递按订阅快照，投递中的增退订不影响本轮。
 */

import type { Command, KernelEvent } from '../contracts/index.ts'
import { assertSerializable } from './serializable.ts'

/** 内核侧命令订阅方（主循环）——收命令，不返回值。 */
export type CommandHandler = (command: Command) => void

/** 外壳侧事件订阅方（渲染 / 观测）——收事件，不返回值。 */
export type KernelEventListener = (event: KernelEvent) => void

/** 退订——重复调用无害。 */
export type Unsubscribe = () => void

/**
 * 控制面通道——两个方向，各一组订阅方。
 *
 * 无订阅方时消息**丢弃**（Emitter 语义，不抛、不排队）：装配（U11）须先接订阅方
 * 再开放输入——命令通道空转＝用户输入无声丢失，故不排队、不假装收下。
 */
export type ControlChannel = {
  /** 外壳 → 内核：发一条命令（`input.submit` / `decision.answer` / `turn.interrupt`）。 */
  readonly send: (command: Command) => void
  /** 内核 → 外壳：推一条事件给全部订阅方。 */
  readonly publish: (event: KernelEvent) => void
  /** 内核侧：订阅命令（主循环）。 */
  readonly onCommand: (handler: CommandHandler) => Unsubscribe
  /** 外壳侧：订阅事件（渲染 / 观测）。 */
  readonly subscribe: (listener: KernelEventListener) => Unsubscribe
}

/**
 * 建一条控制面通道——首站＝同进程直连。
 *
 * 第二站换传输（跨进程桥接）时替换本实现即可：桥接侧订阅 `publish` 往对端送、
 * 把对端来信喂回 `send`，两侧的接口与消息一字不动。
 */
export function createControlChannel(): ControlChannel {
  const handlers = new Set<CommandHandler>()
  const listeners = new Set<KernelEventListener>()

  return {
    send(command) {
      assertSerializable(command, '命令')
      // 快照：投递期间的退订 / 新订阅不改本轮受众
      for (const handler of [...handlers]) handler(command)
    },
    publish(event) {
      assertSerializable(event, '事件')
      for (const listener of [...listeners]) listener(event)
    },
    onCommand(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
