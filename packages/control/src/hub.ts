/**
 * `ControlHub` —— 控制域端口（技术方案 · 领域划分：装配 → 控制域，外壳经传输接入）。
 *
 * 域的两个动作：
 * - **`bind(routes)`**——装命令路由：`input.submit` / `turn.interrupt` → 对话域；
 *   `decision.answer` → 权限域（技术方案 · 装配视图 4）；
 * - **`attach(transport)`**——接传输：内核侧一端接上后，命令自传输进来、事件自传输出去。
 *
 * 另有一处**广播入口 `emit`**——装配的 `EventSink` 扇出把事件送到此处（装配视图 4：
 * 「控制广播全部」）。用契约 `EventSink` 的动词，不另立名字。
 *
 * 纪律（技术方案 · 领域划分 · 控制域）：
 * - **无订阅方时命令丢弃**（Emitter 语义，不抛、不排队）——装配须**先接订阅、后放开输入**；
 * - **裁决配对＝请求事件 id**——答复按 `decision.answer.id` 原样路由给权限域，域内不解释
 *   （`call` 是另一 id 空间，见契约 `ids.ts` 头注）；
 * - 消息经传输投递，**可序列化校验在传输那侧**（投递前逐条，违者拒投并点名路径）。
 */

import type { Command, CommandRoutes, KernelEvent } from '@magic/contracts'
import type { KernelTransport, Unsubscribe } from './transport.ts'

/**
 * 控制域公开面——端口两动作 ＋ 广播入口。
 *
 * ⚠️ **`attach` 的入参是内核侧传输**（`KernelTransport`）。契约 `ControlHub` 把入参写成
 * `ControlTransport`（**外壳侧**形状：`send` 发命令 / `subscribe` 收事件）；内核侧与之镜像
 * （`send` 出事件 / `subscribe` 收命令），契约未给此形态——本域按规约 4 自定，见回报待决 1。
 * 域的两个动作名与语义与端口一字不差，只有这一个入参形态待规划侧锚定。
 */
export type ControlHubFace = {
  /** 命令 → 各域（契约 `ControlHub.bind`）。 */
  bind(routes: CommandRoutes): void
  /** 接传输（契约 `ControlHub.attach`）。 */
  attach(transport: KernelTransport): void
  /** 广播入口（契约 `EventSink`）——装配扇出把事件送到此处，再推给传输的对端。 */
  emit(event: KernelEvent): void
}

/**
 * 造一个控制域实例（首站：单活跃——技术方案 · 领域划分末句）。
 *
 * 装配顺序（装配视图 5）：**先 `bind` 路由、再 `attach` 传输、最后才放开输入**——
 * 反了就是用户输入无声丢失（丢弃语义不排队，见文件头注）。
 */
export function createControlHub(): ControlHubFace {
  let routes: CommandRoutes | undefined
  let link: { readonly transport: KernelTransport; readonly off: Unsubscribe } | undefined

  /** 命令 → 路由——未装路由＝丢弃（与无订阅方同一条纪律：不排队、不假装收下）。 */
  const route = (command: Command): void => {
    const target = routes
    if (target === undefined) return

    switch (command.type) {
      case 'input.submit':
        target.onInput(command)
        return
      case 'turn.interrupt':
        target.onInterrupt()
        return
      case 'decision.answer':
        // 配对键＝请求事件 id，原样交给权限域——此处不解释、不改写
        target.onDecision(command.id, command.decision)
        return
    }
  }

  return {
    bind(next) {
      routes = next
    },
    attach(transport) {
      link?.off() // 二次接入＝换传输：先摘旧的，不留两条链路
      link = { transport, off: transport.subscribe(route) }
    },
    emit(event) {
      // 未接传输＝丢弃（Emitter 语义）；投递前的可序列化校验在传输那侧
      link?.transport.send(event)
    },
  }
}
