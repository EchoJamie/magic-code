/**
 * U72 · 取网页的判定规则（`web.ts`）——**一处定、两处用**的那一份。
 *
 * 为什么这些规则值一组用例：它们是**产品规则**（设计 · 网页与搜索「已定的取舍」），
 * 而消费它的有**两处**——工具执行体（发请求之前那一关）与权限域（算「发给哪个域名」）。
 * 两处各写一遍就是两套「什么叫合法地址」：审核展示的那个域名与实际发出去的那个
 * 从此可以不相等，而两边都「看着对」。故规则本身在这儿钉死。
 */

import { describe, expect, test } from 'bun:test'
import { WEB_CACHE_TTL_MS, webTargetOf } from '../src/index.ts'

/** 取得到的那一支——取不到就当场炸（用例里这是「本该取到」）。 */
function targetOf(raw: string): Extract<ReturnType<typeof webTargetOf>, { ok: true }> {
  const got = webTargetOf(raw)
  if (!got.ok) throw new Error(`本该取得到，实际拒了：${got.reason}`)
  return got
}

/** 取不到的那一支——取到了就当场炸。 */
function refusalOf(raw: string): string {
  const got = webTargetOf(raw)
  if (got.ok) throw new Error(`本该拒，实际取到了：${got.url}`)
  return got.reason
}

describe('U72 · 取网页的地址判定', () => {
  test('http 一律升 https（主机与路径原样）', () => {
    expect(targetOf('http://example.com/a/b?q=1')).toEqual({
      ok: true,
      url: 'https://example.com/a/b?q=1',
      host: 'example.com',
    })
  })

  test('https 原样，域名归一成小写', () => {
    expect(targetOf('https://Example.COM/Path').host).toBe('example.com')
  })

  test('没写协议按 https 办（「取网页」只有这一种合理默认）', () => {
    expect(targetOf('example.com/x').url).toBe('https://example.com/x')
  })

  test('域名取的是主机名那一格——**不含端口、不含路径**（卡上写的就是它）', () => {
    expect(targetOf('https://example.com:8443/x').host).toBe('example.com')
  })

  test('凭据摘掉（口令不随这一趟发到第三方站点去）', () => {
    const got = targetOf('https://user:secret@example.com/x')
    expect(got.url).toBe('https://example.com/x')
    expect(got.url).not.toContain('secret')
  })

  test('本机地址一律拒（含各级子域）', () => {
    expect(refusalOf('http://localhost:8080/x')).toContain('localhost')
    expect(refusalOf('https://a.localhost/x')).toContain('localhost')
  })

  test('无点主机名一律拒', () => {
    expect(refusalOf('https://intranet/wiki')).toContain('没有点')
    expect(refusalOf('http://router/')).toContain('没有点')
  })

  test('IP 字面量拒（`127.0.0.1` 有「点」，却正是要挡的那一个）', () => {
    expect(refusalOf('https://127.0.0.1/x')).toContain('IP')
    expect(refusalOf('https://192.168.1.1/')).toContain('IP')
    expect(refusalOf('https://[::1]/')).toContain('IP')
  })

  test('只认 http / https（不接任意协议）', () => {
    expect(refusalOf('ftp://example.com/x')).toContain('只认 http / https')
    expect(refusalOf('file:///etc/passwd')).toContain('只认 http / https')
    expect(refusalOf('data:text/html,hi')).toContain('只认 http / https')
  })

  test('空 / 解析不出的都不放行（且各说各的缘由）', () => {
    expect(refusalOf('')).toContain('参数错误')
    expect(refusalOf('https://')).toContain('不是一个能用的网址')
  })

  test('缓存时长是 15 分钟（参照面那个数）', () => {
    expect(WEB_CACHE_TTL_MS).toBe(15 * 60 * 1000)
  })
})
