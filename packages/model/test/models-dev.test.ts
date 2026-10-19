import { expect, test } from 'bun:test'
import { mergeModelInfo, modelsDevProvider, parseModelsDev } from '../src/models-dev.ts'
import { createModelInfoService, modelSpecOf } from '../src/model-info.ts'
import { selectModel } from '../src/selection.ts'

const id = 'MiniMax-M3.1-Flash'
const data = { 'minimax-cn': { models: { [id]: {
  id, limit: { context: 1_000_000, output: 512_000 },
  modalities: { input: ['text', 'image', 'video'], output: ['text'] }, tool_call: true,
  reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
} } } }

test('目录数值保持原样，分别保留输入/输出/窗口，思考支持不推断默认或可关闭', () => {
  const parsed = parseModelsDev(data)['minimax-cn']!.models[id]!
  expect(parsed.limits).toEqual({ maxContextTokens: 1_000_000, maxOutputTokens: 512_000 })
  expect(parsed.capabilities).toEqual({ chat: true, image: true, tools: true })
  expect(parsed.reasoning).toEqual({ levels: ['low', 'medium', 'high', 'xhigh', 'max'] })
  const toggled = parseModelsDev({ p: { models: { m: { id: 'm', reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', min: 1024, max: 8192 }] } } } }).p!.models.m!
  expect(toggled.reasoning).toEqual({ disable: true, levels: [], budget: { minTokens: 1024, maxTokens: 8192 } })
})

test('非法容量不变成无限大或被转换，资料格式错误不能当成成功的空目录', () => {
  expect(() => parseModelsDev({ data: [{ id }] })).toThrow('有效模型目录')
  const model = parseModelsDev({ p: { models: { m: { id: 'm', limit: { context: 100, input: 101, output: '512K' } } } } }).p!.models.m!
  expect(model.limits).toEqual({ maxContextTokens: 100 })
})

test('精确匹配渠道，自定义地址不因 vendor 或同名模型借用官方资料', () => {
  expect(modelsDevProvider({ vendor: 'minimax' }, {})).toBe('minimax-cn')
  expect(modelsDevProvider({ vendor: 'minimax', baseURL: 'https://api.minimaxi.com/v1' }, {})).toBe('minimax-cn')
  expect(modelsDevProvider({ vendor: 'minimax', baseURL: 'https://private.test/v1' }, parseModelsDev(data))).toBeUndefined()
  const providers = { proxy: { api: 'https://private.test/v1', models: {} } }
  expect(modelsDevProvider({ baseURL: 'https://private.test/v1/' }, providers)).toBe('proxy')
  expect(modelsDevProvider({ baseURL: 'https://private.test/v1' }, { ...providers, other: providers.proxy })).toBeUndefined()
})

test('读取时补充精确型号，原始列表不增加条目；供应商逐字段优先，用户覆盖最终生效', async () => {
  const config = { vendor: 'minimax', modelOverrides: { [id]: { limits: { maxOutputTokens: 4096 } } } }
  const raw = { id, limits: { maxContextTokens: 900_000 }, capabilities: { tools: false } }
  const service = createModelInfoService({
    connections: () => [{ id: 'mm', config, baseURL: 'https://api.minimax.cn/v1', apiKey: 'fake' }],
    cache: { read: () => undefined, replace: async () => {}, drop: async () => {} },
    now: () => 1000, fetch: async () => new Response(JSON.stringify({ data: [{ id, context_window: 900_000, capabilities: { tools: false } }] })),
    metadata: { read: () => ({ snapshot: { fetchedAt: 1000, providers: parseModelsDev(data) } }), refresh: async () => false },
  })
  await service.refresh('mm')
  expect(service.peek('mm').snapshot!.models).toEqual([raw])
  const info = service.model('mm', id)!
  expect(info.limits).toEqual({ maxContextTokens: 900_000, maxOutputTokens: 512_000 })
  expect(info.capabilities?.tools).toBe(false)
  expect(modelSpecOf(config, id, info)).toMatchObject({ maxOutputTokens: 4096, inputBudget: 895_904 })
  for (const unknown of [`${id}-Preview`, id.toLowerCase(), 'toString', 'constructor', '__proto__']) expect(service.model('mm', unknown)).toBeUndefined()
  expect(selectModel({ providers: { mm: config }, modelInfoOf: () => info }, { choice: 'default', provider: 'mm', model: id, reasoning: { mode: 'level', level: 'high' } }).ok).toBe(true)
  expect(selectModel({ providers: { mm: config }, modelInfoOf: () => info }, { choice: 'default', provider: 'mm', model: id, reasoning: { mode: 'off' } }).ok).toBe(false)
  expect(selectModel({ providers: { mm: config } }, { choice: 'default', provider: 'mm', model: '新正式型号' }).ok).toBe(true)
})

test('接口明确给出的思考字段优先，其余字段保留目录值', () => {
  expect(mergeModelInfo(id, { id, reasoning: { levels: ['high'], disable: false } }, { id, reasoning: { levels: ['low', 'high'], disable: true, budget: { minTokens: 10 } } })?.reasoning)
    .toEqual({ levels: ['high'], disable: false, budget: { minTokens: 10 } })
})
