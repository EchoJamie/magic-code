/**
 * U37 · **图片输入到模型请求的留帧装置**——真 PTY ＋ 本地模型夹具，落成可核对的帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。按键 → 视图 → 命令那一半在
 * `packages/tui/test/spec.u37.test.ts`；这里补的是**只有真终端才说得清的那几件**：
 * - 屏上**长什么样**（引用那一段怎么写、有没有多出一行附件清单——`AGENTS.md` 的看帧四项）；
 * - **图真到了端点上吗**（夹具按出站请求体里的 `image_url` 数张数，不是看内核侧）；
 * - **删掉源文件之后**从 `/attachments` 取回、再送一次，端点**又收到一张**；
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
 * 出六屏：`01-选入图片` · `02-提交之后` · `03-坏图拒绝` · `04-送过的图片` ·
 * `05-详情两条` · `06-取回再送`。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  await session.key('ctrl+c')
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

    await pressKey(session, 'enter', { until: { absent: '　文件' }, timeoutMs: 10_000 })
    const picked = await session.capture({ label: '01-选入图片' })
    keep(out, picked, '01-选入图片')

    check(has(picked, '看 @报错.png'), '引用留在它被说出来的位置（那句话还在）')
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
      (requests.at(-1)?.lastUser ?? '').includes('看 @报错.png'),
      '正文一个字不剥（引用那一段还在）',
      requests.at(-1)?.lastUser ?? '',
    )
    check(has(sent, '看 @报错.png'), '记录区回显的是**原话**')

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
    check(has(refused, '看 @半截.png'), '**原稿保住**（那句话连同引用还在输入行上）')
    check(session.requests().length === 0, '一个模型请求都没发出去')
  } finally {
    await close(session)
  }
}

// ══ ⑤～⑥ 送过的图片：取回、再送一次（源文件已删）═══════════════════════

async function retrieving(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u37-取回',
    artifacts: join(out, 'runs'),
    turns: [
      { kind: 'text', text: '看到了。', chunks: 2, chunkDelayMs: 40 },
      { kind: 'text', text: '还是空指针。', chunks: 2, chunkDelayMs: 40 },
    ],
  })

  try {
    const { workspace } = session.facts()
    const path = putBytes(workspace, '截图.png', PNG)

    // 先送一次（走 `@` 选入）
    await typeLine(session, '看 ')
    await session.send('@', { until: { text: '@' }, timeoutMs: 10_000 })
    await session.send('截图', { until: { text: '@截图' }, timeoutMs: 10_000 })
    await session.wait({ text: '截图.png　文件' }, { timeoutMs: 10_000 })
    await pressKey(session, 'enter', { until: { absent: '　文件' }, timeoutMs: 10_000 })
    await pressKey(session, 'enter', { until: { text: '看到了。' }, timeoutMs: 15_000 })

    check(session.requests().at(-1)?.images === 1, '第一次：端点上收到一张图')

    // **把源文件删掉**（「源文件已删除」那一档）
    rmSync(path)

    // —— ⑤ `/attachments`：列出送过的那张 ——
    // ⚠️ **两次回车**：第一次是**补全候选**（`/attachments` 打在草稿里就出候选，那一下
    // 只是把它补全），第二次才真的跑这条命令——真终端上栽过一次（只按一次的时候
    // 屏上还停在候选那一栏，用例却因为记录区那条 `看 @截图.png` 也在屏上而误绿）
    await typeLine(session, '/attachments')
    await pressKey(session, 'enter')
    await pressKey(session, 'enter')
    // 等**只有抽屉才有**的那句话（不拿记录区里也可能有的名字当判据）
    await session.wait({ text: '选定一张看能做什么' }, { timeoutMs: 10_000 })
    const listed = await session.capture({ label: '04-送过的图片' })
    keep(out, listed, '04-送过的图片')

    check(has(listed, '截图.png'), '送过的那张列得出来（源文件已经删了）')
    check(has(listed, 'png ·'), '一行里说得出类型 / 大小')
    check(has(listed, '选定一张看能做什么'), '抽屉真开着（这一句只有它那一屏有）')

    // —— 进详情 ——
    await pressKey(session, 'enter', { until: { text: '查看原图' }, timeoutMs: 10_000 })
    const detail = await session.capture({ label: '05-详情两条' })
    keep(out, detail, '05-详情两条')

    check(has(detail, '查看原图'), '详情有「查看原图」')
    check(has(detail, '加入本次输入'), '详情有「加入本次输入」')

    // —— ⑤b 「查看原图」⇒ 落一个本地文件并给出路径（不自动打开外部应用）——
    await pressKey(session, 'enter', { until: { text: '原图已导出' }, timeoutMs: 10_000 })
    const exported = await session.capture({ label: '05b-查看原图' })
    keep(out, exported, '05b-查看原图')

    check(has(exported, '原图已导出 → '), '给出**一条本地路径**（用户下一步要的就是它）')
    // 那句话里那一条路径**真在盘上**，且字节与当初交上去的那一份逐字节相同。
    // ⚠️ 路径**会折行**（系统临时目录本来就长）——把后续几行接起来再切（`─` 之后的都不算，
    // 而路径里不可能有那个字符：导出时清洗过）
    const at = exported.lines.findIndex((line) => line.includes('原图已导出 → '))
    const head = exported.lines[at] ?? ''
    // 续行带**悬挂缩进**（记录区那种对齐）——接起来之前先剥掉行首那几格
    const tail = exported.lines
      .slice(at + 1)
      .map((line) => line.trimStart())
      .join('')
    const where = (head.slice(head.indexOf('→ ') + 2) + tail).replace(/─[\s\S]*$/, '').trim()
    const onDisk = readFileSync(where)
    check(onDisk.equals(PNG), `导出的文件与交上去的那一份**逐字节相同**（${where}）`)
    rmSync(where, { force: true })
    // ⚠️ 导出**不关抽屉**（结果是一条回执）——接着还能按「加入本次输入」
    await pressKey(session, 'down')

    // —— ⑥ 「加入本次输入」⇒ 引用回到输入行，再送一次 ——
    await pressKey(session, 'enter', { until: { text: '@截图.png' }, timeoutMs: 10_000 })
    const back = await session.capture({ label: '06a-加入本次输入' })
    keep(out, back, '06a-加入本次输入')

    check(has(back, '@截图.png'), '那一张**放回了输入行**（复用保存的字节，不依赖原路径）')

    await typeLine(session, '还是这个错')
    const before = session.requests().length
    await pressKey(session, 'enter', { until: { text: '还是空指针。' }, timeoutMs: 15_000 })
    const again = await session.capture({ label: '06-取回再送' })
    keep(out, again, '06-取回再送')

    const requests = session.requests()
    check(requests.length === before + 1, '又发了一次请求')
    check(requests.at(-1)?.images === 1, `源文件删了**照样送得出那张图**（实测 ${requests.at(-1)?.images ?? 0} 张）`)
    check(
      (requests.at(-1)?.lastUser ?? '').includes('还是这个错'),
      '正文与引用一起送出去',
      requests.at(-1)?.lastUser ?? '',
    )
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
  await retrieving(out)
  console.log(`\n全部判据通过。帧落在 ${out}`)
}
