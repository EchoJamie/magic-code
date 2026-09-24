/**
 * 界面验收 · 本地模型夹具（U40）——**loopback HTTP/SSE 接真模型适配链**。
 *
 * ## 为什么是 HTTP，而不是进程内的替身网关
 *
 * 这一层验的是**用户真正走的那条路**：真 `cli.ts` → 真装配 → 真模型域 →
 * `@ai-sdk/openai-compatible` → **网络**。进程内的 `FauxGateway` 把最后那一跳换掉了，
 * 于是「端点地址从配置里解析」「key 从配置里取」「SSE 分块怎么变成屏上的字」这几段
 * 都不在判据里——而它们恰恰是用户可感的那部分。
 *
 * 故这里起的是**真服务器**：`Bun.serve` 绑 `127.0.0.1`、端口**自动分配**（`port: 0`），
 * 回的是 OpenAI 兼容的 `text/event-stream`。配置里的 `baseURL` 指向它（见 `sandbox.ts`），
 * 整条链上**只有端点地址是假的**。
 *
 * ⚠️ **一个付费请求都不发**：绑的是环回地址，且客户端那把 key 是合成的假 key。
 *
 * ## 剧本（turns）
 *
 * 「这一趟模型说什么」按请求次序取——第 n 次请求用第 n 个回合，**用完了重复最后一个**。
 * 三形：
 * - `text`——流式吐一段字（可分块 ＋ 块间延时：**中间屏取样**要的就是这段「长出来的过程」）；
 * - `tool`——请求一个工具调用（走真闸门 → 裁决卡 → 真执行 → 再回模型）；
 * - `http`——甩一个错状态（判据要的失败现场）。
 */

/** 剧本的一回合——「第 n 次请求，模型怎么答」。 */
export type FixtureTurn =
  | {
      readonly kind: 'text'
      readonly text: string
      /** 切成几块吐（缺省 3）——块越多，「中间屏」越抓得到。 */
      readonly chunks?: number
      /** 块间延时（毫秒，缺省 120）——真流式是**长出来的**，不是一次性落下来的。 */
      readonly chunkDelayMs?: number
    }
  | {
      readonly kind: 'tool'
      readonly name: string
      readonly args: Record<string, unknown>
      /**
       * **这一回合先说的那句**（缺省＝一个字都不说）。
       *
       * 真供应商的一回合可以**又说话又调工具**（正文分块流完，紧跟着 `tool_calls`），
       * 而这一档原先只会发 `tool_calls` ⇒ 留帧装置造不出
       * 「`⏺ 我先看看。` ＋ `● ls …`」那一形（U67 的块交界有一半落在它上面）。
       * 给了 `text` 就照 `text` 那一档的折法**先流一段正文**，再发工具调用。
       *
       * ⚠️ **不给＝一个字都没有**——这一形也是要的：「模型一句话都没说就调工具」时屏上是
       * `› 改个文件` **紧接** `⟳ ls …`（中间没有 `⏺` 那句，见设计 · 终端呈现那一条的补正）。
       */
      readonly text?: string
      /** 正文切成几块吐 / 块间延时（同 `text` 那一档的缺省：3 块 · 120ms）。 */
      readonly chunks?: number
      readonly chunkDelayMs?: number
    }
  | { readonly kind: 'http'; readonly status: number; readonly message: string }

/** 夹具收到的一次请求——**回填送达了吗 / 提交前是不是零请求**这类判据靠它。 */
export type FixtureRequest = {
  readonly n: number
  readonly path: string
  readonly model: string
  /** 送进来几条消息（系统消息也算）。 */
  readonly messages: number
  /** 最后一条 user 正文（截断）——「实际发出去的是什么」的物证。 */
  readonly lastUser: string
  /**
   * 最后一条 user 消息里**图像部件**的个数（U37）——「图真到了端点上吗」的物证。
   *
   * `lastUser` 只拼文字那几件（图没有文字），故「带图了没有」得另报一个数：
   * 判据要是只看正文，把图丢在取件层也照样绿。
   */
  readonly images: number
  /** 这次请求带了工具吗（工具调用那一路要它）。 */
  readonly tools: number
  /** 相对夹具起好的时刻（毫秒）。 */
  readonly at: number
}

export type Fixture = {
  /** 交给配置的 `baseURL`（`http://127.0.0.1:<port>/v1`）。 */
  readonly baseURL: string
  readonly port: number
  /** 到此刻为止收到的请求（按次序）。 */
  requests(): readonly FixtureRequest[]
  /** 停服——**端口跟着释放**（「自有端点已释放」那条判据查的就是它）。 */
  stop(): Promise<void>
}

export type FixtureOptions = {
  readonly turns: readonly FixtureTurn[]
  /** 回给客户端的模型名（缺省 `MiniMax-M3`，与配置里那条一致）。 */
  readonly model?: string
}

/** 没给剧本时的回话——「一路顺风回一句」，只为让链子走通。 */
const DEFAULT_TURN: FixtureTurn = { kind: 'text', text: '收到' }

export function startFixture(options: FixtureOptions): Fixture {
  const model = options.model ?? 'MiniMax-M3'
  const started = Bun.nanoseconds()
  const requests: FixtureRequest[] = []
  let index = 0

  const server = Bun.serve({
    // 端口自动分配——**两个实例并行**时端口不串（判据 6）；绑环回地址 ⇒ 不出网
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const body = await readBody(req)
      const messages = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : []
      const tools = Array.isArray(body['tools']) ? (body['tools'] as unknown[]).length : 0
      const turn = options.turns[index] ?? options.turns.at(-1) ?? DEFAULT_TURN

      requests.push({
        n: requests.length + 1,
        path: new URL(req.url).pathname,
        model: typeof body['model'] === 'string' ? body['model'] : model,
        messages: messages.length,
        lastUser: lastUserOf(messages),
        images: imagesOf(messages),
        tools,
        at: (Bun.nanoseconds() - started) / 1e6,
      })
      index += 1

      if (turn.kind === 'http') {
        return new Response(JSON.stringify({ error: { message: turn.message } }), {
          status: turn.status,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(streamOf(turn, model, requests.length), {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      })
    },
  })

  // 端口是**内核分配的**（`port: 0`）——起不来就说清楚，不给一个 `undefined` 糊过去
  const port = server.port
  if (port === undefined) {
    // 半成品由**创建者**收掉：抛出去之后调用方手上没有 Fixture，那个服务就没人停得掉了
    void server.stop(true)
    throw new Error('夹具起在了 unix socket 上——本夹具只认 TCP 端口')
  }

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    port,
    requests: () => requests,
    stop: async () => {
      await server.stop(true)
    },
  }
}

/** 请求体（读不出来按空对象办——判据只看我们关心的那几格）。 */
async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await req.text())
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 最后一条 user 消息里的图像部件数（U37）——`image_url` 那一形（OpenAI 兼容的出站形态）。 */
function imagesOf(messages: readonly unknown[]): number {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]
    if (typeof message !== 'object' || message === null) continue
    const entry = message as { role?: unknown; content?: unknown }
    if (entry.role !== 'user') continue
    if (!Array.isArray(entry.content)) return 0

    return entry.content.filter(
      (part) => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'image_url',
    ).length
  }

  return 0
}

/** 最后一条 user 的正文（AI SDK 可能发数组形态的 content——只取文本块）。 */
function lastUserOf(messages: readonly unknown[]): string {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]
    if (typeof message !== 'object' || message === null) continue
    const entry = message as { role?: unknown; content?: unknown }
    if (entry.role !== 'user') continue

    const text =
      typeof entry.content === 'string'
        ? entry.content
        : Array.isArray(entry.content)
          ? entry.content
              .map((part) =>
                typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
                  ? String((part as { text?: unknown }).text ?? '')
                  : '',
              )
              .join('')
          : ''

    return text.slice(0, 200)
  }

  return ''
}

/** 一次 `data: {…}` 帧（OpenAI 兼容片的形制）。 */
function frame(model: string, payload: Record<string, unknown>): string {
  const head = {
    id: 'chatcmpl-u40',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model,
  }

  return `data: ${JSON.stringify({ ...head, ...payload })}\n\n`
}

/**
 * 一段正文分块吐出去（块间真等）——`text` 那一档与「又说话又调工具」那一档共用这一处。
 *
 * 空的正文也发那个 `content: ''` 的角色帧：`http` 那一档走的就是这一形（原先如此，
 * 不改它的字节）。
 */
async function streamText(
  push: (text: string) => void,
  model: string,
  text: string,
  chunks: number,
  delayMs: number,
): Promise<void> {
  const size = Math.ceil(text.length / Math.max(1, chunks))

  push(frame(model, { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }))
  for (let at = 0; at < text.length; at += size) {
    push(frame(model, { choices: [{ index: 0, delta: { content: text.slice(at, at + size) } }] }))
    if (delayMs > 0) await Bun.sleep(delayMs)
  }
}

/**
 * 一回合的 SSE 字节流——**按块真流**（块间真等）。
 *
 * `ReadableStream` 的 `start` 里顺序 `await`：写一块、等一会儿、再写下一块。
 * 这样屏上看到的是**长出来的**正文，`capture` 才抓得到中间那几屏（判据 3 要它）。
 */
function streamOf(turn: FixtureTurn, model: string, callIndex: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (text: string): void => controller.enqueue(encoder.encode(text))

      if (turn.kind === 'tool') {
        // **先说那句**（给了才说）——真供应商就是这样：正文分块流完，紧跟着 `tool_calls`
        if (turn.text !== undefined && turn.text !== '') {
          await streamText(push, model, turn.text, turn.chunks ?? 3, turn.chunkDelayMs ?? 120)
        }
        push(
          frame(model, {
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_u40_${callIndex}`,
                      type: 'function',
                      function: { name: turn.name, arguments: JSON.stringify(turn.args) },
                    },
                  ],
                },
              },
            ],
          }),
        )
        push(frame(model, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
        // 用量帧（收尾那一格）——与 `text` 那一档同形：一回合一份，模型域据此上屏
        push(
          frame(model, {
            choices: [],
            usage: {
              prompt_tokens: 1_000 + callIndex,
              completion_tokens: (turn.text ?? '').length,
              total_tokens: 1_000 + callIndex + (turn.text ?? '').length,
            },
          }),
        )
        push('data: [DONE]\n\n')
        controller.close()
        return
      }

      const text = turn.kind === 'text' ? turn.text : ''
      const chunks = turn.kind === 'text' ? Math.max(1, turn.chunks ?? 3) : 1
      const delayMs = turn.kind === 'text' ? (turn.chunkDelayMs ?? 120) : 0

      await streamText(push, model, text, chunks, delayMs)
      push(frame(model, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      // 用量帧（收尾那一格）——状态行 ④ 的分母/分子据此上屏
      push(
        frame(model, {
          choices: [],
          usage: { prompt_tokens: 1_000 + callIndex, completion_tokens: text.length, total_tokens: 1_000 + callIndex + text.length },
        }),
      )
      push('data: [DONE]\n\n')
      controller.close()
    },
  })
}
