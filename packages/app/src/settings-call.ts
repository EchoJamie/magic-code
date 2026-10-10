import { isAbsolute, join } from 'node:path'
import { settingsRequest, type SettingsAction, type SettingsPreview, type SettingsSnapshot } from '@magic/contracts'
import { createSettings } from './settings.ts'
import { createWorkEnvironment } from './work-environment.ts'
import { normalizeDataDir } from './run/paths.ts'

export type SettingsRequest = {
  readonly request: string
  readonly home: string
  readonly base: string
  readonly configPath: string
  readonly stamp?: string | null
  readonly action?: SettingsAction
  readonly preview?: SettingsPreview
}
export type SettingsResult = {
  readonly request: string
  readonly base: string
  readonly configPath: string
  readonly saved: boolean
  readonly note?: string
  readonly snapshot?: SettingsSnapshot
  readonly error?: string
}

/** 写入只调用一次；保存后的读取失败不撤销成功事实，也不重放动作。 */
export async function performSettingsRequest(request: SettingsRequest, settings: Pick<ReturnType<typeof createSettings>, 'read' | 'apply'>): Promise<SettingsResult> {
  const target = { request: request.request, base: request.base, configPath: request.configPath }
  let saved = false, note: string | undefined
  try {
    if (request.action) {
      note = await settings.apply(request.action, request.stamp ?? null)
      saved = request.action.type !== 'model.refresh'
    }
    let snapshot: SettingsSnapshot
    try { snapshot = await settings.read(request.preview) }
    catch { snapshot = await settings.read(request.preview) }
    return { ...target, saved, ...(note === undefined ? {} : { note }), snapshot }
  } catch (error) {
    return { ...target, saved, ...(note === undefined ? {} : { note }), error: error instanceof Error ? error.message : String(error) }
  }
}

export async function runSettingsCall(raw: unknown, environment: Readonly<Record<string, string | undefined>>): Promise<SettingsResult> {
  if (!settingsRequest(raw)) throw new Error('设置请求、动作或内容指纹无效')
  const request = raw as SettingsRequest
  if (![request.home, request.base, request.configPath].every(isAbsolute) ||
      normalizeDataDir(request.configPath) !== normalizeDataDir(join(request.base, 'config.json'))) throw new Error('配置路径与读取时的数据实例不一致，未保存')
  const network = createWorkEnvironment(environment)
  try {
    return await performSettingsRequest(request, createSettings({ magic: { home: request.home, base: request.base }, environment: network.env, fetch: network.fetch }))
  } finally { await network.close() }
}
