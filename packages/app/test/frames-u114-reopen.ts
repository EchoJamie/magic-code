import { strict as assert } from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { startResidentHost } from './resident-host-fixture.ts'
import { startFixture } from './ui/fixture.ts'
import { createSandbox } from './ui/sandbox.ts'
import { createUiSession, REPO_ROOT } from './ui/driver.ts'
const root = REPO_ROOT + '/.ui-runs/u114'
const fixture = startFixture({ turns: [
  { kind: 'text', text: 'FIRST_STREAM_' + 'a'.repeat(300), chunks: 30, chunkDelayMs: 500 },
  { kind: 'text', text: 'EXPLICIT_CONTINUE_DONE', chunks: 1, chunkDelayMs: 10 },
] })
const sandbox = createSandbox({ baseURL: fixture.baseURL })
mkdirSync(root, { recursive: true })
let host = await startResidentHost(sandbox, join(root, 'reopen-host-1'))
let ui = await createUiSession({ fixture, sandbox, columns: 200, rows: 40, label: 'U114-停止前持久输入', artifacts: root })
const key = async (name: Parameters<typeof ui.key>[0]) => { await ui.key(name); await Bun.sleep(100) }
try {
  await ui.send('FIRST_OWNED_RUN'); await key('enter'); await ui.wait({ text: 'FIRST_STREAM' })
  await ui.send('PENDING_AFTER_REOPEN'); await key('alt+enter'); await ui.wait({ text: '本条输入用途' })
  await key('down'); await key('enter'); await ui.wait({ text: '本条：下一件' }); await key('enter'); await ui.wait({ text: '下一件排队中：PENDING_AFTER_REOPEN' })
  await ui.capture({ label: '200-停止前已持久受理' })
  await key('ctrl+c'); await ui.wait({ text: '停止任务' }); await key('enter'); await ui.wait({ text: '○ 空闲' })
  const db = new Database(join(sandbox.dataDir, 'records.db'), { readonly: true })
  const pending = db.query("SELECT * FROM inputs WHERE state='pending'").get() as any
  assert.equal(JSON.parse(pending.body).text, 'PENDING_AFTER_REOPEN')
  const firstRun = ui.runDir, firstPid = host.pid
  await ui.capture({ label: '200-停止后未执行仍在' })
  await ui.close({ keepSandbox: true }); await host.close()
  host = await startResidentHost(sandbox, join(root, 'reopen-host-2'))
  assert.notEqual(host.pid, firstPid)
  ui = await createUiSession({ fixture, sandbox, argv: ['resume', pending.session], columns: 200, rows: 40, label: 'U114-重开明确继续', artifacts: root })
  await ui.wait({ text: '未执行，等待明确继续：PENDING_AFTER_REOPEN' }); await Bun.sleep(700)
  assert.equal(fixture.requests().filter(r => r.path.endsWith('/chat/completions')).length, 1, '接回与等待不得自动消费旧输入')
  await ui.capture({ label: '200-重开仅可查不自动消费' })
  await key('alt+enter'); await ui.wait({ text: '本条输入用途' }); await key('down'); await key('down'); await key('enter')
  await ui.wait({ text: '输入受理记录' }); await key('down'); await key('enter'); await ui.wait({ text: '明确继续这条输入' })
  await ui.capture({ label: '200-待处理原文和明确继续' })
  await key('down'); await key('down'); await key('down'); await key('enter')
  await key('esc'); await key('esc'); await ui.wait({ text: 'EXPLICIT_CONTINUE_DONE' }); await ui.wait({ text: '○ 空闲' })
  await ui.capture({ label: '200-明确继续才带入请求' })
  const calls = fixture.requests().filter(r => r.path.endsWith('/chat/completions'))
  assert.equal(calls.length, 2); assert(JSON.stringify(calls[1]!.body).includes('PENDING_AFTER_REOPEN'))
  const after = db.query('SELECT * FROM inputs WHERE ref=?').get(pending.ref) as any
  assert.equal(after.state, 'included')
  writeFileSync(join(ui.runDir, 'u114-reopen-facts.json'), JSON.stringify({ firstRun, firstPid, secondPid: host.pid, before: pending, after, calls, facts: ui.facts() }, null, 2))
  db.close(); console.log(ui.runDir)
} finally { await ui.close({ keepSandbox: true }); await host.close(); await fixture.stop() }
