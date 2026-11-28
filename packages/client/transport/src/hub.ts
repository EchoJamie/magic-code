/**
 * `ControlHub` —— 控制域端口（技术方案 · 领域划分：装配 → 控制域，外壳经传输接入）。
 *
 * 域的两个动作：
 * - **`bind(routes)`**——装命令路由：`input.submit` / `turn.interrupt` → 对话域；
 *   `model.switch` → 装配（注册表，技术方案 · 装配视图 4）；
 *   `session.*` 四支 → 对话域（会话的持有者——本域只是把话带到）；
 *   `history.read`（读侧）→ 对话域，答复走 `session.history` 事件；
 * - **`attach(transport)`**——接传输：接**内核侧一端**（契约 `KernelTransport`）后，
 *   命令自传输进来、事件自传输出去。外壳侧一端（`ControlTransport`）由外壳自持。
 *
 * 另有一处**广播入口 `emit`**——装配的 `EventSink` 扇出把事件送到此处（装配视图 4：
 * 「控制广播全部」）。用契约 `EventSink` 的动词，不另立名字。
 *
 * 纪律（技术方案 · 领域划分 · 控制域）：
 * - **无订阅方时命令丢弃**（Emitter 语义，不抛、不排队）——装配须**先接订阅、后放开输入**；
 * - 消息经传输投递，**可序列化校验在传输那侧**（投递前逐条，违者拒投并点名路径）。
 */

import type {
  Command,
  CommandRoutes,
  KernelEvent,
  KernelTransport,
} from '@magic/contracts'
import type { Unsubscribe } from './transport.ts'

/** 协作命令仍由宿主编排；旧装配可以先只接原有路由。 */
export type ControlRoutes = CommandRoutes & {
  onBackground?(command: Extract<Command, { type: `background.${string}` }>): void | Promise<void>
  onCollaboration?(command: Extract<Command, { type: `collaboration.${string}` }>): void
}

/**
 * 控制域公开面——端口两动作 ＋ 广播入口。
 *
 * 三个成员的形态**皆取自契约**：`bind` 入参 `CommandRoutes` · `attach` 入参
 * `KernelTransport`（端口内类型）· `emit` 事件 `KernelEvent`；`emit` 即 `EventSink.emit`。
 * 本域面与契约两个端口（`ControlHub` / `EventSink`）的相容由测试的类型探针钉住。
 */
export type ControlHubFace = {
  /** 命令 → 各域（契约 `ControlHub.bind`）。 */
  bind(routes: ControlRoutes): void
  /** 接**内核侧**一端（契约 `ControlHub.attach`）。 */
  attach(transport: KernelTransport): void
  /** 广播入口（契约 `EventSink`）——装配扇出把事件送到此处，再推给传输的对端。 */
  emit(event: KernelEvent): void
  shutdown(): Promise<void>
}

/**
 * 造一个控制域实例（首站：单活跃——技术方案 · 领域划分末句）。
 *
 * 装配顺序（装配视图 5）：**先 `bind` 路由、再 `attach` 传输、最后才放开输入**——
 * 反了就是用户输入无声丢失（丢弃语义不排队，见文件头注）。
 */
export function createControlHub(onError?: (error: unknown) => void): ControlHubFace {
  const flights = new Set<Promise<void>>()
  const failures: unknown[] = []
  let closed = false
  let routes: ControlRoutes | undefined
  let link: { readonly transport: KernelTransport; readonly off: Unsubscribe } | undefined

  /** 命令 → 路由——未装路由＝丢弃（与无订阅方同一条纪律：不排队、不假装收下）。 */
  const route = (command: Command): unknown => {
    const target = routes
    if (target === undefined) return

    switch (command.type) {
      case 'session.references':
      case 'memory.read':
      case 'memory.tidy':
      case 'memory.source':
      case 'knowledge.query':
      case 'knowledge.read':
      case 'knowledge.forget':
      case 'knowledge.forget-result':
      case 'compact.request':
      case 'compact.query':
      case 'compact.cancel':
        throw new Error('该操作须经 Magic Engine 的会话控制入口')
      case 'background.list':
      case 'background.stop':
        return target.onBackground?.(command)
      case 'collaboration.read':
      case 'collaboration.input':
      case 'collaboration.stop':
      case 'collaboration.resume':
      case 'collaboration.configure':
      case 'collaboration.receive':
      case 'collaboration.abandon':
        return target.onCollaboration?.(command)
      case 'input.manage':
        return target.onInputManage?.(command)
      case 'input.submit':
        return target.onInput(command)
      case 'turn.interrupt':
        return target.onInterrupt()
      case 'model.switch':
        // 换模型——原样转手给装配（它握着注册表）。本域**不知道换得成换不成**：
        // 「切不动就不动」的判别式处置归装配，路由只负责把话带到（同 `onDecision` 的姿势）。
        { const { type, ...request } = command; return target.onModelSwitch(request) }
      case 'session.list':
      case 'session.new':
      case 'session.open':
      case 'session.archive':
      case 'session.restore':
      case 'session.rename':
        // 会话四支——原样转手给**对话域**（它才是会话的持有者）。
        // 本域不认识会话、也不知道开得成开不成，与 `model.switch` 同一姿势。
        return target.onSession(command)
      case 'history.read':
        // 读侧命令——**原样转手**给对话域（会话与条目归它）。答复走事件（`session.history`）
        // ——命令面只发不收，本域也不读条目（它够不着记录域，这正是读面走控制面的由头）。
        return target.onHistoryRead(command.session)
      case 'plan.read':
        // 当前计划读侧（2026-11-24）——同 `history.read` 的姿势转手给对话域；
        // 答复走事件（`plan.changed`，带 `requestId`），全文、零裁剪。
        return target.onPlanRead?.(command.session, command.requestId)
      case 'model.list':
        // 模型条目表（读侧）——**原样转手**给**装配**（注册表在它手上）。本域不认识注册表、
        // 也不知道有哪些条目；答复走事件（`model.catalog`，不落库）——命令面只发不收。
        return target.onModelList()
      case 'skills.list':
        // 技能目录（读侧 · U33）——**原样转手**给**装配**（执行域的发现面在它手里，
        // 同 `model.list` 之于注册表）。本域不认识技能，答复走事件
        // （`skills.catalog`，不落库）——命令面只发不收。
        return target.onSkillList()
      case 'paths.list':
        // 路径候选（读侧 · U36）——**原样转手**给**装配**（执行域的路径面在它手里，
        // 同 `skills.list`）。本域不认识文件系统，答复走事件（`paths.catalog`，不落库）。
        return target.onPathList(command.query)
      case 'paths.identify':
        // 认一认选定的那一条（U62 · 图片的名字）——同一条路（执行域的路径面在装配手里）。
        // 本域不认识文件系统，**也不判里外**：`external` 是用户选定那一刻的事实，
        // 原样带过去（控制域只带话，不翻译）。
        // 答复走事件（`paths.identified`，不落库）。
        return target.onPathIdentify(command.path, command.external)
      case 'input.paste':
        // 把剪贴板里的图取进来（U107）——同一条路（剪贴板那一跳在装配手里）。
        // 本域不认识剪贴板，也不读字节：**原样转手**，答复走事件（`input.pasted`，不落库）。
        return target.onInputPaste()
      case 'image.export':
        // 导出原图（U110）——**原样转手**给**对话域**（记录里那份字节归它读，落盘那一步
        // 经装配注入的写口完成；同 `attachments.export` 当年的站位）。本域不认识记录、
        // 也读不了字节，答复走事件（`image.exported`，不落库）。
        return target.onImageExport(command.blob, command.name, command.mime)
      case 'mcp.list':
        // 外部服务器的一屏（读侧 · U39）——**原样转手**给**装配**（那一束连接是它编排的，
        // 同 `model.list` 之于注册表）。本域不认识 MCP，答复走事件（`mcp.catalog`，不落库）。
        return target.onMcpList()
      case 'mcp.reconnect':
        // 显式重连——同一条路（连接归装配）。**不在这里判服务器名认不认得**：
        // 名字是配置里的身份，只有装配那份配置说了算（同 `grants.revoke` 的缺省之例）。
        return target.onMcpReconnect(command.server)
      case 'model.refresh':
        // 显式刷新模型信息（U41）——**原样转手**给**装配**（模型信息缓存与在途获取在它那一层，
        // 同 `model.list` 之于注册表）。缺省那条连接由装配按「当下选中」解释，本域不猜。
        return target.onModelRefresh(command.provider)
      case 'models.search':
        // Models.dev 检索（手动对位）——读的是**本地资料**（`<base>/cache/models.dev.json`），
        // 归设置那一侧：外壳在 `terminalSettings` 里**本地处置**（离线设置也一样）。
        // 真从这里进来时如实说，不静默丢弃。
        throw new Error('该操作由设置界面在本地处置')
      case 'model.override':
        return target.onModelOverride(command)
      case 'model.configure':
        return target.onModelConfigure(command)
      case 'web.list':
        // 网页服务读数（U94）——归装配（配置读在它那一层）；答复走 `web.state`。
        return target.onWebList()
      case 'web.configure':
        // 设置 / 清除网页服务引用——控制域只带话，校验与落盘都在装配。
        return target.onWebConfigure(command.provider)
      case 'prefs.set':
        // 界面的两格偏好（U112）——写配置里 `statusLine` / `motion` 那两格。控制域只带话：
        // 校验与落盘都在装配（同 `webfetch.set` 的站位）。
        // ⚠️ **它连一条会话、一件工具都不碰**：改的只是「这一屏长什么样」。
        return target.onPrefsSet(command)
      case 'provider.list':
        // 管理面的连接一览（U41 读侧）——**归装配**（配置与凭据的读取都在它那一层，
        // 同 `model.list` 之于注册表）。答复走事件（`provider.catalog`，不落库）。
        return target.onProviderList()
      case 'provider.save':
        // 接入 / 改名 / 更新认证 / 改地址共一个动作（U41）——落盘归装配。
        // **凭据不在这里留痕**：只带话（同 `input.submit` 的姿势）。
        return target.onProviderSave(command)
      case 'provider.remove':
        return target.onProviderRemove(command.provider)
      default: {
        // **穷尽性**（U41 补）——契约加了命令而这里忘了接，过去是**静默丢弃**：
        // 实测 `model.default.set` 发出去一点回声都没有，用例干等三秒才超时。
        // 这一行让它变成**编译期**的事（加命令时 tsc 当场报）。
        const unhandled: never = command
        void unhandled
        return
      }
    }
  }

  return {
    bind(next) {
      routes = next
    },
    attach(transport) {
      link?.off() // 二次接入＝换传输：先摘旧的，不留两条链路
      link = { transport, off: transport.subscribe(command => {
        if (closed) return
        let flight: Promise<void>
        const failed = (error: unknown): void => {
          try { if (onError) onError(error); else failures.push(error) } catch (reportError) { failures.push(reportError) }
        }
        try { flight = Promise.resolve(route(command)).then(() => undefined, failed) }
        catch (error) { failed(error); return }
        flights.add(flight)
        void flight.then(() => flights.delete(flight))
      }) }
    },
    async shutdown() {
      closed = true
      link?.off()
      await Promise.all([...flights])
      if (failures.length) throw new AggregateError(failures.splice(0), '控制操作失败')
    },
    emit(event) {
      // 未接传输＝丢弃（Emitter 语义）；投递前的可序列化校验在传输那侧
      link?.transport.send(event)
    },
  }
}
