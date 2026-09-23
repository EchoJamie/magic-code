/**
 * 模型信息缓存 —— 盘上那一份（U41 · 装配根提供 `ModelInfoCache` 端口的实现）。
 *
 * 出处：设计 · 模型与上下文「数据与持久化」：
 * 「`app` 提供 `<dataDir>/cache/models/` 下独立连接文件的实现：安全编码文件名 ·
 * 仅本用户读写 · 临时文件后原子替换。缓存损坏可丢弃重取，不新增数据库、迁移账或版本对照系统。」
 *
 * 三条纪律：
 * - **文件名安全编码**——连接 id 是用户自由命名的（可能有 `/` · `..` · 中文），
 *   故先 base64url 再落盘；**不用密钥或密钥摘要作标识**（设计明文）；
 * - **原子替换**——写临时文件再 `rename`：读到的要么是上一份完整的、要么是这一份完整的，
 *   不会读到写了一半的 JSON；
 * - **损坏可丢弃**——读不懂就当没有（那正是「可删除重建」的意思），**不迁移、不修复**。
 *
 * ⚠️ 本文件在装配根（`app`），不在模型域：域不碰 fs（内核 fs 纪律）。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelInfo, ModelInfoCache, ModelInfoSnapshot } from '@magic/contracts'

/** 缓存目录名（相对数据目录）——`<dataDir>/cache/models/`。 */
export const MODEL_CACHE_DIR = join('cache', 'models')

/**
 * 文件名——连接 id 经 **base64url** 编码。
 *
 * 由头：id 是用户起的（`providers` 的键），里面可能有 `/`、`..`、空白、中文——
 * 直接拼进路径既会跑出目录，也会在别人的文件系统上撞名字。base64url 只出
 * `A-Za-z0-9-_`，长度确定、可逆，且**不含密钥**（id 本来就不是凭据）。
 */
function fileNameOf(providerId: string): string {
  return `${Buffer.from(providerId, 'utf8').toString('base64url')}.json`
}

/** 读不懂 / 不成形 ＝ `undefined`（**损坏可丢弃重取**，不报错、不修复）。 */
function parseSnapshot(text: string): ModelInfoSnapshot | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined
  const raw = parsed as Record<string, unknown>

  const provider = raw['provider']
  const scope = raw['scope']
  const fetchedAt = raw['fetchedAt']
  const models = raw['models']

  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof scope !== 'string') return undefined
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return undefined
  if (!Array.isArray(models)) return undefined

  // 逐条只认 `id`——那一格是调用时要送的名字，缺它这条就没有用
  const kept: ModelInfo[] = []
  for (const one of models) {
    if (typeof one !== 'object' || one === null) continue
    const id = (one as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) continue
    kept.push(one as ModelInfo)
  }

  return { provider, scope, fetchedAt, models: kept }
}

export function createFileModelInfoCache(dataDir: string): ModelInfoCache {
  const dir = join(dataDir, MODEL_CACHE_DIR)

  const pathOf = (providerId: string): string => join(dir, fileNameOf(providerId))

  /** 读一份——**内部函数**（不用 `this`：解构调用时 `this` 会丢）。 */
  function readSnapshot(providerId: string): ModelInfoSnapshot | undefined {
    let text: string
    try {
      text = readFileSync(pathOf(providerId), 'utf8')
    } catch {
      // 没有 / 读不了 —— 都是「还没有那一份」，不是错
      return undefined
    }
    return parseSnapshot(text)
  }

  return {
    async read(providerId: string): Promise<ModelInfoSnapshot | undefined> {
      return readSnapshot(providerId)
    },

    async replace(snapshot: ModelInfoSnapshot): Promise<void> {
      const existing = readSnapshot(snapshot.provider)

      // **同一范围里不倒退**：更旧的一份（比如同一进程两次获取乱序落定时）不覆盖新的。
      // 范围**不同**时照收——那正是「用户改了地址 / 换了供应商」，新范围这份是当前的意图；
      // 「旧范围的晚到写入」由模型域在落定前比对范围挡掉（`model-info.ts` 的 fetchOnce）。
      if (
        existing !== undefined &&
        existing.scope === snapshot.scope &&
        existing.fetchedAt > snapshot.fetchedAt
      ) {
        return
      }

      mkdirSync(dir, { recursive: true, mode: 0o700 })

      // 原子替换：先写同目录下的临时文件，再 rename（同一文件系统内 rename 是原子的）
      const temp = `${pathOf(snapshot.provider)}.tmp-${process.pid}`
      try {
        // 仅本用户读写（缓存里有模型标识与地址范围，没有凭据）
        writeFileSync(temp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
        renameSync(temp, pathOf(snapshot.provider))
      } catch (error) {
        rmSync(temp, { force: true })
        throw error
      }
    },

    async drop(providerId: string): Promise<void> {
      // 不存在不是错（设计：连接移除 / 范围变更时废弃，重复调用无害）
      rmSync(pathOf(providerId), { force: true })
    },
  }
}
