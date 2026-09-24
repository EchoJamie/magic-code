/**
 * U63 · **送达方式：文件 / 目录 / 技能 ⇒ 模型按需自读** —— 真 PTY ＋ 本地模型夹具的留帧装置。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它咬的是**只有真终端 ＋ 真请求说得清**的那几件：
 *
 * | 场景 | 咬什么 |
 * | --- | --- |
 * | ① 读了 / 没读 | 同一条交代里两处引用：模型读了其中一份 ⇒ 请求里两份正文都没有，而**只有没读的那一份**被报出来 |
 * | ② 技能 | 显式引用**不随请求展开**；模型真走 `skill` 工具读了才回「本次使用技能」 |
 * | ③ 图片 | **照旧引用即进**（请求里真有图像部件），且不进「没读」那份账 |
 * | ④ 权限 | 读那一趟弹的是**普通那张轻卡**（不是为「引用」新加的闸）；拨了「本工作区总是允许」之后**不再问**；工作区外那份只读附件照旧 |
 *
 * ⚠️ **关于「读那几种不弹卡」**（工单验收那一行）：放行区那几种是**轻**——轻的落点是
 * 「命中用户规则 / 已保存授权即自动放行」，不是「一律不问」。这条沙地是全新临时家目录
 * （没有规则、没有点出的授权），故**第一次**同类调用仍会问一次——那是**产品既有行为**，
 * 本单**一个字节都没动权限那一层**。④ 那一屏把这条说清楚：卡是普通那张 `read` 的轻卡
 * （键位 `y / a / n`、影响面是根内那条路径、**卡上没有一个「引用」字样**），
 * 而拨了 `a` 之后同类调用就直接跑完。 |
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 **loopback 夹具**
 * （`127.0.0.1`，端口自动分配，合成假 key）——**一个付费请求都不发**，真 `~/.magic` 零触碰。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u63-tui.ts --out <目录>
 * ```
 *
 * 出帧：`01-…` 起头，逐屏落 `.txt`（人能读的那一份）＋ `.json`（字格与光标）。
 * 请求物证落在 `*-请求.txt`（每次出站请求的 `lastUser`）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAGIC_IDLE_MARK, createUiSession, statusLineOf } from './ui/index.ts'
import type { Capture, UiSession } from './ui/index.ts'
import { readDatabase } from './support.ts'
import { tempDir } from './tmp.ts'

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
    `${JSON.stringify(
      { columns: shot.columns, rows: shot.rows, cursor: shot.cursor, scrollback: shot.scrollback, lines: shot.lines, runFiles: shot.files },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${label} ──\n${shot.text}`)
}

/** 打一行字并**等它真出现在屏上**（按键丢了就等不到——不重发，如实失败）。 */
async function typeLine(session: UiSession, text: string, shown = text.trimEnd()): Promise<void> {
  await session.send(text, { until: { text: shown }, timeoutMs: 10_000 })
}

/** 打一个 `@`（开路径候选那一下）——等它真上屏。 */
async function typeAt(session: UiSession): Promise<void> {
  await session.send('@', { until: { text: '@' }, timeoutMs: 10_000 })
}

/**
 * 按一个**非文字键**——先等一小会儿再写（同 `frames-u36-tui.ts` 那条：两次写挨太近
 * 会被并成一块读进去，回车变成一个正文里的控制字符）。
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

/** 摆一个文件（中间目录自动建）。 */
function put(where: string, relative: string, text: string): void {
  const path = join(where, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

/** 摆一张 1×1 的真 PNG（67 字节）。 */
function putPng(where: string, relative: string): void {
  const path = join(where, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
}

/**
 * 一次裁决卡的答复——**它是「放行区那几种」那一档的普通轻卡**（键位 `y / a / n`）。
 *
 * 由头：放行区那几种是「**轻**」——轻的落点是「命中用户规则 / 已保存授权即自动放行」，
 * **不是「一律不问」**（见 `@magic/permission` 的 `gate.ts`：落到链底就是问）。
 * 这条沙地是全新临时家目录（没有规则、也没点出过授权），故第一次同类调用仍会问一次；
 * 产品既有行为，本单一个字没动它。答复写 `y`（只批这一次）——要演示「拨了 `a` 之后不再问」
 * 的那一屏走 `answer` 参数。
 */
async function passCard(
  session: UiSession,
  label: string,
  out: string,
  answer: 'y' | 'a' = 'y',
): Promise<Capture> {
  await session.wait({ text: '等你定夺' }, { timeoutMs: 15_000 })
  const card = await session.capture({ label })
  keep(out, card, label)
  await session.send(answer)
  await Bun.sleep(200)

  return card
}

/**
 * 等这一轮**真收束**（状态行回到空闲）。
 *
 * ⚠️ **不能拿「答复那几个字上屏了」当收束**：回执（`本次没读`）与状态是**收束那一刻**才发的
 * ——早一帧抓下去，那一行还没到（第一版就这么栽的：读到「好。」就抓，屏上还是「工作中」）。
 */
async function settled(session: UiSession): Promise<void> {
  await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 20_000 })
}

/** 收过摊的（同一会话只收一次）。 */
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

/** 出站请求的物证——每次请求的 `lastUser`（夹具只留前 200 字符，够断「不在」）。 */
function writeRequests(out: string, label: string, session: UiSession): readonly string[] {
  const rows = session.requests().map((one) => `#${one.n}（${one.messages} 条消息 · 工具 ${one.tools} 个 · 图片 ${one.images} 张）\n${one.lastUser}`)
  writeFileSync(join(out, label), `${rows.join('\n\n')}\n`, 'utf8')
  return session.requests().map((one) => one.lastUser)
}

/** 库里那条 `user` 条目的载荷（直读——不经读 API）。 */
function payloadOf(session: UiSession, index = 0): {
  readonly refs?: readonly { readonly kind: string; readonly at: number; readonly marker: string; readonly text?: string; readonly source: string }[]
} {
  const raw = readDatabase(join(session.facts().dataDir, 'records.db'))
  const user = raw.entries.filter((row) => row.kind === 'user')
  raw.close()

  return JSON.parse(user[index]?.payload ?? '{}') as never
}

// ══ ① 读了 / 没读：同一条交代里两处引用 ═══════════════════════════════

/**
 * 工单最要紧的那一条：**只配「读了要说」不够**——模型没读时那一轮结束屏上什么也没有，
 * 用户照样以为它看了。
 *
 * 摆法：一条交代里引用两份材料，模型**只读其中一份**（剧本里只发一个 `read`）——
 * 于是：请求里两份正文都不在（① 自读），而收束时屏上**点名说另一份没读**（② 痕迹）。
 */
async function unread(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u63-读了与没读',
    artifacts: join(out, 'runs'),
    // 剧本：第一趟只读 `需求.md`；第二趟给结论文——`没用上.md` 一个字都没碰
    turns: [
      { kind: 'tool', name: 'read', args: { path: '需求.md' } },
      { kind: 'text', text: '照需求改好了。', chunks: 3, chunkDelayMs: 40 },
    ],
  })

  try {
    const { workspace } = session.facts()
    put(workspace, '需求.md', '要求：先看登录逻辑。')
    put(workspace, '没用上.md', '这一份这一轮用不上（不读也罢）。')

    // —— 引用两处：`@需求.md` 与 `@没用上.md` ——
    await typeLine(session, '先读 ')
    await typeAt(session)
    await session.send('需求', { until: { text: '@需求' }, timeoutMs: 10_000 })
    await session.wait({ text: '需求.md　文件' }, { timeoutMs: 10_000 })
    await pressKey(session, 'enter', { until: { absent: '　文件' }, timeoutMs: 10_000 })

    await typeLine(session, '，再对照 ')
    await typeAt(session)
    await session.send('没用上', { until: { text: '@没用上' }, timeoutMs: 10_000 })
    await session.wait({ text: '没用上.md　文件' }, { timeoutMs: 10_000 })
    await pressKey(session, 'enter', { until: { absent: '　文件' }, timeoutMs: 10_000 })

    const composed = await session.capture({ label: '01a-两处引用就位' })
    keep(out, composed, '01a-两处引用就位')
    check(has(composed, '先读 @需求.md，再对照 @没用上.md'), '两处引用都在它们被说出来的位置')
    check(session.requests().length === 0, '**选定不发请求**（夹具 0 条）')

    // —— 提交：模型那一趟要 `read`，先过那张**普通轻卡**（见 `passCard`）——
    await pressKey(session, 'enter', { until: { text: '等你定夺' }, timeoutMs: 20_000 })
    await passCard(session, '01b-读的裁决卡', out)

    await settled(session)
    const sent = await session.capture({ label: '01-读了与没读' })
    keep(out, sent, '01-读了与没读')

    // ① **出站请求里没有材料正文**（两趟都没有）
    const carried = writeRequests(out, '01-请求.txt', session)
    check(carried.length >= 1, `模型真被调了（夹具收到 ${carried.length} 次请求）`)
    check(carried.every((text) => !text.includes('要求：先看登录逻辑。')), '**请求里没有 需求.md 的正文**')
    check(carried.every((text) => !text.includes('这一份这一轮用不上')), '请求里也没有 没用上.md 的正文')
    check(carried[0]?.includes('先读 @需求.md，再对照 @没用上.md') === true, '引用原样留在句子里')

    // ② **模型调了读的工具**（记录区那一行就是它）
    check(has(sent, 'read'), '**模型调了读的工具**（记录区看得见）')

    // ③ **没读的那一份被点名报出来**（工单第 3 条：屏上不许一片沉默）
    check(has(sent, '本次没读：'), '屏上说了「本次没读」——没读时不是一片沉默')
    check(has(sent, '本次没读：@没用上.md'), '**点名的正是没读的那一份**（读了的不报）')
    check(!has(sent, '本次没读：@需求.md'), '读过的那一份不在这一行里')
    check(!has(sent, '本次使用技能'), '这一条没带技能，也没有多余回执')

    // ④ 记录：位置 ＋ 身份在，正文不在（正文由模型自己取，落在工具条目里）
    const payload = payloadOf(session)
    check(payload.refs?.length === 2, `记录里两处引用（实测 ${payload.refs?.length ?? 0}）`)
    check(payload.refs?.[0]?.marker === '@需求.md' && payload.refs?.[0]?.at === 3, '第一处位置自证（`at` 3）')
    check(payload.refs?.[1]?.marker === '@没用上.md', '第二处也在')
    check(payload.refs?.every((ref) => ref.text === undefined) === true, '两处都**没有正文**（自读那一版）')
  } finally {
    await close(session)
  }
}

// ══ ② 技能：显式引用不展开；读了才回执 ════════════════════════════════

/**
 * 两条对照：
 * - **不读**：显式引用的技能正文**不随请求展开**，也没有「本次使用技能」——收束时报「没读」；
 * - **读了**（真走 `skill` 工具）：正文才进请求，回执照说。
 */
async function skills(out: string): Promise<void> {
  // —— 第一屏：模型不读 ——
  const quiet = await createUiSession({
    label: 'u63-技能不读',
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '好。', chunks: 2, chunkDelayMs: 40 }],
  })

  try {
    const { workspace } = quiet.facts()
    put(workspace, '.magic/skills/review/SKILL.md', '---\nname: review\ndescription: 检查改动\n---\n\n逐条核对清单。\n')

    await typeLine(quiet, '按 ')
    await quiet.send('/review', { until: { text: '/review' }, timeoutMs: 10_000 })
    await quiet.wait({ text: 'review' }, { timeoutMs: 10_000 })
    await pressKey(quiet, 'tab')
    await Bun.sleep(200)
    await typeLine(quiet, ' 看看')

    // 这一屏模型不调工具（剧本里没有 toolCalls）——故**没有裁决卡**
    await pressKey(quiet, 'enter')
    await quiet.wait({ text: '好。' }, { timeoutMs: 20_000 })
    await settled(quiet)
    const shot = await quiet.capture({ label: '02a-技能不读' })
    keep(out, shot, '02a-技能不读')

    const carried = writeRequests(out, '02a-请求.txt', quiet)
    check(carried.every((text) => !text.includes('逐条核对清单。')), '**技能主文不随请求展开**')
    check(!has(shot, '本次使用技能'), '没有「本次使用技能」回执（它没读）')
    check(has(shot, '本次没读：/review'), '**没读也说了**（点名 `/review`）')
  } finally {
    await close(quiet)
  }

  // —— 第二屏：模型真去读（走 `skill` 工具）——
  const loud = await createUiSession({
    label: 'u63-技能读了',
    artifacts: join(out, 'runs'),
    turns: [
      { kind: 'tool', name: 'skill', args: { name: 'review' } },
      { kind: 'text', text: '照它核对完了。', chunks: 3, chunkDelayMs: 40 },
    ],
  })

  try {
    const { workspace } = loud.facts()
    put(workspace, '.magic/skills/review/SKILL.md', '---\nname: review\ndescription: 检查改动\n---\n\n逐条核对清单。\n')

    await typeLine(loud, '按 ')
    await loud.send('/review', { until: { text: '/review' }, timeoutMs: 10_000 })
    await loud.wait({ text: 'review' }, { timeoutMs: 10_000 })
    await pressKey(loud, 'tab')
    await Bun.sleep(200)
    await typeLine(loud, ' 看看')

    await pressKey(loud, 'enter', { until: { text: '等你定夺' }, timeoutMs: 20_000 })
    await passCard(loud, '02b-技能读取的裁决卡', out, 'a')

    await settled(loud)
    const shot = await loud.capture({ label: '02-技能读了' })
    keep(out, shot, '02-技能读了')

    writeRequests(out, '02-请求.txt', loud)
    check(has(shot, '本次使用技能：review'), '**读了才回「本次使用技能：review」**')
    check(!has(shot, '本次没读'), '读了就不报「没读」')
  } finally {
    await close(loud)
  }
}

// ══ ③ 图片：照旧引用即进 ══════════════════════════════════════════════

/** 图片**不改成自读**：没有读图的工具，而且一张图往往就是那件事本身。 */
async function images(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u63-图片照旧',
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '看到了。', chunks: 2, chunkDelayMs: 40 }],
  })

  try {
    const { workspace } = session.facts()
    putPng(workspace, 'shot.png')

    await typeLine(session, '看 ')
    await typeAt(session)
    await session.send('shot', { until: { text: '@shot' }, timeoutMs: 10_000 })
    await session.wait({ text: 'shot.png　文件' }, { timeoutMs: 10_000 })
    await pressKey(session, 'enter', { until: { absent: '　文件' }, timeoutMs: 10_000 })

    await pressKey(session, 'enter')
    await session.wait({ text: '看到了。' }, { timeoutMs: 20_000 })
    await settled(session)
    const shot = await session.capture({ label: '03-图片照旧' })
    keep(out, shot, '03-图片照旧')

    writeRequests(out, '03-请求.txt', session)
    const first = session.requests()[0]
    check(first?.images === 1, `**图片照旧随请求成部件**（实测 ${first?.images ?? 0} 张）`)
    check(!has(shot, '本次没读'), '图片不进「没读」那份账（它引用即进）')
  } finally {
    await close(session)
  }
}

// ══ ④ 权限：读那几种不弹卡；工作区外照旧 ══════════════════════════════

/**
 * **权限没被带坏**——两件事：
 *
 * ① **引用没加闸**：`read` 弹的是**普通那张轻卡**（`y / a / n`、影响面是根内那条路径、
 *    卡上没有一个「引用」字样）——它是产品既有那一张，不是为「引用」新加的；
 *    而拨了 `a`（本工作区总是允许）之后，**第二次同类调用直接跑完、不再问**
 *    （放行区那几种「一律轻」的落点：命中已保存授权即自动放行）；
 * ② **工作区外那份只读附件照旧**：经候选明确选定的那一个文件仍是引用即进
 *    （模型手上没有能读它的路——沙箱只认根内的绝对路径），请求里真有它的正文。
 */
async function permissions(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u63-权限不联动',
    artifacts: join(out, 'runs'),
    turns: [
      { kind: 'tool', name: 'read', args: { path: 'a.txt' } },
      { kind: 'text', text: '读完了。', chunks: 2, chunkDelayMs: 40 },
      { kind: 'tool', name: 'read', args: { path: 'b.txt' } },
      { kind: 'text', text: '又读完了。', chunks: 2, chunkDelayMs: 40 },
    ],
  })

  try {
    const { workspace } = session.facts()
    put(workspace, 'a.txt', '甲：先看登录逻辑。')
    put(workspace, 'b.txt', '乙：再看注册逻辑。')

    // —— ① 第一次读：普通轻卡，拨 `a` ——
    await typeLine(session, '读 ')
    await typeAt(session)
    await session.send('a.txt', { until: { text: '@a.txt' }, timeoutMs: 10_000 })
    await session.wait({ text: 'a.txt　文件' }, { timeoutMs: 10_000 })
    await pressKey(session, 'enter', { until: { absent: '　文件' }, timeoutMs: 10_000 })

    await pressKey(session, 'enter', { until: { text: '等你定夺' }, timeoutMs: 20_000 })
    const card = await passCard(session, '04-读的普通轻卡', out, 'a')

    check(has(card, 'y / a / n'), '卡是**轻那一档**（键位 y / a / n——放行区那几种的档）')
    check(has(card, 'read'), '卡的标题是那次调用本身（`read`）')
    check(!card.text.includes('引用'), '**卡上没有「引用」字样**——引用没给这一趟加任何东西')
    check(card.text.includes('a.txt'), '影响面说的是那一趟真读的路径（不是「你引用了它」）')

    await settled(session)
    const first = await session.capture({ label: '04a-第一次读（拨了总是允许）' })
    keep(out, first, '04a-第一次读（拨了总是允许）')

    // —— ② 第二次读：**不再问**（放行区那几种的全部落点就在这一屏） ——
    await typeLine(session, '再读 ')
    await typeAt(session)
    await session.send('b.txt', { until: { text: '@b.txt' }, timeoutMs: 10_000 })
    await session.wait({ text: 'b.txt　文件' }, { timeoutMs: 10_000 })
    await pressKey(session, 'enter', { until: { absent: '　文件' }, timeoutMs: 10_000 })
    await pressKey(session, 'enter')
    await session.wait({ text: '又读完了。' }, { timeoutMs: 20_000 })
    await settled(session)

    const second = await session.capture({ label: '04b-第二次读（不再问）' })
    keep(out, second, '04b-第二次读（不再问）')

    // ⚠️ 判据落在**状态行那一格**上（`statusLineOf`），不是全屏找那几个字：
    // 上一轮那张卡的收尾（`· 「读 @a.txt」等你定夺：read`）还在 scrollback 里躺着。
    const status = statusLineOf(second.lines)
    check(!status.includes('等你定夺'), '**第二次同类读不再弹卡**（`a` 那条授权直接放行）', status)
    check(status.includes(MAGIC_IDLE_MARK), '那一轮跑完了（回到空闲——没卡着等裁决）', status)
    check(has(second, 'read {"path":"b.txt"}'), '第二次读真跑下去了（结果行在）')
    writeRequests(out, '04-请求.txt', session)
  } finally {
    await close(session)
  }

  // —— ③ 工作区外那份只读附件 ——
  //
  // ⚠️ **它只能到「候选认得出来」这一屏为止**：真按键去选它时，`@../外面.md` 的候选行
  // 铺上来了（那一屏留了帧：`04-工作区外候选`），可**回车选不中**——picker 不收起、
  // 草稿原样。单开一条最小复现（只做「@ + 打全 + 回车」）也一样：
  //
  // ```
  // bun -e '…createUiSession → send("@../外面.md") → wait("外面.md（工作区外") → key("enter")…'
  // ```
  //
  // **这不是本单带来的**：这一条通路上（`pathRows` / `pickPath` / `candidates()`）一个字节
  // 都没动过（本单改的是「取回来之后怎么送」）。**也不在本单范围里**（U63 不碰选择器），
  // 故**只留帧、不追**——如实记进回报待判，不在这一单里顺手修。
  //
  // 「工作区外那份只读附件照旧引用即进」这条判据由 `packages/app/test/refs.test.ts` 的
  // 端到端用例咬（真装配 · 真请求 · 直读库表：`external` 那一条的正文真进了请求）。
  const outside = await createUiSession({
    label: 'u63-工作区外候选',
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    const { workspace } = outside.facts()
    writeFileSync(join(workspace, '..', '外面.md'), '外面的笔记（这一份在工作区外）。', 'utf8')

    await typeLine(outside, '看 ')
    await typeAt(outside)
    await outside.send('../外面.md', { until: { text: '@../外面.md' }, timeoutMs: 10_000 })
    await outside.wait({ text: '外面.md（工作区外' }, { timeoutMs: 10_000 })

    const picker = await outside.capture({ label: '04-工作区外候选' })
    keep(out, picker, '04-工作区外候选')

    check(has(picker, '工作区外'), '打全的那一条在候选里，且标着它是**工作区外**（选定＝只读附件）')
    check(outside.requests().length === 0, '**一个模型请求都没发**（候选不是提交）')
  } finally {
    await close(outside)
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const out = at === -1 ? tempDir('magic-frames-u63-') : (process.argv[at + 1] as string)
  mkdirSync(out, { recursive: true })

  await unread(out)
  await skills(out)
  await images(out)
  await permissions(out)
  console.log(`\n全部判据通过。帧落在 ${out}`)
}
