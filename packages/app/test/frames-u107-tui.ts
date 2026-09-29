/**
 * U107 · **剪贴板取图**的留帧装置——真 PTY ＋ 本地模型夹具，落成可核对的帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。按键 → 视图 → 命令那一半在
 * `packages/tui/test/spec.u107.test.ts`；这一条补的是**只有真终端 ＋ 真装配才说得清**的：
 *
 * - **`ctrl+v` 真到得了外壳**（PTY 上真写 `0x16`，不是用例里直接调外壳）；
 * - **内核那一跳真 spawn 了命令、真读回了字节**，并且那一份字节**原样成了 blob**；
 * - 屏上的形态（`Image#N` 落在**插入点**上、没有多余的附件行）——`AGENTS.md` 的看帧四项；
 * - **图真到了端点上**（夹具按出站请求体里的图像部件数张数）；
 * - **反向判据那一屏**：剪贴板里没有图 ⇒ 不产生块、**落一句回执**；
 * - 应用与夹具**由监督者收干净**（`close()` 的 `exit.by`）。
 *
 * ## 剪贴板那一跳怎么替换（**不碰用户的真剪贴板**）
 *
 * `readClipboardImage` 走的是 `PATH` 上的命令（`pngpaste` → `osascript`）。
 * 这一趟**在临时目录里造一个桩 `pngpaste`，把它排到 PATH 最前面**——被测的那条路
 * （spawn → 收字节 → 过尺子 → 落 blob → 插 `Image#N`）**一步都没换**，换的只是
 * 末端那条系统命令。不这么做的话，跑一趟测试就会读（并且要摆布）用户自己的剪贴板，
 * 判据还随他手上正好复制了什么而变。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u107-tui.ts --out <目录>
 * ```
 *
 * 出四屏：`01-贴图` · `02-提交之后` · `03-剪贴板里没有图` · `04-这张太大`。
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDatabase } from './support.ts'
import { tempDir } from './tmp.ts'
import { createUiSession } from './ui/index.ts'
import type { Capture, UiSession } from './ui/index.ts'

/** 1×1 真 PNG（67 字节）——「从剪贴板贴进来的那张图」。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/** 留一屏——文本写进 `<out>/<序号>-<名字>.txt`，字格与光标写进同名 `.json`。 */
function keep(out: string, shot: Capture, label: string): void {
  writeFileSync(join(out, `${label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${label}.json`),
    `${JSON.stringify({ columns: shot.columns, rows: shot.rows, lines: shot.lines }, null, 2)}\n`,
    'utf8',
  )
  console.log(`\n── ${label} ──\n${shot.text}`)
}

/** 打一行字并**等它真出现在屏上**（按键丢了就等不到——不重发，如实失败）。 */
async function typeLine(session: UiSession, text: string, shown = text.trimEnd()): Promise<void> {
  await session.send(text, { until: { text: shown }, timeoutMs: 10_000 })
}

/**
 * 按一个**非文字键**——先等一小会儿再写（PTY 上两次写挨太近会被并成一块读进来，
 * 同 `frames-u36/u37-tui.ts` 那条处置）。
 */
async function pressKey(
  session: UiSession,
  name: 'enter' | 'ctrl+v' | 'left',
  until?: Parameters<UiSession['key']>[1],
): Promise<void> {
  await Bun.sleep(150)
  await session.key(name, until)
}

/** 屏上有没有这一行。 */
function has(shot: Capture, needle: string): boolean {
  return shot.lines.some((line) => line.includes(needle))
}

/** 收过摊的（同一会话只收一次——驱动的 `close` 没有二次调用守卫）。 */
const closed = new WeakSet<UiSession>()

async function close(session: UiSession): Promise<void> {
  if (closed.has(session)) return
  closed.add(session)

  await session.wait({ text: '○ 空闲' }, { timeoutMs: 10_000 }).catch(() => undefined)
  await session.quit()
  const report = await session.close({ graceMs: 3_000 })
  const how = `${report.exit.by}（code ${report.exit.code ?? '-'} / signal ${report.exit.signal ?? '-'}）`

  if (report.exit.by !== 'app') throw new Error(`应用不是自己走的（${how}）——收摊那条路没走完`)

  console.log(`  · 收摊：${how} · 帧 ${report.frames} 张 · 现场 ${report.runDir}`)
}

// —— 那两条系统命令的桩 ——

/**
 * 造一个临时 bin 目录，放一个**桩 `pngpaste`**（把给定的字节吐到 stdout）。
 *
 * 只放 `pngpaste` 一条：`readClipboardImage` 先试它，成了就不往 `osascript` 走
 * ——于是这一趟**一次都不会摸到用户的真剪贴板**。
 */
function stubBin(payload: Uint8Array | null): string {
  const dir = tempDir('magic-u107-bin-')

  // ⚠️ **`osascript` 也要桩上**：不给的话，`pngpaste` 没吐字节时那一趟会落到**真的**
  //    `/usr/bin/osascript` 上，读的就成了**用户自己的真剪贴板**（实测踩过：那一屏报的是
  //    他复制的东西有多大）。判据随他手上有什么而变，那就不是判据了。
  writeFileSync(join(dir, 'osascript'), '#!/bin/sh\necho EMPTY\n', 'utf8')
  chmodSync(join(dir, 'osascript'), 0o755)

  if (payload === null) {
    // **剪贴板里没有图**那一形：退非零、什么都不吐（同真 pngpaste 的表现）
    writeFileSync(join(dir, 'pngpaste'), '#!/bin/sh\nexit 1\n', 'utf8')
  } else {
    writeFileSync(join(dir, 'payload.bin'), payload)
    writeFileSync(join(dir, 'pngpaste'), '#!/bin/sh\ncat "$(dirname "$0")/payload.bin"\n', 'utf8')
  }
  chmodSync(join(dir, 'pngpaste'), 0o755)

  return dir
}

/** `PATH` 那一格——把桩目录排在**最前面**（不是换掉：桩脚本自己要用 `cat` / `dirname`）。 */
function pathWith(bin: string): Record<string, string> {
  return { PATH: `${bin}:${process.env.PATH ?? ''}` }
}

/**
 * 一张**真能过「认图 ＋ 完整性」却超过单张上限**的 PNG。
 *
 * 做法：在那张 1×1 真 PNG 的 `IEND` **之前**插一个够大的辅助块（`tEXt`）。
 * 两张尺子都照旧成立——魔数还是 PNG、`IEND` 还在最后（`checkImageIntact` 查的正是
 * 那 8 个字节），而字节数越过了 5 MiB。内核不解码（`images.ts` 那条注），
 * 故块里塞什么、CRC 对不对都无所谓——这一份**不是**给解码器看的，是给尺子看的。
 */
function hugePng(bytes: number): Buffer {
  const iend = PNG.subarray(PNG.length - 12) // 长度 0 ＋ `IEND` ＋ CRC，共 12 字节
  const payload = Buffer.alloc(Math.max(0, bytes - PNG.length - 12), 0x41)
  const chunk = Buffer.concat([
    ((): Buffer => {
      const head = Buffer.alloc(4)
      head.writeUInt32BE(payload.length, 0)
      return head
    })(),
    Buffer.from('tEXt'),
    payload,
    Buffer.alloc(4), // CRC 随便填（本模块不查它）
  ])

  return Buffer.concat([PNG.subarray(0, PNG.length - 12), chunk, iend])
}

// ══ ①～② 贴一张图：落屏 · 提交 · 记录 ═══════════════════════════════════

async function pasting(out: string): Promise<void> {
  const bin = stubBin(PNG)

  const session = await createUiSession({
    label: 'u107-贴图',
    artifacts: join(out, 'runs'),
    env: pathWith(bin),
    turns: [{ kind: 'text', text: '看到了，是那个报错。', chunks: 3, chunkDelayMs: 40 }],
  })

  try {
    // —— ① `ctrl+v`：那一张落在**插入点**上 ——
    // 先打半句、把插入点挪回句中——判据要的正是「不一律追加到末尾」
    await typeLine(session, '看这儿')
    await pressKey(session, 'left')
    await pressKey(session, 'left')
    await pressKey(session, 'ctrl+v', { until: { text: '› 看Image#1这儿' }, timeoutMs: 15_000 })
    const pasted = await session.capture({ label: '01-贴图' })
    keep(out, pasted, '01-贴图')

    check(has(pasted, '› 看Image#1这儿'), '那一处落在**插入点**上（不是整句的尾巴上）')
    check(has(pasted, 'Image#1'), '引用块写的是**编号**')
    check(!has(pasted, '剪贴板.png'), '**不假装有文件名**（一个字都不上屏）')
    check(!has(pasted, '（待发送）'), '**不另铺常驻附件行**（设计：引用就在正文里）')
    check(session.requests().length === 0, '**贴图不发模型请求**（夹具收到 0 条）')

    // —— ② 提交：那一张真到了端点上 ——
    const before = session.requests().length
    await pressKey(session, 'enter', { until: { text: '看到了，是那个报错。' }, timeoutMs: 15_000 })
    const sent = await session.capture({ label: '02-提交之后' })
    keep(out, sent, '02-提交之后')

    const requests = session.requests()
    check(requests.length === before + 1, `提交之后**正好一次**请求（实测 ${requests.length} 条）`)
    check(requests.at(-1)?.images === 1, `端点上**收到了一张图**（实测 ${requests.at(-1)?.images ?? 0} 张）`)
    // ⚠️ **材料那一块是「引用处随材料展开」**（既有那条路，U37 至今如此）：图片部件与
    // 抬头铺在**引用那一段的位置上**，句子后半截（`这儿`）落在它**之后**——故不能拿
    // 「`看Image#1这儿` 连着」当判据。要钉的是那三件：前后文字都还在、引用在原地、
    // 抬头用的是**同一个名字**。
    const carried = requests.at(-1)?.lastUser ?? ''
    check(carried.includes('看Image#1') && carried.includes('这儿'), '正文一个字不剥（前后文字都在）', carried)
    check(
      carried.includes('〔本次材料 · 图片 Image#1（来源 剪贴板）〕'),
      '抬头说的是**同一个名字**，出处如实写「剪贴板」（没有路径可写）',
      carried,
    )
    check(has(sent, '看Image#1这儿'), '记录区回显的是**原话**')

    // —— ③ 记录：图片引用 ＋ blob，**不是**字节本体 ——
    const raw = readDatabase(join(session.facts().dataDir, 'records.db'))
    const user = raw.entries.filter((row) => row.kind === 'user')
    raw.close()

    const payload = JSON.parse(user[0]?.payload ?? '{}') as {
      readonly refs?: readonly Record<string, unknown>[]
    }
    const ref = payload.refs?.[0]
    check(ref?.['kind'] === 'image', '记录里那一处是 image 支')
    check(ref?.['mime'] === 'image/png', '类型按**字节**认出来记着')
    check(typeof ref?.['blob'] === 'string', '字节另存 blob（载荷里是引用）')
    check(ref?.['source'] === '剪贴板', '**出处如实记**（剪贴板来的没有路径，不编一个）')
    check(JSON.stringify(payload).length < 2000, '载荷里没有字节本体（二进制不进那张表）')
  } finally {
    await close(session)
    rmSync(bin, { recursive: true, force: true })
  }
}

// ══ ④ 剪贴板里没有图：不产生块 ＋ 一句回执 ══════════════════════════════

async function emptyClipboard(out: string): Promise<void> {
  const bin = stubBin(null)

  const session = await createUiSession({
    label: 'u107-空剪贴板',
    artifacts: join(out, 'runs'),
    env: pathWith(bin),
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    await typeLine(session, '先打半句')
    await pressKey(session, 'ctrl+v', { until: { text: '剪贴板是空的' }, timeoutMs: 15_000 })
    const shot = await session.capture({ label: '03-剪贴板里没有图' })
    keep(out, shot, '03-剪贴板里没有图')

    check(has(shot, '剪贴板是空的'), '**回执那一行在屏上**（不许静默失败）')
    check(
      has(shot, '剪贴板是空的——先复制一张图，再按一次。'),
      '说的是**那一件真事**（不是笼统的「没有图」）',
    )
    // 反向判据那一半：**块一个都没有**
    check(has(shot, '› 先打半句'), '草稿**原样**（没多出别的东西）')
    check(!has(shot, 'Image#'), '**不产生块**（一个编号都没有）')
    check(session.requests().length === 0, '**没有发模型请求**（夹具收到 0 条）')
  } finally {
    await close(session)
    rmSync(bin, { recursive: true, force: true })
  }
}

// ══ ⑤ 剪贴板里那张图太大：不产生块 ＋ 说清是哪一个尺子不过 ══════════════

async function tooBig(out: string): Promise<void> {
  const bin = stubBin(hugePng(5 * 1024 * 1024 + 64))

  const session = await createUiSession({
    label: 'u107-太大',
    artifacts: join(out, 'runs'),
    env: pathWith(bin),
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    await typeLine(session, '先打半句')
    await pressKey(session, 'ctrl+v', { until: { text: '超过单张图片的上限' }, timeoutMs: 15_000 })
    const shot = await session.capture({ label: '04-这张太大' })
    keep(out, shot, '04-这张太大')

    check(has(shot, '超过单张图片的上限 5 MiB'), '说的是**哪一把尺子不过**（不是笼统的「没取到」）')
    check(has(shot, '剪贴板里这一张'), '称呼是**剪贴板里这一张**（这一份没有文件名可报）')
    check(!has(shot, 'Image#'), '**不产生块**（一个编号都没有）')
    check(has(shot, '› 先打半句'), '草稿**原样**')
  } finally {
    await close(session)
    rmSync(bin, { recursive: true, force: true })
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const out = at === -1 ? tempDir('magic-frames-u107-') : (process.argv[at + 1] as string)
  mkdirSync(out, { recursive: true })

  await pasting(out)
  await emptyClipboard(out)
  await tooBig(out)
  console.log(`\n全部判据通过。帧落在 ${out}`)
}
