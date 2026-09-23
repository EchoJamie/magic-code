/**
 * 网关装配 —— 配置 + 取件层 + 归一 + 中间件位（技术方案 · 模型策略 · 接缝自留）。
 *
 * 数据流（单向，供应商细节不回流）：
 *
 *   ModelRequest ─〔中间件 · transformRequest〕→ 取件层（AI SDK · OpenAI 兼容）
 *     → 供应商 chunk ─〔normalize〕→ KernelEvent（内核自家事件）
 *     ─〔中间件 · transformEvents〕→ 循环 / 控制面
 *
 * 密钥纪律（共享语言 · 配置形制）：key 只在**本层向下**流动——解析一次、交给取件层，
 * 并作为脱敏种子交给归一（错误消息里若混进 key，先被换掉）。key **不进事件、不进结果**。
 *
 * 配置加载（读 `~/.magic/config.json`、展开 `~/.magic`）**不在这里**——那是 U11 的活；
 * 本层只吃已解析好的 `ProviderConfig`（本域不碰文件系统）。
 *
 * 本文件造的是**单条目**的网关；「多条目的注册表 ＋ 运行时切换」在 `registry.ts`
 * （它按条目调用这里，故 key 解析、特征标记、退避重试的裁定各只有一份）。
 */

import type {
  EventStamper,
  ModelLimits,
  ModelRequest,
  ModelTraits,
  ProviderConfig,
  ProviderModelOverride,
} from '@magic/contracts'
import { apiKeyEnvVarOf } from '@magic/contracts'
import type { ModelCallContext, ModelMiddleware } from './middleware.ts'
import type { ModelGateway, ModelStream, ModelStreamOptions } from './call.ts'
import { MAX_COMPLETION_TOKENS, createVendorStreamer } from './ai-sdk.ts'
import type { FetchLike } from './ai-sdk.ts'
import { applyEventMiddleware, applyRequestMiddleware } from './middleware.ts'
import { toKernelEvents } from './normalize.ts'
import type { RetryPolicy, Sleeper } from './retry.ts'
import { withTransientRetry } from './retry.ts'
import { resolveModelTraits } from './traits.ts'
import { ownOf, resolveContextWindow } from './capacity.ts'
import { vendorIds, vendorOf } from './vendors.ts'
import type { VendorAdapter } from './vendors.ts'

// —— 缺 key ——

/**
 * 缺 key——**构造期**失败（不是 `model.error`：还没到模型那一步）。
 * 消息只报「去哪儿配 / 配哪个环境变量」，**永不包含 key 本身**。
 */
export class MissingApiKeyError extends Error {
  readonly providerId: string
  readonly envVar: string

  /**
   * `configPath`——**实际读的那一份配置文件**（U42）。给得出就说它，给不出只报「配置文件」。
   *
   * 由头：配置文件的落点随 `MAGIC_HOME` 走（`<基础目录>/config.json`），写死一句
   * 「`~/.magic/config.json`」在 `MAGIC_HOME` 指到别处时是**指错地方**——用户照着那串
   * 去找，找到的是另一份（或什么都没有）。谁读的配置谁知道路径，故由调用方递进来。
   */
  constructor(providerId: string, envVar: string, configPath?: string | undefined) {
    // `where` 的分支里带着前置空格：中文里「请在 A 的 x 里填」要那一格，
    // 而没有路径时「请在配置文件的 x 里填」不兴中间加空格
    const where = configPath === undefined ? '配置文件的' : ` ${configPath} 的`

    super(
      `供应商「${providerId}」缺 apiKey——请在${where} ` +
        `providers.${providerId}.apiKey 里填，或设环境变量 ${envVar}`,
    )
    this.name = 'MissingApiKeyError'
    this.providerId = providerId
    this.envVar = envVar
  }
}

/**
 * key 解析——次序：显式注入（测试用）→ 配置 `apiKey` → 环境变量回退。
 * 「apiKey 空 / 缺省 → 回退环境变量」是配置形制的明文（`apiKeyEnvVarOf` 给名字）。
 */
export function resolveApiKey(input: {
  readonly providerId: string
  readonly config: ProviderConfig
  readonly explicit?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** 实际读的那一份配置文件——只用于**缺 key 那句提示**（见 `MissingApiKeyError`）。 */
  readonly configPath?: string | undefined
}): string {
  const explicit = input.explicit?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit

  const fromConfig = input.config.apiKey?.trim()
  if (fromConfig !== undefined && fromConfig.length > 0) return fromConfig

  const envVar = apiKeyEnvVarOf(input.providerId)
  const fromEnv = input.env?.[envVar]?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv

  throw new MissingApiKeyError(input.providerId, envVar, input.configPath)
}

// —— 生效的规格与特征（用户覆盖 → 该家适配的缺项补充 → 未知）——

/**
 * 该模型的**用户明确覆盖**——两处合成一处：
 *
 * - **新形态** `modelOverrides[<精确模型 id>]`（按精确 id 查，最高优先级）；
 * - **旧形态** `traits` / `contextWindow` 两个平铺键——**只在它就是这条连接
 *   `model` 那一个时**算数（设计：旧的声明属于「这一条 ＋ 它的模型」两件；
 *   同条目换到别的模型时不跟过去）；
 * - 其余一切 → `undefined`（**不知道就是不知道**，不按型号名猜）。
 */
function overrideOf(config: ProviderConfig, model: string): ProviderModelOverride | undefined {
  const explicit =
    config.modelOverrides === undefined ? undefined : ownOf(config.modelOverrides, model)
  if (explicit !== undefined) return explicit

  if (config.model !== model) return undefined

  const legacy: ProviderModelOverride = {
    ...(config.traits === undefined ? {} : { traits: config.traits }),
    ...(config.contextWindow === undefined
      ? {}
      : { limits: { maxContextTokens: config.contextWindow } }),
  }
  return Object.keys(legacy).length === 0 ? undefined : legacy
}

/** **生效的通道特征**——用户覆盖 → 该家适配的缺项补充 → 无（正文原样走，不猜不切）。 */
function traitsOf(
  model: string,
  config: ProviderConfig,
  adapter: VendorAdapter | undefined,
): ModelTraits | undefined {
  const override = overrideOf(config, model)?.traits
  if (override !== undefined) return override

  // **官方适配**按该家的补充来；**兼容接入**（无适配）走域内的已知差异表——
  // 那条路的能力一个字不删（设计 · 命令行与配置：「不借此删除旧能力」）
  return adapter === undefined
    ? resolveModelTraits(model, undefined)
    : adapter.supplement({ id: model }).traits
}

/**
 * **生效的令牌规格**——用户覆盖 → 该家适配的缺项补充（逐位合并，覆盖优先）。
 *
 * 两处都缺的位就是**未知**（不给这一位）：设计明文「零 / 非法规格不当作无限大」，
 * 「读不懂就不给这一位」。兼容接入走域内的内置容量表（旧能力不删，见 `traitsOf` 同一条）。
 */
function effectiveLimits(
  model: string,
  config: ProviderConfig,
  adapter: VendorAdapter | undefined,
): ModelLimits | undefined {
  const override = overrideOf(config, model)?.limits
  const supplemented =
    adapter === undefined
      ? ((): ModelLimits | undefined => {
          const window = resolveContextWindow(model)
          return window === undefined ? undefined : { maxContextTokens: window }
        })()
      : adapter.supplement({ id: model }).limits

  const merged: ModelLimits = { ...supplemented, ...override }
  return Object.keys(merged).length === 0 ? undefined : merged
}

/**
 * **这一次的有效输入预算**（token）——`model.usage.contextWindow` 报的就是它。
 *
 * 判据（设计 · 模型与上下文「规格与参数」）：
 * - **合用窗口要预留输出**——「联合窗口须为本次输出（含其规则要求计入的思考预算）
 *   预留空间」。故 `maxContextTokens` 减去**已知的输出上限**（用户覆盖或适配补充的那一个；
 *   两处都没有就不减——取件层常量是**我们请求时带的数**，不是模型规格，混进容量就成了编）；
 * - **独立输入上限不机械减去输出上限**——它本来就是「输入那一边」的上限，直接用。
 *
 * 两处皆无 ⇒ **不给这一位**（外壳显示不出分母就不显示）。
 */
function contextWindowOf(
  model: string,
  config: ProviderConfig,
  adapter: VendorAdapter | undefined,
): number | undefined {
  const limits = effectiveLimits(model, config, adapter)

  if (limits?.maxContextTokens !== undefined) {
    return Math.max(0, limits.maxContextTokens - (limits.maxOutputTokens ?? 0))
  }
  return limits?.maxInputTokens
}

/**
 * **这一次的输出上限**——用户对该精确模型的覆盖 → 取件层常量（见 `ai-sdk.ts`）。
 *
 * 它同时是**出站请求带的那一个**与**上面输入预算里预留的那一个**：两处同源
 * （设计：「输入上限、预留输出与所显示分母须同口径」）。
 */
function maxOutputTokensOf(
  model: string,
  config: ProviderConfig,
  fallback: number | undefined,
): number {
  return overrideOf(config, model)?.limits?.maxOutputTokens ?? fallback ?? MAX_COMPLETION_TOKENS
}

// —— 装配 ——

export type ModelGatewayOptions = {
  /** 供应商 id——`providers.<id>` 的键（也是环境变量回退名的来源）。 */
  readonly providerId: string
  /** 已解析的供应商条目（共享语言 `ProviderConfig`——含 `traits` 覆盖位）。 */
  readonly config: ProviderConfig
  /** 中间件链（数组由外到内）——阶段 1 只留位，缺省为空。 */
  readonly middleware?: readonly ModelMiddleware[] | undefined
  /** 显式 key（测试用）——优先于配置与环境变量。 */
  readonly apiKey?: string | undefined
  /** 注入用 fetch（测试：假端点回放 SSE，不经网络）。 */
  readonly fetch?: FetchLike | undefined
  /** 环境变量来源——缺省 `process.env`；显式传入便于测试。 */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** 输出上限覆盖（取件层常量，见 `ai-sdk.ts`）。 */
  readonly maxCompletionTokens?: number | undefined
  /** 实际读的那一份配置文件——只用于缺 key 那句提示（见 `MissingApiKeyError`）。 */
  readonly configPath?: string | undefined
  /**
   * **瞬时档退避重试**的策略（技术方案 · 模型策略 · 错误分档——「回退逻辑放内核」）。
   * 缺省 `DEFAULT_RETRY_POLICY`；`maxAttempts: 1` ＝ 不重试。策略与判据见 `retry.ts`。
   */
  readonly retry?: RetryPolicy | undefined
  /** 退避等待的实现——注入用（测试不真等）；缺省真等。 */
  readonly sleep?: Sleeper | undefined
  /**
   * 信封铸造器（技术方案 · 领域划分 · 信封的归属 v0 锚定）——**产出方铸**。
   *
   * 由**装配按会话实例**构造并注入：`id` 取自记录域（`RecordsService.nextId()`）、
   * `session` 由装配设定、`turn` 由对话域在轮起止时经 `beginTurn` 调、`at` 由铸造器盖。
   *
   * ⚠️ **必填，本域无缺省**——模型域不自造计数、不自取时钟（缺省只留给测试的桩）。
   */
  readonly stamper: EventStamper
}

/**
 * 造一个模型网关——内核通往供应商的唯一界面（契约端口 `ModelGateway` 的落地）。
 *
 * 缺 key 在**此处**抛 `MissingApiKeyError`（启动期就能报，不留到第一次调用）。
 *
 * **模型名取自请求**（`req.model`）：配置条目的 `model` 是该供应商的默认，
 * 请求可覆盖——运行时切换（U17）的落点。特征标记也随之按请求的模型名裁定。
 */
export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  const { providerId, config } = options
  const apiKey = resolveApiKey({
    providerId,
    config,
    explicit: options.apiKey,
    env: options.env ?? process.env,
    configPath: options.configPath,
  })

  // **供应商适配**（U41）——有 `vendor` 却认不出＝**报错**：不悄悄当成兼容接入
  // （那会拿官方域名去走旧协议），也不换一个「看上去像」的适配
  const adapter = config.vendor === undefined ? undefined : vendorOf(config.vendor)
  if (config.vendor !== undefined && adapter === undefined) {
    const known = vendorIds().join(' / ')
    throw new Error(
      `连接「${providerId}」写的是不认识的供应商「${config.vendor}」——已内置：${known}`,
    )
  }

  // **地址**：官方适配按区域给（`baseURL` 明确写了就用它）；兼容接入用配置里那个。
  // 两个都没有＝这条连接不知道该往哪儿发——启动期就报（不留到第一次调用）
  const baseURL = adapter === undefined ? config.baseURL : adapter.baseURLOf(config)
  if (baseURL === undefined) {
    throw new Error(
      adapter === undefined
        ? `连接「${providerId}」没有服务地址——请写 baseURL（或改用内置供应商）`
        : `连接「${providerId}」的供应商「${adapter.id}」没有区域「${config.region ?? ''}」的地址`,
    )
  }

  const streamVendor = createVendorStreamer({
    providerId,
    baseURL,
    apiKey,
    adapter,
    fetch: options.fetch,
    // 输出上限**按请求的那个模型算**（用户覆盖 → 常量）——不是构造期钉死一个数
    maxOutputTokensOf: (model) => maxOutputTokensOf(model, config, options.maxCompletionTokens),
  })
  const middleware = options.middleware ?? []

  // 瞬时档的退避重试（技术方案 · 错误分档）——在**归一之下**：内核只看得见最终那一次尝试，
  // 好消息是重试的痕迹有两条出口：结果上的 `attempts`（可断）与 `model.retry` 事件（可看）
  let attempts = 0
  const streamRetrying = withTransientRetry(streamVendor, {
    policy: options.retry,
    sleep: options.sleep,
    onAttempt: (attempt) => {
      attempts = attempt
    },
    // 退避期间**屏上要有话说**（原先这里静默，用户只看见界面一动不动）——
    // 那块 `retry` 信号骑马过流，由归一铸成 `model.retry`（见 `retry.ts` 的那一处 yield）
  })

  // 返回类型即 `ModelGateway`——`extends ModelGatewayPort` 处已由 tsc 钉住结构兼容（见 `call.ts`）
  return {
    stream(request: ModelRequest, streamOptions?: ModelStreamOptions): ModelStream {
      // 上下文取「中间件链之前」的原始请求——改写是对账对象，不是判据基线
      const context: ModelCallContext = { provider: providerId, model: request.model, request }
      const effective = applyRequestMiddleware(middleware, request, context)

      const { events, result } = toKernelEvents(streamRetrying(effective, streamOptions), {
        model: effective.model,
        // 条目名随事件上报——外壳状态行据以显示「当前供应商」（本条即当前这一格）
        provider: providerId,
        // 窗长随**用量**上报（分母跟着分子走）——见 `contextWindowOf`
        contextWindow: contextWindowOf(effective.model, config, adapter),
        secret: apiKey,
        // 生效标记——见 `traitsOf`（用户覆盖 → 该家适配的缺项补充）
        traits: traitsOf(effective.model, config, adapter),
        stamper: options.stamper,
      })

      return {
        events: applyEventMiddleware(middleware, events, context),
        // 计数在结果落定那一刻已定（重试循环早已退出）——`attempts` 如实记「成功那次是第几次」
        result: result.then((settled) => ({ ...settled, attempts })),
      }
    },
  }
}
