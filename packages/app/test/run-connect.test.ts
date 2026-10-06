/** 第 7 项：真 CLI/PTY 和隔离 stdin 宿主；仅模型端点为本地夹具。 */
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostDiscovery, NativeProjection } from '@magic/contracts'
import { linkOf, socketHandlers } from '../src/run/wire.ts'
import { startResidentHost } from './resident-host-fixture.ts'
import { readDatabase } from './support.ts'
import { removeDir, tempDir } from './tmp.ts'
import { createSandbox } from './ui/sandbox.ts'
import { createUiSession, type UiSession } from './ui/driver.ts'
import { startFixture } from './ui/fixture.ts'

const CTRL_R = '\x12'
const PLAN = { steps: [{ text: 'CONNECT_PLAN_KEEP', status: 'in_progress' }], notes: 'CONNECT_PLAN_NOTES' }

/** 原生只读观察者不占终端绑定；投影中的终端归属只能来自被测 CLI。 */
async function projectionOf(discovery: HostDiscovery): Promise<NativeProjection> {
  const link = linkOf(await Bun.connect({ unix: discovery.socket, socket: socketHandlers() }) as never)
  let projection: NativeProjection | undefined
  link.onMessage(message => { if (message.t === 'native.welcome') projection = message.projection })
  try {
    link.send({ t: 'hello', role: 'observer', ...discovery })
    const deadline = Date.now() + 5_000
    while (projection === undefined && Date.now() < deadline) await Bun.sleep(10)
    if (projection === undefined) throw new Error('隔离宿主未返回只读投影')
    return projection
  } finally { link.close() }
}

for (const canonicalHome of [false, true]) for (const how of ['shutdown', 'eof'] as const) {
  const homeForm = canonicalHome ? 'realpath' : 'declared'
  test(`${homeForm} HOME / ${how} 后同一 CLI 的 Ctrl+R 与 /connect 恢复原会话，保留草稿/历史/计划且不执行`, async () => {
    const evidenceRoot = process.env['MAGIC_CONNECT_EVIDENCE']
    const evidence = evidenceRoot === undefined ? tempDir('magic-connect-') : join(evidenceRoot, `${homeForm}-${how}-${crypto.randomUUID()}`)
    mkdirSync(evidence, { recursive: true })
    const fixture = startFixture({ turns: [
      { kind: 'tool', name: 'plan_update', args: { plan: PLAN } },
      { kind: 'text', text: 'CONNECT_HISTORY_COMPLETE' },
    ] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    // macOS /var 与 /private/var 指向同一位置：两种 HOME 写法都必须可重连。
    if (canonicalHome) sandbox.env['HOME'] = realpathSync(sandbox.home)
    const hosts: Awaited<ReturnType<typeof startResidentHost>>[] = []
    const checkpoints: unknown[] = []
    const staleDisconnectFlashes: string[] = []
    let ui: UiSession | undefined
    let passed = false
    const database = () => {
      const db = readDatabase(join(sandbox.dataDir, 'records.db'))
      try { return { sessions: db.sessions, entries: db.entries, events: db.events } }
      finally { db.close() }
    }
    const startHost = async () => {
      const host = await startResidentHost(sandbox, join(evidence, `host-${hosts.length}`))
      hosts.push(host)
      return host
    }
    try {
      let host = await startHost()
      ui = await createUiSession({ label: `connect-${how}`, artifacts: evidence, sandbox, fixture, columns: 200, rows: 40 })
      const input = `CONNECT_INPUT_${how}`, draft = `CONNECT_DRAFT_${how}`
      await ui.send(input)
      await ui.key('enter')
      await ui.wait({ text: 'CONNECT_HISTORY_COMPLETE' }, { timeoutMs: 20_000 })
      await ui.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })
      await ui.wait({ text: 'CONNECT_PLAN_KEEP' })
      const before = database()
      expect(before.sessions).toHaveLength(1)
      expect(before.events.filter(e => e.kind === 'turn.end').map(e => JSON.parse(e.data).reason)).toEqual(['settled', 'settled'])
      expect(before.entries.filter(e => e.kind === 'user').map(e => e.content_text)).toEqual([input])
      expect(before.entries.filter(e => e.kind === 'tool-result').map(e => JSON.parse(e.payload ?? '{}').plan)).toContainEqual(PLAN)
      expect(fixture.requests()).toHaveLength(2)
      expect(host.executorStarts()).toBe(1)
      await ui.send(draft, { until: { text: draft } })
      await ui.capture({ label: 'completed-with-unsent-draft' })
      checkpoints.push({ phase: 'completed', facts: ui.facts(), database: before })

      // 两次断线各走一个真实键盘入口；/connect 前显式删草稿，不把清稿冒充恢复行为。
      for (const action of ['Ctrl+R', '/connect'] as const) {
        if (action === '/connect') {
          await ui.send('\x7f'.repeat(draft.length))
          await ui.wait({ absent: draft })
        }
        const oldHost = host
        await oldHost.close(how)
        await ui.wait({ text: '暂时无法确认任务状态' }, { timeoutMs: 20_000 })
        const lost = await ui.capture({ label: `${action === 'Ctrl+R' ? 'ctrl-r' : 'slash'}-disconnected` })
        expect(lost.text).toContain('/connect 重连')
        expect(lost.text).not.toContain('○ 空闲')
        const stopped = JSON.parse(readFileSync(join(oldHost.evidence, 'host.json'), 'utf8'))
        expect(stopped.code).toBe(0)
        expect(stopped.alreadyGone).toBe(false)
        expect(stopped.messages.some((m: { t: string }) => m.t === 'host.stopped')).toBe(true)
        if (action === 'Ctrl+R') {
          expect(lost.text).toContain(draft)
          await ui.key('enter')
          await ui.wait({ text: '草稿未发送' })
          expect(database().entries).toEqual(before.entries)
        }
        // 先重开本测试宿主，再触发恢复；不调用系统 open，不接触已安装 App。
        host = await startHost()
        expect(host.discovery.base).toBe(oldHost.discovery.base)
        expect(host.discovery.dataDir).toBe(oldHost.discovery.dataDir)
        expect(host.discovery.serviceInstance).not.toBe(oldHost.discovery.serviceInstance)
        expect(host.pid).not.toBe(oldHost.pid)
        if (action === 'Ctrl+R') await ui.send(CTRL_R)
        else {
          await ui.send('/connect', { until: { text: '› /connect' } })
          await ui.key('enter')
        }
        // 历史刷新会替换临时连接回执；以恢复后的可见事实为准。
        await ui.wait({ text: '○ 空闲' }, { timeoutMs: 15_000 })
        await ui.wait({ text: 'CONNECT_HISTORY_COMPLETE' })
        await ui.wait({ text: 'CONNECT_PLAN_KEEP' })
        const restored = await ui.capture({ label: `${action === 'Ctrl+R' ? 'ctrl-r' : 'slash'}-restored` })
        staleDisconnectFlashes.push(...restored.lines.filter(line => line.trimStart().startsWith('▲') && line.includes('连接已断开')))
        expect(restored.lines.some(line => line.includes(`› ${input}`))).toBe(true)
        if (action === 'Ctrl+R') expect(restored.text).toContain(draft)
        // 已连接重复刷新也只能读事实；同一 PTY 仍在，记录与模型往返不增长。
        for (let repeat = 0; repeat < 3; repeat++) {
          await ui.send(CTRL_R)
          await Bun.sleep(30)
        }
        await Bun.sleep(250)
        const after = database()
        expect(after.sessions).toEqual(before.sessions)
        expect(after.entries).toEqual(before.entries)
        expect(after.events.filter(e => ['turn.start', 'turn.end', 'tool.call', 'tool.decision'].includes(e.kind)))
          .toEqual(before.events.filter(e => ['turn.start', 'turn.end', 'tool.call', 'tool.decision'].includes(e.kind)))
        expect(fixture.requests()).toHaveLength(2)
        expect(fixture.requests().every(request => !JSON.stringify(request.body).includes(draft) && !JSON.stringify(request.body).includes('/connect'))).toBe(true)
        expect(host.executorStarts()).toBe(0)
        const projection = await projectionOf(host.discovery)
        const work = projection.works.find(work => work.session === before.sessions[0]!.id)
        checkpoints.push({ phase: action, oldHost: oldHost.discovery, newHost: host.discovery, executorStarts: host.executorStarts(), database: after, projection })
        expect(work?.terminalNoticeIds?.length).toBeGreaterThan(0)
      }
      // 历史中的断线记录可以保留；输入区的当前提示不能仍声称连接已断开。
      expect(staleDisconnectFlashes).toEqual([])
      passed = true
    } finally {
      writeFileSync(join(evidence, 'connect-facts.json'), JSON.stringify({ how, homeForm, passed, staleDisconnectFlashes, checkpoints, requests: fixture.requests(), ui: ui?.facts() }, null, 2))
      try { await ui?.close() }
      finally {
        try { for (const host of hosts) await host.close() }
        finally { await fixture.stop(); await sandbox.dispose() }
      }
      if (passed && evidenceRoot === undefined) removeDir(evidence)
      else console.log(`connect 验收证据：${evidence}`)
    }
  }, 90_000)
}
