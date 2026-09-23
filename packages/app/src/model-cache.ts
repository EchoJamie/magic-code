/**
 * 模型信息缓存 —— 盘上那一份（U41 · 装配根提供 `ModelInfoCache` 端口的实现）。
 *
 * 出处：设计 · 模型与上下文「数据与持久化」：
 * 「`app` 提供 `<dataDir>/cache/models/` 下独立连接文件的实现：安全编码文件名 ·
 * 仅本用户读写 · 临时文件后原子替换。缓存损坏可丢弃重取，不新增数据库、迁移账或版本对照系统。」
 *
 * ## 按「连接 ＋ 接入身份」隔离存储（缓存接口裁决）
 *
 * 文件名 = `<provider 编码>.<accessId 编码>.json`——**范围进了文件名**。
 * 于是「旧范围的迟到写入」写的是**它自己那份**，读只认**当前范围**那份：
 * 两边根本不相遇。**不需要撤销黑名单，也不拿时间戳当范围**——
 * 判据不再回答「这份还作不作数」，而是「读的是不是该读的那一份」。
 *
 * ⚠️ **旧范围的文件残留在盘上没关系**：那是**可重建的缓存**，不是当前范围的资料。
 * 读到它等于没读到（读的时候根本不会去开它），**不为删净它造迁移账**。
 *
 * ## 四条纪律
 *
 * - **文件名安全编码**——连接 id 是用户自由命名的（可能有 `/` · `..` · 中文），
 *   身份也一样；故都先 base64url 再落盘；**不用密钥或密钥摘要作标识**（设计明文）；
 * - **原子替换**——写临时文件再 `rename`：读到的要么是上一份完整的、要么是这一份完整的；
 * - **同范围内「读—比—换」有并发保护**——见 `withLock`；
 * - **损坏可丢弃 / 失败可见**——读不懂就当没有（可删除重建）；写不进、清不掉则**抛出**。
 *
 * ⚠️ 本文件在装配根（`app`），不在模型域：域不碰 fs（内核 fs 纪律）。
 */

import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelCacheAccess, ModelInfo, ModelInfoCache, ModelInfoSnapshot } from '@magic/contracts'

/** 缓存目录名（相对数据目录）——`<dataDir>/cache/models/`。 */
export const MODEL_CACHE_DIR = join('cache', 'models')

/** 等锁的上限与自旋间隔——等不到就**抛出**（清除/写入失败要可见，不吞）。 */
export const MODEL_CACHE_LOCK_WAIT_MS = 2_000
const LOCK_RETRY_MS = 5

/**
 * 一段标识 → **定长**的文件名一节。
 *
 * 由头两条，缺一不可：
 * - **安全**：连接 id 与接入身份都可能含 `/`、`..`、空白、中文——直接拼进路径既会跑出目录，
 *   也会在别人的文件系统上撞名字；
 * - **不长**：接入身份里带着**配置文件的绝对路径 ＋ 纳秒 ＋ 大小**，路径一深就上百字节，
 *   再按 base64url 膨胀四分之三 ⇒ 文件名撑爆 `NAME_MAX`（255）——**实测会 `ENAMETOOLONG`**，
 *   连锁文件都建不出来（`真长目录` 那条用例钉的就是它）。
 *
 * 故取 sha256 的前 16 字节（base64url，22 字符）：**定长、文件名安全**。
 *
 * ⚠️ **不是「对密钥做摘要」**：两段输入（连接 id、接入身份）本来就**不含密钥或其摘要**，
 * 摘的是「哪一个连接 / 哪一份接入范围」这个**非凭据**标记——设计禁的是**把凭据或其摘要
 * 落盘**，那一条照旧守死。
 */
function slugOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('base64url').slice(0, 22)
}

/** 一个范围一份文件——两段都定长，文件名恒为 50 字节。 */
function fileNameOf(providerId: string, accessId: string): string {
  return `${slugOf(providerId)}.${slugOf(accessId)}.json`
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

  const pathOf = (providerId: string, accessId: string): string =>
    join(dir, fileNameOf(providerId, accessId))

  /** 读一份——**内部函数**（不用 `this`：解构调用时 `this` 会丢）。 */
  function readSnapshot(path: string): ModelInfoSnapshot | undefined {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      // 没有 / 读不了 —— 都是「还没有那一份」，不是错
      return undefined
    }
    return parseSnapshot(text)
  }

  /**
   * 把一个范围内的「读盘上那份 → 比新旧 → 原子替换」串起来。
   *
   * 为什么要有它：**「传两个相同字符串比一下再 rename」不是原子条件提交**——比较与替换之间
   * 那个窗口里，另一个写者可以插进来把两边都写花（或丢掉一次更新）。故用 `O_EXCL` 建锁文件
   * 做**跨进程**互斥（同一文件系统上的 `wx` 是原子的）：拿到锁才进那段，出来就放。
   *
   * 拿不到就有界自旋；等过 `MODEL_CACHE_LOCK_WAIT_MS` **抛出**——缓存写入失败要看得见，
   * 不静默丢。
   *
   * ⚠️ **限度**：锁文件在进程崩溃时会残留（没有陈旧锁回收）。缓存可重建，故这里不为它
   * 再叠一套租约/看门狗——等满就抛，由调用方如实报。
   */
  async function withLock<T>(path: string, body: () => T | Promise<T>): Promise<T> {
    mkdirSync(dir, { recursive: true, mode: 0o700 })

    const lock = `${path}.lock`
    const deadline = Date.now() + MODEL_CACHE_LOCK_WAIT_MS
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx'))
        break
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'EEXIST') throw error
        if (Date.now() >= deadline) throw new Error(`等不到缓存锁：${lock}`)
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
      }
    }

    try {
      return await body()
    } finally {
      rmSync(lock, { force: true })
    }
  }

  return {
    async read(providerId: string, access?: ModelCacheAccess): Promise<ModelInfoSnapshot | undefined> {
      // **不落盘的那一类**（环境变量来源）：盘上没有它的东西，去读只会读到别人的；
      // **没有身份**同理——过渡期 `access` 可选只为分线各自编译得过，**不是「按老样子读」**
      if (access === undefined || !access.persistent) return undefined

      return readSnapshot(pathOf(providerId, access.id))
    },

    async replace(snapshot: ModelInfoSnapshot, access?: ModelCacheAccess): Promise<void> {
      // 同上：不跨进程复用 / 没有身份 —— 都不落盘（进程内那份走内存，不归这里）
      if (access === undefined || !access.persistent) return

      const path = pathOf(snapshot.provider, access.id)
      await withLock(path, () => {
        // **只在本范围内比新旧**：范围之外那份是别人的，不参与这条判据
        const existing = readSnapshot(path)
        if (existing !== undefined && existing.fetchedAt > snapshot.fetchedAt) return

        // 原子替换：先写同目录下的临时文件，再 rename（同一文件系统内 rename 是原子的）
        const temp = `${path}.tmp-${process.pid}`
        try {
          // 仅本用户读写（缓存里有模型标识与地址范围，没有凭据）
          writeFileSync(temp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
          renameSync(temp, path)
        } catch (error) {
          rmSync(temp, { force: true })
          throw error
        }
      })
    },

    async drop(providerId: string, access?: ModelCacheAccess): Promise<void> {
      // 没有身份就不知道该清哪一份——**不猜、也不顺手清别的范围**
      if (access === undefined || !access.persistent) return

      // **只删本范围那份**：旧认证 / 别的进程那份不归这次清除管——
      // 「旧范围的清除不能碰到新范围」也靠这里
      const path = pathOf(providerId, access.id)
      await withLock(path, () => {
        // 不存在不是错（连接移除 / 范围变更时废弃，重复调用无害）
        rmSync(path, { force: true })
      })
    },
  }
}
