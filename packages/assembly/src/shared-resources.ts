/** 共享资源编排 —— 装配的**资源构造域**（从 index.ts 按职责拆出，行为不变）。
 *
 * 拆出的那一份职责：执行环境（network / environment / fetch / 生命周期信号）、执行域资源
 * （ledger / backgroundRuns / sandbox）、外部服务器（mcp）、发现面（projectRules / skills /
 * materials）、记录连接（recordsStore）与控制广播（hub / sink）的**构造与接线**。
 * 会话链管理、目录命令与装配产物形状仍归 index.ts——本域经 `SharedResourcesDeps`
 * 拿到它们的输入，经返回值交出全部把手。
 */
import type {
  EventKind,
  EventSink,
  MagicHome,
  ProcessLedger,
  WorkspaceService,
} from '@magic/contracts'
import { TRANSIENT_EVENT_KINDS } from '@magic/contracts'
import { createControlHub } from '@magic/transport'
import type { WorkEnvironment } from '@magic/host'
import { createWorkEnvironment } from '@magic/host'
import type { LoadedConfig } from '@magic/state'
import type { RecordsStore } from '@magic/data'
import { createRecordsStore } from '@magic/data'
import type { FetchLike } from '@magic/model'
import type { McpServers } from '@magic/mcp'
import { createMcpServers } from '@magic/mcp'
import type { ToolDefinition } from '@magic/tools'
import { defineMcpTools } from '@magic/tools'
import {
  createBackgroundRuns,
  type BackgroundRegistry,
  createBunProcessPort,
  createMaterials,
  createProcessLedger,
  createProjectRules,
  createSandbox,
  createSkills,
} from '@magic/resources'
import { tmpdir } from 'node:os'
import { backgroundOutputDirOf, runPathsOf } from '@magic/host'

/** 瞬时类不落库（契约 `TRANSIENT_EVENT_KINDS`——记录 schema v0 规则 ①）。 */
const TRANSIENT: ReadonlySet<EventKind> = new Set(TRANSIENT_EVENT_KINDS)

/** 共享资源编排的依赖束——显式列出，不隐式持装配上下文。 */
export type SharedResourcesDeps = {
  /** 入参的相关字段（一切「从外面拿的」仍经 options 进来）。 */
  readonly options: {
    readonly ledger?: ProcessLedger
    readonly environment?: Readonly<Record<string, string>>
    readonly network?: WorkEnvironment
    readonly signal?: AbortSignal
    readonly records?: RecordsStore
    readonly modelFetch?: FetchLike | undefined
    readonly executionId?: string | undefined
    readonly mcpTimeouts?:
    | { readonly connectTimeoutMs?: number; readonly callTimeoutMs?: number }
    | undefined
  }
  readonly magic: MagicHome
  readonly loaded: LoadedConfig
  /** 工作区（由 index 按 savedAgent 判定后交进来；资源构造共用它）。 */
  readonly workspace: WorkspaceService
  /** 持久身份——咨询成员不接 MCP 服务器（成员自足，不共享宿主的外部连接表）。 */
  readonly savedAgent?: { readonly purpose?: 'consultation' } | undefined
  /** 控制广播出错的上抛口——由 index 接线（要引用会话链域的 chain 与 sink）。 */
  readonly onHubError: (error: unknown) => void
}

export type SharedResources = {
  readonly network: WorkEnvironment
  readonly environment: Readonly<Record<string, string>>
  readonly fetch: FetchLike
  readonly lifetime: AbortController
  readonly signal: AbortSignal
  readonly ledger: ProcessLedger
  readonly backgroundRuns: BackgroundRegistry | undefined
  readonly sandbox: ReturnType<typeof createSandbox>
  readonly mcp: McpServers
  readonly mcpTools: () => readonly ToolDefinition[]
  readonly projectRules: ReturnType<typeof createProjectRules>
  readonly skills: ReturnType<typeof createSkills>
  readonly materials: ReturnType<typeof createMaterials>
  readonly recordsStore: RecordsStore
  readonly hub: ReturnType<typeof createControlHub>
  readonly sink: EventSink
}

export function createSharedResources(deps: SharedResourcesDeps): SharedResources {
  const { options, magic, loaded, workspace } = deps

  // 入口拥有位置选择权；装配与下游共用传入结果。
  const network = options.network ?? createWorkEnvironment(options.environment ?? process.env)
  const environment = network.env
  const fetch: FetchLike = (input, init) => (options.modelFetch ?? network.fetch)(input, { ...init, signal: init?.signal == null ? signal : AbortSignal.any([signal, init.signal]) })
  const lifetime = new AbortController()
  const signal = options.signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, options.signal])

  const ledger = options.ledger ?? createProcessLedger()

  const executionId = options.executionId ?? crypto.randomUUID()
  const backgroundDir = ((): string | undefined => {
    try {
      return `${backgroundOutputDirOf(runPathsOf(magic, tmpdir()))}/${executionId}`
    } catch {
      return undefined
    }
  })()

  const backgroundRuns: BackgroundRegistry | undefined =
    backgroundDir === undefined
      ? undefined
      : createBackgroundRuns({ dir: backgroundDir, workspace, ledger, env: environment, signal, ...(environment['SHELL'] === undefined ? {} : { shell: environment['SHELL'] }) })

  const sandbox = createSandbox({
    env: environment,
    workspace,
    ledger,
    ...(environment['SHELL'] === undefined ? {} : { shell: environment['SHELL'] }),
  })

  const mcp: McpServers = createMcpServers({
    environment, cwd: workspace.defaultRoot(), signal, fetch: network.fetch,
    process: createBunProcessPort(),
    servers: deps.savedAgent?.purpose === 'consultation' ? {} : loaded.config.mcp?.servers ?? {},
    ledger,
    ...(options.mcpTimeouts?.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.mcpTimeouts.connectTimeoutMs }),
    ...(options.mcpTimeouts?.callTimeoutMs === undefined
      ? {}
      : { callTimeoutMs: options.mcpTimeouts.callTimeoutMs }),
  })

  const mcpTools = (): readonly ToolDefinition[] =>
    mcp.connections.flatMap((connection) => [...defineMcpTools(connection)])

  const projectRules = createProjectRules({
    signal,
    workspace,
    sources: loaded.config.rules?.sources ?? [],
    // 两张名册两件事（契约 `RulesConfig`）：`sources` 读进来，`linkSources` 只放行链接
    linkSources: loaded.config.rules?.linkSources ?? [],
  })

  const skills = createSkills({
    signal,
    workspace,
    magicBase: magic.base,
    home: magic.home,
    sources: loaded.config.skills?.sources ?? [],
  })

  const materials = createMaterials({ workspace })

  const recordsStore = options.records?.forWorkspace(workspace.roots()) ?? createRecordsStore({
    dataDir: magic.base,
    workspace: workspace.roots(),
  })

  // 所有会话共享控制广播与记录连接；信封仍由各自的铸造器生成。
  const hub = createControlHub(deps.onHubError)
  const sink: EventSink = {
    emit(event) {
      // ① 控制广播**全部**（含瞬时增量——渲染要实时）
      //    先广播后落库：反过来的话，落库一炸（载荷非 JSON 等）就是外壳**静默**漏事件
      //    ——比如一条裁决询问没显示出来，用户永远等不到提示。丢持久可查、丢渲染会挂。
      hub.emit(event)
      if (!TRANSIENT.has(event.kind)) recordsStore.appendEvent(event)
    },
  }

  return {
    network, environment, fetch, lifetime, signal, ledger, backgroundRuns,
    sandbox, mcp, mcpTools, projectRules, skills, materials, recordsStore, hub, sink,
  }
}
