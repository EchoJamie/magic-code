import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { alive } from '@magic/host'
import { connectManager, type ManagerClient } from '@magic/host'
import { startResidentHost, debugLogs } from './resident-host-fixture.ts'
import { createSandbox, startFixture } from './ui/index.ts'

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('真实宿主责任状态未到达')
    await Bun.sleep(10)
  }
}

for (const how of ['shutdown', 'signal'] as const) {
  test(`有待答责任时明确停止 Engine ${how}：Agent 与资源收妥后关闭连接`, async () => {
    const fixture = startFixture({ turns: [{ kind: 'text', text: '受控等待中', chunks: 200, chunkDelayMs: 100 }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined
    let client: ManagerClient | undefined
    try {
      host = await startResidentHost(sandbox)
      client = await connectManager(host.discovery.socket, { cwd: sandbox.workspace })
      expect(client).toBeDefined()
      client!.send({ type: 'input.submit', text: '受控等待，不结束这一轮' })
      await waitFor(() => client!.runs().some((row) => row.state === 'running'))
      await waitFor(() => {
        try {
          const db = new Database(join(sandbox.home, '.magic', 'records.db'), { readonly: true })
          try {
            return db.query<{ generation: number; state: string }, []>('SELECT generation, state FROM runs').all()
              .some(row => row.state === 'running' && row.generation > 0)
          } finally { db.close() }
        } catch { return false }
      })
      await waitFor(() => host.executorStarts() >= 1) // 执行者子进程的诊断落盘是异步 pump，先等它出现
      expect(host.executorStarts()).toBe(1)
      // T1 消费流：受理落账→ready wake→dequeue→consume→模型调用，请求晚于 spawn 到达。
      await waitFor(() => fixture.requests().some((one) => one.path.endsWith('/chat/completions')))
      expect(fixture.requests().filter((one) => one.path.endsWith('/chat/completions'))).toHaveLength(1)
      const pid = host.pid
      const socket = host.discovery.socket
      await host.close(how)
      expect(alive(pid)).toBe(false)
      expect(client!.closed).toBe(true)
      expect(existsSync(socket)).toBe(false)
    } finally {
      client?.close()
      try { await host?.close() } finally {
        await fixture.stop()
        await sandbox.dispose()
      }
    }
  }, 20_000)
}
