/**
 * 接缝装配 —— 配置 + 取件层 + 归一 + 中间件位（工作分解 · U03；技术方案 · 模型策略）。
 *
 * 数据流（单向，供应商细节不回流）：
 *
 *   ModelRequest ─〔中间件 · transformRequest〕→ 取件层（AI SDK · OpenAI 兼容）
 *     → 供应商 chunk ─〔normalize〕→ ModelEvent（内核自家事件）
 *     ─〔中间件 · transformEvents〕→ 循环 / 控制面
 *
 * 密钥纪律（配置契约）：key 只在**本层向下**流动——解析一次、交给取件层，
 * 并作为脱敏种子交给归一（错误消息里若混进 key，先被换掉）。key **不进事件、不进结果**。
 *
 * 配置加载（读 `~/.magic/config.json`、展开 `~/.magic`）**不在这里**——那是 U11 的活；
 * 本层只吃已解析好的 `ProviderConfig`（本目录不碰文件系统）。
 */

import type { ProviderConfig } from '../contracts/index.ts'
import { apiKeyEnvVarOf } from '../contracts/index.ts'
import type { ModelRequest, ModelSeam, ModelStream, ModelStreamOptions } from './call.ts'
import { createVendorStreamer } from './ai-sdk.ts'
import type { FetchLike } from './ai-sdk.ts'
import { applyEventMiddleware, applyRequestMiddleware } from './middleware.ts'
import type { ModelCallContext, ModelMiddleware } from './middleware.ts'
import { toKernelEvents } from './normalize.ts'

// —— 缺 key ——

/**
 * 缺 key——**构造期**失败（不是 `model.error`：还没到模型那一步）。
 * 消息只报「去哪儿配 / 配哪个环境变量」，**永不包含 key 本身**。
 */
export class MissingApiKeyError extends Error {
  readonly providerId: string
  readonly envVar: string

  constructor(providerId: string, envVar: string) {
    super(
      `供应商「${providerId}」缺 apiKey——请写入 ~/.magic/config.json 的 ` +
        `providers.${providerId}.apiKey，或设环境变量 ${envVar}`,
    )
    this.name = 'MissingApiKeyError'
    this.providerId = providerId
    this.envVar = envVar
  }
}

/**
 * key 解析——次序：显式注入（测试用）→ 配置 `apiKey` → 环境变量回退。
 * 「apiKey 空 / 缺省 → 回退环境变量」是配置契约的明文（`apiKeyEnvVarOf` 给名字）。
 */
export function resolveApiKey(input: {
  readonly providerId: string
  readonly config: ProviderConfig
  readonly explicit?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}): string {
  const explicit = input.explicit?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit

  const fromConfig = input.config.apiKey?.trim()
  if (fromConfig !== undefined && fromConfig.length > 0) return fromConfig

  const envVar = apiKeyEnvVarOf(input.providerId)
  const fromEnv = input.env?.[envVar]?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv

  throw new MissingApiKeyError(input.providerId, envVar)
}

// —— 装配 ——

export type ModelSeamOptions = {
  /** 供应商 id——`providers.<id>` 的键（也是环境变量回退名的来源）。 */
  readonly providerId: string
  /** 已解析的供应商条目（配置契约 `ProviderConfig`）。 */
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
}

/**
 * 造一个模型接缝——内核通往供应商的唯一界面。
 *
 * 缺 key 在**此处**抛 `MissingApiKeyError`（启动期就能报，不留到第一次调用）。
 */
export function createModelSeam(options: ModelSeamOptions): ModelSeam {
  const { providerId, config } = options
  const apiKey = resolveApiKey({
    providerId,
    config,
    explicit: options.apiKey,
    env: options.env ?? process.env,
  })

  const streamVendor = createVendorStreamer({
    providerId,
    config,
    apiKey,
    fetch: options.fetch,
    maxCompletionTokens: options.maxCompletionTokens,
  })
  const middleware = options.middleware ?? []

  return {
    stream(request: ModelRequest, streamOptions?: ModelStreamOptions): ModelStream {
      // 上下文取「中间件链之前」的原始请求——改写是对账对象，不是判据基线
      const context: ModelCallContext = { provider: providerId, model: config.model, request }
      const effective = applyRequestMiddleware(middleware, request, context)

      const { events, result } = toKernelEvents(streamVendor(effective, streamOptions), {
        model: config.model,
        secret: apiKey,
      })

      return { events: applyEventMiddleware(middleware, events, context), result }
    },
  }
}
