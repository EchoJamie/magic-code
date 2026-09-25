#!/usr/bin/env bun
/**
 * U91 验收装置 —— **真端点真跑一趟长输出**，留出站请求体原文。
 *
 * ## 它要证的那一条
 *
 * 「输出上限取自模型信息」——判据落在**出站请求体**上：那一格应当是
 * 供应商接口给的 `max_output_tokens`，**不再是取件层那个 4096**。
 *
 * 故这一趟刻意让模型**写一个较大的文件**：那是 U91 工单记下的真事故形状
 * （一轮 4096 里 reasoning 占掉 3480，留给正文的不够 ⇒ 工具调用参数被截在半路）。
 * 改前那一侧拿这份脚本到基线检出上跑，两侧一比就是「改前 / 改后」。
 *
 * ## 安全（**硬规矩**，照 `bench-first-token.ts` 的先例）
 *
 * 真配置里那个 `apiKey` 是**真 key**——故：① 配置**复制**进一个临时家，`dataDir`
 * 随之展开到临时家 ⇒ **用户真库零写入**；② 跑完把临时家删掉（含那份带 key 的副本）；
 * ③ **落档的只有请求体**——它**不含凭据**（凭据在请求头里，这一趟不落头）。
 *
 * ⚠️ **会真调模型**，且这一趟故意要一大段输出——那是要花钱的（用户已定：不控成本）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/u91-output-limit-real.ts --out <目录> --label 改后
 * ```
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KernelEvent } from '@magic/contracts'
import { resolveMagicHome } from '@magic/contracts'

/** 真配置的落点（跟 `MAGIC_HOME` 走，不写死 `~/.magic`）。 */
const REAL_CONFIG = `${resolveMagicHome(process.env, homedir()).base}/config.json`

function argOf(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

const OUT = argOf('--out') ?? join(tmpdir(), 'u91-out')
const LABEL = argOf('--label') ?? '未标'

/**
 * 这一趟要的那份交代——**逼出长输出**（改前那一侧正撞在同一处上）。
 *
 * ⚠️ **必须堵住「用脚本生成」那条捷径**：第一版没堵，模型当场改用 `exec` 打一个
 * 循环去造那 1200 行——文件是成了，可**输出只有 276 个 token**，这一趟就没验到
 * 「长输出」那件事（U91 要复的是**输出被截断**那个形状）。故这里明写：
 * 用 write 工具一次写完，不许 exec / 脚本 / 循环。
 */
const PROMPT = [
  '请在当前工作区写一个文件 u91-big.md：把它**整份直接写出来**，从第 1 行到第 1200 行，',
  '每行形如「第 N 行 · u91-<N>」，N 从 1 数到 1200。',
  '**必须用 write 工具一次写完**——**不许**用 exec / 脚本 / 循环去生成它，',
  '**不许**省略、不许用「以下略」或占位符。写完再用一句话回我。',
].join('')

type Call = { readonly url: string; readonly body: Record<string, unknown> }

const home = join(tmpdir(), `magic-u91-${process.pid}-${Date.now()}`)
mkdirSync(join(home, '.magic'), { recursive: true })
mkdirSync(join(home, 'ws'), { recursive: true })
// **复制**配置（不是改写真的那份）；`dataDir` 里的 `~` 随之展开到临时家
writeFileSync(join(home, '.magic', 'config.json'), readFileSync(REAL_CONFIG))

const magic = resolveMagicHome({}, home)

const { assemble, attachShell, loadConfig } = await import('../src/index.ts')

const calls: Call[] = []

/** 拦在出站那一跳上——**记请求体，不记请求头**（头里有凭据）。 */
const modelFetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
  const url = String(input)
  const raw = (init as { body?: unknown } | undefined)?.body
  if (typeof raw === 'string') {
    try {
      calls.push({ url, body: JSON.parse(raw) as Record<string, unknown> })
    } catch {
      calls.push({ url, body: { '（正文不是 JSON）': raw.slice(0, 200) } })
    }
  }
  return await globalThis.fetch(input, init)
}) as typeof globalThis.fetch

const configPath = join(home, '.magic', 'config.json')
const loaded = loadConfig({ path: configPath, magic })

const assembly = assemble({
  cwd: join(home, 'ws'),
  magic,
  config: loaded,
  modelFetch,
  // 这一趟要跑通全链（含 write 那件工具）——闸门一律放行，是**装置的方便**，不是产品行为
  allowAll: true,
  grantsFile: join(home, '.magic', 'grants.json'),
  prompt: { platform: process.platform, date: '2026-09-26' },
})

const shell = attachShell(assembly.shell, { timeoutMs: 300_000 })

try {
  await assembly.ready()

  // **先把模型信息取到手**：那是本单的来路——不取，规格里就没有那一格。
  // （真产品里这一步是用户打开模型列表 / 启动时的后台那一趟。）
  const provider = loaded.providerId ?? Object.keys(loaded.config.providers ?? {})[0] ?? ''
  const listed = await assembly.modelInfo.refresh(provider)
  const models = listed.snapshot?.models ?? []
  console.log(`【${LABEL}】模型信息：${provider} · ${models.length} 个模型`)
  for (const one of models) {
    console.log(`  · ${one.id} → limits=${JSON.stringify(one.limits ?? null)}`)
  }

  calls.length = 0
  console.log(`【${LABEL}】交代：写 1200 行的文件…`)
  await shell.submit(PROMPT, 280_000)

  const events = shell.events
  const usages = events.filter((one): one is Extract<KernelEvent, { kind: 'model.usage' }> => one.kind === 'model.usage')
  const toolCalls = events.filter((one) => one.kind === 'tool.call')
  const toolResults = events.filter((one): one is Extract<KernelEvent, { kind: 'tool.result' }> => one.kind === 'tool.result')
  const askings = events.filter((one) => one.kind === 'tool.decision.request')
  const errors = events.filter((one) => one.kind === 'model.error' || one.kind === 'error')

  console.log(`【${LABEL}】出站请求 ${calls.length} 趟：`)
  for (const [index, call] of calls.entries()) {
    const limit = call.body['max_tokens'] ?? call.body['max_completion_tokens']
    console.log(`  ${index + 1}. ${call.url}`)
    console.log(`     输出上限那一格：max_tokens=${call.body['max_tokens']} · max_completion_tokens=${call.body['max_completion_tokens']}`)
    console.log(`     （这一趟真会送的输出上限＝${String(limit)}；model=${String(call.body['model'])}）`)
  }

  console.log(`【${LABEL}】用量：`)
  for (const one of usages) {
    console.log(
      `  outputTokens=${one.data.outputTokens} · reasoningTokens=${one.data.reasoningTokens} · inputTokens=${one.data.inputTokens} · 分母=${String(one.data.contextWindow)}`,
    )
  }
  console.log(`【${LABEL}】工具：调用 ${toolCalls.length} 次 · 结果 ${toolResults.length} 条 · 闸门询问 ${askings.length} 次`)
  for (const one of toolResults) {
    // 输出两形（正文 / 大块引用）——这一趟只印正文那一支，够判「写成了没有」
    const text = 'text' in one.data.output ? one.data.output.text : `（转存成大块：${one.data.output.blob}）`
    console.log(`  · ok=${String(one.data.ok)} ${text.slice(0, 200).replace(/\n/g, ' ⏎ ')}`)
  }
  for (const one of errors) {
    console.log(`  ⚠️ ${one.kind}：${JSON.stringify(one.data).slice(0, 300)}`)
  }

  try {
    const written = readFileSync(join(home, 'ws', 'u91-big.md'), 'utf8')
    const lines = written.split('\n')
    console.log(`【${LABEL}】落盘的文件：${lines.length} 行 · ${written.length} 字符 · 首行「${lines[0] ?? ''}」· 末行「${lines.at(-2) ?? ''}」`)
  } catch {
    console.log(`【${LABEL}】落盘的文件：**没写成**`)
  }

  // —— 归档：**出站请求体原文**（不含凭据）——
  mkdirSync(OUT, { recursive: true })
  for (const [index, call] of calls.entries()) {
    writeFileSync(
      join(OUT, `出站请求体-${LABEL}-${index + 1}.json`),
      JSON.stringify({ url: call.url, body: call.body }, null, 2),
    )
  }
  writeFileSync(
    join(OUT, `读数-${LABEL}.json`),
    JSON.stringify(
      {
        label: LABEL,
        provider,
        models,
        requests: calls.map((call) => ({
          url: call.url,
          model: call.body['model'],
          max_tokens: call.body['max_tokens'],
          max_completion_tokens: call.body['max_completion_tokens'],
        })),
        usages: usages.map((one) => one.data),
        toolResults: toolResults.map((one) => ({
          ok: one.data.ok,
          output: 'text' in one.data.output ? one.data.output.text.slice(0, 400) : '（大块）',
        })),
      },
      null,
      2,
    ),
  )
  console.log(`【${LABEL}】归档到 ${OUT}`)
} finally {
  shell.dispose()
  assembly.close()
  // 临时家（含那份带 key 的副本）**删掉**
  rmSync(home, { recursive: true, force: true })
}
