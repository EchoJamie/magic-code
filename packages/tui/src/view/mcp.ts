import type { EventDataOf } from '@magic/contracts'
import { sanitizeForDisplay } from '@magic/contracts'
import type { PickerRow } from '../view.ts'

/**
 * **`/mcp` 的行** —— 一台服务器一行（**与 `/grants` · `/skills` 同位置同开合**）。
 *
 * 一件要紧的事：行**保证只占一行**（`oneLine`）——`meta` 里是状态与件数，由渲染层按列宽
 * 截断；高度账按一行一条数（见 `PickerRow.oneLine`）。**不可用的缘由不放这儿**：
 * 它可能很长，放 `meta` 就折行、账就少了（那正是矮终端上真光标错位的老账）——放 `hint`。
 */
export function mcpRows(catalog: McpCatalog): readonly PickerRow[] {
  return catalog.servers.map((server) => ({
    label: server.server,
    // **状态打头**：窄窗 + 长名字时，行会被截（`oneLine`），先丢的必须是接入方式与件数
    // ——「这条可用不可用」是这一屏的全部意义，不能被一个长名字挤没（`keep` 再保一道）
    meta: `${mcpStateLabel(server)} · ${server.transport}` + mcpToolCount(server),
    current: false,
    value: server.server,
    oneLine: true,
    keep: mcpStateLabel(server),
  }))
}

/**
 * **一台服务器的明细行** —— 工具名各占一行（`/mcp <名字>` 看的那一屏）。
 *
 * 只报得出名字：读数里就这几格（契约 `McpCatalogRow`），说明与参数不在这一屏的取材里。
 */
export function mcpToolRows(catalog: McpCatalog, who: string): readonly PickerRow[] {

  const found = catalog.servers.find((server) => server.server === who)
  if (found === undefined) return []
  return found.tools.map((tool) => ({
    label: tool,
    meta: '',
    current: false,
    value: tool,
    oneLine: true,
  }))
}

/**
 * 抽屉下方那行说明——**总览**（不给 `who`）与**一台的明细**（给了 `who`）两用。
 *
 * 两条共用的分寸：
 * - **不可用就说缘由**（「某个服务失联时能看出哪条连接不可用」）：总览里逐台一行，
 *   明细则并进那一行状态；
 * - **拒收的那些要说出来**（名字不合规 / 重名）——它们是「服务器报了，我们没用」，
 *   不说就等于让用户对着一个不生效的工具发呆。名字是服务器自报的原文，
 *   **上屏前先洗控制字节**（`sanitizeForDisplay`）。
 */
export function mcpHint(catalog: McpCatalog, who?: string): string {
  if (who !== undefined) return mcpServerHint(catalog, who)
  if (catalog.servers.length === 0) {
    return '还没有配外部工具服务器——配置里写 mcp.servers 才连（工作区里的 .mcp.json 不算授权）'
  }
  const lines = catalog.servers
    .filter((server) => server.state.status === 'unavailable')
    .map((server) => `${server.server}：${server.state.status === 'unavailable' ? server.state.reason : ''}`)
  lines.push('/mcp <名字> 看那一台的工具与错误')
  return lines.join('\n')
}

/** 一台的明细那行说明——身份 ＋ 状态/缘由 ＋ 拒收的那些。 */
function mcpServerHint(catalog: McpCatalog, who: string): string {

  const found = catalog.servers.find((server) => server.server === who)
  if (found === undefined) {
    return `没有配这一台：「${sanitizeForDisplay(who)}」——配置里 mcp.servers 的条目名才是身份`
  }
  const lines = [`${found.server}（${found.transport}）· ${mcpStateLabel(found)}${mcpToolCount(found)}`]
  // **不可用时把那一句缘由摆出来**：`/mcp <服务器>` 正是设计给的「看工具/**错误**」入口
  // （总览那一屏也报，但点进这一台时不该反而看不到）
  if (found.state.status === 'unavailable') lines.push(found.state.reason)
  for (const one of found.rejected) {
    lines.push(`没收下「${sanitizeForDisplay(one.tool)}」——${one.reason}`)
  }
  return lines.join('\n')
}

/** 状态那一格——**连接中 / 可用 / 不可用**（不可用时缘由交给 `hint`）。 */
function mcpStateLabel(server: McpCatalog['servers'][number]): string {
  switch (server.state.status) {
    case 'idle':
      return '未连接'
    case 'connecting':
      return '还在连'
    case 'available':
      return '可用'
    default:
      return '不可用'
  }
}

/** 件数那一截——**只有连上了才报**（没连上时报 0 件是假账）。 */
function mcpToolCount(server: McpCatalog['servers'][number]): string {
  return server.state.status === 'available' ? ` · ${server.tools.length} 件工具` : ''
}

export type McpCatalog = EventDataOf['mcp.catalog']
