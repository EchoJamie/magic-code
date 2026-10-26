/** 真实装配中的事项增量、计划投影、历史回查与明确接续。模型受控，不证明语义效果。 */
import { expect, test } from 'bun:test'
import type { MemoryChange, ModelRequest } from '@magic/contracts'
import { createFauxGateway, type FauxTurn } from '@magic/faux'
import { attachShell, type Assembly } from '../src/index.ts'
import { createPlanReader } from '@magic/conversation'
import { makeStage, eventsOfKind } from './support.ts'

const textOf = (request: ModelRequest) => request.messages.map(message => message.role === 'tool' ? message.output : message.content).join('\n')
function mainSource(request: ModelRequest): number {
  const ids = [...textOf(request).matchAll(/#(\d+) user/g)].map(match => Number(match[1]))
  const id = ids.at(-1)
  if (id === undefined) throw new Error('请求没有用户来源位置')
  return id
}

test('实际工具增量更新要求和步骤，清步骤保留其他认识；计划事件和只读投影一致', async () => {
  const stage = makeStage()
  const requests: ModelRequest[] = []
  let app!: Assembly; let update = 0
  app = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
    requests.push(request)
    const records = app.records.serviceFor(app.session!)
    const memory = records.memory.read()
    let turn: FauxTurn
    if (requests.length % 2 === 0) turn = { text: '已按当前要求处理' }
    else {
      const sources = [{ session: app.session!, entry: mainSource(request) }]
      const base = { evidence: 'fact' as const, status: 'active' as const, sources }
      const changes: MemoryChange[] = update++ === 0 ? [
        { ...base, id: 'goal', kind: 'goal', text: '修复登录失败提示' },
        { ...base, id: 'requirement', kind: 'requirement', text: '保留用户输入' },
        { ...base, id: 'step', kind: 'step', text: '核对失败分支', order: 0, progress: 'in_progress' },
      ] : update === 2 ? [{ ...memory.items.find(item => item.id === 'requirement')!, text: '保留用户输入和焦点', sources }]
        : [{ ...memory.items.find(item => item.id === 'step')!, status: 'resolved', sources }]
      turn = { toolCalls: [{ name: 'memory_update', args: { expectedRevision: memory.revision, changes } }] }
    }
    return createFauxGateway({ stamper, turns: [turn] }).stream(request, options)
  } }) })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('修复登录失败提示，保留用户输入')
    await shell.submit('补充：也要保留焦点')
    await shell.submit('已完成，清除步骤')
    const records = app.records.serviceFor(app.session!)
    const memory = records.memory.read()
    expect(memory.items.find(item => item.id === 'requirement')?.text).toBe('保留用户输入和焦点')
    expect(memory.items.find(item => item.id === 'goal')?.text).toBe('修复登录失败提示')
    const projection = await createPlanReader({ records, session: app.session! }).readPlan()
    expect(projection.plan).toMatchObject({ goal: '修复登录失败提示', steps: [], notes: '保留用户输入和焦点' })
    expect(eventsOfKind(shell.events, 'plan.changed').at(-1)?.data.plan).toEqual(projection.plan)
    const names = requests[0]!.tools!.map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining(['memory_read', 'memory_update', 'source_read', 'plan_read', 'history_read']))
    expect(names).not.toContain('plan_update')
    expect(textOf(requests[5]!)).toContain('保留用户输入和焦点')
  } finally { shell.dispose(); app.close(); stage.dispose() }
})

test('同会话重开保留事项，无新执行的只读查询不调用模型；其他会话不串', async () => {
  const stage = makeStage()
  const first = stage.assemble({ turns: [{ text: '确认' }] })
  const shell = attachShell(first.shell)
  try {
    await shell.submit('记住本工作要求')
    const session = first.session!
    const records = first.records.serviceFor(session)
    const entry = (await records.readEntriesBack(session, undefined, 10)).find(item => item.kind === 'user')!.id
    records.memory.update({ expectedRevision: 0, changes: [{ id: 'req', kind: 'requirement', text: '本工作要求', evidence: 'fact', status: 'active', sources: [{ session, entry }] }] })
    shell.dispose(); first.close()
    let calls = 0
    const reopened = stage.assemble({ session, modelGateway: stamper => ({ stream(request, options) { calls += 1; return createFauxGateway({ stamper, turns: [{ text: '继续核对' }] }).stream(request, options) } }) })
    const again = attachShell(reopened.shell)
    try {
      expect(reopened.records.serviceFor(session).memory.read().items[0]?.text).toBe('本工作要求')
      expect(reopened.records.serviceFor('unrelated').memory.read().items).toHaveLength(0)
      expect(calls).toBe(0)
      await again.submit('明确继续')
      expect(calls).toBe(1)
    } finally { again.dispose(); reopened.close() }
  } finally { shell.dispose(); first.close(); stage.dispose() }
})

test('长用户要求完整送达，历史分页的entry/offset到达真实下一次请求', async () => {
  const stage = makeStage()
  const requests: ModelRequest[] = []
  let original = 0
  const text = `${'甲'.repeat(2500)}精确尾部要求`
  const app = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
    requests.push(request)
    if (requests.length === 1) original = mainSource(request)
    const turn: FauxTurn = requests.length === 2 ? { toolCalls: [{ name: 'history_read', args: { entry: original } }] } : { text: '确认' }
    return createFauxGateway({ stamper, turns: [turn] }).stream(request, options)
  } }) })
  const shell = attachShell(app.shell)
  try {
    await shell.submit(text)
    expect(textOf(requests[0]!)).toContain(text)
    await shell.submit('回查原始要求')
    const output = requests[2]!.messages.filter(message => message.role === 'tool').map(message => message.output).join('\n')
    expect(output).toContain('节选')
    expect(output).toContain(`entry=${original} offset=2000`)
    expect(output).not.toContain('甲'.repeat(2500))
  } finally { shell.dispose(); app.close(); stage.dispose() }
})
