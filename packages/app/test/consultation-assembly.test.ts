import { expect, test } from 'bun:test'
import { realpathSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRecordsStore } from '@magic/records'
import { createFauxGateway, type FauxTurn } from '@magic/faux'
import { attachShell } from '../src/index.ts'
import { createCollaborationBoundary } from '../src/collaboration-boundary.ts'
import { makeStage } from './support.ts'

for (const limited of [false, true]) test(`U115：可信用途优先于普通全工具角色，原许可交集 ${limited}，无协作边界也禁止实际写入`, async () => {
  const stage = makeStage({ config: { agentRoles: { all: { name: '普通全工具角色', instructions: '可以修改', tools: ['read', 'write', 'exec', 'plan_update'] },
    origin: { name: '发起角色', instructions: '查证', ...(limited ? { tools: ['read'] } : {}) } } } })
  const store = createRecordsStore({ dataDir: stage.dataDir, workspace: [realpathSync(stage.workspace)] })
  const r = store.collaboration
  const model = { alias: 'default' as const, provider: 'test', model: 'test' }
  const entryId = store.serviceFor('origin').appendEntry({ kind: 'user', content: { text: '用户原工作' }, at: 1 })
  const root = r.registerAgent({ operationId: 'root', sessionId: 'origin', name: '原工作', role: 'origin', model, at: 1 })
  const origin = { sessionId: 'origin', entryId }
  r.openCollaboration(root.agentId, { operationId: 'open', origin, at: 1 })
  const advisor = r.spawn(root.agentId, { operationId: 'spawn', sessionId: 'advisor', name: '咨询', role: 'all', purpose: 'consultation', model,
    scope: '查证', source: origin, authorization: [origin], body: [{ kind: 'text', text: '只读问题' }], at: 1 })
  r.respondToDelegation(advisor.agent.agentId, { operationId: 'accept', delegationId: advisor.delegation.delegationId, response: 'accept', at: 1 })
  writeFileSync(join(stage.workspace, 'probe.txt'), '原值')
  store.close()
  const turns: readonly FauxTurn[] = [{ toolCalls: [
    { id: 'forged-external-read', name: 'read', args: { path: 'probe.txt' } },
    { name: 'write', args: { path: 'probe.txt', content: '错误副作用' } }, { name: 'read', args: { path: 'probe.txt' } },
  ] }, { text: '建议' }]
  let gateway: ReturnType<typeof createFauxGateway> | undefined
  const app = stage.assemble({ session: 'advisor', allowAll: true, modelGateway(stamper) {
    gateway = createFauxGateway({ stamper, turns })
    const controlled = gateway
    return { ...controlled, stream(request, options) {
      const flow = controlled.stream(request, options)
      return { ...flow, result: flow.result.then(result => ({ ...result, toolCalls: result.toolCalls?.map(call => call.id === 'forged-external-read'
        ? { ...call, external: { server: 'same-name', tool: 'read' } } : call) })) }
    } }
  } }) // 刻意不给 collaboration，真实分发自身拒绝伪造外部同名 read 和 write。

  const shell = attachShell(app.shell)
  try {
    await shell.submit('查证')
    expect(readFileSync(join(stage.workspace, 'probe.txt'), 'utf8')).toBe('原值')
    const outputs = shell.events.filter(event => event.kind === 'tool.result')
    expect(outputs.map(event => event.data.ok)).toEqual([false, false, true])
    expect(JSON.stringify(gateway!.requests)).toContain('原值')
    const boundary = createCollaborationBoundary({ records: app.records.collaboration, session: 'advisor', runId: 'fake', model: () => model,
      tools: () => undefined, now: Date.now, changed() {} }).boundary
    expect(boundary.admit({ id: 'forged', name: 'read', args: {}, external: { server: 'same-name', tool: 'read' } })).toContain('咨询只允许')
    expect(boundary.admit({ id: 'forged2', name: 'agent_spawn', args: {} })).toContain('咨询只允许')
    const evidence = process.env['MAGIC_CONSULT_ASSEMBLY_EVIDENCE']
    if (evidence) {
      mkdirSync(evidence, { recursive: true })
      writeFileSync(join(evidence, `u115-assembly-${limited}.json`), JSON.stringify({ proof: 'real-assembly-tool-runtime-faux-model-no-collaboration-boundary',
        limitedOriginTools: limited, consultationIdentity: advisor.agent, allowAll: true, requests: gateway!.requests, events: shell.events,
        probe: readFileSync(join(stage.workspace, 'probe.txt'), 'utf8') }, null, 2))
    }
  } finally { shell.dispose(); app.close(); stage.dispose() }
})
