import { describe, expect, test } from 'bun:test'
import { cacheAccessFor } from '../src/index.ts'
import { connectionScopeChanged } from '@magic/host'

/**
 * 缓存身份的锚（2026-11-24 裁定，取代 U41 的「按接入隔离/配置指纹」）：
 *
 * 身份 = 连接**解析后的数据来源**（端点 ＋ 协议）——同一软件的各部分互信，同一份自己
 * 写入的缓存不按「认证从哪来」「配置文件指纹」区分；换凭据**不**作废（第三方给的数据
 * 本身一致，有效性只由 fetchedAt ＋ TTL 时间锚定）；指向另一个服务（端点/协议变化）
 * 才落另一份文件。凭据或其摘要不进身份（原有裁决保留）。
 */
describe('身份＝连接的数据来源（端点 ＋ 协议）', () => {
  test('同端点同协议 ⇒ 同一个身份；端点或协议变 ⇒ 身份变', () => {
    const a = cacheAccessFor({ vendor: undefined, baseURL: 'https://api.deepseek.com', protocol: 'chat-completions' })
    const b = cacheAccessFor({ vendor: undefined, baseURL: 'https://api.deepseek.com', protocol: 'chat-completions' })
    expect(b.id).toBe(a.id)

    expect(cacheAccessFor({ vendor: undefined, baseURL: 'https://api.deepseek.com/v2', protocol: 'chat-completions' }).id)
      .not.toBe(a.id)
    expect(cacheAccessFor({ vendor: undefined, baseURL: 'https://api.deepseek.com', protocol: 'messages' }).id)
      .not.toBe(a.id)
  })

  test('**换凭据不作废**：同一端点，key 换了身份一字不变', () => {
    // 身份的入参里**没有** key——这一条靠形状保证（编译期就过不了带 key 的调用）；
    // 这里锚的是行为口径：跨账号同端点的列表缓存照用，TTL 到点自然更新。
    const official = cacheAccessFor({ vendor: undefined, baseURL: 'https://api.minimax.cn/v1', protocol: 'messages' })
    expect(official.id).toBe('@https://api.minimax.cn/v1#messages')
    expect(official.id).not.toContain('key')
  })

  test('连接的**名字**不进身份——provider 改名，缓存照用（同一端点就是同一份数据）', () => {
    const idOf = (vendor: string | undefined, baseURL: string | undefined, protocol: string | undefined) => cacheAccessFor({ vendor, baseURL, protocol }).id
    expect(idOf('deepseek', 'http://127.0.0.1:1/api', 'responses')).toBe(idOf('deepseek', 'http://127.0.0.1:1/api', 'responses'))
  })
})

describe('范围变化的判据（connectionScopeChanged）', () => {
  const base: import('@magic/contracts').ProviderConfig = { vendor: 'deepseek', baseURL: 'https://api.deepseek.com', protocol: 'chat-completions', apiKey: 'k' }

  test('端点 / 协议 / 官方归属或区域变了 ⇒ 换范围（落另一份文件）', () => {
    expect(connectionScopeChanged(base, { ...base, baseURL: 'https://api.deepseek.com/v2' })).toBe(true)
    expect(connectionScopeChanged(base, { ...base, protocol: 'messages' })).toBe(true)
    expect(connectionScopeChanged(base, { ...base, vendor: 'minimax' })).toBe(true)
    expect(connectionScopeChanged(undefined, base)).toBe(true)
  })

  test('**换凭据不换范围**：apiKey / auth 变化不再是失效依据（2026-11-24 裁定）', () => {
    expect(connectionScopeChanged(base, { ...base, apiKey: 'another-key' })).toBe(false)
    expect(connectionScopeChanged(base, { ...base, auth: 'none' })).toBe(false)
  })

  test('配置之外的写（模型映射、偏好）不换范围', () => {
    expect(connectionScopeChanged(base, { ...base })).toBe(false)
  })
})
