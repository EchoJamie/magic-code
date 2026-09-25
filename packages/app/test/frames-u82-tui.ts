#!/usr/bin/env bun
/**
 * U82 · **大结果：屏幕别印哈希，模型那份要头也要尾**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `.test.ts`）。
 *
 * ## 这一单治的两处病（`D40` · 用户真跑指出）
 *
 * 超过 `BLOB_THRESHOLD_BYTES`（8 KiB）的工具结果——**同一件事，两处独立的病**：
 *
 * - **屏幕**：落一串 64 位 sha256（`（大块转存 2252f436…）`）。用户原话是把它读成
 *   「**有个转储文件**」——那串 id 是**我们自己才认识的**，面向用户的字里不该有它；
 * - **模型那一份**：`deliveredTextOf` 只 `slice(0, limit)`——**只留开头 2000 字符**，
 *   而构建日志的报错在**末尾**（现场见 `D40`）。模型看不见结论，于是改写新命令去探。
 *
 * ## 四张帧
 *
 * | 帧 | 工单那一格 | 该在屏上（与请求体里）看见什么 |
 * | --- | --- | --- |
 * | `01` | **① 大结果 · 收起** | 那一行说「**大块输出 N 行（屏幕上没铺全）**」；**整屏找不到那串 sha256**（也找不到「大块转存」四个字） |
 * | `02` | **① 大结果 · 展开** | 正文上屏：头段、**中段**、**末段**都在缓冲里（那一行真看得见内容） |
 * | `03` | **① 反面：小结果照旧** | 小于 8 KiB 的结果**逐字未变**（`✓ … · 小结果`——大块那套说法不碰它） |
 * | `04` | **② 模型那一份** | 夹具收到的那条 `tool` 消息：**头在、尾在**，省略处**报数**且**指得出怎么读全** |
 *
 * ## 三处装置上的讲究（都不是产品行为）
 *
 * - **`02` 那一按要在「还在跑」的时候按**（U72 的留帧记过同一条）：`ctrl+o` 只对
 *   **还在活动区**的行管用——已定局的行进 `<Static>`，**写一次就不再重绘**（按了等于没按）。
 *   故这一帧的造法＝**发出去就按**，等结果落下来时它就是展开的那一形。
 *   ⚠️ 这是**既有渲染模型的限度**，不是本单引入的；本单也因此**不**在屏上印「按 ctrl+o」
 *   这类指路的话（定局之后那句话就是个跑不了的入口）。限度如实记在回报里。
 * - **命令末尾挂一个 `sleep 2`**：让那一行**在结果落下来之前一直是活的**，
 *   `ctrl+o` 因此按得准（`seq` 本身只要几毫秒）。
 * - **正文每行带一个前缀**（`u82a-1`…）：正文与别的东西（帧号、行号）不易撞脸，
 *   判据按整行找它。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u82-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSandbox, createUiSession, startFixture } from './ui/index.ts'
import type { Capture, FixtureTurn, Sandbox, UiSession } from './ui/index.ts'
import { tempDir } from './tmp.ts'

/** 这一趟的产物根——入口解析 `--out` 之后填。 */
let out = ''

/** 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/** 留一屏——文本写进 `<out>/<名字>.txt`，字格与光标写进同名 `.json`。 */
function keep(shot: Capture, name: string): void {
  writeFileSync(join(out, `${name}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${name}.json`),
    `${JSON.stringify(
      {
        columns: shot.columns,
        rows: shot.rows,
        cursor: shot.cursor,
        scrollback: shot.scrollback,
        lines: shot.lines,
        history: shot.history,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${name} ──（${shot.columns}×${shot.rows} · scrollback ${shot.scrollback}）\n${shot.text}`)
}

/** 一行在不在**可见屏**上（按行找，与 `session.wait` 同一条尺子）。 */
function has(shot: Capture, needle: string): boolean {
  return shot.lines.some((line) => line.includes(needle))
}

/** 整个缓冲（含滚进 scrollback 的）里有没有**正好是这一行**的行。 */
function lineIn(shot: Capture, text: string): boolean {
  return shot.history.some((line) => line.trim() === text)
}

/** 可见屏上含某词的整行（报错时贴给人看）。 */
function linesWith(shot: Capture, needle: string): string {
  return shot.lines
    .map((line) => line.trim())
    .filter((line) => line.includes(needle))
    .join(' ⏎ ')
}

/** 64 位十六进制——**blob 的引用长相**（sha256）。屏上、请求体里都不该有它。 */
const SHA256 = /\b[0-9a-f]{64}\b/

// ══ 造大 / 小结果的那两条命令 ═══════════════════════════════════════

/**
 * **> 8 KiB 的输出**：1200 行 × 每行 12 字符 ≈ 14.4 KB（越过 `BLOB_THRESHOLD_BYTES` 的 8 KiB）。
 *
 * - 每行带前缀 `u82a-`：判据按整行找它，不与别的东西撞脸；
 * - 末尾挂 `sleep 2` 是**装置上的**讲究——见文件头注（那一按得落在「还在跑」的时候）；
 * - 1200 行也**小于那一趟的 scrollback 上限**（2000）：展开之后整份正文都还在缓冲里可查。
 */
const BIG_CMD = 'seq 1 1200 | sed "s/^/u82a-/"; sleep 2'

/** 展开那一帧再跑一次——**换一个前缀**（`u82b-`），两趟的正文因此分得开。 */
const BIG_CMD_2 = 'seq 1 1200 | sed "s/^/u82b-/"; sleep 2'

/** 小结果（远小于阈值）——反面那一帧用：这一改不该碰它。 */
const SMALL_CMD = 'echo 小结果'

/** 长交代（> 8192 字符 ⇒ 存成 blob）——`04` 那一帧用；头尾各留一个认得出的标记。 */
const LONG_HEAD = '〔这段交代的开头〕'
const LONG_TAIL = '〔而这里是要害：末尾这句要求〕'
const LONG_FILL = 9000

/** 越过 `EXEC_MAX_OUTPUT_BYTES`（64 KiB）的那一条——`06` 对照帧用。 */
const HUGE_CMD = 'seq 1 20000 | sed "s/^/u82h-/"'

// ══ 起手与收摊 ══════════════════════════════════════════════════════

async function openScene(options: {
  readonly label: string
  readonly turns: readonly FixtureTurn[]
}): Promise<{ readonly session: UiSession; readonly sandbox: Sandbox; readonly fixture: { stop(): Promise<void> } }> {
  const fixture = startFixture({ turns: options.turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const session = await createUiSession({
    label: options.label,
    artifacts: join(out, 'runs'),
    sandbox,
    fixture,
    columns: 100,
    rows: 40,
  })
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

  return { session, sandbox, fixture }
}

/** 收摊：先照产品的方式退，再停夹具、删沙地。 */
async function closeScene(scene: {
  readonly session: UiSession
  readonly sandbox: Sandbox
  readonly fixture: { stop(): Promise<void> }
}): Promise<void> {
  try {
    await scene.session.quit()
  } finally {
    await scene.session.close({ graceMs: 3_000 })
    await scene.fixture.stop()
    scene.sandbox.dispose()
  }
}

/** 打一行字并**等它真出现在屏上**（文本与回车分两次写——挤在同一次写里按键会丢）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

// ══ ① 大结果：收起那一屏 / 展开那一屏 ＋ ③ 小结果照旧 ═══════════════

async function sceneScreen(): Promise<void> {
  const scene = await openScene({
    label: 'u82-屏幕',
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: BIG_CMD } },
      { kind: 'text', text: '跑完了。' },
      { kind: 'tool', name: 'exec', args: { cmd: BIG_CMD_2 } },
      { kind: 'text', text: '再跑完了。' },
      { kind: 'tool', name: 'exec', args: { cmd: SMALL_CMD } },
      { kind: 'text', text: '小的也跑了。' },
    ],
  })

  try {
    // —— 01 收起：不按 ctrl+o，等它跑完 ——
    await typeLine(scene.session, '跑个大输出')
    // ⚠️ 等的是**这一趟才会出现的那句话**（不是「空闲」——提交之后到状态行翻过去之间，
    //    屏上还写着上一轮那个「空闲」，照那个等会落在上一轮还没走完的时候）
    await scene.session.key('enter', { until: { text: '跑完了。' }, timeoutMs: 60_000 })
    await scene.session.wait({ text: '○ 空闲' }, { timeoutMs: 30_000 })

    const collapsed = await scene.session.capture({ label: '01-大结果收起' })
    keep(collapsed, '01-大结果收起')

    check(
      has(collapsed, '✓') && has(collapsed, '大块输出 1200 行'),
      '① 那一行报得出「这块有多大」（1200 行）',
      linesWith(collapsed, 'exec'),
    )
    check(
      has(collapsed, '屏幕上没铺全'),
      '① 说得出「没全带回来」（不是装作它小）',
      linesWith(collapsed, '大块输出'),
    )
    check(
      !collapsed.history.some((line) => SHA256.test(line)),
      '① 整屏（含 scrollback）**一处都没有那串 sha256**',
      collapsed.history.filter((line) => SHA256.test(line)).join(' ⏎ '),
    )
    check(
      !collapsed.history.some((line) => line.includes('大块转存')),
      '① 也没有「大块转存」这句旧话（引用本身一个字都不落屏）',
    )

    // —— 02 展开：**在跑动中按**（见文件头注），结果落下来就是展开那一形 ——
    await scene.session.key('ctrl+o')
    await typeLine(scene.session, '再跑一次，这次展开着')
    await scene.session.key('enter', { until: { text: '再跑完了。' }, timeoutMs: 60_000 })
    await scene.session.wait({ text: '○ 空闲' }, { timeoutMs: 30_000 })

    const expanded = await scene.session.capture({ label: '02-大结果展开' })
    keep(expanded, '02-大结果展开')

    check(
      lineIn(expanded, 'u82b-1'),
      '② 正文**头段**到了屏上（`u82b-1` 在缓冲里）',
    )
    check(
      lineIn(expanded, 'u82b-600'),
      '② 正文**中段**到了屏上（`u82b-600` 在缓冲里）',
    )
    check(
      lineIn(expanded, 'u82b-1200'),
      '② 正文**末段**到了屏上（`u82b-1200` 在缓冲里——结论就在这一头）',
    )
    check(
      expanded.scrollback > 200,
      '② 那一千多行真写进了 scrollback（不是只画了屏上那几十行）',
      `scrollback=${expanded.scrollback}`,
    )
    check(
      !expanded.history.some((line) => SHA256.test(line)),
      '② 展开之后照样一处都没有那串 sha256',
    )

    // —— 03 反面：小结果照旧（先收起来，好照改前那一形看） ——
    await scene.session.key('ctrl+o')
    await typeLine(scene.session, '跑个小输出')
    await scene.session.key('enter', { until: { text: '小的也跑了。' }, timeoutMs: 60_000 })
    await scene.session.wait({ text: '○ 空闲' }, { timeoutMs: 30_000 })

    const small = await scene.session.capture({ label: '03-小结果照旧' })
    keep(small, '03-小结果照旧')

    check(
      has(small, '✓') && has(small, '小结果'),
      '③ 小结果照旧原样（`✓ … · 小结果`——那一改没碰到它）',
      linesWith(small, 'exec'),
    )
    check(
      !has(small, '大块输出') && !has(small, '屏幕上没铺全'),
      '③ 小结果那一行**不出现**大块那套说法（不是所有结果都改口径）',
      linesWith(small, '大块'),
    )
  } finally {
    await closeScene(scene)
  }
}

// ══ ④ ⑤ ⑥ 模型那一份：头也要、尾也要 ═══════════════════════════════

/**
 * **本单 ② 真正改到的是哪条路**（先说清楚，免得判据咬错了东西）：
 *
 * `deliveredTextOf` 的 **blob 那一支**——正文存成引用的那些条目（越过 8192 字符的
 * 用户交代 / 助手正文 / 摘要）。工具结果的**正文本就不走这一支**：工具条目的正文是
 * **面向模型的文本**（`appendToolResultEntry` 一律内联），按既有语义「内联＝原样、
 * 恒为完整」——那条本单一个字不动。
 *
 * 故这一趟**三条路各取一份证据**：
 * - `04` **长交代**（> 8192 字符 ⇒ 存成 blob）⇒ 请求体里那条 `user` 消息**头尾都在**，
 *   省略处报数且指得出怎么读全（**这就是本单改的那一处**）；
 * - `05` **大结果**（未越 64 KiB 上限）⇒ 模型那条 `tool` 消息**整份都在**（头尾自然都在）；
 * - `06` **对照 · `KNOWN_OPEN`**：工具输出**越过 `EXEC_MAX_OUTPUT_BYTES`（64 KiB）**时，
 *   模型那一份**只剩开头**——`exec` 的上限按**头**截（`execution/src/exec.ts` 的 `drain`：
 *   `value.subarray(0, room)`），尾巴整个丢掉。**工单明写不动那个上限**，故本单一字未改，
 *   只把这条事实**钉在帧里**（谁动了它，这一条会红——回头重读一遍）。
 */
async function sceneDelivered(): Promise<void> {
  const longText = `${LONG_HEAD}${'x'.repeat(LONG_FILL)}${LONG_TAIL}`

  const scene = await openScene({
    label: 'u82-模型那份',
    turns: [
      { kind: 'text', text: '收到一号。' },
      { kind: 'tool', name: 'exec', args: { cmd: BIG_CMD } },
      { kind: 'text', text: '收到二号。' },
      { kind: 'tool', name: 'exec', args: { cmd: HUGE_CMD } },
      { kind: 'text', text: '收到三号。' },
    ],
  })

  try {
    // —— 04 长交代：> 8192 字符 ⇒ 存成 blob ⇒ 装配时按策略截 ——
    // ⚠️ 等的是**末尾那个标记**，不是整段：草稿太长，输入行只画得出末尾那几十行
    //    （屏上「… 上面还有 N 行」），等整段永远等不到
    await scene.session.send(longText, { until: { text: LONG_TAIL }, timeoutMs: 20_000 })
    await scene.session.key('enter', { until: { text: '收到一号。' }, timeoutMs: 60_000 })
    await scene.session.wait({ text: '○ 空闲' }, { timeoutMs: 30_000 })

    const longUser = userMessagesOf(scene.session).find((one) => one.includes(LONG_HEAD)) ?? ''
    writeFileSync(join(out, '04-模型那份-长交代.txt'), `${longUser}\n`, 'utf8')
    console.log(`\n── 04 长交代那一份（原文 ${longText.length} 字符 · 送到模型 ${longUser.length} 字符）──`)

    check(longUser.startsWith(LONG_HEAD), '④ **头在**（开头就是它）')
    check(longUser.endsWith(LONG_TAIL), '④ **尾在**（结尾也在——原先只留开头那 2000）')
    check(longUser.includes('截断'), '④ 省略处说得出「这里被截了」')
    check(/省略 \d{3,} 字符/.test(longUser), '④ 省略处**报数**')
    check(
      longUser.includes('history_read') && /entry=\d+/.test(longUser),
      '④ 省略处**指得出怎么读全**（引导，不是干截）',
    )
    check(!SHA256.test(longUser), '④ 模型那一份里也不含任何内部 id')

    // —— 05 大结果（未越上限）：模型拿到的是整份 ——
    await typeLine(scene.session, '跑个大输出')
    await scene.session.key('enter', { until: { text: '收到二号。' }, timeoutMs: 60_000 })
    await scene.session.wait({ text: '○ 空闲' }, { timeoutMs: 30_000 })

    const bigTool = lastToolOf(scene.session, 'u82a-1')
    check(bigTool !== '', '⑤ 夹具真收到了一条 `tool` 消息（不是「哪儿都没到」）')
    check(bigTool.startsWith('u82a-1\n'), '⑤ **头在**（第一行就是它）')
    check(bigTool.endsWith('u82a-1200\n'), '⑤ **尾在**（最后一行也在——这一份整份都在）')
    check(!bigTool.includes('截断'), '⑤ 这一份没被截（未越 exec 的上限——内联＝原样，一个字不截）')
    writeFileSync(join(out, '05-模型那份-大结果.txt'), `${bigTool}\n`, 'utf8')

    // —— 06 对照（KNOWN_OPEN）：越过 64 KiB 时只剩开头 ——
    await typeLine(scene.session, '再跑个更大的')
    await scene.session.key('enter', { until: { text: '收到三号。' }, timeoutMs: 90_000 })
    await scene.session.wait({ text: '○ 空闲' }, { timeoutMs: 30_000 })

    const huge = lastToolOf(scene.session, 'u82h-1')
    writeFileSync(join(out, '06-对照-越过上限只剩开头.txt'), `${huge}\n`, 'utf8')
    console.log(
      `\n── 06 对照（越过 64 KiB 上限的那一份，${huge.length} 字符）──\n` +
        `头 40：${JSON.stringify(huge.slice(0, 40))}\n尾 60：${JSON.stringify(huge.slice(-60))}\n`,
    )
    check(
      huge.includes('u82h-1') && !huge.includes('u82h-20000'),
      '⑥ 对照 · KNOWN_OPEN：越过 64 KiB 上限时**只剩开头**（尾巴整个丢掉——本单不动那条上限）',
      huge.slice(-60),
    )
  } finally {
    await closeScene(scene)
  }
}

/**
 * 夹具收到的请求里**某个角色的消息正文**（按请求序）——读的是 `FixtureRequest.body`
 * 原样（不是夹具另做的那几格摘要），判据因此问的是「真发出去的是什么」。
 */
function messagesOf(session: UiSession, role: string): readonly string[] {
  const found: string[] = []

  for (const request of session.requests()) {
    const messages = request.body['messages']
    if (!Array.isArray(messages)) continue

    for (const one of messages as readonly Record<string, unknown>[]) {
      if (one['role'] !== role) continue
      const content = one['content']
      if (typeof content === 'string') found.push(content)
    }
  }

  return found
}

const userMessagesOf = (session: UiSession): readonly string[] => messagesOf(session, 'user')

/** 最后一条**含这个标记**的 `tool` 消息正文（这一趟的物证）。 */
function lastToolOf(session: UiSession, marker: string): string {
  const hits = messagesOf(session, 'tool').filter((one) => one.includes(marker))

  return hits[hits.length - 1] ?? ''
}

// ══ 入口 ════════════════════════════════════════════════════════════

const at = process.argv.indexOf('--out')
out = at === -1 ? tempDir('magic-u82-frames-') : (process.argv[at + 1] ?? '')
if (out === '') throw new Error('--out 后面要给一个目录')
mkdirSync(out, { recursive: true })

console.log(`产物目录：${out}\n`)
console.log('══ ① 大结果那一屏（收起 / 展开）＋ ③ 小结果照旧 ══')
await sceneScreen()
console.log('\n══ ④ 模型那一份（头 / 尾 / 省略说明）══')
await sceneDelivered()
console.log('\n全部判据通过。')
