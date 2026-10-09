import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentModelConfig, AgentRoleConfig, CollaborationReply, ModelInfoSnapshot } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { assemble } from '../src/assembly.ts'
import { resolveManagedModel } from '../src/agent-models.ts'
import { loadConfig } from '../src/config.ts'
import { cacheAccessFor } from '../src/cache-access.ts'
import { createFileModelInfoCache } from '../src/model-cache.ts'
import { attachShell } from '../src/shell.ts'
import { magicAt, tempDir, removeDir } from './tmp.ts'

type Wire = { route: string; body: Record<string, unknown> }
function setup(rolePatch: Partial<AgentRoleConfig> = {}, image?: boolean) {
  const root = tempDir('magic-collaboration-models-')
  const magic = magicAt(root)
  const workspace = join(root, 'original')
  const changed = join(root, 'changed')
  const dataDir = magic.base
  const guide = join(root, 'guidance.md')
  const skillDir = join(workspace, '.magic', 'skills', 'review')
  for (const dir of [magic.base, workspace, changed, skillDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(guide, 'GUIDANCE_CURRENT_A')
  writeFileSync(join(workspace, 'AGENTS.md'), 'ORIGINAL_WORKSPACE_RULE')
  writeFileSync(join(changed, 'AGENTS.md'), 'MUST_NOT_LOAD_CHANGED_WORKSPACE')
  writeFileSync(join(workspace, 'same.txt'), 'ORIGINAL_FILE')
  writeFileSync(join(changed, 'same.txt'), 'CHANGED_FILE')
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: review\ndescription: review things\n---\nREQUIRED_SKILL_CURRENT_A')
  const seen: Wire[] = []
  let nextTool: { name: string; args: Record<string, unknown> } | undefined
  let usage: Record<string, unknown> | undefined = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
  let onRequest: (() => void) | undefined
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>
    seen.push({ route: new URL(request.url).pathname, body })
    onRequest?.()
    const tool = nextTool
    nextTool = undefined
    const delta = tool === undefined ? { content: '本地结果' } : { tool_calls: [{ index: 0, id: `tool-${seen.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
    const chunk = (delta: unknown, finish?: string) => `data: ${JSON.stringify({ id: 'controlled', object: 'chat.completion.chunk', created: 1, model: body['model'], choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`
    const usageChunk = usage === undefined ? '' : `data: ${JSON.stringify({ id: 'controlled', object: 'chat.completion.chunk', created: 1, model: body['model'], choices: [], usage })}\n\n`
    return new Response(chunk(delta) + chunk({}, tool ? 'tool_calls' : 'stop') + usageChunk + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const providers = {
    ds: { vendor: 'deepseek', baseURL: `http://127.0.0.1:${server.port}/ds`, apiKey: 'local-only-ds' },
    mm: { vendor: 'minimax', baseURL: `http://127.0.0.1:${server.port}/mm`, apiKey: 'local-only-mm', ...(image === undefined ? {} : { modelOverrides: { 'member-model': { capabilities: { image } } } }) },
    missing: { vendor: 'deepseek', baseURL: `http://127.0.0.1:${server.port}/missing` },
  }
  const configPath = join(magic.base, 'config.json')
  const config = { dataDir, providers, models: {default: {provider: "missing", model: 'missing'}, cantrip: {provider: "ds", model: 'entry-model'}, spell: {provider: "mm", model: 'member-model'}, arcane: {provider: "ds", model: 'role-default-must-not-replace-member'}}, workspaceRoots: [changed], agentRoles: { reader: {
    name: '只读审查', instructions: 'ROLE_INSTRUCTIONS', guidanceFiles: [guide], skills: ['review'], tools: ['read'],
    model: { choice: 'arcane', reasoning: { mode: 'level' as const, level: 'high' } }, ...rolePatch,
  } } }
  writeFileSync(configPath, JSON.stringify(config))
  const store = createRecordsStore({ dataDir, workspace: [realpathSync(workspace)] })
  const origin = { sessionId: 'origin', entryId: store.serviceFor('origin').appendEntry({ kind: 'user', content: { text: '原始目标' }, at: 1 }) }
  const coordinator = store.collaboration.registerAgent({ operationId: 'register', sessionId: 'origin', name: '入口', role: '', model: { choice: 'default', provider: 'ds', model: 'entry-model', reasoning: { mode: 'off' } }, at: 2 })
  const collaboration = store.collaboration.openCollaboration(coordinator.agentId, { operationId: 'open', origin, at: 3 })
  const { agent, delegation } = store.collaboration.spawn(coordinator.agentId, { operationId: 'spawn', sessionId: 'member', name: '成员', role: 'reader', responsibility: 'PERSISTED_RESPONSIBILITY', model: { choice: 'default', provider: 'mm', model: 'member-model', reasoning: { mode: 'default' } }, body: [{ kind: 'text', text: '按职责审查' }], scope: '只读工作', source: origin, authorization: [origin], at: 4 })
  store.collaboration.respondToDelegation(agent.agentId, { operationId: 'accept', delegationId: delegation.delegationId, response: 'accept', at: 5 })
  const open = (session = 'member', coordinate = true, collaborationChanged?: () => void) => assemble({
    cwd: changed, session, magic, config: loadConfig({ path: configPath, magic }), allowAll: true,
    collaborationChanged,
    ...(coordinate ? { collaboration: async (): Promise<CollaborationReply> => ({ ok: false, reason: '本用例不发送协作请求' }) } : {}),
  })
  return { root, magic, workspace, changed, dataDir, guide, skillDir, seen, store, agent, delegation, coordinator, collaboration, config, configPath, providers, open,
    usage(value: Record<string, unknown> | undefined) { usage = value },
    onRequest(callback: () => void) { onRequest = callback },
    tool(name: string, args: Record<string, unknown>) { nextTool = { name, args } },
    close() { server.stop(true); store.close(); removeDir(root) },
  }
}

function texts(request: Wire | undefined): string {
  return JSON.stringify(request?.body['messages'])
}

describe('成员主机装配', () => {
  test('持久 workspace/model 优先于变更后的全局配置；角色职责、规约和技能动态进入真实请求', async () => {
    const f = setup()
    const app = f.open()
    const shell = attachShell(app.shell)
    try {
      await app.ready()
      await app.boot()
      expect(f.seen).toEqual([])
      expect(app.workspaceRoots).toEqual([realpathSync(f.workspace)])
      expect(app.models?.current()).toEqual(f.agent.model)
      f.tool('read', { path: 'same.txt' })
      await shell.submit('请检查', 3000)
      expect(f.seen[0]?.route).toBe('/mm/chat/completions')
      expect(f.seen[0]?.body['model']).toBe('member-model')
      expect(texts(f.seen[0])).toContain('ROLE_INSTRUCTIONS')
      expect(texts(f.seen[0])).toContain('PERSISTED_RESPONSIBILITY')
      expect(texts(f.seen[0])).toContain('ORIGINAL_WORKSPACE_RULE')
      expect(texts(f.seen[0])).not.toContain('MUST_NOT_LOAD_CHANGED_WORKSPACE')
      expect(texts(f.seen[0])).toContain('GUIDANCE_CURRENT_A')
      expect(texts(f.seen[0])).toContain('REQUIRED_SKILL_CURRENT_A')
      expect(shell.events.filter(event => event.kind === 'error' || event.kind === 'model.error')).toEqual([])
      expect(JSON.stringify(shell.events.filter(event => event.kind === 'tool.result'))).toContain('ORIGINAL_FILE')
      expect(texts(f.seen.at(-1))).toContain('ORIGINAL_FILE')
      expect(texts(f.seen.at(-1))).not.toContain('CHANGED_FILE')
      const tools = f.seen[0]?.body['tools'] as { function: { name: string } }[]
      expect(tools.some(tool => tool.function.name === 'read')).toBe(true)
      expect(tools.filter(tool => !tool.function.name.startsWith('agent_')).map(tool => tool.function.name)).toEqual(['read'])
      writeFileSync(f.guide, 'GUIDANCE_CURRENT_B')
      writeFileSync(join(f.skillDir, 'SKILL.md'), '---\nname: review\ndescription: review things\n---\nREQUIRED_SKILL_CURRENT_B')
      await shell.submit('再检查一次', 3000)
      expect(texts(f.seen.at(-1))).toContain('GUIDANCE_CURRENT_B')
      expect(texts(f.seen.at(-1))).toContain('REQUIRED_SKILL_CURRENT_B')
      const evidence = process.env['MAGIC_ASSEMBLY_EVIDENCE']
      if (evidence) writeFileSync(evidence, JSON.stringify({ kind: 'local-controlled-assembly-http', identity: f.agent, workspace: app.workspaceRoots, requests: f.seen }, null, 2))
    } finally { shell.dispose(); app.close(); f.close() }
  })

  test('即使绕过协作循环准入和 allowAll，隐藏的 write 也不能执行', async () => {
    const f = setup()
    const app = f.open('member', false)
    const shell = attachShell(app.shell)
    try {
      await app.ready(); await app.boot()
      f.tool('write', { path: 'forbidden.txt', content: 'SHOULD_NOT_EXIST' })
      await shell.submit('尝试伪造不可见工具', 3000)
      expect(existsSync(join(f.workspace, 'forbidden.txt'))).toBe(false)
      expect(existsSync(join(f.changed, 'forbidden.txt'))).toBe(false)
      expect(shell.events.some(event => event.kind === 'tool.result' && !event.data.ok)).toBe(true)
      expect((f.seen[0]?.body['tools'] as { function: { name: string } }[]).map(tool => tool.function.name)).toEqual(['read'])
    } finally { shell.dispose(); app.close(); f.close() }
  })

  test('两成员装配并行异构出站，切换只改本人后续请求和身份', async () => {
    const f = setup()
    const peer = f.store.collaboration.spawn(f.coordinator.agentId, {
      operationId: 'spawn-peer', sessionId: 'peer', name: '另一成员', role: 'reader', responsibility: '独立审查',
      model: { choice: 'default', provider: 'ds', model: 'peer-model', reasoning: { mode: 'level', level: 'high' } },
      body: [{ kind: 'text', text: '检查另一部分' }], scope: '只读工作',
      source: f.collaboration.origin, authorization: [f.collaboration.origin], at: 6,
    })
    f.store.collaboration.respondToDelegation(peer.agent.agentId, {
      operationId: 'accept-peer', delegationId: peer.delegation.delegationId, response: 'accept', at: 7,
    })
    const first = f.open()
    const second = f.open('peer')
    const a = attachShell(first.shell)
    const b = attachShell(second.shell)
    try {
      await Promise.all([first.ready(), second.ready()])
      await Promise.all([first.boot(), second.boot()])
      await Promise.all([a.submit('FIRST_MEMBER_A', 3000), b.submit('FIRST_MEMBER_B', 3000)])
      const initialA = f.seen.find(one => one.body['model'] === 'member-model')!
      const initialB = f.seen.find(one => one.body['model'] === 'peer-model')!
      expect(initialA.route).toBe('/mm/chat/completions')
      expect(initialA.body['reasoning_effort']).toBeUndefined()
      expect(initialB.route).toBe('/ds/chat/completions')
      expect(initialB.body['reasoning_effort']).toBe('high')
      expect(texts(initialA)).not.toContain('FIRST_MEMBER_B')
      expect(texts(initialB)).not.toContain('FIRST_MEMBER_A')
      expect(first.applyModel({ choice: 'spell', provider: 'ds', model: 'switched-member', reasoning: { mode: 'level', level: 'low' } }).ok).toBe(true)
      await Promise.all([a.submit('AFTER_SWITCH_A', 3000), b.submit('AFTER_SWITCH_B', 3000)])
      expect(f.seen.find(one => one.body['model'] === 'switched-member')?.body['reasoning_effort']).toBe('low')
      expect(f.seen.findLast(one => one.body['model'] === 'peer-model')?.body['reasoning_effort']).toBe('high')
      expect(second.models?.current()).toEqual(peer.agent.model)
      expect(f.store.collaboration.getAgent(peer.agent.agentId)?.model).toEqual(peer.agent.model)
      expect(f.store.collaboration.getCollaboration(f.collaboration.collaborationId)?.defaultModel).toEqual(f.collaboration.defaultModel)
      const evidence = process.env['MAGIC_ASSEMBLY_ISOLATION_EVIDENCE']
      if (evidence) writeFileSync(evidence, JSON.stringify({ kind: 'local-controlled-two-member-assembly',
        identities: f.store.collaboration.listMembers(f.collaboration.collaborationId), requests: f.seen }, null, 2))
    } finally { a.dispose(); b.dispose(); first.close(); second.close(); f.close() }
  })

  test('角色开放 exec 不授予删除权限，原权限闸门依然拒绝', async () => {
    const f = setup({ tools: ['exec'] })
    const app = f.open('member', false)
    const shell = attachShell(app.shell)
    try {
      await app.ready(); await app.boot()
      f.tool('exec', { cmd: 'rm same.txt' })
      await shell.submit('检查权限', 3000)
      expect(existsSync(join(f.workspace, 'same.txt'))).toBe(true)
      expect(shell.events.some(event => event.kind === 'tool.result' && !event.data.ok)).toBe(true)
    } finally { shell.dispose(); app.close(); f.close() }
  })

  test('未知角色工具/技能及不可读指导文件阻止出站，不静默丢失约束', async () => {
    for (const patch of [{ tools: ['not-a-tool'] }, { skills: ['not-a-skill'] }, { guidanceFiles: ['/nonexistent-magic-role-guidance.md'] }]) {
      const f = setup(patch)
      const app = f.open()
      const shell = attachShell(app.shell)
      try {
        await app.ready(); await app.boot()
        await shell.submit('不得忽略缺失约束', 3000)
        expect(f.seen).toEqual([])
        expect(shell.events.some(event => event.kind === 'error')).toBe(true)
      } finally { shell.dispose(); app.close(); f.close() }
    }
  })

  test('成员切换提交 identity；供应商/能力/持久更新失败保留旧实例；入口不改协作默认', async () => {
    const f = setup()
    let app = f.open()
    try {
      await app.ready(); await app.boot()
      const before = app.models
      for (const request of [{}, { provider: 'missing' }, { provider: 'unknown' }, { reasoning: { mode: 'off' as const } }]) {
        expect(app.applyModel(request as unknown as AgentModelConfig).ok).toBe(false)
        expect(app.models).toBe(before)
        expect(f.store.collaboration.getAgent(f.agent.agentId)?.model).toEqual(f.agent.model)
      }
      const update = app.records.collaboration.updateAgent
      app.records.collaboration.updateAgent = () => { throw new Error('模拟持久更新失败') }
      expect(app.applyModel({ choice: 'default', provider: 'ds', model: 'another', reasoning: { mode: 'off' } }).ok).toBe(false)
      expect(app.models).toBe(before)
      app.records.collaboration.updateAgent = update
      const changed = { choice: 'default' as const, provider: 'ds', model: 'another', reasoning: { mode: 'off' as const } }
      expect(app.applyModel(changed).ok).toBe(true)
      expect(f.store.collaboration.getAgent(f.agent.agentId)?.model).toEqual(changed)
      app.close()
      app = f.open()
      await app.ready(); await app.boot()
      expect(app.models?.current()).toEqual(changed)
      expect(f.store.collaboration.getCollaboration(f.collaboration.collaborationId)?.defaultModel).toEqual(f.collaboration.defaultModel)
      app.close()
      app = f.open('origin')
      await app.ready(); await app.boot()
      expect(app.applyModel({ choice: 'spell', provider: 'mm', model: 'entry-changed' }).ok).toBe(true)
      expect(f.store.collaboration.getAgent(f.coordinator.agentId)?.model.model).toBe('entry-changed')
      expect(f.store.collaboration.getAgent(f.agent.agentId)?.model).toEqual(changed)
      expect(f.store.collaboration.getCollaboration(f.collaboration.collaborationId)?.defaultModel).toEqual(f.collaboration.defaultModel)
      expect(f.seen).toEqual([])
    } finally { app.close(); f.close() }
  })

  test('配置已提交后通知失败仍回成功，不谎报保留旧配置', async () => {
    const f = setup()
    const app = f.open('member', false, () => { throw new Error('模拟通知失败') })
    const shell = attachShell(app.shell)
    try {
      await app.ready(); await app.boot()
      const model = { choice: 'default' as const, provider: 'ds', model: 'committed', reasoning: { mode: 'off' as const } }
      expect(app.applyModel(model)).toEqual({ ok: true, selection: model })
      expect(app.models?.current()).toEqual(model)
      expect(f.store.collaboration.getAgent(f.agent.agentId)?.model).toEqual(model)
      expect(shell.events.some(event => event.kind === 'error' && event.data.message.includes('通知失败'))).toBe(true)
    } finally { shell.dispose(); app.close(); f.close() }
  })

  test('用量沿原事件记录，绑定请求开始时的委派，缺项与无用量不补零', async () => {
    const f = setup()
    const app = f.open('member', false)
    const shell = attachShell(app.shell)
    try {
      await app.ready(); await app.boot()
      f.usage({ prompt_tokens: 7 })
      f.onRequest(() => f.store.collaboration.deliver(f.agent.agentId, {
        operationId: 'delivered-during-request', delegationId: f.delegation.delegationId,
        body: [{ kind: 'text', text: '请求期间委派状态已变' }], at: 20,
      }))
      await shell.submit('留下实际用量', 3000)
      const events = shell.events.filter(event => event.kind === 'model.usage')
      expect(events).toHaveLength(1)
      expect(events[0]?.data).toMatchObject({ delegationId: f.delegation.delegationId, inputTokens: 7 })
      expect(events[0]?.data.outputTokens).toBeUndefined()
      expect(events[0]?.data.totalTokens).toBeUndefined()
      const persisted = []
      for await (const event of app.records.serviceFor('member').readEvents('member')) if (event.kind === 'model.usage') persisted.push(event)
      expect(persisted).toEqual(events)
      f.onRequest(() => undefined)
      f.usage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } })
      await shell.submit('明确报告零用量', 3000)
      expect(shell.events.filter(event => event.kind === 'model.usage').at(-1)?.data).toEqual({
        inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
      })
      f.usage({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 9 })
      await shell.submit('保留供应商总量定义', 3000)
      expect(shell.events.filter(event => event.kind === 'model.usage').at(-1)?.data.totalTokens).toBe(9)
      f.usage(undefined)
      await shell.submit('这次没有报告用量', 3000)
      expect(shell.events.filter(event => event.kind === 'model.usage')).toHaveLength(3)
      const evidence = process.env['MAGIC_USAGE_EVIDENCE']
      if (evidence) writeFileSync(evidence, JSON.stringify({ kind: 'existing-model-usage-event',
        firstPersisted: persisted, events: shell.events.filter(event => event.kind === 'model.usage') }, null, 2))
    } finally { shell.dispose(); app.close(); f.close() }
  })

  test('会话目录只列原工作，底层记录目录仍可扫描成员', async () => {
    const f = setup()
    const app = f.open('origin')
    const shell = attachShell(app.shell)
    try {
      await app.ready(); await app.boot()
      expect((await app.records.listSessions()).map(row => row.id)).toContain('member')
      const listed = shell.until(event => event.kind === 'session.state', 3000)
      shell.send({ type: 'session.list' })
      const event = await listed
      if (event.kind !== 'session.state') throw new Error('应返回会话目录')
      expect(event.data.sessions.map(row => row.id)).toEqual(['origin'])
    } finally { shell.dispose(); app.close(); f.close() }
  })

  test('后台进程真正退出前持有委派准入，不能关闭协作或接下另一委派', async () => {
    const f = setup({ tools: ['exec'] })
    const app = f.open()
    const shell = attachShell(app.shell)
    const releaseFile = join(f.workspace, 'release-background')
    try {
      await app.ready(); await app.boot()
      f.tool('exec', { cmd: 'while test ! -f release-background; do sleep 0.02; done', background: true })
      await shell.submit('运行受控后台任务', 3000)
      expect(app.background?.running()).toHaveLength(1)
      const records = f.store.collaboration
      const running = records.listExecutions(f.collaboration.collaborationId).filter(one => one.state !== 'finished')
      expect(running).toHaveLength(1)
      expect(running[0]).toMatchObject({ agentId: f.agent.agentId, delegationId: f.delegation.delegationId, kind: 'tool', mode: 'work' })
      records.deliver(f.agent.agentId, { operationId: 'early-report', delegationId: f.delegation.delegationId, body: [{ kind: 'text', text: '已交付但后台仍未退' }], at: 10 })
      records.receiveDelivery(f.coordinator.agentId, f.delegation.delegationId, 11)
      const next = records.delegate(f.coordinator.agentId, { operationId: 'next-work', assigneeId: f.agent.agentId,
        scope: '另一份工作', body: [{ kind: 'text', text: '继续下一份' }], source: f.collaboration.origin,
        authorization: [f.collaboration.origin], at: 12 })
      expect(records.respondToDelegation(f.agent.agentId, { operationId: 'try-accept-busy', delegationId: next.delegationId, response: 'accept', at: 13 }).accepted).toBe(false)
      const closing = records.closeCollaboration(f.collaboration.collaborationId, 14)
      expect(closing.closed).toBe(false)
      expect(closing.blockers.some(one => one.includes(`execution ${running[0]!.operationId}`))).toBe(true)
      const idle = shell.until(event => event.kind === 'agent.state' && event.data.state === 'waiting', 3000)
      writeFileSync(releaseFile, '退出')
      await idle
      expect(app.background?.running()).toEqual([])
      expect(records.listExecutions(f.collaboration.collaborationId).every(one => one.state === 'finished')).toBe(true)
      records.resume({ kind: 'collaboration', collaborationId: f.collaboration.collaborationId }, 15)
      expect(records.respondToDelegation(f.agent.agentId, { operationId: 'accept-after-exit', delegationId: next.delegationId, response: 'accept', at: 16 }).accepted).toBe(true)
      records.deliver(f.agent.agentId, { operationId: 'next-report', delegationId: next.delegationId, body: [{ kind: 'text', text: '下一份完成' }], at: 17 })
      records.receiveDelivery(f.coordinator.agentId, next.delegationId, 18)
      expect(records.closeCollaboration(f.collaboration.collaborationId, 19).closed).toBe(true)
      const evidence = process.env['MAGIC_BACKGROUND_EVIDENCE']
      if (evidence) writeFileSync(evidence, JSON.stringify({ kind: 'real-local-background-lifecycle', running, closing,
        finished: records.listExecutions(f.collaboration.collaborationId),
        exits: shell.events.filter(event => event.kind === 'exec.background.done') }, null, 2))
    } finally {
      for (const run of app.background?.running() ?? []) await app.background?.stop(run.id)
      shell.dispose(); app.close(); f.close()
    }
  })

  test('后台启动返回失败或抛错时立即释放额外准入', async () => {
    for (const throws of [false, true]) {
      const f = setup({ tools: ['exec'] })
      const app = f.open()
      const shell = attachShell(app.shell)
      try {
        await app.ready(); await app.boot()
        if (app.background === undefined) throw new Error('应装配后台进程')
        app.background.start = async () => {
          if (throws) throw new Error('模拟启动异常')
          return { ok: false, reason: '模拟启动失败' }
        }
        f.tool('exec', { cmd: 'echo never-started', background: true })
        await shell.submit('失败的后台启动', 3000)
        const executions = f.store.collaboration.listExecutions(f.collaboration.collaborationId)
        expect(executions.filter(one => one.kind === 'tool')).toHaveLength(2)
        expect(executions.every(one => one.state === 'finished')).toBe(true)
        expect(shell.events.some(event => event.kind === 'tool.result' && !event.data.ok)).toBe(true)
      } finally { shell.dispose(); app.close(); f.close() }
    }
  })

  test('共享约束中的其他会话图片参与成员能力检查，支持时才进入实际请求', async () => {
    for (const supported of [false, true]) {
      const f = setup({}, supported)
      const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
      const origin = f.store.serviceFor('origin')
      const blob = await origin.blobs.put(bytes)
      const source = { sessionId: 'origin', entryId: origin.appendEntry({ kind: 'user', at: 7, content: { text: '检查 Image#1' }, payload: { refs: [
        { kind: 'image', at: 3, marker: 'Image#1', source: '/original-reference.png', label: '原始图片', name: 'reference.png', mime: 'image/png', blob },
      ] } }) }
      const constraint = f.store.collaboration.publishConstraint(f.coordinator.agentId, {
        operationId: 'shared-image', source, body: [{ kind: 'entry', ref: source }], at: 8,
      })
      const app = f.open()
      const shell = attachShell(app.shell)
      try {
        await app.ready(); await app.boot()
        await shell.submit('根据共享约束检查', 3000)
        const item = f.store.collaboration.inbox(f.agent.agentId).find(one => one.messageId === constraint.messageId)
        if (supported) {
          expect(JSON.stringify(f.seen.at(-1)?.body['messages'])).toContain('data:image/png;base64,')
          expect(item?.includedAt).toBeDefined()
        } else {
          expect(f.seen).toEqual([])
          expect(shell.events.some(event => event.kind === 'error' && event.data.message.includes('不支持图片'))).toBe(true)
          expect(item?.includedAt).toBeUndefined()
          expect(app.models?.current()).toEqual(f.agent.model)
        }
      } finally { shell.dispose(); app.close(); f.close() }
    }
  })

  test('supplementCollaboration 原样交付输入 ref 和材料引用，共享约束引用已接收原文', async () => {
    const f = setup()
    const app = f.open('origin')
    const shell = attachShell(app.shell)
    try {
      await app.ready(); await app.boot()
      const idle = shell.until(event => event.kind === 'agent.state' && event.data.state === 'waiting', 3000)
      await app.supplementCollaboration({ text: '检查 @same.txt', ref: 'supplement-reference',
        refs: [{ kind: 'file', source: join(f.workspace, 'same.txt'), at: 3, marker: '@same.txt' }] }, true)
      await idle
      expect(shell.events.some(event => event.kind === 'input.settled' && event.data.ref === 'supplement-reference' && event.data.ok)).toBe(true)
      expect(texts(f.seen.at(-1))).toContain('检查 @same.txt')
      const constraints = f.store.collaboration.listConstraints(f.collaboration.collaborationId)
      expect(constraints).toHaveLength(1)
      const message = f.store.collaboration.readMessage(f.coordinator.agentId, constraints[0]!.messageId)
      expect(message?.userSource?.sessionId).toBe('origin')
      if (message?.userSource === undefined) throw new Error('共享约束须保留原始用户来源')
      expect(message.body).toEqual([{ kind: 'entry', ref: message.userSource }])
      const entries = []
      for await (const entry of app.records.readEntries('origin')) entries.push(entry)
      expect(entries.find(entry => entry.id === message?.userSource?.entryId)?.payload).toMatchObject({
        refs: [{ kind: 'file', source: realpathSync(join(f.workspace, 'same.txt')), at: 3, marker: '@same.txt' }],
      })
    } finally { shell.dispose(); app.close(); f.close() }
  })
})

describe('manager 模型预检只读已有缓存', () => {
  test('过期缓存仍参与能力校验，绝不后台发现或调用模型', async () => {
    const f = setup()
    try {
      const cache = createFileModelInfoCache(f.dataDir)
      const snapshot: ModelInfoSnapshot = { provider: 'ds', scope: `deepseek@${f.providers.ds.baseURL}`, fetchedAt: 1, models: [{ id: 'cached', reasoning: { levels: ['low'], disable: false } }] }
      const configuration = JSON.parse(readFileSync(f.configPath, 'utf8'))
      configuration.models.default = { provider: 'ds', model: 'cached' }
      writeFileSync(f.configPath, JSON.stringify(configuration))
      await cache.replace(snapshot, cacheAccessFor({ provider: 'ds', configPath: f.configPath, apiKey: f.providers.ds.apiKey, processToken: 'test' }))
      const defaults = { choice: 'default' as const, provider: 'ds', model: 'cached', reasoning: { mode: 'level' as const, level: 'high' } }
      await expect(resolveManagedModel({ magic: f.magic, defaults })).rejects.toThrow('不支持思考档位')
      expect(await resolveManagedModel({ magic: f.magic, defaults, model: { reasoning: { mode: 'level', level: 'low' } } })).toEqual({ ...defaults, reasoning: { mode: 'level', level: 'low' } })
      await expect(resolveManagedModel({ magic: f.magic, defaults, role: 'unknown' })).rejects.toThrow('未知角色')
      await expect(resolveManagedModel({ magic: f.magic, defaults, model: { choice: 'spell', reasoning: { mode: 'off' } } })).rejects.toThrow('未知')
      f.store.collaboration.updateAgent(f.agent.agentId, { model: defaults })
      const app = f.open()
      try { await expect(app.ready()).rejects.toThrow('不支持思考档位') }
      finally { app.close() }
      expect(f.seen).toEqual([])
    } finally { f.close() }
  })
})
