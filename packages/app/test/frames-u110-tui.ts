#!/usr/bin/env bun
/**
 * U110 · **查看：另开一屏**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `.test.ts`）。
 *
 * ## 这一单改了什么
 *
 * 对话照旧内联（主缓冲、终端自己的滚动条，一个字没动）；**要细看时 `ctrl+o` 另开一整屏**：
 * 切**备用屏**、画满一屏、**只用来显示**；退出后对话原样（设计 · 终端交互「查看：另开一屏」）。
 * 内联那半的「就地展开」整条撤掉（物理上做不到：定局的行进了 `<Static>` 不再重绘）。
 *
 * ## 四张帧 ＋ 两条反向判据
 *
 * | 帧 | 工单那一格 | 判据 |
 * | --- | --- | --- |
 * | `01` | 进视图**之前** | 折叠态那一屏：折住的那句写着「… 还有 N 行（`ctrl+o` 看全文）」 |
 * | `02` | **视图内**（含搜索与跳转） | 展开态：折住的行都在、`{}` 跳到用户交代、`/`＋`n` 找得到、状态行在位 |
 * | `03` | **退出之后** | 屏与「进之前」**逐行相同**（主缓冲没被污染） |
 * | `04` | `v` 交给 `$EDITOR` | 桩编辑器收到了**整份**转写（不是路径、不是摘要） |
 * | `05` | **选中一条材料**（追加） | 那一行反显，底下行给出两个动作（加入本次输入 / 导出原图） |
 * | `06` | **执行「加入本次输入」后回对话**（追加） | 引用落在**进屏前那个插入点**上（不是开头、不是末尾、也不是它当年在旧交代里的偏移） |
 * | `07` | **不选中时**（反向判据） | 底下那行**一个字都不提**那两条动作 |
 *
 * 两条**反向判据**（这是本单最要紧的一对，都是「不该发生的事」）：
 * - **不进视图时，对话与改动前逐字节一致**——本装置的判法是**进出一趟**：进出前后的
 *   **整个缓冲**（含 scrollback）逐行相同，且**没有一行被多印一份**；
 * - **备用屏进出不污染主缓冲**——进去时主屏那一份照旧是「进之前」的样子（`03` 与 `01` 相同），
 *   且字节流里**真是** `CSI ?1049h` / `CSI ?1049l` 那一对（不是拿清屏糊的）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u110-tui.ts --out <目录>
 * ```
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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

/** 可见屏上含某词的整行（报错时贴给人看）。 */
function linesWith(shot: Capture, needle: string): string {
  return shot.lines
    .map((line) => line.trim())
    .filter((line) => line.includes(needle))
    .join(' ⏎ ')
}

/** 状态行里报的「共多少行」（那一屏的整条记录有多长）。 */
function totalOf(shot: Capture): number {
  const matched = /\/ (\d+) 行/.exec(statusOf(shot))

  return matched === null ? 0 : Number(matched[1])
}

// ══ 这一趟的素材 ════════════════════════════════════════════════════

/** 大块正文（40 行）——收起态只报一行，**展开态每一行都在**（「里面不折」的物证）。 */
const BIG_CMD = 'seq 1 40 | sed "s/^/u110a-/"'

/**
 * `edit` 那一笔的**大 diff**——折行那句（`log.ts` 的 `… 还有 N 行`）只有这一条路出得来
 * （`resultBody` 只在 `edit` 推得出 diff 时默认铺预览）。
 *
 * 两侧各 24 行 ⇒ diff 四十来行 ⇒ 预览 16 行，剩下那一截**必然**折住。
 */
const DIFF_PATH = 'u110-diff.txt'
const DIFF_OLD = Array.from({ length: 24 }, (_, at) => `旧行-${at + 1}`).join('\n')
const DIFF_NEW = Array.from({ length: 24 }, (_, at) => `新行-${at + 1}`).join('\n')

/** 用户交代里那三个记号——`{` / `}` 跳的就是它们（每条交代一个，屏上好认）。 */
const TURN_1 = '第一件事：跑个大输出'
const TURN_2 = '第二件事：改个文件'
const TURN_3 = '第三件事：总结一下'

/**
 * 发那条带图交代时**先打的三个字**——先打它、再贴图（`ctrl+v`）⇒ 正文是 `看看 Image#1`。
 *
 * ⚠️ 这三个字**不再是**「加入本次输入」的落点依据（U110 裁决后：落点是**进屏前那个插入点**，
 * 与这条旧交代里 `Image#1` 当年在哪一格无关）——它在这儿只是为了让那条交代带上一张图。
 */
const IMAGE_PREFIX = '看看 '

/** 贴进来的那张图（1×1 真 PNG——与 `frames-u107` 同一张：尺子认它、字节小）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * 搜的那个词——只出现在**大块正文**里（内联屏上根本没有它）。
 *
 * 取 `u110a-3` 是有由头的：它命中 **11 处**（`u110a-3` 自己 ＋ `u110a-30`…`u110a-39`），
 * 故「第几处 / 共几处」与 `n` / `N` 都有得走——只命中一处的话那几个判据全是空转。
 */
const NEEDLE = 'u110a-3'

// ══ 起手与收摊 ══════════════════════════════════════════════════════

async function openScene(options: {
  readonly label: string
  readonly turns: readonly FixtureTurn[]
  /** 加给子进程环境的那几位（沙地那份 `env` 就是交给子进程的那一份）。 */
  readonly env?: Record<string, string>
}): Promise<{ readonly session: UiSession; readonly sandbox: Sandbox; readonly fixture: { stop(): Promise<void> } }> {
  const fixture = startFixture({ turns: options.turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  Object.assign(sandbox.env, options.env ?? {})

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

/**
 * 收摊：先照产品的方式退，再停夹具、删沙地。
 *
 * ⚠️ **收摊这一趟自己出错不许盖掉真正的失败**（实测踩过：一条判据没过，`finally` 里
 * `quit()` 又超时，抛出来的成了那一句 `UiWaitTimeout`——判据的原话一个字都看不见）。
 * 故这一层把收摊的毛病**记下来、不抛**：它是清场，不是判据。
 */
async function closeScene(scene: {
  readonly session: UiSession
  readonly sandbox: Sandbox
  readonly fixture: { stop(): Promise<void> }
}): Promise<void> {
  try {
    await scene.session.quit()
  } catch (error) {
    console.log(`  （收摊：未能照产品方式退出——${String(error).split('\n')[0]}）`)
  }

  try {
    await scene.session.close({ graceMs: 3_000 })
  } finally {
    await scene.fixture.stop()
    await scene.sandbox.dispose()
  }
}

/**
 * 一屏的一行——**活屏与定格帧共用这一格**（`VtScreen.lines` 与 `Capture.lines` 都是
 * 一行的数组，只是活屏那边每行是个带 `text` 的对象）。
 */
type Screenish = { readonly lines: readonly { readonly text: string }[]; readonly rows: number }

/** 底下那一行状态行（位置都写在它上面——故「滚没滚」看它最准）。 */
function statusLine(shot: Screenish): string {
  return (shot.lines[shot.rows - 1]?.text ?? '').trim()
}

/** 顶行（这一屏第一个非空行——跳转判据按它咬，不按「屏上有没有」咬）。 */
function topLine(shot: Screenish): string {
  return (shot.lines.find((line) => line.text.trim() !== '')?.text ?? '').trim()
}

/** 定格帧（`Capture`）那一头：行是纯文本，另起一对同义的取法。 */
function statusOf(shot: Capture): string {
  return shot.lines[shot.rows - 1]?.trim() ?? ''
}

function topOf(shot: Capture): string {
  return shot.lines.find((line) => line.trim() !== '')?.trim() ?? ''
}

/**
 * **等那一屏的某一处到位**——轮询**活屏**（不落帧），超时（3 秒）抛「没动静」。
 *
 * ## 为什么非等不可（这一单踩到的）
 *
 * 那一屏是**另一个进程**里的一个死循环：按键写进 PTY 之后，它要**读到、走一步、重画**
 * 才轮到屏上。而驱动那一侧的 `send()` 只保证「字节写出去了」（写完睡 1ms 就回来）——
 * 拿它当「按完了」用，取到的帧有时是**按之前**那一张（本装置第一版就是这么假的：
 * 一条判据时绿时红，红的时候屏上还停在原处）。故凡「按一下要看到结果」的地方，
 * 一律**等一个可判的量**（`read` 那一支）。
 */
async function waitOn(
  session: UiSession,
  read: (screen: Screenish) => string,
  ok: (now: string) => boolean,
  what: string,
): Promise<void> {
  for (let at = 0; at < 150; at += 1) {
    const now = read(await session.screen())
    if (ok(now)) return
    await Bun.sleep(20)
  }

  throw new Error(`等了 3 秒，那一屏${what}——此刻底下那行是「${statusLine(await session.screen())}」`)
}

/**
 * 底下那行报的「读到哪儿 / 共多少行」→ `[起, 止, 共]`（报不出就是 `null`）。
 *
 * 滚动那几条判据拿它认位置：`atTop` 是「从第 1 行起」，`atBottom` 是「读到末行」——
 * **不写死那个数**（写死 112 的话，改一句素材就全得跟着改，而它判的本来不是那个数）。
 */
function rangeOf(line: string): readonly [number, number, number] | null {
  const matched = /(\d+)–(\d+) \/ (\d+) 行/.exec(line)
  if (matched === null) return null

  return [Number(matched[1]), Number(matched[2]), Number(matched[3])]
}

const showsTop = (line: string): boolean => rangeOf(line)?.[0] === 1
const showsBottom = (line: string): boolean => {
  const range = rangeOf(line)

  return range !== null && range[1] === range[2]
}

/**
 * **等一件事成真**（与屏无关的那些条件用它——如「桩编辑器真被叫起来了」）。
 *
 * 与 `waitOn` 一样是**有界**的（3 秒），超时抛「没等到」。
 */
async function waitUntil(ok: () => boolean, what: string): Promise<void> {
  for (let at = 0; at < 150; at += 1) {
    if (ok()) return
    await Bun.sleep(20)
  }

  throw new Error(`等了 3 秒，${what}`)
}

/** 按一个键，**等底下那行变了**（位置一动它就变），再往下走。 */
async function pressScrolling(session: UiSession, text: string): Promise<string> {
  const was = statusLine(await session.screen())
  await session.send(text)
  await waitOn(session, statusLine, (now) => now !== was, `没有动（按的是 ${JSON.stringify(text)}）`)

  return was
}

/** 按一个键，**等底下那行回到这个值**（「回得到原处」那几条判据用它）。 */
async function pressUntil(session: UiSession, text: string, want: string): Promise<void> {
  await session.send(text)
  await waitOn(session, statusLine, (now) => now === want, `没有回到「${want}」`)
}

/** 一屏的全部文字（判「屏上有没有这一句」用它）。 */
function allText(shot: Screenish): string {
  return shot.lines.map((line) => line.text).join('\n')
}

/** 按一个键，**等顶行成为这一句**（`{` / `}` 那两条用它——锚落在交代自己的头一行上）。 */
async function pressToTurn(session: UiSession, text: string, want: string): Promise<void> {
  await session.send(text)
  await waitOn(session, topLine, (now) => now.includes(want), `顶行没有落在「${want}」上`)
}

/**
 * 按一个键，**等这一句出现在屏上**——⚠️ 与上面那条分工明确：**最后一条交代**跳过去时，
 * 它下面已经不够一屏了 ⇒ 那一行**到不了屏顶**（位置被夹在「最多能滚到哪儿」上）。
 * 那是**对的**（再往下就没内容了），故最后那一条判「看得见」，不判「在顶上」。
 */
async function pressToSee(session: UiSession, text: string, want: string): Promise<void> {
  await session.send(text)
  await waitOn(session, allText, (now) => now.includes(want), `屏上没有出现「${want}」`)
}

/** 打一行字并**等它真出现在屏上**（文本与回车分两次写——挤在同一次写里按键会丢）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 提交一句交代，等这一轮的答复落定。 */
async function say(session: UiSession, said: string, until: string): Promise<void> {
  await typeLine(session, said)
  await session.key('enter', { until: { text: until }, timeoutMs: 60_000 })
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 30_000 })
}

/**
 * **开那一屏并等它真画出来**。
 *
 * 等的那一句是**这一屏自己的话**（状态行里的键位提示）——屏上别处不会有它，
 * 故这一等不会落在「主屏还没走完」的那一刻上。
 */
async function enterScreen(session: UiSession): Promise<void> {
  await session.key('ctrl+o', { until: { text: 'ctrl+u/d 半页' }, timeoutMs: 15_000 })
}

/** **退出那一屏并等主屏回来**（等的是主屏状态行那一格「空闲」——那一屏上没有它）。 */
async function leaveScreen(session: UiSession): Promise<void> {
  await session.send('q', { until: { text: '○ 空闲' }, timeoutMs: 15_000 })
}

// ══ ① 反向判据 ＋ ② 视图内（不折 · 键位逐条）═══════════════════════════

async function sceneScreen(): Promise<void> {
  const scene = await openScene({
    label: 'u110-那一屏',
    turns: [
      // ① → 大块正文（收起态只报一行）
      { kind: 'tool', name: 'exec', args: { cmd: BIG_CMD } },
      { kind: 'text', text: '一跑完了。' },
      // ② → edit 的大 diff（折住那一句就是它）
      { kind: 'tool', name: 'edit', args: { path: DIFF_PATH, old: DIFF_OLD, new: DIFF_NEW } },
      { kind: 'text', text: '二改完了。' },
      // ③ → 收尾
      { kind: 'text', text: '三说完了。' },
    ],
  })

  // 那一笔 `edit` 要**真有那个文件**才改得成（不顺带验失败那一形——那是 U83 的事）
  writeFileSync(join(scene.sandbox.workspace, DIFF_PATH), `${DIFF_OLD}\n`, 'utf8')

  try {
    await say(scene.session, TURN_1, '一跑完了。')
    await say(scene.session, TURN_2, '二改完了。')
    await say(scene.session, TURN_3, '三说完了。')

    // —— 01 进视图之前（折叠态） ——
    const before = await scene.session.capture({ label: '01-进之前' })
    keep(before, '01-进之前')

    check(
      has(before, '… 还有') && has(before, '（ctrl+o 看全文）'),
      '① 屏上折住的那句写着「… 还有 N 行（ctrl+o 看全文）」（**不是**旧那句「展开」）',
      linesWith(before, '还有'),
    )
    check(
      !has(before, NEEDLE),
      '① 大块正文那 40 行**没有**在内联屏上（收起态只报一行——那正是要另开一屏的由头）',
      linesWith(before, 'u110a-'),
    )
    check(
      !has(before, 'ctrl+u/d 半页'),
      '① 进之前没有那一屏的任何痕迹',
    )

    // —— 02 视图内 ——
    await enterScreen(scene.session)

    const inside = await scene.session.capture({ label: '02-视图内' })
    keep(inside, '02-视图内')

    check(
      inside.scrollback === 0,
      '② 这一屏是**备用屏**（它自己的缓冲，底下一行存档都没有）',
      `scrollback=${inside.scrollback}`,
    )
    check(
      has(inside, TURN_1),
      '② 整条记录从顶上铺起（头一条交代在屏上）',
      linesWith(inside, '件事'),
    )
    check(
      /1–\d+ \/ \d+ 行/.test(statusOf(inside)),
      '② 底下那行报得出「读到哪儿 / **共多少行**」——这一屏看的是**整条记录**（不是本轮那一块）',
      statusOf(inside),
    )
    check(
      totalOf(inside) > 60,
      '② 整条记录比一屏长（所以这才叫「另开一屏」：一屏装不下它）',
      `共 ${totalOf(inside)} 行`,
    )
    check(
      !has(inside, '（ctrl+o 看全文）'),
      '② ⚠️ **这一屏上那句「看全文」不该出现**——那一屏**不折**，那 24 行真铺出来了',
      linesWith(inside, '看全文'),
    )
    check(
      has(inside, 'ctrl+u/d 半页') && has(inside, 'q 退出'),
      '② 底下那行键位提示在位（设计列的那些键都在这一行上）',
      linesWith(inside, 'q 退出'),
    )

    // —— `G` 到底：最后一条交代 ＋ 折住的那一截的**尾巴**都在 ——
    await scene.session.send('G')
    await waitOn(scene.session, statusLine, showsBottom, '`G` 没有到底')
    const bottom = await scene.session.capture({ label: '02b-视图内-G到底' })
    keep(bottom, '02b-视图内-G到底')
    check(
      has(bottom, TURN_3) && has(bottom, '三说完了。'),
      '② `G` 到底：**最后一条交代**与它那句答复都在',
      linesWith(bottom, '件事'),
    )
    check(
      has(bottom, '新行-24'),
      '② 折住的那一截**尾巴在**（`新行-24` 在屏上——内联屏上它被折掉了）',
      linesWith(bottom, '新行'),
    )

    // —— 逐条键位：`g` 回顶，`j` / `k` 一行，`ctrl+u` / `ctrl+d` 半页，空格 / `b` 整页 ——
    const top = async (label: string): Promise<Capture> => {
      const shot = await scene.session.capture({ label })
      keep(shot, label)
      return shot
    }

    // —— `g` 回顶：位置回到「1–… / N 行」那一档 ——
    await pressScrolling(scene.session, 'g')
    const atTop = await top('02c-视图内-g回顶')
    check(has(atTop, TURN_1), '② `g` 回顶（头一条交代在屏上）', linesWith(atTop, '件事'))
    const home = statusOf(atTop)

    // —— `j` / `k` 一行一行地滚（`k` **回得到原处**）——
    await pressScrolling(scene.session, 'j')
    const down = await top('02d-视图内-j一行')
    // ⚠️ 判据咬**底下那行的位置**，不咬「顶行动没动」：字标那几行前面本来就是一个空行，
    //    从第 1 行滚到第 2 行时「第一个非空行」纹丝不动（顶行不是一把好尺子）。
    check(statusOf(down) !== home, '② `j` 往下滚一行', `底下那行=${statusOf(down)}（原处 ${home}）`)

    await pressUntil(scene.session, 'k', home)
    const up = await top('02e-视图内-k一行')
    check(statusOf(up) === home, '② `k` 再滚回来（回得到 `j` 之前那一行）', `底下那行=${statusOf(up)}`)

    // —— 半页：往下半屏再往上半屏，**回得到原处**（这正是「半页」那个数的判据）——
    await pressScrolling(scene.session, '\u0004')
    const halfDown = await top('02f-视图内-ctrl+d半页')
    check(statusOf(halfDown) !== home, '② `ctrl+d` 半页往下', `底下那行=${statusOf(halfDown)}`)
    await pressUntil(scene.session, '\u0015', home)
    const halfBack = await top('02g-视图内-ctrl+u半页')
    check(statusOf(halfBack) === home, '② `ctrl+u` 半页往上（回得到原处）', `底下那行=${statusOf(halfBack)}`)

    // —— 整页：`空格` 往下、`b` 往上 ——
    await pressScrolling(scene.session, ' ')
    const paged = await top('02h-视图内-空格整页')
    check(statusOf(paged) !== home, '② `空格` 整页往下', `底下那行=${statusOf(paged)}`)
    await pressUntil(scene.session, 'b', home)
    const pagedBack = await top('02i-视图内-b整页')
    check(statusOf(pagedBack) === home, '② `b` 整页往上（回得到原处）', `底下那行=${statusOf(pagedBack)}`)

    // —— `{` / `}` 跳「上一条 / 下一条用户交代」——
    // 跳过去之后**那一条就在屏顶**（锚落在交代自己的头一行上）——故判据按顶行咬，
    // 不按「屏上有没有」咬（那样连跳错地方也看不出来）。
    await scene.session.send('g')
    await waitOn(scene.session, statusLine, showsTop, '`g` 没有回顶')
    await pressToTurn(scene.session, '}', TURN_1)
    const turn1 = await top('02j-视图内-右花括号下一条交代')
    check(topOf(turn1).includes(TURN_1), '② `}` 跳到**下一条交代**（头一行落在屏顶）', `顶行=${topOf(turn1)}`)

    await pressToTurn(scene.session, '}', TURN_2)
    const turn2 = await top('02k-视图内-再跳下一条')
    check(topOf(turn2).includes(TURN_2), '② 再按一次到位第二条交代', `顶行=${topOf(turn2)}`)

    // ⚠️ 最后一条交代**到不了屏顶**：它下面已经不够一屏（位置夹在「最多能滚到哪儿」上）——
    //    故这一条判「跳到了、看得见」，上面那两条才判「落在屏顶」。
    await pressToSee(scene.session, '}', TURN_3)
    const turn3 = await top('02l-视图内-再跳下一条')
    check(has(turn3, TURN_3), '② 第三条交代（最后一条——它下面不够一屏，屏顶到不了）', linesWith(turn3, '件事'))

    await pressToTurn(scene.session, '{', TURN_2)
    const backTurn = await top('02m-视图内-左花括号上一条交代')
    check(topOf(backTurn).includes(TURN_2), '② `{` 回到**上一条交代**', `顶行=${topOf(backTurn)}`)

    // —— `/` 搜 ＋ `n` / `N` 跳匹配 ——
    await scene.session.send('/', { until: { text: '搜索：' }, timeoutMs: 10_000 })
    const typing = await scene.session.capture({ label: '02n-视图内-搜索中' })
    keep(typing, '02n-视图内-搜索中')
    check(has(typing, '搜索：'), '② `/` 开的是**搜索那一档**（底下那行写着「搜索：」）', linesWith(typing, '搜索'))

    await scene.session.send(NEEDLE)
    await scene.session.key('enter', { until: { text: '第 1/11 处' }, timeoutMs: 10_000 })
    const searched = await top('02o-视图内-搜索命中')
    check(has(searched, `/${NEEDLE}`), '② 回车确认之后底下报出搜的是什么', linesWith(searched, `/${NEEDLE}`))
    check(
      has(searched, NEEDLE),
      '② 命中那一处**被滚进了视野**（搜的是内联屏上根本没有的那一段正文）',
      linesWith(searched, 'u110a-'),
    )
    check(
      searched.lines.some((line, row) => line.includes(NEEDLE) && searched.cellsOf(row).some((cell) => cell.inverse)),
      '② 命中那一行**反显**（找得到、也看得见是哪一行）',
      searched.lines.map((line, row) => (searched.cellsOf(row).some((cell) => cell.inverse) ? line.trim() : '')).join(' ⏎ ') || '（一行都没有反显）',
    )
    check(
      has(searched, '第 1/11 处'),
      '② 底下报得出「第几处 / 共几处」（`u110a-3` 那一串共 11 处）',
      linesWith(searched, '第'),
    )

    await scene.session.send('n', { until: { text: '第 2/11 处' }, timeoutMs: 10_000 })
    const nextMatch = await top('02p-视图内-n跳下一处')
    check(has(nextMatch, '第 2/11 处'), '② `n` 走到下一处', linesWith(nextMatch, '第'))

    await scene.session.send('N', { until: { text: '第 1/11 处' }, timeoutMs: 10_000 })
    const prevMatch = await top('02q-视图内-N回上一处')
    check(has(prevMatch, '第 1/11 处'), '② `N` 回到上一处', linesWith(prevMatch, '第'))

    // —— 03 退出（`q`）——屏与「进之前」逐行相同 ——
    await leaveScreen(scene.session)

    const after = await scene.session.capture({ label: '03-退出之后' })
    keep(after, '03-退出之后')

    check(
      after.lines.join('\n') === before.lines.join('\n'),
      '③ **反向判据①**：退出之后可见屏与「进之前」逐行相同（主缓冲没被污染）',
      `进之前顶行=${before.lines[0] ?? ''} ／ 退出之后顶行=${after.lines[0] ?? ''}`,
    )
    check(
      !has(after, 'ctrl+u/d 半页') && !has(after, '搜索：'),
      '③ 那一屏的东西一件都没留在主屏上',
    )

    // **反向判据②**：进出前后**整个缓冲**逐行相同——对话的历史**一行不多、一行不少**。
    // 「多」那一半尤其要紧：`<Static>` 一旦被重挂，整条对话会**再印一遍**（那才是真丢脸的事）。
    check(
      after.history.length === before.history.length,
      '③ **反向判据②**：整个缓冲的行数一字不变（没有一行被重印）',
      `进之前 ${before.history.length} 行 ／ 退出之后 ${after.history.length} 行`,
    )
    const rewritten = after.history.filter((line, at) => line !== before.history[at])
    check(
      rewritten.length === 0,
      '③ 逐行比对：**一行都没变**（进出那一趟对主缓冲是透明的）',
      rewritten.slice(0, 3).join(' ⏎ '),
    )

    // 那一对字节**真是**备用屏的（不是拿清屏糊的）
    const raw = scene.session.rawText()
    check(
      raw.includes('\u001b[?1049h') && raw.includes('\u001b[?1049l'),
      '③ 字节流里真是 `CSI ?1049h` / `CSI ?1049l` 那一对（进的是备用缓冲）',
    )

    console.log('\n两条反向判据都过了：进出那一趟对主缓冲**逐行透明**。')
  } finally {
    await closeScene(scene)
  }
}

// ══ ④ `v` 交给 `$EDITOR` ════════════════════════════════════════════

/**
 * 桩编辑器——**把它读到的整份转写抄一份出来**（判据要看的是内容，不是它被叫起来了）。
 *
 * 用桩而不是真 `$EDITOR`：这一条要判的是「交给它的是什么」，不是某个编辑器能不能起。
 */
async function sceneEditor(): Promise<void> {
  const stubDir = tempDir('magic-u110-editor-')
  const seen = join(stubDir, 'editor-seen.txt')
  const stub = join(stubDir, 'stub-editor.sh')
  writeFileSync(stub, `#!/bin/sh\ncp "$1" ${JSON.stringify(seen)}\n`, 'utf8')
  chmodSync(stub, 0o755)

  const scene = await openScene({
    label: 'u110-编辑器',
    turns: [
      { kind: 'text', text: 'u110ed-就这一句。' },
    ],
    env: { VISUAL: stub },
  })

  try {
    await say(scene.session, '看看编辑器那一档', 'u110ed-就这一句。')
    await enterScreen(scene.session)
    await scene.session.send('v')

    // ⚠️ **等的是硬证据，不是睡一觉**：桩编辑器真被叫起来（它把读到的那一份抄了出来），
    //    且那一屏**又进了一次备用屏**（`?1049h` 出现第二回——它只可能来自「回来」那一跳）。
    //    早先这里写的是 `await Bun.sleep(1500)`：真帧上量到过**假红**（那一觉睡完了，
    //    应用这一头还没走完那一趟，取到的帧停在主屏那一形）。
    await waitUntil(() => existsSync(seen), '桩编辑器一直没有被叫起来')
    await waitOn(
      scene.session,
      () => scene.session.rawText(),
      (now) => (now.match(/\?1049h/g) ?? []).length >= 2,
      '回来之后没有再进那一屏',
    )
    await Bun.sleep(200) // 回来那一帧画完（`?1049h` 与它之间就隔一次 `write`）

    const inside = await scene.session.capture({ label: '04-交给编辑器' })
    keep(inside, '04-交给编辑器')
    check(has(inside, 'ctrl+u/d 半页'), '④ 编辑器那一趟回来之后**这一屏还在**（退回的是它，不是主屏）')

    // 取完那一帧**退出那一屏**（收摊走的是主屏那套「按两次 ctrl+c」——留在这一屏里
    // 第一下会被它当成「退出这一屏」吃掉）
    await leaveScreen(scene.session)

    const text = await Bun.file(seen).text().catch(() => '')
    check(text.includes('u110ed-就这一句。'), '④ 桩编辑器收到了**整份转写**（那句答复在里面）', text.slice(0, 80))
    check(
      text.includes('看看编辑器那一档'),
      '④ 用户那条交代也在里面（是整条对话，不是一屏截屏）',
      text.slice(0, 80),
    )
  } finally {
    await closeScene(scene)
  }
}

// ══ ⑤ ⑥ ⑦ 材料那一行：选中 → 加入本次输入（U110 · 追加）════════════

/**
 * **一条交代带过的图**——`/attachments` 撤掉（U111）之后，它能做的两件事按裁定变成
 * 「**那一行上的动作**」：**加入本次输入**（插回原位置）· **导出原图**（落一个文件给路径）。
 *
 * ## 这一趟怎么把图弄进记录的（**不碰用户的真剪贴板**）
 *
 * 与 `frames-u107` 同一手：临时目录里造一个**桩 `pngpaste`** 排到 `PATH` 最前面，
 * `ctrl+v` 走的那条路（spawn → 收字节 → 过尺子 → 落 blob → 插 `Image#N`）**一步都没换**，
 * 换的只是末端那条系统命令。
 *
 * ## 三张帧
 *
 * - `05` **选中**：材料那一行反显，底下那行报出**是哪一条**与两个动作；
 * - `06` **加入本次输入**（回车）：回对话，引用落在**原位置**（不是开头、也不是追加到末尾）；
 * - `07` **不选中**（反向判据）：底下那行一个字都不提那两条动作。
 */
async function sceneMaterial(): Promise<void> {
  const bin = tempDir('magic-u110-bin-')
  // ⚠️ **`osascript` 也要桩上**：不桩的话，`pngpaste` 没吐字节时那一趟会落到**真的**
  //    `/usr/bin/osascript` 上，读的就成了用户自己的真剪贴板（`frames-u107` 踩过这一跤）。
  writeFileSync(join(bin, 'osascript'), '#!/bin/sh\necho EMPTY\n', 'utf8')
  chmodSync(join(bin, 'osascript'), 0o755)
  writeFileSync(join(bin, 'payload.bin'), PNG)
  writeFileSync(join(bin, 'pngpaste'), '#!/bin/sh\ncat "$(dirname "$0")/payload.bin"\n', 'utf8')
  chmodSync(join(bin, 'pngpaste'), 0o755)

  const scene = await openScene({
    label: 'u110-材料',
    turns: [{ kind: 'text', text: 'u110m-收到。' }],
    env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` },
  })

  try {
    // —— 发一条带图的交代（图落在第 3 个字符上）——
    // ⚠️ 等的是**不带尾空格**的那三个字：屏上的行会抹掉行尾空白（`vt.ts` 那一条），
    //    而这三字里最后那个正是空格——等带空格的那一串永远等不到（实测踩过）
    await scene.session.send(IMAGE_PREFIX, { until: { text: '看看' }, timeoutMs: 10_000 })
    await scene.session.key('ctrl+v', { until: { text: 'Image#1' }, timeoutMs: 15_000 })
    await scene.session.key('enter', { until: { text: 'u110m-收到。' }, timeoutMs: 60_000 })
    await scene.session.wait({ text: '○ 空闲' }, { timeoutMs: 30_000 })

    /**
     * **再打一句，并把插入点挪到中间**（设计 · 文件与图片：「**在打开查询前的输入位置
     * 插入引用**……**不一律追加到末尾**」）。
     *
     * ⚠️ **插入点要摆在看得出来的一格上**（`再改Image#1一版`）：开头（0）、末尾（4）、
     * 以及那条旧交代里 `Image#1` 当年的偏移（3）三种读法在这一格上**各是各的**——
     * 判据因此咬得住「插到的是**插入点**」。
     */
    const DRAFT = '再改一版'
    await scene.session.send(DRAFT, { until: { text: DRAFT }, timeoutMs: 10_000 })
    await scene.session.key('left')
    await scene.session.key('left')

    // —— 开那一屏：**先看不选中的那一形**（反向判据）——
    await enterScreen(scene.session)
    const unselected = await scene.session.capture({ label: '07-没选中' })
    keep(unselected, '07-没选中')

    check(
      !has(unselected, '加入本次输入') && !has(unselected, '导出原图'),
      '⑦ **反向判据**：一处都没选时，底下那行一个字都不提那两个动作',
      linesWith(unselected, '导出'),
    )
    check(has(unselected, '▣ Image#1'), '⑤ 材料那一行在（`▣ Image#1 · …`）', linesWith(unselected, '▣'))

    // —— `]` 选中它 ——
    await scene.session.send(']')
    await waitOn(scene.session, allText, (now) => now.includes('加入本次输入'), '`]` 之后那两个动作没出来')
    const picked = await scene.session.capture({ label: '05-选中材料' })
    keep(picked, '05-选中材料')

    check(
      has(picked, 'Image#1') && has(picked, '加入本次输入') && has(picked, '导出原图'),
      '⑤ 选中之后底下那行报出**是哪一条**与两个动作',
      linesWith(picked, '加入本次输入'),
    )
    check(
      picked.lines.some((text, row) => text.includes('▣ Image#1') && picked.cellsOf(row).some((cell) => cell.inverse)),
      '⑤ 选中的那一行**反显**（看得出选的是哪一条）',
      picked.lines.map((text, row) => (picked.cellsOf(row).some((cell) => cell.inverse) ? text.trim() : '')).join(' ⏎ '),
    )

    // —— 回车：加入本次输入，回对话 ——
    await scene.session.key('enter', { until: { text: 'Image#1' }, timeoutMs: 15_000 })
    await scene.session.wait({ text: '○ 空闲' }, { timeoutMs: 15_000 })

    const back = await scene.session.capture({ label: '06-回到对话' })
    keep(back, '06-回到对话')

    check(
      !has(back, '加入本次输入'),
      '⑥ 回到对话那一屏（那一屏自己的东西一件都没留下）',
      linesWith(back, '加入本次输入'),
    )
    check(
      has(back, '再改Image#1一版'),
      '⑥ **插在插入点上**：引用落在**进这一屏之前**输入行的那个插入点上（不是开头、不是末尾，' +
        '也不是它当年在那条旧交代里的偏移）',
      linesWith(back, 'Image#1'),
    )
  } finally {
    await closeScene(scene)
  }
}

// ══ 入口 ════════════════════════════════════════════════════════════

const at = process.argv.indexOf('--out')
out = at === -1 ? tempDir('magic-u110-frames-') : (process.argv[at + 1] ?? '')
if (out === '') throw new Error('--out 后面要给一个目录')
mkdirSync(out, { recursive: true })

console.log(`产物目录：${out}\n`)
console.log('══ ① 反向判据 ＋ ② 那一屏（不折 · 键位逐条）══')
await sceneScreen()
console.log('\n══ ④ `v` 交给 `$EDITOR` ══')
await sceneEditor()
console.log('\n══ ⑤⑥⑦ 材料那一行（选中 → 加入本次输入）══')
await sceneMaterial()
console.log('\n全部判据通过。')
