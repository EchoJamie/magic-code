/**
 * stdio 连接 —— **客户端封在适配器后**。
 *
 * 本文件是「藏」的那一层：官方 SDK 的类型**一件都不出去**，外面只看得到契约里的
 * `McpConnection`。发现 / 调用 / 结果 / 状态与释放的规矩全在 `connection.ts`（两种传输
 * 共用的一条链），这里只有 stdio 自己的那三件：怎么拉一条自有进程组的传输、起不来的缘由
 * 怎么说、它自己没了怎么说。
 *
 * 四条与进程有关的规矩：
 * 1. **stderr 不外泄**——规范允许客户端忽略服务器的 stderr；而本进程正跑着全屏 TUI，
 *    子进程往 stderr 写一行就能把屏面搅乱。故固定 `stderr: 'ignore'`。
 * 2. **环境不外溢**——SDK 的默认环境只带 PATH / HOME 一类，配置里 `env` 的那些**追加**
 *    在它之上。用户自己的凭据不因为「起了一个 MCP 服务器」就跟着过去。
 * 3. **关闭照规范的次序，且按组收**——关 stdin → 等 → 组 TERM → 等 → 组 KILL；
 *    归属在启动那一刻定死（`stdio-transport.ts`）。
 * 4. **起手有界**——连不上 / 不应答的服务器不能把启动拖住（`MCP_CONNECT_TIMEOUT_MS`）。
 */

import type { McpConnection, McpStdioConfig } from '@magic/contracts'
import { createConnection } from './connection.ts'
import type { OwnedTransport } from './connection.ts'
import { createOwnedStdioTransport } from './stdio-transport.ts'

/** 它自己走了的那句缘由（我们放了手是另一句，见 `connection.ts` 的 `RELEASED`）。 */
const SERVER_GONE = '服务器退出了'

export type StdioConnectionOptions = {
  readonly server: string
  readonly config: McpStdioConfig
  readonly connectTimeoutMs?: number
  readonly callTimeoutMs?: number
}

/** stdio 连接——端口 ＋ 起手（**启动那一步归编排者调**，端口本身不含它）。 */
export interface StdioConnection extends McpConnection {
  start(): Promise<void>
}

/** 造一条 stdio 连接——**造了不等于连了**（`start()` 才拉进程）。 */
export function createStdioConnection(options: StdioConnectionOptions): StdioConnection {
  const config = options.config

  return createConnection({
    server: options.server,
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
    driver: {
      kind: 'stdio',
      // 自己 spawn、自成进程组：归属在启动那一刻定死，收尾按组收（见 `stdio-transport.ts`）
      open: (): OwnedTransport =>
        createOwnedStdioTransport({
          command: config.command,
          ...(config.args === undefined ? {} : { args: [...config.args] }),
          ...(config.env === undefined ? {} : { env: { ...config.env } }),
        }),
      startupReason: (error) => startupReason(error, config.command),
      goneReason: SERVER_GONE,
    },
  })
}

/**
 * **起不来**那句缘由——**说人话**（这一句会上屏：开屏回执与 `--check` 都读它）。
 *
 * 拉不起一个进程时，Node 抛的是 `ENOENT: no such file or directory, posix_spawn '…'`
 * ——那是给写代码的人看的。而这一类失败恰恰是 MCP 最常见的配置事故：命令写错、包里没装。
 * 故按 errno 译一句「哪条命令、怎么不对」——用户要改的就是那一条命令。
 * 认不出的错误照原样带出（不编）：那种情形下原委就是唯一的线索。
 */
function startupReason(error: unknown, command: string): string {
  const code = (error as { readonly code?: unknown } | null)?.code

  if (code === 'ENOENT') return `找不到可执行文件「${command}」（命令写错了，还是没装？）`
  if (code === 'EACCES') return `没有执行权限「${command}」`

  return error instanceof Error ? error.message : String(error)
}
