/**
 * 2026-11-21 接续事故的真实规模回归。
 *
 * 事故形状：一条 5.7MB 的工具结果被 `readSessionCatalog` 当「最近进展」全文带进
 * `session.state`，带会话的连接（`magic resume` / App 恢复）当场被连接层断开。
 * 这条用例把三件事一起钉住：
 * - 目录里的最近进展只带一行预览；
 * - 历史按**字节**分批，单条消息不超过控制面预算；
 * - 超预算的旧记录被裁剪时如实说明，条目不丢。
 */

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PREVIEW_LIMIT } from '@magic/conversation'
import { CONTROL_FRAME_BUDGET_BYTES, resolveMagicHome, WIRE_MESSAGE_BUDGET_BYTES, type KernelEvent } from '@magic/contracts'
import { createRecordsStore } from '@magic/data'
import { connectManager, runPathsOf, startManager } from '@magic/host'

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10)
  if (!predicate()) throw new Error('等不到条件成立')
}

test('大记录接续：目录只带预览，历史按字节分批且单条裁剪有说明', async () => {
  const root = mkdtempSync(join(tmpdir(), 'big-resume-'))
  const magic = resolveMagicHome({}, root)
  const paths = runPathsOf(magic, tmpdir())
  const store = createRecordsStore({ dataDir: magic.base, workspace: [root] })
  const session = 'big'
  store.setSessionTitle(session, session, 1)
  const huge = 'x'.repeat(9 * 1024 * 1024)
  const service = store.serviceFor(session)
  service.appendEntry({ kind: 'user', content: { text: '开始' }, at: 1 })
  service.appendEntry({ kind: 'tool-result', content: { text: huge }, payload: { ok: true, output: { text: huge } }, at: 2 })
  service.appendEntry({ kind: 'assistant', content: { text: '完成' }, at: 3 })

  const started = await startManager({ magic, paths, stopGraceMs: 10, stopKillMs: 10,
    launch: { spawn() { throw new Error('读历史不能起执行者') } } })
  if (started.role !== 'manager') throw new Error('隔离 Engine 未启动')
  const client = await connectManager(paths.socket, { session })
  if (!client) throw new Error('终端连接失败')
  const events: KernelEvent[] = []
  client.onEvent(event => events.push(event))
  try {
    // **连接没被目录压断**——最近进展只带一行预览。
    await until(() => events.some(event => event.kind === 'session.state'))
    const state = events.find((event): event is Extract<KernelEvent, { kind: 'session.state' }> => event.kind === 'session.state')!
    expect(client.closed).toBe(false)
    expect(state.data.sessions.find(one => one.id === session)?.recentProgress?.length)
      .toBeLessThanOrEqual(PREVIEW_LIMIT + 1)

    // 历史按字节分批；每条消息都在单条预算之内。
    await until(() => events.some(event => event.kind === 'session.history' && event.data.done), 20_000)
    const blocks = events.filter((event): event is Extract<KernelEvent, { kind: 'session.history' }> => event.kind === 'session.history')
    expect(blocks.length).toBeGreaterThan(1)
    for (const block of blocks) {
      const bytes = new TextEncoder().encode(JSON.stringify({ t: 'ev', gen: null, event: block })).byteLength
      expect(bytes).toBeLessThan(WIRE_MESSAGE_BUDGET_BYTES)
    }

    // 超预算的那一条被裁，并如实说明；三条都在（裁剪不丢条目）。
    const entries = blocks.flatMap(block => block.data.entries)
    expect(entries).toHaveLength(3)
    const result = entries.find(entry => entry.kind === 'tool-result')
    expect(result?.content).toMatchObject({ text: expect.stringContaining('记录过大，显示已截断') })
  } finally {
    client.close()
    started.manager.stop('测试收尾')
    await started.manager.waitUntilExit()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('历史末包带 5MB input.local：帧仍在预算内，连接不断', async () => {
  const root = mkdtempSync(join(tmpdir(), 'big-meta-'))
  const magic = resolveMagicHome({}, root)
  const paths = runPathsOf(magic, tmpdir())
  const store = createRecordsStore({ dataDir: magic.base, workspace: [root] })
  const session = 'meta'
  store.setSessionTitle(session, session, 1)
  const service = store.serviceFor(session)
  service.appendEntry({ kind: 'user', content: { text: '开始' }, at: 1 })
  const bigText = 'x'.repeat(5 * 1024 * 1024)
  service.appendEvent({
    id: service.nextId(), session, turn: null, at: 2, kind: 'input.local',
    data: { text: bigText, refs: [], ref: 'big-local' },
  })
  service.appendEntry({ kind: 'assistant', content: { text: '完成' }, at: 3 })

  const started = await startManager({ magic, paths, stopGraceMs: 10, stopKillMs: 10,
    launch: { spawn() { throw new Error('读历史不能起执行者') } } })
  if (started.role !== 'manager') throw new Error('隔离 Engine 未启动')
  const client = await connectManager(paths.socket, { session })
  if (!client) throw new Error('终端连接失败')
  const events: KernelEvent[] = []
  client.onEvent(event => events.push(event))
  try {
    await until(() => events.some(event => event.kind === 'session.history' && event.data.done), 20_000)
    expect(client.closed).toBe(false)
    const done = events.findLast((event): event is Extract<KernelEvent, { kind: 'session.history' }> =>
      event.kind === 'session.history' && event.data.done)!
    const inputs = done.data.inputs ?? []
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.data.text.length).toBeLessThan(bigText.length)
    const bytes = new TextEncoder().encode(JSON.stringify({ t: 'ev', gen: null, event: done })).byteLength
    expect(bytes).toBeLessThan(CONTROL_FRAME_BUDGET_BYTES + 4096)
  } finally {
    client.close()
    started.manager.stop('测试收尾')
    await started.manager.waitUntilExit()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
