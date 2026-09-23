/**
 * 接入身份 —— 缓存按它隔离存储（U41 返修 · 缓存接口裁决）。
 *
 * 出处：工单「缓存接口裁决」＋ 缓存线的方案（`交接/回报/U41-缓存返修.md` 第二节）。
 * 本文件只做**身份的计算**（契约的**形状**在 `@magic/contracts` · `ModelCacheAccess`）；
 * **缓存实现的 scoped 读写与发布前的身份核对归缓存线**（本线不碰那两个文件）。
 *
 * ## 为什么不是一个「连接 id ＋ 时间戳」
 *
 * 两份**不同的接入**（换了凭据 / 换了端点 / 换了整个配置文件）绝不能共用一份缓存，
 * 否则旧范围的结果会冒充新范围的当前资料。裁决要求：
 *
 * - **配置来源**——身份要**由同一个文件跨进程推出同一个值**，且要**区分配置文件本身
 *   及其变更**。故指纹含六件：路径（**哪一个文件**）＋ `dev` / `ino`（**是不是同一个
 *   inode**）＋ `mtimeNs` / `ctimeNs` / `size`（**它变过没有**）。
 *
 *   ⚠️ **只取路径 ＋ mtime ＋ size 不够**：一个**等长**、又被刻意**保留 mtime** 的新文件
 *   会算出同一个身份——而它可能装的是另一把 key。`ino` 认「换了文件」，`ctimeNs` 认
 *   「inode 变过」（写内容会推 ctime，即使 mtime 被保留）。**不需要 hash、也不需要 key
 *   或其摘要**（裁决明文：不含凭据）。
 *
 * - **环境变量来源**——没有可验证的共同身份（另一个进程的 env 是另一回事），
 *   故 `persistent: false`：**不落盘**，进程内照常复用。
 *
 * ⚠️ **本文件只算身份**：装配把它交给缓存端口（`ModelInfoCache` 的 `access`）与连接资料
 * （`ModelConnection.access`，那一格由缓存线加）——**在缓存实现消费它之前**，读面按
 * 「缺可信身份不读共享盘」处理，不得声称隔离已完成。
 */

import { realpathSync, statSync } from 'node:fs'
import type { ModelCacheAccess } from '@magic/contracts'

/**
 * 配置文件的可观察指纹——**六件**（见文件头注的由头）。
 *
 * 全部用 `bigint`：`ino` / `mtimeNs` 在真机器上超 `Number.MAX_SAFE_INTEGER` 是常事
 * （`statSync(path, { bigint: true })` 直接给大整数）。
 */
export type ConfigFingerprint = {
  /** 配置文件的**绝对路径**（已展开）——认「是哪一个文件」。 */
  readonly path: string
  readonly dev: bigint
  readonly ino: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
  readonly size: bigint
}

/** 取一份指纹——文件不在 / 读不了 ⇒ `undefined`（**没有可信身份**，调用方据此不读共享盘）。 */
export function configFingerprintOf(path: string): ConfigFingerprint | undefined {
  try {
    // **规范路径**：同一个文件的两种写法（软链 / 带 `..` / 相对）必须算出**同一个身份**
    // ——否则同一个配置会被当成两个范围，缓存白丢一份
    const real = realpathSync(path)
    const stat = statSync(real, { bigint: true })
    return {
      path: real,
      dev: stat.dev,
      ino: stat.ino,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      size: stat.size,
    }
  } catch {
    return undefined
  }
}

/**
 * 算一条连接的**接入身份**。
 *
 * - 认证**取自配置文件**（且有指纹）⇒ `cfg:…`，`persistent: true`——同一个文件在
 *   另一个进程里算出同一个串，故那份缓存跨进程可复用；
 * - 其余（认证走**环境变量**回退、或配置文件此刻不可观察）⇒ `env:…`，`persistent: false`
 *   ——**不落盘**：另一个进程的环境变量是另一回事，没有共同身份可言。
 *
 * ⚠️ **不含密钥或其摘要**（裁决明文）；`processToken` 由装配在**本进程**生成一次，
 * 只作「这不是别的进程」的标记——它进不了磁盘文件名以外的任何地方。
 */
export function modelCacheAccessOf(input: {
  /** 连接 id（`providers` 的键）。 */
  readonly provider: string
  /** 配置文件此刻的指纹——**只有认证取自配置文件时**才是可信身份。 */
  readonly config?: ConfigFingerprint | undefined
  /** 本进程的唯一值（环境变量来源用）。 */
  readonly processToken: string
}): ModelCacheAccess {
  if (input.config !== undefined) {
    const f = input.config
    // 逐件写上：**路径认文件、dev/ino 认 inode、三个时刻 ＋ 字节认变更**
    return {
      id: `cfg:${input.provider}:${f.path}:${f.dev}:${f.ino}:${f.mtimeNs}:${f.ctimeNs}:${f.size}`,
      persistent: true,
    }
  }

  return { id: `env:${input.provider}:${input.processToken}`, persistent: false }
}
