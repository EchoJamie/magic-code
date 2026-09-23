/**
 * U41 · **供应商端点的专属夹具**（界面线）——loopback HTTP，按两家官方接口的形状回话。
 *
 * ## 它是什么、不是什么
 *
 * **是**：一个**真 HTTP 服务器**（`Bun.serve`、绑 `127.0.0.1`、端口自动分配），把
 * 「列表 / 详情 / 聊天」三条端点按 MiniMax 与 DeepSeek 的**公开接口形状**摆出来，
 * 并带上「刷新后新增一条 / 限流 / 认证失败 / 迟到 / 断连」这几只旋钮。
 * 于是「接通供应商 → 发现模型 → 选择 → 真发出这条模型」这条链上的**网络那一跳是真的**。
 *
 * **不是**：不是真实账号验证。**一个付费请求都不发**（环回地址 ＋ 合成假 key），
 * 也没有任何真实 key。故本夹具能证的是**通路与形状**，不能证「这个账号有权调用」——
 * 那一条要真实账号另验，工单允许明写限度。
 *
 * ## 为什么按 URL **后缀**分派，而不钉死路径前缀
 *
 * 两家的官方地址不是同一个形状（MiniMax 是 `<host>/v1/...`，DeepSeek 是
 * `<host>/models`）。夹具**照后缀认端点**（`/models` · `/models/<id>` · `/chat/completions`），
 * 于是它坐落在哪种前缀之下都回同一件事——**不必替供应商适配先猜一个 URL 形状**，
 * 也就不会拿「猜错的形状」去判适配写得对不对（那正是把夹具的错记在适配头上）。
 *
 * ## 两处如实留白（**不许当已验证**）
 *
 * - **分页形制未对真账号核过**：两家文档给了列表接口，但「用哪个参数翻页」本夹具按
 *   `page` / `page_size` 与 `cursor` 两种常见写法**都认**，且**默认不翻页**（一次给全）。
 *   真要用翻页那一格，就在 `pagination` 里明写——那时才按它切，并在请求轨迹里留下
 *   实际收到的参数（写报告时照它说，不凭印象）。
 * - **详情接口只有 MiniMax 有**（DeepSeek 公开结构里没有单模型详情）：故 `detail` 一格的
 *   缺省按供应商给——MiniMax 有、DeepSeek **404**。DeepSeek 那一格**不伪造**：
 *   它没有的就是没有，适配不该去调它（调了这里就留痕）。
 *
 * ## 脱敏
 *
 * 记请求时**只记凭据对不对**（`auth: ok | missing | mismatch`），**一个字节的 key 都不落盘**
 * ——夹具自己拿的是合成假 key，但这条纪律对**将来拿真 key 跑真账号**的那一天同样成立。
 */

/** 两家首批接入的供应商（`vendor` 字段的取值）。 */
export type VendorId = 'minimax' | 'deepseek'

/**
 * 一条模型——**字段名即供应商原始字段**（`id` 必有，其余原样带回）。
 *
 * 夹具不替它们归一：归一归模型域的适配，夹具只负责「供应商是这么说的」。
 * 要验「未知字段保持未知」，就在这儿**少给几格**（如 DeepSeek 的列表只有 `id`/`object`/`owned_by`）。
 */
export type ModelSpec = {
  readonly id: string
  readonly owned_by?: string
  readonly created?: number
  /** 供应商在列表里多带的那些格（原样透出——适配认不认是它的事）。 */
  readonly extra?: Readonly<Record<string, unknown>>
}

/**
 * 列表这一头的一回合——**按第几次 `GET models` 取**（用完了重复最后一个）。
 *
 * 「刷新之后新增可选」正是靠它：第一次回两个，第二次回三个。
 */
export type ListTurn =
  | {
      readonly kind: 'ok'
      readonly models: readonly ModelSpec[]
    }
  /**
   * 甩一个错状态（限流 `429` / 认证 `401` / 服务端 `500`）——判据要的失败现场。
   * `retryAfter` 给了就带 `Retry-After` 头（限流那一路的形状）。
   */
  | { readonly kind: 'error'; readonly status: number; readonly message: string; readonly retryAfter?: number }
  /** **直接把连接断掉**（不是状态码）——网络那一种失败。 */
  | { readonly kind: 'cut' }
  /** 先等一会儿再回下一回合——「端点慢，结果迟到」那一形靠它。 */
  | { readonly kind: 'slow'; readonly ms: number }

/** 聊天那一头的一回合（OpenAI 兼容 SSE）——形状照仓里那台共用夹具（`test/ui/fixture.ts`）。 */
export type ChatTurn =
  | {
      readonly kind: 'text'
      readonly text: string
      readonly chunks?: number
      readonly chunkDelayMs?: number
      /**
       * 收尾那一帧的用量——**按供应商的原始字段名给**（不归一：归一归模型域）。
       *
       * DeepSeek 那几格（`prompt_cache_hit_tokens` / `completion_tokens_details.reasoning_tokens`）
       * 在这里出现，是为了让「缓存命中不重复加总、思考细分不重复计数」那几条判据
       * 咬得着**真形状的报文**，而不是一个已经被人手削平的假对象。
       */
      readonly usage?: Readonly<Record<string, number | Record<string, number>>>
    }
  | { readonly kind: 'http'; readonly status: number; readonly message: string }

/** 一次调用按第几次取（用完了重复最后一个）。 */
function pick<T>(turns: readonly T[] | undefined, index: number, fallback: T): T {
  if (turns === undefined || turns.length === 0) return fallback

  return turns[Math.min(index, turns.length - 1)] as T
}

/** 夹具收到的一次 HTTP 请求——**判据的物证**（脱敏：只记凭据对不对，不记 key）。 */
export type ProviderRequest = {
  readonly n: number
  readonly method: string
  /** 去掉前缀之后的端点（`/models` · `/models/<id>` · `/chat/completions`）。 */
  readonly endpoint: string
  /** 原样的查询串（分页参数长什么样，照这里说）。 */
  readonly query: string
  /** 凭据对不对得上（`missing` ＝ 压根没带）。 */
  readonly auth: 'ok' | 'missing' | 'mismatch' | 'not-required'
  /** 聊天请求里那个 `model`（列表请求为空串）——**「实际出站的是哪一条」看它**。 */
  readonly model: string
  /** 相对夹具起好的时刻（毫秒）。 */
  readonly at: number
}

export type ProviderFixtureOptions = {
  readonly vendor: VendorId
  /** 要认的 key（合成假 key）；不给＝**不检查凭据**（那条路仍有 `auth: 'not-required'` 留痕）。 */
  readonly key?: string
  /** **一律拒绝**（无论 key 对不对）——「认证失败停在该连接上」那一形用它。 */
  readonly rejectAuth?: boolean
  /** 列表这一头的剧本（缺省：一条成功回合，模型表见下）。 */
  readonly lists?: readonly ListTurn[]
  /** 缺省那条成功回合回什么模型。 */
  readonly models?: readonly ModelSpec[]
  /** 聊天这一头的剧本。 */
  readonly chat?: readonly ChatTurn[]
  /** 详情接口：`auto` 按供应商给（MiniMax 有 / DeepSeek 404）· `off` 一律 404。 */
  readonly detail?: 'auto' | 'off'
  /**
   * **翻页那一格**（缺省不翻页：一次给全）。
   *
   * 给了才按它切——`page 0,1,2…`（`offset = page * size`）或 `cursor`（游标就是下一段的
   * 起点下标，字符串形式）。两种都认的理由见文件头「两处如实留白」。
   */
  readonly pagination?: {
    readonly style: 'page' | 'cursor'
    readonly size: number
    /** 参数名（缺省 `page` / `page_size`、`cursor`）。 */
    readonly pageParam?: string
    readonly sizeParam?: string
    readonly cursorParam?: string
  }
}

export type ProviderFixture = {
  /** 交给配置的 `baseURL`——**带 `/v1` 那一层**（两家官方地址都是这个形状的上一层）。 */
  readonly baseURL: string
  /** 另一形（DeepSeek 是 `<host>/models`，不带 `/v1`）——同一台服务器，换个写法而已。 */
  readonly bareURL: string
  readonly port: number
  /** 到此刻为止收到的请求（按次序）。 */
  requests(): readonly ProviderRequest[]
  /** 列表被问过几次（「刷新一共打了几次列表」直接数它）。 */
  listCalls(): number
  /** 停服——**端口跟着释放**。 */
  stop(): Promise<void>
}

/** 缺省的两家模型表——**形状照各家公开文档**（不是全量清单，只是「这儿有这些」）。 */
const DEFAULT_MODELS: Readonly<Record<VendorId, readonly ModelSpec[]>> = {
  minimax: [
    { id: 'MiniMax-M3', owned_by: 'minimax' },
    { id: 'MiniMax-Text-01', owned_by: 'minimax' },
  ],
  deepseek: [
    // DeepSeek 公开的列表结构只有这几格——**不替它补容量与思考**（那是「缺项如实保留」）
    { id: 'deepseek-chat', owned_by: 'deepseek' },
    { id: 'deepseek-reasoner', owned_by: 'deepseek' },
  ],
}

/** 端点分派——**照后缀认**（理由见文件头）。 */
export function endpointOf(pathname: string): { readonly endpoint: string; readonly model: string } {
  const at = pathname.indexOf('/models')
  if (at !== -1) {
    const rest = pathname.slice(at + '/models'.length)

    return rest === '' || rest === '/'
      ? { endpoint: '/models', model: '' }
      : { endpoint: `/models${rest}`, model: decodeURIComponent(rest.slice(1)) }
  }
  if (pathname.endsWith('/chat/completions')) return { endpoint: '/chat/completions', model: '' }

  return { endpoint: pathname, model: '' }
}

export function startProviderFixture(options: ProviderFixtureOptions): ProviderFixture {
  const started = Bun.nanoseconds()
  const requests: ProviderRequest[] = []
  const models = options.models ?? DEFAULT_MODELS[options.vendor]
  const hasDetail = options.detail === 'off' ? false : options.vendor === 'minimax'

  let listIndex = 0
  let chatIndex = 0

  const record = (init: Omit<ProviderRequest, 'n' | 'at'>): void => {
    requests.push({ n: requests.length + 1, at: (Bun.nanoseconds() - started) / 1e6, ...init })
  }

  /**
   * 凭据对得上吗——**只回三态，不比对内容之外的东西**（脱敏见文件头）。
   *
   * 两家的官方认证都是 `Authorization: Bearer <key>`；没配 key ＝ 不检查
   * （`not-required`），但**照样留痕**——「这一趟有没有带凭据」是判据要看的事。
   */
  const authOf = (req: Request): ProviderRequest['auth'] => {
    if (options.key === undefined) return 'not-required'

    const header = req.headers.get('authorization')
    if (header === null) return 'missing'

    return header === `Bearer ${options.key}` ? 'ok' : 'mismatch'
  }

  const denied = (): Response =>
    json({ error: { message: 'invalid api key', type: 'authentication_error' } }, 401)

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url)
      const { endpoint, model } = endpointOf(url.pathname)
      const body = req.method === 'POST' ? await readBody(req) : {}
      const auth = authOf(req)
      const outbound = typeof body['model'] === 'string' ? body['model'] : ''

      record({ method: req.method, endpoint, query: url.search, auth, model: outbound })

      // 「一律拒绝」优先于一切：**认证没过就停在这儿**（不轮试别的地址 / 别的凭据）
      if (options.rejectAuth === true) return denied()
      if (auth === 'missing' || auth === 'mismatch') return denied()

      if (endpoint === '/models') return await list(url)
      if (endpoint.startsWith('/models/')) {
        return hasDetail ? json(modelDetail(model), 200) : json({ error: { message: 'not found' } }, 404)
      }
      if (endpoint === '/chat/completions') return chat(body)

      return json({ error: { message: `夹具不认这个端点：${endpoint}` } }, 404)
    },
  })

  // 端口是**内核分配的**（`port: 0`）——起不来就说清楚，不给一个 `undefined` 糊过去
  const port = server.port
  if (port === undefined) {
    void server.stop(true)
    throw new Error('供应商夹具起在了 unix socket 上——本夹具只认 TCP 端口')
  }

  /**
   * 列表那一头：回合取 `lists[listIndex]`，按需切页。
   *
   * `slow` 只说「这一趟慢」，不说「回什么」——故**当场等完再取下一回合**（一个回合一号），
   * 而不是把它当成一条答复（那样调用方会拿到一个没有列表的空答复，判据看的就是假现场）。
   */
  const list = async (url: URL): Promise<Response> => {
    for (;;) {
      const turn = pick(options.lists, listIndex, { kind: 'ok', models } as ListTurn)
      listIndex += 1

      if (turn.kind === 'slow') {
        // 请求**已经入账了**（`record` 在进本函数之前）——慢也留痕，迟到的现场才说得清
        await Bun.sleep(turn.ms)
        continue
      }
      if (turn.kind === 'cut') return cut()
      if (turn.kind === 'error') {
        const headers: Record<string, string> = {}
        if (turn.retryAfter !== undefined) headers['retry-after'] = String(turn.retryAfter)

        return json({ error: { message: turn.message } }, turn.status, headers)
      }

      const slice = pageOf(turn.models, url, options.pagination)

      return json(
        {
          object: 'list',
          data: slice.rows.map((one) => ({
            id: one.id,
            object: 'model',
            created: one.created ?? 1_700_000_000,
            owned_by: one.owned_by ?? options.vendor,
            ...(one.extra ?? {}),
          })),
          ...(slice.next === undefined ? {} : { next: slice.next, has_more: true }),
        },
        200,
      )
    }
  }

  /** 聊天那一头：OpenAI 兼容 SSE（形状照共用夹具，另加可选的原生用量格）。 */
  const chat = (body: Readonly<Record<string, unknown>>): Response => {
    const turn = pick(options.chat, chatIndex, { kind: 'text', text: '收到' } as ChatTurn)
    chatIndex += 1

    if (turn.kind === 'http') {
      return json({ error: { message: turn.message } }, turn.status)
    }

    const outbound = typeof body['model'] === 'string' ? body['model'] : 'model'
    const text = turn.text
    const chunks = Math.max(1, turn.chunks ?? 3)
    const delayMs = turn.chunkDelayMs ?? 0
    const size = Math.max(1, Math.ceil(text.length / chunks))
    const encoder = new TextEncoder()

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const push = (payload: Record<string, unknown>): void =>
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: 'chatcmpl-u41',
                object: 'chat.completion.chunk',
                created: 1_700_000_000,
                model: outbound,
                ...payload,
              })}\n\n`,
            ),
          )

        push({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
        for (let at = 0; at < text.length; at += size) {
          push({ choices: [{ index: 0, delta: { content: text.slice(at, at + size) } }] })
          if (delayMs > 0) await Bun.sleep(delayMs)
        }
        push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        if (turn.usage !== undefined) push({ choices: [], usage: turn.usage })
        push({ choices: [], usage: turn.usage ?? { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    })
  }

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    bareURL: `http://127.0.0.1:${port}`,
    port,
    requests: () => requests,
    listCalls: () => requests.filter((one) => one.endpoint === '/models').length,
    stop: async () => {
      await server.stop(true)
    },
  }
}

/**
 * **把这条连接掐断**——网络那一种失败的形状（不是状态码）。
 *
 * ⚠️ **不能靠 `throw`**：`Bun.serve` 会把处理器抛出来的错**变成一条 500 答复**
 * （实测：客户端拿到的是 `500`，不是「断了」）——那样这一格就成了一条假的网络失败，
 * 而判据会以为自己在验「断连」。
 *
 * 用**答复体中止**的流：头已经出去了，正文一个字节都没有，连接随即被掐——
 * 客户端那边 `await res.text()`（或 `.json()`）当场抛。**这条只有实测说了算**，
 * 故同名用例里拿一个已知答案的样本咬它（`fetch 抛 / 读体抛` 二形都认）。
 *
 * ⚠️ **中止时不带缘由**（`controller.error()` 不传参数）：传了的话 Bun 会把那个 `Error`
 * 连同栈打到 stderr——那是**夹具演出来的**一条错，混进门日志里就成了「像是真出了事」。
 * 客户端那边照样抛（它拿到的是「这条答复断了」，与缘由是什么无关）。
 */
function cut(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error()
    },
  })

  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 详情回什么——**只回列表已有的那几格**（不替供应商编容量 / 思考）。 */
function modelDetail(id: string): Record<string, unknown> {
  return { id, object: 'model', created: 1_700_000_000, owned_by: 'minimax' }
}

/** 切一页——不翻页时一次给全（见 `pagination` 的注）。 */
function pageOf(
  rows: readonly ModelSpec[],
  url: URL,
  pagination: ProviderFixtureOptions['pagination'],
): { readonly rows: readonly ModelSpec[]; readonly next?: string } {
  if (pagination === undefined) return { rows }

  if (pagination.style === 'page') {
    const pageParam = pagination.pageParam ?? 'page'
    const sizeParam = pagination.sizeParam ?? 'page_size'
    const page = Number(url.searchParams.get(pageParam) ?? '0') || 0
    const size = Number(url.searchParams.get(sizeParam) ?? '') || pagination.size
    const from = page * size
    const slice = rows.slice(from, from + size)

    return slice.length + from < rows.length ? { rows: slice, next: String(page + 1) } : { rows: slice }
  }

  const cursorParam = pagination.cursorParam ?? 'cursor'
  const from = Number(url.searchParams.get(cursorParam) ?? '0') || 0
  const slice = rows.slice(from, from + pagination.size)

  return slice.length + from < rows.length ? { rows: slice, next: String(from + pagination.size) } : { rows: slice }
}

/** JSON 答复（两家的错误体都不是同一个形状，但**判据只看状态码与那一句 message**）。 */
function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
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
