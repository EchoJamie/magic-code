#!/usr/bin/env bun
/**
 * **压缩那一次调用的出站请求体** —— U97 的验收跑具。
 *
 * 判据要的是「那一份真发出去的请求体」，故这一趟**除了供应商那一段网线，全是真的**：
 * 真装配 · 真配置 · 真记录库 · 真对话域（压缩器就在里面） · 真模型域（注册表 → 取件层
 * → 适配 → 请求体）——只有最外那一跳 `fetch` 换成**记下请求体再回一段 SSE**的替身。
 * 故抓下来的那一份**就是出站体的原文**（不是「我们以为会发什么」）。
 *
 * 三样读数，一份不落：
 * ① **逐次调用的完整请求体**落到 `--out` 目录（一次调用一个文件）——改前 / 改后各跑一遍，
 *    两份目录直接 `diff`：**除了该变的那一位，别的一个字不许动**；
 * ② 屏幕上标出**哪一次是压缩**（请求体里带摘要指令的那一次）与它的出站体；
 * ③ 该家适配对 `{ mode: 'off' }` 的**实际处置**（发了原生参数 / 没发 / 报了缺口）——
 *    见末尾那一段读数。
 *
 * ⚠️ **落点写死在 `/tmp` 下的一个固定目录**（不是 `mkdtemp`）：请求体里有 `cwd` 一类
 * 注入值，路径随机就 diff 不动了——**要并排比，两次跑就得落在同一处**。
 *
 * 跑法：
 *   bun packages/app/scripts/compact-reasoning-probe.ts --vendor deepseek --out /tmp/u97-改前
 *   bun packages/app/scripts/compact-reasoning-probe.ts --vendor minimax  --out /tmp/u97-minimax
 *   bun packages/app/scripts/compact-reasoning-probe.ts --vendor deepseek --session-reasoning level:high
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent, ProviderConfig } from '@magic/contracts'
import { resolveMagicHome } from '@magic/contracts'
import { assemble, loadConfig, runShellScript } from '../src/index.ts'

// —— 入参 ——

const argv = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(name)
  const value = argv[at + 1]
  return argv.includes(name) && value !== undefined ? value : fallback
}

/** 走哪一家（`compat` ＝**没有适配**的兼容接入）。 */
const VENDOR = flag('--vendor', 'deepseek')
/** 会话里那一档思考设置（`none` ＝不设）——用来盯「压缩不听会话那一档」。 */
const SESSION = flag('--session-reasoning', 'none')
/** 抓下来的请求体落哪儿（两次跑必须给**同一处**才 diff 得动）。 */
const OUT = flag('--out', '/tmp/u97-probe')

/**
 * 这一趟用的模型名——各家按自家的真名字写（大小写与符号就是调用时要送的那个）。
 *
 * ⚠️ `compat`（兼容接入）走的是 MiniMax 的老地址，故也用它的型号名：那条路**没有适配**，
 * 名字只是原样送出去的一段字符串——拿 `MiniMax-M3` 才与「用户真那么配」逐字同形。
 */
const MODEL = VENDOR === 'deepseek' ? 'deepseek-flash' : 'MiniMax-M3'

/** 配置里那一条连接——三家的形态各按各家该有的样子写。 */
function provider(): ProviderConfig {
  const reasoning =
    SESSION === 'none'
      ? {}
      : SESSION.startsWith('level:')
        ? { reasoning: { mode: 'level' as const, level: SESSION.slice('level:'.length) } }
        : SESSION.startsWith('budget:')
          ? { reasoning: { mode: 'budget' as const, budgetTokens: Number(SESSION.slice('budget:'.length)) } }
          : { reasoning: { mode: SESSION as 'off' | 'default' } }

  if (VENDOR === 'compat') {
    // 兼容接入：无 `vendor`，地址与协议照旧（MiniMax 的老地址）
    return {
      baseURL: 'https://api.minimaxi.com/v1',
      apiKey: 'sk-not-a-real-key',
      name: '兼容接入',
      model: MODEL,
      ...reasoning,
    }
  }
  return { vendor: VENDOR, apiKey: 'sk-not-a-real-key', model: MODEL, ...reasoning }
}

// —— 假供应商：真格式的 SSE，请求体原样留下 ——

type Call = {
  readonly url: string
  readonly body: Record<string, unknown> | undefined
}

/** 一次 OpenAI 兼容的 SSE 帧（形状照真响应）。 */
function frame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-u97',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: MODEL,
    ...payload,
  })}\n\n`
}

/**
 * 假端点——列表回一份最小清单，聊天回「一句正文 ＋ 用量」。
 *
 * **用量给得够大**：压缩的触发判据看的就是它（探针把阈值压到 1，见下）。
 */
function fakeVendor(): { readonly fetch: typeof globalThis.fetch; readonly calls: Call[] } {
  const calls: Call[] = []

  const fetch = (async (input: unknown, init?: { headers?: unknown; body?: unknown }) => {
    const url = String(input)
    calls.push({
      url,
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    })

    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    return new Response(
      frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '收到' } }] }) +
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
        frame({
          choices: [],
          usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 },
        }) +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as unknown as typeof globalThis.fetch

  return { fetch, calls }
}

/** 这一次调用是不是**压缩**——认摘要指令那一句（压缩请求体的头一条就是它）。 */
function isCompaction(call: Call): boolean {
  const text = JSON.stringify(call.body ?? {})
  return text.includes('你是会话压缩器')
}

/** 这一次调用是不是**列表**（不算模型调用）。 */
function isList(call: Call): boolean {
  return call.url.endsWith('/models')
}

// —— 沙地（固定路径：两次跑必须落在同一处）——

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const workspace = '/tmp/magic-u97-ws'
rmSync(workspace, { recursive: true, force: true })
mkdirSync(workspace, { recursive: true })

const sandbox = '/tmp/magic-u97-sandbox'
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const configPath = join(sandbox, 'config.json')
writeFileSync(
  configPath,
  JSON.stringify(
    {
      defaultProvider: 'p',
      providers: { p: provider() },
      dataDir: join(sandbox, 'data'),
    },
    null,
    2,
  ),
  'utf8',
)

console.log('magic —— 压缩出站请求体探针（U97）')
console.log(`  连接 ${VENDOR} · 模型 ${MODEL} · 会话那一档 ${SESSION}`)
console.log(`  请求体落点 ${OUT}`)

const magic = resolveMagicHome({}, sandbox)
const vendor = fakeVendor()

const assembly = assemble({
  cwd: workspace,
  magic,
  config: loadConfig({ path: configPath, magic }),
  modelFetch: vendor.fetch,
  grantsFile: join(sandbox, 'grants.json'),
  prompt: { platform: 'darwin', date: '2026-09-26' },
  // 阈值压到 0 —— **降的是阈值，不是机制**（同 compact-probe 那条注）。
  // ⚠️ 两个数都要压：**模型信息声明了窗长时走占比**（MiniMax 有内置窗长）、
  // 没声明才走绝对值——只压绝对值那一支，MiniMax 那条路永远够不着（实测第一版即此）。
  context: { compactAtTokens: 1, compactAtFraction: 0, nearEntries: 1 },
})

const marks: string[] = []

try {
  await runShellScript(
    assembly.shell,
    { inputs: ['第一件事', '第二件事', '第三件事'], timeoutMs: 120_000 },
    {
      onEvent: (event: KernelEvent) => {
        if (event.kind === 'model.usage') {
          marks.push(`用量　入 ${event.data.inputTokens} · 出 ${event.data.outputTokens}`)
          return
        }
        if (event.kind === 'context.compacted') marks.push(`压缩发生：摘要条目 #${event.data.summary}`)
        if (event.kind === 'model.error') marks.push(`模型错（${event.data.tier}）：${event.data.message}`)
      },
    },
  )
} finally {
  assembly.close()
}

// —— 帧 ①：逐次调用落盘（一次调用一个文件）——

let seq = 0
let compactAt = -1
const index: string[] = []

for (const call of vendor.calls) {
  if (isList(call)) continue
  seq += 1
  const compaction = isCompaction(call)
  if (compaction) compactAt = seq

  const no = String(seq).padStart(2, '0')
  const name = `${no}-${compaction ? 'compact' : 'loop'}.json`
  writeFileSync(join(OUT, name), JSON.stringify(call.body, null, 2), 'utf8')
  index.push(`  ${no}. ${compaction ? '◆ 压缩' : '  循环'}　${call.url}`)
}

console.log('\n—— 帧 ①：出站调用（按发生序；每次一份请求体落到 --out）——')
for (const line of index) console.log(line)
for (const mark of marks) console.log(`  · ${mark}`)

// —— 帧 ②：压缩那一次的请求体原文 ——

const compactBody = vendor.calls.filter((call) => !isList(call))[compactAt - 1]?.body
console.log('\n—— 帧 ②：压缩那一次的**出站请求体原文** ——')
console.log(compactBody === undefined ? '  （这一趟没有压缩调用）' : JSON.stringify(compactBody, null, 2))

// —— 帧 ③：这一家对「关思考」的实际处置 ——

const keys = Object.keys(compactBody ?? {})
const reasoningKeys = keys.filter((key) => /thinking|reasoning/i.test(key))
console.log('\n—— 帧 ③：适配对 `{ mode: \'off\' }` 的实际处置 ——')
console.log(`  出站体里的思考参数：${reasoningKeys.length === 0 ? '（一个都没有）' : reasoningKeys.map((k) => `${k}=${JSON.stringify(compactBody?.[k])}`).join(' · ')}`)
console.log(`  出站体顶层键：${keys.join(' / ')}`)
console.log(`  沙地 ${sandbox}（留给人复看）`)
