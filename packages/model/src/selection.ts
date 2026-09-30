import type { ModelInfo, ProviderConfig, ReasoningSetting } from '@magic/contracts'
import { ownOf } from './capacity.ts'
import { vendorOf } from './vendors.ts'
import type { ModelSelection, ModelSwitchRequest, ModelSwitchResult } from './registry.ts'

/** 只使用目标连接、精确模型的信息；能力允许之后仍须由实际适配映射参数。 */
export function reasoningFailure(
  config: ProviderConfig,
  model: string,
  setting: ReasoningSetting | undefined,
  known?: ModelInfo,
): string | undefined {
  if (setting === undefined) return undefined
  if (typeof setting !== 'object' || setting === null || Array.isArray(setting)) return '思考设置须是对象'
  if (setting.mode === 'default') return undefined
  const adapter = config.vendor === undefined ? undefined : vendorOf(config.vendor)
  const support = ownOf(config.modelOverrides ?? {}, model)?.reasoningSupport
    ?? adapter?.supplement(known?.id === model ? known : { id: model }).reasoning
    ?? (known?.id === model ? known.reasoning : undefined)
  if (support === undefined) return `模型「${model}」的思考能力未知，只能使用模型默认`
  switch (setting.mode) {
    case 'off':
      if (support.disable !== true) return `模型「${model}」未声明支持关闭思考`
      break
    case 'level':
      if (!support.levels?.includes(setting.level)) {
        return `模型「${model}」不支持思考档位「${setting.level}」；可用档位：${support.levels?.join(' / ') || '未知'}`
      }
      break
    case 'budget': {
      const budget = support.budget
      if (budget === undefined || !Number.isSafeInteger(setting.budgetTokens) || setting.budgetTokens <= 0
        || (budget.minTokens !== undefined && setting.budgetTokens < budget.minTokens)
        || (budget.maxTokens !== undefined && setting.budgetTokens > budget.maxTokens)) {
        return `模型「${model}」不支持该思考预算`
      }
      break
    }
    default:
      return '思考设置 mode 无效'
  }
  if (adapter === undefined) return '这条连接没有可用的思考参数适配，只能使用模型默认'
  const mapped = adapter.reasoningOf(setting)
  if (mapped === undefined) return '该思考设置没有可用的请求参数映射'
  return 'gap' in mapped ? mapped.gap : undefined
}

/** 组合变更即切断旧思考设置继承；只改连接取该连接用户默认模型。 */
export function resolveSelection(
  providers: Readonly<Record<string, ProviderConfig>>,
  layers: readonly (ModelSwitchRequest | undefined)[],
  modelInfoOf?: (provider: string, model: string) => ModelInfo | undefined,
): ModelSwitchResult {
  let selected: ModelSwitchRequest = {}
  for (const layer of layers) {
    if (layer === undefined) continue
    for (const key of ['provider', 'model'] as const) {
      if (layer[key] !== undefined && (typeof layer[key] !== 'string' || layer[key].trim() === '')) {
        return { ok: false, reason: `${key} 须是非空字符串` }
      }
    }
    const provider = layer.provider ?? selected.provider
    const changedProvider = provider !== selected.provider
    const model = layer.model ?? (changedProvider
      ? (provider === undefined ? undefined : ownOf(providers, provider)?.model)
      : selected.model)
    const changed = changedProvider || model !== selected.model
    const targetDefault = provider === undefined || model === undefined ? undefined
      : ownOf(ownOf(providers, provider)?.modelOverrides ?? {}, model)?.reasoning
    const reasoning = layer.reasoning !== undefined ? layer.reasoning : (changed ? targetDefault : selected.reasoning)
    selected = { provider, model, reasoning }
  }
  const { provider, model, reasoning } = selected
  if (provider === undefined) return { ok: false, reason: '还没有可用的连接——先接入一个供应商' }
  const config = ownOf(providers, provider)
  if (config === undefined) return { ok: false, reason: `未知供应商「${provider}」——已注册：${Object.keys(providers).join(' / ') || '（一个都没有）'}` }
  if (config.vendor !== undefined && vendorOf(config.vendor) === undefined) {
    return { ok: false, reason: `未知供应商适配「${config.vendor}」` }
  }
  if (model === undefined || model.trim() === '') return { ok: false, reason: `连接「${provider}」还没有默认模型——请指明用哪个模型` }
  const known = modelInfoOf?.(provider, model)
  const chat = ownOf(config.modelOverrides ?? {}, model)?.capabilities?.chat ?? (known?.id === model ? known.capabilities?.chat : undefined)
  if (chat === false) return { ok: false, reason: `模型「${model}」不支持对话` }
  const failure = reasoningFailure(config, model, reasoning, known)
  if (failure !== undefined) return { ok: false, reason: failure }
  // 显式 default 必须保留，不能被配置里的精确型号覆盖重新替换。
  const selection: ModelSelection = Object.freeze({ provider, model,
    ...(reasoning === undefined ? {} : { reasoning: Object.freeze({ ...reasoning }) }) })
  return { ok: true, selection }
}
