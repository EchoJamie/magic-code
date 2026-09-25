#!/usr/bin/env bun
/**
 * **提炼那一次调用的出站请求体** —— U99 的验收跑具。
 *
 * 判据要的是「那一份真发出去的请求体」，故这一趟**除了供应商那一段网线，全是真的**：
 * 真装配 · 真配置 · 真记录库 · 真对话域 · 真工具域（闸门也真走）· 真模型域（网关 →
 * 取件层 → 适配 → 请求体）——只有两处是假的：最外那一跳 `fetch`（记下请求体再回一段 SSE）
 * 与取回面（`webSource` 注入，不出网）。故抓下来的那一份**就是出站体的原文**。
 *
 * ⚠️ **本单的第一件事是查清「这一跳的设置从哪儿补齐」**——本跑具的帧 ③ 就是那件事的实测：
 * 打印提炼那一次请求体里的思考参数**与它经过的那条路**（不经注册表，见文件末注）。
 *
 * 三样读数，一份不落：
 * ① **逐次调用的完整请求体**落到 `--out` 目录（一次调用一个文件）——改前 / 改后各跑一遍，
 *    两份目录直接 `diff`：**除了该变的那一位，别的一个字不许动**；
 * ② 屏幕上标出**哪一次是提炼**（去往 `webFetch.model` 那个名字的那一次）与它的出站体；
 * ③ 该家适配对 `{ mode: 'off' }` 的**实际处置**（发了原生参数 / 没发 / 报了缺口）。
 *
 * ⚠️ **落点写死在 `/tmp` 下的一个固定目录**（不是 `mkdtemp`）：请求体里有 `cwd` 一类
 * 注入值，路径随机就 diff 不动了——**要并排比，两次跑就得落在同一处**。
 *
 * 跑法：
 *   bun packages/app/scripts/distill-reasoning-probe.ts --vendor deepseek --out /tmp/u99-改前
 *   bun packages/app/scripts/distill-reasoning-probe.ts --vendor minimax  --out /tmp/u99-mm
 *   bun packages/app/scripts/distill-reasoning-probe.ts --vendor compat   --out /tmp/u99-compat
 *   bun packages/app/scripts/distill-reasoning-probe.ts --vendor deepseek --distill-vendor minimax
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent, ProviderConfig, WebSource, PageFetch } from '@magic/contracts'
import { resolveMagicHome } from '@magic/contracts'
import { assemble, loadConfig, runShellScript } from '../src/index.ts'

// —— 入参 ——

const argv = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(name)
  const value = argv[at + 1]
  return argv.includes(name) && value !== undefined ? value : fallback
}

/** 会话那条连接的适配（`compat` ＝**没有适配**的兼容接入）。 */
const VENDOR = flag('--vendor', 'deepseek')
/**
 * **提炼那条连接的适配**（`same` ＝与会话共用一条连接）。
 *
 * 给成别家 ⇒ `webFetch.provider` 另指一条连接——这正是 ② 那一形要的现场
 *（提炼走它自己那一条，与会话那条不是同一家）。
 */
const DISTILL_VENDOR = flag('--distill-vendor', 'same')
/** 会话里那一档思考设置（`none` ＝不设）。 */
const SESSION = flag('--session-reasoning', 'none')
/** 抓下来的请求体落哪儿（两次跑必须给**同一处**才 diff 得动）。 */
const OUT = flag('--out', '/tmp/u99-probe')

/** 会话那一条连接上的模型。 */
const SESSION_MODEL = VENDOR === 'deepseek' ? 'deepseek-flash' : 'MiniMax-M3'
/** 「取网页用的模型」——**另一个名字**（判据 ④ 的读数靠它）。 */
const DISTILL_MODEL = VENDOR === 'deepseek' ? 'deepseek-distill-small' : 'MiniMax-M1-distill'

/** 那一页（取回面替身直接给 markdown）。 */
const PAGE = '# 定价\n\n标准版每月 12 元。\n\n内部备注：这一段只在原文里。'

/** 配置里一条连接的形态——三家各按各家该有的样子写。 */
function providerOf(vendor: string, model: string): ProviderConfig {
  const reasoning =
    SESSION === 'none' || vendor !== VENDOR
      ? {}
      : SESSION.startsWith('level:')
        ? { reasoning: { mode: 'level' as const, level: SESSION.slice('level:'.length) } }
        : SESSION.startsWith('budget:')
          ? { reasoning: { mode: 'budget' as const, budgetTokens: Number(SESSION.slice('budget:'.length)) } }
          : { reasoning: { mode: SESSION as 'off' | 'default' } }

  const base = { baseURL: 'https://api.example.com/v1', apiKey: 'sk-not-a-real-key', model }

  // 兼容接入：无 `vendor`，地址与协议照旧
  return vendor === 'compat' ? { ...base, ...reasoning } : { vendor, ...base, ...reasoning }
}

// —— 假供应商：真格式的 SSE，请求体原样留下 ——

type Call = {
  readonly url: string
  readonly body: Record<string, unknown> | undefined
}

/** 一次 OpenAI 兼容的 SSE 帧（形状照真响应）。 */
function frame(model: string, payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-u99',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model,
    ...payload,
  })}\n\n`
}

/**
 * 假端点——列表回一份最小清单，聊天回「一句正文 ＋ 用量」。
 *
 * ⚠️ **回什么正文要看这一跳是谁**：主轮必须回一个 `web_fetch` 工具调用（否则走不到提炼），
 * 提炼那一跳回一句答案。按**请求里的模型名**分（那正是我们要验的那一位）。
 */
function fakeVendor(): { readonly fetch: typeof globalThis.fetch; readonly calls: Call[] } {
  const calls: Call[] = []
  /** 主轮已经问过几次——**只有第一次**要工具，之后回一句正文（否则这一轮永远收不了尾）。 */
  let asked = 0

  const fetch = (async (input: unknown, init?: { headers?: unknown; body?: unknown }) => {
    const url = String(input)
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    calls.push({ url, body })

    if (url.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [{ id: SESSION_MODEL, object: 'model' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const model = typeof body?.['model'] === 'string' ? (body['model'] as string) : SESSION_MODEL
    const isDistill = model === DISTILL_MODEL
    if (!isDistill) asked += 1

    /** 主轮**第一次**要一次网页（走到工具域）；之后与提炼一样，回一句正文收尾。 */
    const wantsFetch = !isDistill && asked === 1

    const head = wantsFetch
      ? frame(model, {
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'web_fetch',
                      arguments: JSON.stringify({
                        url: 'https://example.com/pricing',
                        prompt: '标准版多少钱？',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        })
      : frame(model, {
          choices: [
            { index: 0, delta: { role: 'assistant', content: isDistill ? '标准版每月 12 元。' : '看完了。' } },
          ],
        })

    return new Response(
      head +
        frame(model, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
        frame(model, {
          choices: [],
          usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 },
        }) +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as unknown as typeof globalThis.fetch

  return { fetch, calls }
}

/** 这一次调用是不是**提炼**——按去往哪个模型认（不是按第几次，判据 ④ 正问的是这件事）。 */
function isDistill(call: Call): boolean {
  return call.body?.['model'] === DISTILL_MODEL
}

/** 这一次调用是不是**列表**（不算模型调用）。 */
function isList(call: Call): boolean {
  return call.url.endsWith('/models')
}

// —— 沙地（固定路径：两次跑必须落在同一处）——

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const workspace = '/tmp/magic-u99-ws'
rmSync(workspace, { recursive: true, force: true })
mkdirSync(workspace, { recursive: true })

const sandbox = '/tmp/magic-u99-sandbox'
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const providers: Record<string, ProviderConfig> = {
  p: providerOf(VENDOR, SESSION_MODEL),
}
const distillProvider = DISTILL_VENDOR === 'same' ? 'p' : 'd'
if (DISTILL_VENDOR !== 'same') providers['d'] = providerOf(DISTILL_VENDOR, DISTILL_MODEL)

const configPath = join(sandbox, 'config.json')
writeFileSync(
  configPath,
  JSON.stringify(
    {
      defaultProvider: 'p',
      providers,
      webFetch: { provider: distillProvider, model: DISTILL_MODEL },
      dataDir: join(sandbox, 'data'),
    },
    null,
    2,
  ),
  'utf8',
)

console.log('magic —— 提炼出站请求体探针（U99）')
console.log(`  会话连接 ${VENDOR} · 模型 ${SESSION_MODEL} · 会话那一档 ${SESSION}`)
console.log(`  提炼连接 ${DISTILL_VENDOR} · 模型 ${DISTILL_MODEL}`)
console.log(`  请求体落点 ${OUT}`)

const magic = resolveMagicHome({}, sandbox)
const vendor = fakeVendor()

/** 取回面替身——不出网，直接给 markdown。 */
const web: WebSource = {
  fetchPage: (url: string): Promise<PageFetch> =>
    Promise.resolve({
      ok: true,
      url,
      status: 200,
      bytes: Buffer.byteLength(PAGE),
      body: PAGE,
      contentType: 'text/markdown',
    }),
}

const assembly = assemble({
  cwd: workspace,
  magic,
  config: loadConfig({ path: configPath, magic }),
  modelFetch: vendor.fetch,
  webSource: web,
  grantsFile: join(sandbox, 'grants.json'),
  prompt: { platform: 'darwin', date: '2026-09-26' },
})

const marks: string[] = []

try {
  await runShellScript(
    assembly.shell,
    { inputs: ['查一下它的定价'], timeoutMs: 120_000 },
    {
      onEvent: (event: KernelEvent) => {
        if (event.kind === 'model.usage') {
          marks.push(`用量　入 ${event.data.inputTokens} · 出 ${event.data.outputTokens}`)
          return
        }
        if (event.kind === 'tool.call') marks.push(`工具调用 ${event.data.name}`)
        if (event.kind === 'tool.result') marks.push(`工具回执 ${String(event.data.output).slice(0, 60)}…`)
        if (event.kind === 'model.error') marks.push(`模型错（${event.data.tier}）：${event.data.message}`)
      },
    },
  )
} finally {
  assembly.close()
}

// —— 帧 ①：逐次调用落盘（一次调用一个文件）——

let seq = 0
let distillAt = -1
const index: string[] = []

for (const call of vendor.calls) {
  if (isList(call)) continue
  seq += 1
  const distilled = isDistill(call)
  if (distilled) distillAt = seq

  const no = String(seq).padStart(2, '0')
  const name = `${no}-${distilled ? 'distill' : 'loop'}.json`
  writeFileSync(join(OUT, name), JSON.stringify(call.body, null, 2), 'utf8')
  index.push(`  ${no}. ${distilled ? '◆ 提炼' : '  循环'}　${call.url}`)
}

console.log('\n—— 帧 ①：出站调用（按发生序；每次一份请求体落到 --out）——')
for (const line of index) console.log(line)
for (const mark of marks) console.log(`  · ${mark}`)

// —— 帧 ②：提炼那一次的请求体原文 ——

const distillBody = vendor.calls.filter((call) => !isList(call))[distillAt - 1]?.body
console.log('\n—— 帧 ②：提炼那一次的**出站请求体原文** ——')
console.log(distillBody === undefined ? '  （这一趟没有提炼调用）' : JSON.stringify(distillBody, null, 2))

// —— 帧 ③：这一家对「关思考」的实际处置 ——

const keys = Object.keys(distillBody ?? {})
const reasoningKeys = keys.filter((key) => /thinking|reasoning/i.test(key))
console.log('\n—— 帧 ③：适配对 `{ mode: \'off\' }` 的实际处置 ——')
console.log(
  `  出站体里的思考参数：${
    reasoningKeys.length === 0
      ? '（一个都没有）'
      : reasoningKeys.map((k) => `${k}=${JSON.stringify(distillBody?.[k])}`).join(' · ')
  }`,
)
console.log(`  出站体顶层键：${keys.join(' / ')}`)
console.log(`  沙地 ${sandbox}（留给人复看）`)
