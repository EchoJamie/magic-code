import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveMagicHome } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { spawnOwned } from '@magic/execution'
import { startManager, type ExecutorRequest } from '../src/run/manager.ts'
import { connectManager } from '../src/run/client.ts'
import { runPathsOf } from '../src/run/paths.ts'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check: () => boolean) {
  const deadline = Date.now() + 6000
  while (!check() && Date.now() < deadline) await Bun.sleep(5)
  expect(check()).toBe(true)
}

test('Agent 取消等待真实完成，工具核销后才回 done，旧代回调不影响后继', async () => {
  const root = mkdtempSync(join(tmpdir(), 'resident-reclaim-order-'))
  const magic = resolveMagicHome({}, root), paths = runPathsOf(magic, tmpdir())
  const store = createRecordsStore({ dataDir: magic.base, workspace: [root] })
  store.setSessionTitle('ordered', '退出次序', 1)
  let request: ExecutorRequest | undefined
  let cancelled = false, exited = false, done = false
  const callbacks: ((reason: string) => void)[] = []
  const started = await startManager({ paths, magic, stopGraceMs: 30, stopKillMs: 30,
    launch: { spawn(input) {
      request = input; cancelled = false; exited = false
      return { onExit(callback) { callbacks.push(callback) }, cancel() { cancelled = true } }
    } },
  })
  if (started.role !== 'manager') throw new Error('启动失败')
  const manager = started.manager
  const client = (await connectManager(paths.socket, { session: 'ordered' }))!
  let tool: Awaited<ReturnType<typeof spawnOwned<'pipe', 'ignore'>>> | undefined
  client.onStopped(report => { if (report.phase === 'done') {
    expect(exited).toBe(true); expect(tool === undefined || !alive(tool.process.pid)).toBe(true); done = true
  } })
  const attach = () => { request!.link.send({ t: 'assembled', session: 'ordered', workspace: [root] }); request!.link.send({ t: 'ready' }) }
  try {
    client.send({ type: 'input.submit', text: '本轮输入' })
    await until(() => request !== undefined)
    attach()
    tool = await spawnOwned([process.execPath, '-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], {
      stdout: 'pipe', stderr: 'ignore', ledger: request!.ledger, kind: 'background', what: '次序测试工具', cwd: root,
    })
    const reader = tool.process.stdout.getReader(); await reader.read(); reader.releaseLock()
    await until(() => manager.runs().some(row => row.background === 1))
    client.stop('ordered', 'run')
    await until(() => cancelled)
    expect(done).toBe(false); expect(alive(tool.process.pid)).toBe(true)
    expect(manager.executors()).toHaveLength(1)
    exited = true; callbacks[0]!('Agent 已完成异步收尾')
    await until(() => done)
    expect(await tool.process.exited).toBe(137)
    expect(JSON.parse(readFileSync(paths.runs, 'utf8')).runs[0].owned).toBeUndefined()

    const gen = request!.gen
    done = false
    client.send({ type: 'input.submit', text: '下一代' })
    await until(() => request!.gen !== gen)
    attach()
    client.stop('ordered', 'run')
    await until(() => cancelled)
    callbacks[0]!('旧代重复回调')
    expect(done).toBe(false); expect(manager.executors()).toHaveLength(1)
    exited = true; callbacks[1]!('新代收尾完成')
    await until(() => done)
  } finally {
    if (tool?.process.exitCode === null) { tool.process.kill('SIGKILL'); await tool.process.exited }
    exited = true; for (const callback of callbacks) callback('测试清理')
    client.close(); manager.stop('测试结束'); await manager.waitUntilExit()
    store.close(); rmSync(paths.dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true })
  }
}, 10000)
