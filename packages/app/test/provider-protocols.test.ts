import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelCatalogRow, SettingsAction } from '@magic/contracts'
import { createSettings } from '../src/settings.ts'
import { connectionScopeChanged } from '../src/cache-access.ts'
import { attachShell } from '../src/index.ts'
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

test('官方协议不再按型号拦：照旧落盘；改名不锁定自动选择', async () => {
  const g = setup()
  await g.apply({ type: 'provider.save', provider: 'ds', vendor: 'deepseek' })
  await g.apply({ type: 'model.configure', choice: 'default', provider: 'ds', model: 'deepseek-v4-pro' })
  // 改名不动协议（不锁定自动选择）。
  await g.apply({ type: 'provider.save', provider: 'ds', name: '更名' })
  expect(g.raw().providers.ds.protocol).toBeUndefined()
  // 协议兼容不再是硬闸门：官方提示里没有该型号的协议也照落盘，不回滚配置。
  await g.apply({ type: 'provider.save', provider: 'ds', protocol: 'responses' })
  expect(g.raw().providers.ds.protocol).toBe('responses')
  expect(g.raw().models.default).toEqual({ provider: 'ds', model: 'deepseek-v4-pro' })
  expect(g.requests()).toBe(0)
})

test('对话能力明确不支持也不拦保存与映射', async () => {
  const g = setup(), model = '只做嵌入的型号'
  await g.apply({ type: 'provider.save', provider: 'local', baseURL: 'http://127.0.0.1:9000/v1', auth: 'none', protocol: 'chat-completions' })
  await g.apply({ type: 'model.override', provider: 'local', model, override: { capabilities: { chat: false } } })
  // 保存前的预检不再因 `chat` 能力拒绝——映射照旧落盘。
  await g.apply({ type: 'model.configure', choice: 'default', provider: 'local', model })
  expect(g.raw().models.default).toEqual({ provider: 'local', model })
  expect(g.raw().providers.local.modelOverrides[model].capabilities).toEqual({ chat: false })
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


test('改协议或地址后下一次请求按当前配置组装，不必重新选档', async () => {
  const seen: string[] = []
  const chat = 'data: {"choices":[{"index":0,"delta":{"content":"好"}}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n'
  const responses = [
    { type: 'response.created', response: { id: 'resp', created_at: 1, model: 'raw' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg' } },
    { type: 'response.output_text.delta', item_id: 'msg', output_index: 0, content_index: 0, delta: '好' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg' } },
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
  const modelFetch = async (input: unknown) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    seen.push(url.origin + url.pathname)
    const body = url.pathname.endsWith('/responses') ? responses : url.pathname.endsWith('/chat/completions') ? chat : undefined
    if (body === undefined) throw new Error(`未预期的模型请求：${url.pathname}`)
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }
  const stage = makeStage({ config: { providers: { local: { baseURL: 'http://localhost:9000/prefix', protocol: 'chat-completions', auth: 'none' } }, models: { default: { provider: 'local', model: 'raw' } } } })
  const assembly = stage.assemble({ modelGateway: undefined, modelFetch })
  const shell = attachShell(assembly.shell, { timeoutMs: 5000 })
  try {
    await shell.submit('第一句')
    expect(seen).toEqual(['http://localhost:9000/prefix/chat/completions'])
    expect(assembly.models?.current()?.protocol).toBe('chat-completions')
    // 改了协议：下一次请求自己按新配置解析，用户不必重新选档。
    const raw = JSON.parse(readFileSync(stage.configPath, 'utf8'))
    raw.providers.local.protocol = 'responses'
    writeFileSync(stage.configPath, JSON.stringify(raw))
    await shell.submit('第二句')
    expect(seen.at(-1)).toBe('http://localhost:9000/prefix/responses')
    expect(assembly.models?.current()?.protocol).toBe('responses')
    // 改了地址：同样在下一次请求生效；保存的选择字段不被改写。
    raw.providers.local.baseURL = 'http://localhost:9001/new'
    writeFileSync(stage.configPath, JSON.stringify(raw))
    await shell.submit('第三句')
    expect(seen.at(-1)).toBe('http://localhost:9001/new/responses')
    expect(assembly.models?.current()?.endpoint).toBe('http://localhost:9001/new')
    expect(assembly.models?.current()).toMatchObject({ choice: 'default', provider: 'local', model: 'raw' })
  } finally { shell.dispose(); assembly.close(); stage.dispose() }
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
