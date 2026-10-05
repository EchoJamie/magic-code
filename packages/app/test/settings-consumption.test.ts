import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import type { NativeResponse, SettingsAction } from '@magic/contracts'
import { linkOf, socketHandlers } from '../src/run/wire.ts'
import { collaborationRuntime, latch, spawnMember } from './run-collaboration-fixture.ts'

// 保存走真实原生入口；消费走真实 manager / executor / 成员创建和本地 HTTP。
test('原生保存后新成员采用新档位与独立思考，入口和已有成员保留；真实执行责任拒改数据', async () => {
  const held = latch(), newHeld = latch()
  const f = await collaborationRuntime('u116-settings-consumption', async call => {
    if (call.model === 'member-model') { await held.promise; return { text: '原成员保留原组合' } }
    if (call.model === 'descendant-model') { await newHeld.promise; return { text: '新角色采用已保存档位' } }
    if (call.index === 0) return spawnMember
    if (call.index === 2) return { tool: 'agent_spawn', args: { operationId: 'u116-new-member', name: '新审查者', role: 'reviewer', responsibility: '检查新配置的实际消费', scope: '只读设置事实', body: [{ kind: 'text', text: '依据当前配置独立检查' }] } }
    return { text: '入口仍保持 entry-model' }
  })
  const identity = f.manager.identity
  const link = linkOf<NativeResponse>(await Bun.connect({ unix: f.manager.socketPath, socket: socketHandlers() }) as never)
  const responses: NativeResponse[] = []; link.onMessage(v => responses.push(v))
  const target = { serviceInstance: identity.serviceInstance, dataDir: identity.dataDir }
  let stamp: string | null = null
  async function request(action?: SettingsAction) {
    const request = crypto.randomUUID()
    link.send(action ? { t: 'native.settings.apply', request, ...target, stamp, action } : { t: 'native.settings.read', request, ...target })
    await f.wait('设置结果', () => responses.some(v => v.t === 'native.settings.result' && v.request === request))
    const result = responses.find((v): v is Extract<NativeResponse, { t: 'native.settings.result' }> => v.t === 'native.settings.result' && v.request === request)!
    if (result.snapshot) stamp = result.snapshot.stamp
    return result
  }
  try {
    link.send({ t: 'hello', role: 'observer', protocol: identity.protocol, version: identity.version, source: identity.source, dataDir: identity.dataDir })
    await f.wait('观察握手', () => responses.some(v => v.t === 'native.welcome'))
    expect((await request()).snapshot?.mcp).toEqual([]); expect(f.manager.executors()).toEqual([])
    f.client.send({ type: 'input.submit', text: '先委派一个独立成员。' })
    await f.wait('原成员正在调用', () => f.requests('member-model').length === 1 && f.member() !== undefined)
    const oldMember = f.member()!
    expect((await request()).snapshot?.canChangeData).toBe(false)
    const configPath = join(f.magic.base, 'config.json'), before = readFileSync(configPath, 'utf8')
    expect((await request({ type: 'data.set', directory: join(f.root, 'other-data') })).error).toContain('执行责任')
    expect(readFileSync(configPath, 'utf8')).toBe(before)
    expect((await request({ type: 'model.alias.set', alias: 'spell', provider: 'controlled', model: 'descendant-model' })).error).toBeUndefined()
    expect((await request({ type: 'model.alias.set', alias: 'default', provider: 'controlled', model: 'descendant-model' })).error).toBeUndefined()
    expect((await request({ type: 'role.save', id: 'reviewer', role: { name: '审查者', instructions: '根据实际依据审查', tools: [], model: { alias: 'spell', reasoning: { mode: 'off' } } } })).error).toBeUndefined()
    expect((await request({ type: 'prefs.set', reducedMotion: true })).error).toBeUndefined()
    expect(f.events.some(e => e.kind === 'prefs.state' && e.data.reducedMotion)).toBe(true)
    const current = f.store.collaboration.getAgent(oldMember.agentId)!
    expect(current.model.model).toBe('member-model'); expect(current.model.alias).toBe('spell')
    expect(f.requests('descendant-model')).toHaveLength(0)
    await f.wait('入口空闲可接下一项', () => f.manager.runs().find(one => one.session === f.session())?.state === 'idle')
    f.client.send({ type: 'input.submit', text: '再按 reviewer 角色创建一个成员检查。' })
    await f.wait('新成员出站采用已保存型号', () => f.requests('descendant-model').length === 1)
    const fresh = f.members().find(one => one.role === 'reviewer')!
    expect(fresh.model.alias).toBe('spell'); expect(fresh.model.reasoning).toEqual({ mode: 'off' })
    const body = f.requests('descendant-model')[0]!.body
    expect(body.thinking).toEqual({ type: 'disabled' })
    const toolNames = (body.tools as { function: { name: string } }[]).map(tool => tool.function.name)
    expect(toolNames).toEqual(['agent_list', 'agent_spawn', 'agent_message', 'agent_wait', 'agent_control']) // 协作通信保留，普通执行工具全部收窄。
    expect(f.requests('member-model')).toHaveLength(1); expect(f.requests('entry-model').length).toBeGreaterThanOrEqual(3)
    expect(f.store.collaboration.getAgent(f.collaboration()!.coordinatorId)?.model.model).toBe('entry-model')
    const evidence = process.env['MAGIC_SETTINGS_EVIDENCE']
    if (evidence) writeFileSync(evidence, JSON.stringify({ entry: 'native.settings.apply → manager → actual member executor → local HTTP', existingModel: current.model, newModel: fresh.model, requests: f.calls.map(({model,body}) => ({model, thinking:body.thinking, reasoning_effort:body.reasoning_effort, toolCount:Array.isArray(body.tools)?body.tools.length:0})), dataChangeRejected:true, preferencesAdopted:true }, null, 2))
  } finally { held.release(); newHeld.release(); link.close(); await f.close() }
}, 30000)
