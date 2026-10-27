import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { createRecordsStore } from '@magic/records'
import { createShell } from '@magic/tui'
import { resolveMagicHome } from '@magic/contracts'
import type { Command, KernelEvent } from '@magic/contracts'
import { startManager } from '../src/run/manager.ts'
import { connectManager } from '../src/run/client.ts'
import { clientTransport } from '../src/run/terminal.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { tempDir, removeDir } from './tmp.ts'

async function until(check: () => boolean) {
  const end = Date.now() + 2500
  while (!check() && Date.now() < end) await Bun.sleep(5)
  expect(check()).toBe(true)
}

test('真实 TUI→Engine→记录读取/来源链不启动执行者，纠正绑定进草稿不写库', async () => {
  const root = tempDir('magic-memory-engine-'), magic = resolveMagicHome({}, root)
  const store = createRecordsStore({ dataDir: magic.base, workspace: [root] })
  const records = store.serviceFor('session')
  const original = '必须保持这一条原始要求。'.repeat(900) + '来源原文末尾'
  const entry = records.appendEntry({ kind: 'user', content: { text: original }, at: 1 })
  store.serviceFor('other').appendEntry({ kind: 'user', content: { text: '另一会话' }, at: 2 })
  const note = join(magic.base, 'notes', 'session', 'MEMORY.md')
  mkdirSync(join(magic.base, 'notes', 'session'), { recursive: true })
  const content = `长期要求 [原文](session#${entry})`
  writeFileSync(note, content)
  let launched = 0
  const started = await startManager({ magic, paths: runPathsOf(magic, '/tmp'), launch: { spawn() { launched++; throw new Error('只读操作不得启动执行者') } } })
  if (started.role !== 'manager') { store.close(); removeDir(root); throw new Error(`Engine 未启动：${JSON.stringify(started)}`) }
  const client = await connectManager(started.manager.socketPath, { session: 'session', cwd: root })
  if (!client) throw new Error('终端连接失败')
  const events: KernelEvent[] = [], commands: Command[] = []
  client.onEvent(event => events.push(event))
  const transport = clientTransport(client)
  const shell = createShell({ subscribe: transport.subscribe, send(command) { commands.push(command); transport.send(command) } }, { magicBase: magic.base, inputReady: true })
  const type = (text: string) => { for (const char of text) shell.key({ kind: 'char', char }) }
  const select = (value: string) => {
    const view = shell.getView()
    if (view.dock.kind !== 'picker') throw new Error('未进入阅读层')
    const delta = view.dock.picker.rows.findIndex(row => row.value === value) - view.dock.picker.selected
    for (let n = 0; n < Math.abs(delta); n++) shell.key({ kind: delta > 0 ? 'down' : 'up' })
    shell.key({ kind: 'enter' })
  }
  try {
    client.send({ type: 'session.list' })
    await until(() => shell.getView().sessionId === 'session')
    type('/memory '); shell.key({ kind: 'enter' })
    await until(() => events.some(event => event.kind === 'memory.state'))
    select('link:0')
    await until(() => events.some(event => event.kind === 'memory.source'))
    const source = events.find(event => event.kind === 'memory.source')
    if (source?.kind !== 'memory.source' || !source.data.page) throw new Error('未取得来源分页')
    let page = source.data.page, text = page.text, pages = 1
    while (page.next !== undefined) {
      const before = events.filter(event => event.kind === 'memory.source').length
      select('next-source')
      await until(() => events.filter(event => event.kind === 'memory.source').length > before)
      const next = events.findLast(event => event.kind === 'memory.source')
      if (next?.kind !== 'memory.source' || !next.data.page) throw new Error('未取得后续来源')
      expect(next.data.page.source.offset).toBe(page.next)
      page = next.data.page; text += page.text; pages++
    }
    expect(pages).toBeGreaterThan(1)
    expect(text).toBe(original)
    for (let n = 0; n < pages; n++) shell.key({ kind: 'escape' })
    select('correct-note')
    expect(shell.getView().refs[0]).toMatchObject({ kind: 'note', source: 'MEMORY.md', session: 'session' })
    expect(readFileSync(note, 'utf8')).toBe(content)
    expect(commands.some(command => command.type === 'input.submit')).toBe(false)
    // 换目标后不得把旧会话的纠正变成对新会话的交代，更不能为拒绝动作启动 Agent。
    client.send({ type: 'session.open', session: 'other' })
    await until(() => shell.getView().sessionId === 'other')
    client.send({ type: 'input.submit', ref: 'wrong-correction-target', text: '纠正旧事项', refs: [{
      kind: 'note', source: 'MEMORY.md', session: 'session', at: 0, marker: '纠正旧事项',
    }] })
    await until(() => events.some(event => event.kind === 'input.settled' && event.data.ref === 'wrong-correction-target'))
    expect(events.findLast(event => event.kind === 'input.settled')).toMatchObject({ session: 'other', data: { ok: false, reason: expect.stringContaining('发送目标不一致') } })
    expect(store.serviceFor('other').inputs.list()).toEqual([])
    expect(readFileSync(note, 'utf8')).toBe(content)
    expect(launched).toBe(0)
    expect(started.manager.executors()).toHaveLength(0)
  } finally {
    shell.dispose(); client.close(); started.manager.stop('隔离检查完成'); await started.manager.waitUntilExit(); store.close(); removeDir(root)
  }
})

test('真实shell到Engine执行器：会话引用落盘并送达模型，召回守住上界，普通纠正读取目标当前正文', async () => {
  const { collaborationRuntime } = await import('./run-collaboration-fixture.ts')
  const f = await collaborationRuntime('memory-reference-delivery', () => ({ text: '引用与纠正对象已收到' }))
  const type = (text: string) => { for (const char of text) f.shell.key({ kind: 'char', char }) }
  const idle = () => f.manager.runs().some(run => run.session === f.session() && run.state === 'idle')
  try {
    const origin = f.store.serviceFor('origin')
    origin.appendEntry({ kind: 'user', at: 1, content: { text: 'ORIGINAL_SOURCE：仍需核查依据' } })
    f.store.setSessionTitle('origin', '历史来源', 1)
    f.store.setSessionArchived('origin', true)
    f.store.serviceFor('same-title').appendEntry({ kind: 'user', at: 1, content: { text: 'WRONG_SAME_TITLE_SOURCE' } })
    f.store.setSessionTitle('same-title', '历史来源', 1)
    type('@历史来源')
    await f.wait('会话候选', () => { const dock = f.shell.getView().dock; return dock.kind === 'picker' && dock.picker.rows.some(row => row.value === 'session:origin') })
    f.pick('session:origin')
    const through = origin.appendEntry({ kind: 'assistant', at: 2, content: { text: 'BEFORE_ACCEPT：选择后、受理前的补充' } })
    type(' 请核查'); f.shell.key({ kind: 'enter' })
    await f.wait('首轮真实模型调用与消费完成', () => f.calls.length === 1 && idle())
    const target = f.session()!, records = f.store.serviceFor(target)
    const first = records.inputs.list().find(row => row.input.refs?.some(ref => ref.kind === 'session'))!
    expect(first.state).toBe('included')
    expect(first.input.refs?.[0]).toMatchObject({ kind: 'session', source: 'origin', through })
    const written = (await Array.fromAsync(records.readEntries(target))).find(entry => entry.id === first.entry)
    expect(written?.payload && 'refs' in written.payload && written.payload.refs?.[0]).toMatchObject({ kind: 'session', source: 'origin', through })
    const main = (index: number) => JSON.stringify(f.calls[index]?.body['messages'])
    expect(main(0)).toContain('ORIGINAL_SOURCE')
    expect(main(0)).toContain('BEFORE_ACCEPT')
    expect(main(0)).toContain('本次材料 · 历史会话')
    expect(main(0)).not.toContain('WRONG_SAME_TITLE_SOURCE')
    expect(f.store.isSessionArchived('origin')).toBe(true)
    expect(f.manager.runs().some(run => run.session === 'origin' || run.session === 'same-title')).toBe(false)
    origin.appendEntry({ kind: 'user', at: 3, content: { text: 'AFTER_ACCEPT_MUST_STAY_OUT' } })
    f.shell.key({ kind: 'up' }); f.shell.key({ kind: 'enter' })
    await f.wait('历史召回实际送达', () => f.calls.length === 2 && idle())
    expect(main(1)).not.toContain('AFTER_ACCEPT_MUST_STAY_OUT')
    expect(records.inputs.list().filter(row => row.state === 'included')).toHaveLength(2)
    const note = join(f.magic.base, 'notes', target, 'MEMORY.md')
    mkdirSync(join(f.magic.base, 'notes', target), { recursive: true })
    const before = '保留当前约束'
    writeFileSync(note, before)
    type('/memory '); f.shell.key({ kind: 'enter' })
    await f.wait('工作记忆实际返回', () => { const dock = f.shell.getView().dock; return dock.kind === 'picker' && dock.picker.rows.some(row => row.value === 'correct-note') })
    f.pick('correct-note')
    expect(f.shell.getView().flash ?? '').not.toContain('已加入纠正对象')
    type(' 修改为仍需逐项验证'); f.shell.key({ kind: 'enter' })
    await f.wait('纠正对象实际送达', () => f.calls.length === 3 && idle())
    expect(main(2)).toContain('本次材料 · 所选纠正对象')
    expect(main(2)).toContain('保留当前约束')
    const correction = records.inputs.list().find(row => row.input.refs?.some(ref => ref.kind === 'note'))!
    const correctionEntry = (await Array.fromAsync(records.readEntries(target))).find(entry => entry.id === correction.entry)
    expect(correctionEntry?.payload && 'refs' in correctionEntry.payload && correctionEntry.payload.refs?.[0]).toMatchObject({ kind: 'note', source: 'MEMORY.md', session: target })
    expect(readFileSync(note, 'utf8')).toEqual(before)
    expect(f.events.filter(event => event.kind === 'error')).toEqual([])
    expect(f.errors).toEqual([])
  } finally { await f.close() }
}, 30000)
