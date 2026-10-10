import { NATIVE_PROTOCOL, SOFTWARE_VERSION, resolveMagicHome, type HostDiscovery, type NativeResponse, type ServiceIdentity } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { engineAlive, readEngineState, writeEngineState } from './engine-state.ts'
import { assertHostIdentity } from './host-discovery.ts'
import { runPathsOf } from './paths.ts'
import { softwareSource } from './runtime-launch.ts'
import { linkOf, socketHandlers } from './wire.ts'
import { readRuns, writeRuns } from './manager.ts'
import { reclaim } from './reclaim.ts'

export type EngineCall = {
  action: 'status' | 'prepare' | 'stop' | 'reclaim' | 'fail-start'
  home: string; parent: string; app: string; source: string; discovery: string
  error?: string; systemTaskRemoved?: boolean; request?: string; lifecycle?: string; expected?: ServiceIdentity; idleOnly?: boolean
}
export type EngineResult = { state: HostDiscovery['state']; base: string; alive?: boolean; record?: HostDiscovery; error?: string }

async function connect(found: HostDiscovery) {
  try {
    const socket = await Bun.connect({ unix: found.socket, socket: socketHandlers() })
    const link = linkOf(socket)
    return await new Promise<{ link: typeof link; accepting: boolean } | undefined>((resolve, reject) => {
      const timer = setTimeout(() => { link.close(); resolve(undefined) }, 1500)
      link.onClose(() => { clearTimeout(timer); resolve(undefined) })
      link.onMessage(message => {
        if (message.t !== 'native.welcome') return
        clearTimeout(timer)
        try { assertHostIdentity(message.identity, found); resolve({ link, accepting: message.projection.accepting }) }
        catch (error) { link.close(); reject(error) }
      })
      link.send({ t: 'hello', role: 'observer', protocol: NATIVE_PROTOCOL, version: SOFTWARE_VERSION, source: found.source, base: found.base })
    })
  } catch { return undefined }
}

/** 同包平台短调用；配置选择已明确，操作不依赖任何图形进程。 */
export async function engineCall(input: EngineCall): Promise<EngineResult> {
  if (!['status', 'prepare', 'stop', 'reclaim', 'fail-start'].includes(input.action) || ![input.home, input.parent, input.app, input.source, input.discovery].every(value => typeof value === 'string' && isAbsolute(value)) || input.source !== softwareSource()) throw new Error('平台控制参数或软件来源无效')
  const magic = resolveMagicHome({ MAGIC_HOME: input.parent }, input.home)
  const found = readEngineState(input.discovery)
  if (input.action === 'fail-start') {
    if (!found || found.lifecycle !== input.lifecycle || found.pid !== undefined || found.state !== 'starting') throw new Error('启动结果代次不匹配')
    const record: HostDiscovery = { ...found, state: 'failed', error: input.error ?? '系统拒绝启动 Engine' }
    writeEngineState(input.discovery, record)
    return { state: 'failed', base: record.base, record, alive: false, error: record.error }
  }
  if (input.action === 'prepare') {
    if (!input.lifecycle || !input.request) throw new Error('缺少启动代次')
    if (found && await engineAlive(found) !== false) throw new Error('旧 Engine 尚未确认停止')
    const record: HostDiscovery = { protocol: NATIVE_PROTOCOL, version: SOFTWARE_VERSION, source: input.source, app: input.app,
      base: magic.base, serviceInstance: input.request, lifecycle: input.lifecycle, state: 'starting', socket: runPathsOf(magic, tmpdir()).socket }
    writeEngineState(input.discovery, record)
    return { state: 'starting', base: magic.base, record }
  }
  if (!found) return { state: 'stopped', base: magic.base, alive: false }
  assertHostIdentity(found, { source: input.source, base: magic.base, ...input.expected })
  const connection = await connect(found)
  const link = connection?.link
  if (input.action === 'status') {
    if (link) { link.close(); return { state: found.state === 'failed' ? 'failed' : connection.accepting ? 'ready' : 'stopping', record: found, base: found.base, alive: true, error: found.error } }
    const alive = await engineAlive(found)
    const state = alive === false && ['stopped', 'failed'].includes(found.state) ? found.state : found.state === 'starting' ? 'starting' : 'unreachable'
    return { state, record: found, base: found.base, ...(alive === undefined ? {} : { alive }), ...(found.error === undefined ? {} : { error: found.error }) }
  }
  if (!input.request || !input.expected) { link?.close(); throw new Error('停止必须携带原 Engine 身份和请求标识') }
  if (found.request === input.request && found.state === 'stopped' && await engineAlive(found) === false) { link?.close(); return { state: 'stopped', record: found, base: found.base, alive: false } }
  if (input.action === 'stop') {
    if (!link) return { state: 'unreachable', record: found, base: found.base, error: 'Engine 不可达，须由平台移除原任务后回收资源' }
    let failure: string | undefined
    link.onMessage(raw => { const message = raw as NativeResponse; if (message.t === 'native.engine.result' && message.request === input.request && message.phase === 'failed') failure = message.error ?? 'Engine 停止失败' })
    link.send({ t: 'native.engine.stop', request: input.request, identity: input.expected, idleOnly: input.idleOnly })
    const deadline = Date.now() + 45_000
    try {
      while (Date.now() < deadline) {
        if (failure) return { state: 'failed', base: found.base, record: found, error: failure }
        const current = readEngineState(input.discovery)
        if (!current || current.serviceInstance !== found.serviceInstance) throw new Error('停止期间 Engine 身份改变')
        if (current.request === input.request) {
          if (current.state === 'failed') return { state: 'failed', base: found.base, record: current, error: current.error }
          if (current.state === 'stopped' && await engineAlive(current) === false) return { state: 'stopped', base: found.base, record: current, alive: false }
        }
        await Bun.sleep(30)
      }
      return { state: 'failed', base: found.base, record: found, error: 'Engine 收尾尚未确认，保留当前停止责任' }
    } finally { link.close() }
  }
  link?.close()
  // 仅在平台 bootout 后调用，仍独立核对原进程已停。
  if (await engineAlive(found) !== false && !(input.systemTaskRemoved && found.pid === undefined && found.state === 'starting')) throw new Error('原 Engine 未确认退出，不能接管资源归属')
  const paths = runPathsOf({ home: input.home, base: found.base }, tmpdir())
  // 有文件却不可读时不能当作没有归属。
  try { const raw = JSON.parse(readFileSync(paths.runs, 'utf8')); if (!Array.isArray(raw.runs)) throw new Error('运行归属记录无效') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const store = createRecordsStore({ dataDir: found.base, workspace: [] })
  const notes: string[] = []
  try {
    store.collaboration.stop({ kind: 'host' }, 'Engine 已停止，等待明确继续', Date.now())
    const runs = [...readRuns(paths)]
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]!, result = await reclaim(run.owned ?? [])
      runs[i] = { ...run, owned: result.remaining, state: 'stopped', kind: 'aborted', why: result.notes.join('；') || 'Engine 已停止' }
      writeRuns(paths, runs, Date.now()); notes.push(...result.notes)
    }
  } finally { store.close() }
  const record: HostDiscovery = { ...found, request: input.request, state: notes.length ? 'failed' : 'stopped', error: notes.length ? notes.join('；') : undefined }
  writeEngineState(input.discovery, record)
  return { state: record.state, base: found.base, record, alive: false, error: record.error }
}
