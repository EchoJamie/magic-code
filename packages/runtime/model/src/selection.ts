import type { ModelInfo, ProviderConfig, ReasoningSetting, ReasoningSupport } from '@magic/contracts'
import { ownOf } from './capacity.ts'
import { vendorOf, resolveModelSource, reasoningParams } from './vendors.ts'
import type { ModelSelection, ModelSwitchResult } from './registry.ts'

/** 能力覆盖与供应商信息的唯一可编辑读面，实际参数映射决定能否开放。 */
export function effectiveReasoningSupportOf(config: ProviderConfig, model: string, known?: ModelInfo): ReasoningSupport | undefined {
  let protocol: import('@magic/contracts').ModelProtocol
  try { protocol = resolveModelSource(config, model).protocol } catch { return undefined }
  const adapter = config.vendor === undefined ? undefined : vendorOf(config.vendor)
  const support = ownOf(config.modelOverrides ?? {}, model)?.reasoningSupport
    ?? (known?.id === model ? known.reasoning : undefined)
  if (support === undefined) return undefined
  const canMap = (setting: ReasoningSetting) => {
    const mapped = reasoningParams(adapter, setting, model, protocol)
    return mapped !== undefined && 'params' in mapped
  }
  const budget = support.budget !== undefined && canMap({ mode: 'budget', budgetTokens: support.budget.minTokens ?? 1024 }) ? support.budget : undefined
  return {
    ...(support.default === undefined ? {} : { default: support.default }),
    ...(support.disable === false ? { disable: false } : support.disable === true && canMap({ mode: 'off' }) ? { disable: true } : {}),
    ...(support.levels === undefined ? {} : { levels: support.levels.filter(level => canMap({ mode: 'level', level })) }),
    ...(budget === undefined ? {} : { budget }),
  }
}

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
  const support = effectiveReasoningSupportOf(config, model, known)
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
  const mapped = reasoningParams(adapter, setting, model, resolveModelSource(config, model).protocol)
  if (mapped === undefined) return '该思考设置没有可用的请求参数映射'
  return 'gap' in mapped ? mapped.gap : undefined
}

/**
 * 校验完整的运行选择；档位解析与继承只在宿主入口完成。
 *
 * `selected.protocol` / `selected.endpoint` 是**历史记录里的诊断元数据**（D63）：不参与解析、
 * 不与当前连接比对。来源一律按**当前配置**重新解析——换了协议、地址或支持提示之后，
 * 下一次请求照当前配置组装，不要求重新选择模型。进行中的请求由调用方在启动时固定来源。
 */
export function selectModel(options: {
  readonly providers: Readonly<Record<string, ProviderConfig>>
  readonly modelInfoOf?: (provider: string, model: string) => ModelInfo | undefined
}, selected: Omit<ModelSelection, 'protocol' | 'endpoint'> & Partial<import('@magic/contracts').ModelSource>): ModelSwitchResult {
  const { providers, modelInfoOf } = options
  const { provider, model, reasoning, choice } = selected
  if (typeof provider !== 'string' || provider.trim() === '') return { ok: false, reason: 'provider 须是非空字符串' }
  if (typeof model !== 'string' || model.trim() === '') return { ok: false, reason: 'model 须是非空字符串' }
  if (!['cantrip', 'spell', 'arcane'].includes(choice)) return { ok: false, reason: '未知模型档位；只能选择 cantrip / spell / arcane' }
  const config = ownOf(providers, provider)
  if (config === undefined) return { ok: false, reason: `未知供应商「${provider}」——已注册：${Object.keys(providers).join(' / ') || '（一个都没有）'}` }
  if (config.vendor !== undefined && vendorOf(config.vendor) === undefined) return { ok: false, reason: `未知供应商适配「${config.vendor}」` }
  let source: import('@magic/contracts').ModelSource
  try { source = resolveModelSource(config, model) } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) } }
  const known = modelInfoOf?.(provider, model)
  // 对话能力不是硬闸门（D65／协议闭环）：选择照旧成立，能力留给真实请求时解析。
  const failure = reasoningFailure(config, model, reasoning, known)
  if (failure !== undefined) return { ok: false, reason: failure }
  const selection: ModelSelection = Object.freeze({ choice, provider, model, ...source,
    ...(reasoning === undefined ? {} : { reasoning: Object.freeze({ ...reasoning }) }) })
  return { ok: true, selection }
}
