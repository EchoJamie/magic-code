/** 检查上下文用量、状态行与终端布局。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createShell } from '../../src/shell.ts'
import type { Shell } from '../../src/shell.ts'
import { event } from '../../test/events.ts'
import { createSpyTransport } from '../../test/fakes.ts'
import { rendered, show } from '../../test/screen.ts'

const SCREEN = { columns: 100, rows: 40 } as const

/** 一句已用量（原型状态行 ④ 的样例数）。 */
const used = () => event('model.usage', { inputTokens: 3_100, outputTokens: 6 })

/** 一次**真跑**——分母随之落定（`inputBudget` 就是那一刻的有效输入预算）。 */
const ran = (model: string, provider: string, inputBudget?: number) =>
  event('model.call.start', { choice: 'default',
    model,
    provider,
    ...(inputBudget === undefined ? {} : { inputBudget }),
  })

/** 落一帧：屏上的字（读屏）＋ 外壳写出的原始字节（带色），外加印一份给人看。 */
async function save(out: string, name: string, shell: Shell): Promise<void> {
  const view = shell.getView()
  const screen = await show([view], SCREEN, null)
  const bytes = await rendered([view], SCREEN, null)

  writeFileSync(join(out, `${name}.txt`), `${screen.screen.lines.join('\n')}\n`, 'utf8')
  writeFileSync(join(out, `${name}.ansi`), bytes, 'utf8')
  await Bun.write(Bun.stdout, `── ${name} ──\n${screen.screen.lines.join('\n')}\n\n`)
}

async function main(): Promise<void> {
  const at = process.argv.indexOf('--out')
  const out = process.argv[at + 1] ?? ''
  if (at === -1 || out === '') throw new Error('用法：bun frames-window.ts --out <目录>')

  mkdirSync(out, { recursive: true })

  const spy = createSpyTransport()
  // 开机那一格：外壳还不知道模型名（装配按缺省连接给的读数）
  const shell = createShell(spy.transport, { magicBase: '/test/.magic', contextWindow: 1_000_000 })
  const feed = (...events: Parameters<typeof spy.emit>[0][]): void => {
    for (const item of events) spy.emit(item)
  }

  try {
    await save(out, '01-boot', shell)

    // 跑过一句：③ 有模型名、④ 有分子与分母（1M ⇒ `1000k`）
    feed(ran('MiniMax-M3', 'mm', 1_000_000), used())
    await save(out, '02-known-M3', shell)

    // 换到**另一已知**：切换事件自己带着新模型的预算（204_800 ⇒ `205k`）
    feed(event('model.switched', { choice: 'default', ok: true, provider: 'mm2', model: 'MiniMax-M2', inputBudget: 204_800 }))
    await save(out, '03-switched-known-M2', shell)

    // 换到**用户覆盖过**的那一档（131_072 ⇒ `131k`）
    feed(event('model.switched', { choice: 'default', ok: true, provider: 'mm3', model: 'mini-declared', inputBudget: 131_072 }))
    await save(out, '04-switched-declared', shell)

    // 换到**未知**（自建 llama：内核不带这一位 ⇒ 分母**清空**，不沿用上一个）
    feed(event('model.switched', { choice: 'default', ok: true, provider: 'local', model: 'my-local-llama' }))
    await save(out, '05-switched-unknown', shell)

    // 真跑一个新模型：请求开始那一刻分母就位（不必等整轮收束）
    feed(ran('MiniMax-M3', 'mm', 1_000_000))
    await save(out, '06-call-start-budget', shell)

    await Bun.write(Bun.stdout, `帧落在：${out}\n`)
  } finally {
    shell.dispose()
  }
}

if (import.meta.main) await main()
