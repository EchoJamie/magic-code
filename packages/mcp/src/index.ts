/**
 * `@magic/mcp` —— **MCP 客户端适配器**（U38）。
 *
 * 出处：首批功能建设 ·「MCP 外部工具」；交互约束 ·「MCP 查询、审批与失败恢复」。
 * 本包**不是域**：它实现契约里的连接端口（`McpConnection`），把客户端藏在适配器之后。
 * 依赖纪律与各域同一条：**只依赖 `@magic/contracts`** ＋ 官方 SDK
 * （`test/scaffold.test.ts` 的两张表里都登了记）。
 *
 * ## 协议与 SDK 的版本关系（领取时核对，2026-09-21）
 *
 * - **设计所引规范**：`modelcontextprotocol.io/specification/2026-07-28`（本轮实际读过
 *   transports / stdio 两页）。这一版是**「按请求带元数据」的现代修订版**：连接不再需要
 *   `initialize` 握手，协议版本走每条请求 `_meta`；旧版（握手式）由规范的
 *   「Backward Compatibility」一节给兼容矩阵与探测规则。
 * - **官方 SDK**：`@modelcontextprotocol/sdk@1.30.0`（npm `latest`，发布日 2026-07-27
 *   ——**比上述规范修订版早一天**）。它实现的仍是**握手式**那一代：
 *   `LATEST_PROTOCOL_VERSION = '2025-11-25'`、缺省协商 `2025-03-26`。
 * - **故本包按 SDK 支持的那一代接**（设计原话：「按 MCP 传输规范与**实现时官方 SDK 的
 *   支持版本**核对，不手写协议栈」）——**不自己实现 2026-07-28 那一套**：
 *   手写协议栈正是本单明令不做的事，而它的现代修订版要等官方 SDK 跟上（见回报）。
 *   版本这一条不影响本单的验收面：发现 / 审批 / 调用 / 结果 / 取消 / 关闭六件在两个
 *   修订版里是同一条链（传输只换了元数据的带法），U39 接 HTTP 时照同一处核对即可。
 *
 * ## 对外三件
 *
 * ① `createMcpServers`（编排：起手 · 等落定 · 释放）· ② `McpServers` 形态 ·
 * ③ 两条实现级常量（连接 / 调用上限——装配可覆盖，用例不必真等两分钟）。
 *
 * **不出去的**：SDK 的类型与实例 · 传输细节 · 编解码 · 装配与工具域的接线
 * （工具定义在 `@magic/tools` 的 `defineMcpTools` 里合成——本包只管「连接」这一件事）。
 */

import type { McpConnection, McpServerConfig } from '@magic/contracts'
import { createStdioConnection } from './stdio.ts'

/**
 * 一束连接——**生命周期的那三件**（起手 / 等落定 / 释放）。
 *
 * 「应用层管理连接生命周期」落在这一处：装配造它、等它、收它；工具域只看见
 * `connections` 里那几条端口。**U39 的查询与管理**（`/mcp` 那一屏、显式重连）
 * 也接在这一束上（状态在每条连接的 `state` 里，不必另造一本账）。
 */
export type McpServers = {
  /** 按配置顺序（键序）——**身份就是这里的顺序与名字**。 */
  readonly connections: readonly McpConnection[]
  /**
   * **等发现落定**——全部连接走完「起手 → 发现」，各自有界（`connectTimeoutMs`）。
   *
   * 「首轮模型请求前完成发现」就是这一跳：等过它，工具表才是最终的那一份；
   * 失败的那几条落成 `unavailable`（报缘由，**不拖垮内置工具**）。
   */
  ready(): Promise<void>
  /** 释放**本进程创建**的每个子进程与资源（幂等；不碰用户自己的服务）。 */
  shutdown(): Promise<void>
}

export type McpServersOptions = {
  /** 配置里的那一段（`mcp.servers`）——**一个条目一条连接**；空＝一条都没有。 */
  readonly servers: Readonly<Record<string, McpServerConfig>>
  /** 连接 / 发现的上限（毫秒）——缺省 `MCP_CONNECT_TIMEOUT_MS`。 */
  readonly connectTimeoutMs?: number
  /** 一次调用的上限（毫秒）——缺省 `MCP_CALL_TIMEOUT_MS`。 */
  readonly callTimeoutMs?: number
}

/**
 * 按配置造一束连接并**当场起手**（不等它——等落定请 `ready()`）。
 *
 * 起手与等待分开，是照着装配那一步的形状来：装配是**同步**的（造各域、接线），
 * 而连服务器是**异步**的。于是「先起手、再在起手该落定的那一处等」——
 * 起手那几跳并行跑，等的时候一次收齐。
 */
export function createMcpServers(options: McpServersOptions): McpServers {
  const connections = Object.entries(options.servers).map(([server, config]) =>
    createStdioConnection({
      server,
      config,
      ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
      ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
    }),
  )

  // 起手那一趟**当场发车**（不 await）——`ready()` 收它们的落定；`start()` 自己不抛
  const starting = connections.map((connection) => connection.start())

  return {
    connections,
    ready: async () => {
      await Promise.all(starting)
    },
    shutdown: async () => {
      await Promise.all(connections.map((connection) => connection.close()))
    },
  }
}

export { MCP_CALL_TIMEOUT_MS, MCP_CONNECT_TIMEOUT_MS } from './stdio.ts'
