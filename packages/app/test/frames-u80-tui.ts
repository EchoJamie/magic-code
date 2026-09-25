#!/usr/bin/env bun
/**
 * U80 · **读后台命令的输出文件** —— 真 PTY 留帧 ＋ 逐格验收。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。跑法：
 *
 * ```
 * bun packages/app/test/frames-u80-tui.ts --out <目录>
 * ```
 *
 * 真 `cli.ts`（真装配 · 真沙箱 · 真闸门 · 真记录 · 真 Ink 外壳）跑在**真 PTY** 里，
 * 只有模型那一头是本机夹具（`ui/fixture.ts`，环回地址、一个付费请求都不发）。
 *
 * ## 取的是哪几屏
 *
 * | 张 | 工单那一格 | 该在屏上看见什么 |
 * | --- | --- | --- |
 * | ① | 读我们自己的产物 | 后台命令（`background`）⇒ 读它的输出文件：**不弹卡**、**读得到内容** |
 * | ② | 反面 · 用户的东西 | 读工作区外**用户自己的**文件：**沙箱照旧够不着**（工具回越界） |
 * | ③ | 反面 · 别放一片 | 往工作区外**写** ⇒ **照旧弹卡**；往**我们自己的产物**里写 ⇒ **也照旧弹卡** |
 *
 * ## ⚠️ 两处与工单原话对不上的地方（**如实记**，见回报）
 *
 * - **工单 ① 说「U70 的帧里那张卡该消失」——它已经消失了**，但不是本单收的：
 *   U76 把链的底从「默认问」翻成「**默认通**」，判轻的调用（读那一类）**一律不问**。
 *   故本单落在这一格上的**不是行为**，是**判据**（权限域认下那处，见下）；
 * - **工单 ② 说读工作区外的文件「照旧弹卡」——今天它也不弹**，同一条由头：
 *   **读那一类是放行区**（设计 · 权限：「越界那一条管的是工作区外的**写 / 删 / 移**，
 *   读材料不在此列」）＋ U76 的默认通 ⇒ 读哪儿都不问。
 *   故 ② 这一格取到的是**实况**：屏上没有卡，而**沙箱照旧够不着那个文件**
 *   （② 这一趟仍留下一帧，正是为了把这件事摆在明面上，而不是替工单圆一句）。
 *   **「别把认一处做成放一片」那一条另有判据**——落在 ③ 那两帧（写那一侧一个字没松）
 *   与单元用例（工作区外用户的东西照旧判根外、规则照旧盖不住）上。
 *
 * ## 判据怎么咬
 *
 * 每条都是**逐字**比对屏上的字（`check`），对不上当场抛——不是「看看而已」。
 * 帧落在 `<out>/NN-<名字>.txt`（纯文本）与 `.json`（字格 / 光标），原始字节与查看页在
 * `<out>/runs/` 那一份运行档案里（`createUiSession` 的 artifacts）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MagicHome } from '@magic/contracts'
import {
  MAGIC_IDLE_MARK,
  createSandbox,
  createUiSession,
  startFixture,
  statusLineOf,
} from './ui/index.ts'
import type { Capture, FixtureTurn, Sandbox, UiSession } from './ui/index.ts'
import { backgroundOutputDirOf, runPathsOf } from '../src/run/paths.ts'
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

/** 留一屏——文本 ＋ 字格（色与重量只能从 `.json` 的格子上看）。 */
function keep(shot: Capture): void {
  writeFileSync(join(out, `${shot.label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${shot.label}.json`),
    `${JSON.stringify(
      { columns: shot.columns, rows: shot.rows, cursor: shot.cursor, lines: shot.lines },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${shot.label} ──（scrollback ${shot.scrollback}）\n${shot.text}`)
}

/** 屏上（可见那一屏＋滚进去的）有没有这句话。 */
function has(shot: Capture, needle: string): boolean {
  return shot.text.includes(needle) || shot.history.some((line) => line.includes(needle))
}

/**
 * 屏上有没有**整整这么一行**（裁掉行首缩进之后逐字相同）。
 *
 * ⚠️ **判内容必须用这一支，不能用 `has`**：`has` 是**包含**，而工具卡那一行写着参数
 * （`● read {"path":"…/bg/bg-1.log"}`）⇒ 拿 `has('起手')` 去认「读到了那一行」，
 * 命令串 / 路径里的同一串字会**替它通过**——判据当场变成假绿。行级相等没有这个洞。
 */
function hasLine(shot: Capture, text: string): boolean {
  return [...shot.history, ...shot.lines].some((line) => line.trim() === text)
}

/**
 * 判「这一趟**没有卡**」——判轻的调用**默认通**（U76），屏上什么都不该多。
 *
 * ⚠️ **不能拿全屏找「等你定夺」代替**：那四个字**也在旧卡的回执行里**，
 * 回执写完就留在屏上 ⇒ 一场里只要开过一张卡，后面每一帧都命中它。
 * 够准的两件：**卡自己的东西不在**（键位行 `y 批准` 只在卡上）
 * ＋ **状态行不是裁决态**（那一格说的是「此刻」）。
 * ⚠️ 键位提示**两串都要判**（轻 `y / a / n` · 重 `y / n`）。
 */
function noCardHere(shot: Capture, what: string): void {
  const status = statusLineOf(shot.lines)
  check(!has(shot, 'y 批准'), `${what}：**没有卡**（卡上的键位行不在）`, shot.text)
  check(
    !status.includes('等你定夺') && !status.includes('y / n') && !status.includes('y / a / n'),
    `${what}：状态行也不是裁决态（根本没问）`,
    status,
  )
}

/**
 * 一次裁决卡的答复——**逐张把它留在帧里**，并把它交回给调用方判内容。
 *
 * ⚠️ 等卡要看**状态行**那格（`waitCard`），不能拿全屏找「等你定夺」——
 * 那个短语也在**上一张卡的回执**里，回执写完就留在屏上。
 */
async function passCard(session: UiSession, label: string, answer: 'y' | 'n' = 'n'): Promise<Capture> {
  await waitCard(session)
  const card = await session.capture({ label })
  keep(card)
  await session.send(answer)
  await waitCardGone(session)
  return card
}

/** 等**状态行**上出现「等你定夺」（卡真开出来了）。 */
async function waitCard(session: UiSession, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const screen = await session.screen()
    if (statusLineOf(screen.lines.map((line) => line.text)).includes('等你定夺')) return
    await Bun.sleep(20)
  }

  throw new Error('等不到裁决卡——状态行一直没写到「等你定夺」')
}

/** 等那一张卡**真撤了**（状态行不再是「等你定夺」）。 */
async function waitCardGone(session: UiSession, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const screen = await session.screen()
    if (!statusLineOf(screen.lines.map((line) => line.text)).includes('等你定夺')) return
    await Bun.sleep(20)
  }

  throw new Error('那一张卡一直没撤')
}

/** 等这一轮真收束（状态行回到空闲）。 */
async function settled(session: UiSession): Promise<void> {
  await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 30_000 })
}

/**
 * **展开**（`ctrl+o`）——工具卡收起时只报「N 行」，展开了才看得见读了什么。
 *
 * ⚠️ **必须在这一行落进记录区之前拨**：`Static` 写一次就不再重绘，已经定局的行拨了也不动。
 */
async function expand(session: UiSession): Promise<void> {
  await session.send('\u000f')
  await Bun.sleep(300)
}

/** 敲一行字并**等它真出现在屏上**（文本与回车分两次写——挤在一次里会丢键）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/**
 * **那一条后台命令的输出文件路径**——按产品自己的那两件算（`runPathsOf` ＋
 * `backgroundOutputDirOf`），不是照目录结构猜的：装配怎么算的，这里就怎么算。
 *
 * `bg-1` ＝ 这一代进程里第一条（沙地是全新的，号从 1 起）。
 */
function outputPathOf(sandbox: Sandbox, id = 'bg-1'): string {
  const magic: MagicHome = { home: sandbox.home, base: join(sandbox.home, '.magic') }
  return join(backgroundOutputDirOf(runPathsOf(magic, sandbox.dataDir, tmpdir())), `${id}.log`)
}

// ══ 那一趟真 PTY ══════════════════════════════════════════════════════

/**
 * 一趟走完那五格：交出去 · 读自己的产物 · 读用户的东西 · 写用户的东西 · 写自己的产物。
 *
 * 剧本**可变**：第 3 回合（读输出）要知道那个路径，而路径要先有沙地才算得出（见 `outputPathOf`）。
 */
async function readingFrame(): Promise<void> {
  // **判轻**的后台命令（一段都不在名单里）——故交出去这一趟**连卡都没有**：
  // 本屏要留的是「读那个文件不问」，不是「交出去问不问」（那一格归 U70 的帧）。
  const turns: FixtureTurn[] = [
    {
      kind: 'tool',
      name: 'exec',
      args: { cmd: 'echo 起手; sleep 1; echo 收工', background: true },
      text: '这条命令交出去跑，我不占着这一轮。',
    },
    { kind: 'text', text: '交出去了，我先做别的。' },
  ]

  const fixture = startFixture({ turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const outputPath = outputPathOf(sandbox)
  /** 工作区外**用户自己的**一个文件（家目录下）——②③ 两格的反面用它。 */
  const userFile = join(sandbox.home, '.zshrc')
  writeFileSync(userFile, 'U80 · 用户自己的东西（不是内核产出的）\n', 'utf8')

  // ① 被「跑完」那一声唤醒之后：用**既有的 `read`** 读那个输出文件
  turns.push({
    kind: 'tool',
    name: 'read',
    args: { path: outputPath },
    text: '我去读一下它的输出。',
  })
  turns.push({ kind: 'text', text: '读到了，确实在文件里。' })
  // ② 反面：读工作区外**用户自己的**文件（用户给的路径就在参数里）
  turns.push({
    kind: 'tool',
    name: 'read',
    args: { path: userFile },
    text: '我再读一下家目录里那个文件。',
  })
  turns.push({ kind: 'text', text: '那个读不到——越界了。' })
  // ③ 反面：往工作区外**写**（用户的东西）⇒ 照旧必闸
  turns.push({
    kind: 'tool',
    name: 'write',
    args: { path: userFile, content: '改一下\n' },
    text: '那我写一下。',
  })
  turns.push({ kind: 'text', text: '好，那我不写。' })
  // ③ 反面之二：往**我们自己的产物**里写 ⇒ **也照旧必闸**（「认一处」不是「放一片」）
  turns.push({
    kind: 'tool',
    name: 'write',
    args: { path: outputPath, content: '改一下\n' },
    text: '那我往那个输出文件里写。',
  })
  turns.push({ kind: 'text', text: '好，那我不写。' })

  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: 'u80-读输出',
      artifacts: join(out, 'runs'),
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })

    await typeLine(session, '把这条构建交出去')
    await session.key('enter')

    // —— ① 交出去那一趟：**没有卡**（命令一段都不在名单里）——
    await session.wait({ text: '〔bg-1〕' }, { timeoutMs: 20_000 })
    await session.wait({ text: '交出去了，我先做别的' }, { timeoutMs: 20_000 })
    const handed = await session.capture({ label: '01-交出去了（这一趟没有卡）' })
    keep(handed)
    noCardHere(handed, '① 交出去那一趟')
    check(
      has(handed, '〔bg-1〕') && has(handed, '输出文件：'),
      '① 回执认得出：id ＋ 输出文件（① 读的就是它——路径在回执行里按宽度折了行）',
      handed.text,
    )

    // —— ① 读那个输出文件：不弹卡 ＋ 读得到内容 ——
    //
    // 展开位要**赶在那一行落进记录区之前**拨（`expand` 的注）：读是被「跑完」那一声
    // 唤醒的，故这一拨落在那一句落地**之前**（命令还在 `sleep 1` 里，窗口够宽）。
    await settled(session)
    await expand(session)
    await session.wait({ text: 'bg-1 跑完了' }, { timeoutMs: 20_000 })
    await session.wait({ text: '读到了，确实在文件里' }, { timeoutMs: 20_000 })
    const ownRead = await session.capture({ label: '02-读我们自己的产物不弹卡' })
    keep(ownRead)
    noCardHere(ownRead, '① 读输出那一趟')

    await settled(session)
    await session.send('\u000f') // 收起展开位（内容已经写进滚屏，仍在）
    await Bun.sleep(400)
    const content = await session.capture({ label: '03-读到了内容' })
    keep(content)
    check(hasLine(content, '起手'), '① **读到了内容**（命令吐的第一行）', content.text)
    check(hasLine(content, '收工'), '① 读到的是完整那一段（末行也在）', content.text)

    // —— ② 反面：读工作区外**用户自己的**文件 ——
    await typeLine(session, '读一下我自己的那个文件')
    await session.key('enter')
    await session.wait({ text: '那个读不到' }, { timeoutMs: 20_000 })
    const userRead = await session.capture({ label: '04-读用户自己的文件（没有卡）' })
    keep(userRead)
    noCardHere(userRead, '② 读用户的东西那一趟')
    check(
      has(userRead, '工作区越界') || has(userRead, '读取失败'),
      '② **沙箱照旧够不着**那个文件（工具回越界——「读得到」不是「哪儿都读得到」）',
      userRead.text,
    )

    // —— ③ 反面：往工作区外**写**（用户的东西）⇒ 照旧必闸 ——
    await typeLine(session, '往那个文件里写一句')
    await session.key('enter')
    const userWrite = await passCard(session, '05-往工作区外写（照旧弹卡）')
    check(has(userWrite, 'y 批准'), '③ 卡上有批准键', userWrite.text)
    check(has(userWrite, '根外'), '③ 卡上点明落点在**根外**', userWrite.text)

    // —— ③ 反面之二：往**我们自己的产物**里写 ⇒ **也照旧必闸** ——
    await typeLine(session, '往那个输出文件里写一句')
    await session.key('enter')
    const ownWrite = await passCard(session, '06-往我们自己的产物里写（照旧弹卡）')
    check(
      has(ownWrite, '根外'),
      '③ ⚠️ **认下那处 ≠ 放一片**：往我们自己的输出文件里写**照旧判根外**（照旧弹卡）',
      ownWrite.text,
    )

    await session.quit()
    const closed = await session.close({ graceMs: 3_000 })
    check(closed.exit.by === 'app', '收摊：应用自己走的', String(closed.exit.by))
  } finally {
    session = undefined
    await fixture.stop()
    // **外借的那两件归借出方收**（见 `UiSessionOptions.sandbox`）：驱动不删它
    sandbox.dispose()
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u80-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    console.log('\n══ ① 读我们自己的产物（不弹卡 · 读得到）＋ ②③ 反面 ══')
    await readingFrame()
    console.log(`\n帧落在 ${out}`)
  } catch (error) {
    writeFileSync(join(out, 'ERROR.txt'), `${String(error)}\n`, 'utf8')
    throw error
  }
}
