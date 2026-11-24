import { realpathSync, statSync } from 'node:fs'

/**
 * **文件比较依据**（`configStamp`）——原生与终端共用的「配置在我读取后有没有被改过」判据
 * （保存冲突检测）。它**只**用于写盘竞争的核对：缓存身份早已不在这里——缓存按连接的
 * 数据来源（端点 ＋ 协议）锚定，见 `@magic/host` 的 `cacheAccessFor`（2026-11-24 裁定）。
 */

/** 原生与终端共用文件比较依据——**整文件变更**都算（保存冲突检测；与缓存身份分工）。 */
export function configStamp(path: string): string | null {
  try {
    const real = realpathSync(path)
    const stat = statSync(real, { bigint: true })
    return `${real}:${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`
  } catch {
    return null
  }
}
