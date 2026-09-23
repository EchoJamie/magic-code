/**
 * 供应商注册表 —— 多供应商 ＋ **运行时切换**（技术方案 · 模型策略 · 切换）。
 *
 * 技术方案的原文：「registry 动态注册多供应商；运行时切换（会话中途换模型：上下文由内核
 * 构造，**换模型＝换接缝下游**）；注册表存于配置文件」。
 *
 * **归属**——选实现仍归装配：本文件只把配置里那张 `providers` 表变成「**条目 → 网关**」的
 * 查表（每条目一个 `createModelGateway`，key 各自解析一次），不读配置文件、不碰文件系统。
 * 「加一条目即多一个可用」由此成立：`providers` 加键，注册表就多一格，形制不变。
 *
 * **换模型＝换接缝下游**——注册表**就是**那个接缝：对话域只拿到一个 `ModelGateway`，
 * 全程不变；切换只改注册表内部的「当前选中」，于是下一次 `stream()` 走到另一个条目的
 * 网关上。对话域 / 记录域**不知道发生过切换**（上下文照旧由条目重建，一条不丢）。
 *
 * **模型名怎么定**（锚定：技术方案 · 配置与密钥「模型名取自请求」）——
 * - **未切换**：走缺省条目，模型名**取自请求**（`req.model`）——与接入时逐字同义；
 * - **切换之后**：走选中的条目 ＋ 选中的模型——`use({ provider })` 不带模型时取
 *   **该条目的默认**（`providers.<id>.model`）：换了条目还用上家的模型名，等于拿一个
 *   对方多半不认的名字去问。
 *
 * **域内零散件**：`use()` 返回判别式（成功 / 不成功 ＋ 缘由），**不抛**——与权限域
 * `parseRules` 同一姿态（读不懂的**不生效**，缘由交回调用方去说给人听）；且**切不动就不动**：
 * 校验全过才落选中，失败时原选中原样保留（缺省＝安全姿态）。
 */

import type {
  EventStamper,
  KernelEvent,
  ModelInfo,
  ModelRequest,
  ProviderConfig,
  ReasoningSetting,
} from '@magic/contracts'
import type { FetchLike } from './ai-sdk.ts'
import type { ModelGateway, ModelStream, ModelStreamOptions } from './call.ts'
import type { ModelMiddleware } from './middleware.ts'
import type { RetryPolicy, Sleeper } from './retry.ts'
import { MissingApiKeyError, createModelGateway, effectiveSpecOf } from './gateway.ts'
import type { EffectiveSpec } from './gateway.ts'
import { modelCallStart, modelErrorEvent } from './events.ts'
import { vendorOf } from './vendors.ts'
import type { VendorAdapter } from './vendors.ts'
import { MODEL_CONTEXT_BUILTIN, ownOf, resolveContextWindow } from './capacity.ts'
import type { WindowTable } from './capacity.ts'

// —— 形态 ——

/** 还没有可用选择时，那一轮调用报的那句话（说给人听：下一步该做什么）。 */
const NO_SELECTION = '还没有可用的供应商连接——先接入一个供应商并选一个模型'

/**
 * **一轮立刻失败**的调用流——用在「还没定下走谁」这唯一一种情形。
 *
 * 为什么不抛异常：对话域只该看见模型域的事件（`model.error` 是它的终局信号之一），
 * 异常穿层会让上层报「对话域异常」——把人指去错地方（`MissingApiKeyError` 那条注同理，
 * 区别在它是**构造期**的、还能在启动时报）。
 *
 * 形态与归一出来的流一致：`call.start` → `error`（**没有** `call.end`——
 * 与归一的不变式 ④ 一致：出错即以 `model.error` 终结）。
 */
function errorStream(stamper: EventStamper, model: string, message: string): ModelStream {
  const detail = { tier: 'terminal' as const, message }
  const events = (async function* (): AsyncGenerator<KernelEvent> {
    yield modelCallStart(stamper, model)
    yield modelErrorEvent(stamper, detail.tier, detail.message)
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

/** 注册表里的一格——**供应商细节不出域**：只给「叫什么、默认用哪个模型、窗多长」。 */
export type ProviderEntry = {
  readonly id: string
  /**
   * 该连接的**用户默认模型**（`providers.<id>.model`）——**没选过就不给这一位**。
   *
   * U41 起型号来自供应商接口的缓存，配置里的 `model` 只是「这个连接默认用哪个」，
   * 新接上的连接可以还没有它（用户第一次选完才会有）。
   */
  readonly model?: string
  /**
   * 该连接**默认选择的思考设置**（`providers.<id>.reasoning`）——没设过就不给这一位。
   *
   * 它随默认选中一起出去（返修：此前只读了 `model`，于是「保存了默认思考设置」在
   * **开局那条路径**上根本不生效——设置存进了配置，请求里却一个参数都没有）。
   */
  readonly reasoning?: ReasoningSetting
  /**
   * 该条目的**上下文窗口总量**（token）——**声明了就用它，否则查内置表**（U30）。
   *
   * 它是**元数据**（供应商 / 模型规格），不是供应商细节（端点 / key / 参数）：出得来。
   * 两处**都没有**才不给这个位——外壳拿不到分母就不显示分母，不编（缺陷 D10 · 第 1 样）。
   *
   * 判据在 `resolveContextWindow`（`capacity.ts`）：配置声明（`providers.<id>.contextWindow`）
   * 是**覆盖位**（本地端点 / 私有部署只有用户知道），内置表是**已知模型的客观属性**
   * ——用户不该为它去翻官方文档。
   */
  readonly contextWindow?: number
}

/** 当前选中——供应商 ＋ 模型（两个都得定下来：换条目而留旧模型名多半打不通）。 */
export type ModelSelection = {
  readonly provider: string
  readonly model: string
  /**
   * **这一次采用的思考设置**（U41）——缺省 ＝ 模型默认（不发送任何思考参数）。
   *
   * 它是**选中态的一部分**：换了模型而没显式指定时，取的是**目标模型**的默认，
   * 不把原模型的档位 / 预算盲目带过去（设计 · 模型与上下文「解析、继承与修改」）。
   */
  readonly reasoning?: ReasoningSetting
}

/**
 * 切换请求——两件都可缺，看要换什么：
 * - 只给 `provider`：换条目，模型取**该条目的默认**；
 * - 只给 `model`：留在这家，换模型（同一端点上跑另一个模型）；
 * - 都给：两件一起换。
 * - 都不给：不晓得更成什么——如实报「不知道要换成什么」，不猜。
 */
export type ModelSwitchRequest = {
  readonly provider?: string | undefined
  readonly model?: string | undefined
  /** 这次采用的思考设置——缺省＝模型默认（不把原模型那套带过来）。 */
  readonly reasoning?: ReasoningSetting | undefined
}

/**
 * 切换结果——判别式。
 * 不成功时选中**原样不动**（切不动就不动），`reason` 是**说给人听**的一句话
 * （含已注册的条目名——用户打错字时当场看得见有哪些可选）。
 */
export type ModelSwitchResult =
  | { readonly ok: true; readonly selection: ModelSelection }
  | { readonly ok: false; readonly reason: string }

/** 模型域 → 装配的注册表面（`ModelGateway` 的扩展——消费者按契约端口取用即可）。 */
export interface ModelRegistry extends ModelGateway {
  /** 已注册的条目（配置顺序）——「加一条目即多一个」的读数面。 */
  list(): readonly ProviderEntry[]
  /**
   * **窗长表**（U30 · 形态与消费见 `WindowTable` / `windowOfSelection`）——
   * 内置表 ＋ 各条目**自己声明**的覆盖位，**分开装**、按 `provider ＋ model` 消费。
   *
   * 为什么给外壳的是**表**而不是「此刻那一条的数」：换模型是**运行时**的事
   * （`/model` 一按就换），而外壳够不着注册表——它得**当场**知道新模型多长。
   * 表在手上，`model.switched` / `model.call.start` 一来就能查；查不到＝不知道（不编）。
   *
   * **声明只跟着它那一条目**（不按模型名合并）：合法的两个端点可能给同名模型声明
   * 不同的窗长，平表会让甲的声明盖到乙头上。
   */
  windowTable(): WindowTable
  /**
   * **某个模型的有效规格**（U41 返修 · 新出口）——显示、出站、压缩**同一份解析**。
   *
   * 由头（设计 · 模型与上下文「统一消费」）：「模型域解析一次有效选择与令牌规格，
   * 为当前请求形成不可变读数，贯穿调用、事件和容量消费」。
   *
   * ⚠️ **与 `windowTable()` 并存是过渡**：旧链（`registry.windowTable → 装配 → 外壳`）
   * 让外壳自己拿表算分母、gateway 另有一套算法，两处各说一套（复核点名）。新出口一次
   * 解析完；**界面接完这一格之后，旧链统一删**——在那之前两条链的**数值会不一致**
   * （旧表报窗长原值，新出口已为本次输出预留），这是过渡期的实情，不是最终态。
   */
  capacityOf(provider: string, model: string): EffectiveSpec | undefined
  /** 配置里的缺省连接 id（`defaultProvider`）——**没配过就不给**（U41 起可缺）。 */
  defaultProviderId(): string | undefined
  /** 当前**选中**；**未切换过即 `undefined`**（＝走缺省条目、模型名取自请求）。 */
  selection(): ModelSelection | undefined
  /**
   * **此刻会走哪一条**——`selection()` 的「没有就补缺省」版：未切换过＝缺省连接 ＋
   * 该连接的默认模型（`stream` 的实际去向）。
   *
   * 两个读法并存各有其用：`selection()` 回答「**换过没有**」（`undefined` 本身就是信息），
   * 本方法回答「**现在是谁**」——外壳的模型选择器要标「当前」，问的是后者
   * （缺陷 D10 · 第 3 样）。
   *
   * ⚠️ **U41 起可能 `undefined`**——还没选过模型（或一条连接都没有）时就**没有去向**：
   * 那时由调用方报「先选模型」，**不取列表第一项顶上**（设计明文）。
   */
  current(): ModelSelection | undefined
  has(id: string): boolean
  /** 换模型——会话中途调用，下一轮起走新条目（见文件头注）。 */
  use(request: ModelSwitchRequest): ModelSwitchResult
}

/**
 * 把**这次要用的思考设置**并进流选项——缺省＝不动（模型默认）。
 *
 * 已切换走选中态那份、未切换走配置里缺省连接那份；两处同一条拼装，
 * 免得再出现「一处带了、一处没带」（返修的根因）。
 */
function withReasoning(
  streamOptions: ModelStreamOptions | undefined,
  reasoning: ReasoningSetting | undefined,
): ModelStreamOptions | undefined {
  if (reasoning === undefined) return streamOptions
  return { ...streamOptions, reasoning }
}

/**
 * 思考设置能不能落——**做不到就说缘由**（设计 · 模型与上下文：校验失败保留原配置并
 * 说明原因，**不静默降档、不删参数**）。
 *
 * `default` 恒可（那正是「什么都不发」）；其余形态要**适配认得出**：
 * 兼容接入没有可配置的思考参数，官方适配按它自己的 `reasoningOf` 判——
 * 缺口的原话就是给用户看的那一句。
 */
function checkReasoning(
  adapter: VendorAdapter | undefined,
  setting: ReasoningSetting | undefined,
): { readonly setting?: ReasoningSetting | undefined } | { readonly reason: string } {
  if (setting === undefined || setting.mode === 'default') return {}

  if (adapter === undefined) {
    return { reason: '这条连接是兼容接入——思考设置只能用它自己的默认' }
  }

  const mapped = adapter.reasoningOf(setting)
  if (mapped !== undefined && 'gap' in mapped) return { reason: mapped.gap }
  return { setting }
}

export type ModelRegistryOptions = {
  /** 配置里的 `providers` 原样（形制见共享语言 · 配置形制）。 */
  readonly providers: Readonly<Record<string, ProviderConfig>>
  /**
   * 配置里的 `defaultProvider`——开局走它；**没配过就不给**（U41 起可缺）。
   *
   * 缺省时**不预造任何网关**，也不挑一条顶上：`current()` 为空、`stream()` 报「先选模型」，
   * 直到用户选一次（设计：「无默认时进入选择流程，不取列表第一项」）。
   */
  readonly defaultProvider?: string
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

// —— 装配 ——

/**
 * 造一个供应商注册表。
 *
 * **缺省条目在构造期就位**（＝造它的网关）——于是「开局要用的那条缺 key」照旧**启动期即报**
 * （与单供应商时代逐字同义：`MissingApiKeyError` 一声响，不留到第一次调用）。
 * **其余条目按需构造**（第一次切过去时才造）——理由：配置里可以有**当下还用不上**的条目
 * （本地端点 / 备用供应商），为一个永远不用的条目把启动卡死，是拿别人的错惩罚用户；
 * 而「切过去才发现没配好」也不难受：`use()` 当场把缘由说清楚（key 的来处在消息里）。
 */
export function createModelRegistry(options: ModelRegistryOptions): ModelRegistry {
  const { providers, defaultProvider, stamper } = options
  const entries = Object.entries(providers)

  // ⚠️ 查表一律走 `ownOf`（只认自有键）——条目名是用户给的字符串，普通索引会从
  // `Object.prototype` 上摸到东西（见 `capacity.ts` 的 `ownOf` 注）
  const defaultEntry = defaultProvider === undefined ? undefined : ownOf(providers, defaultProvider)
  if (defaultProvider !== undefined && defaultEntry === undefined) {
    const known = entries.map(([id]) => id).join(' / ') || '（一个都没有）'
    throw new Error(`缺省供应商「${defaultProvider}」不在 providers 里——已配：${known}`)
  }

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
      maxCompletionTokens: options.maxCompletionTokens,
    })
    built.set(id, gateway)
    return gateway
  }

  /** 开局那条——**构造期就造**（缺 key 当场报；见函数头注）。**没配缺省就不预造**。 */
  if (defaultProvider !== undefined) gatewayFor(defaultProvider)

  /** 当前选中；`undefined` ＝未切换（走缺省条目、模型名取自请求）。 */
  let selected: ModelSelection | undefined

  /**
   * **缺省那一条的选中**（未切换时走它）——**带上配置里的思考设置**（返修）。
   *
   * 两处共用一份（`current()` 的读数与 `stream()` 的实际去向）：读面说「现在是谁」、
   * 调用真走谁，两者必须是同一份，否则又会出现「设置存了、请求里没有」。
   */
  const defaultSelection = (): ModelSelection | undefined => {
    if (defaultProvider === undefined || defaultEntry?.model === undefined) return undefined
    return {
      provider: defaultProvider,
      model: defaultEntry.model,
      ...(defaultEntry.reasoning === undefined ? {} : { reasoning: defaultEntry.reasoning }),
    }
  }

  return {
    list(): readonly ProviderEntry[] {
      return entries.map(([id, config]) => {
        // 没选过默认模型 —— 窗长无从谈起（那份声明属于「这一条 ＋ 它的模型」两件）
        const window =
          config.model === undefined
            ? undefined
            : resolveContextWindow(config.model, config.contextWindow)
        return {
          id,
          ...(config.model === undefined ? {} : { model: config.model }),
          ...(config.reasoning === undefined ? {} : { reasoning: config.reasoning }),
          // 两处皆无就不给这个位（不拿 0 / 占位符冒充「不知道」）
          ...(window === undefined ? {} : { contextWindow: window }),
        }
      })
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
      })
    },

    windowTable(): WindowTable {
      // 声明**按条目装**（不并进内置表）：条目 id → 它声明的那个模型 ＋ 那个数。
      // 内置表原样转出去（只读）——它按准确模型 id 算，与条目无关。
      const declared: Record<string, { model: string; window: number }> = {}
      for (const [id, config] of entries) {
        // 两件都要有：声明属于「这一条 ＋ 它的模型」——没选过模型就没有「它那个模型」
        if (config.contextWindow !== undefined && config.model !== undefined) {
          declared[id] = { model: config.model, window: config.contextWindow }
        }
      }

      return { builtin: MODEL_CONTEXT_BUILTIN, declared }
    },

    defaultProviderId(): string | undefined {
      return defaultProvider
    },

    selection(): ModelSelection | undefined {
      return selected
    },

    current(): ModelSelection | undefined {
      // 未切换过——缺省连接 ＋ **它的**默认模型（`stream` 那时正是这么走的：请求给的模型名
      // 由装配按缺省连接填）。
      // ⚠️ 缺省连接没配、或它还没选过模型 ⇒ **没有去向**（`undefined`）——那时如实报
      // 「先选模型」，**不取列表第一项顶上**。
      return selected ?? defaultSelection()
    },

    has(id: string): boolean {
      return ownOf(providers, id) !== undefined
    },

    use(request: ModelSwitchRequest): ModelSwitchResult {
      const askedProvider = request.provider?.trim()
      const askedModel = request.model?.trim()
      const requestedReasoning = request.reasoning

      if (askedProvider === undefined && (askedModel === undefined || askedModel.length === 0)) {
        return { ok: false, reason: '既没给 provider 也没给 model——不知道要换成什么' }
      }

      const providerId = askedProvider ?? selected?.provider ?? defaultProvider
      if (providerId === undefined) {
        return { ok: false, reason: '还没有可用的连接——先接入一个供应商' }
      }

      const entry = ownOf(providers, providerId)
      if (entry === undefined) {
        const known = entries.map(([id]) => id).join(' / ') || '（一个都没有）'
        return { ok: false, reason: `未知供应商「${providerId}」——已注册：${known}` }
      }

      const model = askedModel !== undefined && askedModel.length > 0 ? askedModel : entry.model
      // 连接在、模型不在 —— 报「先选模型」，**不挑一个顶上**（设计：不取列表第一项）
      if (model === undefined || model.length === 0) {
        return { ok: false, reason: `连接「${providerId}」还没有默认模型——请指明用哪个模型` }
      }

      // **思考设置随同验证**（设计明文）——做不到就当场说清，**不静默减档**
      const reasoning = checkReasoning(adapterFor(providerId), requestedReasoning)
      if ('reason' in reasoning) return { ok: false, reason: reasoning.reason }

      // **网关在这一步就造**（不是等下一轮调用）——切不过去就该在「切」这一下说清楚：
      // 缺 key 的缘由经 `use` 的返回值交回，而不是拖到下一轮炸在对话域里（那里只会报
      // 「对话域异常」，把人指去错地方）
      try {
        gatewayFor(providerId)
      } catch (error) {
        if (error instanceof MissingApiKeyError) return { ok: false, reason: error.message }
        throw error
      }

      selected = {
        provider: providerId,
        model,
        ...(reasoning.setting === undefined ? {} : { reasoning: reasoning.setting }),
      }
      return { ok: true, selection: selected }
    },

    stream(request: ModelRequest, streamOptions?: ModelStreamOptions): ModelStream {
      const chosen = selected
      if (chosen !== undefined) {
        return gatewayFor(chosen.provider).stream(
          { ...request, model: chosen.model },
          withReasoning(streamOptions, chosen.reasoning),
        )
      }

      // 未切换——缺省连接 ＋ **请求给的模型名**（技术方案 · 配置与密钥：「模型名取自请求」）
      // ＋ **配置里那条默认的思考设置**（返修：此前这一路完全没带设置）。
      // ⚠️ 没配缺省 ⇒ **无处可去**：如实回一轮「这次调用不成立」的流（见 `errorStream`），
      // **不退回某一条看上去顺眼的连接**——那会把「我没选」变成「它替我选了」；
      // 也不抛异常穿层：对话域只该看见模型域的事件。
      if (defaultProvider === undefined) {
        return errorStream(options.stamper, request.model, NO_SELECTION)
      }
      return gatewayFor(defaultProvider).stream(
        request,
        withReasoning(streamOptions, defaultEntry?.reasoning),
      )
    },
  }
}
