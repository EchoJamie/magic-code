import type { DiagnosticsChange } from '@magic/contracts'
import { applyHostDiagnostics } from './diagnostics-client.ts'
/** CLI 只连接 App 所属服务；仅用户主动打开/重开时可以通过 LaunchServices 打开 App。 */
import type { HostDiscovery, MagicHome } from '@magic/contracts'
import type { LoadedConfig } from '../config.ts'
import { connectManager, executionEnvironment, type ConnectOptions, type ManagerClient } from './client.ts'
import { locateHost, readHostDiscovery, selectedHostConfig, type HostLocationOptions } from './host-discovery.ts'
import { normalizeDataDir } from './paths.ts'

export type AppConnectionOptions = HostLocationOptions & {
  readonly diagnostics?: DiagnosticsChange

  /** 缺省是被动观察，绝不打开 App。 */
  readonly intent?: 'observe' | 'open'
  /** 留屏重连须仍属原数据实例；在发送 hello/session 之前核对。 */
  readonly expectedInstance?: Pick<HostDiscovery, 'base' | 'dataDir'>
  readonly connect?: ConnectOptions
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
  /** 隔离测试收集启动动作；生产使用 /usr/bin/open 的参数数组。 */
  readonly openApplication?: (app: string) => Promise<void>
}

export type AppConnection = {
  readonly client: ManagerClient
  readonly discovery: HostDiscovery
  readonly magic: MagicHome
  readonly loaded: LoadedConfig
}

export async function openApplication(app: string): Promise<void> {
  const child = Bun.spawn(['/usr/bin/open', app], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  })
  const errors = new Response(child.stderr).text()
  const timer = setTimeout(() => child.kill(), 5_000)
  try {
    const code = await child.exited
    if (code !== 0) throw new Error(`无法打开 App ${app}：${(await errors).trim() || `open 退出码 ${code}`}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function connectApp(options: AppConnectionOptions = {}): Promise<AppConnection> {
  const location = locateHost(options)
  const active = options.intent === 'open'
  const env = options.env ?? process.env
  const cwd = options.connect?.cwd ?? process.cwd()
  const timeoutMs = options.timeoutMs ?? 8_000
  const deadline = Date.now() + timeoutMs
  let reason = `App 尚未发布就绪记录：${location.discoveryPath}`

  const attempt = async (): Promise<AppConnection | undefined> => {
    const discovery = readHostDiscovery(location)
    if (discovery === undefined) return undefined
    if (options.expectedInstance !== undefined &&
      (normalizeDataDir(discovery.base) !== normalizeDataDir(options.expectedInstance.base) ||
        normalizeDataDir(discovery.dataDir) !== normalizeDataDir(options.expectedInstance.dataDir))) {
      throw new Error(`App 数据实例已改变：原基础目录 ${options.expectedInstance.base}，数据 ${options.expectedInstance.dataDir}；当前基础目录 ${discovery.base}，数据 ${discovery.dataDir}。请在 App 设置切回原实例再重开`)
    }
    const selected = selectedHostConfig(discovery, { home: location.home, cwd, env })
    const client = await connectManager(discovery.socket, {
      ...options.connect,
      expectedIdentity: discovery,
      environment: active ? executionEnvironment(env) : undefined,
      timeoutMs: Math.max(1, Math.min(options.connect?.timeoutMs ?? timeoutMs, deadline - Date.now())),
    })
    if (client === undefined) {
      reason = `App 发现记录已过期或服务不可达：${discovery.socket}`
      return undefined
    }
    if (options.diagnostics) {
      try { const note = await applyHostDiagnostics(discovery, options.diagnostics); process.stderr.write(`${note}\n`) } catch (error) { client.close(); throw error }
    }
    return { client, discovery, ...selected }
  }

  const existing = await attempt()
  if (existing !== undefined) return existing
  if (!active) throw new Error(`${reason}；被动连接不会打开 Magic Code`)
  if (location.app === undefined) {
    throw new Error(`${reason}；源码模式请先显式启动同来源的原生 App 宿主`)
  }

  await (options.openApplication ?? openApplication)(location.app)
  do {
    const connected = await attempt()
    if (connected !== undefined) return connected
    await Bun.sleep(Math.min(25, Math.max(0, deadline - Date.now())))
  } while (Date.now() < deadline)
  throw new Error(`已请求打开 ${location.app}，但未能在 ${timeoutMs}ms 内连接就绪服务：${reason}`)
}

/** 供后续 TUI“重新打开 Magic Code”明确动作调用；自动重连仍调用 connectApp 的缺省观察模式。 */
export function reopenApp(options: Omit<AppConnectionOptions, 'intent'> = {}): Promise<AppConnection> {
  return connectApp({ ...options, intent: 'open' })
}
