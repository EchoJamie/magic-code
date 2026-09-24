/**
 * **外部工具预检**（U48 第六段）——**连一遍、报状态、断开**。
 *
 * 设计（MCP 接入 · 服务启动时的预检）：
 *
 * > **它是探针，不是工具连接。** 两件事都叫「连 MCP」，但目的、生命周期、归属都不同。
 * > …**为什么放在服务启动**：MCP 是**外部服务，随时可能不可用**。预检只能在「此刻」
 * > 回答「此刻」的事，**它答不了「对话时还通不通」**。
 *
 * ## 三个「不」
 *
 * - **不为它单起后台**：挂在本机服务（管理者）的启动上——管理者本来就在（第一个窗口
 *   按需把它拉起来）。**不另起执行者、不建会话**，故「空白启动页只有客户端」不受影响。
 * - **不持有工具**：探针**不把工具交给任何人**。它读一下发现的结果（有几件、几件被拒），
 *   报完就断——「这一轮要用哪些工具」是**执行者**的事。
 * - **不供会话使用**：这一条连接与任何会话都没有关系，它的状态也不替执行者那一次背书。
 *
 * 于是「预检通过」**不是**对话那一轮的免死金牌：执行者照旧自己连一次，失败照旧如实
 * 带出（设计明文：「预检通过不能免掉对话时那一次」）。
 *
 * ## 起手那一整套为什么不自己写一遍
 *
 * 用的是**同一束** `createMcpServers`——传输分派、进程组归属、有界超时、拒收判定
 * 全在那一条链上。另写一份「只连不调」的探针，等于把「怎么算连上了」判两遍，
 * 而两处迟早会分叉（一处认的「连上」另一处不认）。
 */

import type { McpServerConfig } from '@magic/contracts'
import { createMcpServers } from '@magic/mcp'
import type { McpProbeRow } from './wire.ts'

export type PreflightOptions = {
  /** 配置里的那一段（`mcp.servers`）——空＝一条都没有（这一跳空转）。 */
  readonly servers: Readonly<Record<string, McpServerConfig>>
  /** 连接 / 发现的上限（毫秒）——缺省＝适配器那个实现级常量。 */
  readonly connectTimeoutMs?: number | undefined
  /** 一次调用的上限（毫秒）——探针**一次都不调**，但它随那一束一起构造。 */
  readonly callTimeoutMs?: number | undefined
  /** 诊断——缺省不打印。 */
  readonly log?: ((line: string) => void) | undefined
}

/**
 * 走一趟预检——**连接 → 报状态 → 断开**。
 *
 * 无论成败都在返回前**断开**（`finally` 里那一跳）：探针的价值是当时那个读数，
 * 不是留着一条连接。失败也**不抛**——外面那一条（管理者启动）不该因为一台外部服务
 * 连不上就起不来：那正是「单连接失败不拖垮内置工具」在这里的形态。
 */
export async function probeMcp(options: PreflightOptions): Promise<readonly McpProbeRow[]> {
  // 一条都没配＝**空转**（不造那一束、不起任何进程）——绝大多数用户是这样
  if (Object.keys(options.servers).length === 0) return []

  const probe = createMcpServers({
    servers: options.servers,
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
  })

  const rows: McpProbeRow[] = []

  try {
    await probe.ready()
    for (const connection of probe.connections) {
      rows.push({
        server: connection.server,
        state: connection.state,
        rejected: connection.rejected.length,
      })
    }
    return rows
  } catch (error) {
    // 走到这儿＝**预检本身**坏了（不是某台连不上——那一条落成 `unavailable` 的读数）。
    // 如实记一句、交回已经读到的那些，不把它变成「管理者起不来」。
    options.log?.(`外部工具预检没跑完：${error instanceof Error ? error.message : String(error)}`)
    return rows
  } finally {
    // **断开**——探针不持有连接（见文件头注）
    try {
      await probe.shutdown()
    } catch {
      // 收尾失败不影响读数：这一束是探针自己的，进程退出时 OS 会收
    }
  }
}
