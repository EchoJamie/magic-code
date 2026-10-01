/**
 * U37 · **图片输入到模型请求的留帧装置**——真 PTY ＋ 本地模型夹具，落成可核对的帧。
 *
 * ⚠️ **U62 起那一处写的是编号**（`Image#N`），不是文件名 / 路径：名字按**内容身份**
 * （字节的 sha256）在一段输入里取号，同一张图在两处出现就是同一个名字。故下面几处判据
 * 跟着改了字面（`看 @报错.png` → `看 Image#1`，`@截图.png` → `Image#1`），
 * 并补了一条「认不出图的那一处不编号」（坏图那一屏）。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。按键 → 视图 → 命令那一半在
 * `spec.u62.test.ts`（那一处在正文里的编号；`spec.u37.test.ts` 随 U111 撤 `/attachments` 一并撤了）；
 * 这里补的是**只有真终端才说得清的那几件**：
 * - 屏上**长什么样**（引用那一段怎么写、有没有多出一行附件清单——`AGENTS.md` 的看帧四项）；
 * - **图真到了端点上吗**（夹具按出站请求体里的 `image_url` 数张数，不是看内核侧）；
 * - 坏图那一下**说得出为什么**、原稿保住；
 * - 应用与夹具**由监督者收干净**（`close()` 的 `exit.by`：它自己走的 / 我们杀的）。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**。模型那一头是 **loopback 夹具**（`127.0.0.1`，端口自动分配，
 * 合成假 key）——**一个付费请求都不发**，真 `~/.magic` 零触碰。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u37-tui.ts --out <目录>
 * ```
 *
 * 出三屏：`01-选入图片` · `02-提交之后` · `03-坏图拒绝`。
 *
 * ⚠️ **U111 撤掉 `/attachments`**（判据：「看」不该有名字）之后，原来那三屏
 * （`04-送过的图片` / `05-详情两条` / `06-取回再送`）连同它们的取回链路一并撤了——
 * 这条命令整条不在了，装置里不该留一条走不通的路。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDatabase } from './support.ts'
import { tempDir } from './tmp.ts'
import { createUiSession } from './ui/index.ts'
import type { Capture, UiSession } from './ui/index.ts'

/** 1×1 真 PNG（67 字节）——「用户交上来的那张报错截图」。 */
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

/** 摆一个文件（中间目录自动建）。 */
function putBytes(where: string, relative: string, bytes: Uint8Array): string {
  const path = join(where, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

/**
 * 按一个**非文字键**——先等一小会儿再写。
 *
 * 由头与 `frames-u36-tui.ts` 那一条同：PTY 上两次写挨得太近时，应用一次 read 会把它们
 * 并成一块读进来（回车于是成了正文里的一个控制字符）。
 */
async function pressKey(
  session: UiSession,
  name: 'enter' | 'backspace' | 'tab' | 'up' | 'down',
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

  // 先等它闲下来——忙的时候 `ctrl+c` 是**中断**不是退出（外壳的既有语义）
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 10_000 }).catch(() => undefined)
  // 空闲**按两次**才走（U46）——`quit()` 就是那一套（第一下只印那一行）
  await session.quit()
  const report = await session.close({ graceMs: 3_000 })
  const how = `${report.exit.by}（code ${report.exit.code ?? '-'} / signal ${report.exit.signal ?? '-'}）`

  if (report.exit.by !== 'app') throw new Error(`应用不是自己走的（${how}）——收摊那条路没走完`)

  console.log(`  · 收摊：${how} · 帧 ${report.frames} 张 · 现场 ${report.runDir}`)
}

// ══ ①～③ 送一张图：选入 · 提交 · 记录 ═══════════════════════════════════

async function sending(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u37-送图',
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '看到了，是空指针。', chunks: 3, chunkDelayMs: 40 }],
  })

  try {
    const { workspace } = session.facts()
    putBytes(workspace, '报错.png', PNG)

    // —— ① 用 `@` 选入那张图（沿用既有入口——设计：复用 `@` 文件入口）——
    await typeLine(session, '看 ')
    await session.send('@', { until: { text: '@' }, timeoutMs: 10_000 })
    await session.send('报错', { until: { text: '@报错' }, timeoutMs: 10_000 })
    await session.wait({ text: '报错.png　文件' }, { timeoutMs: 10_000 })
    const candidates = await session.capture({ label: '01a-候选（图也在里面）' })
    keep(out, candidates, '01a-候选（图也在里面）')
    check(has(candidates, '报错.png'), '图片文件在 `@` 候选里（沿用既有入口，没有另一个选择器）')

    // 认出来之后那一处**就地**成了编号（U62）——等的就是它（名字是内容身份取的号，
    // 不是文件名）；输入行那一格（`› ` 开头）才是判据，别拿记录区里同名的旧行顶上
    await pressKey(session, 'enter', { until: { text: '› 看 Image#1' }, timeoutMs: 10_000 })
    const picked = await session.capture({ label: '01-选入图片' })
    keep(out, picked, '01-选入图片')

    check(has(picked, '› 看 Image#1'), '引用留在它被说出来的位置（那句话还在）')
    check(has(picked, 'Image#1'), '那一处写的是**编号**（不是文件名、也不是路径）')
    check(!has(picked, '报错.png'), '**不假装有文件名**（文件名一个字都不上屏）')
    check(!has(picked, '（待发送）'), '**不另铺常驻附件行**（设计：引用就在正文里）')
    check(session.requests().length === 0, '**选入不发模型请求**（夹具收到 0 条）')

    // —— ② 提交：图真到了端点上 ——
    const before = session.requests().length
    await pressKey(session, 'enter', { until: { text: '看到了，是空指针。' }, timeoutMs: 15_000 })
    const sent = await session.capture({ label: '02-提交之后' })
    keep(out, sent, '02-提交之后')

    const requests = session.requests()
    check(requests.length === before + 1, `提交之后**正好一次**请求（实测 ${requests.length} 条）`)
    check(requests.at(-1)?.images === 1, `端点上**收到了一张图**（实测 ${requests.at(-1)?.images ?? 0} 张）`)
    check(
      (requests.at(-1)?.lastUser ?? '').includes('看 Image#1'),
      '正文一个字不剥（引用那一段还在）',
      requests.at(-1)?.lastUser ?? '',
    )
    check(
      (requests.at(-1)?.lastUser ?? '').includes('〔本次材料 · 图片 Image#1（来源'),
      '抬头说的是**同一个名字**（正文那一处与材料那一块对得上）',
      requests.at(-1)?.lastUser ?? '',
    )
    check(has(sent, '看 Image#1'), '记录区回显的是**原话**')

    // —— ③ 记录：图片引用 ＋ blob（不是字节本体现在那张表里）——
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
    check(JSON.stringify(payload).length < 2000, '载荷里没有字节本体（二进制不进那张表）')
  } finally {
    await close(session)
  }
}

// ══ ④ 坏图：说得出为什么，原稿保住 ═══════════════════════════════════

async function broken(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u37-坏图',
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    const { workspace } = session.facts()
    // 半截的 PNG（IEND 那一块切掉）——文件读得出来，但不是一张完整的图
    putBytes(workspace, '半截.png', new Uint8Array(PNG.subarray(0, PNG.length - 12)))

    await typeLine(session, '看 ')
    await session.send('@', { until: { text: '@' }, timeoutMs: 10_000 })
    await session.send('半截', { until: { text: '@半截' }, timeoutMs: 10_000 })
    await session.wait({ text: '半截.png　文件' }, { timeoutMs: 10_000 })
    await pressKey(session, 'enter', { until: { absent: '　文件' }, timeoutMs: 10_000 })

    await pressKey(session, 'enter', { until: { text: '没送出' }, timeoutMs: 15_000 })
    const refused = await session.capture({ label: '03-坏图拒绝' })
    keep(out, refused, '03-坏图拒绝')

    check(has(refused, '没送出'), '当场说一句「没送出」（不静默失败）')
    check(has(refused, '没传完'), '缘由说得出**是哪一种不过**（半截的图）')
    // **认不出图 ⇒ 那一处照旧是路径**（不是「硬安一个编号」）：一份连完整图片都不算的
    // 文件，本来就没有「图片的名字」可言——名字是内容身份换来的
    check(has(refused, '看 @半截.png'), '**原稿保住**（那句话连同引用还在输入行上）')
    check(!has(refused, 'Image#'), '认不出图的那一处**不编号**（不假装它是张图）')
    check(session.requests().length === 0, '一个模型请求都没发出去')
  } finally {
    await close(session)
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const out = at === -1 ? tempDir('magic-frames-u37-') : (process.argv[at + 1] as string)
  mkdirSync(out, { recursive: true })

  await sending(out)
  await broken(out)
  console.log(`\n全部判据通过。帧落在 ${out}`)
}
