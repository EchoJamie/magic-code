/** SDK 协议接缝：模型域持有历史、认证和供应商差异，业务只消费统一流。 */
import { jsonSchema, streamText, tool } from 'ai'
import type { JSONSchema7, JSONValue, ModelMessage as AiSdkMessage, ToolSet, UserContent } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import type { ModelMessage, ModelProtocol, ModelRequest, ProviderAuth, ReasoningState, ToolSpec, UserMessageContent } from '@magic/contracts'
import type { ModelStreamOptions } from './call.ts'
import type { VendorStreamPart } from './normalize.ts'
import { CHAT_REASONING_METADATA } from './reasoning-metadata.ts'
import { reasoningParams } from './vendors.ts'
import type { VendorAdapter } from './vendors.ts'

export const MINIMAX_PROVIDER_ID = 'minimax'
export const MINIMAX_BASE_URL = 'https://api.minimaxi.com/v1'
export const MINIMAX_MODEL = 'MiniMax-M3'
/** 只有所有资料均缺少输出上限时使用的请求额度，不伪装成模型能力。 */
export const MAX_COMPLETION_TOKENS = 4096
export type FetchLike = (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => Promise<Response>
export type VendorStreamerOptions = {
  readonly providerId: string
  readonly baseURL: string
  readonly protocol: ModelProtocol
  readonly auth: ProviderAuth
  readonly apiKey: string
  readonly fetch?: FetchLike
  readonly adapter?: VendorAdapter
}
export type VendorRequest = ModelRequest & { readonly model: string }
export type VendorStreamer = (request: VendorRequest, options?: ModelStreamOptions, maxOutputTokens?: number) => AsyncIterable<VendorStreamPart>

function sameSource(state: ReasoningState | undefined, options: VendorStreamerOptions, model: string): boolean {
  return state?.provider === options.providerId && state.model === model
    && state.protocol === options.protocol && state.endpoint === options.baseURL
}
function toUserContent(content: UserMessageContent): UserContent {
  return typeof content === 'string' ? content : content.map(part => part.type === 'text'
    ? { type: 'text', text: part.text } : { type: 'file', data: part.data, mediaType: part.mime })
}
function reasoningParts(state: ReasoningState | undefined, text: string | undefined, protocol: ModelProtocol) {
  if (state === undefined) return []
  if (protocol === 'chat-completions') return text ? [{ type: 'reasoning' as const, text }] : []
  return (state.items ?? []).map(item => {
    if (protocol === 'responses') {
      if (typeof item.id !== 'string') throw new Error('Responses 思考项缺少 id，无法安全回传')
      return { type: 'reasoning' as const, text: '', providerOptions: { openai: { itemId: item.id, reasoningEncryptedContent: typeof item.encrypted_content === 'string' ? item.encrypted_content : '' } } }
    }
    return { type: 'reasoning' as const, text: typeof item.thinking === 'string' ? item.thinking : '',
      providerOptions: { anthropic: item.type === 'redacted_thinking'
        ? { redactedData: item.data as string } : { signature: typeof item.signature === 'string' ? item.signature : '' } } }
  })
}
function toAiSdkMessages(messages: readonly ModelMessage[], options: VendorStreamerOptions, model: string): AiSdkMessage[] {
  return messages.filter(message => message.role !== 'system').map((message): AiSdkMessage => {
    switch (message.role) {
      case 'user': return { role: 'user', content: toUserContent(message.content) }
      case 'assistant': {
        const state = sameSource(message.reasoningState, options, model) ? message.reasoningState : undefined
        const details = options.protocol === 'chat-completions' ? state?.details : undefined
        const content = [
          ...reasoningParts(state, message.reasoning, options.protocol),
          ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
          ...(message.toolCalls ?? []).map(call => ({ type: 'tool-call' as const, toolCallId: call.id, toolName: call.name, input: call.args })),
        ]
        return { role: 'assistant', content: content.length ? content : message.content,
          ...(details === undefined ? {} : { providerOptions: { openaiCompatible: { reasoning_details: details as JSONValue[] } } }) }
      }
      case 'tool': return { role: 'tool', content: [{ type: 'tool-result', toolCallId: message.callId, toolName: message.name,
        output: { type: message.ok ? 'text' : 'error-text', value: message.output } }] }
    }
  })
}
function toAiSdkTools(specs: readonly ToolSpec[]): ToolSet {
  return Object.fromEntries(specs.map(spec => [spec.name, tool({ description: spec.summary, inputSchema: jsonSchema(spec.parameters as JSONSchema7) })]))
}

/** SDK 不能表示的原协议数据在本接缝回填；不把第三方私有字段套给另一协议。 */
function restoreItems(body: Record<string, any>, request: VendorRequest, options: VendorStreamerOptions) {
  const items = request.messages.flatMap(message => message.role === 'assistant' && sameSource(message.reasoningState, options, request.model)
    ? message.reasoningState?.items ?? [] : [])
  if (options.protocol === 'responses') {
    const originals = new Map(items.map(item => [item.id, item]))
    body.input = body.input.map((item: Record<string, unknown>) => item.type === 'reasoning' && originals.has(item.id) ? originals.get(item.id) : item)
    // 历史始终由 Magic 发送；不启用服务端持久化、接续、截断或压缩。
    body.store = false
    delete body.previous_response_id
    delete body.conversation
    delete body.context_management
    body.truncation = 'disabled'
  } else if (options.protocol === 'messages') {
    let index = 0
    for (const message of body.messages) if (message.role === 'assistant' && Array.isArray(message.content)) {
      message.content = message.content.map((part: Record<string, unknown>) =>
        ['thinking', 'redacted_thinking'].includes(String(part.type)) ? items[index++] ?? part : part)
    }
  }
}

export function createVendorStreamer(options: VendorStreamerOptions): VendorStreamer {
  return (request, streamOptions, maxOutputTokens) => {
    const mapped = reasoningParams(options.adapter, streamOptions?.reasoning, request.model, options.protocol)
    if (mapped !== undefined && 'gap' in mapped) throw new Error(mapped.gap)
    const params = mapped?.params
    const fetch: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers)
      headers.delete('authorization')
      headers.delete('x-api-key')
      if (options.auth === 'bearer') headers.set('authorization', `Bearer ${options.apiKey}`)
      if (options.auth === 'api-key') headers.set('x-api-key', options.apiKey)
      const body = JSON.parse(String(init?.body))
      restoreItems(body, request, options)
      // 参数由模型域已核实的协议映射负责，SDK 的官方型号表不改写自定义原始型号的设置。
      if (options.protocol === 'responses') {
        body.max_output_tokens = maxOutputTokens ?? MAX_COMPLETION_TOKENS
        if (params?.reasoningEffort !== undefined) body.reasoning = { effort: params.reasoningEffort }
        else delete body.reasoning
      } else if (options.protocol === 'messages') {
        // SDK 会将 thinking budget 再加到 max_tokens；Magic 的输出额度已包含思考。
        body.max_tokens = maxOutputTokens ?? MAX_COMPLETION_TOKENS
        if (params?.thinking !== undefined) {
          const { budgetTokens, ...thinking } = params.thinking as Record<string, JSONValue>
          body.thinking = { ...thinking, ...(budgetTokens === undefined ? {} : { budget_tokens: budgetTokens }) }
        } else delete body.thinking
        if (params?.effort !== undefined) body.output_config = { ...body.output_config, effort: params.effort }
      }
      return (options.fetch ?? globalThis.fetch)(url, { ...init, headers, body: JSON.stringify(body) })
    }
    // Empty explicit strings stop SDK key resolution from consulting OPENAI_API_KEY / ANTHROPIC_API_KEY.
    // The fetch boundary above is the sole authority for all emitted authentication headers.
    const sdkKey = options.auth === 'none' ? '' : options.apiKey
    const protocol = options.protocol
    const model = protocol === 'responses'
      ? createOpenAI({ baseURL: options.baseURL, apiKey: sdkKey, fetch: fetch as typeof globalThis.fetch }).responses(request.model)
      : protocol === 'messages'
      ? createAnthropic({ baseURL: options.baseURL, apiKey: sdkKey, fetch: fetch as typeof globalThis.fetch }).messages(request.model)
      : createOpenAICompatible({ name: options.providerId, baseURL: options.baseURL, apiKey: sdkKey, fetch: fetch as typeof globalThis.fetch,
          includeUsage: true,
          convertUsage: usage => ({
            inputTokens: { total: usage?.prompt_tokens ?? undefined, noCache: undefined, cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? undefined, cacheWrite: undefined },
            outputTokens: { total: usage?.completion_tokens ?? undefined, text: undefined, reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? undefined },
            raw: (usage ?? undefined) as Record<string, JSONValue> | undefined,
          }),
          transformRequestBody: options.adapter?.transformRequestBody,
          metadataExtractor: CHAT_REASONING_METADATA,
        }).chatModel(request.model)
    const instructions = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
    const providerOptions: Record<string, Record<string, JSONValue>> | undefined = protocol === 'responses' ? { openai: { store: false, systemMessageMode: 'system' } }
      : protocol === 'messages' ? { anthropic: {} }
      : params === undefined ? undefined : { [options.providerId]: params }
    const result = streamText({ model, ...(instructions ? { instructions } : {}),
      messages: toAiSdkMessages(request.messages, options, request.model),
      ...(request.tools?.length ? { tools: toAiSdkTools(request.tools) } : {}),
      maxOutputTokens: maxOutputTokens ?? MAX_COMPLETION_TOKENS,
      providerOptions,
      include: { rawChunks: true }, maxRetries: 0, onError: () => undefined,
      ...(streamOptions?.signal === undefined ? {} : { abortSignal: streamOptions.signal }),
    })
    return result.fullStream as AsyncIterable<VendorStreamPart>
  }
}
