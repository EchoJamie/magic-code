#!/usr/bin/env bun
/**
 * U112 · **符号 ＋ 动效（一套）＋ 状态行可配** —— 真帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。跑法：
 *
 * ```
 * bun packages/tui/test/frames-u112.ts --out <目录>
 * ```
 *
 * ## 这一单要看的那几件事
 *
 * - **四种状态各一张**：工具**进行中**（行尾那一位在动）· **成**（`✓` 定住）·
 *   **败**（`×` 定住）· **等你**（状态格 `◆`，出现时**脉冲一次**）；
 * - **脉冲是动效，静态帧看不出来** ⇒ 另附**逐帧**（同一个 `pulseAt`、四个「此刻」）
 *   ——那几帧连起来读，就是「一路变亮、走完定住」；
 * - **状态行三种**：**没配**（默认那条）· **配了**（挑格 ＋ 顺序）· **有格不可用**（整格省掉）；
 * - **看帧四项**（布局 · 文案 · 层级 · 通读）：留帧就是为了**从上到下一行行读**，
 *   故还留一屏「一整轮」的样子（你 → 助手 → 工具 → 结果 → 回执）。
 *
 * ## 走的是真链路
 *
 * 真外壳（`createShell`）→ 真渲染（Ink）→ 真终端回放（`@xterm/headless` 读屏）。
 * 事件按真内核的形状喂；「此刻」与「脉冲那一刻」由本装置**显式给**——
 * 动效因此**可重放**（同一个输入永远画出同一屏），这正是「另附逐帧」能成立的前提。
 *
 * ⚠️ **留三形**：`*.txt`（屏上的字）· `*.ansi`（写出去的原始字节，带色）·
 * `*.json`（每一行每一格的色与重量——**层级**那一项要看它）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent, StatusLineCell } from '@magic/contracts'
import { createShell } from '../src/shell.ts'
import type { Shell } from '../src/shell.ts'
import type { ShellView } from '../src/view.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
import { rendered, show, showScreen } from './screen.ts'

const SCREEN = { columns: 100, rows: 30 } as const

/** 一个「此刻」的底（毫秒）——写死，好让帧可重放、可逐字比对。 */
const AT = 1_700_000_000_000

/**
 * 一次工具调用（`result` 不给 ＝ 还在跑）。
 *
 * `id` 缺省 71——**同一屏上放两笔时各自给一个**（两笔同一个 id 会互相盖：第二笔的
 * `tool.call` 把第一笔那条行按同一个配对键换掉，屏上就只剩一笔）。
 */
function call(
  name: string,
  args: Readonly<Record<string, unknown>>,
  result?: { ok: boolean; text: string },
  id = 71,
): readonly KernelEvent[] {
  const out: KernelEvent[] = [event('tool.call', { name, args }, { id })]
  if (result !== undefined) {
    out.push(event('tool.result', { call: id, ok: result.ok, output: { text: result.text } }, { id: id + 1 }))
  }

  return out
}

/** 落一帧：屏上的字（读屏）＋ 原始字节（带色）＋ 每格的色与重量。 */
async function save(
  out: string,
  name: string,
  view: ShellView,
  now: number | null = null,
  pulseAt: number | null = null,
): Promise<void> {
  const screen = await show([view], SCREEN, now, pulseAt)
  const bytes = await rendered([view], SCREEN, now, pulseAt)

  writeFileSync(join(out, `${name}.txt`), `${screen.screen.lines.join('\n')}\n`, 'utf8')
  writeFileSync(join(out, `${name}.ansi`), bytes, 'utf8')
  writeFileSync(
    join(out, `${name}.json`),
    `${JSON.stringify(
      { columns: SCREEN.columns, rows: SCREEN.rows, lines: screen.screen.lines, cells: screen.screen.lines.map((_line, row) => screen.cellsOf(row)) },
      null,
      1,
    )}\n`,
    'utf8',
  )

  await Bun.write(Bun.stdout, `── ${name} ──\n${screen.screen.lines.join('\n')}\n\n`)
}

/**
 * 落一帧**查看那一屏**（U110 起「展开」在那儿）——同一形（txt/ansi/json）。
 *
 * 这一支是给**裁定③那一格**用的：结果正文块与 `diff` 的缩进要**同一级**，
 * 而两者都只在展开之后才画得出来（内联那一半恒折叠，见 `spec.log.test.ts` 那条注）。
 */
async function saveScreen(out: string, name: string, view: ShellView): Promise<void> {
  const frame = await showScreen(view)
  const lines = frame.screen.lines

  writeFileSync(join(out, `${name}.txt`), `${lines.join('\n')}\n`, 'utf8')
  writeFileSync(
    join(out, `${name}.json`),
    `${JSON.stringify({ lines, cells: lines.map((_line, row) => frame.cellsOf(row)) }, null, 1)}\n`,
    'utf8',
  )

  await Bun.write(Bun.stdout, `── ${name} ──\n${lines.join('\n')}\n\n`)
}

/** 一屏的底子：会话已开、这一轮在跑、答复已经吐了一句。 */
const ENOUGH: readonly KernelEvent[] = [
  event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '改时区' }] }),
  event('turn.start', {}, { id: 40 }),
  event('model.delta', { channel: 'text', text: '我先看一眼这个文件。' }, { id: 41 }),
]

/**
 * 一句话＋一串事件——**照着真用法来**：那句交代是**敲进去的**（真按键走到外壳），
 * 不是编一条事件顶上（回显那一行由外壳自己落，见 `view.ts` 的 `user.echo`）。
 */
function live(
  sayText: string,
  events: readonly KernelEvent[],
  options: Parameters<typeof createShell>[1] = {},
): Shell {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport, options)
  for (const char of sayText) shell.key({ kind: 'char', char })
  shell.key({ kind: 'enter' })
  for (const item of events) spy.emit(item)

  return shell
}

/** 状态行那三张的真源——会话名 / 模型 / 上下文占用 / 工作区都摆上值。 */
const MODEL_KNOWN: readonly KernelEvent[] = [
  event('model.call.start', { model: 'MiniMax-M3', provider: 'minimax', inputBudget: 996_000 }, { id: 50 }),
  event('model.usage', { inputTokens: 3_100, outputTokens: 6 }, { id: 51 }),
]

async function main(): Promise<void> {
  const at = process.argv.indexOf('--out')
  const out = process.argv[at + 1] ?? ''
  if (at === -1 || out === '') throw new Error('用法：bun frames-u112.ts --out <目录>')
  mkdirSync(out, { recursive: true })

  // —— 一 · 四种状态（工具那三张 ＋ 等你那一张）——

  const running = live('看看这个文件', [...ENOUGH, ...call('exec', { cmd: 'sleep 2 && chmod 755 .' })])
  // 「此刻」给在发起之后 1.4 秒——行尾那一位按那一刻的亮度画（呼吸的一档）
  await save(out, '01-工具-进行中', running.getView(), AT + 71 + 1_400)

  const done = live('看看这个文件', [
    ...ENOUGH,
    ...call('read', { path: 'src/records/db.ts' }, { ok: true, text: '这是一份 42 行的文件' }),
  ])
  await save(out, '02-工具-成', done.getView())

  const failed = live('看看这个文件', [
    ...ENOUGH,
    ...call('exec', { cmd: 'make test' }, { ok: false, text: '没有这个目标——先看 Makefile' }),
  ])
  await save(out, '03-工具-败', failed.getView())

  /**
   * **等你在脉冲**——静态帧看不出动效，故**逐帧**：同一个 `pulseAt`（那一刻）、
   * 四个「此刻」把那一趟脉冲走完（0 → 300 → 600 → 1200 毫秒）。
   */
  const waiting = live('看看这个文件', [
    ...ENOUGH,
    ...call('write', { path: 'src/records/db.ts' }),
    event('tool.decision.request', { call: 71, name: 'write', material: '整写文件 src/records/db.ts', weight: 'heavy' }, { id: 88 }),
  ])
  for (const [index, step] of [0, 300, 600, 1200].entries()) {
    await save(out, `04-等你-脉冲-${index + 1}`, waiting.getView(), AT + 88 + step, AT + 88)
    // **色才是那一次脉冲的证据**（四张 `.txt` 整帧逐字相同——动的是亮度，不是字）
    const frame = await show([waiting.getView()], SCREEN, AT + 88 + step, AT + 88)
    await Bun.write(Bun.stdout, `   ↳ 状态格那一位的色：${frame.cellsOf(frame.statusRow)[1]?.fg ?? '（默认）'}\n\n`)
  }

  // —— 二 · 状态行那三张 ——

  const plain = live('看看这个文件', [...ENOUGH, ...MODEL_KNOWN])
  await save(out, '05-状态行-没配', plain.getView())

  const picked: readonly StatusLineCell[] = ['workspace', 'model', 'reasoning', 'context', 'session']
  const configured = live('看看这个文件', [...ENOUGH, ...MODEL_KNOWN], {
    statusLine: { cells: picked },
    workspaceRoots: ['/Users/who/code/magic-code'],
  })
  await save(out, '06-状态行-配了', configured.getView())

  // **有格不可用**：挑了三格，可这三格此刻都拿不到值（还没跑过任何一次调用 ⇒ 没有模型、
  // 没有用量；也没给工作区）⇒ **整格省掉**（不占位、不显示空值）
  const missing = createShell(createSpyTransport().transport, {
    statusLine: { cells: ['workspace', 'model', 'reasoning', 'context', 'session'] },
  })
  await save(out, '07-状态行-有格不可用', missing.getView())

  // —— 三 · 通读：一整轮的样子（你 → 助手 → 工具 → 结果 → 回执）——
  //
  // 一屏里把这一单动过的那几处**放在一起读**：助手顶格 · 工具行缩进一级 ＋ 行尾状态位 ·
  // 结果缩进一级不加符号 · 回执 `·` · 字标 · 两线 · 状态行。
  const whole = live('看看这个文件', [
    ...ENOUGH,
    ...call('read', { path: 'src/records/db.ts' }, { ok: true, text: '这是一份 42 行的文件' }),
    event('model.delta', { channel: 'text', text: '看过了：这一份是记录域的开库那一段。' }, { id: 60 }),
    event('turn.end', { reason: 'settled' }, { id: 61 }),
  ])
  await save(out, '08-通读-一轮', whole.getView())

  // **减少动效**那一档也留一张（进行中那一位定住、秒数照旧）
  const still = live('看看这个文件', [...ENOUGH, ...call('exec', { cmd: 'sleep 2 && chmod 755 .' })], { reducedMotion: true })
  await save(out, '09-减少动效-进行中', still.getView(), AT + 71 + 1_400)

  // —— 四 · 配置那一屏（③ 的入口：`/config` 多两行 ＋ 状态行那一屏）——

  const configSpy = createSpyTransport()
  const config = createShell(configSpy.transport, { workspaceRoots: ['/Users/who/code/magic-code'] })
  for (const char of '/config') config.key({ kind: 'char', char })
  config.key({ kind: 'enter' })
  for (const item of [
    event('model.catalog', {
      entries: [{ provider: 'minimax', name: '个人版', model: 'MiniMax-M3' }],
      current: { provider: 'minimax', model: 'MiniMax-M3' },
    }),
    event('grants.catalog', {
      workspace: '/Users/who/code/magic-code',
      grants: [],
      stale: [],
      decisions: { total: 0, uncovered: 0, vetoed: 0 },
      history: { total: 0, auto: 0, kernel: 0 },
    }),
    event('mcp.catalog', { servers: [] }),
  ]) {
    configSpy.emit(item)
  }
  await save(out, '10-配置-两行', config.getView())

  // 走到「状态行」那一行上，回车进它自己那一屏
  for (let step = 0; step < 4; step += 1) config.key({ kind: 'down' })
  config.key({ kind: 'enter' })
  await save(out, '11-配置-状态行那一屏', config.getView())

  // —— 五 · **结果缩进那一条**（裁定③）：正文块与 diff **同一级（4 列）** ——
  //
  // 两张放一起读：一样都是「某个工具的结果」，缩进深浅必须一样
  // （改前是正文 2 列、diff 4 列——同一屏两级不一致）。
  const indented = live('看看这个文件', [
    ...ENOUGH,
    ...call('read', { path: 'src/records/db.ts' }, { ok: true, text: '第一行\n第二行' }, 201),
    ...call('edit', { path: 'src/records/db.ts', old: 'let a = 1', new: 'let a = 2' }, { ok: true, text: '改好了' }, 301),
  ])
  await saveScreen(out, '12-结果缩进-两级都在四列', indented.getView())

  console.log(`帧落在 ${out}`)
}

if (import.meta.main) await main()
