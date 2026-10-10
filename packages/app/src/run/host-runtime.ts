import { NATIVE_PROTOCOL, SOFTWARE_VERSION, resolveMagicHome, type HostDiscovery } from '@magic/contracts'
import { startTimeOf } from '@magic/execution'
import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'
import { loadConfig } from '../config.ts'
import { runPathsOf } from './paths.ts'
import { createAgentLauncher } from './launch.ts'
import { startManager } from './manager.ts'
import { softwareSource } from './runtime-launch.ts'
import { writeEngineState } from './engine-state.ts'

/** launchd 直接托管；stdin/图形客户端关闭不参与 Engine 寿命。 */
export async function runEngine(argv: readonly string[]): Promise<number> {
  const value = (name: string): string => {
    const at = argv.indexOf(name), found = at < 0 ? undefined : argv[at + 1]
    if (!found) throw new Error(`缺少启动参数 ${name}`)
    return found
  }
  const home = value('--home'), parent = value('--parent'), app = value('--app'), discovery = value('--discovery'), source = value('--source'), lifecycle = value('--lifecycle')
  if (![home, parent, app, discovery, source].every(isAbsolute) || source !== softwareSource()) throw new Error('Engine 启动身份不匹配')
  const magic = resolveMagicHome({ MAGIC_HOME: parent }, home)
  const paths = runPathsOf(magic, tmpdir())
  let state: HostDiscovery = {
    protocol: NATIVE_PROTOCOL, version: SOFTWARE_VERSION, source, serviceInstance: crypto.randomUUID(),
    base: magic.base, socket: paths.socket, app, lifecycle, state: 'starting', pid: process.pid, startedAt: await startTimeOf(process.pid),
  }
  const publish = () => writeEngineState(discovery, state)
  publish()
  try {
    const loaded = loadConfig({ magic })
    const started = await startManager({
      paths, magic, launch: createAgentLauncher(), mcp: loaded.config.mcp?.servers ?? {},
      engineState: async (phase, request, error) => { state = { ...state, state: phase, request, error }; publish() },
      beforeExit: async () => { state = { ...state, state: 'stopped', error: undefined }; publish() },
      onShutdownError: error => { state = { ...state, state: 'failed', error }; publish() },
    })
    if (started.role !== 'manager') throw new Error(started.role === 'existing' ? '所选实例已有 Engine，未覆盖它' : started.reason)
    state = { ...state, ...started.manager.identity, state: 'ready' }; publish()
    const stop = () => { state = { ...state, state: 'stopping' }; publish(); started.manager.stop('系统会话结束') }
    process.on('SIGTERM', stop); process.on('SIGINT', stop)
    await started.manager.waitUntilExit()
    process.off('SIGTERM', stop); process.off('SIGINT', stop)
    return 0
  } catch (error) {
    // 可识别的配置/公共资源错误不触发 launchd 异常恢复循环。
    state = { ...state, state: 'failed', error: error instanceof Error ? error.message : String(error) }; publish()
    return 0
  }
}
