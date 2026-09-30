import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveMagicHome } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { startTimeOf } from '@magic/execution'
import { startManager, type ExecutorRequest } from '../src/run/manager.ts'
import { connectManager } from '../src/run/client.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { linkOf, socketHandlers } from '../src/run/wire.ts'

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 6_000
  while (!check() && Date.now() < deadline) await Bun.sleep(5)
  expect(check()).toBe(true)
}

test('socket先断、执行者真退出、自有组最后回收：只有全部确证才回done', async () => {
  const root = mkdtempSync(join(tmpdir(), 'resident-reclaim-order-'))
  const magic = resolveMagicHome({}, root)
  const dataDir = join(root, 'data')
  const paths = runPathsOf(magic, dataDir, tmpdir())
  const store = createRecordsStore({ dataDir, workspace: [root] })
  store.setSessionTitle('ordered', '退出次序', 1)
  const trace: unknown[] = []
  let request: ExecutorRequest | undefined
  let ready = false
  let child: Bun.Subprocess<'ignore', 'pipe', 'ignore'> | undefined
  let exited = false
  let terminated = false
  const exitCallbacks: (() => void)[] = []
  const owned = Bun.spawn([process.execPath, '-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], {
    detached: true, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', cwd: root,
  })
  const ownedReader = owned.stdout.getReader()
  await ownedReader.read(); ownedReader.releaseLock()
  const startedAt = startTimeOf(owned.pid)
  if (startedAt === undefined) throw new Error('自有组身份不可读')
  const started = await startManager({ paths, dataDir, magic, stopGraceMs: 500, stopKillMs: 500,
    launch: { spawn(input) {
      request = input
      ready = false; exited = false; terminated = false
      const process = child = Bun.spawn([Bun.argv[0]!, '-e', "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150)); console.log('ready'); setInterval(()=>{},1000)"], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', cwd: root,
      })
      const reader = process.stdout.getReader()
      void reader.read().then(() => { ready = true; reader.releaseLock() })
      return { pid: process.pid,
        onExit(callback) { exitCallbacks.push(() => callback('上一代的重复退出回调')); void process.exited.then(() => {
          exited = true; trace.push({ event: 'executor.exit', at: performance.now(), pid: process.pid, ownedAlive: alive(owned.pid) })
          callback('真实执行者正常退出')
        }) },
        kill(signal = 'SIGTERM') { terminated = true; process.kill(signal) },
      }
    } },
  })
  if (started.role !== 'manager') throw new Error('启动失败')
  const manager = started.manager
  const client = await connectManager(paths.socket, { session: 'ordered' })
  if (client === undefined) throw new Error('连接失败')
  let wire: ReturnType<typeof linkOf> | undefined
  let done = false
  const evidence = join(mkdtempSync(join(tmpdir(), 'resident-reclaim-evidence-')), 'order.json')
  client.onStopped((report) => {
    const physical = { executorAlive: child !== undefined && alive(child.pid), ownedAlive: alive(owned.pid), exited }
    trace.push({ event: 'stop.report', at: performance.now(), ...report, ...physical })
    if (report.phase === 'done') {
      expect(physical).toEqual({ executorAlive: false, ownedAlive: false, exited: true })
      done = true
    }
  })
  try {
    client.send({ type: 'input.submit', text: '本轮受控输入' })
    await until(() => request !== undefined && ready)
    wire = linkOf(await Bun.connect({ unix: paths.socket, socket: socketHandlers() }))
    wire.onMessage((message) => {
      if (message.t !== 'bye') return
      trace.push({ event: 'socket.close', at: performance.now(), pid: child!.pid, executorAlive: alive(child!.pid) })
      wire!.close()
    })
    wire.send({ t: 'hello', role: 'executor', token: request!.token, session: 'ordered', workspace: [root] })
    wire.send({ t: 'bound', session: 'ordered' }); wire.send({ t: 'ready' })
    wire.send({ t: 'owned', processes: [{ pgid: owned.pid, startedAt, kind: 'background', what: 'exec:test-owned' }], background: 1 })
    await until(() => manager.runs().some((run) => run.background === 1))
    client.stop('ordered', 'run')
    await until(() => terminated || manager.executors().length === 0)
    expect(exited).toBe(false)
    expect(alive(child!.pid)).toBe(true)
    expect(done).toBe(false)
    expect(manager.executors().some((run) => run.gen === request!.gen)).toBe(true)
    await until(() => done)
    expect(await child!.exited).toBe(0)
    expect(await owned.exited).toBe(137)
    expect(owned.signalCode).toBe('SIGKILL')

    // 同 session 继续工作已换执行者代次；旧代再次报退出不能完成本代的停止。
    const firstGen = request!.gen
    done = false
    client.send({ type: 'input.submit', text: '下一代受控输入' })
    await until(() => request!.gen !== firstGen && ready)
    const secondGen = request!.gen
    wire = linkOf(await Bun.connect({ unix: paths.socket, socket: socketHandlers() }))
    let bound = false
    wire.onMessage((message) => {
      if (message.t === 'cmd') bound = true
      if (message.t === 'bye') wire!.close()
    })
    wire.send({ t: 'hello', role: 'executor', token: request!.token, session: 'ordered', workspace: [root] })
    wire.send({ t: 'bound', session: 'ordered' }); wire.send({ t: 'ready' })
    await until(() => bound)
    client.stop('ordered', 'run')
    await until(() => terminated)
    exitCallbacks[0]!()
    expect(exited).toBe(false)
    expect(done).toBe(false)
    expect(alive(child!.pid)).toBe(true)
    expect(manager.executors().some((run) => run.gen === secondGen)).toBe(true)
    await until(() => done)
    expect(await child!.exited).toBe(0)
  } finally {
    if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    if (owned.exitCode === null) { owned.kill('SIGKILL'); await owned.exited }
    client.close(); wire?.close(); manager.stop('测试收尾'); await manager.waitUntilExit()
    writeFileSync(evidence, JSON.stringify({ executorGen: request?.gen, trace }, null, 2))
    console.log(`核销次序证据：${evidence}`)
    store.close(); rmSync(root, { recursive: true, force: true })
  }
}, 10_000)
