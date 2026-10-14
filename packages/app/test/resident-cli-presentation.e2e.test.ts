/** 真 Engine + 真 PTY + records.db；只在失败时保留本轮临时诊断。 */
import { expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { connectManager } from '../src/run/client.ts'
import { createSandbox, createUiSession, startFixture } from './ui/index.ts'
import type { UiSession } from './ui/index.ts'
import { startResidentHost } from './resident-host-fixture.ts'
import { attentionFacts } from './resident-attention-fixture.ts'
import { readDatabase } from './support.ts'

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 15_000
  while (!check()) {
    if (Date.now() > end) throw new Error('等不到真实事项数据库事实')
    await Bun.sleep(10)
  }
}

test('当前来源替换不累积历史，实际呈现才已读且审批已读不等于答复', async () => {
  const evidence = join(tmpdir(), 'magic-resident-cli-evidence', `presentation-${crypto.randomUUID()}`)
  mkdirSync(evidence, { recursive: true })
  const fixture = startFixture({ turns: [
    { kind: 'text', text: '历史第一条结果' }, { kind: 'text', text: '' },
    { kind: 'text', text: '这次真正显示的新结果' },
    { kind: 'tool', name: 'exec', args: { cmd: 'chmod 755 .' } },
    { kind: 'http', status: 400, message: '隔离失败验收' },
  ] })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const facts = () => attentionFacts(sandbox.dataDir, sandbox.workspace)
  const save = (name: string) => writeFileSync(join(evidence, `${name}.json`), JSON.stringify(facts(), null, 2))
  let host: Awaited<ReturnType<typeof startResidentHost>> | undefined
  let headless: Awaited<ReturnType<typeof connectManager>>
  let window: UiSession | undefined
  let passed = false
  try {
    host = await startResidentHost(sandbox, join(evidence, 'host'))
    headless = await connectManager(host.discovery.socket, { cwd: sandbox.workspace })
    if (headless === undefined) throw new Error('专用宿主未连接')
    let historyReturns = 0
    headless.onEvent(event => {
      if (event.kind === 'session.history' && event.data.done) historyReturns += 1
    })
    headless.send({ type: 'input.submit', text: '第一条：留历史结果' })
    await until(() => facts().length === 1 && facts()[0]?.kind === 'done')
    const first = facts()[0]!
    expect(first.unread).toBe(true)
    expect(first.detail).toBe('历史第一条结果')
    const session = first.session
    headless.send({ type: 'input.submit', text: '第二条：空答轮' })
    await until(() => facts().length === 1 && facts()[0]?.kind === 'done' && facts()[0]?.id !== first.id)
    const empty = facts()[0]!
    expect(empty.session).toBe(session)
    expect(empty.unread).toBe(true)
    expect(empty.detail).not.toContain('历史第一条结果')
    // 旧来源已被替换；迟到回执、只读历史查询不能消费新的停点。
    const historyReturnsBeforeQuery = historyReturns
    headless.markRead([first.id])
    headless.send({ type: 'history.read', session })
    await until(() => historyReturns > historyReturnsBeforeQuery)
    expect(facts().map(one => ({ id: one.id, unread: one.unread }))).toEqual([{ id: empty.id, unread: true }])
    save('current-source-after-read-only-history')
    headless.close()
    window = await createUiSession({ label: '具体事项呈现', sandbox, fixture, artifacts: evidence, argv: ['resume', session] })
    await window.wait({ text: '你不在的时候' })
    await window.wait({ text: '历史第一条结果' })
    await window.capture({ label: '历史正文与当前空答停点分别呈现' })
    expect(facts().map(one => ({ id: one.id, unread: one.unread }))).toEqual([{ id: empty.id, unread: true }])
    save('history-does-not-present-current-source')
    await window.send('第三条：显示新结果')
    await window.key('enter')
    await window.wait({ text: '这次真正显示的新结果' })
    await until(() => facts().length === 1 && facts()[0]?.kind === 'done' && facts()[0]?.id !== empty.id)
    const liveDone = facts()[0]!
    expect(liveDone.detail).toBe('这次真正显示的新结果')
    await window.wait({ text: '本轮已完成' })
    await until(() => facts()[0]?.id === liveDone.id && !facts()[0]!.unread)
    expect(facts()).toHaveLength(1)
    await window.capture({ label: '新结果实际呈现后已读，旧来源不再累积' })
    save('current-result-presented')
    await window.send('第四条：等我批准')
    await window.key('enter')
    await window.wait({ text: '批准这一次' })
    await window.wait({ text: '需要你决定' })
    await until(() => facts().some(one => one.kind === 'needs-you' && !one.unread))
    // 自动展开与未选择时按 Enter/旧字母均不能批准。
    await window.key('enter')
    await window.send('yan')
    await window.capture({ label: '待答呈现后已读，未选择和旧快捷键均未批准' })
    expect(fixture.requests()).toHaveLength(4)
    const db = readDatabase(join(sandbox.dataDir, 'records.db'))
    try { expect(db.events.filter((event) => event.kind === 'tool.decision')).toHaveLength(0) } finally { db.close() }
    expect(facts()).toHaveLength(1)
    expect(facts()[0]).toMatchObject({ session, kind: 'needs-you', unread: false })
    expect(facts()[0]!.id).not.toBe(liveDone.id)
    save('pending-read-not-answered')
    // 已读只确认呈现；先退出审批层，再走任务菜单停止，不产生工具批准。
    await window.key('esc', { until: { text: 'Tab 进入决策' } })
    await window.key('ctrl+c', { until: { text: '当前任务正在等待你' }, timeoutMs: 15_000 })
    await window.key('enter')
    await window.wait({ text: '停了' }, { timeoutMs: 30_000 })
    await until(() => facts().length === 0)
    const stopped = readDatabase(join(sandbox.dataDir, 'records.db'))
    try { expect(stopped.events.filter(event => event.kind === 'tool.decision' && JSON.parse(event.data).decider === 'user')).toHaveLength(0) } finally { stopped.close() }
    await window.send('第五条：展示失败')
    await window.key('enter')
    await window.wait({ text: '模型错误' })
    await window.wait({ text: '出错了' })
    await until(() => facts().some(one => one.kind === 'failed' && !one.unread))
    await window.capture({ label: '当前失败实际呈现后已读，先前结果与审批退出提醒' })
    expect(facts()).toHaveLength(1)
    expect(facts()[0]).toMatchObject({ session, kind: 'failed', unread: false })
    expect(facts()[0]!.detail).toContain('隔离失败验收')
    expect(fixture.requests()).toHaveLength(5)
    const history = readDatabase(join(sandbox.dataDir, 'records.db'))
    try {
      const replies = history.entries.filter(entry => entry.session === session && entry.kind === 'assistant').map(entry => entry.content_text)
      expect(replies).toContain('历史第一条结果')
      expect(replies).toContain('这次真正显示的新结果')
      expect(history.events.some(event => event.session === session && event.kind === 'model.error')).toBe(true)
      expect(history.events.filter(event => event.kind === 'tool.decision' && JSON.parse(event.data).decider === 'user')).toHaveLength(0)
    } finally { history.close() }
    save('current-failure-presented-history-preserved')
    passed = true
  } finally {
    headless?.close()
    await window?.close()
    await host?.close()
    await fixture.stop()
    await sandbox.dispose()
    if (passed) rmSync(evidence, { recursive: true, force: true })
    else console.log(`CLI 呈现诊断：${evidence}`)
  }
}, 60_000)
