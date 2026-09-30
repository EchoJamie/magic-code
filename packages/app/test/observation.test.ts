import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Command, EventDataOf, EventKind, ProviderConfig } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { modelSpecOf, resolveConnection } from '@magic/model'
import { cacheAccessFor } from '../src/cache-access.ts'
import { createFileModelInfoCache } from '../src/model-cache.ts'
import { query, type ObservationContext } from '../src/run/observation.ts'
import { cliGround } from './resident-cli-fixture.ts'

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
function ground() {
  const g = cliGround()
  const workspace = join(g.root, 'workspace')
  mkdirSync(workspace)
  const store = createRecordsStore({ dataDir: g.dataDir, workspace: [] })
  cleanups.push(() => { store.close(); g.close() })
  const context: ObservationContext = {
    magic: { base: g.base, home: g.home }, cwd: workspace, store, mcp: [], now: () => 172_800_000,
  }
  return { ...g, workspace, store, context, configure(providers: Record<string, ProviderConfig>, other = {}) {
    writeFileSync(join(g.base, 'config.json'), JSON.stringify({ dataDir: g.dataDir, providers, ...other }))
  } }
}
async function answer<K extends EventKind>(command: Command, context: ObservationContext, kind: K): Promise<EventDataOf[K]> {
  const event = await query(command, context)
  expect(event?.kind).toBe(kind)
  return event!.data as EventDataOf[K]
}
function bytesUnder(path: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of readdirSync(path).sort()) {
    const file = join(path, name)
    if (statSync(file).isDirectory()) Object.assign(result, bytesUnder(file))
    else if (!name.endsWith('-shm')) result[file] = readFileSync(file).toString('base64')
  }
  return result
}

describe('无执行者的真实只读目录', () => {
  test('七类查询不联网/不派生进程/不写文件、不建session、不消耗未读；缺key仍能展示配置', async () => {
    const g = ground()
    g.configure({ ds: { vendor: 'deepseek', model: 'deepseek-chat' } }, { defaultProvider: 'ds' })
    const skillDir = join(g.workspace, '.magic/skills/local')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: local\ndescription: 本地真实技能\n---\n正文不进入目录\n')
    writeFileSync(join(g.workspace, 'hello.ts'), 'export const hello = 1')
    const stale = join(g.root, 'removed')
    writeFileSync(join(g.base, 'grants.json'), JSON.stringify({ version: 1, workspaces: {
      [g.workspace]: [{ tool: 'web_fetch', op: ['outbound'], host: 'example.com', grantedAt: 1 }],
      [stale]: [{ tool: 'web_fetch', op: ['outbound'], host: 'old.example.com', grantedAt: 1 }],
    } }))
    g.store.attention.put({ id: 'pending', session: 'no-session-yet', fact: 'needs-input', kind: 'needs-you', at: 1, unread: true, delivered: false })
    const before = bytesUnder(g.root)
    const fetch = spyOn(globalThis, 'fetch').mockImplementation((() => { throw new Error('只读不能网络请求') }) as unknown as typeof globalThis.fetch)
    const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('只读不能派生进程') })
    try {
      const models = await answer({ type: 'model.list' }, g.context, 'model.catalog')
      expect(models.entries.map((row) => row.provider)).toEqual(['ds'])
      expect(models.current).toEqual({ provider: 'ds', model: 'deepseek-chat' })
      const providers = await answer({ type: 'provider.list' }, g.context, 'provider.catalog')
      expect(providers.vendors.length).toBeGreaterThan(0)
      expect(providers.entries).toEqual(models.entries)
      const skills = await answer({ type: 'skills.list' }, g.context, 'skills.catalog')
      expect(skills.skills.map((row) => row.name)).toEqual(['local'])
      expect(JSON.stringify(skills)).not.toContain('正文不进入目录')
      const paths = await answer({ type: 'paths.list', query: 'hello' }, g.context, 'paths.catalog')
      expect(paths.rows.some((row) => row.path.endsWith('hello.ts'))).toBe(true)
      const grants = await answer({ type: 'grants.list' }, g.context, 'grants.catalog')
      expect(grants.grants).toHaveLength(1)
      expect(grants.stale).toEqual([stale])
      const servers: ObservationContext['mcp'] = [{ server: 'real-probe', transport: 'stdio', state: { status: 'available' }, tools: ['echo'], rejected: [{ tool: 'bad name', reason: '真实拒收原因' }] }]
      expect(await answer({ type: 'mcp.list' }, { ...g.context, mcp: servers }, 'mcp.catalog')).toEqual({ servers })
      expect(await answer({ type: 'attachments.list' }, g.context, 'attachments.catalog')).toEqual({ rows: [] })
      await Bun.sleep(0)
      expect(fetch).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
      expect(await g.store.listSessions()).toEqual([])
      expect(g.store.attention.list()[0]).toMatchObject({ unread: true, delivered: false })
      expect(bytesUnder(g.root)).toEqual(before)
    } finally { fetch.mockRestore(); spawn.mockRestore() }
  })

  test('缓存按原接入身份与scope读取，过期照实标记；pure peek不隐式refresh，预算同域判定', async () => {
    const g = ground()
    const config: ProviderConfig = { vendor: 'deepseek', apiKey: 'test-secret', model: 'catalog-only' }
    g.configure({ ds: config }, { defaultProvider: 'ds' })
    const access = cacheAccessFor({ provider: 'ds', configPath: join(g.base, 'config.json'), apiKey: config.apiKey, processToken: 'test' })
    const cache = createFileModelInfoCache(g.dataDir)
    const snapshot = { provider: 'ds', scope: `deepseek@${resolveConnection({ providerId: 'ds', config }).baseURL}`, fetchedAt: 1,
      models: [{ id: 'catalog-only', limits: { maxInputTokens: 12_000, maxOutputTokens: 1_000 } }] }
    await cache.replace(snapshot, access)
    const fetch = spyOn(globalThis, 'fetch').mockImplementation((() => { throw new Error('不能refresh') }) as unknown as typeof globalThis.fetch)
    try {
      const catalog = await answer({ type: 'model.list' }, g.context, 'model.catalog')
      expect(catalog.entries[0]?.cache).toEqual({ snapshot, stale: true })
      expect(catalog.currentInputBudget).toBe(modelSpecOf(config, 'catalog-only', snapshot.models[0]).inputBudget)
      expect(catalog.currentInputBudget).toBe(12_000)
      expect(JSON.stringify(catalog)).not.toContain('test-secret')
      await cache.replace({ ...snapshot, scope: 'another-region', fetchedAt: 2 }, access)
      expect((await answer({ type: 'model.list' }, g.context, 'model.catalog')).entries[0]?.cache).toBeUndefined()
      await Bun.sleep(0)
      expect(fetch).not.toHaveBeenCalled()
    } finally { fetch.mockRestore() }
  })

  test('只给provider/只给model复用域内选择，缺默认与非法选择具体失败；配置与技能每次现读', async () => {
    const g = ground()
    g.configure({ a: { baseURL: 'http://unreachable', model: 'first' }, b: { baseURL: 'http://unreachable', model: 'second' } }, { defaultProvider: 'a' })
    expect((await answer({ type: 'model.list' }, { ...g.context, switch: { provider: 'b' } }, 'model.catalog')).current).toEqual({ provider: 'b', model: 'second' })
    expect((await answer({ type: 'model.list' }, { ...g.context, switch: { model: 'alternate' } }, 'model.catalog')).current).toEqual({ provider: 'a', model: 'alternate' })
    await expect(query({ type: 'model.list' }, { ...g.context, switch: { provider: 'absent' } })).rejects.toThrow('未知供应商')
    g.configure({ b: { vendor: 'deepseek' } })
    expect((await answer({ type: 'model.list' }, g.context, 'model.catalog')).current).toBeUndefined()
    await expect(query({ type: 'model.list' }, { ...g.context, switch: { provider: 'b' } })).rejects.toThrow('还没有默认模型')
    expect((await answer({ type: 'skills.list' }, g.context, 'skills.catalog')).skills).toEqual([])
    const path = join(g.workspace, '.magic/skills/late')
    mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'SKILL.md'), '---\nname: late\ndescription: 后到的技能\n---\n')
    expect((await answer({ type: 'skills.list' }, g.context, 'skills.catalog')).skills[0]?.name).toBe('late')
    writeFileSync(join(g.base, 'grants.json'), '{broken')
    const before = readFileSync(join(g.base, 'grants.json'), 'utf8')
    expect((await answer({ type: 'grants.list' }, g.context, 'grants.catalog')).note).toContain('授权文件读不懂')
    expect(readFileSync(join(g.base, 'grants.json'), 'utf8')).toBe(before)
  })

  test('观察面切换按目标缓存拒绝不支持档位，换供应商或型号不沿用旧思考；不联网或改原选择', async () => {
    const g = ground()
    const config: ProviderConfig = { vendor: 'deepseek', apiKey: 'local-cache-test', model: 'same', reasoning: { mode: 'level', level: 'low' } }
    g.configure({ ds: config, mm: { vendor: 'minimax', model: 'same' } }, { defaultProvider: 'ds' })
    const cache = createFileModelInfoCache(g.dataDir)
    const access = cacheAccessFor({ provider: 'ds', configPath: join(g.base, 'config.json'), apiKey: config.apiKey, processToken: 'test' })
    await cache.replace({ provider: 'ds', scope: `deepseek@${resolveConnection({ providerId: 'ds', config }).baseURL}`, fetchedAt: 1,
      models: [{ id: 'same', reasoning: { levels: ['low'], disable: false } }],
    }, access)
    const selection = { provider: 'ds', model: 'same', reasoning: { mode: 'level' as const, level: 'low' } }
    const context = { ...g.context, selection }
    const before = bytesUnder(g.root)
    const fetch = spyOn(globalThis, 'fetch').mockImplementation((() => { throw new Error('观察切换不能联网') }) as unknown as typeof globalThis.fetch)
    try {
      await expect(query({ type: 'model.list' }, { ...context, switch: { reasoning: { mode: 'level', level: 'high' } } })).rejects.toThrow('不支持思考档位')
      await expect(query({ type: 'model.list' }, { ...context, switch: { reasoning: { mode: 'off' } } })).rejects.toThrow('未声明支持关闭')
      await expect(query({ type: 'model.list' }, { ...context, switch: { provider: 'mm', reasoning: { mode: 'off' } } })).rejects.toThrow('未知')
      expect((await answer({ type: 'model.list' }, { ...context, switch: { reasoning: { mode: 'level', level: 'low' } } }, 'model.catalog')).current).toEqual(selection)
      expect((await answer({ type: 'model.list' }, { ...context, switch: { provider: 'mm' } }, 'model.catalog')).current).toEqual({ provider: 'mm', model: 'same' })
      expect((await answer({ type: 'model.list' }, { ...context, switch: { model: 'other' } }, 'model.catalog')).current).toEqual({ provider: 'ds', model: 'other' })
      expect(selection).toEqual({ provider: 'ds', model: 'same', reasoning: { mode: 'level', level: 'low' } })
      expect((await answer({ type: 'model.list' }, context, 'model.catalog')).current).toEqual(selection)
      expect(bytesUnder(g.root)).toEqual(before)
      expect(fetch).not.toHaveBeenCalled()
    } finally { fetch.mockRestore() }
  })

  test('所选会话附件与工作区授权历史真实可见，查询不分配记录id或改变未读', async () => {
    const g = ground()
    const writer = createRecordsStore({ dataDir: g.dataDir, workspace: [g.workspace] })
    cleanups.push(() => writer.close())
    const blob = await writer.blobs.put(new Uint8Array([1, 2, 3]))
    writer.serviceFor('existing').appendEntry({ kind: 'user', content: { text: '看图' }, at: 10,
      payload: { refs: [{ kind: 'image', at: 0, marker: '@saved.png', source: '/gone/saved.png', label: 'saved.png', name: 'saved.png', mime: 'image/png', blob }] } })
    writer.appendEvent({ id: 2, session: 'existing', turn: 1, at: 11, kind: 'tool.decision', data: {
      call: 1, decision: 'approve', decider: 'auto', elapsedMs: 0,
    } })
    expect(g.store.decisionHistory()).toEqual({ total: 0, auto: 0, kernel: 0 })
    expect(g.store.decisionHistory([g.workspace])).toEqual({ total: 1, auto: 1, kernel: 0 })
    const selected = { ...g.context, session: 'existing', cwd: g.root }
    const before = bytesUnder(g.root)
    const event = await query({ type: 'attachments.list' }, selected)
    expect(event?.session).toBe('existing')
    const attachments = await answer({ type: 'attachments.list' }, selected, 'attachments.catalog')
    expect(attachments.rows).toHaveLength(1)
    expect(attachments.rows[0]).toMatchObject({ name: 'saved.png', bytes: 3, blob, source: '/gone/saved.png' })
    const grants = await answer({ type: 'grants.list' }, selected, 'grants.catalog')
    expect(grants.workspace).toBe(g.workspace)
    expect(grants.history).toEqual({ total: 1, auto: 1, kernel: 0 })
    expect(bytesUnder(g.root)).toEqual(before)
    expect(await g.store.listSessions()).toHaveLength(1)
  })

  test('设置、执行、导出和独立session/history命令不冒充目录；坏配置不被吞成空表', async () => {
    const g = ground()
    writeFileSync(join(g.base, 'config.json'), '{broken')
    for (const command of [
      { type: 'session.list' }, { type: 'history.read' }, { type: 'model.switch', provider: 'ds' },
      { type: 'mcp.reconnect', server: 'real' }, { type: 'input.submit', text: '明确输入' },
      { type: 'attachments.export', entry: 1 }, { type: 'grants.revoke', index: 0 },
    ] satisfies Command[]) expect(await query(command, g.context)).toBeUndefined()
    await expect(query({ type: 'model.list' }, g.context)).rejects.toThrow('config.json')
    expect(await g.store.listSessions()).toEqual([])
  })
})
