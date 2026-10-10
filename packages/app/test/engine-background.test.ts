import { test, expect } from 'bun:test'
import { startFixture, createSandbox } from './ui/index.ts'
import { startResidentHost } from './resident-host-fixture.ts'
import { connectManager } from '../src/run/client.ts'

test('后台工具返回后继续下一次模型请求，停止收回全部资源', async () => {
  const fixture = startFixture({ turns: [{ kind: 'tool', name: 'exec', args: { cmd: 'sleep 30', background: true } }, { kind: 'text', text: '交出去了。', chunkDelayMs: 200 }] })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const host = await startResidentHost(sandbox)
  const client = (await connectManager(host.discovery.socket, { cwd: sandbox.workspace, environment: sandbox.env }))!
  let settled = false
  client.onEvent(event => { if (event.kind === 'model.delta' && event.data.channel === 'text') client.stop(event.session, 'run'); if (event.kind === 'turn.end' && !event.data.continues) settled = true })
  try {
    client.send({ type: 'input.submit', text: 'run' })
    const until = Date.now() + 5000
    while (!settled && Date.now() < until) await Bun.sleep(10)
    expect(fixture.requests()).toHaveLength(2)
    expect(settled).toBe(true)
  } finally {
    client.close()
    try { await host.close() } finally { await fixture.stop(); await sandbox.dispose() }
  }
}, 30000)
