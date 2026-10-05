import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { createRecordsStore } from '@magic/records'
import { createWorkspaceService, createSkills } from '@magic/execution'
import { createGrantLedger } from '@magic/permission'
import { resolveModelChoice } from '../src/agent-models.ts'
import { loadConfig } from '../src/config.ts'
import { saveProvider } from '../src/config-save.ts'
import { createSettings, type SettingsContext } from '../src/settings.ts'
import { configStamp } from '../src/cache-access.ts'
import { cliGround } from './resident-cli-fixture.ts'
import type { SettingsAction } from '@magic/contracts'
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
function setup() {
  const g = cliGround(), workspace = join(g.root, 'workspace'), config = join(g.base, 'config.json')
  mkdirSync(workspace)
  const store = createRecordsStore({ dataDir: g.dataDir, workspace: [] })
  cleanups.push(() => { store.close(); g.close() })
  let responsibility = false, preferences = 0, grants = 0
  const context: SettingsContext = { magic: { base: g.base, home: g.home }, cwd: workspace, store, mcp: [],
    canChangeData: () => !responsibility, mcpWorks: async () => [], preferencesChanged: async () => { preferences++ },
    reconnect: async () => { throw new Error('没有活动工作，未重连') }, grantsChanged: async () => { grants++ } }
  const settings = createSettings(context)
  return { ...g, workspace, config, store, settings, context, responsibility: (value: boolean) => { responsibility = value }, preferences: () => preferences, grants: () => grants,
    apply: async (action: SettingsAction) => settings.apply(action, (await settings.read()).stamp),
    raw: () => JSON.parse(readFileSync(config, 'utf8')) as Record<string, unknown> }
}

test('七类设置的实际配置消费：连接/映射/材料/角色/根/权限/呈现，保留无关字段与零Session', async () => {
  const g = setup()
  writeFileSync(g.config, JSON.stringify({ dataDir: g.dataDir, untouched: { keep: 1 } }))
  await g.apply({ type: 'provider.save', provider: 'ds', vendor: 'deepseek', apiKey: 'SENTINEL_PROVIDER_KEY' })
  await g.apply({ type: 'model.alias.set', alias: 'default', provider: 'ds', model: 'deepseek-chat', initialize: true })
  await g.apply({ type: 'model.alias.set', alias: 'arcane', provider: 'ds', model: 'deepseek-reasoner' })
  await g.apply({ type: 'model.override', provider: 'ds', model: 'deepseek-chat', override: { limits: { maxContextTokens: 256000 }, capabilities: { image: false } } })
  await g.apply({ type: 'role.save', id: 'reviewer', role: { name: '审查者', instructions: '只读审查', tools: [], model: { alias: 'arcane', reasoning: { mode: 'default' } } } })
  await g.apply({ type: 'sources.set', source: 'rules.sources', paths: [join(g.workspace, 'team.md')] })
  await g.apply({ type: 'sources.set', source: 'rules.linkSources', paths: [g.workspace] })
  const skill = join(g.workspace, 'extra', 'demo'); mkdirSync(skill, { recursive: true }); writeFileSync(join(skill, 'SKILL.md'), '---\nname: demo\ndescription: 示例技能\n---\n只读查证')
  await g.apply({ type: 'sources.set', source: 'skills.sources', paths: [join(g.workspace, 'extra')] })
  await g.apply({ type: 'workspace.set', roots: [g.workspace] })
  await g.apply({ type: 'permissions.set', rules: [{ tool: 'read', path: '**/*.md', op: 'read' }] })
  await g.apply({ type: 'prefs.set', statusLine: { cells: ['workspace', 'model', 'reasoning', 'context', 'session'], color: false }, reducedMotion: true })
  const loaded = loadConfig({ magic: g.context.magic }), config = loaded.config
  expect(config.modelAliases?.default?.model).toBe('deepseek-chat'); expect(config.modelAliases?.spell?.model).toBe('deepseek-chat'); expect(config.modelAliases?.arcane?.model).toBe('deepseek-reasoner')
  const picked = resolveModelChoice({ providers: config.providers, aliases: config.modelAliases, config: config.agentRoles?.reviewer?.model })
  expect(picked.ok && picked.selection.model).toBe('deepseek-reasoner')
  expect(config.agentRoles?.reviewer?.tools).toEqual([])
  const workspace = createWorkspaceService({ roots: config.workspaceRoots! })
  expect(workspace.defaultRoot()).toBe(g.workspace)
  expect(createSkills({ workspace, home: g.home, magicBase: g.base, sources: config.skills!.sources! }).discover().skills.some(s => s.name === 'demo')).toBe(true)
  const snapshot = await g.settings.read()
  expect(snapshot.sources).toHaveLength(3); expect(snapshot.sources[0]?.problem).toBeDefined()
  expect(snapshot.configuration).not.toHaveProperty('untouched'); expect(g.raw().untouched).toEqual({ keep: 1 })
  expect(JSON.stringify(snapshot)).not.toContain('SENTINEL_PROVIDER_KEY')
  expect(statSync(g.config).mode & 0o777).toBe(0o600); expect(g.preferences()).toBe(1); expect(await g.store.listSessions()).toEqual([])
})

test('MCP 值只进不出，保留/替换/清除区分，浏览不执行命令', async () => {
  const g = setup()
  await g.apply({ type: 'mcp.save', name: 'local', server: { command: '/SENTINEL_NEVER_RUN', args: ['a b', 'c'] }, secrets: { PRIVATE: 'SENTINEL_ENV', OLD: 'SENTINEL_OLD' } })
  expect(JSON.stringify(await g.settings.read())).not.toContain('SENTINEL_ENV')
  await g.apply({ type: 'mcp.save', name: 'local', server: { command: '/SENTINEL_NEVER_RUN', args: ['d'] }, secrets: { OLD: null, NEW: 'SENTINEL_NEW' } })
  expect(loadConfig({ magic: g.context.magic }).config.mcp?.servers.local).toEqual({ command: '/SENTINEL_NEVER_RUN', args: ['d'], env: { PRIVATE: 'SENTINEL_ENV', NEW: 'SENTINEL_NEW' } })
  await g.apply({ type: 'mcp.save', name: 'http', server: { url: 'http://127.0.0.1:1/mcp' }, secrets: { Authorization: 'SENTINEL_HEADER' } })
  expect(JSON.stringify(await g.settings.read())).not.toContain('SENTINEL_HEADER')
  await g.apply({ type: 'mcp.remove', name: 'local' })
  expect(loadConfig({ magic: g.context.magic }).config.mcp?.servers.local).toBeUndefined()
  expect(await g.store.listSessions()).toEqual([])
})

test('首次文件新建/同mtime内容外改/两入口旧快照/损坏JSON均拒绝覆盖', async () => {
  const g = setup(); const before = await g.settings.read()
  await g.apply({ type: 'prefs.set', reducedMotion: true })
  await expect(g.settings.apply({ type: 'prefs.set', reducedMotion: false }, before.stamp)).rejects.toThrow('修改')
  const snapshot = await g.settings.read(), time = statSync(g.config)
  writeFileSync(g.config, JSON.stringify({ dataDir: g.dataDir, motion: { reduced: false } })); utimesSync(g.config, time.atime, time.mtime)
  const external = readFileSync(g.config, 'utf8')
  await expect(g.settings.apply({ type: 'prefs.set', reducedMotion: true }, snapshot.stamp)).rejects.toThrow('修改')
  expect(readFileSync(g.config, 'utf8')).toBe(external)
  writeFileSync(g.config, '{"apiKey":"SENTINEL_BROKEN_KEY",')
  await expect(g.settings.read()).rejects.toThrow('合法 JSON')
  try { await g.settings.read() } catch (error) { expect(String(error)).not.toContain('SENTINEL_BROKEN_KEY') }
  const stamp = configStamp(g.config)
  await expect(g.settings.apply({ type: 'prefs.set', reducedMotion: true }, stamp)).rejects.toThrow()
  expect(readFileSync(g.config, 'utf8')).toBe('{"apiKey":"SENTINEL_BROKEN_KEY",')
  const path = join(g.base, 'new.json')
  const missing = null
  writeFileSync(path, '{}')
  expect(saveProvider({ path, expectedStamp: missing, request: { provider: 'ds', vendor: 'deepseek' } }).ok).toBe(false)
})

test('无效字段与数据责任拒写；角色工具缺省/空列表、清除默认与移除引用不混', async () => {
  const g = setup(); const before = readFileSync(g.config, 'utf8')
  await expect(g.apply({ type: 'workspace.set', roots: [] })).rejects.toThrow()
  await expect(g.apply({ type: 'permissions.set', rules: [{ tool: 'read', op: 'NOT_AN_OP' }] })).rejects.toThrow('permissions.rules')
  await expect(g.apply({ type: 'sources.set', source: 'rules.sources', paths: ['relative'] })).rejects.toThrow('绝对路径')
  expect(readFileSync(g.config, 'utf8')).toBe(before)
  g.responsibility(true)
  await expect(g.apply({ type: 'data.set', directory: join(g.root, 'new-data') })).rejects.toThrow('执行责任')
  expect(readFileSync(g.config, 'utf8')).toBe(before)
  g.responsibility(false)
  await g.apply({ type: 'provider.save', provider: 'ds', vendor: 'deepseek' }); await g.apply({ type: 'model.alias.set', alias: 'default', provider: 'ds', model: 'deepseek-chat' })
  await expect(g.apply({ type: 'provider.remove', provider: 'ds' })).rejects.toThrow('引用')
  await g.apply({ type: 'role.save', id: 'a', role: { name: '角色', instructions: '只读', tools: [] } })
  expect(loadConfig({ magic: g.context.magic }).config.agentRoles?.a?.tools).toEqual([])
  await g.apply({ type: 'role.save', id: 'a', role: { name: '角色', instructions: '只读' } })
  expect(loadConfig({ magic: g.context.magic }).config.agentRoles?.a?.tools).toBeUndefined()
  await g.apply({ type: 'model.alias.clear', alias: 'default' }); await g.apply({ type: 'provider.remove', provider: 'ds' })
  await g.apply({ type: 'data.set', directory: join(g.root, 'new-data') }); expect(loadConfig({ magic: g.context.magic }).config.dataDir).toBe(join(g.root, 'new-data'))
})

test('授权撤销比较真实文件身份，重读后撤销且回读同一事实', async () => {
  const g = setup(), grantPath = join(g.base, 'grants.json')
  writeFileSync(grantPath, JSON.stringify({ version: 1, workspaces: { [g.workspace]: [{ tool: 'read', grantedAt: 1 }] } }))
  const snapshot = await g.settings.read()
  writeFileSync(grantPath, JSON.stringify({ version: 1, workspaces: { [g.workspace]: [{ tool: 'write', grantedAt: 1 }, { tool: 'read', grantedAt: 1 }] } }))
  await expect(g.apply({ type: 'grants.revoke', workspace: g.workspace, index: 0, grantStamp: snapshot.grantStamp })).rejects.toThrow('授权已改变')
  const fresh = await g.settings.read()
  await g.apply({ type: 'grants.revoke', workspace: g.workspace, index: 1, grantStamp: fresh.grantStamp })
  const current = await g.settings.read(); expect(current.grants[0]?.entries).toHaveLength(1); expect(g.grants()).toBe(1)
  const ledger = createGrantLedger({ workspace: g.workspace }); ledger.replace({ version: 1, workspaces: { [g.workspace]: [{ tool: 'read', grantedAt: 1 }] } }); expect(ledger.rules()).toHaveLength(1)
  ledger.replace({ version: 1, workspaces: {} }); expect(ledger.rules()).toEqual([])
})

test('显式刷新真实本地列表，保存映射与偏好后仍能读取缓存；无自动外连', async () => {
  const g = setup(); let requests = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return Response.json({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }) } })
  cleanups.push(() => server.stop(true))
  await g.apply({ type: 'provider.save', provider: 'local', vendor: 'deepseek', baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'SENTINEL_REFRESH' })
  await g.settings.read(); expect(requests).toBe(0)
  await g.apply({ type: 'model.refresh', provider: 'local' }); expect(requests).toBe(1)
  expect(JSON.stringify(await g.settings.read())).toContain('deepseek-chat')
  await g.apply({ type: 'model.alias.set', alias: 'default', provider: 'local', model: 'deepseek-chat' })
  await g.apply({ type: 'prefs.set', reducedMotion: true })
  const after = await g.settings.read(); expect(JSON.stringify(after.catalog)).toContain('deepseek-chat'); expect(JSON.stringify(after)).not.toContain('SENTINEL_REFRESH'); expect(requests).toBe(1)
})


test('自由 ID 和敏感名称按自己的键保存，不命中对象原型', async () => {
  const g = setup()
  await g.apply({ type: 'role.save', id: '__proto__', role: { name: '原型同名角色', instructions: '按明确 ID 查询', tools: [] } })
  expect(Object.hasOwn(loadConfig({ magic: g.context.magic }).config.agentRoles!, '__proto__')).toBe(true)
  await g.apply({ type: 'mcp.save', name: 'local', server: { command: '/SENTINEL_NEVER_RUN' }, secrets: JSON.parse('{"__proto__":"SENTINEL_PROTO"}') })
  expect(JSON.stringify(g.raw())).toContain('SENTINEL_PROTO')
  expect(JSON.stringify(await g.settings.read())).not.toContain('SENTINEL_PROTO')
})
