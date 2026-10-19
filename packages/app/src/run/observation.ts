import type { MagicConfig, McpConnection, RulesProblem } from '@magic/contracts'
import type { RuleProblem } from '@magic/permission'
/** 常驻核心的只读控制面：只取配置、目录、缓存和记录，不装配执行者或连接外部服务。 */
import type {
  Command,
  DecisionHistory,
  EventDataOf,
  EventKind,
  KernelEvent,
  MagicHome,
  Materials,
  McpCatalogRow,
  ModelCatalogRow,
  ModelInfoRead,
  ModelSelectionRef,
  ModelSwitchRequest,
  ProviderConfig,
  SkillCatalog,
  WorkspaceService,
} from '@magic/contracts'
import { GRANTS_FILE_NAME, apiKeyEnvVarOf } from '@magic/contracts'
import { DEFAULT_CANDIDATES, createMaterials, createSkills, createWorkspaceService } from '@magic/execution'
import type { ModelInfoService } from '@magic/model'
import {
  createModelInfoService,
  effectiveReasoningSupportOf,
  modelSpecOf,
  resolveConnection,
  vendorCatalog,
} from '@magic/model'
import { createGrantLedger } from '@magic/permission'
import type { RecordsStore } from '@magic/records'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveModelChoice } from '../agent-models.ts'
import { cacheAccessFor } from '../cache-access.ts'
import { ConfigError, loadConfig, type LoadedConfig } from '@magic/config'
import { loadGrants } from '../grants-file.ts'
import { createFileModelInfoCache } from '../model-cache.ts'
import { createModelsDevResource } from '../models-dev-resource.ts'

export function workspaceOf(loaded: LoadedConfig, cwd: string): WorkspaceService {
  try {
    return createWorkspaceService({ roots: loaded.config.workspaceRoots ?? [cwd] })
  } catch (error) {
    throw new ConfigError(loaded.path, error instanceof Error ? error.message : String(error))
  }
}

/** assembly 与观察面共用投影；调用者提供真实内存读数或纯缓存读数。 */
export type ModelCatalogReader = {
  readonly describe?: ModelInfoService['describe']
  readonly providers: Readonly<Record<string, ProviderConfig>>
  readonly configuredModels?: MagicConfig['models']
  readonly entries: readonly { readonly id: string; readonly model?: string }[]
  readonly current?: ModelSelectionRef
  readonly read: (provider: string) => ModelInfoRead
  readonly inputBudget: (provider: string, model: string) => number | undefined
  readonly env?: Readonly<Record<string, string | undefined>>
}

export function modelCatalogRows(reader: ModelCatalogReader): readonly ModelCatalogRow[] {
  return reader.entries.map((entry) => {
    const config = reader.providers[entry.id]
    const fromEnv = (reader.env ?? process.env)[apiKeyEnvVarOf(entry.id)]
    const keySource = config?.auth === 'none' ? 'none' : config?.apiKey?.trim() ? 'config' : fromEnv?.trim() ? 'env' : undefined
    const budget = entry.model === undefined ? undefined : reader.inputBudget(entry.id, entry.model)
    const cache = reader.read(entry.id)
    const modelIds = new Set([
      ...(cache.snapshot?.models.map(model => model.id) ?? []), ...Object.keys(config?.modelOverrides ?? {}),
      ...Object.values(reader.configuredModels ?? {}).filter(mapping => mapping.provider === entry.id).map(mapping => mapping.model),
      ...(reader.current?.provider === entry.id ? [reader.current.model] : []),
    ])
    const described = reader.describe?.(entry.id, [...modelIds])
    const effectiveReasoning = Object.fromEntries([...modelIds].flatMap(model => {
      if (config === undefined) return []
      const effective = reader.current?.provider === entry.id && reader.current.model === model
        ? { ...config, protocol: reader.current.protocol } : config
      const known = described?.modelInfo && Object.hasOwn(described.modelInfo, model) ? described.modelInfo[model] : cache.snapshot?.models.find(info => info.id === model)
      const support = effectiveReasoningSupportOf(effective, model, known)
      return support === undefined ? [] : [[model, support]]
    }))
    return {
      provider: entry.id,
      ...described,
      ...(Object.keys(effectiveReasoning).length === 0 ? {} : { effectiveReasoning }),
      ...(config?.name === undefined ? {} : { name: config.name }),
      ...(config?.vendor === undefined ? {} : { vendor: config.vendor }),
      ...(config?.region === undefined ? {} : { region: config.region }),
      ...(config?.baseURL === undefined ? {} : { baseURL: config.baseURL }),
      ...(config?.protocol === undefined ? {} : { protocol: config.protocol }),
      ...(config?.auth === undefined ? {} : { auth: config.auth }),
      ...(config?.modelOverrides === undefined ? {} : { modelOverrides: config.modelOverrides }),
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ...(keySource === undefined ? {} : { keySource }),
      ...(budget === undefined ? {} : { contextWindow: budget }),
      ...(Object.keys(cache).length === 0 ? {} : { cache }),
    }
  })
}

export function modelCatalog(reader: ModelCatalogReader, configuredModels?: NonNullable<MagicConfig['models']>): EventDataOf['model.catalog'] {
  const current = reader.current
  const budget = current === undefined ? undefined : reader.inputBudget(current.provider, current.model)
  return {
    entries: modelCatalogRows(reader),
    ...(current === undefined ? {} : { current }),
    ...(budget === undefined ? {} : { currentInputBudget: budget }),
    ...(configuredModels === undefined ? {} : { configuredModels }),
  }
}

export function providerCatalog(reader: ModelCatalogReader, note?: string): EventDataOf['provider.catalog'] {
  return { entries: modelCatalogRows(reader), vendors: vendorCatalog(), ...(note === undefined ? {} : { note }) }
}

export function skillsCatalog(found: SkillCatalog): EventDataOf['skills.catalog'] {
  return {
    skills: found.skills.map(({ name, description, path, label, source, origin }) => ({ name, description, path, label, source, origin })),
    problems: found.problems.map(({ path, message, kind }) => ({ path, message, kind })),
  }
}

export async function pathsCatalog(materials: Materials, query: string): Promise<EventDataOf['paths.catalog']> {
  const found = await materials.candidates(query, DEFAULT_CANDIDATES)
  return {
    query,
    rows: found.rows.map(({ path, display, kind, external }) => ({ path, display, kind, external })),
    ...(found.note === undefined ? {} : { note: found.note }),
  }
}

export function grantsCatalog(
  view: Pick<EventDataOf['grants.catalog'], 'workspace' | 'grants' | 'stale'>,
  decisions: EventDataOf['grants.catalog']['decisions'],
  history: DecisionHistory,
  ...notes: readonly (string | undefined)[]
): EventDataOf['grants.catalog'] {
  const note = notes.filter((line): line is string => line !== undefined).join('；')
  return { ...view, decisions, history, ...(note === '' ? {} : { note }) }
}

export function grantsTrouble(path: string, unreadable?: string): string | undefined {
  return unreadable === undefined ? undefined : `授权文件读不懂——${path}：${unreadable}` +
    '。本次一条都没加载，也不改动这个文件；改对之后，下次启动就恢复'
}

export function mcpCatalog(servers: readonly McpCatalogRow[], note?: string): EventDataOf['mcp.catalog'] {
  return { servers, ...(note === undefined ? {} : { note }) }
}

export type ObservationContext = {
  readonly magic: MagicHome
  readonly cwd: string
  readonly store: Pick<RecordsStore, 'readEntries' | 'blobs' | 'listSessions' | 'decisionHistory'>
  readonly session?: string | null
  /** 无执行者时保存的明确模型选择；缺省读配置默认，不构造注册表。 */
  readonly selection?: ModelSelectionRef
  readonly switch?: ModelSwitchRequest
  /** 管理者的预检原始目录，不在查询时连接 MCP。 */
  readonly mcp: readonly McpCatalogRow[]
  readonly now?: () => number
}

const READ_COMMANDS = new Set<Command['type']>([
  'model.list', 'provider.list', 'skills.list', 'paths.list', 'grants.list', 'mcp.list',
])

/** undefined 只表示这不是本出口处理的只读命令；读取失败抛出具体错误，由管理者回报。 */
export async function query(command: Command, context: ObservationContext): Promise<KernelEvent | undefined> {
  if (!READ_COMMANDS.has(command.type)) return undefined
  const now = context.now ?? Date.now
  const stamp = <K extends EventKind>(kind: K, data: EventDataOf[K]): KernelEvent => ({
    id: 0, session: context.session ?? '', turn: null, at: now(), kind, data,
  }) as KernelEvent
  if (command.type === 'mcp.list') return stamp('mcp.catalog', mcpCatalog(context.mcp))

  const loaded = loadConfig({ magic: context.magic })
  if (command.type === 'model.list' || command.type === 'provider.list') {
    const reader = await readModelCatalog(loaded, context.magic, context.selection, context.switch, now)
    return command.type === 'model.list'
      ? stamp('model.catalog', modelCatalog(reader, loaded.config.models))
      : stamp('provider.catalog', providerCatalog(reader))
  }

  // 观察已选会话时沿用记录归属；空白窗口使用当前工作区配置。
  const saved = context.session == null ? undefined : (await context.store.listSessions()).find((row) => row.id === context.session)?.workspace
  const workspace = saved === undefined ? workspaceOf(loaded, context.cwd) : createWorkspaceService({ roots: saved })
  if (command.type === 'skills.list') return stamp('skills.catalog', skillsCatalog((await createSkills({
    workspace, magicBase: context.magic.base, home: context.magic.home,
    sources: loaded.config.skills?.sources ?? [],
  }).discover())))
  if (command.type === 'paths.list') return stamp('paths.catalog', await pathsCatalog(createMaterials({ workspace }), command.query))
  if (command.type === 'grants.list') {
    const file = readGrantView(context.magic, workspace, now)
    return stamp('grants.catalog', grantsCatalog(file.view,
      { total: 0, uncovered: 0, vetoed: 0 }, context.store.decisionHistory(workspace.roots()),
      grantsTrouble(file.path, file.unreadable), file.note))
  }
  return undefined
}

export async function readModelCatalog(loaded: LoadedConfig, magic: MagicHome, selection: ModelSelectionRef | undefined, request: ModelSwitchRequest | undefined, now: () => number, providedInfo?: ModelInfoService): Promise<ModelCatalogReader> {
  const providers = loaded.config.providers
  const processToken = crypto.randomUUID()
  const info = providedInfo ?? createModelInfoService({
    connections: () => Object.entries(providers).map(([providerId, config]) => ({
      ...resolveConnection({ providerId, config }),
      access: cacheAccessFor({ provider: providerId, configPath: loaded.path, apiKey: config.apiKey, processToken }),
    })),
    cache: createFileModelInfoCache(magic.base), now, fetch: globalThis.fetch,
    metadata: createModelsDevResource(magic.base, globalThis.fetch, now),
  })
  await info.warmup() // 仅读缓存并核接入范围；peek 不会触发刷新。
  const picked = request === undefined && selection !== undefined ? { ok: true as const, selection } : resolveModelChoice({
    providers, configuredModels: loaded.config.models, defaults: selection,
    config: request, modelInfoOf: (provider, model) => info.model(provider, model)
  })
  if (request !== undefined && !picked.ok) throw new Error(picked.reason)
  const current = picked.ok ? picked.selection : undefined
  return {
    providers,
    describe: info.describe,
    configuredModels: loaded.config.models,
    entries: Object.keys(providers).map(id => ({ id })),
    ...(current === undefined ? {} : { current }),
    read: (provider) => info.peek(provider),
    inputBudget: (provider, model) => {
      const config = providers[provider]
      return config === undefined ? undefined : modelSpecOf(config, model, info.model(provider, model)).inputBudget
    },
  }
}

/** 配置诊断与核心目录共用的纯文件读面；活跃执行者仍读自己的内存账本。 */
export function readGrantView(magic: MagicHome, workspace: WorkspaceService, now = Date.now) {
  const file = loadGrants(join(magic.base, GRANTS_FILE_NAME))
  const grants = createGrantLedger({ workspace: workspace.defaultRoot(), file: file.file, now })
  return {
    ...file, view: {
      workspace: workspace.defaultRoot(), grants: grants.view(),
      stale: grants.sections().filter((path) => { try { return !statSync(path).isDirectory() } catch { return true } }),
    }
  }
}

export function mcpNoticesOf(
  rows: readonly {
    readonly server: string
    readonly state: { readonly status: string; readonly reason?: string | undefined }
    readonly rejected: number
  }[],
): readonly string[] {
  const said: string[] = []

  // 连不上的那几条**各说一句**（不与别的并成一句：这一条要能一眼看出是哪台服务器）
  for (const row of rows) {
    if (row.state.status !== 'unavailable') continue
    said.push(
      `外部工具服务器「${row.server}」连不上：${row.state.reason ?? '未说缘由'}` +
      '——本次它的工具不可用（内置工具不受影响）',
    )
  }
  for (const row of rows) {
    if (row.rejected === 0) continue
    said.push(
      `外部工具服务器「${row.server}」有 ${row.rejected} 件工具没能收下` +
      '——名字不合规或与同台重名（`--check` 看缘由）',
    )
  }

  return said
}

export function noModelAdvice(input: {
  /** 配好的连接条数（**不是**「缺省是谁」——两者答的是不同的问题）。 */
  readonly connections: number
  /** 此刻真会走的那一条定下来了没有（注册表的 `current()`，不是配置里的缺省）。 */
  readonly hasModel: boolean
}): string | undefined {
  if (input.hasModel) return undefined
  if (input.connections === 0) return '还没有接上供应商——敲 /model connect 接一条'

  return '还没有选好走哪个模型——敲 /model 挑一个'
}

export function noModelRefusal(input: {
  readonly connections: number
  readonly hasModel: boolean
}): string | undefined {
  const advice = noModelAdvice(input)
  if (advice === undefined) return undefined

  return `${advice}（原稿在 ↑ 里）`
}

export function providerRemovedNote(
  provider: string,
  state: { readonly connections: number; readonly hasModel: boolean },
): string {
  const advice = noModelAdvice(state)

  return advice === undefined ? `「${provider}」已断开` : `「${provider}」已断开，${advice}`
}

export function noticesOf(
  rejectedRules: readonly RuleProblem[],
  grantsNotes: readonly string[],
  configPath: string,
  rulesProblems: readonly RulesProblem[],
  connections: readonly McpConnection[],
): readonly string[] {
  const said: string[] = []

  if (rejectedRules.length > 0) {
    said.push(
      `配置里有 ${rejectedRules.length} 条权限规则读不懂（未生效）——${configPath}（\`--check\` 看缘由）`,
    )
  }
  // **只数「坏了」那一类**（2026-09-20 裁）：取舍那类（原生顶掉同名的兼容规则、AGENTS
  // 顶掉 CLAUDE）是**产品按设计做的选择**——为它每次开屏报一句就是噪音，而它**不是故障**。
  // 用户要查「我写的那份为什么没在管」，`--check` 里逐条列着（口径同权限规则那句）。
  const broken = rulesProblems.filter((problem) => problem.kind === 'error')
  if (broken.length > 0) {
    said.push(`项目规约里有 ${broken.length} 条没能加载（\`--check\` 看缘由）`)
  }
  said.push(
    ...mcpNoticesOf(
      connections.map((connection) => ({
        server: connection.server,
        state: connection.state,
        rejected: connection.rejected.length,
      })),
    ),
  )
  said.push(...grantsNotes)

  return said
}
