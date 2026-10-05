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

test('无可靠焦点证据：真实渲染/历史/汇总均保留三类未读，显示待答不代表批准', async () => {
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
    window = await createUiSession({ label: '具体事项呈现', sandbox, fixture, artifacts: evidence, argv: ['--session', session] })
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
    expect(done.every((one) => one.unread)).toBe(true)
    await window.capture({ label: '实时结果仍未读' })
    save('live-done-unread')
    await window.send('第四条：等我批准')
    await window.key('enter')
    await window.wait({ text: 'Ctrl+G 审阅' })
    await until(() => facts().some((one) => one.kind === 'needs-you'))
    expect(facts().filter((one) => one.kind === 'needs-you').every((one) => one.unread)).toBe(true)
    await window.capture({ label: '待答保持未读且未批准' })
    expect(fixture.requests()).toHaveLength(4)
    const db = readDatabase(join(sandbox.dataDir, 'records.db'))
    try { expect(db.events.filter((event) => event.kind === 'tool.decision')).toHaveLength(0) } finally { db.close() }
    expect(facts().filter((one) => one.kind === 'needs-you')).toHaveLength(1)
    save('pending-unread-not-answered')
    // **原预期 → 新预期**（U109 · 合并 U100 之后）：
    //
    // - 原预期：卡挂着时一下 `ctrl+c` ⇒ 「替用户中断本轮」，等屏上回到 `○ 空闲`。
    // - 为何变：U100 起有在途工作时那一下**只把问题摆出来**（三选：停止任务／转到后台／
    //   停止并退出），**不再替用户中断**；此刻停这一轮的入口是**三选第一项「停止任务」**
    //   （默认高亮，回车即达），回执是**「停了」**（核销那一拍）。
    // - 新预期：`ctrl+c` ⇒ 三选（标题「当前任务正在等待你」）⇒ 回车 ⇒ 「停了」。
    // - 依据：`main` 自己的用例 `run-terminal.test.ts` 那段「U100 改判（原锚 / 为何变 /
    //   新锚）」（`:219-226`）与 `stopAndStay`（`:508-514`）。
    // - **判据没变弱**：这一下要证的仍是「那张卡**没被答复**、这一轮就此打住」——卡未批准
    //   那两条断言（`tool.decision` 为 0、`needs-you` 仍是未读）原样留在下面。
    await window.key('ctrl+c', { until: { text: '当前任务正在等待你' }, timeoutMs: 15_000 })
    await window.key('enter')
    await window.wait({ text: '停了' }, { timeoutMs: 30_000 })
    await window.send('第五条：展示失败')
    await window.key('enter')
    await window.wait({ text: '模型错误' })
    await until(() => facts().some((one) => one.kind === 'failed'))
    await window.capture({ label: '失败真实显示仍未读' })
    expect(facts().every((one) => one.unread)).toBe(true)
    expect(new Set(facts().map((one) => one.kind))).toEqual(new Set(['done', 'needs-you', 'failed']))
    save('all-three-remain-unread')
  } finally {
    headless.close()
    await window?.close()
    await host.close()
    await fixture.stop()
    await sandbox.dispose()
    console.log(`CLI 呈现证据：${evidence}`)
  }
}, 60_000)
