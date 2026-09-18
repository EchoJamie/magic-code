/**
 * 流式基准（U21 · **测量装置**，不是用例——`bun test` 不收它）。
 *
 * ## 量什么
 *
 * 三样里这一份管两样（第三样「启动到首帧」在 `@magic/app` 的 `bench-boot.ts`）：
 *
 * - **流式跟手度**——长输出流进来时**卡不卡**。两条读数：
 *   ① **事件循环滞后**（`lag`）：流式期间每隔 1ms 排一个定时器，量它实际迟到多久。
 *      渲染若把主线程占满，这个数当场鼓起来——**「卡」在进程内的可判定形态就是它**；
 *   ② **内容上屏延迟**：一条 delta 投出去 → 它的尾巴出现在 stdout 的字节里，花了多久。
 * - **外壳侧首字延迟**——`回车 → 第一个字上屏`。真端点那一段（网络 TTFT）不在这一层，
 *   由 `bench-boot.ts` 的真端点那一档量；这里量的是**外壳自己**那一跳：事件到手 → 上屏。
 *
 * ## 为什么用合成流（而不是真端点）
 *
 * 真端点的节奏受网络与供应商摆布，两次跑的数没有可比性——**优化前后要对照，就得先把
 * 输入钉死**。故这里按**固定节奏**投事件，外壳那一侧走的是**真路径**：
 * 真 `TuiApp` · 真 Ink（**生产档 `maxFps`**，不是 `terminal.ts` 录制用的 `0`）· 真归约。
 *
 * ## 跑法
 *
 * ```
 * FORCE_COLOR=0 bun packages/tui/test/bench-stream.ts            # 默认档
 * FORCE_COLOR=0 bun packages/tui/test/bench-stream.ts --quick    # 只跑一轮（调试用）
 * ```
 *
 * ⚠️ **看数别只看均值**：判「卡」的是 **p95 / max**。均值好看而 max 一柱子高的，
 * 用户照样看得见那一下顿。
 */

import { EventEmitter } from 'node:events'
import { render } from 'ink'
import type { Instance } from 'ink'
import { createElement as h } from 'react'
import type { Command, ControlTransport, EventEnvelope, KernelEvent, SessionId } from '@magic/contracts'
import { TuiApp } from '../src/components/app.ts'
import { createShell } from '../src/shell.ts'

// ── 计时 ──────────────────────────────────────────────────────────────

/** 单调毫秒（`performance.now()`——墙钟会被 NTP 拽走）。 */
const now = (): number => performance.now()
const ms = (value: number): string => value.toFixed(1)

/** 一串读数的分位。 */
function stats(values: readonly number[]): { p50: number; p95: number; max: number; n: number } {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0, n: 0 }

  const sorted = [...values].sort((left, right) => left - right)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number

  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] as number, n: sorted.length }
}

// ── 假终端（Ink 只用得上这几个成员——同 `terminal.ts`，但**带时间戳**）──────

/**
 * 假 stdout——`isTTY` 为真（Ink 只在真终端上走擦行那条路），**记下每次写出的时刻与字节**。
 *
 * `maxFps` 走 Ink 的**生产缺省**（30）：`terminal.ts` 录制时取 `0` 是为了「一帧就是一帧」，
 * 而这里要量的正是**用户面前那一档**。
 */
class StampedTty extends EventEmitter {
  readonly isTTY = true
  readonly destroyed = false
  readonly writableEnded = false
  /** 每次 `write` 的时刻（毫秒，与 `now()` 同源）。 */
  readonly writes: { at: number; text: string }[] = []

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super()
  }

  write = (chunk: string): boolean => {
    this.writes.push({ at: now(), text: chunk })
    return true
  }

  /** 自 `from` 起（含）写出去的全部字节。 */
  bytesSince(from: number): string {
    let out = ''
    for (let index = from; index < this.writes.length; index += 1) out += (this.writes[index] as { text: string }).text

    return out
  }

  get writeCount(): number {
    return this.writes.length
  }
}

class FakeStdin extends EventEmitter {
  readonly isTTY = true
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => null
}

/** 剥 ANSI——判「这段字上屏了没有」只能看文字（色码会把子串切断）。 */
function plain(text: string): string {
  return text.replace(/\[[0-9;?]*[A-Za-z]/gu, '')
}

// ── 可编程传输 ────────────────────────────────────────────────────────

/**
 * 能**按需投事件**的传输（外壳侧写起，内核侧推）。
 *
 * 与 `fakes.ts` 的 `createSpyTransport` 同形，但**只留这一档要的那几件**：
 * 这个文件量的是耗时，替身的每一层包装都会进到被量的那段时间里。
 */
function programmable(): {
  readonly transport: ControlTransport
  readonly emit: (event: KernelEvent) => void
} {
  const listeners = new Set<(event: KernelEvent) => void>()

  return {
    transport: {
      send: (_command: Command): void => {},
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

// ── 事件（形态照契约，`id` / `at` 单调）────────────────────────────────

const SESSION: SessionId = 'bench-session'
let sequence = 0

/** 一条正文增量（**按契约的信封造**——不强转，与 `events.ts` 同法）。 */
function delta(text: string, at: number): EventEnvelope<'model.delta'> {
  sequence += 1

  return {
    id: sequence,
    session: SESSION,
    turn: 1,
    at,
    kind: 'model.delta',
    // `channel: 'text'` 那一支只认 `text`（`data.id` 是供应商侧的调用 id，走工具那条）
    data: { channel: 'text', id: 'bench', text },
  }
}

// ── 量一档 ────────────────────────────────────────────────────────────

export type StreamSpec = {
  readonly label: string
  /** 投几条。 */
  readonly deltas: number
  /** 每条之间等多久（毫秒）——`0` ＝ 尽可能快（**最坏情况**：模型比外壳快）。 */
  readonly gapMs: number
  /** 一个「词」长什么样（按序号生成——末词可判「上屏了没有」）。 */
  readonly word: (index: number) => string
  readonly columns: number
  readonly rows: number
}

export type StreamResult = {
  readonly label: string
  /** 全部投完 ＋ 屏上出现末词的总墙钟（毫秒）。 */
  readonly wallMs: number
  /** 每条 delta 的「投递 → 它的末词上屏」延迟。 */
  readonly wordLag: readonly number[]
  /** 流式期间的事件循环滞后（定时器迟到）。 */
  readonly loopLag: readonly number[]
  /** 写完的帧数。 */
  readonly frames: number
  /** 流式期间按一次键（打到草稿里）→ 那个字上屏，花了多久。 */
  readonly keyEchoMs: number | null
  /** **校验**：末词真的到屏上了（折行切开的词按「抹掉全部空白」对齐）。假的数不算数。 */
  readonly landed: boolean
}

export async function streamBench(spec: StreamSpec): Promise<StreamResult> {
  const kernel = programmable()
  const shell = createShell(kernel.transport)
  const stdout = new StampedTty(spec.columns, spec.rows)
  const stdin = new FakeStdin()

  const app: Instance = render(h(TuiApp, { shell }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })

  // 等首帧挂上再开始投（否则量到的是「Ink 还没起」那一段）
  await app.waitUntilRenderFlush()

  // —— 事件循环滞后探针：流式全程都排着 ——
  const loopLag: number[] = []
  let ticking = true
  const TICK = 1
  let last = now()
  const ticker = (): void => {
    if (!ticking) return
    const at = now()
    loopLag.push(at - last - TICK)
    last = at
    setTimeout(ticker, TICK)
  }
  setTimeout(ticker, TICK)

  // —— 按键回声探针：流到一半时按一个键 ——
  let keyEchoMs: number | null = null
  const keyAt = Math.max(1, Math.floor(spec.deltas / 2))
  const KEY = '◆'

  const sentAt: number[] = []
  const started = now()

  for (let index = 0; index < spec.deltas; index += 1) {
    const sent = now()
    sentAt.push(sent)
    kernel.emit(delta(spec.word(index), Math.round(sent)))

    if (index === keyAt) {
      const pressedAt = now()
      const keysBefore = stdout.writeCount
      shell.key({ kind: 'char', char: KEY })
      await waitFor(() => stdout.writeCount > keysBefore)
      keyEchoMs = now() - pressedAt
    }

    // ⚠️ **照节奏投，不等上屏**——「等这一条上屏了再投下一条」是把**屏的节拍**串进了读数：
    // 外壳一旦合批，每条都白等一个窗口，量出来的就成了窗口宽度而不是它的本事。
    // 投递与落地在这里**解耦**：投完在事后按写出的时刻回算各自的延迟（见下）。
    if (spec.gapMs > 0) await sleep(spec.gapMs)
    else await new Promise<void>((resolve) => setImmediate(resolve))
  }

  // 收尾：把最后那帧等出来（末条多半还在节流窗口里）
  await app.waitUntilRenderFlush()
  const lastSent = sentAt[sentAt.length - 1] ?? 0
  await waitFor(() => (stdout.writes[stdout.writeCount - 1]?.at ?? 0) >= lastSent, 2_000)
  const stopAt = now()
  const wallMs = now() - started

  ticking = false
  // **末尾一次校验**（不参与计时）：末词真到屏上了吗？折行会把词切开，
  // 故把**全部空白抹掉**再认——那是「屏上文字」与「应然文字」的对齐。
  const shown = plain(stdout.bytesSince(0)).replace(/\s+/gu, '')
  const landed = shown.includes(spec.word(spec.deltas - 1).replace(/\s+/gu, ''))

  // —— 事后回算每条 δ 的上屏延迟 ——
  // 一次写出画的是**那一瞬间的整屏**，故它带上的是「此前投出去、还没画过的」全部 δ。
  // 按写出的时刻切段：落在 (上一次写出, 这一次写出] 里的 δ 共享这一次写出的时刻。
  const wordLag: number[] = []
  let cursor = 0
  for (const write of stdout.writes) {
    if (write.at < started || write.at > stopAt) continue
    while (cursor < sentAt.length && (sentAt[cursor] as number) <= write.at) {
      wordLag.push(write.at - (sentAt[cursor] as number))
      cursor += 1
    }
  }
  // 尾巴上那些还没画出来的（若有）按收尾那一刻算——**不能悄悄丢掉**，那正是最慢的那批
  while (cursor < sentAt.length) {
    wordLag.push(stopAt - (sentAt[cursor] as number))
    cursor += 1
  }

  app.unmount()
  shell.dispose()

  return { label: spec.label, wallMs, wordLag, loopLag, frames: stdout.writeCount, keyEchoMs, landed }
}

const sleep = (duration: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, duration))

/**
 * 等一个条件成立（超时抛——等不到就是真没上屏）。
 *
 * ⚠️ **轮询用 `setImmediate` 不用 `setTimeout(0)`**：后者有 ~1ms 的钳位，
 * 每等一次就白送 1ms 进读数（量的是十几毫秒这一档，那 1ms 不是小数）。
 */
async function waitFor(test: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = now() + timeoutMs

  while (now() < deadline) {
    if (test()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  throw new Error('基准超时：等不到那一帧')
}

/** 一条词——`w0001` 这样，末词好认。 */
function word(index: number): string {
  return `w${String(index).padStart(5, '0')} `
}

// ── 档位 ──────────────────────────────────────────────────────────────

/** 一屏的尺寸——与 `terminal.ts` 的 TERMINAL 同（110 × 40，原型那台）。 */
const COLUMNS = 110
const ROWS = 40

export const SPECS: readonly StreamSpec[] = [
  // ① **最坏情况**：模型比外壳快（每条之间不等）——吞吐靠外壳自己撑
  { label: '极速 · 2000 条', deltas: 2000, gapMs: 0, word, columns: COLUMNS, rows: ROWS },
  // ② **真节奏**：20ms/条 ≈ 50 条/秒（真人看的那种流）——该跟得上
  { label: '常速 · 500 条 @20ms', deltas: 500, gapMs: 20, word, columns: COLUMNS, rows: ROWS },
]

/** 跑一轮并把读数打到 stdout（**格式固定**——前后对照直接并排看）。 */
export async function run(specs: readonly StreamSpec[] = SPECS): Promise<readonly StreamResult[]> {
  const results: StreamResult[] = []

  for (const spec of specs) {
    const result = await streamBench(spec)
    results.push(result)

    const word = stats(result.wordLag)
    const loop = stats(result.loopLag)

    console.log(`\n── ${result.label} ──`)
    console.log(`  总墙钟      ${ms(result.wallMs)}ms · 帧 ${result.frames} · 末词上屏 ${result.landed ? '✓' : '✗'}`)
    console.log(`  上屏延迟    p50 ${ms(word.p50)} · p95 ${ms(word.p95)} · max ${ms(word.max)}ms`)
    console.log(`  事件循环滞后 p50 ${ms(loop.p50)} · p95 ${ms(loop.p95)} · max ${ms(loop.max)}ms`)
    console.log(`  按键回声    ${result.keyEchoMs === null ? '（没量）' : `${ms(result.keyEchoMs)}ms`}`)
  }

  return results
}

if (import.meta.main) {
  const quick = process.argv.includes('--quick')
  await run(quick ? [SPECS[1] as StreamSpec] : SPECS)
}
