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
 * ⚠️ **认证变更与移除不在 `scope` 里**（那里不放凭据或其摘要），故这一半由 **`drop`**
 * 兜住：装配在改地址 / 区域 / 认证与移除连接时都调它，它把该连接**当时在途的那一趟**
 * 一并作废（`voided`）并让出在途位——旧认证的迟到列表不得复活成当前缓存。
 * 跨进程那一半（别的进程手上那条迟到的响应）由缓存端口的**作废记录**兜，见 `app` 的
 * `model-cache.ts`。
 *
 * ⚠️ **`drop` 不该去动盘上已经落定的那份**：那一跳里可能已经有**换过认证的那一趟**
 * 写下的新结果，抹掉它是把别人的东西删了（复核反例二）。作废过的这一趟落定后
 * **什么都不做**——内存由 `drop` 自己清，盘上的事交给作废记录判。
 *
 * ## 域纪律
 *
 * 本文件不碰 fs（缓存持久化走 `ModelInfoCache` 端口）· 不读配置（连接资料由装配给）·
 * 不 import 外壳与装配。
 */

import type {
  ModelCacheAccess,
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
  /**
   * **接入身份**（装配给，形态见 `ModelCacheAccess`）——盘上那份缓存按它隔离存储：
   * 旧身份的迟到写入写的是**它自己那份**，读只认当前身份那份，两边不相遇。
   *
   * **缺省 ＝ 还没有可信身份** ⇒ **不读也不写共享盘**（内存里照常跑）。
   * 过渡期可选只为了让分线各自编译得过，**不等于隔离已完成**。
   */
  readonly access?: ModelCacheAccess | undefined
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
  /** **接入身份**（由装配按认证来源算出）——缺省＝还没有可信身份，不碰共享盘。 */
  readonly access?: ModelCacheAccess | undefined
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

  return {
    id: providerId,
    config,
    baseURL,
    apiKey,
    ...(input.access === undefined ? {} : { access: input.access }),
  }
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
  /**
   * 废弃一条连接的快照（连接移除 / 认证或接入范围改变时由装配调）。
   *
   * **只清当前身份那份**——别的范围（旧认证 / 别的进程）那份留着：它是**可重建的缓存**，
   * 不是当前范围的资料（读到它等于没读到，不为删净它造迁移账）。
   *
   * ⚠️ **异步且会抛**：清除失败要看得见，不吞——调用方（装配）**要 `await` 并接住**，
   * 把「缓存没能清掉」如实写进那次动作的答复。
   */
  drop(providerId: string): Promise<void>
  /** 该连接是否**有自动获取能力**（官方适配）——兼容接入为 `false`。 */
  canFetch(providerId: string): boolean
}

/**
 * 一趟在途获取——`voided` 由 `drop` 落笔：**这一趟的结果已经不要了**。
 *
 * 为什么要有这个位：**认证变更 / 移除不在 `scope` 里**（那里不放凭据或其摘要），
 * 故「落定前比一次范围」挡不住它们——只有 `drop` 知道那一趟该作废。
 */
type InflightFetch = {
  /** 与重复访问共享的那个 promise。 */
  task: Promise<void>
  /** 作废过：落定后不发布、不记失败、不发变更；写盘途中被作废的连盘上那份也抹掉。 */
  voided: boolean
}

/**
 * 内存那份的键——**连接 ＋ 接入身份**（与盘上文件名同一套隔离）。
 *
 * 用**长度前缀**拼，不用分隔符：连接 id 与身份都是用户侧可出现的自由文本（可能含空格、
 * 冒号、换行），拿任何一个字符当分隔都能被构造出歧义；`<长度>:<连接>:<身份>` 拼不出来。
 */
function snapshotKeyOf(providerId: string, accessId: string | undefined): string {
  return `${providerId.length}:${providerId}:${accessId ?? ''}`
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

/**
 * 失败缘由——**说给人听**，且**脱敏**（凭据不出现在任何文案里）。
 *
 * ⚠️ 这句话会进事件与记录，而异常文字常常整段带上请求头（`Authorization: Bearer sk-…`）：
 * 故把**这次请求用过的那几把凭据**从文案里抹掉。只知道什么就抹什么，不猜、不扩大——
 * 抹多了会把「网络断了」也认成敏感（那正是另一头要守住的）。
 */
function describeFailure(error: unknown, secrets: readonly (string | undefined)[] = []): string {
  let reason = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) continue
    reason = reason.split(secret).join('***')
  }
  return reason.length === 0 ? '未知原因' : reason
}

export function createModelInfoService(options: ModelInfoServiceOptions): ModelInfoService {
  const ttlMs = options.ttlMs ?? MODEL_INFO_TTL_MS
  const cooldownMs = options.cooldownMs ?? MODEL_INFO_FAILURE_COOLDOWN_MS

  /**
   * 内存里那一份（`warmup` 从缓存文件读回，刷新后替换）——**按「连接 ＋ 接入身份」存**，
   * 与盘上同一把尺子（见 `snapshotKeyOf`）。
   *
   * 为什么不能只按连接存：连接被**外部**改过（认证/地址变了）之后，旧那份仍处在有效期内，
   * `read` 会把它当当前列表端出去——「连接变更后首次读取不得展示修改前的新鲜缓存」。
   * 身份进了键，旧那份**取不到就等于没有**，不必另记一本「谁是谁」的账。
   */
  const snapshots = new Map<string, ModelInfoSnapshot>()
  /** 最近一次失败的缘由与时刻——**不清缓存**，只多记这一笔。 */
  const failures = new Map<string, { at: number; reason: string }>()
  /** 在途获取——同一连接同一进程**只跑一趟**（重复访问共用它）。 */
  const inflight = new Map<string, InflightFetch>()

  const connectionOf = (providerId: string): ModelConnection | undefined =>
    options.connections().find((one) => one.id === providerId)

  const readOf = (providerId: string): ModelInfoRead => {
    const snapshot = snapshots.get(snapshotKeyOf(providerId, connectionOf(providerId)?.access?.id))
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

    const snapshot = snapshots.get(snapshotKeyOf(providerId, connectionOf(providerId)?.access?.id))
    return snapshot === undefined || options.now() - snapshot.fetchedAt > ttlMs
  }

  /**
   * 取一趟（内部）——**同一连接只跑一趟**：在途时返回同一个 Promise。
   *
   * 失败**只记一笔**（`failures`），旧快照原样留着——设计：「网络失败、限流、鉴权失败
   * 不清空旧缓存」。且取不到不等于生成服务不可用：调用照旧走原路径。
   */
  function fetchOnce(connection: ModelConnection): Promise<void> {
    const id = connection.id
    const running = inflight.get(id)
    if (running !== undefined) return running.task

    const entry: InflightFetch = { task: Promise.resolve(), voided: false }

    const task = (async () => {
      const adapter = adapterOf(connection.config)
      // 兼容接入没有自动列表能力——**不发请求**，也不报错（设计：不假称已支持）
      if (adapter === undefined) return

      const scope = scopeOf(adapter, connection.baseURL)
      // **获取时捕获该身份**：发布前拿它跟**现取的**核一次——这一趟用的是哪份接入，
      // 只有发起时那个连接资料说得准
      const access = connection.access
      if (connection.apiKey === undefined || connection.apiKey.length === 0) {
        // 缺认证＝取不了：**照样记一笔失败**（用户该知道这条为什么一直空着）
        failures.set(id, { at: options.now(), reason: '这条连接没有可用的认证' })
        options.onChange?.(id)
        return
      }

      try {
        const listed = await adapter.listModels({
          providerId: id,
          baseURL: connection.baseURL,
          apiKey: connection.apiKey,
          fetch: options.fetch,
        })

        // **整趟作废**（认证 / 移除那一类变化）：不在 `scope` 里，比范围挡不住
        if (entry.voided) return

        // **迟到结果不得重新发布**：这一次取的是哪个范围 / 哪个接入身份，落定前**再核一次现取的**——
        // 中间用户改了地址、换了认证、或配置被改过，这份就作废（旧范围的列表不是当前的）
        const current = connectionOf(id)
        const currentScope =
          current === undefined
            ? undefined
            : (() => {
                const now = adapterOf(current.config)
                return now === undefined ? undefined : scopeOf(now, current.baseURL)
              })()

        if (currentScope !== scope) return
        if (current?.access?.id !== access?.id) return

        const snapshot: ModelInfoSnapshot = {
          provider: id,
          scope,
          // **成功取得的时刻**（设计原义）——不是发起时刻，也不拿它冒充有效范围
          fetchedAt: options.now(),
          // 补充在**归一之后**：API 给了的字段一律不覆盖（补充排在它之后）
          models: listed.map((info) => adapter.supplement(info)),
        }

        snapshots.set(snapshotKeyOf(id, access?.id), snapshot)
        failures.delete(id)
        // **没有可信身份就不写共享盘**：内存里那份照常发布，盘上一份不动
        if (access !== undefined) await options.cache.replace(snapshot, access)

        // 这一跳里被 `drop` 了（发布内存与写完盘之间有个 await）⇒ **什么都不做**。
        // 盘上那份该不该留**不归这一趟判**：它可能已经是换过认证的那一趟写下的新结果，
        // 抹掉它就是把别人的东西删了（复核反例二）。该不该作废由作废记录判，见缓存端口
        if (entry.voided) return

        options.onChange?.(id)
      } catch (error) {
        // 作废过的那趟**失败也不算数**：那是旧认证的实况，不是这条连接现在的
        if (entry.voided) return
        failures.set(id, { at: options.now(), reason: describeFailure(error, [connection.apiKey]) })
        options.onChange?.(id)
      }
    })().finally(() => {
      // 只让出**自己的**位子——`drop` 之后可能已经又起了一趟
      if (inflight.get(id) === entry) inflight.delete(id)
    })

    entry.task = task
    inflight.set(id, entry)
    return task
  }

  return {
    async warmup(): Promise<void> {
      for (const connection of options.connections()) {
        // **无可信身份不读共享盘**（内存里照常跑；过渡期可选只为分线编译，不等于隔离已完成）
        if (connection.access === undefined) continue

        const stored = await options.cache.read(connection.id, connection.access)
        if (stored === undefined) continue

        // **核范围**：盘上那份说的是不是这条连接**现在这个范围**——
        // 不是就不接纳（设计：认证或接入范围改变时废弃该连接的旧缓存）。
        // 上一轮改了地址却没删成的（跨进程改的 / 上次崩在删之前），在这里挡住
        const adapter = adapterOf(connection.config)
        if (adapter === undefined) continue
        if (stored.scope !== scopeOf(adapter, connection.baseURL)) continue

        snapshots.set(snapshotKeyOf(connection.id, connection.access.id), stored)
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

    async drop(providerId: string): Promise<void> {
      const access = connectionOf(providerId)?.access
      // **只清当前身份那份**（内存与盘同一把尺子）：旧身份那些留着——读到它们等于没读到
      snapshots.delete(snapshotKeyOf(providerId, access?.id))
      failures.delete(providerId)

      // 在途的那一趟**一并作废，并让出在途位**。作废是必须的：认证变更不在 `scope` 里
      // （那里不放凭据），它落定时比范围比不出自己已经过时；让位是为了用户改完认证
      // 立刻看列表时，新的一趟不必等旧那趟先跑完一趟（多半还是白跑）
      const running = inflight.get(providerId)
      if (running !== undefined) {
        running.voided = true
        inflight.delete(providerId)
      }

      // **盘上同理**（上面那行清的是内存那份）：别的范围（旧认证 / 别的进程）那份留着，
      // 它是可重建的缓存、不是当前范围的资料
      if (access !== undefined) await options.cache.drop(providerId, access)
    },

    canFetch(providerId: string): boolean {
      const connection = connectionOf(providerId)
      return connection !== undefined && adapterOf(connection.config) !== undefined
    },
  }
}
