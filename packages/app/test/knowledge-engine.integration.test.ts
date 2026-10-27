import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Command, KernelEvent } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { createConversationSession } from '@magic/conversation'
import { createFauxGateway, makeFauxToolRuntime } from '@magic/faux'
import { createStamper } from '../src/agent-assembly/events.ts'
import { connectManager } from '../src/run/client.ts'
import { startManager, type Manager } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'

test('真实Engine查询/证据/遗忘/重连回查不启动Agent，停止发现且保留原历史', async () => {
  const root = mkdtempSync('/tmp/magic-k-')
  const home = join(root, 'home'), base = join(root, 'data'), workspace = join(root, 'project')
  for (const dir of [home, base, workspace]) mkdirSync(dir)
  writeFileSync(join(base, 'config.json'), JSON.stringify({ workspaces: [workspace] }))
  const magic = { home, base }
  const paths = runPathsOf(magic, '/tmp')
  let manager: Manager | undefined
  let client: Awaited<ReturnType<typeof connectManager>>
  let store = createRecordsStore({ dataDir: base, workspace: [workspace] })
  let launches = 0
  try {
    const records = store.serviceFor('original')
    const entry = records.appendEntry({ kind: 'user', content: { text: '具体授权证据：中文认证结论' }, at: 1 })
    const secret = records.appendEntry({ kind: 'user', content: { text: '未授权的其他历史' }, at: 2 })
    const scope = { kind: 'project' as const, workspace: [workspace] }
    expect(store.knowledge.write([{ id: 'auth', expectedRevision: 0, scope, topic: '认证', terms: ['鉴权'], conclusion: '旧认证认识', conditions: '某特定条件',
      evidence: 'fact', status: 'active', sources: [{ session: 'original', entry }], dependencies: [] }]).ok).toBe(true)
    records.appendEntry({ kind: 'assistant', content: { text: '原答复中的旧认证认识' }, payload: { knowledge: [{ id: 'auth', revision: 1 }] }, at: 3 })
    records.appendEntry({ kind: 'user', content: { text: '仍须保留的用户要求' }, at: 4 })
    store.setSessionArchived('original', true)
    store.close()
    const started = await startManager({ paths, magic, launch: { spawn() { launches += 1; throw new Error('知识管理不应启动执行者') } } })
    if (started.role !== 'manager') throw new Error(`隔离Engine未启动：${JSON.stringify(started)}`)
    manager = started.manager
    client = await connectManager(paths.socket, { cwd: workspace })
    if (client === undefined) throw new Error('连接隔离Engine失败')
    const responses = new Map<string, (event: KernelEvent) => void>()
    const receive = (event: KernelEvent) => { if ('requestId' in event.data && typeof event.data.requestId === 'string') responses.get(event.data.requestId)?.(event) }
    client.onEvent(receive)
    const request = async (command: Command & { readonly requestId: string }): Promise<KernelEvent> => {
      let timer: ReturnType<typeof setTimeout>
      try {
        return await new Promise<KernelEvent>((resolve, reject) => {
          responses.set(command.requestId, resolve)
          timer = setTimeout(() => reject(new Error(`没有回执 ${command.type}`)), 2000)
          client!.send(command)
        })
      } finally { clearTimeout(timer!); responses.delete(command.requestId) }
    }
    const query = await request({ type: 'knowledge.query', requestId: 'query', session: 'original', query: { query: '鉴权' } })
    expect(query.kind).toBe('knowledge.state')
    if (query.kind === 'knowledge.state') expect(query.data.page?.items.map(item => item.id)).toEqual(['auth'])
    const source = await request({ type: 'memory.source', requestId: 'source', session: 'original', knowledge: 'auth', source: { session: 'original', entry } })
    if (source.kind !== 'memory.source') throw new Error('来源回执不符')
    expect(source.data.page?.text).toContain('具体授权证据')
    const denied = await request({ type: 'memory.source', requestId: 'denied', session: 'original', knowledge: 'auth', source: { session: 'original', entry: secret } })
    if (denied.kind !== 'memory.source') throw new Error('来源拒绝回执不符')
    expect(denied.data.error).toContain('允许范围')
    const forget = { type: 'knowledge.forget' as const, requestId: 'forget', session: 'original', id: 'auth', scope, expectedRevision: 1 }
    const result = await request(forget)
    if (result.kind !== 'knowledge.forgotten') throw new Error('遗忘回执不符')
    expect(result.data.result?.status).toBe('completed')
    client.close()
    client = await connectManager(paths.socket, { cwd: workspace })
    if (client === undefined) throw new Error('重连失败')
    client.onEvent(receive)
    const confirmed = await request({ ...forget, type: 'knowledge.forget-result' })
    if (confirmed.kind !== 'knowledge.forgotten') throw new Error('查询回执不符')
    expect(confirmed.data.result?.status).toBe('completed')
    const repeated = await request(forget)
    if (repeated.kind !== 'knowledge.forgotten') throw new Error('重复遗忘回执不符')
    expect(repeated.data.result?.current?.revision).toBe(2)
    expect(launches).toBe(0)
    expect(manager.executors()).toEqual([])
    expect(manager.runs()).toEqual([])
    client.close(); client = undefined
    manager.stop('测试结束'); await manager.waitUntilExit(); manager = undefined
    store = createRecordsStore({ dataDir: base, workspace: [workspace] })
    expect(store.knowledge.search().items).toEqual([])
    expect(store.knowledge.forgetResult(forget).status).toBe('completed')
    expect(store.isSessionArchived('original')).toBe(true)
    expect(await store.listSessions()).toHaveLength(1)
    // Engine 只读动作保持归档；此后显式恢复，检查公开会话入口的下一次真实模型请求。
    store.setSessionArchived('original', false)
    const resumedRecords = store.serviceFor('original')
    const stamper = createStamper({ records: resumedRecords, session: 'original', now: Date.now })
    const gateway = createFauxGateway({ stamper, turns: [{ text: '已核对当前要求' }] })
    const events: KernelEvent[] = []
    const service = createConversationSession({ session: 'original', records: resumedRecords, knowledge: store.knowledge,
      stamper, gateway, tools: makeFauxToolRuntime(), sink: { emit(event) { events.push(event) } },
      prompt: { cwd: workspace, platform: 'darwin', date: '2026-10-26' },
    })
    try {
      service.submit({ text: '明确继续核对当前工作' })
      const deadline = Date.now() + 2_000
      while (service.busy() && Date.now() < deadline) await Bun.sleep(2)
      expect(service.busy()).toBe(false)
      expect(events.filter(event => event.kind === 'error')).toEqual([])
      expect(gateway.requests).toHaveLength(1)
      expect(JSON.stringify(gateway.requests[0]!.messages)).toContain('原答复中的旧认证认识')
      expect(JSON.stringify(gateway.requests[0]!.messages)).toContain('仍须保留的用户要求')
    } finally { await service.shutdown() }
    expect((await Array.fromAsync(store.readEntries('original'))).some(item => item.id === entry)).toBe(true)
  } finally {
    client?.close()
    if (manager !== undefined) { manager.stop('测试清场'); await manager.waitUntilExit() }
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
