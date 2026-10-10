import { validDiagnosticsChange } from './diagnostics.ts'
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const strings = (v: unknown) => Array.isArray(v) && v.every(text)
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v)
export function settingsAction(v: unknown): boolean {
  if (!object(v)) return false
  switch (v.type) {
    case 'diagnostics.set': return optional(v.source, x => x === 'app' || x === 'cli') && validDiagnosticsChange(v)
    case 'provider.save': return text(v.provider) && ['vendor', 'name', 'region', 'baseURL', 'apiKey'].every(k => optional(v[k], x => typeof x === 'string'))
    case 'provider.remove': case 'model.refresh': return text(v.provider)
    case 'model.configure': return ['default', 'cantrip', 'spell', 'arcane'].includes(String(v.choice)) && text(v.provider) && text(v.model) && optional(v.initialize, x => typeof x === 'boolean')
    case 'model.clear': return ['default', 'cantrip', 'spell', 'arcane'].includes(String(v.choice))
    case 'model.override': return text(v.provider) && text(v.model) && (v.override === null || object(v.override))
    case 'prefs.set': return optional(v.reducedMotion, x => typeof x === 'boolean') && optional(v.statusLine, x => object(x) && Array.isArray(x.cells) && x.cells.every(c => ['session', 'model', 'reasoning', 'context', 'workspace'].includes(String(c))) && new Set(x.cells).size === x.cells.length && optional(x.color, c => typeof c === 'boolean'))
    case 'mcp.save': return text(v.name) && object(v.server) && Object.keys(v.server).every(k => Object.hasOwn(v.server as object, 'url') ? k === 'url' : ['command', 'args'].includes(k)) && (Object.hasOwn(v.server, 'url') ? text(v.server.url) : text(v.server.command) && optional(v.server.args, x => Array.isArray(x) && x.every(a => typeof a === 'string'))) && object(v.secrets) && Object.values(v.secrets).every(x => x === null || typeof x === 'string')
    case 'mcp.remove': return text(v.name)
    case 'sources.set': return ['rules.sources', 'rules.linkSources', 'skills.sources'].includes(String(v.source)) && strings(v.paths)
    case 'role.save': return text(v.id) && object(v.role)
    case 'role.remove': return text(v.id)
    case 'workspace.set': return v.roots === null || strings(v.roots)
    case 'permissions.set': return Array.isArray(v.rules)
    case 'grants.revoke': return text(v.workspace) && optional(v.index, x => typeof x === 'number' && Number.isInteger(x) && x >= 0) && (v.grantStamp === null || text(v.grantStamp))
    default: return false
  }
}
export function settingsSnapshot(v: unknown): boolean {
  return object(v) && text(v.configPath) && text(v.base) && (v.stamp === null || text(v.stamp)) && object(v.configuration) && object(v.preview) && ['catalog', 'vendors', 'sources', 'grants'].every(k => Array.isArray(v[k])) && (v.grantStamp === null || text(v.grantStamp))
}

export function settingsRequest(v: unknown): boolean {
  return object(v) && ['request', 'home', 'base', 'configPath'].every(k => text(v[k])) &&
    optional(v.action, x => settingsAction(x) && (v.stamp === null || typeof v.stamp === 'string')) &&
    optional(v.preview, x => object(x) && Number.isInteger(x.columns) && (x.columns as number) >= 20 && (x.columns as number) <= 300 && typeof x.reducedMotion === 'boolean' && settingsAction({ type: 'prefs.set', statusLine: x.statusLine }))
}
export function settingsResult(v: unknown): boolean {
  return object(v) && ['request', 'base', 'configPath'].every(k => text(v[k])) && typeof v.saved === 'boolean' &&
    optional(v.snapshot, settingsSnapshot) && optional(v.error, x => typeof x === 'string') && optional(v.note, x => typeof x === 'string') && (v.snapshot !== undefined || v.error !== undefined)
}
