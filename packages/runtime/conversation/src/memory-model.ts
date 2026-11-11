import type { EventSink, EventStamper, ModelErrorTier, ModelGateway, ModelRequest, ModelResult } from '@magic/contracts'

/** 内务模型只发布完成元数据；正文、思考和用量不混入主对话事件流。 */
export async function callMemoryModel(input: {
  readonly purpose: 'compact'
  readonly gateway: ModelGateway
  readonly request: ModelRequest
  readonly signal?: AbortSignal
  readonly sink: EventSink
  readonly stamper: EventStamper
  readonly now: () => number
}): Promise<{ text: string; reasoning: string; result: ModelResult; failure?: { tier: ModelErrorTier; message: string } }> {
  input.signal?.throwIfAborted()
  const began = input.now()
  let model: string | undefined
  let provider: string | undefined
  let result: ModelResult | undefined
  let failure: { tier: ModelErrorTier; message: string } | undefined
  let text = ''; let reasoning = ''
  try {
    const stream = input.gateway.stream(input.request, input.signal === undefined ? {} : { signal: input.signal })
    // 事件读取中断时也接住结果通道的拒绝，避免另一出口成为未处理异常。
    void stream.result.catch(() => {})
    for await (const event of stream.events) {
      if (event.kind === 'model.call.start') { model = event.data.model; provider = event.data.provider }
      if (event.kind === 'model.delta' && event.data.channel === 'text') text += event.data.text
      if (event.kind === 'model.delta' && event.data.channel === 'thinking') reasoning += event.data.text
      if (event.kind === 'model.error') failure = event.data
    }
    result = await stream.result
    return { text, reasoning, result, ...(failure === undefined ? {} : { failure }) }
  } catch (error) {
    failure ??= { tier: 'terminal', message: error instanceof Error ? error.message : String(error) }
    return { text, reasoning, result: { complete: false, finishReason: 'error' }, failure }
  } finally {
    input.sink.emit(input.stamper.stamp('memory.model', {
      purpose: input.purpose, durationMs: Math.max(0, input.now() - began),
      ok: result?.complete === true && failure === undefined && input.signal?.aborted !== true,
      ...(model === undefined ? {} : { model }), ...(provider === undefined ? {} : { provider }),
      ...(result?.usage === undefined ? {} : { usage: result.usage }),
    }))
  }
}
