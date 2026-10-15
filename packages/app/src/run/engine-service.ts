import { closeSync, constants, openSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { type HostDiscovery, type ServiceIdentity } from '@magic/contracts'
import { componentDirectory, privateDirectory, selectedParent, writePrivateJSON } from '../components.ts'
import { engineCall, type EngineResult } from './engine-call.ts'
import { fingerprintOf, normalizeDataDir } from './paths.ts'
import { runtimeLaunch, softwareSource } from './runtime-launch.ts'

export type ServiceAction = 'status' | 'start' | 'stop' | 'switch' | 'remove'
export type ServiceOptions = {
  readonly home: string
  readonly parent?: string
  readonly base?: string
  readonly request?: string
  readonly expected?: ServiceIdentity
}
export type PlatformCommand = (args: readonly string[]) => Promise<number>
const launchctl: PlatformCommand = async args => Bun.spawn(['/bin/launchctl', ...args], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exited

export function serviceLabel(home: string): string {
  return `com.magiccode.engine.${fingerprintOf(normalizeDataDir(home))}`
}

/** macOS open(O_EXLOCK) 与原生 flock 同一把内核锁；进程退出自动释放。 */
export async function acquireServiceLock(home: string): Promise<() => void> {
  if (process.platform !== 'darwin') throw new Error('本机服务管理目前支持 macOS 用户登录会话')
  const directory = join(componentDirectory(home), 'runtime')
  privateDirectory(directory)
  for (;;) {
    try {
      // sys/fcntl.h: O_EXLOCK = 0x20。Node 未导出此 macOS 标志，open 原样传给内核。
      const fd = openSync(join(directory, 'host.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x20, 0o600)
      return () => closeSync(fd)
    } catch (error) {
      if (!['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await Bun.sleep(25)
    }
  }
}

/** 独立 Engine 的本机管理；所有客户端沿同一入口串行启动、停止和切换。 */
export async function controlService(action: ServiceAction, options: ServiceOptions, command: PlatformCommand = launchctl, legacy?: { source: string; parent: string; label: string }): Promise<EngineResult> {
  if (!isAbsolute(options.home) || (options.parent !== undefined && !isAbsolute(options.parent)) || (options.base !== undefined && !isAbsolute(options.base))) throw new Error('Engine 控制路径必须是绝对路径')
  if (legacy && action !== 'remove') throw new Error('旧安装转换只能停止并移除原任务')
  if (action === 'switch' && !options.parent) throw new Error('切换需要明确的基础路径')
  const home = normalizeDataDir(options.home), source = legacy?.source ?? softwareSource()
  const directory = join(componentDirectory(home), 'runtime'), discovery = join(directory, 'host.json'), plist = join(directory, 'engine.plist')
  const label = legacy?.label ?? serviceLabel(home), domain = `gui/${process.getuid!()}`, target = `${domain}/${label}`
  const request = options.request ?? crypto.randomUUID()
  let parent = legacy?.parent ?? selectedParent(home)
  function checkBase() {
    if (options.base !== undefined && normalizeDataDir(options.base) !== normalizeDataDir(join(parent, '.magic'))) throw new Error('终端指定的数据实例与当前选择不一致，未执行 Engine 控制')
  }
  function call(operation: 'status' | 'prepare' | 'stop' | 'reclaim' | 'fail-start', record?: HostDiscovery, extra: { lifecycle?: string; idleOnly?: boolean; error?: string } = {}) {
    return engineCall({ action: operation, home, parent, source, discovery, request, ...extra,
      expected: options.expected ?? record, systemTaskRemoved: operation === 'reclaim' }, source)
  }
  async function bootout() {
    const code = await command(['bootout', target])
    if (code !== 0 && code !== 3) throw new Error(`无法移除 Engine 系统任务（launchctl ${code}）`)
  }
  async function stop(current: EngineResult, idleOnly: boolean): Promise<EngineResult> {
    const record = current.record
    if (!record) { await bootout(); return current }
    let result = current
    if (current.alive === true && current.state !== 'unreachable') {
      result = await call('stop', record, { idleOnly })
      if (result.state === 'failed') return result
    }
    if (idleOnly && result.state !== 'stopped') throw new Error('原 Engine 失联，无法核实空闲；请先明确停止 Engine')
    await bootout()
    if (result.state !== 'stopped') {
      const deadline = Date.now() + 10_000
      for (;;) {
        const status = await call('status', record)
        if (status.alive === false || (status.record?.pid === undefined && status.state === 'starting')) break
        if (Date.now() > deadline) throw new Error('系统任务已移除，但原 Engine 退出尚未确认')
        await Bun.sleep(50)
      }
      result = await call('reclaim', record)
    }
    return result
  }
  async function start(): Promise<EngineResult> {
    let current = await call('status')
    const pendingUntil = Date.now() + 20_000
    while (current.state === 'starting' && Date.now() < pendingUntil) { await Bun.sleep(50); current = await call('status') }
    if (current.state === 'ready') return current
    if (current.alive !== false) throw new Error(current.error ?? '旧 Engine 未确认停止，请先明确停止')
    await bootout()
    const lifecycle = crypto.randomUUID()
    await call('prepare', undefined, { lifecycle })
    const logs = join(parent, '.magic/logs'), startup = join(logs, 'manager-startup.jsonl')
    privateDirectory(logs)
    try { if (statSync(startup).size >= 10 * 1024 * 1024) writeFileSync(startup, '', { mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; writeFileSync(startup, '', { mode: 0o600, flag: 'wx' }) }
    const args = [...runtimeLaunch(), 'serve', '--home', home, '--parent', parent, '--source', source, '--discovery', discovery, '--lifecycle', lifecycle]
    const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
    const definition = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>WorkingDirectory</key><string>${xml(home)}</string><key>StandardOutPath</key><string>${xml(startup)}</string><key>StandardErrorPath</key><string>${xml(startup)}</string></dict></plist>`
    writeFileSync(plist, definition, { mode: 0o600 })
    const code = await command(['bootstrap', domain, plist])
    if (code !== 0) return call('fail-start', undefined, { lifecycle, error: `系统拒绝启动 Engine（launchctl ${code}），请检查该任务的系统允许状态` })
    const deadline = Date.now() + 20_000
    do {
      current = await call('status')
      if (current.state === 'ready' || current.state === 'failed') return current
      await Bun.sleep(50)
    } while (Date.now() < deadline)
    throw new Error('Engine 启动尚未就绪')
  }
  checkBase()
  if (action === 'status') return call('status')
  const release = await acquireServiceLock(home)
  try {
    parent = legacy?.parent ?? selectedParent(home); checkBase()
    if (action === 'start') return await start()
    const current = await call('status')
    const wasRunning = current.state === 'ready' || current.state === 'stopping'
    const stopped = await stop(current, action === 'switch' && current.state !== 'stopped' && current.state !== 'failed')
    if (stopped.state !== 'stopped') return stopped
    if (action === 'switch') {
      if (!options.parent) throw new Error('切换需要明确的基础路径')
      parent = normalizeDataDir(options.parent)
      writePrivateJSON(join(componentDirectory(home), 'engine.json'), { parent })
      rmSync(discovery, { force: true }); rmSync(plist, { force: true })
      if (!wasRunning) return call('status')
      try { return await start() } catch (error) { return { state: 'failed', base: join(parent, '.magic'), error: String(error) } }
    }
    if (action === 'remove') { rmSync(plist, { force: true }); rmSync(discovery, { force: true }) }
    return stopped
  } finally { release() }
}
