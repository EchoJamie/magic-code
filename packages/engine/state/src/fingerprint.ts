import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'

/**
 * 配置文件的**认证来源指纹**——模型缓存的接入身份（「这个连接的 key 来自哪一份认证材料」）。
 *
 * ⚠️ **只看 `providers` 段的内容**（2026-11-22 收窄）：身份哈希取自连接表的序列化，
 * 认证材料（key / auth / 地址）变了才轮转。模型映射、界面偏好、开局档位记录这类
 * **非认证写**不改变身份——否则每次 /model 切档都会把模型缓存打成冷的。
 * 旧形（整文件 stat 六件）的问题正是：任何配置写都轮转，缓存范围跟着配置写陪葬。
 */
export type ConfigFingerprint = {
  /** 配置文件的**绝对路径**（已展开）——认「是哪一个文件」。 */
  readonly path: string
  /** `providers` 段的内容哈希——认证材料变了才变。 */
  readonly hash: string
}

/** 取一份指纹——文件不在 / 读不了 / 不是合法 JSON ⇒ `undefined`（**没有可信身份**，调用方据此不读共享盘）。 */
export function configFingerprintOf(path: string): ConfigFingerprint | undefined {
  try {
    // **规范路径**：同一个文件的两种写法（软链 / 带 `..` / 相对）必须算出**同一个身份**
    // ——否则同一个配置会被当成两个范围，缓存白丢一份
    const real = realpathSync(path)
    const raw = JSON.parse(readFileSync(real, 'utf8')) as { providers?: unknown }
    const providers = raw.providers === undefined ? {} : raw.providers
    const hash = createHash('sha256').update(JSON.stringify(providers)).digest('hex')
    return { path: real, hash }
  } catch {
    return undefined
  }
}

/** 原生与终端共用文件比较依据——**整文件变更**都算（与认证指纹分工：那个只看 providers 段内容）。 */
export function configStamp(path: string): string | null {
  try {
    const real = realpathSync(path)
    const stat = statSync(real, { bigint: true })
    return `${real}:${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`
  } catch {
    return null
  }
}
