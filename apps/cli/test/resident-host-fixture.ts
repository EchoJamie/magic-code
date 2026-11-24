/** 隔离 Engine；测试入口关闭不拥有其寿命，夹具结束时显式停止。 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { hostDiscoveryPath } from '@magic/host'
import { engineCall, type EngineCall } from '@magic/host'
import { readEngineState } from '@magic/host'
import { softwareSource } from '@magic/host'
import type { Sandbox } from './ui/sandbox.ts'

export async function startResidentHost(sandbox: Sandbox, evidence = join(sandbox.root, `engine-check-${crypto.randomUUID()}`), cli = join(import.meta.dir, '../../engine/src/engine.ts')) {
  const discoveryPath = hostDiscoveryPath(sandbox.home)
  mkdirSync(evidence, { recursive: true })
  const input: EngineCall = { action: 'status', home: sandbox.home, parent: sandbox.env.MAGIC_HOME ?? sandbox.home,
    source: softwareSource(), discovery: discoveryPath }
  const child = Bun.spawn([process.execPath, cli, 'serve', '--home', input.home, '--parent', input.parent,
    '--source', input.source, '--discovery', discoveryPath, '--lifecycle', crypto.randomUUID()], {
      cwd: sandbox.workspace, env: sandbox.env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
    })
  const errors = new Response(child.stderr).text()
  let closed = false
  const gone = () => child.exitCode !== null || child.signalCode !== null
  const close = async (how: 'shutdown' | 'signal' = 'shutdown') => {
    if (closed) return
    closed = true
    const alreadyGone = gone()
    let failure: unknown
    try {
      const found = readEngineState(discoveryPath)
      if (found) {
        if (!alreadyGone && how === 'signal') child.kill('SIGTERM')
        else {
          const result = await engineCall({ ...input, action: alreadyGone ? 'reclaim' : 'stop', request: 'fixture-close', expected: found })
          if (result.state !== 'stopped') throw new Error(result.error ?? '隔离 Engine 收尾未确认')
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([child.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('隔离 Engine 未退出')), 15000) })]) }
      finally { clearTimeout(timer) }
      if (!alreadyGone && (child.exitCode !== 0 || readEngineState(discoveryPath)?.state !== 'stopped')) throw new Error('隔离 Engine 未确认停止')
    } catch (error) { failure = error; throw error }
    finally {
      if (!gone()) { child.kill('SIGKILL'); await child.exited }
      const diagnostic = await errors
      // 测试断言及 UI 装置的读数，跟随调用者的临时运行目录统一清理。
      writeFileSync(join(evidence, 'host.json'), JSON.stringify({ pid: child.pid, code: child.exitCode, signal: child.signalCode,
        alreadyGone, state: readEngineState(discoveryPath), ...(failure === undefined ? {} : { error: String(failure) }) }))
      writeFileSync(join(evidence, 'host.stderr.log'), diagnostic)
    }
  }
  try {
    const deadline = Date.now() + 5000
    let discovery = readEngineState(discoveryPath)
    while ((!discovery || discovery.state === 'starting' || discovery.pid !== child.pid) && !gone() && Date.now() < deadline) {
      await Bun.sleep(10); discovery = readEngineState(discoveryPath)
    }
    if (discovery?.state !== 'ready' || discovery.pid !== child.pid) throw new Error(`隔离 Engine 未就绪：${JSON.stringify(discovery)}`)
    const logs = join(discovery.base, 'logs')
    // 进程隔离后执行者日志以**子进程自己的 pid**命名（进程内时代与引擎同 pid）——
    // 数「本宿主起来之后新增的执行者日志」：宿主复用同一数据目录时，只数增量。
    const knownAtStart = new Set(readdirSync(logs))
    return { pid: child.pid, discovery, evidence, close,
      executorStarts: () => readdirSync(logs).filter(name => name.startsWith('executor-') && !knownAtStart.has(name)).reduce((sum, name) =>
        sum + readFileSync(join(logs, name), 'utf8').split('\n').filter(line => line.includes('"event":"executor.started"')).length, 0),
    }
  } catch (error) { try { await close() } catch {} throw error }
}
