/**
 * U94 · DeepSeek 网页服务客户端——完整读取、结构校验、错误分类与取消。
 *
 * 判据不在「抓得对不对」（那是可信服务的职责），而在 Magic 自己负责的那一段：
 * 响应完整接收、合法 JSON、失败如实分档、地址不合格时零出网。
 */

import { describe, expect, test } from 'bun:test'
import { createWebSource } from '../src/web.ts'

const KEY = 'test-key'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('Fetch：完整读取与结构校验', () => {
  test('大正文完整读取，跨块 UTF-8 字符保留', async () => {
    const markdown = `${'a'.repeat(4 * 1024 * 1024 - 1)}末尾例外：仅支持 TLS。`
    const bytes = new TextEncoder().encode(JSON.stringify({ title: '长页', content: markdown }))
    const web = createWebSource({
      apiKey: KEY,
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 4 * 1024 * 1024))
          controller.enqueue(bytes.slice(4 * 1024 * 1024))
          controller.close()
        },
      })),
    })

    const result = await web.fetchPage('https://example.com/long')

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.markdown).toBe(markdown)
    expect(result.title).toBe('长页')
  })

  test('响应流中途失败不交付已读取的前段', async () => {
    let reads = 0
    const web = createWebSource({
      apiKey: KEY,
      fetch: async () => new Response(new ReadableStream({
        pull(controller) {
          if (reads++ === 0) controller.enqueue(new TextEncoder().encode('{"title":"x","content":"开头'))
          else controller.error(new Error('response interrupted'))
        },
      })),
    })

    const result = await web.fetchPage('https://example.com/broken')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('不应交付部分响应')
    expect(result.reason).toContain('response interrupted')
    expect(result).not.toHaveProperty('markdown')
  })

  test('200 但 JSON 损坏 / 缺 content ⇒ 协议失败', async () => {
    const broken = createWebSource({ apiKey: KEY, fetch: async () => new Response('not json', { status: 200 }) })
    const missing = createWebSource({ apiKey: KEY, fetch: async () => json(200, { title: 'x' }) })

    expect((await broken.fetchPage('https://example.com/a')).ok).toBe(false)
    const got = await missing.fetchPage('https://example.com/a')
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.reason).toContain('结构损坏')
  })

  test('服务拒绝时按状态说人话，不断言原站状态', async () => {
    const web = createWebSource({ apiKey: KEY, fetch: async () => json(404, {}) })
    const result = await web.fetchPage('https://example.com/missing')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('404')
      expect(result.reason).toContain('不代表原页面不存在')
    }
  })

  test('3xx 不跟随（凭据不离开固定服务域）', async () => {
    const web = createWebSource({
      apiKey: KEY,
      fetch: async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }),
    })
    const result = await web.fetchPage('https://example.com/a')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('未跟随')
  })

  test('地址不合格 / 缺少凭据：零出网', async () => {
    let calls = 0
    const web = createWebSource({ apiKey: KEY, fetch: async () => { calls += 1; return json(200, { content: 'x' }) } })
    const noKey = createWebSource({ apiKey: '  ', fetch: async () => { calls += 1; return json(200, { content: 'x' }) } })

    expect((await web.fetchPage('http://localhost:8080/x')).ok).toBe(false)
    expect((await web.fetchPage('https://127.0.0.1/x')).ok).toBe(false)
    expect((await noKey.fetchPage('https://example.com/x')).ok).toBe(false)
    expect(calls).toBe(0)
  })

  test('请求体只有 url（prompt 不发给网页服务）', async () => {
    let body: unknown
    const web = createWebSource({
      apiKey: KEY,
      fetch: async (_input, init) => { body = JSON.parse(String(init?.body)); return json(200, { title: '', content: '正文' }) },
    })

    await web.fetchPage('http://example.com/a')

    expect(body).toEqual({ url: 'https://example.com/a' })
  })
})

describe('Search：逐条资料、need_content=false', () => {
  test('发送 query 与 need_content=false，按返回顺序组织逐条字段', async () => {
    let body: unknown
    const web = createWebSource({
      apiKey: KEY,
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return json(200, {
          results: [
            { title: 'A', url: 'https://a', date: '2026-10-19T00:00:00Z', summary: '摘要 A', snippet: '忽略', rerank_score: 2 },
            { title: null, url: 'https://b', date: null, summary: '' },
          ],
        })
      },
    })

    const result = await web.search({ query: '查什么' })

    expect(body).toEqual({ query: '查什么', need_content: false })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.results).toEqual([
      { title: 'A', url: 'https://a', date: '2026-10-19T00:00:00Z', summary: '摘要 A' },
      { title: '', url: 'https://b' },
    ])
  })

  test('结构损坏（缺 results / 某条缺链接）⇒ 失败', async () => {
    const noResults = createWebSource({ apiKey: KEY, fetch: async () => json(200, {}) })
    const noUrl = createWebSource({ apiKey: KEY, fetch: async () => json(200, { results: [{ title: 'x' }] }) })

    expect((await noResults.search({ query: 'q' })).ok).toBe(false)
    const got = await noUrl.search({ query: 'q' })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.reason).toContain('结构损坏')
  })

  test('空结果是一份合法结果（不是失败）', async () => {
    const web = createWebSource({ apiKey: KEY, fetch: async () => json(200, { results: [] }) })
    const result = await web.search({ query: 'q' })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.results).toEqual([])
  })
})
