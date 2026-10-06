/** 真 stdin 宿主 + 真 PTY + records.db；帧与事项快照保留在隔离证据目录。 */
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
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

test('具体事项实际呈现才已读，握手/历史/汇总不消费未读，三类事项与审批答复独立', async () => {
  const evidence = join(tmpdir(), 'magic-resident-cli-evidence', `presentation-${crypto.randomUUID()}`)
  mkdirSync(evidence, { recursive: true })
  const fixture = startFixture({ turns: [
    { kind: 'text', text: '历史第一条结果' }, { kind: 'text', text: '' },
    { kind: 'text', text: '这次真正显示的新结果' },
    { kind: 'tool', name: 'exec', args: { cmd: 'chmod 755 .' } },
    { kind: 'http', status: 400, message: '隔离失败验收' },
  ] })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const host = await startResidentHost(sandbox, join(evidence, 'host'))
  const headless = await connectManager(host.discovery.socket, { cwd: sandbox.workspace })
  if (headless === undefined) throw new Error('专用宿主未连接')
  const facts = () => attentionFacts(sandbox.dataDir, sandbox.workspace)
  const save = (name: string) => writeFileSync(join(evidence, `${name}.json`), JSON.stringify(facts(), null, 2))
  let window: UiSession | undefined
  try {
    headless.send({ type: 'input.submit', text: '第一条：留历史结果' })
    await until(() => facts().filter((one) => one.kind === 'done').length === 1)
    headless.send({ type: 'input.submit', text: '第二条：空答轮' })
    await until(() => facts().filter((one) => one.kind === 'done').length === 2)
    const original = facts().filter((one) => one.kind === 'done')
    expect(original.every((one) => one.unread)).toBe(true)
    const session = original[0]!.session
    headless.send({ type: 'history.read', session })
    await Bun.sleep(20)
    expect(facts().every((one) => one.unread)).toBe(true)
    save('headless-unread')
    headless.close()
    window = await createUiSession({ label: '具体事项呈现', sandbox, fixture, artifacts: evidence, argv: ['resume', session] })
    await window.wait({ text: '你不在的时候' })
    await window.wait({ text: '历史第一条结果' })
    await window.capture({ label: '历史接回仍未读' })
    expect(facts().filter((one) => one.kind === 'done').map((one) => one.unread)).toEqual([true, true])
    save('history-remains-unread')
    await window.send('第三条：显示新结果')
    await window.key('enter')
    await window.wait({ text: '这次真正显示的新结果' })
    await until(() => facts().filter((one) => one.kind === 'done').length === 3)
    const done = facts().filter((one) => one.kind === 'done')
    expect(done).toHaveLength(3)
    const liveDone = done.find(one => !original.some(old => old.id === one.id))!
    await window.wait({ text: '本轮已完成' })
    await until(() => facts().find(one => one.id === liveDone.id)?.unread === false)
    expect(facts().filter(one => original.some(old => old.id === one.id)).map(one => one.unread)).toEqual([true, true])
    await window.capture({ label: '具体完成事项呈现后已读，历史仍未读' })
    save('live-done-read-history-unread')
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
    expect(facts().filter((one) => one.kind === 'needs-you')).toHaveLength(1)
    save('pending-read-not-answered')
    // 已读只确认呈现；先退出审批层，再走任务菜单停止，不产生工具批准。
    await window.key('esc', { until: { text: 'Tab 进入决策' } })
    await window.key('ctrl+c', { until: { text: '当前任务正在等待你' }, timeoutMs: 15_000 })
    await window.key('enter')
    await window.wait({ text: '停了' }, { timeoutMs: 30_000 })
    const stopped = readDatabase(join(sandbox.dataDir, 'records.db'))
    try { expect(stopped.events.filter(event => event.kind === 'tool.decision')).toHaveLength(0) } finally { stopped.close() }
    await window.send('第五条：展示失败')
    await window.key('enter')
    await window.wait({ text: '模型错误' })
    await window.wait({ text: '出错了' })
    await until(() => facts().some(one => one.kind === 'failed' && !one.unread))
    await window.capture({ label: '三类具体事项均已读，历史两项仍未读' })
    expect(facts().filter(one => original.some(old => old.id === one.id)).map(one => one.unread)).toEqual([true, true])
    expect(facts().filter(one => !original.some(old => old.id === one.id)).map(one => one.unread)).toEqual([false, false, false])
    expect(new Set(facts().map((one) => one.kind))).toEqual(new Set(['done', 'needs-you', 'failed']))
    expect(fixture.requests()).toHaveLength(5)
    save('all-three-presented-history-unread')
  } finally {
    headless.close()
    await window?.close()
    await host.close()
    await fixture.stop()
    await sandbox.dispose()
    console.log(`CLI 呈现证据：${evidence}`)
  }
}, 60_000)
