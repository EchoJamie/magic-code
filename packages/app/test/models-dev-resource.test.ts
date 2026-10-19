import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODELS_DEV_TTL_MS, MODELS_DEV_URL } from '@magic/model'
import { createModelsDevResource, MODELS_DEV_CACHE_FILE } from '../src/models-dev-resource.ts'
import { createSettings } from '../src/settings.ts'
import { configStamp } from '@magic/config'
import { managedModelChoices, resolveManagedModel } from '../src/agent-models.ts'
import type { ModelCatalogRow } from '@magic/contracts'

const id = 'MiniMax-M3.1-Flash'
const catalog = (output = 512_000) => ({ 'minimax-cn': { api: 'https://api.minimax.cn/anthropic/v1', models: {
  [id]: { id, last_updated: '2026-10-19', limit: { context: 1_000_000, output },
    modalities: { input: ['text', 'image'], output: ['text'] }, tool_call: true,
    reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }] },
  'not-listed': { id: 'not-listed', limit: { context: 100 } },
} } })

test('文件缓存按需解析、1 小时过期、手动绕过 TTL；失败保留成功文件且不残留临时文件', async () => {
  const base = mkdtempSync(join(tmpdir(), 'magic-models-dev-'))
  let now = 1000, calls = 0, broken = false
  const fetcher = async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe(MODELS_DEV_URL)
    expect(init?.headers).toBeUndefined()
    calls++
    return new Response(broken ? '{}' : JSON.stringify(catalog()))
  }
  const resource = createModelsDevResource(base, fetcher, () => now)
  try {
    await Promise.all([resource.refresh(), resource.refresh()])
    expect(calls).toBe(1)
    expect(resource.read().snapshot?.providers['minimax-cn']?.models[id]?.limits?.maxOutputTokens).toBe(512_000)
    await resource.refresh()
    expect(calls).toBe(1)
    now += MODELS_DEV_TTL_MS
    await resource.refresh()
    expect(calls).toBe(2)
    await resource.refresh(true)
    expect(calls).toBe(3)
    const file = join(base, MODELS_DEV_CACHE_FILE), saved = readFileSync(file, 'utf8')
    broken = true
    await resource.refresh(true)
    expect(resource.read().failure).toContain('有效模型目录')
    expect(readFileSync(file, 'utf8')).toBe(saved)
    expect(readdirSync(join(base, 'cache'))).toEqual(['models.dev.json'])
    writeFileSync(file, JSON.stringify({ fetchedAt: now + 1, data: catalog(500_000) }))
    expect(resource.read().snapshot?.providers['minimax-cn']?.models[id]?.limits?.maxOutputTokens).toBe(500_000)
    expect(createModelsDevResource(base, fetcher).read().snapshot?.fetchedAt).toBe(now + 1)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('设置与只读模型预检共用资源：正式型号有规格，Preview 保留，供应商列表不混入第三方型号', async () => {
  const base = mkdtempSync(join(tmpdir(), 'magic-model-catalog-')), path = join(base, 'config.json')
  let catalogCalls = 0, supplierCalls = 0
  const magic = { base, home: base }
  const settings = createSettings({ magic, environment: {}, fetch: async (url, init) => {
    if (String(url) === MODELS_DEV_URL) {
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      catalogCalls++
      return new Response(JSON.stringify(catalog()))
    }
    expect(String(url)).toBe('https://api.minimaxi.com/v1/models')
    supplierCalls++
    return new Response(JSON.stringify({ data: [{ id }] }))
  } })
  try {
    writeFileSync(path, JSON.stringify({ providers: { mm: { vendor: 'minimax', baseURL: 'https://api.minimaxi.com/v1', apiKey: 'TEST_SECRET', modelOverrides: { [`${id}-Preview`]: {} } } } }))
    const first = await settings.read()
    expect(catalogCalls).toBe(1)
    expect(supplierCalls).toBe(0)
    await settings.apply({ type: 'model.refresh', provider: 'mm' }, first.stamp)
    const snapshot = await settings.read(), row = snapshot.catalog[0] as ModelCatalogRow
    expect(catalogCalls).toBe(2)
    expect(row.cache?.snapshot?.models).toEqual([{ id }])
    expect(row.modelInfo?.[id]?.limits).toEqual({ maxContextTokens: 1_000_000, maxOutputTokens: 512_000 })
    expect(row.modelInfo?.[id]?.metadata).toEqual({ provider: 'minimax-cn', updatedAt: '2026-10-19' })
    expect(row.effectiveReasoning?.[id]?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(JSON.stringify(snapshot)).not.toContain('TEST_SECRET')
    await settings.apply({ type: 'model.configure', provider: 'mm', model: id, choice: 'default' }, snapshot.stamp)
    await settings.apply({ type: 'model.override', provider: 'mm', model: id, override: { limits: { maxOutputTokens: 4096 }, capabilities: { image: false } } }, configStamp(path))
    expect(JSON.parse(readFileSync(path, 'utf8')).providers.mm.modelOverrides[`${id}-Preview`]).toEqual({})
    const selected = await resolveManagedModel({ magic, environment: {}, defaults: { provider: 'mm', model: id, choice: 'default', protocol: 'responses', endpoint: 'https://api.minimaxi.com/v1' }, model: { reasoning: { mode: 'level', level: 'high' } } })
    expect(selected.reasoning).toEqual({ mode: 'level', level: 'high' })
    const choices = await managedModelChoices(magic, {})
    expect(choices[0] && 'capabilities' in choices[0] ? choices[0].capabilities?.image : undefined).toBe(false)
    expect(catalogCalls).toBe(2)
    expect(supplierCalls).toBe(1)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('真实装配读取缓存规格，实际请求使用 512000；重新装配按文件新值计算预算', async () => {
  const { assemble, attachShell, loadConfig } = await import('../src/index.ts')
  const base = mkdtempSync(join(tmpdir(), 'magic-models-dev-request-')), path = join(base, 'config.json')
  const magic = { base, home: base }, sent: Record<string, unknown>[] = []
  const fetcher = async (url: unknown, init?: RequestInit) => {
    if (String(url) === MODELS_DEV_URL) return Response.json(catalog())
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id }] })
    sent.push(JSON.parse(String(init?.body)))
    const frame = (choices: unknown) => `data: ${JSON.stringify({ id: 'test', model: id, choices })}\n\n`
    return new Response(frame([{ index: 0, delta: { content: '完成' } }]) + frame([{ index: 0, delta: {}, finish_reason: 'stop' }]) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    writeFileSync(path, JSON.stringify({ providers: { mm: { vendor: 'minimax', protocol: 'chat-completions', apiKey: 'SYNTHETIC' } }, models: { default: { provider: 'mm', model: id } } }))
    await createModelsDevResource(base, fetcher).refresh()
    for (const output of [512_000, 500_000]) {
      if (output === 500_000) writeFileSync(join(base, MODELS_DEV_CACHE_FILE), JSON.stringify({ fetchedAt: Date.now(), data: catalog(output) }))
      const app = assemble({ cwd: base, magic, config: loadConfig({ path, magic }), modelFetch: fetcher, grantsFile: join(base, 'grants.json') })
      const shell = attachShell(app.shell)
      try {
        await app.ready()
        expect(app.switchModel({ reasoning: { mode: 'level', level: 'high' } }).ok).toBe(true)
        expect(app.contextWindow).toBe(1_000_000 - output)
        await shell.submit('检查输出上限')
        expect(shell.events.filter(event => event.kind === 'error').map(event => event.data.message)).toEqual([])
        expect(sent).toHaveLength(output === 512_000 ? 1 : 2)
        expect(sent.at(-1)?.max_completion_tokens).toBe(output)
        expect(sent.at(-1)?.reasoning_effort).toBe('high')
        expect(sent.at(-1)?.model).toBe(id)
      } finally { shell.dispose(); app.close() }
    }
  } finally { rmSync(base, { recursive: true, force: true }) }
})
