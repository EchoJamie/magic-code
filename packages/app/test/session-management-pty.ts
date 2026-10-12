/** U123：真实 CLI/Engine/PTY，隔离库和本地模型；按可见状态等待，结束清理全部临时产物。 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KernelEvent } from '@magic/contracts'
import { createRecordsStore, readSessionSummary } from '@magic/records'
import { readDatabase } from './support.ts'
import { createUiSession, type UiSession } from './ui/driver.ts'
import { createSandbox } from './ui/sandbox.ts'
import { startFixture } from './ui/fixture.ts'
import { startResidentHost } from './resident-host-fixture.ts'
import { connectManager, type ManagerClient } from '../src/run/client.ts'
import { readEngineState } from '../src/run/engine-state.ts'
import { hostDiscoveryPath } from '../src/run/host-discovery.ts'

for (const columns of [100, 200]) {
  const artifacts = mkdtempSync(join(tmpdir(), 'u123-pty-'))
  const fixture = startFixture({ turns: [{ kind: 'text', text: 'DRAFT_SENT_ONCE', chunks: 1, chunkDelayMs: 1 }] })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  let ui: UiSession | undefined, admin: ManagerClient | undefined
  let host: Awaited<ReturnType<typeof startResidentHost>> | undefined
  try {
    writeFileSync(join(sandbox.workspace, 'draft.txt'), 'REFERENCE_CONTENT_U123')
    const store = createRecordsStore({ dataDir: sandbox.dataDir, workspace: [realpathSync(sandbox.workspace)] })
    store.serviceFor('u123-current').appendEntry({ kind: 'user', at: 1, content: { text: 'CURRENT_WORK' } })
    store.serviceFor('u123-current').appendEntry({ kind: 'assistant', at: 2, content: { text: 'CURRENT_HISTORY' } })
    store.setSessionTitle('u123-current', 'CURRENT_WORK', 1)
    store.serviceFor('u123-old').appendEntry({ kind: 'user', at: 3, content: { text: 'OLD_WORK' } })
    store.serviceFor('u123-old').appendEntry({ kind: 'assistant', at: 4, content: { text: Array.from({ length: 65 }, (_, i) => `ARCHIVE_HISTORY_${String(i).padStart(2, '0')} 中文 é`).join('\n') } })
    store.setSessionTitle('u123-old', 'OLD_WORK', 3)
    store.setSessionArchived('u123-old', true)
    store.close()
    host = await startResidentHost(sandbox, join(artifacts, 'host'))
    const identity = readEngineState(hostDiscoveryPath(sandbox.home))!
    admin = (await connectManager(identity.socket, { expectedIdentity: identity, cwd: sandbox.workspace }))!
    const events: KernelEvent[] = []
    admin.onEvent(event => events.push(event))
    const manage = async (session: string, type: 'session.archive' | 'session.restore') => {
      if (type === 'session.archive') {
        const deadline = Date.now() + 8000
        for (;;) {
          const at = events.length
          admin!.send({ type: 'session.list', archived: false })
          while (!events.slice(at).some(event => event.kind === 'session.state')) {
            if (Date.now() > deadline) throw new Error('目录未返回归档资格')
            await Bun.sleep(10)
          }
          const state = events.slice(at).find(event => event.kind === 'session.state')
          if (state?.kind === 'session.state' && state.data.sessions.find(one => one.id === session)?.canArchive) break
          if (Date.now() > deadline) throw new Error('归档资格未就绪')
          await Bun.sleep(10)
        }
      }
      const start = events.length
      admin!.send({ type, session })
      const deadline = Date.now() + 8000
      for (;;) {
        const result = events.slice(start).find(event => event.kind === 'session.managed' && event.data.session === session)
        if (result?.kind === 'session.managed') { assert(result.data.ok, result.data.error ?? '管理失败'); return }
        if (Date.now() > deadline) throw new Error('管理命令未返回')
        await Bun.sleep(10)
      }
    }
    let rejectedOutput = ''
    const rejectedTerminal = new Bun.Terminal({ cols: columns, rows: 40, data(_terminal, bytes) { rejectedOutput += Buffer.from(bytes).toString() } })
    const rejectedCli = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'resume', 'u123-old'], { terminal: rejectedTerminal, cwd: sandbox.workspace, env: sandbox.env })
    const rejectDeadline = Date.now() + 8000
    try {
      while (rejectedCli.exitCode === null) {
        if (Date.now() > rejectDeadline) throw new Error('归档 CLI 接回未明确拒绝')
        await Bun.sleep(10)
      }
      assert.equal(rejectedCli.exitCode, 1)
      assert(rejectedOutput.includes('会话已归档，请在会话管理或 /resume 的已归档列表中恢复'))
    } finally { if (rejectedCli.exitCode === null) { rejectedCli.kill(); await rejectedCli.exited }; rejectedTerminal.close() }
    ui = await createUiSession({ columns, rows: 40, label: `u123-${columns}`, artifacts, sandbox, fixture, argv: ['resume', 'u123-current'] })
    await ui.wait({ text: 'CURRENT_HISTORY' })
    await ui.send('DRAFT_KEEP ')
    await ui.send('@'); await ui.wait({ text: '引用文件或目录' })
    await ui.wait({ text: '›  draft.txt' })
    await ui.key('enter'); await ui.wait({ absent: '引用文件或目录' })
    await ui.wait({ text: '@draft.txt' })
    await manage('u123-current', 'session.archive')
    await ui.wait({ text: '已归档 · Ctrl+G' })
    await ui.key('enter')
    assert.equal(fixture.requests().length, 0)
    await ui.key('ctrl+g'); await ui.wait({ text: '查看／复制原草稿' })
    for (let n = 0; n < 2; n++) await ui.key('down')
    await ui.wait({ text: '›  查看／复制原草稿' })
    await ui.key('enter'); await ui.wait({ text: 'DRAFT_KEEP' }); await ui.wait({ text: '@draft.txt' })
    const draft = await ui.capture({ label: 'archived-draft-readable' })
    assert.equal(draft.columns, columns); assert.equal(draft.rows, 40)
    await ui.key('esc'); await ui.wait({ text: '查看／复制原草稿' })
    await ui.key('up'); await ui.wait({ text: '›  恢复' }); await ui.key('enter')
    await ui.wait({ text: '› DRAFT_KEEP' }); await ui.wait({ absent: '已归档 · Ctrl+G' })
    assert.equal(fixture.requests().length, 0)
    await ui.key('enter'); await ui.wait({ text: 'DRAFT_SENT_ONCE' }); await ui.wait({ text: '○ 空闲' })
    assert.equal(fixture.requests().filter(request => request.path.endsWith('/chat/completions')).length, 1)
    const persisted = readDatabase(join(sandbox.dataDir, 'records.db'))
    try {
      const draft = persisted.entries.find(entry => entry.session === 'u123-current' && entry.kind === 'user' && entry.content_text?.startsWith('DRAFT_KEEP'))
      assert(draft?.payload)
      const refs = JSON.parse(draft.payload).refs
      assert(refs.some((ref: { source: string; marker: string }) => ref.source.endsWith('/draft.txt') && ref.marker === '@draft.txt'))
    } finally { persisted.close() }
    await ui.send('/resume '); await ui.key('enter'); await ui.wait({ text: '普通 · Enter 接回' })
    await ui.key('tab'); await ui.wait({ text: '本工作区' })
    await ui.send('OLD'); await ui.wait({ text: '没有名称匹配' })
    await ui.send('\x1b[Z'); await ui.wait({ text: '已归档 · Enter 查看记录' }); await ui.wait({ text: 'OLD_WORK' })
    await ui.key('enter'); await ui.wait({ text: 'ARCHIVE_HISTORY_00' })
    await ui.key('pageDown'); await ui.wait({ absent: 'ARCHIVE_HISTORY_00' })
    await ui.capture({ label: 'archived-history-scrolled' })
    await ui.key('esc'); await ui.wait({ text: '已归档 · Enter 查看记录' })
    await ui.wait({ text: '本工作区' }); await ui.wait({ text: 'OLD' })
    await ui.key('ctrl+g'); await ui.wait({ text: '恢复后需另行接回或发送' })
    await ui.key('down'); await ui.wait({ text: '›  恢复' }); await ui.key('enter')
    await ui.wait({ text: '普通 · Enter 接回' }); await ui.wait({ text: '›  OLD_WORK' })
    assert.equal(readSessionSummary(sandbox.dataDir, 'u123-old')?.archived, false)
    assert.equal(fixture.requests().filter(request => request.path.endsWith('/chat/completions')).length, 1)
    const restored = await ui.capture({ label: 'restored-selected-without-resume' })
    assert(restored.text.includes('CURRENT_WORK'))
    await ui.key('enter'); await ui.wait({ text: '○ 空闲 · OLD_WORK' })
    await ui.key('ctrl+o'); await ui.wait({ text: 'PgUp/PgDn 翻页' })
    await ui.key('esc'); await ui.wait({ text: '○ 空闲 · OLD_WORK' })
    await ui.quit()
    console.log(JSON.stringify({ columns, rows: 40, archive: true, preservedRefs: true, restoredWithoutSubmit: true, historyScroll: true, restoredSelected: true, modelCalls: 1, rawPtyBytes: ui.rawText().length }))
  } finally {
    await ui?.close()
    admin?.close()
    await host?.close()
    await fixture.stop()
    await sandbox.dispose()
    rmSync(artifacts, { recursive: true, force: true })
  }
}
