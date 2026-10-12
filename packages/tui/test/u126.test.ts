import { describe, expect, test } from 'bun:test'
import type { ModelCatalogRow, VendorInfo } from '@magic/contracts'
import { createStage } from './screen.ts'
import type { Stage } from './screen.ts'
import { event } from './events.ts'
import { modelEditor, modelOverride, providerEditor, providerRequest, protocols, effectiveProtocol } from '../src/model-editor.ts'

const vendors: readonly VendorInfo[] = [{ vendor: 'official', label: '官方', regions: [{ id: 'cn', label: '中国', baseURL: 'https://secret.example/v1' }], protocols: protocols.map(one => ({ ...one, models: ['原始型号'] })) }]
const entry: ModelCatalogRow = { provider: 'local', name: '本地', baseURL: 'http://localhost:1234/custom/v2', protocol: 'responses', auth: 'none' }
function picker(stage: Stage) { const dock = stage.shell.getView().dock; if (dock.kind !== 'picker') throw new Error(`不是选择器：${dock.kind}`); return dock.picker }
function pick(stage: Stage, value: string) {
  const rows = picker(stage).rows; const at = rows.findIndex(one => one.value === value)
  if (at < 0) throw new Error(`缺少 ${value}: ${rows.map(one => one.value).join(',')}`)
  while (picker(stage).selected !== at) stage.press({ kind: 'down' })
  stage.press({ kind: 'enter' })
}
function fill(stage: Stage, field: string, value: string) {
  pick(stage, field)
  const dock = stage.shell.getView().dock; if (dock.kind !== 'prompt') throw new Error('不是输入页')
  for (let i = 0; i < [...dock.prompt.display].length; i++) stage.press({ kind: 'backspace' })
  stage.type(value); stage.press({ kind: 'enter' })
}
function open(stage: Stage, mode: 'connect' | 'manage', entries: readonly ModelCatalogRow[] = []) {
  stage.type(`/model ${mode}`); stage.press({ kind: 'enter' })
  stage.feed([event('provider.catalog', { entries, vendors, stamp: 'initial' })])
}
function writes(stage: Stage) { return stage.commands().filter(one => ['provider.save', 'model.override', 'model.configure'].includes(one.type)) }

describe('U126 /model 集中编辑', () => {
  test('自定义默认 Responses；协议顺序、认证默认、地址保留；取消可继续草稿', () => {
    const stage = createStage(); open(stage, 'connect'); pick(stage, 'custom')
    expect(picker(stage).rows.find(one => one.value === 'protocol')?.meta).toBe('Responses')
    fill(stage, 'baseURL', 'http://localhost:1234/custom/v2')
    pick(stage, 'protocol'); expect(picker(stage).rows.find(one => one.value === 'protocol')?.meta).toBe('Anthropic Messages')
    expect(picker(stage).rows.find(one => one.value === 'auth')?.meta).toContain('API Key')
    pick(stage, 'protocol'); expect(picker(stage).rows.find(one => one.value === 'protocol')?.meta).toBe('Chat Completions')
    pick(stage, 'protocol'); pick(stage, 'auth'); pick(stage, 'auth')
    expect(picker(stage).rows.find(one => one.value === 'auth')?.meta).toBe('无需认证')
    pick(stage, 'cancel'); expect(writes(stage)).toEqual([])
    pick(stage, 'custom'); expect(picker(stage).rows.find(one => one.value === 'baseURL')?.meta).toBe(entry.baseURL)
    pick(stage, 'save')
    expect(writes(stage).at(-1)).toMatchObject({ type: 'provider.save', provider: 'custom', protocol: 'responses', auth: 'none', baseURL: entry.baseURL, expectedStamp: 'initial' })
    expect(stage.commands().some(one => one.type === 'model.refresh')).toBe(false)
  })

  test('官方无地址；更名不锁定协议；密钥隐藏，失败/冲突保留输入与原 stamp', async () => {
    const stage = createStage(); open(stage, 'manage', [{ provider: 'official', vendor: 'official', name: '已有官方' }]); pick(stage, 'official'); pick(stage, 'edit')
    expect(JSON.stringify(picker(stage))).not.toContain('https://')
    expect(picker(stage).rows.some(one => one.value === 'baseURL')).toBe(false)
    fill(stage, 'name', '新名称'); pick(stage, 'apiKey'); stage.type('synthetic-private-key')
    expect(JSON.stringify(stage.shell.getView())).not.toContain('synthetic-private-key')
    const frame = await stage.screen({ columns: 100, rows: 40 }); expect(frame.has('synthetic-private-key')).toBe(false)
    stage.press({ kind: 'enter' }); expect(writes(stage)).toEqual([]); pick(stage, 'save')
    const command = writes(stage).at(-1)!; expect(command).not.toHaveProperty('protocol')
    stage.feed([event('provider.catalog', { entries: [], vendors, saved: false, stamp: 'newer', note: '配置冲突' })])
    expect(picker(stage).source).toBe('model-editor'); expect(picker(stage).hint).toContain('配置冲突')
    expect(picker(stage).rows.find(one => one.value === 'name')?.meta).toBe('新名称')
    pick(stage, 'save'); expect(writes(stage).at(-1)).toEqual(command)
  })

  test('地址改变要求新凭据或无需认证；清空密钥为显式操作', () => {
    const edit = providerEditor('local', undefined, { ...entry, auth: 'bearer' })
    edit.values.baseURL = 'http://localhost:9999/another'
    expect(() => providerRequest(edit)).toThrow('重新填写')
    edit.values.auth = 'none'; expect(providerRequest(edit).auth).toBe('none')
    edit.values.baseURL = entry.baseURL!; edit.values.auth = 'bearer'
    edit.changed!.add('apiKey'); expect(providerRequest(edit).apiKey).toBe('')
  })

  test('无列表仍可手填，原始型号保真、容量与能力一次覆盖保存，刷新不移除手填项', () => {
    const stage = createStage(); open(stage, 'manage', [entry]); pick(stage, 'local'); pick(stage, 'manual')
    const model = '厂商/超长中文模型-原始型号:精确大小写'
    fill(stage, 'model', model); pick(stage, 'expand'); fill(stage, 'maxContextTokens', '32768'); pick(stage, 'image'); pick(stage, 'tools'); pick(stage, 'tools')
    pick(stage, 'save'); expect(writes(stage).at(-1)).toEqual({ type: 'model.override', provider: 'local', model, override: { limits: { maxContextTokens: 32768 }, capabilities: { image: true, tools: false } }, expectedStamp: 'initial' })
    const entries = [{ ...entry, modelOverrides: { [model]: { limits: { maxContextTokens: 32768 } } } }]
    stage.feed([event('model.catalog', { entries, saved: true, stamp: 'saved', configuredModels: {} })])
    pick(stage, 'edit:default'); expect(picker(stage).rows.some(one => one.pick?.model === model)).toBe(true)
    stage.feed([event('model.catalog', { entries, stamp: 'saved', configuredModels: {} })])
    expect(picker(stage).rows.some(one => one.pick?.model === model)).toBe(true)
    pick(stage, `local ${model}`); expect(writes(stage).at(-1)).toMatchObject({ type: 'model.configure', provider: 'local', model, choice: 'default', initialize: true, expectedStamp: 'saved' })
    expect(stage.commands().some(one => one.type === 'model.switch')).toBe(false)
    stage.feed([event('model.catalog', { entries, saved: false, note: '冲突' })]); expect(picker(stage).source).toBe('model')
  })

  test('三态与删除字段恢复来源；容量、预算校验不把输入输出相加', () => {
    const draft = modelEditor('local', 'm', { traits: {}, capabilities: { image: false }, reasoningSupport: { disable: true } })
    expect(draft.values.image).toBe('false'); draft.values.image = ''; draft.values.disable = ''; draft.changed!.add('disable')
    Object.assign(draft.values, { maxInputTokens: '90', maxOutputTokens: '90', maxContextTokens: '100' })
    expect(modelOverride(draft)).toEqual({ traits: {}, limits: { maxInputTokens: 90, maxOutputTokens: 90, maxContextTokens: 100 } })
    draft.values.maxInputTokens = '0'; expect(() => modelOverride(draft)).toThrow('正整数')
    draft.values.maxInputTokens = '101'; expect(() => modelOverride(draft)).toThrow('联合上下文')
    draft.values.maxInputTokens = ''; draft.values.minTokens = '20'; draft.values.maxTokens = '10'; expect(() => modelOverride(draft)).toThrow('下限')
  })

  test('编辑已有覆盖可删除，恢复来源不改映射', () => {
    const stage = createStage(); const ref = { provider: 'local', model: 'm' }
    stage.type('/model '); stage.press({ kind: 'enter' })
    stage.feed([event('model.catalog', { entries: [{ ...entry, modelOverrides: { m: { capabilities: { image: false } } } }], configuredModels: { default: ref }, stamp: 'initial' })])
    pick(stage, 'edit:default'); stage.press({ kind: 'right' }); pick(stage, 'edit-info'); pick(stage, 'remove-override')
    expect(writes(stage).at(-1)).toEqual({ type: 'model.override', ...ref, override: null, expectedStamp: 'initial' })
    expect(stage.commands().some(one => one.type === 'model.configure')).toBe(false)
  })

  test('思考预算输入校验后仅应用当前对象；无预算声明不开放', () => {
    const stage = createStage(); const ref = { provider: 'local', model: 'm' }
    stage.type('/model '); stage.press({ kind: 'enter' })
    stage.feed([event('model.catalog', { entries: [{ ...entry, effectiveReasoning: { m: { budget: { minTokens: 1024, maxTokens: 4096 } } }, modelOverrides: { m: { reasoningSupport: { budget: { minTokens: 1024, maxTokens: 4096 } } } } }], current: { ...ref, choice: 'default', protocol: 'messages', endpoint: entry.baseURL! }, configuredModels: { default: ref } })])
    pick(stage, 'reasoning'); pick(stage, 'budget'); stage.type('0'); stage.press({ kind: 'enter' })
    expect(stage.shell.getView().dock.kind).toBe('prompt'); expect(stage.commands().some(one => one.type === 'model.switch')).toBe(false)
    stage.press({ kind: 'backspace' }); stage.type('2048'); stage.press({ kind: 'enter' })
    expect(stage.commands().at(-1)).toEqual({ type: 'model.switch', reasoning: { mode: 'budget', budgetTokens: 2048 } })
    expect(stage.shell.getView().dock.kind).toBe('input')
  })

  test('取消等待中的保存后打开另一草稿，迟到回执不关闭新编辑页', () => {
    const stage = createStage(); open(stage, 'manage', [entry]); pick(stage, 'local'); pick(stage, 'manual')
    fill(stage, 'model', 'first'); pick(stage, 'save'); stage.press({ kind: 'escape' }); pick(stage, 'edit')
    fill(stage, 'name', '另一个草稿')
    stage.feed([event('model.catalog', { entries: [entry], saved: true, stamp: 'next' })])
    expect(picker(stage).source).toBe('model-editor'); expect(picker(stage).rows.find(one => one.value === 'name')?.meta).toBe('另一个草稿')
  })

  test('思考菜单唯一采用 effectiveReasoning，用户覆盖与供应商原始信息不能扩大选项', () => {
    const stage = createStage(); const ref = { provider: 'local', model: 'm' }
    const source = { ...entry, cache: { snapshot: { provider: 'local', scope: 'fixture', fetchedAt: 1, models: [{ id: 'm', reasoning: { levels: ['供应商原始档位'] } }] } }, modelOverrides: { m: { reasoningSupport: { levels: ['任意私有档位'], disable: true } } } }
    stage.type('/model '); stage.press({ kind: 'enter' })
    const current = { ...ref, choice: 'default' as const, protocol: 'responses' as const, endpoint: entry.baseURL! }
    stage.feed([event('model.catalog', { entries: [source], current })]); pick(stage, 'reasoning')
    expect(picker(stage).rows.map(one => one.value)).toEqual(['default'])
    stage.feed([event('model.catalog', { entries: [{ ...source, effectiveReasoning: { m: { disable: true, levels: ['low'] } } }], current })])
    expect(picker(stage).rows.map(one => one.value)).toEqual(['default', 'off', 'level:low'])
  })

  test('官方自动协议按精确型号成员与优先级解析；显式选择优先', () => {
    const vendor: VendorInfo = { ...vendors[0]!, protocols: [
      { id: 'responses', label: 'Responses', models: ['exact'] },
      { id: 'messages', label: 'Anthropic Messages', models: ['exact', 'message-only'] },
      { id: 'chat-completions', label: 'Chat Completions', models: ['exact', 'chat-only'] },
    ] }
    const official = { provider: 'p', vendor: vendor.vendor }
    expect(effectiveProtocol(official, vendor, 'exact')).toBe('responses')
    expect(effectiveProtocol(official, vendor, 'message-only')).toBe('messages')
    expect(effectiveProtocol(official, vendor, 'EXACT')).toBeUndefined()
    expect(effectiveProtocol({ ...official, protocol: 'chat-completions' }, vendor, 'exact')).toBe('chat-completions')
  })

  for (const columns of [200, 100]) test(`生产渲染 ${columns}×40：长型号、展开信息与保存焦点`, async () => {
    const stage = createStage(); open(stage, 'manage', [entry]); pick(stage, 'local'); pick(stage, 'manual')
    fill(stage, 'model', '本地/这是很长的中文精确原始模型标识-'.repeat(3)); pick(stage, 'expand')
    const frame = await stage.screen({ columns, rows: 40 }); expect(frame.has('图片输入')).toBe(true)
    pick(stage, 'save'); const pending = await stage.screen({ columns, rows: 40 }); expect(pending.has('正在保存')).toBe(true)
    expect(JSON.stringify(stage.shell.getView())).not.toContain('synthetic-private-key')
  })
})
