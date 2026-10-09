import { diagnosticsOf, type Diagnostics } from '@magic/contracts'
import { saveDiagnostics } from './diagnostics.ts'
import { statusLinePreview } from '@magic/tui'
/** 原生设置的应用动作；复用配置解析、保存、缓存和授权，不装配工作。 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { SettingsAction, SettingsSnapshot, SettingsPreview } from '@magic/contracts'
import { expandHome, GRANTS_FILE_NAME, apiKeyEnvVarOf } from '@magic/contracts'
import { createWorkspaceService } from '@magic/execution'
import { parseRules } from '@magic/permission'
import type { ModelInfoService } from '@magic/model'
import { createModelInfoService, resolveConnection, vendorCatalog } from '@magic/model'
import { loadConfig, parseConfig, type LoadedConfig } from './config.ts'
import { editConfigFile, saveProvider, removeProvider, configureModel, setPrefs } from './config-save.ts'
import { commitGrants, loadGrants } from './grants-file.ts'
import { createFileModelInfoCache } from './model-cache.ts'
import { cacheAccessFor, connectionScopeChanged, configStamp } from './cache-access.ts'
import { resolveModelChoice } from './agent-models.ts'
import { providerCatalog, readModelCatalog } from './run/observation.ts'
import type { ObservationContext } from './run/observation.ts'

export type SettingsContext = ObservationContext & {
  readonly diagnosticsChanged?: (value: Diagnostics, source?: 'app' | 'cli' | 'config') => Promise<string>

  readonly canChangeData: () => boolean | Promise<boolean>
  readonly mcpWorks: () => Promise<SettingsSnapshot['mcp']>
  readonly preferencesChanged: () => Promise<void>
  readonly reconnect: (session: string, gen: number, name: string) => Promise<string>
  readonly grantsChanged: (workspace: string) => Promise<void>
}
const book = (v: unknown): Record<string, unknown> => Object.assign(Object.create(null), typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {})

export function createSettings(context: SettingsContext) {
  const configPath = `${context.magic.base}/config.json`
  const grantPath = `${context.magic.base}/${GRANTS_FILE_NAME}`
  const processToken = crypto.randomUUID()
  let currentLoaded: LoadedConfig | undefined
  let info: ModelInfoService | undefined
  function modelInfo(loaded: LoadedConfig): ModelInfoService {
    if (info !== undefined && currentLoaded !== undefined) for (const [provider, config] of Object.entries(currentLoaded.config.providers)) {
      if (connectionScopeChanged(config, loaded.config.providers[provider])) info.drop(provider)
    }
    currentLoaded = loaded
    if (info === undefined) {
      info = createModelInfoService({ connections: () => Object.entries(currentLoaded!.config.providers).map(([providerId, config]) => ({
        ...resolveConnection({ providerId, config }), access: cacheAccessFor({ provider: providerId, configPath, apiKey: config.apiKey, processToken }),
      })), cache: createFileModelInfoCache(context.magic.base), now: context.now ?? Date.now, fetch: globalThis.fetch })
    }
    return info
  }
  async function read(preview?: SettingsPreview): Promise<SettingsSnapshot> {
    const stamp = configStamp(configPath)
    const loaded = loadConfig({ magic: context.magic })
    const config = loaded.config
    const diagnosticsNote = await context.diagnosticsChanged?.(diagnosticsOf(config), 'config')
    const providers = Object.fromEntries(Object.entries(config.providers).map(([id, { apiKey, ...entry }]) => [id, {
      ...entry, keyConfigured: !!apiKey?.trim(), keySource: apiKey?.trim() ? 'config' : process.env[apiKeyEnvVarOf(id)]?.trim() ? 'env' : 'missing',
    }]))
    const servers = Object.fromEntries(Object.entries(config.mcp?.servers ?? {}).map(([name, server]) => {
      if ('url' in server) return [name, { url: server.url, secretNames: Object.keys(server.headers ?? {}) }]
      return [name, { command: server.command, args: server.args ?? [], secretNames: Object.keys(server.env ?? {}) }]
    }))
    const raw = stamp === null ? {} : book(JSON.parse(readFileSync(configPath, 'utf8')))
    const configuration = {
      ...diagnosticsOf(config), diagnosticsNote,
      providers, models: config.models ?? {}, agentRoles: raw.agentRoles ?? {},
      mcp: { servers }, rules: raw.rules ?? {}, skills: raw.skills ?? {},
      ...(raw.workspaceRoots === undefined ? {} : { workspaceRoots: raw.workspaceRoots }),
      permissions: config.permissions ?? {},
      statusLine: config.statusLine ?? { cells: ['session', 'context'], color: true }, motion: config.motion ?? {},
    }
    const sources = ['rules.sources', 'rules.linkSources', 'skills.sources'].flatMap(source => {
      const [section, key] = source.split('.') as [string, string]
      return ((book(raw[section])[key] ?? []) as string[]).map(path => {
        const expanded = expandHome(path, context.magic.home)
        let resolved = expanded, problem: string | undefined
        if (!isAbsolute(expanded)) problem = '须使用绝对路径或 ~ 开头的路径'
        else try { resolved = realpathSync(expanded); if (source === 'skills.sources' && !statSync(resolved).isDirectory()) problem = '技能来源须是目录' } catch { problem = '路径不存在或不可读取' }
        return { source, path, resolved, ...(problem === undefined ? {} : { problem }) }
      })
    })
    const reader = await readModelCatalog(loaded, context.magic, undefined, undefined, context.now ?? Date.now, modelInfo(loaded))
    const catalog = providerCatalog(reader).entries
    const grantStamp = configStamp(grantPath)
    const grants = loadGrants(grantPath)
    const mcp = await context.mcpWorks()
    const canChangeData = await context.canChangeData()
    if (configStamp(grantPath) !== grantStamp) throw new Error('授权在读取期间已改变，请重新读取')
    if (configStamp(configPath) !== stamp) throw new Error('配置在读取期间已改变，请重新读取')
    return {
      preview: statusLinePreview(preview?.statusLine ?? config.statusLine ?? { cells: ['session', 'context'] }, preview?.columns ?? 80, preview?.reducedMotion ?? config.motion?.reduced === true),
      configPath, base: context.magic.base, stamp, configuration, catalog,
      vendors: vendorCatalog(), sources,
      grants: Object.entries(grants.file.workspaces).map(([workspace, entries]) => ({ workspace, entries })),
      grantStamp,
      ...(grants.unreadable === undefined && grants.rejected.length === 0 ? {} : { grantProblem: '授权文件存在无法读取的内容，请定位文件修复' }),
      mcp, canChangeData,
    }
  }
  async function apply(action: SettingsAction, stamp: string | null): Promise<string> {
    if (configStamp(configPath) !== stamp) throw new Error('配置已被修改，请重新读取后再保存；输入已保留')
    const loaded = loadConfig({ magic: context.magic })
    if (action.type === 'diagnostics.set') {
      const { type, source, ...change } = action
      const value = saveDiagnostics(context.magic, change, stamp)
      return await context.diagnosticsChanged?.(value, source ?? 'app') ?? '诊断设置已保存'
    }
    const currentInfo = modelInfo(loaded)
    await currentInfo.warmup()
    const snapshots = Object.entries(loaded.config.providers).map(([provider, config]) => ({ provider, config, snapshot: currentInfo.peek(provider).snapshot }))
    if (action.type === 'role.save' && action.role.model !== undefined) {
      const reader = await readModelCatalog(loaded, context.magic, undefined, undefined, context.now ?? Date.now, currentInfo)
      const choice = resolveModelChoice({ providers: loaded.config.providers, configuredModels: loaded.config.models, config: action.role.model,
        modelInfoOf: (provider, model) => reader.read(provider).snapshot?.models.find(info => info.id === model) })
      if (!choice.ok) throw new Error(`角色模型设置：${choice.reason}`)
    }
    const validate = (raw: Record<string, unknown>) => {
      const config = parseConfig(raw, configPath, context.magic).config
      for (const [id, configEntry] of Object.entries(config.providers)) resolveConnection({ providerId: id, config: configEntry })
      if (action.type === 'workspace.set' && config.workspaceRoots !== undefined) createWorkspaceService({ roots: config.workspaceRoots })
      if (action.type === 'permissions.set') {
        const rejected = parseRules(config.permissions?.rules).rejected
        if (rejected.length) throw new Error(`permissions.rules[${rejected[0]!.index}]：${rejected[0]!.reason}`)
      }
      if (action.type === 'sources.set') for (const path of action.paths) if (!isAbsolute(expandHome(path, context.magic.home))) throw new Error(`${action.source}：须使用绝对路径或 ~ 开头的路径`)
    }
    const input = { path: configPath, expectedStamp: stamp, validate }
    let outcome: ReturnType<typeof editConfigFile>
    switch (action.type) {
      case 'provider.save': outcome = saveProvider({ ...input, request: action }); break
      case 'provider.remove': outcome = removeProvider({ ...input, provider: action.provider }); break
      case 'model.configure': outcome = configureModel({ ...input, request: action }); break
      case 'prefs.set': outcome = setPrefs({ ...input, request: action }); break
      case 'model.refresh': {
        const providers = loaded.config.providers
        if (!providers[action.provider]) throw new Error('连接已不存在，请重新读取')
        const result = await currentInfo.refresh(action.provider)
        if (result.failure) throw new Error('模型列表刷新失败，请检查连接与认证')
        return '模型列表已刷新；未发起模型调用'
      }
      case 'mcp.reconnect': return context.reconnect(action.session, action.gen, action.name)
      case 'grants.revoke': {
        if (configStamp(grantPath) !== action.grantStamp) throw new Error('授权已改变，请重新读取后再撤销')
        const loadedGrants = loadGrants(grantPath)
        if (loadedGrants.unreadable !== undefined) throw new Error('授权文件不可读取，未做修改')
        const rule = action.index === undefined ? undefined : loadedGrants.file.workspaces[action.workspace]?.[action.index]
        if (action.index !== undefined && rule === undefined) throw new Error('该授权已不存在，请重新读取')
        outcome = commitGrants(grantPath, rule === undefined ? [{ kind: 'section', workspace: action.workspace }] : [{ kind: 'revoke', workspace: action.workspace, index: action.index!, rule }], () => configStamp(grantPath) === action.grantStamp)
        if (!outcome.ok) throw new Error(outcome.reason)
        await context.grantsChanged(action.workspace)
        return '已撤销授权；配置权限规则另行管理'
      }
      default: {
        outcome = editConfigFile({ ...input, update(raw) {
          const next = { ...raw }
          switch (action.type) {
            case 'model.clear': { const configuredModels = book(raw.models); delete configuredModels[action.choice]; next.models = configuredModels; break }
            case 'model.override': {
              const providers = book(raw.providers), entry = book(providers[action.provider]), overrides = book(entry.modelOverrides)
              if (!Object.hasOwn(providers, action.provider)) return { ok: false, reason: '连接已不存在' }
              if (action.override === null) delete overrides[action.model]; else overrides[action.model] = action.override
              entry.modelOverrides = overrides; providers[action.provider] = entry; next.providers = providers; break
            }
            case 'mcp.save': case 'mcp.remove': {
              const mcp = book(raw.mcp), servers = book(mcp.servers)
              if (action.type === 'mcp.remove') delete servers[action.name]
              else {
                if ('url' in action.server && !['http:', 'https:'].includes(new URL(action.server.url).protocol)) return { ok: false, reason: 'MCP URL 须为 http:// 或 https://' }
                if (Object.keys(action.secrets).some(key => key.trim() === '')) return { ok: false, reason: '环境变量或请求头名称不能为空' }
                const previous = book(servers[action.name]), key = 'url' in action.server ? 'headers' : 'env'
                const secrets = book(previous[key])
                for (const [name, value] of Object.entries(action.secrets)) if (value === null) delete secrets[name]; else secrets[name] = value
                servers[action.name] = { ...action.server, ...(Object.keys(secrets).length ? { [key]: secrets } : {}) }
              }
              mcp.servers = servers; next.mcp = mcp; break
            }
            case 'sources.set': { const [section, field] = action.source.split('.') as [string, string]; next[section] = { ...book(raw[section]), [field]: action.paths }; break }
            case 'role.save': case 'role.remove': {
              const roles = book(raw.agentRoles)
              if (action.type === 'role.remove') delete roles[action.id]; else roles[action.id] = action.role
              next.agentRoles = roles; break
            }
            case 'workspace.set': if (action.roots === null) delete next.workspaceRoots; else next.workspaceRoots = action.roots; break
            case 'permissions.set': next.permissions = { ...book(raw.permissions), rules: action.rules }; break
          }
          return { ok: true, raw: next }
        } })
      }
    }
    if (!outcome.ok) throw new Error(outcome.reason)
    const reloaded = loadConfig({ magic: context.magic })
    const modelCache = createFileModelInfoCache(context.magic.base)
    for (const { provider, config, snapshot } of snapshots) {
      if (snapshot !== undefined && !connectionScopeChanged(config, reloaded.config.providers[provider])) {
        await modelCache.replace(snapshot, cacheAccessFor({ provider, configPath, apiKey: reloaded.config.providers[provider]?.apiKey, processToken }))
      }
    }
    modelInfo(reloaded)
    if (action.type === 'prefs.set') await context.preferencesChanged()
    if (action.type.startsWith('model.') || action.type.startsWith('provider.')) return '已保存；之后解析模型配置时采用，已有 Agent 的选择保留'
    if (action.type.startsWith('role.')) return '已保存；后续创建采用，已有成员保留'
    if (action.type === 'prefs.set') return '已保存；已向当前终端受理呈现偏好，计时继续'
    return '已保存；下次装配时采用，已有工作保持原配置'
  }
  return { read, apply }
}
