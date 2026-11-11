import { realpathSync, statSync } from 'node:fs'

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

/** 原生与终端共用文件比较依据；复用配置指纹，不包含内容或凭据摘要。 */
export function configStamp(path: string): string | null {
  const f = configFingerprintOf(path)
  return f === undefined ? null : `${f.path}:${f.dev}:${f.ino}:${f.mtimeNs}:${f.ctimeNs}:${f.size}`
}
