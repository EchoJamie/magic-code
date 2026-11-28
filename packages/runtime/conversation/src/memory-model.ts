import type { EventSink, EventStamper, ModelErrorTier, ModelGateway, ModelRequest, ModelResult } from '@magic/contracts'

/** 内务模型只发布完成元数据；正文、思考和用量不混入主对话事件流。 */
export async function callMemoryModel(input: {
  readonly purpose: 'compact' | 'memory-tidy'
  readonly gateway: ModelGateway
  readonly request: ModelRequest
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxOutputTokens?: number
  readonly sink: EventSink
  readonly stamper: EventStamper
  readonly now: () => number
}): Promise<{ text: string; reasoning: string; result: ModelResult; model?: string; provider?: string; failure?: { tier: ModelErrorTier; message: string } }> {
  input.signal?.throwIfAborted()
  const began = input.now()
  const timeoutMs = input.timeoutMs ?? 120_000
  const controller = new AbortController()
  let timedOut = false
  const onParentAbort = () => controller.abort()
  input.signal?.addEventListener('abort', onParentAbort, { once: true })
  const timer = timeoutMs > 0 && Number.isFinite(timeoutMs)
    ? setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    : undefined

  let model: string | undefined
  let provider: string | undefined
  let result: ModelResult | undefined
  let failure: { tier: ModelErrorTier; message: string } | undefined
  let text = ''; let reasoning = ''
  try {
    const stream = input.gateway.stream(input.request, {
      signal: controller.signal,
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    })
    // 事件读取中断时也接住结果通道的拒绝，避免另一出口成为未处理异常。
    void stream.result.catch(() => {})
    for await (const event of stream.events) {
      if (event.kind === 'model.call.start') { model = event.data.model; provider = event.data.provider }
      if (event.kind === 'model.delta' && event.data.channel === 'text') text += event.data.text
      if (event.kind === 'model.delta' && event.data.channel === 'thinking') reasoning += event.data.text
      if (event.kind === 'model.error') failure = event.data
    }
    result = await stream.result
    if (timedOut && input.signal?.aborted !== true && failure === undefined) {
      failure = { tier: 'transient', message: `内务调用超时（超过 ${Math.ceil(timeoutMs / 1000)} 秒未完成）` }
    }
    return { text, reasoning, result, model, ...(provider === undefined ? {} : { provider }), ...(failure === undefined ? {} : { failure }) }
  } catch (error) {
    if (timedOut && input.signal?.aborted !== true) {
      failure ??= { tier: 'transient', message: `内务调用超时（超过 ${Math.ceil(timeoutMs / 1000)} 秒未完成）` }
    } else {
      failure ??= { tier: 'terminal', message: error instanceof Error ? error.message : String(error) }
    }
    return { text, reasoning, result: { complete: false, finishReason: 'error' }, failure }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    input.signal?.removeEventListener('abort', onParentAbort)
    const finishedOk = result?.complete === true
      && (result.finishReason === 'stop' || result.finishReason === 'tool-calls')
    input.sink.emit(input.stamper.stamp('memory.model', {
      purpose: input.purpose, durationMs: Math.max(0, input.now() - began),
      ok: finishedOk && failure === undefined && !timedOut && input.signal?.aborted !== true,
      ...(model === undefined ? {} : { model }), ...(provider === undefined ? {} : { provider }),
      ...(result?.usage === undefined ? {} : { usage: result.usage }),
      ...(result?.finishReason === undefined ? {} : { finishReason: result.finishReason }),
    }))
  }
}
