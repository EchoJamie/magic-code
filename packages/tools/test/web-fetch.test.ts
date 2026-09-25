/**
 * U72 · `web_fetch` —— 取回 → 转 markdown → 按问题提炼 → 只回答案。
 *
 * 判据分四束（各对工单的一句话）：
 *
 * | 束 | 咬住的 |
 * | --- | --- |
 * | ① **成的那一趟** | 回执里有状态码 / 字节数 / 耗时 / 用的哪个模型**那一句「不是原文」**；交出去的是**提炼后的答案**，不是页面 |
 * | ② **缓存** | 15 分钟内同一地址不再取网；**命中要说一声**，且不报取回耗时 |
 * | ③ **拒** | `localhost` / 无点主机名 / 非 http(s) **发请求之前**就拒；`http` 升 `https`；跨主机重定向**不跟**且说清去处 |
 * | ④ **没配** | `ok: false` ＋ **`halt`**（这一轮停住）＋ 两句话（模型看得到、用户看得到） |
 *
 * ⚠️ **第三束里那条「发请求之前」是可数的**：假取回面记下它被叫了几次——
 * 拒掉的那些**一次都不许有**（只断言正文里写了「取不得」，判不出它有没有真发出去）。
 */

import { describe, expect, test } from 'bun:test'
import type { PageDistiller, PageFetch, WebSource } from '@magic/contracts'
import type { ToolDefinition } from '../src/index.ts'
import { defineWebFetchTool } from '../src/index.ts'
import { makeToolDeps } from './helpers.ts'

// ══ 两个替身（都记下自己被怎么使唤的）══════════════════════════════════

type Fetching = WebSource & {
  readonly asked: string[]
  readonly pages: PageFetch[]
}

function fakeWeb(reply: (url: string) => PageFetch): Fetching {
  const asked: string[] = []
  const pages: PageFetch[] = []

  return {
    asked,
    pages,
    fetchPage: (url) => {
      asked.push(url)
      const page = reply(url)
      pages.push(page)
      return Promise.resolve(page)
    },
  }
}

/** 一页 HTML——转出来应当是 markdown（标题成 `#`、标签不见）。 */
const HTML = '<html><head><title>定价</title></head><body><h1>定价</h1><p>标准版每月 <b>12</b> 元。</p></body></html>'

function okPage(url: string, body = HTML, status = 200): PageFetch {
  return { ok: true, url, status, bytes: Buffer.byteLength(body), body, contentType: 'text/html' }
}

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

/** 一个造好的 `web_fetch`（默认配好提炼面；`distiller` 给 `undefined` ＝ 没配）。 */
function toolWith(options: {
  readonly web: WebSource
  readonly distiller?: Distilling | undefined
  readonly now?: () => number
}): { readonly definition: ToolDefinition; readonly deps: ReturnType<typeof makeToolDeps> } {
  const definition = defineWebFetchTool({
    web: options.web,
    distiller: options.distiller === undefined ? undefined : () => options.distiller,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  return { definition, deps: makeToolDeps({ tools: [definition] }) }
}

/** 一次调用（走真分发：注册表 → 闸门 → 执行体 → 回填）。 */
async function callWebFetch(
  deps: ReturnType<typeof makeToolDeps>,
  args: Record<string, unknown>,
): Promise<{ readonly ok: boolean; readonly output: string; readonly halt: boolean }> {
  const result = await deps.runtime.invoke({ id: 'c1', name: 'web_fetch', args }, {})

  return { ok: result.ok, output: result.output, halt: result.halt === true }
}

/**
 * 显示宽度——**全角算 2 列**（与外壳那一侧 `displayWidth` 同一口径的最小版）。
 *
 * 用例里只需要它做一件事：量一量那句话在终端上占几列。取最小版而不是引外壳的实现，
 * 是因为工具域与 `@magic/tui` 之间没有依赖、也不该有（域间只经契约）。
 */
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

// ═══════════════════════════════════════════════════════════════════════

describe('U72 · web_fetch ① 成的那一趟', () => {
  test('回执齐四件（状态码 / 字节数 / 耗时 / 模型）＋ 那句「不是原文」', async () => {
    const web = fakeWeb((url) => okPage(url))
    const distiller = fakeDistiller()
    const { deps } = toolWith({ web, distiller, now: () => 1_700_000_000_000 })

    const got = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '标准版多少钱？' })

    expect(got.ok).toBe(true)
    expect(got.output).toContain('https://example.com/pricing')
    expect(got.output).toContain('200')
    expect(got.output).toContain('字节') // 字节数（这一页很小，按字节报）
    expect(got.output).toMatch(/\d+ms|\d+\.\d+s/u) // 耗时
    expect(got.output).toContain('提炼型号') // 用的哪个模型（说不出来就只能猜）
    // ⚠️ 工单③：**这句必须字面在回执里**——「没问到」读成「没有」是最坏的那种误读
    expect(got.output).toContain('不是原文')
    expect(got.output).toContain('没问到的')
  })

  test('交给提炼的是**转成 markdown 的正文**（不是原始 HTML），问题原样带上', async () => {
    const web = fakeWeb((url) => okPage(url))
    const distiller = fakeDistiller()
    const { deps } = toolWith({ web, distiller })

    await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '标准版多少钱？' })

    const sent = distiller.asked[0]
    expect(sent?.prompt).toBe('标准版多少钱？')
    expect(sent?.url).toBe('https://example.com/pricing')
    // 标签不见了、标题成了 `#`——转 markdown 真的做了
    expect(sent?.page).toContain('# 定价')
    expect(sent?.page).not.toContain('<h1>')
    expect(sent?.page).not.toContain('<body>')
  })

  test('只交提炼后的答案——**页面原文没有跟在后面**（省上下文这一条的字面判据）', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web, distiller: fakeDistiller() })

    const got = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '标准版多少钱？' })

    expect(got.output).toContain('标准版每月 12 元。') // 答案在
    expect(got.output).not.toContain('<html>') // 原文不在
    expect(got.output).not.toContain('# 定价') // 连转出来的整页也不在
  })

  test('参数错：url / prompt 缺一即拒（不问取回面）', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web, distiller: fakeDistiller() })

    expect((await callWebFetch(deps, { prompt: '问什么' })).output).toContain('参数错误：url')
    expect((await callWebFetch(deps, { url: 'https://example.com' })).output).toContain('参数错误：prompt')
    expect(web.asked).toHaveLength(0)
  })
})

describe('U72 · web_fetch ② 缓存', () => {
  test('同一地址第二次：不再取网，且**回执说了一声「缓存命中」**、不报取回耗时', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web, distiller: fakeDistiller() })

    const first = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '标准版多少钱？' })
    const second = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '换成按月还是按年？' })

    expect(web.asked).toHaveLength(1) // 真取网只发生了一次
    expect(first.output).not.toContain('缓存命中')
    expect(second.output).toContain('缓存命中')
    expect(second.ok).toBe(true)
  })

  test('换一个问题**照旧现提炼**（缓存的是页面，不是答案）——两趟答案可以不同', async () => {
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

    const first = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })
    const second = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '支持退款吗？' })

    expect(questions).toEqual(['多少钱？', '支持退款吗？'])
    expect(first.output).toContain('答：多少钱？')
    expect(second.output).toContain('答：支持退款吗？')
  })

  test('过了 15 分钟照旧再取一次（缓存是短时的，不是留存）', async () => {
    const web = fakeWeb((url) => okPage(url))
    let clock = 1_700_000_000_000

    const definition = defineWebFetchTool({
      web,
      distiller: () => fakeDistiller(),
      now: () => clock,
    })
    const deps = makeToolDeps({ tools: [definition] })

    await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })
    clock += 15 * 60 * 1000 + 1
    const later = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })

    expect(web.asked).toHaveLength(2)
    expect(later.output).not.toContain('缓存命中')
  })
})

describe('U72 · web_fetch ③ 拒（发请求之前那一关）', () => {
  test('localhost 与无点主机名：拒，且取回面**一次都没被叫**', async () => {
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

    const got = await callWebFetch(deps, { url: 'http://example.com/plain', prompt: '?' })

    expect(web.asked).toEqual(['https://example.com/plain'])
    expect(got.output).toContain('https://example.com/plain')
  })

  test('跨主机重定向**不跟**，且说清「从哪跳到哪」（让模型自己再取一次）', async () => {
    const web = fakeWeb(() => ({
      ok: false,
      kind: 'off-host-redirect',
      reason: '这个地址跳到了另一个域名（other.example）——本工具不跟跨主机跳转',
      from: 'https://example.com/a',
      to: 'https://other.example/b',
    }))
    const { deps } = toolWith({ web, distiller: fakeDistiller() })

    const got = await callWebFetch(deps, { url: 'https://example.com/a', prompt: '?' })

    expect(got.ok).toBe(false)
    expect(got.output).toContain('https://example.com/a') // 从哪
    expect(got.output).toContain('https://other.example/b') // 跳到哪
    expect(got.output).toContain('再取一次')
  })

  test('出错码 / 取不回来：照实报，不当成「这一页没有」', async () => {
    const notFound = fakeWeb((url) => okPage(url, 'not found', 404))
    expect((await callWebFetch(toolWith({ web: notFound, distiller: fakeDistiller() }).deps, { url: 'https://example.com/x', prompt: '?' })).output).toContain('404')

    const dead = fakeWeb(() => ({ ok: false, kind: 'failed', reason: '取不回「https://example.com/x」：fetch failed' }))
    expect((await callWebFetch(toolWith({ web: dead, distiller: fakeDistiller() }).deps, { url: 'https://example.com/x', prompt: '?' })).output).toContain('fetch failed')
  })
})

describe('U72 · web_fetch ④ 没配提炼模型：这一轮停住', () => {
  test('`ok: false` ＋ **`halt`**（循环据此不开下一轮）', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web }) // 不给 distiller ＝ 配置里那一格空着

    const got = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })

    expect(got.ok).toBe(false)
    expect(got.halt).toBe(true)
  })

  test('两句话都在：模型看得到「还没配、取不到」；用户看得到「去 /config 挑一个」', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web })

    const got = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })

    expect(got.output).toContain('还没配提炼用的模型')
    expect(got.output).toContain('/config')
    // **首行**就是屏上工具行报的那一句（外壳取结果首行作结论）——它得自己说完整
    expect(got.output.split('\n')[0]).toContain('还没配提炼用的模型')
    // 点明两条都不做：不顶替模型、不绕道抓原文
    expect(got.output).toContain('不拿别的模型顶上')
    expect(got.output).toContain('绕道')
  })

  test('首行**在 48 列以内说全**「去 /config 挑一个」——用户不必展开就看得见', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web })

    const got = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })
    const first = got.output.split('\n')[0] ?? ''

    /**
     * 48 是**屏上那半句结论的宽度**（`@magic/tui` · `log.ts` 的 `firstLineOf`：
     * `truncateLine(line, 48)`）——它是**截断**不是折行，超出的部分不上屏。
     *
     * ⚠️ 工单⑦要的是「**用户看得到「去 /config 挑一个」**」：那一句要是落在第 48 列之后，
     * 用户就得先按 `ctrl+o` 才读得到——那不叫看得到。故这一条钉的是**排版**：
     * 改这句文案时，改到 48 列之外就是红的（不是「看着还行」）。
     */
    expect(first).toContain('/config')
    expect(displayWidth(first)).toBeLessThanOrEqual(48)
  })

  test('拦在**取回之前**：这一趟注定提炼不了，那一次取网就不发出去', async () => {
    const web = fakeWeb((url) => okPage(url))
    const { deps } = toolWith({ web })

    await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })

    expect(web.asked).toHaveLength(0)
  })

  test('**照旧不许**拿别的模型顶上：没配就是没配（提炼面一次都没被叫）', async () => {
    const web = fakeWeb((url) => okPage(url))
    const distiller = fakeDistiller()
    // 有提炼面但构造时没给——`deps.distiller` 缺席这一条路在上面几支已钉；这里钉「不顶上」
    const { deps } = toolWith({ web })

    const got = await callWebFetch(deps, { url: 'https://example.com/pricing', prompt: '多少钱？' })

    expect(got.output).not.toContain('12 元')
    expect(distiller.asked).toHaveLength(0)
  })

  test('配了但这一趟没成 ⇒ 普通失败（**不 halt**）——这一种模型处置得了', async () => {
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
