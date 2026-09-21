/**
 * 界面验收 · **帧核对**（D30）——把一趟现场里的 `raw.bin` **按字节水位**重放成屏，拿它跟存下来的帧对。
 *
 * 它回答的是那一句：**「这一帧的屏，是不是它自己标注的字节数那一点的样子？」**
 * 判据据此判错时，先拿它把「帧落后于自己标注的字节数」与「应用真没画出来」分开。
 *
 * ## 四种用法
 *
 * ```bash
 * bun packages/app/scripts/frame-audit.ts <现场目录> verify               # 逐帧核对（最常用）
 * bun packages/app/scripts/frame-audit.ts <现场目录> screen <水位>         # 那个水位上屏是什么样
 * bun packages/app/scripts/frame-audit.ts <现场目录> scan <帧文件>         # 找「这一帧像哪个水位」
 * bun packages/app/scripts/frame-audit.ts <现场目录> sweep <起> <止> <串>  # 某串什么时候在屏上
 * bun packages/app/scripts/frame-audit.ts <现场目录> fixed <水位>          # 用**仓里那台 VT** 喂到该水位
 * ```
 *
 * ## 四条口径必须与驱动一致（不然工具本身会骗人）
 *
 * - 水位是**字节**（`Buffer.byteLength(chunk,'utf8')` 累加），不是字符下标——第一版按字符切，
 *   两趟都对不上，是**对照组**把它打出来的；
 * - `resize` 步记录的水位＝**改窗之前**的水位 ⇒ 先喂到水位，再 resize；
 * - 读屏按可见区（`viewportY + rows`），右侧空白裁掉——与 `vt.ts` 同一读法；
 * - **`write` 要等回调**：xterm 的解析是异步的，喂完就读＝读到半截屏（第一版就栽在这儿，
 *   整屏空白，看着还挺像「应用什么都没画」）。
 *
 * ⚠️ 它是**离线取证**：读产物文件，不进驱动的取帧路径，不构成第二套「屏 ↔ 字节」的账。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'

type Step = { n: number; action: string; bytes: number; [k: string]: unknown }
type RunInfo = {
  terminal: { columns: number; rows: number; scrollback: number }
  commit: string
  dirty: boolean
}

function loadRun(runDir: string): { info: RunInfo; steps: Step[]; raw: Buffer } {
  const info = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as RunInfo
  const steps = readFileSync(join(runDir, 'steps.ndjson'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Step)

  return { info, steps, raw: readFileSync(join(runDir, 'raw.bin')) }
}

type Screen = {
  columns: number
  rows: number
  lines: string[]
  cursor: { x: number; y: number; hidden: boolean }
  scrollback: number
  total: number
}

/**
 * 重放到 `watermark` 字节处，返回那一刻的屏。
 *
 * ⚠️ **`write` 必须等回调**：xterm 的解析是异步的，喂完就读＝读到半截屏
 * （第一版就栽在这儿——整屏空白，看着还挺像「应用什么都没画」）。
 */
async function replayTo(
  info: RunInfo,
  steps: Step[],
  raw: Buffer,
  watermark: number,
  uptoStep = Number.POSITIVE_INFINITY,
): Promise<Screen> {
  const term = new Terminal({
    cols: info.terminal.columns,
    rows: info.terminal.rows,
    scrollback: info.terminal.scrollback,
    convertEol: true,
    allowProposedApi: true,
  })

  let columns = info.terminal.columns
  let rows = info.terminal.rows
  let fed = 0

  // 按块解（`stream: true`）——与驱动同口径：切在多字节字符中间时那半个字符不落屏
  const decoder = new TextDecoder()
  const feed = async (to: number): Promise<void> => {
    if (to <= fed) return
    const chunk = decoder.decode(raw.subarray(fed, to), { stream: true })
    fed = to
    if (chunk === '') return
    await new Promise<void>((done) => term.write(chunk, () => done()))
  }

  // 按步走：每一步先把字节喂到它的水位，`resize` 步再在**那之后**改尺寸。
  //
  // ⚠️ 停止条件**不能只看水位**：同一个水位上常有连着好几步（改窗 · 等 · 取帧都停在同一个
  //    水位上——改窗之后应用还没吐字节时就是这样），只看水位就会在改窗那一步**之前**停下，
  //    于是屏还按旧宽度读，整帧对不上。故再按**步号**卡一道（`uptoStep`＝取样那一步）。
  for (const step of steps) {
    if (step.n > uptoStep || step.bytes > watermark) break
    await feed(step.bytes)
    if (step.action === 'resize') {
      columns = step.columns as number
      rows = step.rows as number
      term.resize(columns, rows)
    }
  }
  await feed(watermark)

  const active = term.buffer.active
  const top = active.viewportY
  const lines: string[] = []
  for (let y = 0; y < rows; y += 1) {
    const line = active.getLine(top + y)
    lines.push(line === undefined ? '' : line.translateToString(true).replace(/\s+$/u, ''))
  }
  const core = (term as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core

  return {
    columns,
    rows,
    lines,
    cursor: { x: active.cursorX, y: active.cursorY, hidden: core?.coreService?.isCursorHidden ?? false },
    scrollback: top,
    total: active.length,
  }
}

/** 存下来的帧文件里那段纯文本（`—— 第 N 步 …` 尾巴之前的部分）。 */
function framePlain(frameTxtPath: string): string[] {
  const text = readFileSync(frameTxtPath, 'utf8')
  const cut = text.lastIndexOf('\n\n—— ')

  return (cut === -1 ? text : text.slice(0, cut)).split('\n')
}

const [runDir, mode, arg] = process.argv.slice(2)
if (runDir === undefined || mode === undefined) {
  console.error('用法：<runDir> screen <水位> | <runDir> scan <帧文件> | <runDir> verify | <runDir> sweep <起> <止> <串>')
  process.exit(2)
}

const { info, steps, raw } = loadRun(runDir)

if (mode === 'verify') {
  // 每一帧 ↔ 它自己那一步 `capture` 记的水位：重放到那个水位，逐行比
  const captures = steps.filter((s) => s.action === 'capture')
  const files = readdirSync(join(runDir, 'frames'))
    .filter((n) => n.endsWith('.txt'))
    .sort()
  console.log(`帧数 ${files.length} · capture 步数 ${captures.length}`)
  for (const [i, name] of files.entries()) {
    const step = captures[i]
    const want = framePlain(join(runDir, 'frames', name))
    if (step === undefined) {
      console.log(`${name}：找不到对应的 capture 步`)
      continue
    }
    const w = step.bytes
    const got = (await replayTo(info, steps, raw, w, step.n)).lines
    const bad: number[] = []
    for (let r = 0; r < want.length; r += 1) if (got[r] !== want[r]) bad.push(r)
    if (bad.length === 0) {
      console.log(`✓ ${name}  步 ${step.n} 水位 ${w} —— 逐行一致（${want.length} 行）`)
    } else {
      console.log(
        `✗ ${name}  步 ${step.n} 水位 ${w} —— ${bad.length}/${want.length} 行对不上；` +
          `头一处差异在第 ${bad[0]} 行：\n     存帧「${want[bad[0]]}」\n     重放「${got[bad[0] as number]}」`,
      )
    }
  }
  process.exit(0)
}

if (mode === 'sweep') {
  // 逐字节推进，报出「可见屏上含这个串」的水位区间——增量喂，不重放，快
  const [lo, hi, needle] = [Number(process.argv[4]), Number(process.argv[5]), process.argv[6] as string]
  const term = new Terminal({
    cols: info.terminal.columns,
    rows: info.terminal.rows,
    scrollback: info.terminal.scrollback,
    convertEol: true,
    allowProposedApi: true,
  })
  const decoder = new TextDecoder()
  let columns = info.terminal.columns
  let rows = info.terminal.rows
  let fed = 0
  let has = false
  let on = -1
  const visible = (): boolean => {
    const active = term.buffer.active
    for (let y = 0; y < rows; y += 1) {
      const line = active.getLine(active.viewportY + y)
      if (line?.translateToString(true).includes(needle) === true) return true
    }
    return false
  }
  for (const step of steps) {
    const to = Math.min(step.bytes, hi)
    while (fed < to) {
      const chunk = decoder.decode(raw.subarray(fed, fed + 1), { stream: true })
      fed += 1
      if (chunk !== '') await new Promise<void>((d) => term.write(chunk, () => d()))
      if (fed < lo) continue
      const now = visible()
      if (now !== has) {
        has = now
        if (now) on = fed
        else console.log(`  含「${needle}」：${on} .. ${fed - 1}`)
      }
    }
    if (fed >= hi) break
    if (step.action === 'resize') {
      columns = step.columns as number
      rows = step.rows as number
      term.resize(columns, rows)
    }
  }
  if (has) console.log(`  含「${needle}」：${on} .. ${hi}（到扫描上界仍在）`)
  process.exit(0)
}

if (mode === 'fixed') {
  // 把这一趟的字节喂进**仓里那一台 VT**（`createVt`，与驱动用的是同一支），看修后语义下屏是什么
  const { createVt } = await import('../test/ui/vt.ts')
  const vt = createVt({
    columns: info.terminal.columns,
    rows: info.terminal.rows,
    scrollback: info.terminal.scrollback,
  })
  const w = Number(process.argv[4])
  const decoder = new TextDecoder()
  let fed = 0
  for (const step of steps) {
    const to = Math.min(step.bytes, w)
    if (to > fed) vt.write(decoder.decode(raw.subarray(fed, to), { stream: true }))
    fed = Math.max(fed, to)
    if (fed >= w) break
    if (step.action === 'resize') vt.resize(step.columns as number, step.rows as number)
  }
  if (w > fed) vt.write(decoder.decode(raw.subarray(fed, w), { stream: true }))
  await vt.settled()
  const s = vt.screen()
  for (const [i, line] of s.lines.entries()) console.log(`${String(i).padStart(2, ' ')}|${line.text}`)
  console.log(
    `—— 喂到 ${w} 字节 · 屏对应水位 ${vt.screenBytes()} · 存档 ${s.scrollback} 行 ——`,
  )
  vt.dispose()
  process.exit(0)
}

if (mode === 'screen') {
  const s = await replayTo(info, steps, raw, Number(arg))
  for (const [i, line] of s.lines.entries()) console.log(`${String(i).padStart(2, ' ')}|${line}`)
  console.log(
    `—— ${s.columns}×${s.rows} · 光标 (${s.cursor.x}, ${s.cursor.y})${s.cursor.hidden ? ' 隐藏' : ''} · 存档 ${s.scrollback} 行 · 总 ${s.total} ——`,
  )
  process.exit(0)
}

if (mode === 'scan') {
  const want = framePlain(arg)
  const max = raw.length
  let best = { at: -1, same: -1, diff: 0 }
  // 逐字节扫太慢；先按步水位粗扫，再在最好那条附近细扫
  const marks = [...new Set([...steps.map((s) => s.bytes), max])].sort((a, b) => a - b)
  for (const at of marks) {
    const got = (await replayTo(info, steps, raw, at)).lines
    let same = 0
    for (let i = 0; i < want.length; i += 1) if (got[i] === want[i]) same += 1
    if (same > best.same) best = { at, same, diff: want.length - same }
  }
  console.log(`步水位粗扫：最像的是 ${best.at}（${best.same}/${want.length} 行相同）`)
  // 细扫：在前一个步水位到后一个步水位之间逐字节找完全一致的那一点
  const idx = marks.indexOf(best.at)
  const lo = idx > 0 ? (marks[idx - 1] as number) : 0
  const hi = idx + 1 < marks.length ? (marks[idx + 1] as number) : max
  let exact: number[] = []
  for (let at = lo; at <= hi; at += 1) {
    const got = (await replayTo(info, steps, raw, at)).lines
    if (got.length === want.length && got.every((line, i) => line === want[i])) exact.push(at)
  }
  console.log(
    exact.length === 0
      ? `细扫 ${lo}..${hi}：没有一处逐行完全一致`
      : `细扫 ${lo}..${hi}：完全一致的水位 ${exact[0]}..${exact[exact.length - 1]}（共 ${exact.length} 个）`,
  )
  process.exit(0)
}

console.error(`不认得的 pattern「${mode}」`)
process.exit(2)
