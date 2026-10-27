import { expect, test } from 'bun:test'
import type { ModelRequest } from '@magic/contracts'
import { createFauxGateway, type FauxTurn } from '@magic/faux'
import { attachShell, type Assembly } from '../src/index.ts'
import { makeStage } from './support.ts'
const textOf = (request: ModelRequest) => JSON.stringify(request.messages)

test('长用户要求完整送达，历史分页的entry/offset到达真实下一次请求', async () => {
  const stage = makeStage()
  const requests: ModelRequest[] = []
  let original = 0
  const text = `${'甲'.repeat(2500)}精确尾部要求`
  let app!: Assembly
  app = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
    requests.push(request)
    if (requests.length === 1) original = app.records.serviceFor(app.session!).inputs.list().find(row => row.entry !== undefined)!.entry!
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
