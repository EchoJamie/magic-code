/**
 * U94 · `web_fetch` —— 服务代读 → Markdown 缓存 → 按问题提炼 → 只交答案。
 *
 * 判据分五束：
 * ① **成的那一趟**：回执报「服务提供 / 不是原文 / 模型」，交出去的是答案；
 * ② **缓存**：15 分钟内同一条连接、同一地址不再取；换连接不串缓存；
 * ③ **拒**：地址不合格时零出网；`http` 升 `https`；
 * ④ **没配 Cantrip**：`halt`，且拦在取回之前；
 * ⑤ **没配网页服务**：零出网，回执说清原因。
 */

import { describe, expect, test } from 'bun:test'
import type { PageDistiller, PageFetch, WebSource, WebSearchOutcome } from '@magic/contracts'
import type { ToolDefinition } from '../src/index.ts'
import { defineWebFetchTool } from '../src/index.ts'
import type { WebServiceRef } from '../src/index.ts'
import { makeToolDeps } from './helpers.ts'

type Fetching = WebSource & { readonly asked: string[] }

function fakeWeb(reply: (url: string) => PageFetch): Fetching {
  const asked: string[] = []

  return {
    asked,
    fetchPage: (url) => {
      asked.push(url)
      return Promise.resolve(reply(url))
    },
    search: (): Promise<WebSearchOutcome> => Promise.resolve({ ok: true, results: [] }),
  }
}

function okPage(url: string, markdown = '# 定价\n\n标准版每月 12 元。'): PageFetch {
  return { ok: true, url, title: '定价', markdown }
}

const service = (web: WebSource, scope = 'test'): (() => WebServiceRef) =>
  () => ({ ok: true, web, provider: 'test', scope })

type Distilling = PageDistiller & {
  readonly asked: { url: string; page: string; prompt: string }[]
}

function fakeDistiller(answer = '标准版每月 12 元。'): Distilling {
  const asked: { url: string; page: string; prompt: string }[] = []

  return {
    asked,
    distill: (input) => {
      asked.push({ url: input.url, page: input.page, prompt: input.prompt })
      return Promise.resolve({ ok: true, answer, model: '提炼型号' })
    },
  }
}

function toolWith(options: {
  readonly web: WebSource
  readonly distiller?: Distilling | undefined
  readonly now?: () => number
}): { readonly definition: ToolDefinition; readonly deps: ReturnType<typeof makeToolDeps> } {
  const definition = defineWebFetchTool({
    web: service(options.web),
    distiller: options.distiller === undefined ? undefined : () => options.distiller,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  return { definition, deps: makeToolDeps({ tools: [definition] }) }
}

async function callWebFetch(
  deps: ReturnType<typeof makeToolDeps>,
  args: Record<string, unknown>,
): Promise<{ readonly ok: boolean; readonly output: string; readonly halt: boolean }> {
  const result = await deps.runtime.invoke({ id: 'c1', name: 'web_fetch', args }, {})
  return { ok: result.ok, output: result.output, halt: result.halt === true }
}

function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    width += wide ? 2 : 1
  }
  return width
}

describe('web_fetch ① 成的那一趟', () => {
  test('回执报服务来源与模型，并明说「不是原文」', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web, distiller: fakeDistiller(), now: () => 1_700_000_000_000 })

    const got = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '标准版多少钱？' })

    expect(got.ok).toBe(true)
    expect(got.output).toContain('https://example.com/pricing')
    expect(got.output).toContain('内容由 DeepSeek 提供')
    expect(got.output).toMatch(/\d+ms|\d+\.\d+s/u)
    expect(got.output).toContain('提炼型号')
    expect(got.output).toContain('不是原文')
    expect(got.output).toContain('没问到的')
    // 不再伪造原站状态码 / 字节数
    expect(got.output).not.toContain('200')
    expect(got.output).not.toContain('字节')
  })

  test('交给提炼的是服务给的 Markdown，问题与地址原样带上', async () => {
    const web = fakeWeb((url) => okPage(url, '# 定价\n\n标准版每月 12 元。'))
    const distiller = fakeDistiller()
    const { deps } = toolWith({ web, distiller })

    await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '标准版多少钱？' })

    const sent = distiller.asked[0]
    expect(sent?.prompt).toBe('标准版多少钱？')
    expect(sent?.url).toBe('https://example.com/pricing')
    expect(sent?.page).toBe('# 定价\n\n标准版每月 12 元。')
  })

  test('只交提炼后的答案——页面原文没有跟在后面', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web, distiller: fakeDistiller() })

    const got = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '标准版多少钱？' })

    expect(got.output).toContain('标准版每月 12 元。')
    expect(got.output).not.toContain('# 定价')
  })

  test('超过十万字符的正文及缓存命中仍完整参与提炼，长答案尾部完整回传', async () => {
    const markdown = `${'背景内容。'.repeat(25_000)}\n页面末尾例外：托管模式仅支持 TLS。`
    const answer = `${'相关说明。'.repeat(5_000)}\n结论的必要条件：仅支持 TLS。`
    const web = fakeWeb((url) => okPage(url, markdown))
    const distiller = fakeDistiller(answer)
    const { deps } = toolWith({ web, distiller })

    for (const prompt of ['适用条件是什么？', '有哪些例外？']) {
      const got = await callWebFetch(deps, { url: 'https://example.com/long', prompt })
      expect(got.ok).toBe(true)
      expect(got.output.endsWith(answer)).toBe(true)
    }

    expect(web.asked).toHaveLength(1)
    expect(distiller.asked.map((input) => input.page)).toEqual([markdown, markdown])
  })

  test('参数错：url / prompt 缺一即拒（不问取回面）', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web, distiller: fakeDistiller() })

    expect((await callWebFetch(deps, { prompt: '问什么' })).output).toContain('参数错误：url')
    expect((await callWebFetch(deps, { url: 'https://example.com' })).output).toContain('参数错误：prompt')
    expect(web.asked).toHaveLength(0)
  })
})

describe('web_fetch ② 缓存', () => {
  test('同一连接、同一地址第二次：不再取，回执说「缓存命中」', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web, distiller: fakeDistiller() })

    const first = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '标准版多少钱？' })
    const second = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '换成按月还是按年？' })

    expect(web.asked).toHaveLength(1)
    expect(first.output).not.toContain('缓存命中')
    expect(second.output).toContain('缓存命中')
  })

  test('换一个问题照旧现提炼（缓存的是页面，不是答案）', async () => {
    const web = fakeWeb((url) => okPage(url))
    const questions: string[] = []
    const distiller: Distilling = {
      asked: [],
      distill: (input) => {
        questions.push(input.prompt)
        return Promise.resolve({ ok: true, answer: `答：${input.prompt}`, model: '提炼型号' })
      },
    }
    const { deps } = toolWith({ web, distiller })

    await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })
    const second = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '支持退款吗？' })

    expect(questions).toEqual(['多少钱？', '支持退款吗？'])
    expect(second.output).toContain('答：支持退款吗？')
  })

  test('过了 15 分钟照旧再取一次', async () => {
    const web = fakeWeb((url) => okPage(url))
    let clock = 1_700_000_000_000

    const definition = defineWebFetchTool({ web: service(web), distiller: () => fakeDistiller(), now: () => clock })
    const deps = makeToolDeps({ tools: [definition] })

    await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })
    clock += 15 * 60 * 1000 + 1
    const later = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })

    expect(web.asked).toHaveLength(2)
    expect(later.output).not.toContain('缓存命中')
  })

  test('换连接（scope 变）不串缓存', async () => {
    const web = fakeWeb((url) => okPage(url))
    let scope = 'a'
    const definition = defineWebFetchTool({
      web: () => ({ ok: true, web, provider: scope, scope }),
      distiller: () => fakeDistiller(),
    })
    const deps = makeToolDeps({ tools: [definition] })

    await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })
    scope = 'b'
    const second = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })

    expect(web.asked).toHaveLength(2)
    expect(second.output).not.toContain('缓存命中')
  })
})

describe('web_fetch ③ 拒（发请求之前那一关）', () => {
  test('localhost 与无点主机名：拒，且取回面一次都没被叫', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web, distiller: fakeDistiller() })

    const local = await callWebFetch(deps, { url: 'http://localhost:8080/x', prompt: '?' })
    const dotless = await callWebFetch(deps, { url: 'https://intranet/wiki', prompt: '?' })

    expect(local.ok).toBe(false)
    expect(local.output).toContain('localhost')
    expect(dotless.ok).toBe(false)
    expect(dotless.output).toContain('没有点')
    expect(web.asked).toHaveLength(0)
  })

  test('其它协议拒、IP 字面量拒（同上：一次都没发）', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web, distiller: fakeDistiller() })

    expect((await callWebFetch(deps, { url: 'ftp://example.com/x', prompt: '?' })).output).toContain('只认 http / https')
    expect((await callWebFetch(deps, { url: 'https://127.0.0.1/x', prompt: '?' })).output).toContain('只取域名')
    expect(web.asked).toHaveLength(0)
  })

  test('`http` 一律升 `https`（发出去的是升过的那一个）', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web, distiller: fakeDistiller() })

    await callWebFetch(deps, { url: 'http://example.com/plain', prompt: '?' })

    expect(web.asked).toEqual(['https://example.com/plain'])
  })

  test('服务失败照实报，不当成「这一页没有」', async () => {
    const dead = fakeWeb(() => ({ ok: false, reason: '网页服务没有取到结果：连不上' }))
    const got = await callWebFetch(toolWith({ web: dead, distiller: fakeDistiller() }).deps, { url: 'https://example.com/x', prompt: '?' })

    expect(got.ok).toBe(false)
    expect(got.output).toContain('连不上')
  })

  test('服务成功但正文为空：报「没有可提炼的文字」', async () => {
    const empty = fakeWeb((url) => okPage(url, '   '))
    const got = await callWebFetch(toolWith({ web: empty, distiller: fakeDistiller() }).deps, { url: 'https://example.com/x', prompt: '?' })

    expect(got.ok).toBe(false)
    expect(got.output).toContain('没有可提炼的文字')
  })
})

describe('web_fetch ④ 没配提炼模型：这一轮停住', () => {
  test('`ok: false` ＋ `halt`，且拦在取回之前', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web })

    const got = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })

    expect(got.ok).toBe(false)
    expect(got.halt).toBe(true)
    expect(got.output).toContain('Cantrip 尚未配置')
    expect(got.output).toContain('/model')
    expect(web.asked).toHaveLength(0)
  })

  test('首行在 48 列以内说全「去 /model 挑一个」', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web })
    const first = (await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })).output.split('\n')[0] ?? ''

    expect(first).toContain('/model')
    expect(displayWidth(first)).toBeLessThanOrEqual(48)
  })

  test('配了但这一趟没成 ⇒ 普通失败（不 halt）', async () => {
    const web = fakeWeb((url) => okPage(url))
    const failing: Distilling = {
      asked: [],
      distill: () => Promise.resolve({ ok: false, kind: 'failed', reason: '连不上' }),
    }
    const { deps } = toolWith({ web, distiller: failing })

    const got = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })

    expect(got.ok).toBe(false)
    expect(got.halt).toBe(false)
    expect(got.output).toContain('连不上')
  })
})

describe('web_fetch ⑤ 没配网页服务', () => {
  test('工具不可用（不进模型工具表），在途调用零出网并说清原因', async () => {
    const web = fakeWeb((url) => okPage(url))
    const definition = defineWebFetchTool({
      web: () => ({ ok: false, reason: '网页服务尚未配置——去 /web 选择连接' }),
      distiller: () => fakeDistiller(),
    })
    const deps = makeToolDeps({ tools: [definition] })

    expect(deps.runtime.definitions().map((one) => one.name)).not.toContain('web_fetch')
    const got = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })

    expect(got.ok).toBe(false)
    expect(got.output).toContain('尚未配置')
    expect(web.asked).toHaveLength(0)
  })
})
