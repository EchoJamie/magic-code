/**
 * 配置 state 服务——当前值、修订、订阅与「用前解析」。
 *
 * 配置文件仍是 `config.json`；本服务只保证：
 * - 每次 `resolveAtUse` 按文件指纹重新解析，运行中改配置在下一个边界生效；
 * - 解析失败退回内存里上一份可用值（并标记 `degraded`），不把会话留在死状态；
 * - 成功写入提升 `state-revision.json` 并通知订阅者。
 */
import type { MagicHome } from '@magic/contracts'
import { loadConfig, type LoadedConfig, type LoadConfigOptions } from './config.ts'
import { configStamp } from './fingerprint.ts'
import { editConfigFile, type EditConfigInput } from './save.ts'
import { contentHashOf, readStateRevision, stateRevisionPathOf, type StateRevision } from './state-revision.ts'
import { subscribeState, type StateListener } from './subscribe.ts'

export type StateService = {
  /** 当前配置（最近一次成功解析的那一份）。 */
  current(): LoadedConfig
  /** 用前解析——文件变了就重读；失败退回上一份可用值。 */
  resolveAtUse(): { readonly config: LoadedConfig; readonly degraded: boolean }
  revision(): number
  /** 写配置；成功提升修订并通知订阅者。 */
  update(input: Omit<EditConfigInput, 'path'>): Promise<{ readonly ok: boolean; readonly reason?: string }>
  subscribe(listener: StateListener): () => void
  /** 最后一次成功解析的指纹（诊断用）。 */
  stamp(): string | null
}

export type StateServiceOptions = {
  readonly path: string
  readonly magic: MagicHome
  readonly now?: () => number
  readonly load?: (options: LoadConfigOptions) => LoadedConfig
}

export function createStateService(options: StateServiceOptions): StateService {
  const load = options.load ?? loadConfig
  let loaded = load({ path: options.path, magic: options.magic })
  let lastStamp = configStamp(options.path)
  let degraded = false

  const refreshRevision = (): StateRevision | undefined => {
    try {
      return readStateRevision(stateRevisionPathOf(options.path))
    } catch {
      return undefined
    }
  }

  return {
    current: () => loaded,
    resolveAtUse() {
      const stamp = configStamp(options.path)
      if (stamp !== null && stamp === lastStamp) return { config: loaded, degraded }
      try {
        loaded = load({ path: options.path, magic: options.magic })
        lastStamp = stamp
        degraded = false
      } catch {
        // 解析失败：保留上一份可用值，不把会话留在死状态。
        degraded = true
      }
      return { config: loaded, degraded }
    },
    revision: () => refreshRevision()?.revision ?? 0,
    async update(input) {
      const outcome = await editConfigFile({ ...input, path: options.path })
      if (!outcome.ok) return { ok: false, reason: outcome.reason }
      // 写入后立刻解析一次，确保新值真的可用；失败保留旧值并标记降级。
      try {
        loaded = load({ path: options.path, magic: options.magic })
        lastStamp = configStamp(options.path)
        degraded = false
      } catch {
        degraded = true
      }
      return { ok: true }
    },
    subscribe: listener => subscribeState(options.path, listener),
    stamp: () => configStamp(options.path),
  }
}

/** 当前文件是否仍是 state 修订里记的那一份（诊断用）。 */
export function stateIsLastKnownGood(path: string): boolean {
  const revision = readStateRevision(stateRevisionPathOf(path))
  return revision === undefined ? false : contentHashOf(path) === revision.lastKnownGood
}

export type { StateListener }
