/**
 * 配置的**写** —— 供应商连接与默认选择的保存（U41）。
 *
 * 出处：设计 · 命令行与配置「旧配置兼容与保存」· 设计 · 模型与上下文「控制与运行」。
 *
 * 三条规矩（逐条对着设计原文）：
 * ① **原子替换**——写临时文件再 `rename`；权限 600（与首次创建一致）；
 * ② **保存前重新读取**——改的是**盘上当下那一份**，不是加载时那份陈旧快照；
 *    且**保留无关字段**（权限 · MCP · 工作区根…原样带过）：本文件只碰
 *    `providers` / `models`/ `statusLine` / `motion`（U112）
 *    那几格，别的一律不动。
 * ③ **外部改过就提示重载**——加载时记下的文件指纹与当下不符 ⇒ 拒绝这次写入，
 *    把「先重新载入」交给用户（**不拿陈旧整份文件覆盖**别人的改动）。
 *
 * ⚠️ **凭据只进不出**：`apiKey` 写进文件（那是它的落点），但本文件产出的任何**文案**
 * 都不含它——报错只说字段名。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { configStamp } from './cache-access.ts'
import { acquireFileLock } from './grants-file.ts'
import type {
  ModelConfigureRequest,
  PrefsSetRequest,
  ProviderSaveRequest,
} from '@magic/contracts'

/** 保存的结果——判别式（**不抛**：写不成是用户要读的一句话，不是异常）。 */
export type SaveOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** 改的结果——判别式（`ok: false` 时只有一句给人看的缘由）。 */
type Edit =
  | { readonly ok: true; readonly raw: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string }

export type EditConfigInput = {
  /** 配置文件路径（**已展开**的绝对路径）。 */
  readonly path: string
  readonly expectedStamp?: string | null
  readonly validate?: (raw: Record<string, unknown>) => void
  /** 读到的**盘上原文**交给他改——返回值即要写回去的内容。 */
  readonly update: (raw: Record<string, unknown>) => Edit
}

/** 读盘上那一份（不存在 ＝ 空对象——**首次配置就是这样**）。 */
function readRaw(path: string): Edit {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { ok: true, raw: {} }
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `读不到配置文件（${reason}）` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // 坏内容**不当空配置覆盖**（设计明文）——报错让人去看那份文件
    return { ok: false, reason: '配置文件不是合法 JSON——请先修好它再改' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: '配置根须是对象' }
  }
  return { ok: true, raw: parsed as Record<string, unknown> }
}

/**
 * 读—改—写一趟（三个动作共用）。
 *
 * 写用**临时文件 ＋ rename**：读到的要么是旧的完整内容、要么是新的完整内容。
 */
export async function editConfigFile(input: EditConfigInput): Promise<SaveOutcome> {
  let lock: Awaited<ReturnType<typeof acquireFileLock>>
  try { lock = await acquireFileLock(input.path) } catch { return { ok: false, reason: '配置文件正在写入或不可写，请稍后重试' } }
  try { return editLocked(input) } catch { return { ok: false, reason: '配置文件无法读取或写入，请检查路径与权限后重试' } } finally { lock.release() }
}

function editLocked(input: EditConfigInput): SaveOutcome {
  const before = configStamp(input.path)
  if (input.expectedStamp !== undefined && input.expectedStamp !== before) {
    return { ok: false, reason: '配置已被修改，请重新读取后再保存；未提交输入已保留' }
  }
  const read = readRaw(input.path)
  if (!read.ok) return { ok: false, reason: read.reason }

  const edited = input.update(read.raw)
  if (!edited.ok) return { ok: false, reason: edited.reason }
  try { input.validate?.(edited.raw) } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : '配置字段无效' } }

  try {
    mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 })
    const temp = `${input.path}.tmp-${process.pid}-${crypto.randomUUID()}`
    try {
      writeFileSync(temp, `${JSON.stringify(edited.raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      if (configStamp(input.path) !== before) { rmSync(temp, { force: true }); return { ok: false, reason: '配置已被外部修改，请重新读取后再保存' } }
      renameSync(temp, input.path)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `写不进配置文件（${reason}）` }
  }

  return { ok: true }
}

/** `providers` 那一段（缺省 / 不是对象 ⇒ 空表——**不静默丢掉**别人的东西：只在本键坏时如此）。 */
function providersOf(raw: Record<string, unknown>): Record<string, unknown> {
  const providers = raw['providers']
  return Object.assign(Object.create(null), typeof providers === 'object' && providers !== null && !Array.isArray(providers) ? providers : {})
}

function entryOf(providers: Record<string, unknown>, id: string): Record<string, unknown> {
  const entry = providers[id]
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return {}
  return { ...(entry as Record<string, unknown>) }
}

/**
 * 保存一条连接（接入 / 改名 / 更新认证 / 改地址）。
 *
 * **只改点名的字段**：`request` 里没给的位一律不碰（缺省 ＝ 不改，不是「改成空」）——
 * 「管理页改个名字不该顺手把凭据抹掉」。给空串的那几位（`name` / `region` / `baseURL`）
 * ＝**清掉这一位**（用户明确要抹掉它）。
 *
 * ⚠️ **不猜供应商**：`vendor` 认不出由模型域报（这里只管写进去）。
 */
export async function saveProvider(input: {
  readonly path: string
  readonly expectedStamp?: string | null
  readonly validate?: (raw: Record<string, unknown>) => void
  readonly request: ProviderSaveRequest
}): Promise<SaveOutcome> {
  return editConfigFile({
    path: input.path,
    ...(input.expectedStamp === undefined ? {} : { expectedStamp: input.expectedStamp }),
    ...(input.validate === undefined ? {} : { validate: input.validate }),
    update(raw) {
      const providers = providersOf(raw)
      const entry = entryOf(providers, input.request.provider)

      // 空串 ＝ 清掉这一位；缺省 ＝ 不动它
      const put = (key: string, value: string | undefined): void => {
        if (value === undefined) return
        if (value.length === 0) delete entry[key]
        else entry[key] = value
      }

      put('vendor', input.request.vendor)
      put('name', input.request.name)
      put('region', input.request.region)
      put('baseURL', input.request.baseURL)
      // 凭据：缺省不动（改名不该抹掉 key）；空串 ＝ 清除（回到环境变量回退）
      put('apiKey', input.request.apiKey)

      providers[input.request.provider] = entry
      return { ok: true, raw: { ...raw, providers } }
    },
  })
}


export async function removeProvider(input: {
  readonly path: string
  readonly expectedStamp?: string | null
  readonly validate?: (raw: Record<string, unknown>) => void
  readonly provider: string
}): Promise<SaveOutcome> {
  return editConfigFile({
    path: input.path,
    ...(input.expectedStamp === undefined ? {} : { expectedStamp: input.expectedStamp }),
    ...(input.validate === undefined ? {} : { validate: input.validate }),
    update(raw) {
      const providers = providersOf(raw)
      if (!Object.hasOwn(providers, input.provider)) {
        return { ok: false, reason: `没有「${input.provider}」这条连接` }
      }

      const configuredModels = raw['models'] as Record<string, { provider: string }> | undefined
      if (Object.values(configuredModels ?? {}).some(mapping => mapping.provider === input.provider)) {
        return { ok: false, reason: '连接仍被 Default 或档位引用，请先更换或清除映射' }
      }
      delete providers[input.provider]
      return { ok: true, raw: { ...raw, providers } }
    },
  })
}

/** 保存独立映射；首次初始化只填尚未设置的三档。 */
export async function configureModel(input: {
  readonly path: string
  readonly expectedStamp?: string | null
  readonly validate?: (raw: Record<string, unknown>) => void
  readonly request: ModelConfigureRequest
}): Promise<SaveOutcome> {
  const { choice, provider, model, initialize } = input.request
  if (!['default', 'cantrip', 'spell', 'arcane'].includes(choice)) return { ok: false, reason: '未知模型选择' }
  if (typeof model !== 'string' || model.trim() === '') return { ok: false, reason: '请选择实际型号' }
  if (initialize === true && choice !== 'default') return { ok: false, reason: '首次初始化只能保存 Default' }
  return editConfigFile({
    path: input.path,
    ...(input.expectedStamp === undefined ? {} : { expectedStamp: input.expectedStamp }),
    ...(input.validate === undefined ? {} : { validate: input.validate }),
    update(raw) {
      if (!Object.hasOwn(providersOf(raw), provider)) return { ok: false, reason: `没有「${provider}」这条连接——先接入它` }
      const value = raw['models']
      if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) return { ok: false, reason: 'models 须是对象，请先修复配置' }
      for (const [key, mapping] of Object.entries(value ?? {})) {
        if (!['default', 'cantrip', 'spell', 'arcane'].includes(key) || typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)
          || Object.keys(mapping).some(field => !['provider', 'model'].includes(field))
          || typeof mapping.provider !== 'string' || !Object.hasOwn(providersOf(raw), mapping.provider)
          || typeof mapping.model !== 'string' || mapping.model.trim() === '') return { ok: false, reason: 'models 内容无效，请先修复配置' }
      }
      const configuredModels = { ...(value as Record<string, unknown> | undefined) }
      const mapping = { provider, model }
      configuredModels[choice] = mapping
      if (initialize === true) for (const tier of ['cantrip', 'spell', 'arcane']) if (!Object.hasOwn(configuredModels, tier)) configuredModels[tier] = mapping
      return { ok: true, raw: { ...raw, models: configuredModels } }
    },
  })
}

export async function setPrefs(input: {
  readonly path: string
  readonly expectedStamp?: string | null
  readonly validate?: (raw: Record<string, unknown>) => void
  readonly request: PrefsSetRequest
}): Promise<SaveOutcome> {
  const { statusLine, reducedMotion } = input.request

  return editConfigFile({
    path: input.path,
    ...(input.expectedStamp === undefined ? {} : { expectedStamp: input.expectedStamp }),
    ...(input.validate === undefined ? {} : { validate: input.validate }),
    update(raw) {
      const next: Record<string, unknown> = { ...raw }

      if (statusLine !== undefined) {
        next['statusLine'] = {
          cells: [...statusLine.cells],
          ...(statusLine.color === undefined ? {} : { color: statusLine.color }),
        }
      }

      // 动效那一段**只留它自己那一格**：`reduced: false` 是「没开」，与「没配过」同义
      // ⇒ 那一格**不留**（写一个 `false` 进去，配置里就多一句从来不生效的话）。
      // 整段因此空了就**把这一段摘掉**（同上：不留空壳）。
      if (reducedMotion !== undefined) {
        if (reducedMotion) next['motion'] = { reduced: true }
        else delete next['motion']
      }

      return { ok: true, raw: next }
    },
  })
}
