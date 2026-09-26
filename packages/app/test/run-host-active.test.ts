import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { alive } from '../src/run/facts.ts'
import { connectManager, type ManagerClient } from '../src/run/client.ts'
import { startResidentHost } from './resident-host-fixture.ts'
import { createSandbox, startFixture } from './ui/index.ts'

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('真实宿主责任状态未到达')
    await Bun.sleep(10)
  }
}

for (const how of ['shutdown', 'eof'] as const) {
  test(`有待答责任时 App ${how}：真实执行者与宿主全退，旧客户端不能留下后台`, async () => {
    const fixture = startFixture({ turns: [{ kind: 'tool', name: 'exec', args: { cmd: 'chmod 755 .' } }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined
    let client: ManagerClient | undefined
    try {
      host = await startResidentHost(sandbox)
      client = await connectManager(host.discovery.socket, { cwd: sandbox.workspace })
      expect(client).toBeDefined()
      client!.send({ type: 'input.submit', text: '受控待答，不批准工具' })
      await waitFor(() => client!.runs().some((row) => row.state === 'waiting'))
      const runs = join(dirname(host.discovery.socket), 'runs.json')
      let executor: number | undefined
      await waitFor(() => {
        if (!existsSync(runs)) return false
        const registry = JSON.parse(readFileSync(runs, 'utf8')) as { runs: { pid?: number; state: string }[] }
        executor = registry.runs.find((row) => row.state === 'waiting')?.pid
        return executor !== undefined
      })
      expect(alive(executor!)).toBe(true)
      expect(host.executorStarts()).toBe(1)
      expect(fixture.requests().filter((one) => one.path.endsWith('/chat/completions'))).toHaveLength(1)
      const pid = host.pid
      const socket = host.discovery.socket
      await host.close(how)
      expect(alive(executor!)).toBe(false)
      expect(alive(pid)).toBe(false)
      expect(client!.closed).toBe(true)
      expect(existsSync(socket)).toBe(false)
      console.log(`有责宿主 ${how} 证据：${host.evidence}`)
    } finally {
      client?.close()
      try { await host?.close() } finally {
        await fixture.stop()
        sandbox.dispose()
      }
    }
  }, 20_000)
}
