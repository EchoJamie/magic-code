#!/usr/bin/env bun
/**
 * 上下文压缩探针 —— **U19 的验收跑具**（技术方案 · 上下文压缩（阶段 3））。
 *
 * 跑一段**真会话**（真装配 · 真记录库 · 真工具域 / 闸门 / 沙箱 · **真端点**），看压缩
 * 三件是不是真的发生了：
 *
 * 1. **摘要条目入库**——关库后拿裸 `bun:sqlite` 直读，条目表里那条 `summary` 在不在；
 * 2. **上下文变短**——`model.usage` 的 `inputTokens` 是真读数：压完那一轮应当**掉下来**；
 * 3. **接着干活不断**——压完照常收束、继续下一轮（不是「压完就停」）。
 *
 * 阈值与近段边界是**实现级常量**（B4），本探针把它们收到 argv 上——真跑里要看到压缩，
 * 不能真等到 12 万 token（那要烧掉一整本书）。**降的是阈值，不是机制**：
 * 触发判据、摘要生成、装配换头走的都是生产那一套代码。
 *
 * 数据落点：**另起一个临时 dataDir**（不碰 `~/.magic/records.db`）——探针反复跑，
 * 不该往用户的记录里掺沙子。供应商与 key 照读真配置。
 *
 * 跑法：
 *   bun packages/app/scripts/compact-probe.ts                    # 阈值 3000 · 近段 2
 *   bun packages/app/scripts/compact-probe.ts --at 8000 --near 4
 */

import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { KernelEvent } from '@magic/contracts'
import { assemble, loadConfig, runShellScript } from '../src/index.ts'

// —— 入参 ——

const argv = process.argv.slice(2)
const valueOf = (flag: string, fallback: number): number => {
  const raw = argv[argv.indexOf(flag) + 1]
  return argv.includes(flag) && raw !== undefined ? Number(raw) : fallback
}

/** 触发阈值（token）——探针压低它，好在一段短会话里真的看见压缩。 */
const AT = valueOf('--at', 3000)
/** 「近段」条数——压不动的那些条目数。 */
const NEAR = valueOf('--near', 2)

/**
 * 一段真会话——**读几个大文件**（工具结果动辄几千 token，真会话里撑爆上下文的就是它），
 * 好让用量爬过阈值；最后几轮落在压缩**之后**，顺带验「压完接着干」。
 */
const INPUTS = [
  '用一句话说你此刻在哪个目录下干活，别调用工具。',
  '跑 `cat packages/conversation/src/context.ts`，用三句话概括这个文件干什么。',
  '跑 `cat packages/conversation/src/agent-loop.ts`，也用三句话概括。',
  '跑 `cat packages/conversation/src/entries.ts`，一句话概括。',
  '接着刚才的：这三个文件里，哪个负责「装配」、哪个负责「压缩」？',
  '最后：把这一路聊过的事压成一句话给我。',
]

// —— 另起沙地（真配置 · 临时落点）——

const home = process.env['HOME'] ?? homedir()
const sandbox = mkdtempSync(join(process.env['TMPDIR'] ?? '/tmp', 'magic-compact-'))
const configPath = join(sandbox, 'config.json')
const raw = JSON.parse(readFileSync(join(home, '.magic', 'config.json'), 'utf8')) as Record<string, unknown>
writeFileSync(configPath, JSON.stringify({ ...raw, dataDir: join(sandbox, 'data') }, null, 2))

console.log('magic —— 上下文压缩探针')
console.log(`  阈值 ${AT} token · 近段 ${NEAR} 条（生产缺省：12 万 / 20 条）`)
console.log(`  数据落点 ${join(sandbox, 'data')}（临时，不碰 ~/.magic）`)

const assembly = assemble({
  cwd: process.cwd(),
  config: loadConfig({ path: configPath, home: sandbox }),
  context: { compactAtTokens: AT, nearEntries: NEAR },
})

try {
  // —— 跑一段真会话（无人值守：裁决一律批准——验收装置的方便，不是产品行为）——

  /**
   * **帧 ①**——按到达序把两样东西记在一张表上：模型调用的用量读数、压缩发生的时刻。
   * 「上下文变短」就在这张表上一目了然：压缩那一条的**前后两条读数**之差。
   */
  type Mark =
    | { readonly kind: 'usage'; readonly input: number; readonly output: number }
    | { readonly kind: 'compacted'; readonly summary: number }
    | { readonly kind: 'error'; readonly message: string }

  const marks: Mark[] = []

  const handle = await runShellScript(
    assembly.shell,
    { inputs: INPUTS, timeoutMs: 300_000 },
    {
      onEvent: (event: KernelEvent) => {
        if (event.kind === 'model.usage') {
          marks.push({ kind: 'usage', input: event.data.inputTokens, output: event.data.outputTokens })
          return
        }
        if (event.kind === 'context.compacted') {
          marks.push({ kind: 'compacted', summary: event.data.summary })
          return
        }
        if (event.kind === 'error') marks.push({ kind: 'error', message: event.data.message })
      },
    },
  )

  console.log('\n—— 帧 ①：用量与压缩（真读数，按发生序）——')
  marks.forEach((mark, index) => {
    const no = String(index + 1).padStart(2)
    if (mark.kind === 'usage') {
      console.log(`  ${no}. 模型调用　入 ${String(mark.input).padStart(7)} token · 出 ${mark.output}`)
      return
    }
    if (mark.kind === 'compacted') {
      console.log(`  ${no}. ◆ **压缩** —— 摘要条目 #${mark.summary} 入库（context.compacted）`)
      return
    }
    console.log(`  ${no}. ✗ error —— ${mark.message}`)
  })

  // 压缩那一下到底省了多少——拿它前后两条用量读数相比
  const drops: string[] = []
  marks.forEach((mark, index) => {
    if (mark.kind !== 'compacted') return
    const before = [...marks.slice(0, index)].reverse().find((m) => m.kind === 'usage')
    const after = marks.slice(index + 1).find((m) => m.kind === 'usage')
    if (before?.kind !== 'usage' || after?.kind !== 'usage') return
    const delta = after.input - before.input
    drops.push(`  #${mark.summary} 压前 ${before.input} → 压后 ${after.input}（${delta >= 0 ? '+' : ''}${delta}）`)
  })
  if (drops.length > 0) {
    console.log('\n—— 帧 ②：每次压缩省下多少（同一条上下文的前后读数）——')
    for (const line of drops) console.log(line)
  }

  const calls = handle.events.filter((event) => event.kind === 'tool.call')
  console.log(`\n  工具调用 ${calls.length} 次 · 轮次 ${handle.events.filter((e) => e.kind === 'turn.end').length} 回`)
} finally {
  assembly.close()
}

// —— 帧 ②：直读记录库（不经 API 回读）——

const db = new Database(join(sandbox, 'data', 'records.db'), { readonly: true })
const entries = db
  .query<{ id: number; kind: string; content_text: string | null; content_blob: string | null }, []>(
    'SELECT id, kind, content_text, content_blob FROM entries ORDER BY id',
  )
  .all()
const compactedEvents = db
  .query<{ id: number; data: string }, []>("SELECT id, data FROM events WHERE kind = 'context.compacted'")
  .all()
db.close()

console.log('\n—— 帧 ③：记录库（裸 sqlite 直读）——')
for (const entry of entries) {
  const text = entry.content_text ?? `（blob ${entry.content_blob ?? '?'}）`
  const oneLine = text.replace(/\s+/g, ' ')
  console.log(
    `  #${String(entry.id).padStart(3)} ${entry.kind.padEnd(10)} ${oneLine.slice(0, 64)}${oneLine.length > 64 ? '…' : ''}`,
  )
}

console.log(`\n  context.compacted 事件 ${compactedEvents.length} 条：${compactedEvents.map((e) => e.data).join(' ')}`)
console.log(`  沙地 ${sandbox}（留给人复看；不留也无妨）`)
