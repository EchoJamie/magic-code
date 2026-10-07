/** 每个 Agent 独立持有已解析的模型组合；连接网关按需构造。 */
import type { AgentModelConfig, EventStamper, KernelEvent, ModelCapabilities, ModelInfo, ModelRequest, ProviderConfig } from '@magic/contracts'
import type { FetchLike } from './ai-sdk.ts'
import type { ModelGateway, ModelStream, ModelStreamOptions } from './call.ts'
import type { ModelMiddleware } from './middleware.ts'
import type { RetryPolicy, Sleeper } from './retry.ts'
import { createModelGateway, effectiveCapabilitiesOf, effectiveSpecOf } from './gateway.ts'
import type { EffectiveSpec } from './gateway.ts'
import { modelCallStart, modelErrorEvent } from './events.ts'
import { vendorOf } from './vendors.ts'
import type { VendorAdapter } from './vendors.ts'
import { selectModel } from './selection.ts'
import { ownOf } from './capacity.ts'

export type ProviderEntry = { readonly id: string }
export type ModelSelection = AgentModelConfig
export type ModelSwitchResult = { readonly ok: true; readonly selection: ModelSelection } | { readonly ok: false; readonly reason: string }
export interface ModelRegistry extends ModelGateway {
  list(): readonly ProviderEntry[]
  capacityOf(provider: string, model: string): EffectiveSpec | undefined
  capabilityOf(provider: string, model: string): ModelCapabilities | undefined
  current(): ModelSelection | undefined
  has(id: string): boolean
  use(selection: ModelSelection): ModelSwitchResult
}

function errorStream(stamper: EventStamper, model: string, message: string): ModelStream {
  const detail = { tier: 'terminal' as const, message }
  const events = (async function* (): AsyncGenerator<KernelEvent> {
    yield modelCallStart(stamper, model)
    // 「哪个模型」照样报（U84）——这一条是「没走到任何一条连接」，故**没有 `provider` 那一位**：
    // 缺它就是「一条都没选中」这件事本身，不是没记
    yield modelErrorEvent(stamper, detail.tier, detail.message, { model })
  })()

  return {
    events,
    result: Promise.resolve({
      model,
      text: '',
      thinking: '',
      toolCalls: [],
      usage: undefined,
      finishReason: undefined,
      error: detail,
      aborted: false,
      complete: true,
    }),

  }
}

export type ModelRegistryOptions = {
  /** 配置里的 `providers` 原样（形制见共享语言 · 配置形制）。 */
  readonly providers: Readonly<Record<string, ProviderConfig>>
  /** 信封铸造器——**按会话实例构造**，各条目的网关共用同一个（见 `createModelGateway`）。 */
  readonly stamper: EventStamper
  /** 中间件链——逐条目的网关共用（横切逻辑与「走哪家」无关）。 */
  readonly middleware?: readonly ModelMiddleware[] | undefined
  /** 瞬时档退避重试的策略——缺省 `DEFAULT_RETRY_POLICY`（见 `retry.ts`）。 */
  readonly retry?: RetryPolicy | undefined
  /** 退避等待的实现——注入用（测试不真等）；缺省真等。 */
  readonly sleep?: Sleeper | undefined
  /** 显式 key（测试用）——按条目给；优先于配置与环境变量。 */
  readonly apiKeys?: Readonly<Record<string, string | undefined>> | undefined
  /** 注入用 fetch（测试：假端点回放 SSE，不经网络）。 */
  readonly fetch?: FetchLike | undefined
  /** 环境变量来源——缺省 `process.env`。 */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /**
   * **实际读的那一份配置文件**（U42）——只往下递给缺 key 那句提示用
   * （见 `MissingApiKeyError`：配置文件落点随 `MAGIC_HOME` 走，不能写死一处）。
   */
  readonly configPath?: string | undefined
  /** 输出上限覆盖（取件层常量，见 `ai-sdk.ts`）。 */
  readonly maxCompletionTokens?: number | undefined
  /**
   * **某连接某模型已知的资料**（来自模型信息缓存）——装配给（它才够得着那份缓存）。
   *
   * 有效规格的一处来路（优先级：用户覆盖 → **供应商 API 当前有效信息** → 缺项补充 → 未知）。
   * 缺省＝没有缓存可看，规格只由配置与适配补齐（与加它之前一字不差）。
   */
  readonly modelInfoOf?:
    | ((provider: string, model: string) => ModelInfo | undefined)
    | undefined
}

export function createModelRegistry(options: ModelRegistryOptions): ModelRegistry {
  const { providers, stamper } = options
  let active: { readonly selection: ModelSelection; readonly gateway: ModelGateway } | undefined
  const adapterFor = (id: string): VendorAdapter | undefined => {
    const vendor = ownOf(providers, id)?.vendor
    return vendor === undefined ? undefined : vendorOf(vendor)
  }

  return {
    list: () => Object.keys(providers).map(id => ({ id })),
    current: () => active?.selection,
    has: id => ownOf(providers, id) !== undefined,

    capacityOf(provider, model): EffectiveSpec | undefined {
      const config = ownOf(providers, provider)
      return config === undefined ? undefined : effectiveSpecOf({
        model, config, adapter: adapterFor(provider), known: options.modelInfoOf?.(provider, model),
        fallbackOutputTokens: options.maxCompletionTokens,
      })
    },

    capabilityOf(provider, model): ModelCapabilities | undefined {
      const config = ownOf(providers, provider)
      return config === undefined ? undefined : effectiveCapabilitiesOf(model, config, options.modelInfoOf?.(provider, model))
    },

    use(selection): ModelSwitchResult {
      const checked = selectModel(options, selection)
      if (!checked.ok) return checked
      const chosen = checked.selection
      try {
        const gateway = createModelGateway({
          ...options, providerId: chosen.provider, model: chosen.model, reasoning: chosen.reasoning,
          config: providers[chosen.provider]!, apiKey: options.apiKeys?.[chosen.provider],
          modelInfoOf: model => options.modelInfoOf?.(chosen.provider, model),
        })
        // 凭据、能力和网关构造全部成功才提交；一份状态同时持有目标和调用端口。
        active = { selection: chosen, gateway }
        return checked
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },

    stream(request: ModelRequest, streamOptions?: ModelStreamOptions): ModelStream {
      const current = active
      if (current === undefined) return errorStream(stamper, '', '还没有有效模型选择——请在 /model 配置 Default 或模型档位')
      const stream = current.gateway.stream(request, streamOptions)
      return { ...stream, events: (async function* () {
        for await (const event of stream.events) yield event.kind === 'model.call.start'
          ? { ...event, data: { ...event.data, choice: current.selection.choice } } : event
      })() }
    },
  }
}
