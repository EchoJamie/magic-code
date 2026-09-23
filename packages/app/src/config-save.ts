/**
 * 配置的**写** —— 供应商连接与默认选择的保存（U41）。
 *
 * 出处：设计 · 命令行与配置「旧配置兼容与保存」· 设计 · 模型与上下文「控制与运行」。
 *
 * 三条规矩（逐条对着设计原文）：
 * ① **原子替换**——写临时文件再 `rename`；权限 600（与首次创建一致）；
 * ② **保存前重新读取**——改的是**盘上当下那一份**，不是加载时那份陈旧快照；
 *    且**保留无关字段**（权限 · MCP · 工作区根…原样带过）：本文件只碰
 *    `providers` 与 `defaultProvider` 两项，别的一律不动。
 * ③ **外部改过就提示重载**——加载时记下的 `mtime` 与当下不符 ⇒ 拒绝这次写入，
 *    把「先重新载入」交给用户（**不拿陈旧整份文件覆盖**别人的改动）。
 *
 * ⚠️ **凭据只进不出**：`apiKey` 写进文件（那是它的落点），但本文件产出的任何**文案**
 * 都不含它——报错只说字段名。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ModelDefaultRequest, ProviderSaveRequest, ReasoningSetting } from '@magic/contracts'

/** 保存的结果——判别式（**不抛**：写不成是用户要读的一句话，不是异常）。 */
export type SaveOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** 改的结果——判别式（`ok: false` 时只有一句给人看的缘由）。 */
type Edit =
  | { readonly ok: true; readonly raw: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string }

export type EditConfigInput = {
  /** 配置文件路径（**已展开**的绝对路径）。 */
  readonly path: string
  /**
   * 加载那一刻这个文件的 `mtimeMs`（没有文件时＝`undefined`）。
   * 给了就比对：不一致 ⇒ 拒绝这次写入（设计：不拿陈旧整份文件覆盖）。
   */
  readonly loadedAt?: number | undefined
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
export function editConfigFile(input: EditConfigInput): SaveOutcome {
  // ③ 外部改过 —— 先比一次（文件此刻不在 ⇒ 与「加载时也不在」相符才算没变）
  if (input.loadedAt !== undefined) {
    let current: number | undefined
    try {
      current = statSync(input.path).mtimeMs
    } catch {
      current = undefined
    }
    if (current !== input.loadedAt) {
      return { ok: false, reason: '配置文件在这一趟之后被改过——请重新载入再改' }
    }
  }

  const read = readRaw(input.path)
  if (!read.ok) return { ok: false, reason: read.reason }

  const edited = input.update(read.raw)
  if (!edited.ok) return { ok: false, reason: edited.reason }

  try {
    mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 })
    const temp = `${input.path}.tmp-${process.pid}`
    try {
      writeFileSync(temp, `${JSON.stringify(edited.raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
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
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return {}
  return { ...(providers as Record<string, unknown>) }
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
export function saveProvider(input: {
  readonly path: string
  readonly loadedAt?: number | undefined
  readonly request: ProviderSaveRequest
}): SaveOutcome {
  return editConfigFile({
    path: input.path,
    ...(input.loadedAt === undefined ? {} : { loadedAt: input.loadedAt }),
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

/**
 * 移除一条连接——**不静默级联**：默认选择指着它时**拒绝**（设计：「有引用先替换或取消」）。
 *
 * 判断落在这一层是因为**这里读得到配置**（默认选择就在同一份文件里）；
 * 「有没有活跃使用」是装配的账，由它在调用前先拦（见 `assembly.ts` 的 `removeProvider`）。
 */
export function removeProvider(input: {
  readonly path: string
  readonly loadedAt?: number | undefined
  readonly provider: string
}): SaveOutcome {
  return editConfigFile({
    path: input.path,
    ...(input.loadedAt === undefined ? {} : { loadedAt: input.loadedAt }),
    update(raw) {
      if (raw['defaultProvider'] === input.provider) {
        return { ok: false, reason: `「${input.provider}」是当前默认——先换一个默认再移除它` }
      }

      const providers = providersOf(raw)
      if (!Object.hasOwn(providers, input.provider)) {
        return { ok: false, reason: `没有「${input.provider}」这条连接` }
      }

      delete providers[input.provider]
      return { ok: true, raw: { ...raw, providers } }
    },
  })
}

/**
 * 设为默认——**写配置**（与 `model.switch` 改当下那一件分开）。
 *
 * 同时落两处（设计 · 命令行与配置：「选定默认后才保存 `defaultProvider` 与对应 `model`」）：
 * `defaultProvider` 换成这条连接，`providers.<id>.model` 换成这个模型。
 */
export function setModelDefault(input: {
  readonly path: string
  readonly loadedAt?: number | undefined
  readonly request: ModelDefaultRequest
}): SaveOutcome {
  return editConfigFile({
    path: input.path,
    ...(input.loadedAt === undefined ? {} : { loadedAt: input.loadedAt }),
    update(raw) {
      const providers = providersOf(raw)
      if (!Object.hasOwn(providers, input.request.provider)) {
        return { ok: false, reason: `没有「${input.request.provider}」这条连接——先接入它` }
      }

      const reasoning: ReasoningSetting | undefined = input.request.reasoning
      providers[input.request.provider] = {
        ...entryOf(providers, input.request.provider),
        model: input.request.model,
        ...(reasoning === undefined ? {} : { reasoning }),
      }

      return { ok: true, raw: { ...raw, providers, defaultProvider: input.request.provider } }
    },
  })
}
