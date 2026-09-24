/**
 * U62 · **图片的名字（`Image#N`）的留帧装置**——真 PTY ＋ 本地模型夹具，落成可核对的帧。
 *
 * 判据就是工单的完成出口（`交接/工单/U62.md` · 设计 · 文件与图片「图片的身份与名字」），
 * **四条全在真终端上走一遍**（按键经真 PTY 送进真外壳的 stdin，帧从它写出的字节里读）：
 *
 * 1. **一张图进草稿 ⇒ 那一处显示 `Image#N`**（不是文件名、也不是路径）；
 * 2. **同一张图引用两次 ⇒ 同一个名字**（内容认身份：两条路径、一份字节 ⇒ 一个号）；
 * 3. **两张不同的图 ⇒ 两个编号**；
 * 4. **同名的两张图**（不同目录、内容不同）⇒ **分得开**（名字不撞）。
 *
 * 外加一条反面（工单明写「文件/目录/技能那几种一个字不许变」）：普通文件那一处
 * **照旧是 `@路径`**，且**一次「它是图吗」都不会多问**（那一趟往返省在目录与文本文件上）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u62-tui.ts --out <目录>
 * ```
 *
 * 出三屏：`01-同名不同内容` · `02-同一张两处` · `03-反面与提交`。
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './tmp.ts'
import { createUiSession } from './ui/index.ts'
import type { Capture, UiSession } from './ui/index.ts'

/** 1×1 真 PNG（红）——「用户交上来的那张报错截图」。 */
const RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
)

/** 1×1 真 PNG（蓝）——**另一张**（名字一样、目录一样、内容不同）。 */
const BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==',
  'base64',
)

/** 一条判据的结论——**不过就当场抛**。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/** 留一屏——文本写进 `<out>/<名字>.txt`，字格与光标写进同名 `.json`。 */
function keep(out: string, shot: Capture, label: string): void {
  writeFileSync(join(out, `${label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${label}.json`),
    `${JSON.stringify({ columns: shot.columns, rows: shot.rows, lines: shot.lines }, null, 2)}\n`,
    'utf8',
  )
  console.log(`\n── ${label} ──\n${shot.text}`)
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
 * 由头与 `frames-u37-tui.ts` 那一条同：PTY 上两次写挨得太近时，应用一次 read 会把它们
 * 并成一块读进来（回车于是成了正文里的一个控制字符）。
 */
async function pressKey(
  session: UiSession,
  name: 'enter' | 'backspace',
  until?: Parameters<UiSession['key']>[1],
): Promise<void> {
  await Bun.sleep(150)
  await session.key(name, until)
}

/**
 * `@` 选一条候选：打 `@` → 打那段筛词 → 等候选露出来 → 回车 → 等**输入行**换好。
 *
 * ⚠️ 判据一律钉在**输入行那一格**（`› ` 开头）：记录区里那些旧消息与输入行用的是同一批字
 * （`Image#1` 会出现好几次），拿裸的名字当判据会**立刻为真**——那是这个装置最容易误绿的地方。
 *
 * `candidate` ＝候选行里那一段（`报错.png　文件`）——等它露出来才按回车，不然回车落在
 * 一个还没到的列表上（那一下就成了「把 `@报错` 发出去」）。
 */
async function pick(session: UiSession, query: string, candidate: string, picked: string): Promise<void> {
  await session.send('@', { until: { text: '@' }, timeoutMs: 10_000 })
  await session.send(query, { until: { text: `@${query}` }, timeoutMs: 10_000 })
  await session.wait({ text: candidate }, { timeoutMs: 10_000 })
  await pressKey(session, 'enter', { until: { text: `› ${picked}` }, timeoutMs: 10_000 })
}

/** 屏上有没有这一行。 */
function has(shot: Capture, needle: string): boolean {
  return shot.lines.some((line) => line.includes(needle))
}

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

// ══ 入口 ═════════════════════════════════════════════════════════════

async function naming(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u62-命名',
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '看到了。', chunks: 3, chunkDelayMs: 40 }],
  })

  try {
    const { workspace } = session.facts()
    putBytes(workspace, '报错.png', RED)
    putBytes(workspace, 'a/报错.png', RED) // 与上一行**逐字节相同**（同一张图，两条路径）
    putBytes(workspace, 'b/报错.png', BLUE) // **同名、同层、内容不同**的一张
    putBytes(workspace, '说明.md', new TextEncoder().encode('# 说明\n'))

    // —— ① 先选一张，那一处就该是 `Image#1` ——
    await session.send('看 ', { until: { text: '› 看' }, timeoutMs: 10_000 })
    await pick(session, '报错', '报错.png　文件', '看 Image#1')

    // —— ② 再选**同名但内容不同**的那张 ⇒ 换一个号（内容认身份，名字不撞）——
    await session.send(' 和 ', { until: { text: '› 看 Image#1 和' }, timeoutMs: 10_000 })
    await pick(session, 'b/报错', '报错.png　文件', '看 Image#1 和 Image#2')

    const apart = await session.capture({ label: '01-同名不同内容' })
    keep(out, apart, '01-同名不同内容')

    check(has(apart, '› 看 Image#1 和 Image#2'), '两张不同的图 ⇒ **两个编号**')
    check(!has(apart, '报错.png'), '**不假装有文件名**：文件名一个字都不上屏（抄的是编号）')
    check(session.requests().length === 0, '选入不发模型请求（夹具收到 0 条）')

    // —— ③ 同一张图**再引用一次**（另一条路径、同一份字节）⇒ 还是那个号 ——
    await session.send(' 再看 ', { until: { text: '› 看 Image#1 和 Image#2 再看' }, timeoutMs: 10_000 })
    await pick(session, 'a/报错', '报错.png　文件', '看 Image#1 和 Image#2 再看 Image#1')

    const twice = await session.capture({ label: '02-同一张两处' })
    keep(out, twice, '02-同一张两处')

    check(has(twice, '› 看 Image#1 和 Image#2 再看 Image#1'), '同一张图引用两次 ⇒ **同一个名字**')
    check(
      !has(twice, '› 看 Image#1 和 Image#2 再看 Image#3'),
      '没有凭空多出第三个编号（内容一样就是同一张）',
    )

    // —— ④ 反面：文本文件那一处**照旧是路径**（一个字不变）——
    await session.send(' 读 ', { until: { text: '› 看 Image#1 和 Image#2 再看 Image#1 读' }, timeoutMs: 10_000 })
    await pick(session, '说明', '说明.md　文件', '看 Image#1 和 Image#2 再看 Image#1 读 @说明.md')

    const plain = await session.capture({ label: '03-反面与提交' })
    keep(out, plain, '03-反面与提交')

    check(has(plain, '读 @说明.md'), '文件那一处**照旧是路径**（反面：那几种一个字不许变）')

    // —— ⑤ 交出去：模型请求里正文写的是编号（不是文件名、也不是路径）——
    const before = session.requests().length
    await pressKey(session, 'enter', { until: { text: '看到了。' }, timeoutMs: 15_000 })

    const requests = session.requests()
    check(requests.length === before + 1, `提交之后**正好一次**请求（实测 ${requests.length} 条）`)
    // 模型收到的那一份里**材料是按位置展开**的（引用那一处紧跟着它的材料），故不拿整句
    // 连着比——比的是那四段文字**按用户排的次序**都在，一个字没被剥掉
    const lastUser = requests.at(-1)?.lastUser ?? ''
    const order = ['看 Image#1', '和 Image#2', '再看 Image#1', '读 @说明.md'].map((one) =>
      lastUser.indexOf(one),
    )
    check(
      order.every((at, index) => at >= 0 && (index === 0 || at > (order[index - 1] ?? -1))),
      '正文一个字不剥，且四处引用**按用户排的次序**在',
      lastUser,
    )
    check(
      (lastUser.match(/〔本次材料 · 图片 Image#1（来源/g) ?? []).length === 2,
      '两处 `Image#1` 那一块**说的是同一个名字**（模型据此认得出那是同一张）',
      lastUser,
    )
    check(lastUser.includes('〔本次材料 · 图片 Image#2（来源'), '第二张说的是 `Image#2`', lastUser)
    // 两张图到端点（同一张出现两次 ⇒ 两份部件；「要不要去重」是送达那一面的事，不在本单）
    check(requests.at(-1)?.images === 3, `端点上收到三份图像部件（实测 ${requests.at(-1)?.images ?? 0}）`)
  } finally {
    await close(session)
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const out = at === -1 ? tempDir('magic-frames-u62-') : (process.argv[at + 1] as string)
  mkdirSync(out, { recursive: true })

  await naming(out)
  console.log(`\n全部判据通过。帧落在 ${out}`)
}
