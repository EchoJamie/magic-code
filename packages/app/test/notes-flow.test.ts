import { expect, test } from 'bun:test'
import { readFile, writeFile, unlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelRequest } from '@magic/contracts'
import { createFauxGateway, type FauxTurn } from '@magic/faux'
import { createWorkingNotes } from '@magic/execution'
import { createPlanReader } from '@magic/conversation'
import { attachShell, type Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage } from './support.ts'

const textOf = (request: ModelRequest) => JSON.stringify(request.messages)

test('真实装配：自身笔记六工具独立于工作区，计划只更新步骤且不修改笔记', async () => {
  const stage = makeStage()
  let app!: Assembly, calls = 0
  const requests: ModelRequest[] = []
  app = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
    requests.push(request)
    const path = join(stage.dataDir, 'notes', app.session!, 'MEMORY.md')
    const turns: FauxTurn[] = [
      { toolCalls: [{ name: 'write', args: { path, content: '约束：保留用户输入\n验证：尚未核对' } }] },
      { toolCalls: [{ name: 'edit', args: { path, old: '尚未核对', new: '已核对输入，焦点未验' } }] },
      { toolCalls: [{ name: 'read', args: { path, limit: 8 } }] },
      { toolCalls: [{ name: 'read', args: { path, offset: 8 } }] },
      { toolCalls: [{ name: 'plan_update', args: { steps: [{ text: '核对焦点', status: 'pending' }] } }] },
      { toolCalls: [{ name: 'plan_update', args: { steps: [] } }] },
      { text: '已保存笔记，计划步骤已清空' },
    ]
    return createFauxGateway({ stamper, turns: [turns[calls++]!] }).stream(request, options)
  } }) })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('保存本次约束并记录验证范围')
    expect(eventsOfKind(shell.events, 'error')).toEqual([])
    const calls = eventsOfKind(shell.events, 'tool.call')
    expect(eventsOfKind(shell.events, 'tool.decision').map(event => calls.find(call => call.id === event.data.call)?.data.name)).toEqual(['plan_update', 'plan_update'])
    expect(eventsOfKind(shell.events, 'tool.result').filter(event => !event.data.ok)).toEqual([])
    expect(app.workspaceRoots).toEqual([await realpath(stage.workspace)])
    expect(await readFile(join(stage.dataDir, 'notes', app.session!, 'MEMORY.md'), 'utf8')).toBe('约束：保留用户输入\n验证：已核对输入，焦点未验')
    expect((await createPlanReader({ records: app.records.serviceFor(app.session!), session: app.session! }).readPlan()).plan?.steps).toEqual([])
    const names = requests[0]!.tools!.map(tool => tool.name)
    expect(names).toContain('plan_update')
    expect(names).not.toContain('memory_update')
    expect(names).not.toContain('memory_read')
    expect(textOf(requests[4]!)).toContain('焦点未验')
  } finally { shell.dispose(); await app.shutdown(); stage.dispose() }
})

test('普通纠正提交读取最新正文，实际 edit 保存；缺失或错会话拒绝整条并保稿', async () => {
  const stage = makeStage()
  let app!: Assembly, calls = 0
  const requests: ModelRequest[] = []
  app = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
    requests.push(request)
    const path = join(stage.dataDir, 'notes', app.session!, 'MEMORY.md')
    const turn: FauxTurn = calls++ === 1 ? { toolCalls: [{ name: 'edit', args: { path, old: '外部更新：焦点未验', new: '外部更新：焦点已验' } }] } : { text: '已处理当前输入' }
    return createFauxGateway({ stamper, turns: [turn] }).stream(request, options)
  } }) })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('建立隔离工作')
    const session = app.session!, notes = createWorkingNotes(stage.dataDir, session), path = join(notes.directory, 'MEMORY.md')
    await notes.bindTarget(notes.resolve(path)!, 'write').sandbox.write(path, { text: '最初内容' })
    await writeFile(path, '外部更新：焦点未验\n独立约束仍保留')
    const refs = [{ kind: 'note' as const, session, source: 'MEMORY.md', at: 0, marker: '@笔记' }]
    await shell.submit({ text: '@笔记 已确认焦点，修正这一处', refs })
    expect(eventsOfKind(shell.events, 'input.settled').filter(event => !event.data.ok)).toEqual([])
    expect(textOf(requests[1]!)).toContain('外部更新：焦点未验')
    expect(await readFile(path, 'utf8')).toBe('外部更新：焦点已验\n独立约束仍保留')
    expect(eventsOfKind(shell.events, 'tool.result').at(-1)?.data.ok).toBe(true)
    await unlink(path)
    const before = calls
    await shell.submit({ text: '@笔记 再改', refs, ref: 'missing-note' })
    await shell.submit({ text: '@笔记 错会话', refs: [{ ...refs[0]!, session: 'other' }], ref: 'wrong-note' })
    expect(calls).toBe(before)
    for (const ref of ['missing-note', 'wrong-note']) expect(eventsOfKind(shell.events, 'input.settled').filter(event => event.data.ref === ref).at(-1)?.data.ok).toBe(false)
  } finally { shell.dispose(); await app.shutdown(); stage.dispose() }
})
