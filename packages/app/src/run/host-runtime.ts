import { diagnosticsOf, decodeNativeMessage, type Diagnostics } from '@magic/contracts'
import { parseDiagnosticsArgs, saveDiagnostics } from '../diagnostics.ts'
import { fstatSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { resolveMagicHome } from '@magic/contracts'
import type { HostResponse } from '@magic/contracts'
import { loadConfig, type LoadedConfig } from '../config.ts'
import { runPathsOf } from './paths.ts'
import { createProcessLauncher } from './launch.ts'
import { startManager } from './manager.ts'

/** 仅 App / 明确的隔离测试宿主调用；专用继承管道 EOF 决定服务寿命。 */
export async function runHostedManager(argv: readonly string[]): Promise<number> {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(name)
    return at < 0 ? undefined : argv[at + 1]
  }
  const hostInstance = value('--host-instance')
  const app = value('--app')
  const send = (message: HostResponse): void => { process.stdout.write(`${JSON.stringify(message)}\n`) }
  if (!hostInstance || !app || !(fstatSync(0).isFIFO() || fstatSync(0).isSocket())) {
    send({ t: 'host.error', reason: '核心须由 App 的专用生命管道启动' })
    return 1
  }
  const selected = resolveMagicHome(process.env, homedir())
  const magic = { ...selected, base: resolve(selected.base) }
  let loaded: LoadedConfig
  try {
    loaded = loadConfig({ magic })
    const change = parseDiagnosticsArgs(argv)
    if (change) { saveDiagnostics(magic, change, loaded.stamp ?? null); loaded = loadConfig({ magic }) }
  } catch (error) {
    send({ t: 'host.error', reason: error instanceof Error ? error.message : String(error) })
    return 1
  }
  const paths = runPathsOf(magic, tmpdir())
  let hostGone = false
  let shutdown: (() => void) | undefined
  let request: string | undefined
  const input = createInterface({ input: process.stdin })
  const pending = new Map<string, { resolve(): void; reject(): void }>()
  const diagnosticsChanged = (value: Diagnostics): Promise<void> => new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('App 未确认')) }, 5_000)
    pending.set(id, { resolve: () => { clearTimeout(timer); resolve() }, reject: () => { clearTimeout(timer); reject(new Error('App 未确认')) } })
    send({ t: 'host.diagnostics', request: id, value, base: magic.base })
  })
  input.on('close', () => { hostGone = true; for (const reply of pending.values()) reply.reject(); pending.clear(); shutdown?.() })
  input.on('line', (line) => {
    try {
      const message = decodeNativeMessage(JSON.parse(line))
      if (message?.t === 'host.diagnostics.applied') { const reply = pending.get(message.request); pending.delete(message.request); if (message.error) reply?.reject(); else reply?.resolve(); return }
      if (!message) return
      if (message.t !== 'host.shutdown' || typeof message.request !== 'string') return
      request = message.request
      shutdown?.()
    } catch { send({ t: 'host.error', reason: '宿主命令不可读' }) }
  })
  void diagnosticsChanged(diagnosticsOf(loaded.config)).catch(() => {})
  const started = await startManager({
    diagnosticsChanged,
    paths, magic, hostInstance,
    launch: createProcessLauncher({ stderr: 'inherit' }),
    mcp: loaded.config.mcp?.servers ?? {},
    log: (line) => process.stderr.write(`[${hostInstance}] ${line}\n`),
    onShutdownError: (reason) => send({ t: 'host.error', reason }),
  })
  if (started.role !== 'manager') {
    input.close()
    send({ t: 'host.error', reason: started.role === 'existing' ? '该数据位置已有服务，请先退出原 App' : started.reason })
    return 1
  }
  const manager = started.manager
  shutdown = () => manager.stop(hostGone ? 'App 生命连接已关闭' : '退出 Magic Code')
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, shutdown)
  if (hostGone || request !== undefined) shutdown()
  else {
    await manager.ready()
    if (!hostGone && request === undefined) send({ t: 'host.ready', identity: manager.identity, socket: paths.socket, base: magic.base, config: loaded.path })
  }
  await manager.waitUntilExit()
  send({ t: 'host.stopped', ...(request === undefined ? {} : { request }) })
  input.close()
  return 0
}
