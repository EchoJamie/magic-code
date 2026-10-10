import type { MagicConfig } from '@magic/contracts'
/** 常驻核心的只读控制面：只取配置、目录、缓存和记录，不装配执行者或连接外部服务。 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Command, DecisionHistory, EventDataOf, EventKind, KernelEvent, MagicHome,
  Materials, McpCatalogRow, ModelCatalogRow, ModelInfoRead, ModelSelectionRef,
  ModelSwitchRequest, ProviderConfig, SkillCatalog, WorkspaceService,
} from '@magic/contracts'
import { GRANTS_FILE_NAME, apiKeyEnvVarOf } from '@magic/contracts'
import { DEFAULT_CANDIDATES, createMaterials, createSkills, createWorkspaceService } from '@magic/execution'
import { createGrantLedger } from '@magic/permission'
import type { ModelInfoService } from '@magic/model'
import { createModelInfoService, modelSpecOf, resolveConnection, vendorCatalog } from '@magic/model'
import type { RecordsStore } from '@magic/records'
import { cacheAccessFor } from '../cache-access.ts'
import { resolveModelChoice } from '../agent-models.ts'
import { ConfigError, loadConfig, type LoadedConfig } from '../config.ts'
import { loadGrants } from '../grants-file.ts'
import { createFileModelInfoCache } from '../model-cache.ts'

export function workspaceOf(loaded: LoadedConfig, cwd: string): WorkspaceService {
  try {
    return createWorkspaceService({ roots: loaded.config.workspaceRoots ?? [cwd] })
  } catch (error) {
    throw new ConfigError(loaded.path, error instanceof Error ? error.message : String(error))
  }
}

/** assembly 与观察面共用投影；调用者提供真实内存读数或纯缓存读数。 */
export type ModelCatalogReader = {
  readonly providers: Readonly<Record<string, ProviderConfig>>
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
    const keySource = config?.apiKey?.trim() ? 'config' : fromEnv?.trim() ? 'env' : undefined
    const budget = entry.model === undefined ? undefined : reader.inputBudget(entry.id, entry.model)
    const cache = reader.read(entry.id)
    return {
      provider: entry.id,
      ...(config?.name === undefined ? {} : { name: config.name }),
      ...(config?.vendor === undefined ? {} : { vendor: config.vendor }),
      ...(config?.region === undefined ? {} : { region: config.region }),
      ...(config?.baseURL === undefined ? {} : { baseURL: config.baseURL }),
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
  })
  await info.warmup() // 仅读缓存并核接入范围；peek 不会触发刷新。
  const picked = resolveModelChoice({ providers, configuredModels: loaded.config.models, defaults: selection,
    config: request, modelInfoOf: (provider, model) => info.peek(provider).snapshot?.models.find(one => one.id === model) })
  if (request !== undefined && !picked.ok) throw new Error(picked.reason)
  const current = picked.ok ? picked.selection : undefined
  return {
    providers,
    entries: Object.keys(providers).map(id => ({ id })),
    ...(current === undefined ? {} : { current }),
    read: (provider) => info.peek(provider),
    inputBudget: (provider, model) => {
      const config = providers[provider]
      return config === undefined ? undefined : modelSpecOf(config, model, info.peek(provider).snapshot?.models.find((one) => one.id === model)).inputBudget
    },
  }
}

/** 配置诊断与核心目录共用的纯文件读面；活跃执行者仍读自己的内存账本。 */
export function readGrantView(magic: MagicHome, workspace: WorkspaceService, now = Date.now) {
  const file = loadGrants(join(magic.base, GRANTS_FILE_NAME))
  const grants = createGrantLedger({ workspace: workspace.defaultRoot(), file: file.file, now })
  return { ...file, view: {
    workspace: workspace.defaultRoot(), grants: grants.view(),
    stale: grants.sections().filter((path) => { try { return !statSync(path).isDirectory() } catch { return true } }),
  } }
}
