#!/usr/bin/env bun
/**
 * U41 · **供应商与模型管理的留帧装置**（界面线）——真 PTY ＋ 真装配，落成可核对的帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它办的是界面线不能不做的那一件事
 * （`AGENTS.md`·工作模式：「外壳改动，验收必须含**看帧判外观**」）：把用户看得见的那几屏
 * 落成**字**（读屏读出来的）与**字格**，好按四项读——布局 · 文案 · 层级 · 从上到下通读。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型读屏）。**端点那一头是本单自己的夹具**
 * （`frames-provider-models.fixture.ts`：loopback ＋ 合成假 key），故：
 * **一个付费请求都不发**，真 `~/.magic` 零触碰，而「列表 / 详情 / 聊天」三跳都是**真 HTTP**。
 *
 * ## 与夹具的分工（边界写在这儿）
 *
 * 装置证明的是**产品这一侧**：接通之后列得出什么、选得对不对、刷新与取消动不动你的草稿、
 * 真实出站的是不是选中的那一条。**不证明**「这个账号有权调用那个模型」——那要真账号另验，
 * 工单允许明写限度（本装置一律合成假 key）。夹具自己的行为由同名用例
 * （`packages/app/test/frames-provider-models.test.ts`）咬住——**尺子先自证**。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/scripts/frames-provider-models.ts --out <目录>
 * bun packages/app/scripts/frames-provider-models.ts --out <目录> --only 选择与出站
 * ```
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../test/tmp.ts'
import { readDatabase } from '../test/support.ts'
import { createUiSession } from '../test/ui/index.ts'
import type { Capture, UiSession } from '../test/ui/index.ts'
import { startProviderFixture } from './frames-provider-models.fixture.ts'
import type { ProviderFixture } from './frames-provider-models.fixture.ts'

/** 合成假 key——**一眼看得出是假的**（真要有人抄去用，抄不坏任何东西）。 */
const FAKE_KEY = 'sk-fake-u41-not-a-real-key'

/**
 * 选择器右位那句的一段——**抽屉开着的判据**。
 *
 * ⚠️ 取的是「**回车 定**」这四个字，**不是**尾巴那截「esc 收起」：输入行候选那一栏
 * （`HINT_COMPLETION`）也以「esc 收起」收尾，拿尾巴当判据会在**候选还开着**的时候就放行
 * ——真跑栽过（第一趟：判据在 `/model` 还没提交时就成了，拍到的是一屏候选）。
 *
 * 全文是 `↑↓ 选 · 回车 定 · esc 收起`（`view.ts` 的 `HINT_PICKER`）——它没出包，
 * 故这里按**字面量**锚；改文案时这条判据会红，那正是它该有的反应。
 */
const PICKER_HINT = '回车 定'

/** 收摊时用的两个键（写的是**真字节**：与手按同一个键、进同一个 stdin）。 */
const CTRL_C = String.fromCharCode(0x03)

/** 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/** 留一屏——文本写进 `<out>/<名字>.txt`，字格与光标写进同名 `.json`，并印一份给人读。 */
function keep(out: string, shot: Capture, label: string): void {
  writeFileSync(join(out, `${label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${label}.json`),
    `${JSON.stringify(
      {
        columns: shot.columns,
        rows: shot.rows,
        cursor: shot.cursor,
        scrollback: shot.scrollback,
        lines: shot.lines,
        runFiles: shot.files,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${label} ──\n${shot.text}`)
}

/** 屏上有没有这一行。 */
function has(shot: Capture, needle: string): boolean {
  return shot.lines.some((line) => line.includes(needle))
}


/**
 * 打一行字并**等它真出现在屏上**（按键丢了就等不到——不重发，如实失败）。
 *
 * 文本与回车**分两次写**，且**先等草稿上屏再回车**（挤在同一次写里整段按键会被丢掉）。
 */
async function typeLine(session: UiSession, text: string, shown = text): Promise<void> {
  await session.send(text, { until: { text: shown }, timeoutMs: 10_000 })
}

/**
 * 按一个**非文字键**——先等一小会儿再写。
 *
 * 由头（真跑栽过两次）：PTY 上两次写挨得太近时，应用**一次 read 就会把它们并成一块**读进来，
 * Ink 那边于是收到一个「输入 = `\r\x7f`」的怪键（`key.return` 为假）——回车会变成一个
 * **正文里的控制字符**。等一等，让上一次写先被读走，再写下一次。
 */
async function pressKey(
  session: UiSession,
  name: 'enter' | 'backspace' | 'tab' | 'up' | 'down' | 'esc',
  until?: Parameters<UiSession['key']>[1],
): Promise<void> {
  await Bun.sleep(150)
  await session.key(name, until)
}

/** 收过摊的（同一会话只收一次——驱动的 `close` 没有二次调用守卫）。 */
const closed = new WeakSet<UiSession>()

/**
 * 收摊——**先等它闲下来**再 `ctrl+c`（忙时那一下是**中断**不是退出，外壳的既有语义）。
 * 只有 `exit.by === 'app'`（它自己走的）才算这一趟干净收场。
 */
async function close(session: UiSession): Promise<void> {
  if (closed.has(session)) return
  closed.add(session)

  await session.wait({ text: '○ 空闲' }, { timeoutMs: 10_000 }).catch(() => undefined)
  await session.key('ctrl+c')
  const report = await session.close({ graceMs: 3_000 })
  const how = `${report.exit.by}（code ${report.exit.code ?? '-'} / signal ${report.exit.signal ?? '-'}）`

  if (report.exit.by !== 'app') throw new Error(`应用不是自己走的（${how}）——收摊那条路没走完`)

  console.log(`  · 收摊：${how} · 帧 ${report.frames} 张 · 现场 ${report.runDir}`)
}

/** 一块沙地要的那些零件（一台夹具 ＋ 一份配置）——**四个场景共用一套装法**。 */
type Bench = {
  readonly fixture: ProviderFixture
  readonly config: Record<string, unknown>
}

/**
 * 装一套被测现场——**兼容形**（`baseURL` ＋ `model` 的旧条目）。
 *
 * ⚠️ 这一形是**基线**：新形制（只有 `vendor` ＋ 认证、型号来自接口）落地之后，
 * 旧形仍必须照跑（工单：「旧兼容配置/URL/覆盖保持」）。故这一档的判据**不随新形制改写**，
 * 它是「旧的没被碰坏」那一条的常驻看门人。
 *
 * 模型信息表与聊天共用一台夹具（同一台服务器的两条端点）——省得判据要盯两个端口。
 */
function compatBench(
  options: {
    readonly models?: readonly { readonly id: string }[]
    readonly model?: string
    readonly chat?: Parameters<typeof startProviderFixture>[0]['chat']
  } = {},
): Bench {
  const model = options.model ?? 'MiniMax-M3'
  const fixture = startProviderFixture({
    vendor: 'minimax',
    key: FAKE_KEY,
    models: options.models ?? [{ id: 'MiniMax-M3' }, { id: 'MiniMax-Text-01' }],
    chat: options.chat ?? [{ kind: 'text', text: '好，先看登录那一段。', chunks: 3, chunkDelayMs: 30 }],
  })

  return {
    fixture,
    config: {
      defaultProvider: 'personal',
      providers: {
        personal: { baseURL: fixture.baseURL, apiKey: FAKE_KEY, model },
      },
    },
  }
}

/** 起一趟真应用（真 PTY ＋ 真 cli.ts）——配置指向上面的夹具。 */
async function start(
  options: { readonly label: string; readonly columns?: number; readonly rows?: number },
  bench: Bench,
  out: string,
): Promise<UiSession> {
  return createUiSession({
    label: options.label,
    artifacts: join(out, 'runs'),
    columns: options.columns ?? 100,
    rows: options.rows ?? 30,
    // **不给 `turns`** ⇒ 共用驱动不起它自己那台聊天夹具：端点归本单的夹具管
    // （配置里 `providers.personal.baseURL` 指向它）
    config: bench.config,
  })
}

/** 夹具收到的请求轨迹落盘——**「实际出站的是哪一条」的物证**。 */
function keepTrace(out: string, fixture: ProviderFixture, label: string): void {
  const lines = fixture
    .requests()
    .map(
      (one) =>
        `${one.n}. ${one.method} ${one.endpoint}${one.query} · auth=${one.auth}` +
        (one.model === '' ? '' : ` · model=${one.model}`),
    )

  writeFileSync(join(out, `${label}.txt`), `${lines.join('\n')}\n`, 'utf8')
  console.log(`\n── ${label}（${lines.length} 次请求）──\n${lines.join('\n')}`)
}

// ══ ① 打开 · 选择 · 出站一致 ═══════════════════════════════════════════

/**
 * 一整套「选得中、发得对」：开抽屉 → 照片 → 选定 → 回执 → 真发一句话 →
 * **夹具那儿的 model 就是选中的那一条**。
 *
 * 这一条是工单重点验收里那句「实际出站连接/精确型号与选择一致」在界面侧的落点：
 * 光看屏上写着什么是自证，**出站报文才是物证**。
 */
async function picking(out: string): Promise<void> {
  const bench = compatBench()
  const session = await start({ label: 'u41-选择' }, bench, out)

  try {
    // —— 开抽屉 ——
    await typeLine(session, '/model')
    await pressKey(session, 'enter', { until: { text: PICKER_HINT }, timeoutMs: 10_000 })
    const opening = await session.capture({ label: '01-打开模型列表' })
    keep(out, opening, '01-打开模型列表')

    check(has(opening, 'personal'), '列表里列得出那条连接')
    check(has(opening, 'MiniMax-M3'), '连接上的模型名也报得出来（副文案）')
    check(has(opening, PICKER_HINT), '右位报的是选择器的键位')

    // —— 选定 ——
    await pressKey(session, 'enter', { until: { text: '已换模型' }, timeoutMs: 10_000 })
    const picked = await session.capture({ label: '02-选定之后' })
    keep(out, picked, '02-选定之后')

    check(!has(picked, PICKER_HINT), '选定之后抽屉收起（右位不再报选择器键位）')
    check(has(picked, '已换模型'), '留一行回执说换成了什么')

    // —— 发一句话：**出站报文是最硬的物证** ——
    await typeLine(session, '看一眼登录')
    await pressKey(session, 'enter', { until: { text: '先看登录那一段' }, timeoutMs: 15_000 })
    // ⚠️ 等**这一轮收束**（`○ 空闲`）再读库与拍照——收束之前那一轮还没落定，
    //    ④ 的用量也还没上报（真跑栽过：拍到的是一屏「工作中」）
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 15_000 })
    const answered = await session.capture({ label: '03-调用之后' })
    keep(out, answered, '03-调用之后')

    const calls = bench.fixture.requests().filter((one) => one.endpoint === '/chat/completions')
    check(calls.length === 1, `一次交代 ＝ 一次模型调用（实测 ${calls.length} 次）`)
    check(calls[0]?.model === 'MiniMax-M3', '**实际出站的就是选中的那一条**', String(calls[0]?.model))
    check(calls[0]?.auth === 'ok', '凭据从配置里取到了（夹具认了这把合成假 key）')
    keepTrace(out, bench.fixture, '03-请求轨迹')

    // —— 落账：选择与调用都是**可回查的会话事实** ——
    //
    // ⚠️ 查的是 `model.switched` / `model.call.start`，**不是 `model.usage`**——
    //    后者按契约**不落库**（实时订阅专用，落库收束为调用级）。判据锚错 kind 会写成
    //    一条永远红（或更坏：改去查一个别的数然后自我说服）的断言。
    const raw = readDatabase(join(session.facts().dataDir, 'records.db'))
    const kinds = raw.events.map((row) => row.kind)
    const user = raw.entries.filter((row) => row.kind === 'user')
    const assistant = raw.entries.filter((row) => row.kind === 'assistant')
    const started = raw.events
      .filter((row) => row.kind === 'model.call.start')
      .map((row) => JSON.parse(row.data) as { readonly model?: string })
    raw.close()

    check(kinds.includes('model.switched'), '换模型那一刻的账在（model.switched 落库）')
    check(user.length === 1, `这一条交代落了账（实测 ${user.length} 条用户条目）`)
    check(assistant.length === 1, `答复也落了账（实测 ${assistant.length} 条助手条目）`)
    check(
      started.some((one) => one.model === 'MiniMax-M3'),
      '**真跑用的是哪一条**在库里查得到（model.call.start 带模型名）',
      JSON.stringify(started),
    )
  } finally {
    await close(session)
    await bench.fixture.stop()
  }
}

// ══ ② 取消：不留痕迹、不切模型、不发请求 ═══════════════════════════════

/**
 * `esc` 收起抽屉＝**什么都没发生**（设计 · 终端交互：「取消不发模型请求」、
 * 「`esc` 取消＝不留痕迹」）——记录区不多一行、模型不换、夹具一条请求都没有。
 *
 * 这一条与 ① 是一对：**选中会变，取消一点都不变**。少了它，「随手点开看一眼」就成了一次
 * 有副作用的操作——那正是用户最不设防的一下。
 */
async function cancelling(out: string): Promise<void> {
  const bench = compatBench()
  const session = await start({ label: 'u41-取消' }, bench, out)

  try {
    await typeLine(session, '/model')
    await pressKey(session, 'enter', { until: { text: PICKER_HINT }, timeoutMs: 10_000 })

    // ⚠️ `esc` 之后**别紧接着做下一件事**：孤立 ESC 要等下一个字节才知道是不是转义序列的开头
    //    （紧随其后的按键会被当成它的续尾吞掉）——故分开等：先等它真收起
    await pressKey(session, 'esc', { until: { absent: PICKER_HINT }, timeoutMs: 10_000 })
    // 收起之后**多等一拍**再拍照：esc 那一跳与它后面那次重绘不是同一帧（真跑栽过）
    await Bun.sleep(300)
    const escaped = await session.capture({ label: '04-取消之后' })
    keep(out, escaped, '04-取消之后')

    check(!has(escaped, '已换模型'), '取消不留回执（记录区不多一行）')
    check(!has(escaped, PICKER_HINT), '抽屉确实收起了')
    check(bench.fixture.requests().length === 0, '**一条模型请求都没发**（夹具零请求）')
  } finally {
    await close(session)
    await bench.fixture.stop()
  }
}

// ══ ③ 窄窗：列表还成不成行 ═════════════════════════════════════════════

/**
 * 46 列下开一次抽屉——看**布局**（`AGENTS.md` 的看帧四项之一）。
 *
 * 窄窗是这一摊的老病区：候选行折行会让交互区的高度账与屏分家（U31 那条「真光标高一行」）。
 * 这里量的是**看得见的那几件**：一行一条、不超宽、键位提示还在。
 */
async function narrow(out: string): Promise<void> {
  const bench = compatBench({
    models: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-Text-01' }],
    model: 'a-very-long-model-name-that-would-not-fit-in-46-columns',
  })
  const session = await start({ label: 'u41-窄窗', columns: 46, rows: 24 }, bench, out)

  try {
    await typeLine(session, '/model')
    await pressKey(session, 'enter', { until: { text: PICKER_HINT }, timeoutMs: 10_000 })
    const shot = await session.capture({ label: '05-窄窗列表' })
    keep(out, shot, '05-窄窗列表')

    const tooWide = shot.lines.filter((line) => line.length > 46)
    check(tooWide.length === 0, '一行都不超宽（没折行账与屏分家）', tooWide.join(' / '))
    check(has(shot, 'personal'), '窄窗下连接名照旧看得见')
    check(has(shot, PICKER_HINT), '键位提示还在（窄窗不该把它挤没）')

    // —— 一条候选只占一行 ——
    //
    // 由头：模型列表**没挂 `oneLine`** 时，长模型名在窄窗里由 Ink 折行 ⇒ 交互区高度账
    // 少算一行 ⇒ 矮终端上真光标错位（U31 那一族的老病）。设计写死「候选每项一行……
    // 窄窗先保住名称/来源、再截断简述」。**折行的判据＝下一行还接着名字的后半截**
    // （那一截只在名字里出现，不会自己跑到别处去）。
    const at = shot.lines.findIndex((line) => line.includes('personal'))
    const tail = at === -1 ? '' : (shot.lines[at + 1] ?? '')

    check(at !== -1, '窄窗下列表那一行在屏上', shot.text)
    check(!tail.includes('ld-not-fit'), '一条候选只占一行（折行的那半截没有掉到下一行）', tail)
  } finally {
    await close(session)
    await bench.fixture.stop()
  }

  // —— 反例：宽窗下**一个字都不截** ——
  //
  // `对表.md`：修 A 要交 B 的反例——「窄窗先截断」这条修法最容易的过头是**宽窗也去截**
  // （U33 的技能行二轮退回的正是这一形）。故同一份行，宽窗下必须原样全出。
  const wide = compatBench({ model: 'a-very-long-model-name-that-would-not-fit-in-46-columns' })
  const roomy = await start({ label: 'u41-宽窗', columns: 100, rows: 30 }, wide, out)

  try {
    await typeLine(roomy, '/model')
    await pressKey(roomy, 'enter', { until: { text: PICKER_HINT }, timeoutMs: 10_000 })
    const shot = await roomy.capture({ label: '05b-宽窗不截' })
    keep(out, shot, '05b-宽窗不截')

    check(has(shot, 'would-not-fit-in-46-columns'), '宽窗下模型名一个字不截（上面那条修法的反例）', shot.text)
  } finally {
    await close(roomy)
    await wide.fixture.stop()
  }
}

// ══ ④ 长列表：高度有界、焦点可见（真终端上看）══════════════════════════

/**
 * 一条连接下几十个型号是常态（供应商接口说了算，不由我们挑）——故列表必须**高度有界**，
 * 且**焦点跟着 `↑↓` 走**（设计 · 终端交互：「高度有界、焦点可见」）。
 *
 * 这一屏量的三件：① 记录区**还在**（候选不许把这一趟的上下文顶出屏幕）；② 折起来的那一头
 * **如实报条数**；③ 挪到窗口之外以后，选中那条仍在屏上。
 *
 * ⚠️ 旧形下「一个条目 ＝ 一个连接 ＋ 一个模型」，故这里摆 30 条连接来凑出长列表；
 * 新形制（型号来自接口）落地之后，同一屏由**一条连接的 30 个型号**给——判据一行不用改。
 */
async function longList(out: string): Promise<void> {
  const providers: Record<string, unknown> = {}
  for (let at = 0; at < 30; at += 1) providers[`conn-${at}`] = { model: `model-${at}` }

  const fixture = startProviderFixture({ vendor: 'minimax', key: FAKE_KEY })
  const bench: Bench = {
    fixture,
    config: {
      defaultProvider: 'conn-0',
      providers: Object.fromEntries(
        Object.entries(providers).map(([id, one]) => [
          id,
          { baseURL: fixture.baseURL, apiKey: FAKE_KEY, ...(one as Record<string, unknown>) },
        ]),
      ),
    },
  }
  const session = await start({ label: 'u41-长列表', columns: 60, rows: 24 }, bench, out)

  try {
    await typeLine(session, '/model')
    await pressKey(session, 'enter', { until: { text: PICKER_HINT }, timeoutMs: 10_000 })
    const shot = await session.capture({ label: '07-长列表' })
    keep(out, shot, '07-长列表')

    // ⚠️ 「不超过 24 行」这条量不出名堂——VT 的屏就是 24 行，怎么画都 ≤ 24。
    //    要量的是**分区**：记录区还在不在（分隔线之上有没有内容）、交互区占了几行。
    const at = shot.lines.findIndex((line) => line.startsWith('──'))
    const dockLines = shot.lines.slice(at + 1).filter((line) => line.trim() !== '')

    check(at > 0, '记录区还在（分隔线之上仍有内容——候选没有把它顶出屏幕）', shot.text)
    check(dockLines.length <= 14, `交互区不超过半屏＋提示＋状态行（实测 ${dockLines.length} 行）`)
    check(has(shot, '还有'), '折起来的那一头如实报了条数')
    check(!has(shot, 'conn-29'), '折起来的那些确实没画')

    // —— 焦点可见：挪到窗口之外 ——
    // ⚠️ 方向键**一下一下来**（连着按会被并入同一次读，Ink 只解头一个序列——U40 那条实测）
    for (let at = 0; at < 14; at += 1) await pressKey(session, 'down')
    const moved = await session.capture({ label: '07b-挪到窗口外' })
    keep(out, moved, '07b-挪到窗口外')

    const movedAt = moved.lines.findIndex((line) => line.startsWith('──'))

    check(has(moved, '上面还有'), '窗口跟着平移了（上头开始折起来）')
    check(movedAt > 0, '平移之后记录区照旧在')
    check(
      moved.lines.slice(movedAt + 1).filter((line) => line.trim() !== '').length <= 14,
      '平移之后交互区照旧有界',
    )
  } finally {
    await close(session)
    await bench.fixture.stop()
  }
}

// ══ ⑤ 配置不被发现模型撑大（**读盘**，不是读屏）════════════════════════

/**
 * 「用户配置不因发现模型而膨胀」＋「保存不泄露凭据」——**两件都读盘**，不读屏。
 *
 * 由头：屏上说什么都不算数——**膨胀与否是文件的事，泄露与否是记录的事**。故这一条量的是：
 * ① 跑完「列出 → 选择 → 调用」之后 `config.json` 有没有多出型号条目；
 * ② 那把 key 有没有溜进记录库（事件与条目都不许有）。
 */
async function configAndSecrets(out: string): Promise<void> {
  const bench = compatBench()
  const session = await start({ label: 'u41-配置' }, bench, out)

  try {
    const configPath = join(session.facts().home, '.magic', 'config.json')
    const before = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>

    // 开一次列表、选一次、发一句话——把「发现模型 → 选择 → 真的用上」跑一遍
    await typeLine(session, '/model')
    await pressKey(session, 'enter', { until: { text: PICKER_HINT }, timeoutMs: 10_000 })
    await pressKey(session, 'enter', { until: { text: '已换模型' }, timeoutMs: 10_000 })
    await typeLine(session, '在吗')
    await pressKey(session, 'enter', { until: { text: '先看登录那一段' }, timeoutMs: 15_000 })

    const after = JSON.parse(readFileSync(configPath, 'utf8')) as {
      readonly providers?: Record<string, Record<string, unknown>>
      readonly defaultProvider?: string
    }
    writeFileSync(
      join(out, '06-配置前后.json'),
      `${JSON.stringify({ before, after }, null, 2)}\n`,
      'utf8',
    )

    // —— ① 配置没有被型号撑大 ——
    const entry = after.providers?.['personal'] ?? {}
    check(
      Object.keys(entry).sort().join(',') === 'apiKey,baseURL,model',
      '连接条目还是那三格（没有被列表里的型号撑大）',
      JSON.stringify(Object.keys(entry)),
    )
    check(after.defaultProvider === 'personal', '普通换模型不动用户默认（默认另有明确动作）')

    // —— ② 凭据没有溜进记录 ——
    const raw = readDatabase(join(session.facts().dataDir, 'records.db'))
    const dump = JSON.stringify({
      entries: raw.entries,
      events: raw.events,
    })
    raw.close()

    check(!dump.includes(FAKE_KEY), '**凭据一个字节都没进记录库**（事件与条目都查过）')
    check(!dump.includes('authorization') && !dump.includes('Bearer'), '认证头也没被记进去')
  } finally {
    await close(session)
    await bench.fixture.stop()
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

const SCENES: readonly { readonly name: string; readonly run: (out: string) => Promise<void> }[] = [
  { name: '选择与出站', run: picking },
  { name: '取消不留痕', run: cancelling },
  { name: '窄窗列表', run: narrow },
  { name: '长列表', run: longList },
  { name: '配置与凭据', run: configAndSecrets },
]

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const out = at === -1 ? tempDir('magic-frames-u41-') : (process.argv[at + 1] as string)
  const onlyAt = process.argv.indexOf('--only')
  const only = onlyAt === -1 ? null : (process.argv[onlyAt + 1] as string)
  mkdirSync(out, { recursive: true })

  const chosen = only === null ? SCENES : SCENES.filter((scene) => scene.name === only)
  if (chosen.length === 0) {
    throw new Error(`没有这个场景「${only}」——有这些：${SCENES.map((one) => one.name).join(' / ')}`)
  }

  for (const scene of chosen) {
    console.log(`\n══ ${scene.name} ══`)
    await scene.run(out)
  }
  console.log(`\n全部判据通过。帧落在 ${out}`)
}
