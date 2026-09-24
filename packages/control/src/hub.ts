/**
 * `ControlHub` —— 控制域端口（技术方案 · 领域划分：装配 → 控制域，外壳经传输接入）。
 *
 * 域的两个动作：
 * - **`bind(routes)`**——装命令路由：`input.submit` / `turn.interrupt` → 对话域；
 *   `decision.answer` → 权限域；`model.switch` → 装配（注册表，技术方案 · 装配视图 4）；
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
 * - **裁决配对＝请求事件 id**——答复按 `decision.answer.id` 原样路由给权限域，域内不解释
 *   （`call` 是另一 id 空间，见契约 `ids.ts` 头注）；答复的**加宽位**（`remember`）同样原样
 *   转手——本域**不做翻译**，「总是允许」的落地（**工作区级授权** · U22）归权限域；
 * - 消息经传输投递，**可序列化校验在传输那侧**（投递前逐条，违者拒投并点名路径）。
 */

import type {
  Command,
  CommandRoutes,
  KernelEvent,
  KernelTransport,
} from '@magic/contracts'
import type { Unsubscribe } from './transport.ts'

/**
 * 控制域公开面——端口两动作 ＋ 广播入口。
 *
 * 三个成员的形态**皆取自契约**：`bind` 入参 `CommandRoutes` · `attach` 入参
 * `KernelTransport`（端口内类型）· `emit` 事件 `KernelEvent`；`emit` 即 `EventSink.emit`。
 * 本域面与契约两个端口（`ControlHub` / `EventSink`）的相容由测试的类型探针钉住。
 */
export type ControlHubFace = {
  /** 命令 → 各域（契约 `ControlHub.bind`）。 */
  bind(routes: CommandRoutes): void
  /** 接**内核侧**一端（契约 `ControlHub.attach`）。 */
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
        // 配对键＝请求事件 id，原样交给权限域——此处不解释、不改写。
        // `remember`（「总是允许」）也**原样转手**：它是答复上的位，翻译归权限域
        // （控制域翻一道＝两处各有一套语义，迟早分叉）。
        target.onDecision(command.id, command.decision, { remember: command.remember })
        return
      case 'model.switch':
        // 换模型——原样转手给装配（它握着注册表）。本域**不知道换得成换不成**：
        // 「切不动就不动」的判别式处置归装配，路由只负责把话带到（同 `onDecision` 的姿势）。
        target.onModelSwitch({ provider: command.provider, model: command.model })
        return
      case 'session.list':
      case 'session.new':
      case 'session.open':
      case 'session.rename':
        // 会话四支——原样转手给**对话域**（它才是会话的持有者）。
        // 本域不认识会话、也不知道开得成开不成，与 `model.switch` 同一姿势。
        target.onSession(command)
        return
      case 'history.read':
        // 读侧命令——**原样转手**给对话域（会话与条目归它）。答复走事件（`session.history`）
        // ——命令面只发不收，本域也不读条目（它够不着记录域，这正是读面走控制面的由头）。
        target.onHistoryRead(command.session)
        return
      case 'model.list':
        // 模型条目表（读侧）——**原样转手**给**装配**（注册表在它手上）。本域不认识注册表、
        // 也不知道有哪些条目；答复走事件（`model.catalog`，不落库）——命令面只发不收。
        target.onModelList()
        return
      case 'grants.list':
        // 授权名录（读侧）——**原样转手**给**装配**（`grants.json` 的读写都在它那一层，
      // 域不碰文件系统）。本域不认识授权，答复走事件（`grants.catalog`，不落库）。
        target.onGrantsList()
        return
      case 'skills.list':
        // 技能目录（读侧 · U33）——**原样转手**给**装配**（执行域的发现面在它手里，
        // 同 `model.list` 之于注册表）。本域不认识技能，答复走事件
        // （`skills.catalog`，不落库）——命令面只发不收。
        target.onSkillList()
        return
      case 'paths.list':
        // 路径候选（读侧 · U36）——**原样转手**给**装配**（执行域的路径面在它手里，
        // 同 `skills.list`）。本域不认识文件系统，答复走事件（`paths.catalog`，不落库）。
        target.onPathList(command.query)
        return
      case 'paths.identify':
        // 认一认选定的那一条（U62 · 图片的名字）——同一条路（执行域的路径面在装配手里）。
        // 本域不认识文件系统，**也不判里外**：`external` 是用户选定那一刻的事实，
        // 原样带过去（同 `decision.answer` 的 `remember` 之例：控制域只带话，不翻译）。
        // 答复走事件（`paths.identified`，不落库）。
        target.onPathIdentify(command.path, command.external)
        return
      case 'attachments.list':
        // 本会话送出的图片（读侧 · U37）——**原样转手**给**对话域**（条目与那份载荷形态
        // 归它，同 `history.read` 的站位）。答复走事件（`attachments.catalog`，不落库）：
        // 命令面只发不收。
        target.onAttachmentList()
        return
      case 'attachments.export':
        // 导出原图（U37）——同一条路（记录里那份字节归对话域读，落盘那一步它经装配注入的
        // 写口完成）。**不在这里解释 `entry`**：记录位置就是身份，本域不认识记录。
        target.onAttachmentExport(command.entry)
        return
      case 'mcp.list':
        // 外部服务器的一屏（读侧 · U39）——**原样转手**给**装配**（那一束连接是它编排的，
        // 同 `model.list` 之于注册表）。本域不认识 MCP，答复走事件（`mcp.catalog`，不落库）。
        target.onMcpList()
        return
      case 'mcp.reconnect':
        // 显式重连——同一条路（连接归装配）。**不在这里判服务器名认不认得**：
        // 名字是配置里的身份，只有装配那份配置说了算（同 `grants.revoke` 的缺省之例）。
        target.onMcpReconnect(command.server)
        return
      case 'grants.revoke':
        // 撤销——同一条路（落盘归装配）。**不在这里解释 `workspace` / `index` 的缺省**：
        // 「缺省＝本工作区」「缺省＝整节」是**授权落点**的语义，归装配那一侧（同 `decision.answer`
        // 的 `remember` 之例：控制域只带话，不翻译）。
        target.onGrantsRevoke(command.workspace, command.index)
        return
      case 'model.refresh':
        // 显式刷新模型信息（U41）——**原样转手**给**装配**（模型信息缓存与在途获取在它那一层，
        // 同 `model.list` 之于注册表）。缺省那条连接由装配按「当下选中」解释，本域不猜。
        target.onModelRefresh(command.provider)
        return
      case 'model.default.set':
        // 设为默认（U41）——写**配置里的默认选择**（与 `model.switch` 改当下那一件分开）。
        // 控制域只带话：校验与落盘都在装配（同 `decision.answer` 的站位）。
        target.onModelDefaultSet(command)
        return
      case 'provider.list':
        // 管理面的连接一览（U41 读侧）——**归装配**（配置与凭据的读取都在它那一层，
        // 同 `grants.list` 之于授权文件）。答复走事件（`provider.catalog`，不落库）。
        target.onProviderList()
        return
      case 'provider.save':
        // 接入 / 改名 / 更新认证 / 改地址共一个动作（U41）——落盘归装配。
        // **凭据不在这里留痕**：只带话（同 `input.submit` 的姿势）。
        target.onProviderSave(command)
        return
      case 'provider.remove':
        target.onProviderRemove(command.provider)
        return
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
      link = { transport, off: transport.subscribe(route) }
    },
    emit(event) {
      // 未接传输＝丢弃（Emitter 语义）；投递前的可序列化校验在传输那侧
      link?.transport.send(event)
    },
  }
}
