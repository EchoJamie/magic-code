/**
 * 模型信息 —— 缓存与时效策略（U41）。
 *
 * 出处：设计 · 模型与上下文「模型信息获取与缓存」。
 *
 * **一个来源、一份可替换副本**：模型是否被供应商列出，以该连接**成功取得的完整列表**为准；
 * 本地那份是可重建的缓存，不是权威目录。
 *
 * ## 时序（设计逐条落地）
 *
 * - **有效期 24 小时**（`ttlMs`）——新鲜就直接用；
 * - **过期先回旧缓存**，同时在后台取一趟（用户不必等）；
 * - **同一连接同一进程只共享一次在途获取**（`inflight`）——重复访问不产生请求风暴；
 * - **无常驻轮询**：只有「读一次」「显式刷新」两种触发，没有定时器；
 * - **失败后至少隔 60 秒**（`cooldownMs`）才允许下一次**自动**重试——不自行循环重试；
 * - **失败不清空旧缓存**：旧快照照旧可用，失败缘由与时刻另记（`failure`）；
 * - **手动刷新绕开时效与冷却**（那是用户明确的要求，不是自动重试）。
 *
 * ## 范围与迟到结果
 *
 * 缓存按**接入范围**（`scope`）隔离——范围标识由连接与适配给（适配名 ＋ 地址），
 * **不含密钥**（设计明文：不用密钥或密钥摘要作文件名 / 缓存标识）。
 * 范围一变，旧快照即刻作废；**先发起、后到达**的旧范围结果不得重新发布
 * （落定前比一次当时的范围，见 `fetchOnce`）。
 *
 * ## 域纪律
 *
 * 本文件不碰 fs（缓存持久化走 `ModelInfoCache` 端口）· 不读配置（连接资料由装配给）·
 * 不 import 外壳与装配。
 */

import type {
  ModelInfoCache,
  ModelInfoRead,
  ModelInfoSnapshot,
  ProviderConfig,
} from '@magic/contracts'
import type { FetchLike } from './ai-sdk.ts'
import { resolveApiKey } from './gateway.ts'
import { vendorOf } from './vendors.ts'
import type { VendorAdapter } from './vendors.ts'

/** 默认有效期——24 小时（设计：默认有效期 24 小时）。 */
export const MODEL_INFO_TTL_MS = 24 * 60 * 60 * 1000

/** 失败后的冷却——自动重试至少隔 60 秒（设计：不自行循环重试）。 */
export const MODEL_INFO_FAILURE_COOLDOWN_MS = 60 * 1000

/**
 * 一条连接的**运行时资料**——装配给的（配置 + 已解析的地址与凭据）。
 *
 * 凭据在这一层是必要的（发请求要用它），但**它只向下流**：产出的快照、失败缘由、
 * 缓存文件里都没有它。
 */
export type ModelConnection = {
  readonly id: string
  readonly config: ProviderConfig
  /** 已解析的基址（官方适配按区域给 / 兼容接入用配置里那个）。 */
  readonly baseURL: string
  /** 缺失时**不发请求**：如实报「这条连接没有可用认证」。 */
  readonly apiKey?: string | undefined
}

/**
 * 把配置里的一条连接解析成**运行时资料**（U41）——地址按适配、凭据按既有次序。
 *
 * 装配要它，是因为**模型信息获取也要连接资料**，而适配细节不出域
 * （`VendorAdapter` 是域内件——装配只见 `ProviderConfig.vendor` 这个名字）。
 *
 * ⚠️ **缺凭据不抛**：取列表那条路要的是一句「这条取不了」的缘由，
 * 不是启动期的异常（`MissingApiKeyError` 管的是**调用**那条路，两者各司其职）。
 */
export function resolveConnection(input: {
  readonly providerId: string
  readonly config: ProviderConfig
  /** 显式注入（测试用）——优先于配置与环境变量。 */
  readonly explicitApiKey?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}): ModelConnection {
  const { providerId, config } = input
  const adapter = config.vendor === undefined ? undefined : vendorOf(config.vendor)

  // 地址：官方适配按区域给；兼容接入用配置里那个。都没有就空串——
  // 「没有地址」的报错留给调用那条路（`gateway.ts` 启动期一声响），这里如实空着
  const baseURL =
    adapter === undefined ? (config.baseURL ?? '') : (adapter.baseURLOf(config) ?? '')

  let apiKey: string | undefined
  try {
    apiKey = resolveApiKey({
      providerId,
      config,
      explicit: input.explicitApiKey,
      env: input.env ?? process.env,
    })
  } catch {
    apiKey = undefined
  }

  return { id: providerId, config, baseURL, apiKey }
}

export type ModelInfoServiceOptions = {
  /** 连接一览——**每次现取**（配置可能被改；快照它会让改完的连接认不出）。 */
  readonly connections: () => readonly ModelConnection[]
  /** 缓存持久化端口（实现归装配）。 */
  readonly cache: ModelInfoCache
  /** 注入用 fetch（测试：假端点回放 JSON，不经网络）。 */
  readonly fetch: FetchLike
  /** 当下时刻（毫秒）——注入用（测试要控制「过没过期」）。 */
  readonly now: () => number
  /** 有效期——缺省 `MODEL_INFO_TTL_MS`。 */
  readonly ttlMs?: number | undefined
  /** 失败冷却——缺省 `MODEL_INFO_FAILURE_COOLDOWN_MS`。 */
  readonly cooldownMs?: number | undefined
  /**
   * **有变化**（取到新列表 / 这次没取成）——装配据此**再发一条 `model.catalog`**，
   * 界面那一屏随之刷新。不伪装成用户输入、也不插入提示词。
   */
  readonly onChange?: ((providerId: string) => void) | undefined
}

/** 模型信息面——装配与外壳经它读；**刷新是显式动作**，不藏在读里。 */
export type ModelInfoService = {
  /** 启动预热：把缓存文件读回内存（缺文件 / 损坏都只是「还没有」，不是错）。 */
  warmup(): Promise<void>
  /**
   * 读一次——**同步**（读面答复不能等 IO）。
   *
   * 副作用有一条，且是设计要求的：**过期或无缓存**时在这里发起一次**后台**获取
   * （不 await、不阻塞答复）。在途共享与失败冷却会挡住重复请求。
   */
  read(providerId: string): ModelInfoRead
  /** **显式刷新**——绕开时效与冷却；返回这次之后的读数（成败都在里面）。 */
  refresh(providerId: string): Promise<ModelInfoRead>
  /** 废弃一条连接的快照（连接移除 / 认证或接入范围改变时由装配调）。 */
  drop(providerId: string): void
  /** 该连接是否**有自动获取能力**（官方适配）——兼容接入为 `false`。 */
  canFetch(providerId: string): boolean
}

/** 一条连接该走哪个适配——没 `vendor` ＝兼容接入（没有自动列表能力）。 */
function adapterOf(config: ProviderConfig): VendorAdapter | undefined {
  if (config.vendor === undefined) return undefined
  return vendorOf(config.vendor)
}

/**
 * 接入范围标识——适配名 ＋ 地址（**不含密钥**）。
 *
 * 它管的是「这份列表说的是哪个范围」：换了供应商或换了地址就是另一个范围，
 * 旧快照即刻作废。`baseURL` 为空串的历史写法也照收（那仍是一个明确的取值）。
 */
function scopeOf(adapter: VendorAdapter, baseURL: string): string {
  return `${adapter.id}@${baseURL}`
}

/** 失败缘由——**说给人听**，且**脱敏**（凭据不出现在任何文案里）。 */
function describeFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  return reason.length === 0 ? '未知原因' : reason
}

export function createModelInfoService(options: ModelInfoServiceOptions): ModelInfoService {
  const ttlMs = options.ttlMs ?? MODEL_INFO_TTL_MS
  const cooldownMs = options.cooldownMs ?? MODEL_INFO_FAILURE_COOLDOWN_MS

  /** 内存里的那一份（`warmup` 从缓存文件读回，刷新后替换）。 */
  const snapshots = new Map<string, ModelInfoSnapshot>()
  /** 最近一次失败的缘由与时刻——**不清缓存**，只多记这一笔。 */
  const failures = new Map<string, { at: number; reason: string }>()
  /** 在途获取——同一连接同一进程**只跑一趟**（重复访问共用它）。 */
  const inflight = new Map<string, Promise<void>>()

  const connectionOf = (providerId: string): ModelConnection | undefined =>
    options.connections().find((one) => one.id === providerId)

  const readOf = (providerId: string): ModelInfoRead => {
    const snapshot = snapshots.get(providerId)
    const failure = failures.get(providerId)
    const refreshing = inflight.has(providerId)

    return {
      ...(snapshot === undefined ? {} : { snapshot }),
      // 新鲜度只在**有快照**时才有意义（没有快照时那一位的意义是「还没取过」）
      ...(snapshot === undefined
        ? {}
        : { stale: options.now() - snapshot.fetchedAt > ttlMs }),
      ...(refreshing ? { refreshing: true } : {}),
      ...(failure === undefined ? {} : { failure }),
    }
  }

  /** 该不该**自动**取一趟：没在途、不在冷却里，且（没缓存 或 过期）。 */
  const shouldRefresh = (providerId: string): boolean => {
    if (inflight.has(providerId)) return false

    const failure = failures.get(providerId)
    if (failure !== undefined && options.now() - failure.at < cooldownMs) return false

    const snapshot = snapshots.get(providerId)
    return snapshot === undefined || options.now() - snapshot.fetchedAt > ttlMs
  }

  /**
   * 取一趟（内部）——**同一连接只跑一趟**：在途时返回同一个 Promise。
   *
   * 失败**只记一笔**（`failures`），旧快照原样留着——设计：「网络失败、限流、鉴权失败
   * 不清空旧缓存」。且取不到不等于生成服务不可用：调用照旧走原路径。
   */
  function fetchOnce(connection: ModelConnection): Promise<void> {
    const running = inflight.get(connection.id)
    if (running !== undefined) return running

    const task = (async () => {
      const adapter = adapterOf(connection.config)
      // 兼容接入没有自动列表能力——**不发请求**，也不报错（设计：不假称已支持）
      if (adapter === undefined) return

      const scope = scopeOf(adapter, connection.baseURL)
      if (connection.apiKey === undefined || connection.apiKey.length === 0) {
        // 缺认证＝取不了：**照样记一笔失败**（用户该知道这条为什么一直空着）
        failures.set(connection.id, { at: options.now(), reason: '这条连接没有可用的认证' })
        options.onChange?.(connection.id)
        return
      }

      try {
        const listed = await adapter.listModels({
          providerId: connection.id,
          baseURL: connection.baseURL,
          apiKey: connection.apiKey,
          fetch: options.fetch,
        })

        // **迟到结果不得重新发布**：这一次取的是哪个范围，落定前再比一次——
        // 中间用户改了地址 / 换了供应商，这份就作废（旧范围的列表不是当前的）
        const current = connectionOf(connection.id)
        const currentScope =
          current === undefined
            ? undefined
            : (() => {
                const now = adapterOf(current.config)
                return now === undefined ? undefined : scopeOf(now, current.baseURL)
              })()

        if (currentScope !== scope) return

        const snapshot: ModelInfoSnapshot = {
          provider: connection.id,
          scope,
          fetchedAt: options.now(),
          // 补充在**归一之后**：API 给了的字段一律不覆盖（补充排在它之后）
          models: listed.map((info) => adapter.supplement(info)),
        }

        snapshots.set(connection.id, snapshot)
        failures.delete(connection.id)
        await options.cache.replace(snapshot)
        options.onChange?.(connection.id)
      } catch (error) {
        failures.set(connection.id, { at: options.now(), reason: describeFailure(error) })
        options.onChange?.(connection.id)
      }
    })().finally(() => {
      inflight.delete(connection.id)
    })

    inflight.set(connection.id, task)
    return task
  }

  return {
    async warmup(): Promise<void> {
      for (const connection of options.connections()) {
        const stored = await options.cache.read(connection.id)
        if (stored !== undefined) snapshots.set(connection.id, stored)
      }
    },

    read(providerId: string): ModelInfoRead {
      const connection = connectionOf(providerId)
      if (connection !== undefined && adapterOf(connection.config) !== undefined) {
        if (shouldRefresh(providerId)) {
          // **后台**取——读面不等它（设计：过期先回旧缓存，后台刷新）
          void fetchOnce(connection)
        }
      }
      return readOf(providerId)
    },

    async refresh(providerId: string): Promise<ModelInfoRead> {
      const connection = connectionOf(providerId)
      if (connection === undefined) return readOf(providerId)

      const adapter = adapterOf(connection.config)
      // 兼容接入 / 未知连接：没有可刷的——如实回一句（缘由由读面的 `vendor` 缺席说）
      if (adapter === undefined) return readOf(providerId)

      failures.delete(providerId)
      await fetchOnce(connection)
      return readOf(providerId)
    },

    drop(providerId: string): void {
      snapshots.delete(providerId)
      failures.delete(providerId)
      // 在途的那一趟会在落定时比对范围（它读的是当时那份连接资料）——
      // 缓存文件由装配在范围变更处一并删（`cache.drop`），此处只管内存
    },

    canFetch(providerId: string): boolean {
      const connection = connectionOf(providerId)
      return connection !== undefined && adapterOf(connection.config) !== undefined
    },
  }
}
