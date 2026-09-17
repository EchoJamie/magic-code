/**
 * 取件层 —— AI SDK 的装配（技术方案 · 模型策略 · 取件 ＋ 接缝自留）。
 *
 * 这一层是**接缝的里侧**：SDK 与供应商细节到此为止。
 * - 走 AI SDK 的 **OpenAI 兼容通道**（`@ai-sdk/openai-compatible`）接首接供应商 MiniMax；
 * - 已知差异**封在这里**（底下 `requestBody` 的参数改写——取件层常量，不入配置形制）；
 * - 关掉 SDK 的自动重试——分档与回退归内核（技术方案：回退逻辑放内核、不依赖 SDK 自动机制）。
 *
 * 本文件不 import `node:fs`（内核 fs 纪律），**也拿不到记录的写入口**——
 * 它只知道 `ProviderConfig`（形制见共享语言 · 配置形制），于是 key 到不了记录 / 事件。
 */

import { jsonSchema, streamText, tool } from 'ai'
import type { JSONSchema7, ModelMessage as AiSdkMessage, ToolSet } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ModelMessage, ModelRequest, ToolSpec } from '@magic/contracts'
import type { ProviderConfig } from '@magic/contracts'
import type { ModelStreamOptions } from './call.ts'
import type { VendorStreamPart } from './normalize.ts'

// —— 首接供应商：MiniMax（配置模板定稿 2026-09-16；`~/.magic/config.json` 已有条目）——

/** 供应商 id——须与配置 `providers` 的键一致。 */
export const MINIMAX_PROVIDER_ID = 'minimax'

/** OpenAI 兼容端点。 */
export const MINIMAX_BASE_URL = 'https://api.minimaxi.com/v1'

/** 首接模型。 */
export const MINIMAX_MODEL = 'MiniMax-M3'

// —— 取件层常量（技术方案：供应商差异封接缝——「参数」暂不入首站形制）——

/**
 * 输出上限（取件层常量——「参数」暂不入配置形制，需要时按生长加键）。
 * 由 SDK 的 `maxOutputTokens` 落到 `max_tokens`，再经下方改写成为 `max_completion_tokens`。
 */
export const MAX_COMPLETION_TOKENS = 4096

/**
 * MiniMax 的已知差异：`max_tokens` 已弃用，改用 `max_completion_tokens`。
 * 挂 `transformRequestBody`（取件层官方挂点）而非 `providerOptions`——
 * 后者要按 provider id 拼键，而 id 是用户自由命名的（`providers.<id>`）；这里改的是**参数名**，与 id 无关。
 */
export function requestBody(args: Record<string, unknown>): Record<string, unknown> {
  const { max_tokens: maxTokens, ...rest } = args
  if (maxTokens === undefined) return rest
  return { ...rest, max_completion_tokens: maxTokens }
}

// —— 请求形态转换（内核侧 → 取件层）——

/**
 * 系统消息 → `instructions`。
 *
 * 取件层（AI SDK v7）**不接受** `messages` 里的 system 角色
 * （会报 `Invalid prompt: System messages are not allowed…`，要 `instructions`）。
 * 这条差异与供应商无关，是 SDK 的形制——正该封在这一层：内核侧照旧把系统提示
 * 当会话的第一条消息（U04 / U10 的上下文装配因此不必知道取件层怎么送）。
 * 多条系统消息按序拼接——顺序即语义（段结构 v0 的顺序不能乱）。
 */
function toInstructions(messages: readonly ModelMessage[]): string | undefined {
  const systems = messages.filter((message) => message.role === 'system')
  if (systems.length === 0) return undefined
  return systems.map((message) => message.content).join('\n\n')
}

function toAiSdkMessages(messages: readonly ModelMessage[]): AiSdkMessage[] {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message): AiSdkMessage => {
      switch (message.role) {
        case 'user':
          return { role: 'user', content: message.content }
        case 'assistant': {
          const calls = message.toolCalls ?? []
          if (calls.length === 0) return { role: 'assistant', content: message.content }
          return {
            role: 'assistant',
            content: [
              ...(message.content.length > 0
                ? [{ type: 'text' as const, text: message.content }]
                : []),
              ...calls.map((call) => ({
                type: 'tool-call' as const,
                toolCallId: call.id,
                toolName: call.name,
                input: call.args,
              })),
            ],
          }
        }
        case 'tool':
          return {
            role: 'tool',
            content: [
              {
                type: 'tool-result' as const,
                toolCallId: message.callId,
                // 工具名由契约的 `tool` 支直接给（M01-3 补锚）——不再从上下文反查
                toolName: message.name,
                output:
                  message.ok
                    ? { type: 'text' as const, value: message.output }
                    : { type: 'error-text' as const, value: message.output },
              },
            ],
          }
      }
    })
}

/** 工具定义——**不带执行体**：模型只出请求，执行归内核工具机制 + 权限闸门。 */
function toAiSdkTools(specs: readonly ToolSpec[] | undefined): ToolSet | undefined {
  if (specs === undefined || specs.length === 0) return undefined
  const tools: ToolSet = {}
  for (const spec of specs) {
    tools[spec.name] = tool({
      // 共享语言 `ToolSpec` 的 `summary` 即工具描述（危险归类不上线——那是闸门的事）
      description: spec.summary,
      inputSchema: jsonSchema(spec.parameters as JSONSchema7),
    })
  }
  return tools
}

// —— 装配 ——

/**
 * 注入用 fetch（测试：假端点回放 SSE，不经网络）。
 * 取 `globalThis.fetch` 的入参类型——共享语言保持无依赖，也不引 DOM lib 之名。
 */
export type FetchLike = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => Promise<Response>

export type VendorStreamerOptions = {
  readonly providerId: string
  readonly config: ProviderConfig
  readonly apiKey: string
  readonly fetch?: FetchLike | undefined
  readonly maxCompletionTokens?: number
}

/**
 * 取件层流——内核请求进，取件层 chunk 出。
 * 产出的 `VendorStreamPart` **只在接缝内部流通**（`normalize.ts` 的输入）。
 *
 * 模型名取自**请求**（`request.model`）——契约 `ModelRequest` 载之；
 * 配置条目的 `model` 是「这个供应商默认用哪个」，请求可覆盖（运行时切换的落点，U17）。
 */
export type VendorStreamer = (
  request: ModelRequest,
  options?: ModelStreamOptions,
) => AsyncIterable<VendorStreamPart>

export function createVendorStreamer(options: VendorStreamerOptions): VendorStreamer {
  const provider = createOpenAICompatible({
    name: options.providerId,
    baseURL: options.config.baseURL,
    apiKey: options.apiKey,
    // 流式用量——不置此则供应商不回 usage，`model.usage` 事件无从产生
    includeUsage: true,
    // 供应商差异（取件层常量）
    transformRequestBody: requestBody,
    ...(options.fetch === undefined
      ? {}
      : { fetch: options.fetch as unknown as typeof globalThis.fetch }),
  })

  const maxOutputTokens = options.maxCompletionTokens ?? MAX_COMPLETION_TOKENS

  return (request, streamOptions) => {
    const model = provider.chatModel(request.model)
    const instructions = toInstructions(request.messages)
    const result = streamText({
      model,
      ...(instructions === undefined ? {} : { instructions }),
      messages: toAiSdkMessages(request.messages),
      ...(request.tools === undefined || request.tools.length === 0
        ? {}
        : { tools: toAiSdkTools(request.tools) }),
      maxOutputTokens,
      // 回退逻辑放内核——不依赖 SDK 自动机制（技术方案 · 模型策略）
      maxRetries: 0,
      // 错误经事件流上报（`model.error`），不另走控制台
      onError: () => undefined,
      ...(streamOptions?.signal === undefined ? {} : { abortSignal: streamOptions.signal }),
    })

    return result.fullStream as AsyncIterable<VendorStreamPart>
  }
}
