import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { NATIVE_PROTOCOL, SOFTWARE_VERSION, resolveMagicHome, type DiagnosticsChange, type HostDiscovery, type MagicHome } from '@magic/contracts'
import { applyHostDiagnostics } from './diagnostics-client.ts'
import type { LoadedConfig } from '../config.ts'
import { connectManager, executionEnvironment, type ConnectOptions, type ManagerClient } from './client.ts'
import { locateHost, readHostDiscovery, selectedHostConfig, type HostLocationOptions } from './host-discovery.ts'
import { normalizeDataDir } from './paths.ts'
import type { EngineResult } from './engine-call.ts'

export type AppConnectionOptions = Omit<HostLocationOptions, 'home'> & { readonly home?: string } & {
  readonly diagnostics?: DiagnosticsChange
  readonly intent?: 'observe' | 'open'
  readonly expectedInstance?: Pick<HostDiscovery, 'base'>
  readonly connect?: ConnectOptions
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
  readonly control?: (action: 'status' | 'start' | 'stop') => Promise<EngineResult>
}
export type AppConnection = { readonly client: ManagerClient; readonly discovery: HostDiscovery; readonly magic: MagicHome; readonly loaded: LoadedConfig }

/** 同包原生短入口，绝不通过 LaunchServices 打开图形 App。 */
export async function controlEngine(action: 'status' | 'start' | 'stop', options: HostLocationOptions & { readonly env?: Readonly<Record<string, string | undefined>>; readonly cwd?: string }): Promise<EngineResult> {
  const location = locateHost(options)
  if (!location.app) throw new Error('源码入口须明确指定同来源的原生包，才能操作当前登录会话的 Engine')
  const plist = Bun.spawnSync(['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleExecutable', join(location.app, 'Contents/Info.plist')], { stdout: 'pipe', stderr: 'pipe' })
  const name = plist.stdout.toString().trim()
  if (plist.exitCode !== 0 || !name || name.includes('/')) throw new Error('所属 App 的平台入口无效')
  const env = options.env ?? process.env
  const requestedBase = env.MAGIC_HOME?.trim() ? resolveMagicHome({ ...env, MAGIC_HOME: resolve(options.cwd ?? process.cwd(), env.MAGIC_HOME.trim()) }, location.home).base : undefined
  const args = [join(location.app, 'Contents/MacOS', name), '--internal-engine-control', action, '--request', crypto.randomUUID()]
  if (requestedBase) args.push('--base', requestedBase)
  if (location.home !== homedir()) args.push('--validation-root', location.home)
  // 明确停止一经发起便独立收尾；关闭发起终端不能把短控制进程一并挂断。
  const child = Bun.spawn(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true })
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text()
  const code = await child.exited
  const result = JSON.parse(await output) as EngineResult
  if (code !== 0) throw new Error(result.error ?? (await errors).trim() ?? 'Engine 控制失败')
  return result
}
export async function connectApp(options: AppConnectionOptions = {}): Promise<AppConnection> {
  const location = locateHost({ ...options, home: options.home ?? homedir() })
  const control = options.control ?? (action => controlEngine(action, { ...options, home: location.home }))
  const env = options.env ?? process.env, cwd = options.connect?.cwd ?? process.cwd()
  const attach = async (discovery: HostDiscovery): Promise<AppConnection | undefined> => {
    if (options.expectedInstance && normalizeDataDir(options.expectedInstance.base) !== normalizeDataDir(discovery.base)) throw new Error('数据实例已改变，请明确切回原实例后重连')
    const config = selectedHostConfig(discovery, { home: location.home, cwd, env })
    const client = await connectManager(discovery.socket, { ...options.connect, expectedIdentity: discovery,
      environment: executionEnvironment(env), timeoutMs: options.timeoutMs ?? 1500 })
    if (!client) return undefined
    if (options.diagnostics) {
      try { process.stderr.write(`${await applyHostDiagnostics(discovery, options.diagnostics, 'cli', location.home, env)}\n`) }
      catch (error) { client.close(); throw error }
    }
    return { client, discovery, ...config }
  }
  const found = readHostDiscovery(location)
  if (found) {
    const existing = await attach(found)
    if (existing) return existing
  }
  const selected = await control('status')
  const explicit = env.MAGIC_HOME?.trim() ? resolveMagicHome({ ...env, MAGIC_HOME: resolve(cwd, env.MAGIC_HOME.trim()) }, location.home).base : undefined
  if (explicit !== undefined && normalizeDataDir(explicit) !== normalizeDataDir(selected.base)) throw new Error(`数据实例不匹配：终端=${explicit}；当前选择=${selected.base}`)
  if (options.expectedInstance && normalizeDataDir(options.expectedInstance.base) !== normalizeDataDir(selected.base)) throw new Error('数据实例已改变，请明确切回原实例后重连')
  const current = selected.state === 'ready' || options.intent !== 'open' ? selected : await control('start')
  const discovery = current.record
  if (current.state !== 'ready' || !discovery) throw new Error(current.error ?? `Magic Engine ${current.state}；刷新与重连不会启动它`)
  if (discovery.protocol !== NATIVE_PROTOCOL || discovery.version !== SOFTWARE_VERSION) throw new Error('Engine 版本不匹配')
  const connected = await attach(discovery)
  if (!connected) throw new Error('Magic Engine 控制连接不可达')
  return connected
}
export function reopenApp(options: Omit<AppConnectionOptions, 'intent'> = {}): Promise<AppConnection> {
  return connectApp({ ...options, intent: 'open' })
}
