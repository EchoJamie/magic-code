/**
 * App 的 native.history 路径——2026-11-21 审计发现的另一条 P0 原形：
 * 50 条全量 + blob 展开，单条 9MB 记录会让 App 的 JSONLines 抛错并关掉整条观察连接。
 */

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTROL_FRAME_BUDGET_BYTES, resolveMagicHome, type NativeResponse } from '@magic/contracts'
import { createRecordsStore } from '@magic/data'
import { linkOf, runPathsOf, socketHandlers, startManager } from '@magic/host'

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10)
  if (!predicate()) throw new Error('等不到条件成立')
}

test('native.history 单条 9MB 记录：裁剪后送达，观察连接不断', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-history-budget-'))
  const magic = resolveMagicHome({}, root)
  const paths = runPathsOf(magic, tmpdir())
  const store = createRecordsStore({ dataDir: magic.base, workspace: [root] })
  const session = 'big-native'
  store.setSessionTitle(session, session, 1)
  const service = store.serviceFor(session)
  const huge = 'x'.repeat(9 * 1024 * 1024)
  service.appendEntry({ kind: 'user', content: { text: '开始' }, at: 1 })
  service.appendEntry({ kind: 'tool-result', content: { text: huge }, payload: { ok: true, output: { text: huge } }, at: 2 })
  service.appendEntry({ kind: 'assistant', content: { text: '完成' }, at: 3 })

  const started = await startManager({ magic, paths, stopGraceMs: 10, stopKillMs: 10,
    launch: { spawn() { throw new Error('读历史不能起执行者') } } })
  if (started.role !== 'manager') throw new Error('隔离 Engine 未启动')
  const observer = linkOf<NativeResponse>(await Bun.connect({ unix: paths.socket, socket: socketHandlers() }) as never)
  const messages: NativeResponse[] = []
  observer.onMessage(message => messages.push(message))
  observer.send({ t: 'hello', role: 'observer', ...started.manager.identity })
  try {
    await until(() => messages.some(message => message.t === 'native.welcome'))
    observer.send({ t: 'native.history', request: 'big-history', session })
    await until(() => messages.some(message => message.t === 'native.history.result' && message.request === 'big-history'), 20_000)
    expect(observer.closed).toBe(false)

    const result = messages.find((message): message is Extract<NativeResponse, { t: 'native.history.result' }> =>
      message.t === 'native.history.result' && message.request === 'big-history')!
    expect(result.done).toBe(true)
    const entries = result.entries ?? []
    expect(entries.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(CONTROL_FRAME_BUDGET_BYTES + 4096)
  } finally {
    observer.close()
    started.manager.stop('测试收尾')
    await started.manager.waitUntilExit()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
