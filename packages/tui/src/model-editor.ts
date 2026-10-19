import type { ModelCatalogRow, ModelProtocol, ProviderAuth, ProviderModelOverride, ProviderSaveRequest, VendorInfo } from '@magic/contracts'
import type { PickerRow } from './view.ts'

export const protocols: readonly { id: ModelProtocol; label: string }[] = [
  { id: 'responses', label: 'Responses' }, { id: 'messages', label: 'Anthropic Messages' }, { id: 'chat-completions', label: 'Chat Completions' },
]
export const protocolLabel = (value: string): string => protocols.find(one => one.id === value)?.label ?? '未选择协议'
export function effectiveProtocol(entry: ModelCatalogRow | undefined, vendor: VendorInfo | undefined, model: string): ModelProtocol | undefined {
  if (entry?.protocol !== undefined) return entry.protocol
  if (entry?.vendor === undefined) return 'responses'
  return vendor?.protocols.find(one => one.models.includes(model))?.id
}

/**
 * 这条连接**应当直接落下的官方协议**（U126 协议优先级：Responses → Messages → Chat）。
 *
 * - 已映射的型号全都支持某一协议 ⇒ 取优先级最高的那一项；
 * - 没有共同协议 ⇒ 取优先级最高、且至少支持一个已映射型号的那项（保存前仍会逐型号校验）；
 * - 还没映射任何型号 ⇒ 取供应商支持项里的第一项。
 *
 * 不再返回「自动」：界面与保存都落到一个具体协议。
 */
export function defaultProtocolOf(vendor: VendorInfo | undefined, models: readonly string[] = []): ModelProtocol | undefined {
  if (vendor === undefined) return 'responses'
  if (models.length === 0) return vendor.protocols[0]?.id
  return (vendor.protocols.find(one => models.every(model => one.models.includes(model)))
    ?? vendor.protocols.find(one => models.some(model => one.models.includes(model)))
    ?? vendor.protocols[0])?.id
}
export type Field = { key: string; label: string; secret?: boolean; choices?: readonly { id: string; label: string }[] }
export type ModelEditor = {
  kind: 'provider' | 'model'; provider: string; model?: string; vendor?: VendorInfo; original?: ModelCatalogRow
  models?: readonly string[]; values: Record<string, string>; fields: readonly Field[]; override?: ProviderModelOverride
  changed?: Set<string>; expanded?: boolean; pending?: boolean; note?: string
}
const tri = [{ id: '', label: '未知／恢复来源' }, { id: 'true', label: '支持' }, { id: 'false', label: '不支持' }]
const numberFields: readonly Field[] = [
  { key: 'maxInputTokens', label: '最大输入 token' }, { key: 'maxOutputTokens', label: '最大输出 token' }, { key: 'maxContextTokens', label: '联合上下文窗口 token' },
]
export function providerEditor(
  provider: string,
  vendor?: VendorInfo,
  original?: ModelCatalogRow,
  mappedModels: readonly string[] = [],
): ModelEditor {
  return {
    kind: 'provider', provider, vendor, original, changed: new Set(),
    // 官方连接也落**具体协议 / 具体区域**：协议取供应商支持项里优先级最高的一项
    // （Responses → Anthropic Messages → Chat Completions），区域取第一个官方区域。
    // 不再给「自动」或「供应商默认区域」这种合成选项——屏上直接是官方给的名称。
    values: {
      name: original?.name ?? vendor?.label ?? '自定义',
      protocol: original?.protocol ?? defaultProtocolOf(vendor, mappedModels) ?? '',
      auth: original?.auth ?? (original?.protocol === 'messages' ? 'api-key' : 'bearer'),
      baseURL: original?.baseURL ?? '',
      region: original?.region ?? vendor?.regions[0]?.id ?? '',
      apiKey: '',
    },
    fields: [
      { key: 'name', label: '名称' },
      { key: 'protocol', label: '接入协议', choices: vendor ? vendor.protocols : protocols },
      ...(vendor ? (vendor.regions.length > 0 ? [{ key: 'region', label: '官方区域', choices: vendor.regions.map(one => ({ id: one.id, label: one.label })) }] : []) : [
        { key: 'baseURL', label: 'API 基础地址' },
        { key: 'auth', label: '认证', choices: [{ id: 'none', label: '无需认证' }, { id: 'bearer', label: 'Bearer' }, { id: 'api-key', label: 'API Key（x-api-key）' }] },
      ]),
      { key: 'apiKey', label: '密钥', secret: true },
    ],
  }
}
export function modelEditor(provider: string, model = '', override?: ProviderModelOverride, original?: ModelCatalogRow, vendor?: VendorInfo): ModelEditor {
  return {
    kind: 'model', provider, model, override, original, vendor, changed: new Set(), values: {
      model, ...Object.fromEntries(numberFields.map(field => [field.key, String(override?.limits?.[field.key as keyof NonNullable<ProviderModelOverride['limits']>] ?? '')])),
      image: String(override?.capabilities?.image ?? ''), tools: String(override?.capabilities?.tools ?? ''),
      default: override?.reasoningSupport?.default ?? '', disable: String(override?.reasoningSupport?.disable ?? ''),
      levels: override?.reasoningSupport?.levels?.join(', ') ?? '', minTokens: String(override?.reasoningSupport?.budget?.minTokens ?? ''), maxTokens: String(override?.reasoningSupport?.budget?.maxTokens ?? ''),
    }, fields: [
      { key: 'model', label: '原始型号' }, ...numberFields,
      { key: 'image', label: '图片输入', choices: tri }, { key: 'tools', label: '工具调用', choices: tri },
      { key: 'default', label: '思考默认', choices: [{ id: '', label: '未知／恢复来源' }, { id: 'on', label: '开启' }, { id: 'off', label: '关闭' }] },
      { key: 'disable', label: '可关闭思考', choices: tri }, { key: 'levels', label: '思考档位（逗号分隔）' },
      { key: 'minTokens', label: '思考预算下限 token' }, { key: 'maxTokens', label: '思考预算上限 token' },
    ],
  }
}
export function editorRows(editor: ModelEditor): readonly PickerRow[] {
  const fields = editor.fields.filter(field => !(field.key === 'apiKey' && editor.values.auth === 'none') && (editor.kind !== 'model' || editor.expanded || field.key === 'model'))
  return [
    ...fields.map(field => ({ label: field.label, value: field.key, current: false, oneLine: true,
      meta: field.secret ? (editor.values.apiKey ? '已输入（隐藏）' : editor.original ? '未修改' : '未填写；可使用环境变量') : field.choices?.find(one => one.id === editor.values[field.key])?.label ?? editor.values[field.key] ?? '',
    })),
    ...(editor.kind === 'model' ? [{ label: editor.expanded ? '收起模型信息' : '展开模型信息（可选）', value: 'expand', current: false, oneLine: true, meta: '用户填写优先；留空恢复供应商信息或未知' }] : []),
    { label: '保存', value: 'save', current: false, oneLine: true, meta: editor.pending ? '正在保存…' : '一次保存全部字段' },
    ...(editor.kind === 'model' && editor.override !== undefined ? [{ label: '删除用户覆盖', value: 'remove-override', current: false, oneLine: true, meta: '恢复供应商信息；不删除已有映射' }] : []),
    { label: '取消并返回', value: 'cancel', current: false, oneLine: true, meta: '不写配置；保留本次草稿' },
  ]
}
export function providerRequest(editor: ModelEditor): ProviderSaveRequest {
  const v = editor.values
  if (!v.name?.trim()) throw new Error('名称不能为空')
  if (!editor.vendor) {
    let url: URL
    try { url = new URL(v.baseURL ?? '') } catch { throw new Error('请填写有效的 HTTP／HTTPS API 基础地址') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('API 基础地址须使用 HTTP／HTTPS，凭据请填入隐藏输入')
  }
  const original = editor.original
  if (!editor.vendor && original && v.baseURL?.trim() !== original.baseURL && v.auth !== 'none' && !v.apiKey) throw new Error('地址已改变：请重新填写此服务的凭据，或选择无需认证')
  return { provider: editor.provider, name: v.name.trim(), ...(editor.vendor ? { vendor: editor.vendor.vendor, region: v.region } : { baseURL: v.baseURL!.trim(), auth: v.auth as ProviderAuth }),
    ...(!original || v.protocol !== (original.protocol ?? '') ? { protocol: v.protocol ? v.protocol as ModelProtocol : null } : {}),
    ...(editor.changed?.has('apiKey') ? { apiKey: v.apiKey } : {}),
  }
}
export function modelOverride(editor: ModelEditor): ProviderModelOverride {
  const v = editor.values
  if (!v.model?.trim()) throw new Error('原始型号不能为空')
  const positive = (key: string): number | undefined => {
    if (!v[key]?.trim()) return undefined
    const n = Number(v[key]); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('容量与预算须为正整数；未知请留空')
    return n
  }
  const limits = Object.fromEntries(numberFields.flatMap(field => { const n = positive(field.key); return n === undefined ? [] : [[field.key, n]] }))
  if (limits.maxContextTokens !== undefined && ((limits.maxInputTokens ?? 0) > limits.maxContextTokens || (limits.maxOutputTokens ?? 0) > limits.maxContextTokens)) throw new Error('输入或输出上限不能超过联合上下文窗口')
  const minTokens = positive('minTokens'); const maxTokens = positive('maxTokens')
  if (minTokens !== undefined && maxTokens !== undefined && minTokens > maxTokens) throw new Error('思考预算下限不能超过上限')
  const capabilities = { ...editor.override?.capabilities }
  for (const key of ['image', 'tools'] as const) { delete capabilities[key]; if (v[key] !== '') capabilities[key] = v[key] === 'true' }
  const levels = v.levels?.split(/[,，]/).map(one => one.trim()).filter(Boolean)
  const reasoningChanged = ['default', 'disable', 'levels', 'minTokens', 'maxTokens'].some(key => editor.changed?.has(key))
  const reasoningSupport = !reasoningChanged && editor.override?.reasoningSupport !== undefined ? editor.override.reasoningSupport : {
    ...(v.default ? { default: v.default as 'on' | 'off' } : {}), ...(v.disable ? { disable: v.disable === 'true' } : {}),
    ...(levels?.length ? { levels } : {}), ...(minTokens === undefined && maxTokens === undefined && editor.override?.reasoningSupport?.budget !== undefined && !editor.changed?.has('minTokens') && !editor.changed?.has('maxTokens') ? { budget: {} } : {}), ...(minTokens !== undefined || maxTokens !== undefined ? { budget: { ...(minTokens === undefined ? {} : { minTokens }), ...(maxTokens === undefined ? {} : { maxTokens }) } } : {}),
  }
  return { ...(editor.override?.traits === undefined ? {} : { traits: editor.override.traits }), ...(Object.keys(limits).length ? { limits } : {}), ...(Object.keys(capabilities).length ? { capabilities } : {}), ...(Object.keys(reasoningSupport).length || (!reasoningChanged && editor.override?.reasoningSupport !== undefined) ? { reasoningSupport } : {}) }
}
