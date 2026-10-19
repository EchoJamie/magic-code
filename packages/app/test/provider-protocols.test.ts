import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelCatalogRow, SettingsAction } from '@magic/contracts'
import { createSettings } from '../src/settings.ts'
import { connectionScopeChanged } from '../src/cache-access.ts'
import { tempDir, removeDir } from './tmp.ts'
import { makeStage } from './support.ts'
import { MODELS_DEV_URL } from '@magic/model'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function setup() {
  const home = tempDir('magic-u126-'), base = join(home, '.magic'), path = join(base, 'config.json')
  mkdirSync(base)
  cleanups.push(() => removeDir(home))
  let requests = 0
  const settings = createSettings({ magic: { home, base }, environment: { MAGIC_LOCAL_API_KEY: 'ENV_SENTINEL' },
    fetch: async url => {
      if (String(url) === MODELS_DEV_URL) return new Response('{}')
      requests++; throw new Error('配置读写不应请求模型接口')
    } })
  const apply = async (action: SettingsAction) => settings.apply(action, (await settings.read()).stamp)
  return { settings, apply, path, requests: () => requests, raw: () => JSON.parse(readFileSync(path, 'utf8')) }
}

test('自定义无认证无需列表，手填长型号与覆盖离线保存，映射只初始化空档位', async () => {
  const g = setup(), model = '本地模型/精确:原始型号-2026-10'
  await g.apply({ type: 'provider.save', provider: 'local', name: '本地', baseURL: 'http://127.0.0.1:9000/custom/v2', protocol: 'responses', auth: 'none' })
  await g.apply({ type: 'model.override', provider: 'local', model, override: {
    limits: { maxInputTokens: 32000, maxOutputTokens: 8000, maxContextTokens: 40000 }, capabilities: { image: false, tools: true },
  } })
  await g.apply({ type: 'model.configure', choice: 'arcane', provider: 'local', model: '另一型号' })
  await g.apply({ type: 'model.configure', choice: 'default', provider: 'local', model, initialize: true })
  const snapshot = await g.settings.read()
  expect(snapshot.configuration.providers).toMatchObject({ local: { auth: 'none', keySource: 'none', keyConfigured: false } })
  expect(JSON.stringify(snapshot)).not.toContain('ENV_SENTINEL')
  expect(g.raw().models).toEqual({ default: { provider: 'local', model }, cantrip: { provider: 'local', model }, spell: { provider: 'local', model }, arcane: { provider: 'local', model: '另一型号' } })
  expect(g.raw().providers.local.modelOverrides[model].capabilities).toEqual({ image: false, tools: true })
  await g.apply({ type: 'model.override', provider: 'local', model, override: null })
  expect(g.raw().providers.local.modelOverrides[model]).toBeUndefined()
  expect(g.raw().models.default.model).toBe(model)
  expect(g.requests()).toBe(0)
})

test('官方显式不支持协议在落盘前拒绝，改名不锁定自动选择', async () => {
  const g = setup()
  await g.apply({ type: 'provider.save', provider: 'ds', vendor: 'deepseek' })
  await g.apply({ type: 'model.configure', choice: 'default', provider: 'ds', model: 'deepseek-v4-pro' })
  const before = readFileSync(g.path, 'utf8')
  await expect(g.apply({ type: 'provider.save', provider: 'ds', protocol: 'responses' })).rejects.toThrow(/deepseek-v4-pro/)
  expect(readFileSync(g.path, 'utf8')).toBe(before)
  await g.apply({ type: 'provider.save', provider: 'ds', name: '更名' })
  expect(g.raw().providers.ds.protocol).toBeUndefined()
  expect(g.requests()).toBe(0)
})

test('旧编辑戳及无效联合容量都保留完整配置', async () => {
  const g = setup()
  await g.apply({ type: 'provider.save', provider: 'local', baseURL: 'http://localhost:8000/v1', auth: 'none', protocol: 'messages' })
  const stamp = (await g.settings.read()).stamp
  const next = { ...g.raw(), unrelated: { keep: true } }
  writeFileSync(g.path, JSON.stringify(next))
  await expect(g.settings.apply({ type: 'provider.save', provider: 'local', name: '未提交' }, stamp)).rejects.toThrow(/修改/)
  await expect(g.apply({ type: 'model.override', provider: 'local', model: 'm', override: { limits: { maxOutputTokens: 100, maxContextTokens: 50 } } })).rejects.toThrow(/联合上下文/)
  expect(g.raw()).toEqual(next)
})

test('协议及认证改变作废缓存范围，普通改名可保留', () => {
  const before = { baseURL: 'http://localhost:8000/v1', protocol: 'responses' as const, auth: 'none' as const }
  expect(connectionScopeChanged(before, { ...before, name: '改名' })).toBe(false)
  expect(connectionScopeChanged(before, { ...before, protocol: 'messages' })).toBe(true)
  expect(connectionScopeChanged(before, { ...before, auth: 'bearer' })).toBe(true)
})


test('保存协议不改变已绑定 Agent，明确应用重新解析；无会话时也采用新连接', () => {
  const stage = makeStage({ config: { providers: { local: { baseURL: 'http://localhost:9000/prefix', protocol: 'chat-completions', auth: 'none' } }, models: { default: { provider: 'local', model: 'raw' } } } })
  const assembly = stage.assemble({ modelGateway: undefined })
  try {
    const before = assembly.models?.current()
    expect(before?.protocol).toBe('chat-completions')
    const raw = JSON.parse(readFileSync(stage.configPath, 'utf8'))
    raw.providers.local.protocol = 'responses'
    writeFileSync(stage.configPath, JSON.stringify(raw))
    expect(assembly.models?.current()).toEqual(before)
    expect(assembly.switchModel({ choice: 'default' })).toEqual({ ok: true, selection: { choice: 'default', provider: 'local', model: 'raw', protocol: 'responses', endpoint: 'http://localhost:9000/prefix' } })
    expect(assembly.models?.current()?.protocol).toBe('responses')
    raw.providers.local.baseURL = 'http://localhost:9001/new'
    writeFileSync(stage.configPath, JSON.stringify(raw))
    expect(assembly.switchModel({ choice: 'default' }).ok).toBe(true)
    expect(assembly.models?.current()?.endpoint).toBe('http://localhost:9001/new')
  } finally { assembly.close(); stage.dispose() }
})

test('设置读面只开放当前协议能表达的思考形态，保留用户原始覆盖', async () => {
  const g = setup()
  await g.apply({ type: 'provider.save', provider: 'local', baseURL: 'http://localhost:8000/v1', auth: 'none', protocol: 'responses' })
  const support = { default: 'on' as const, disable: true, levels: ['minimal', 'low', 'private-level'], budget: { minTokens: 1024, maxTokens: 4096 } }
  await g.apply({ type: 'model.override', provider: 'local', model: 'm', override: { reasoningSupport: support } })
  const response = ((await g.settings.read()).catalog as readonly ModelCatalogRow[]).find(row => row.provider === 'local')!
  expect(response.effectiveReasoning?.m).toEqual({ default: 'on', disable: true, levels: ['minimal', 'low'] })
  expect(response.modelOverrides?.m?.reasoningSupport).toEqual(support)
  await g.apply({ type: 'provider.save', provider: 'local', protocol: 'messages' })
  const messages = ((await g.settings.read()).catalog as readonly ModelCatalogRow[]).find(row => row.provider === 'local')!
  expect(messages.effectiveReasoning?.m).toEqual({ default: 'on', disable: true, levels: ['low'], budget: { minTokens: 1024, maxTokens: 4096 } })
})

test('管理读面保留已有 Agent 的实际组合，不用已修改的服务地址重解释', async () => {
  const g = setup()
  await g.apply({ type: 'provider.save', provider: 'local', baseURL: 'http://localhost:8000/v1', auth: 'none', protocol: 'responses' })
  await g.apply({ type: 'model.configure', choice: 'default', provider: 'local', model: 'm' })
  const selection = { choice: 'default' as const, provider: 'local', model: 'm', protocol: 'responses' as const, endpoint: 'http://localhost:8000/v1' }
  await g.apply({ type: 'provider.save', provider: 'local', baseURL: 'http://localhost:9000/v2', auth: 'none', protocol: 'messages' })
  expect((await g.settings.catalog(selection)).current).toEqual(selection)
  expect((await g.settings.catalog(selection, { choice: 'default' })).current).toEqual({ ...selection, protocol: 'messages', endpoint: 'http://localhost:9000/v2' })
})
