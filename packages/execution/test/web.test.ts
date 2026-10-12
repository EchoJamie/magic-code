import { describe, expect, test } from 'bun:test'
import { createWebSource } from '../src/web.ts'

describe('网页完整读取', () => {
  test('超过原 4 MiB 上限仍读取尾部，跨块 UTF-8 字符完整保留', async () => {
    const body = `${'a'.repeat(4 * 1024 * 1024 - 1)}末尾例外：仅支持 TLS。`
    const bytes = new TextEncoder().encode(body)
    const web = createWebSource({
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
    expect(result.body).toBe(body)
    expect(result.bytes).toBe(bytes.byteLength)
  })

  test('响应流中途失败不交付已读取的前段', async () => {
    let reads = 0
    const web = createWebSource({
      fetch: async () => new Response(new ReadableStream({
        pull(controller) {
          if (reads++ === 0) controller.enqueue(new TextEncoder().encode('只读到了开头'))
          else controller.error(new Error('response interrupted'))
        },
      })),
    })

    const result = await web.fetchPage('https://example.com/broken')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('不应交付部分响应')
    expect(result.reason).toContain('response interrupted')
    expect(result).not.toHaveProperty('body')
  })

  test('服务器明确返回部分内容时拒绝提炼并释放响应', async () => {
    let canceled = false
    const web = createWebSource({
      fetch: async () => new Response(new ReadableStream({
        cancel() { canceled = true },
      }), { status: 206 }),
    })

    const result = await web.fetchPage('https://example.com/partial')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('不应交付部分响应')
    expect(result.reason).toContain('206')
    expect(canceled).toBe(true)
  })
})
