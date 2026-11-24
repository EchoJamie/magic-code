/**
 * 缓存的**接入身份** —— 按**连接的数据来源**锚定（2026-11-24 裁定，取代 U41 的
 * 「按接入隔离/配置指纹」）。
 *
 * ## 为什么是「端点 ＋ 协议」而不是指纹
 *
 * 同一软件的各部分（CLI / TUI / macOS 原生）读写**同一份**自己写入的缓存——写方与读方
 * **相互信任**，不存在「自己怀疑自己」的校验。缓存真正要锚的只有三件：
 *
 * - **数据来源一致**——身份取连接**解析后的服务端点 ＋ 协议**：同一个第三方端点给的就是
 *   同一份数据；端点或协议变了（指向了另一个服务、另一种解析），自然落另一份文件；
 * - **落盘结构一致**——读写的 JSON 结构由本软件唯一定义（TS 与原生共用同一套契约与
 *   vendor 资料），解析结果天然一致；
 * - **有效性由时间锚定**——`fetchedAt` ＋ TTL 判过期，过期就重拉。
 *
 * 「换凭据作废」「配置写一下就轮转」**不是**这份缓存的语义——凭据或其摘要**不进**身份
 * 与文件名（原有裁决保留），换 key 后同一端点的列表照用，TTL 到点自然更新。
 */

import type { ModelCacheAccess, ProviderConfig } from '@magic/contracts'

/**
 * 算一条连接的**缓存身份**——身份串 = **scope**（`<vendor>@<端点>#<协议>`，与 Swift 的
 * `scope(config)`、模型域的 `scopeOf` 同一个形状；protocol 缺省记 `auto`）：简单字符串，
 * 两端各自 sha256 编码进文件名，天然逐字节一致。
 */
export function cacheAccessFor(input: {
  /** 连接的官方归属（自定义连接为 `undefined`）。 */
  readonly vendor: string | undefined
  /** 连接**解析后**的服务端点（官方 vendor 的缺省端点也算解析过）。 */
  readonly baseURL: string | undefined
  /** 连接的调用协议。 */
  readonly protocol: string | undefined
}): ModelCacheAccess {
  return { id: `${input.vendor ?? ''}@${input.baseURL ?? '未解析'}#${input.protocol ?? 'auto'}` }
}

/** 连接指向的**服务**变了（端点 / 协议 / 官方归属与区域）才换缓存范围；换凭据不换。 */
export function connectionScopeChanged(before: ProviderConfig | undefined, after: ProviderConfig | undefined): boolean {
  return before === undefined || after === undefined || before.vendor !== after.vendor || before.baseURL !== after.baseURL || before.region !== after.region || before.protocol !== after.protocol
}
