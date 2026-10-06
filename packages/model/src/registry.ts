/** 每个 Agent 独立持有已解析的模型组合；连接网关按需构造。 */
import type { AgentModelConfig, EventStamper, KernelEvent, ModelCapabilities, ModelInfo, ModelRequest, ProviderConfig, ReasoningSetting } from '@magic/contracts'
import type { FetchLike } from './ai-sdk.ts'
import type { ModelGateway, ModelStream, ModelStreamOptions } from './call.ts'
import type { ModelMiddleware } from './middleware.ts'
import type { RetryPolicy, Sleeper } from './retry.ts'
import { createModelGateway, effectiveCapabilitiesOf, effectiveSpecOf } from './gateway.ts'
import type { EffectiveSpec } from './gateway.ts'
import { modelCallStart, modelErrorEvent } from './events.ts'
import { vendorOf } from './vendors.ts'
import type { VendorAdapter } from './vendors.ts'
import { resolveSelection } from './selection.ts'
import { ownOf } from './capacity.ts'

export type ProviderEntry = { readonly id: string }
export type ModelSelection = AgentModelConfig
/** 仅用于模型域内的实际组合，工作请求使用 contracts.ModelSwitchRequest。 */
export type ModelSwitchRequest = Partial<AgentModelConfig>
export type ModelSwitchResult = { readonly ok: true; readonly selection: ModelSelection } | { readonly ok: false; readonly reason: string }
export interface ModelRegistry extends ModelGateway {
  list(): readonly ProviderEntry[]
  capacityOf(provider: string, model: string): EffectiveSpec | undefined
  capabilityOf(provider: string, model: string): ModelCapabilities | undefined
  selection(): ModelSelection | undefined
  current(): ModelSelection | undefined
  has(id: string): boolean
  use(request: ModelSwitchRequest): ModelSwitchResult
  resolve(input: { readonly config?: ModelSwitchRequest; readonly defaults?: ModelSelection }): ModelSwitchResult
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

function withReasoning(
  streamOptions: ModelStreamOptions | undefined,
  reasoning: ReasoningSetting | undefined,
): ModelStreamOptions | undefined {
  // 调用方明说的照它——它是**知道这一跳要什么**的那一方（见上注）
  if (streamOptions?.reasoning !== undefined) return streamOptions
  if (reasoning === undefined) return streamOptions
  return { ...streamOptions, reasoning }
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

/** 域内实际组合校验；工作选择由 app 解析，不接执行输入。 */
export function selectModel(options: {
  readonly providers: Readonly<Record<string, ProviderConfig>>
  readonly selected?: ModelSelection
  readonly modelInfoOf?: ModelRegistryOptions['modelInfoOf']
}, request: ModelSwitchRequest): ModelSwitchResult {
  return resolveSelection(options.providers, [options.selected, request], options.modelInfoOf)
}

export function createModelRegistry(options: ModelRegistryOptions): ModelRegistry {
  const { providers, stamper } = options
  const entries = Object.entries(providers)

  /** 条目 → 网关（按需构造、造完即留）——同一个条目只解析一次 key。 */
  const built = new Map<string, ModelGateway>()

  /** 这条连接走哪个适配——没 `vendor` ＝**兼容接入**（没有可配置的思考参数）。 */
  const adapterFor = (id: string): VendorAdapter | undefined => {
    const config = ownOf(providers, id)
    if (config?.vendor === undefined) return undefined
    return vendorOf(config.vendor)
  }

  function gatewayFor(id: string): ModelGateway {
    const cached = built.get(id)
    if (cached !== undefined) return cached

    const config = ownOf(providers, id)
    if (config === undefined) throw new Error(`未知供应商「${id}」`)

    const gateway = createModelGateway({
      providerId: id,
      config,
      stamper,
      middleware: options.middleware,
      retry: options.retry,
      sleep: options.sleep,
      apiKey: options.apiKeys?.[id],
      fetch: options.fetch,
      env: options.env,
      configPath: options.configPath,
      maxCompletionTokens: options.maxCompletionTokens,
      // ⚠️ **按 provider 绑定再传**（U41 返修 · 补漏传）：注册表那一格是
      // `(provider, model) => ModelInfo | undefined`，而网关只认**自己那一家**的模型。
      // 不绑就直接递下去的话，网关会拿**别的条目**的 id 去查自己这一家的模型
      //（`capacityOf` 走的是对的、实际网关却拿不到规格 ⇒ 出站上限与分母各说一套）。
      ...(options.modelInfoOf === undefined
        ? {}
        : { modelInfoOf: (model: string) => options.modelInfoOf?.(id, model) }),
    })
    built.set(id, gateway)
    return gateway
  }

  let selected: ModelSelection | undefined

  return {
    list(): readonly ProviderEntry[] {
      return entries.map(([id]) => ({ id }))
    },

    capacityOf(provider: string, model: string): EffectiveSpec | undefined {
      const config = ownOf(providers, provider)
      if (config === undefined) return undefined

      return effectiveSpecOf({
        model,
        config,
        adapter: adapterFor(provider),
        known: options.modelInfoOf?.(provider, model),
        fallbackOutputTokens: options.maxCompletionTokens,
        // 同一份来路：读面与真跑那份解析必须一致
      })
    },

    capabilityOf(provider: string, model: string): ModelCapabilities | undefined {
      const config = ownOf(providers, provider)
      if (config === undefined) return undefined

      return effectiveCapabilitiesOf(model, config, options.modelInfoOf?.(provider, model))
    },

    selection(): ModelSelection | undefined {
      return selected
    },

    current(): ModelSelection | undefined {
      return selected

    },

    has(id: string): boolean {
      return ownOf(providers, id) !== undefined
    },

    resolve(input): ModelSwitchResult {
      return resolveSelection(providers, [input.defaults, input.config], options.modelInfoOf)
    },

    use(request: ModelSwitchRequest): ModelSwitchResult {
      if (Object.keys(request).length === 0) return { ok: false, reason: '请选择模型或设置思考等级' }
      const resolved = selectModel({ providers, selected, modelInfoOf: options.modelInfoOf }, request)
      if (!resolved.ok) return resolved
      // 验证与网关构造全部成功之后才提交选择；失败保留原配置。
      try {
        gatewayFor(resolved.selection.provider)
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      selected = resolved.selection
      return resolved
    },

    stream(request: ModelRequest, streamOptions?: ModelStreamOptions): ModelStream {
      const chosen = selected
      if (chosen === undefined) return errorStream(stamper, request.model, '还没有有效模型选择——请在 /model 配置 Default 或模型档位')
      const checked = resolveSelection(providers, [chosen], options.modelInfoOf)
      if (!checked.ok) return errorStream(stamper, chosen.model, checked.reason)
      const stream = gatewayFor(chosen.provider).stream({ ...request, model: chosen.model }, withReasoning(streamOptions, chosen.reasoning))
      return { ...stream, events: (async function* () {
        for await (const event of stream.events) yield event.kind === 'model.call.start'
          ? { ...event, data: { ...event.data, alias: chosen.alias } } : event
      })() }
    },
  }
}
