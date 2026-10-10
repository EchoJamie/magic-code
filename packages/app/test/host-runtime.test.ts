import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineCall, type EngineCall } from '../src/run/engine-call.ts'
import { softwareSource } from '../src/run/runtime-launch.ts'
import { createRecordsStore } from '@magic/records'
import { startTimeOf } from '@magic/execution'
import { resolveMagicHome } from '@magic/contracts'
import { readRuns, writeRuns } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { connectManager } from '../src/run/client.ts'
import { startFixture } from './ui/fixture.ts'
import { readEngineState } from '../src/run/engine-state.ts'

async function fixture(config = '{}', prepare?: (home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'magic-engine-')), source = softwareSource(), discovery = join(home, 'runtime/host.json')
  mkdirSync(join(home, '.magic')); writeFileSync(join(home, '.magic/config.json'), config)
  const input: EngineCall = { action: 'status', home, parent: home, source, app: '/tmp/Isolated.app', discovery }
  await prepare?.(home)
  const child = Bun.spawn([process.execPath, source, '--internal-engine', '--home', home, '--parent', home, '--source', source,
    '--app', input.app, '--discovery', discovery, '--lifecycle', crypto.randomUUID()], {
      cwd: home, env: { PATH: '/usr/bin:/bin', HOME: home }, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe',
    })
  const errors = new Response(child.stderr).text()
  const until = async () => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const found = readEngineState(discovery)
      if (found && found.state !== 'starting') return found
      if (child.exitCode !== null) throw new Error(await errors)
      await Bun.sleep(10)
    }
    throw new Error('Engine 未就绪')
  }
  return { child, input, until, async close() { if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await errors; rmSync(home, { recursive: true, force: true }) } }
}

test('Engine 独立于入口 stdin，纯状态查询不建 Agent；具身份停止持久同请求结果', async () => {
  const f = await fixture()
  try {
    const found = await f.until(); expect(found.state).toBe('ready')
    f.child.stdin.end()
    expect((await engineCall(f.input)).state).toBe('ready')
    expect(f.child.exitCode).toBeNull()
    const result = await engineCall({ ...f.input, action: 'stop', request: 'stop-one', expected: found })
    expect(result.state).toBe('stopped')
    expect(await f.child.exited).toBe(0)
    expect(result.record?.request).toBe('stop-one')
    expect((await engineCall({ ...f.input, action: 'stop', request: 'stop-one', expected: found })).state).toBe('stopped')
  } finally { await f.close() }
}, 15000)

test('旧 Engine 代次不能停止新 Engine', async () => {
  const f = await fixture()
  try {
    const found = await f.until()
    await expect(engineCall({ ...f.input, action: 'stop', request: 'old-stop', expected: { ...found, serviceInstance: 'old-generation' } })).rejects.toThrow('代次')
    expect((await engineCall(f.input)).state).toBe('ready')
    expect((await engineCall({ ...f.input, action: 'stop', request: 'current-stop', expected: found })).state).toBe('stopped')
  } finally { await f.close() }
}, 15000)

test('可识别配置错误记录失败并正常退出，设置及状态入口不重启', async () => {
  const f = await fixture('{broken')
  try {
    const result = await f.until()
    expect(result.state).toBe('failed'); expect(result.error).toBeDefined()
    expect(await f.child.exited).toBe(0)
    expect((await engineCall(f.input)).state).toBe('failed')
  } finally { await f.close() }
}, 10000)


test('单 Run 身份无法核实时保留资源责任，独立工作仍能执行；故障解除后可收妥', async () => {
  const tool = Bun.spawn(['/bin/sleep', '30'], { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  const model = startFixture({ turns: [{ kind: 'text', text: '独立工作完成' }] })
  const config = JSON.stringify({ models: Object.fromEntries(['default', 'cantrip', 'spell', 'arcane'].map(tier => [tier, { provider: 'local', model: 'probe' }])), providers: { local: { vendor: 'minimax', apiKey: 'synthetic', baseURL: model.baseURL } } })
  const f = await fixture(config, async home => {
    const magic = resolveMagicHome({}, home), store = createRecordsStore({ dataDir: magic.base, workspace: [home] })
    store.setSessionTitle('held-run', '尚有责任', Date.now()); store.close()
    mkdirSync(runPathsOf(magic, '/tmp').dir, { recursive: true })
    writeRuns(runPathsOf(magic, '/tmp'), [{ session: 'held-run', gen: 1, workspace: [home], startedAt: Date.now(), since: Date.now(), state: 'running',
      owned: [{ pgid: tool.pid, startedAt: (await startTimeOf(tool.pid))! - 3600000, kind: 'exec', what: '注入身份无法核实' }] }], Date.now())
  })
  let client: Awaited<ReturnType<typeof connectManager>>
  try {
    const found = await f.until(); expect(found.state).toBe('ready'); expect(tool.exitCode).toBeNull()
    client = await connectManager(found.socket, { cwd: f.input.home, environment: { PATH: '/usr/bin:/bin' } })
    let completed = false
    client!.onEvent(event => { if (event.kind === 'turn.end' && event.data.reason === 'settled') completed = true })
    client!.send({ type: 'input.submit', text: '独立新工作' })
    const deadline = Date.now() + 5000
    while (!completed && Date.now() < deadline) await Bun.sleep(10)
    expect(completed).toBe(true); expect(model.requests()).toHaveLength(1)
    const paths = runPathsOf(resolveMagicHome({}, f.input.home), '/tmp')
    expect(readRuns(paths).find(run => run.session === 'held-run')?.owned).toHaveLength(1)
    const stopResult = await engineCall({ ...f.input, action: 'stop', expected: found, request: 'failed-stop' })
    expect(stopResult.state).toBe('failed')
    expect(tool.exitCode).toBeNull()
    tool.kill(); await tool.exited
    expect((await engineCall({ ...f.input, action: 'stop', expected: found, request: 'retry-stop' })).state).toBe('stopped')
    expect(readRuns(paths).find(run => run.session === 'held-run')?.owned ?? []).toHaveLength(0)
  } finally { client?.close(); if (tool.exitCode === null) { tool.kill(); await tool.exited }; await f.close(); await model.stop() }
}, 20000)

test('实例切换的空闲停止与新输入两种顺序：已有责任拒绝切换，准入关闭后不执行新工作', async () => {
  for (const inputFirst of [true, false]) {
    const model = startFixture({ turns: [{ kind: 'text', text: '保持在途', chunks: 20, chunkDelayMs: 500 }] })
    const config = JSON.stringify({ models: Object.fromEntries(['default', 'cantrip', 'spell', 'arcane'].map(tier => [tier, { provider: 'local', model: 'probe' }])), providers: { local: { vendor: 'minimax', apiKey: 'synthetic', baseURL: model.baseURL } } })
    const f = await fixture(config)
    let client: Awaited<ReturnType<typeof connectManager>>
    try {
      const found = await f.until()
      client = await connectManager(found.socket, { cwd: f.input.home, environment: { PATH: '/usr/bin:/bin' } })
      if (inputFirst) {
        let accepted = false
        client!.onEvent(event => { if (event.kind === 'input.settled' && event.data.ok) accepted = true })
        client!.send({ type: 'input.submit', text: '先受理' })
        const until = Date.now() + 5000
        while (!accepted && Date.now() < until) await Bun.sleep(10)
        expect(accepted).toBe(true)
        const refused = await engineCall({ ...f.input, action: 'stop', expected: found, request: 'idle-switch', idleOnly: true })
        expect(refused.state).toBe('failed'); expect(refused.error).toContain('工作责任')
        expect((await engineCall(f.input)).state).toBe('ready')
        expect((await engineCall({ ...f.input, action: 'stop', expected: found, request: 'cleanup' })).state).toBe('stopped')
      } else {
        const stopping = engineCall({ ...f.input, action: 'stop', expected: found, request: 'idle-switch', idleOnly: true })
        const until = Date.now() + 5000
        while (readEngineState(f.input.discovery)?.state === 'ready' && Date.now() < until) await Bun.sleep(1)
        client!.send({ type: 'input.submit', text: '关闭准入后提交' })
        expect((await stopping).state).toBe('stopped')
        expect(client!.closed).toBe(true); expect(model.requests()).toHaveLength(0)
      }
    } finally { client?.close(); await f.close(); await model.stop() }
  }
}, 20000)
