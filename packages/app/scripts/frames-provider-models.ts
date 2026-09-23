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
import { join, resolve } from 'node:path'
import { tempDir } from '../test/tmp.ts'
import { readDatabase } from '../test/support.ts'
import { createUiSession } from '../test/ui/index.ts'
import type { Capture, UiSession } from '../test/ui/index.ts'
import { startProviderFixture } from './frames-provider-models.fixture.ts'
import type { ProviderFixture } from './frames-provider-models.fixture.ts'

/** 本仓根——重开那一段要拿被测 `cli.ts` 的路径（同一个 checkout）。 */
const REPO = resolve(import.meta.dir, '../../..')

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
async function close(session: UiSession, keepSandbox = false): Promise<void> {
  if (closed.has(session)) return
  closed.add(session)

  await session.wait({ text: '○ 空闲' }, { timeoutMs: 10_000 }).catch(() => undefined)
  // 空闲**按两次**才走（U46）——`quit()` 就是那一套
  await session.quit()
  // `keepSandbox`：重开那一段要用**同一块沙地**（HOME / 配置 / 缓存都在里面）
  const report = await session.close({ graceMs: 3_000, keepSandbox })
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
  options: {
    readonly label: string
    readonly columns?: number
    readonly rows?: number
    /** 预载脚本（`.ts`）——见 `rewritePreload`：把「官方地址」落到本地夹具上。 */
    readonly preload?: string
  },
  bench: Bench,
  out: string,
): Promise<UiSession> {
  const cli = join(REPO, 'packages/app/src/cli.ts')

  return createUiSession({
    label: options.label,
    artifacts: join(out, 'runs'),
    columns: options.columns ?? 100,
    rows: options.rows ?? 30,
    // **不给 `turns`** ⇒ 共用驱动不起它自己那台聊天夹具：端点归本单的夹具管
    // （配置里 `providers.personal.baseURL` 指向它）
    config: bench.config,
    // 有预载就走「bun --preload <脚本> <cli>」（见 `rewritePreload`）
    ...(options.preload === undefined
      ? {}
      : { command: [process.execPath, '--preload', options.preload, cli] }),
  })
}

/**
 * **把「官方地址」落到本地夹具上**——给「接一条**新连接**」那一趟用的预载脚本。
 *
 * 由头：新接的连接在配置里**只有 `vendor`**（地址由适配给官方地址），而沙地**不许碰真端点**
 * （验收准则：端点用本地假服务）。于是这一手在**测试侧**把对官方主机的那几次 `fetch`
 * 改写到本地夹具——产品代码一个字不知道，路径 / 认证头 / 方法原样过去
 * （夹具照旧按 `Authorization` 判凭据，故「凭据从哪儿来」这一条仍是真的）。
 *
 * ⚠️ **限度写清楚**：这证明的是**链路与形状**（适配拼出的 URL、认证位置、请求方法、
 * 响应归一），**不证明**官方端点真的接受这把 key。真账号验证另需真实凭据。
 */
function rewritePreload(out: string, hosts: readonly string[], baseURL: string): string {
  const path = join(out, '重定向预载.ts')
  const lines = hosts.map((host) => `  { host: ${JSON.stringify(host)}, to: ${JSON.stringify(baseURL)} },`)

  writeFileSync(
    path,
    [
      '/** 测试侧预载：把对官方主机的 fetch 改写到本地夹具（由留帧装置生成，见 `rewritePreload`）。 */',
      'const targets = [',
      ...lines,
      ']',
      'const real = globalThis.fetch',
      'globalThis.fetch = ((input: any, init: any) => {',
      '  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? "")',
      '  const hit = targets.find((one) => url.startsWith(`https://${one.host}`))',
      '  if (hit === undefined) return real(input, init)',
      '  const rewritten = hit.to + url.slice(`https://${hit.host}`.length)',
      '  return real(rewritten, init)',
      '}) as typeof fetch',
      '',
    ].join('\n'),
    'utf8',
  )

  return path
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

// ══ ⑤ 接入：密钥那一屏**不回显**（真终端上验）══════════════════════════

/** 打进密钥屏的那一串——**只为证明它不上屏**（不是真 key，一眼看得出是假的）。 */
const TYPED_SECRET = 'sk-fake-u41-typed-secret'

/**
 * 接通一条供应商：挑一家 → **密钥屏** → 保存。
 *
 * 这一屏要证的是三件**只有真终端说得清**的事：
 * ① 密钥屏上**一个真字符都不出来**（屏上是圆点）；
 * ② 原文既不在屏上、也不在应用的原始输出字节里（留档给取证）；
 * ③ 取消（`esc`）之后什么都没发生——不发命令、不留回执。
 *
 * ⚠️ **限度写在这儿**：`provider.save` 的后端接线归内核线（本装置跑的这一刻还是「还没做」
 * 的回话），故这一屏验的是**界面与按键路径**；「保存之后真去供应商那儿取列表」那一段
 * 等内核接上之后再跑一遍（回报里记着）。
 */
async function connecting(out: string): Promise<void> {
  const bench = compatBench()
  const session = await start({ label: 'u41-接入' }, bench, out)

  try {
    await typeLine(session, '/model connect')
    await pressKey(session, 'enter')
    await Bun.sleep(800)
    const picking = await session.capture({ label: '08-挑一家供应商' })
    keep(out, picking, '08-挑一家供应商')

    check(has(picking, 'MiniMax'), '`/model connect` 开到「挑一家」那一屏——名单来自读面')
    check(has(picking, 'DeepSeek'), '另一家也在')

    // —— 密钥那一屏 ——
    await pressKey(session, 'enter', { until: { text: '回显' }, timeoutMs: 10_000 })
    // ⚠️ **等的是圆点，不是那串密钥**（它压根不上屏——这一条判据要的正是这个）：
    // 原先写的是 `typeLine(session, TYPED_SECRET)`（等它出现），真接上之后当场超时
    // ——那正是「不回显」成立的样子。故等一个**只可能来自「打进字了」**的条件。
    await session.send(TYPED_SECRET, { until: { text: '••••' }, timeoutMs: 10_000 })
    const typed = await session.capture({ label: '09-密钥屏（输入不回显）' })
    keep(out, typed, '09-密钥屏（输入不回显）')

    check(has(typed, '不回显'), '标签就写着「输入不回显」——用户知道自己的字为什么看不见')
    check(!has(typed, TYPED_SECRET), '**打进去的那串一个字都不上屏**')
    check(has(typed, '•'), '屏上是圆点（看得出「打进去了几个字」）')
    // 原始字节也查一遍（屏上没画 ≠ 没写出去）
    check(!session.rawText().includes(TYPED_SECRET), '**应用的原始输出里也没有它**')
    writeFileSync(join(out, '09-原始字节里搜密钥.txt'), [
      `在应用写出的 ${session.rawText().length} 个字符里搜「${TYPED_SECRET}」的结论：`,
      session.rawText().includes(TYPED_SECRET) ? '**搜到了**（不该）' : '一个字符都没有',
      '',
      '（这是原始 stdout，含 ANSI 与历次重绘——屏上没画不等于没写出去，故两处都查）',
      '',
    ].join('\n'), 'utf8')

    // —— 取消：什么都不该发生 ——
    await pressKey(session, 'esc', { until: { absent: '不回显' }, timeoutMs: 10_000 })
    await Bun.sleep(300)
    const gone = await session.capture({ label: '10-取消之后' })
    keep(out, gone, '10-取消之后')

    check(!has(gone, '不回显'), '这一屏收起了')
    check(bench.fixture.requests().length === 0, '全程零模型请求（夹具那儿一条都没有）')
  } finally {
    await close(session)
    await bench.fixture.stop()
  }
}

// ══ ⑥ 真实闭环：接入 → 列表 → 选择 → 调用 → 保存 → **重开** ═══════════

/**
 * 一条**从零接通**的路走到底（U41 界面返修 · 集成那一趟的正题）。
 *
 * 走的是**真链路**：空配置起步 → `/model` 空态里选「连接供应商」→ 挑 MiniMax → 挑区域
 * → 密钥屏（假 key）→ 保存（内核写盘 ＋ 就去取列表）→ 列表里出现**夹具经 HTTP 给的**型号
 * → 选一个 → 真发一句话（夹具那儿的出站 model 是物证）→ 设为默认。
 *
 * 收尾做**重开**：同一块沙地、**另起一个进程**跑 `--script`（无人值守那一入口），
 * 证明「保存下来的连接与默认」在**新进程**里读得回来、且真能拿它发出去。
 *
 * 隔离：合成假 key、环回夹具、`HOME` 指沙地（`MAGIC_HOME` 不设 ⇒ 基础目录仍是
 * `<HOME>/.magic`——U42 的缺省那条路），真 `~/.magic` 零触碰、一个付费请求都不发。
 */
async function connectingLive(out: string): Promise<void> {
  const fixture = startProviderFixture({
    vendor: 'minimax',
    key: FAKE_KEY,
    models: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-Text-01' }],
    chat: [{ kind: 'text', text: '好，先看登录那一段。', chunks: 3, chunkDelayMs: 30 }],
  })
  // **空配置起步**（首次运行就是这样：一条连接都没有）——`defaultProvider` 一并撤掉
  // （留着一个指向不存在连接的默认，加载器会当场点名报错）；官方主机重定向到夹具（见 `rewritePreload`）
  const preload = rewritePreload(out, ['api.minimax.cn', 'api.minimax.chat', 'api.deepseek.com'], fixture.baseURL)
  const session = await start(
    { label: 'u41-接通并重开', preload },
    { fixture, config: { defaultProvider: undefined, providers: {} } },
    out,
  )

  let kept = false
  try {
    // —— ① 空态：列表给可点的入口 ——
    await typeLine(session, '/model')
    await pressKey(session, 'enter', { until: { text: '连接供应商' }, timeoutMs: 10_000 })
    const empty = await session.capture({ label: '13-空配置的模型屏' })
    keep(out, empty, '13-空配置的模型屏')
    check(has(empty, '连接供应商'), '空配置也能进选择器，且入口就在屏上')

    // —— ② 接一条：挑供应商 → 挑区域 → 密钥 → 保存 ——
    await pressKey(session, 'enter', { until: { text: 'MiniMax' }, timeoutMs: 10_000 })
    const vendors = await session.capture({ label: '14-挑一家（读面给的）' })
    keep(out, vendors, '14-挑一家（读面给的）')
    check(has(vendors, 'DeepSeek'), '名单来自调用线的查询出口（两家都在）')

    await pressKey(session, 'enter') // 选定 MiniMax
    // MiniMax ⇒ 下一步**直接是密钥屏**：首批两家在适配里**各只有一个区域**
    // （`packages/model/src/vendors.ts`：minimax 只有 `cn`、deepseek 只有 `official`），
    // 而「只有一个区域」没有选择可言——外壳不问那一步，也**不写** `region`（约定：不写＝缺省那项）。
    // 说明里仍把这一次会用哪个区域报出来（见下面那条判据）；**多区域那一支**由
    // `spec.u41.test.ts` ⑩ 的用例钉着（喂一家两个区域 ⇒ 中间多一屏、选定才写）。
    await session.wait({ text: '不回显' }, { timeoutMs: 10_000 })
    const keys = await session.capture({ label: '15-密钥屏（含区域交代）' })
    keep(out, keys, '15-密钥屏（含区域交代）')
    check(has(keys, '中国大陆'), '说明里报出**这一次会用哪个区域**（适配给的可读名）')
    check(has(keys, 'api.minimax') === false, '地址不往屏上堆（适配解析好，用户通常不必看）')
    // 打的就是夹具认的那把（合成假 key）——输错的话取列表会 401，那是夹具在正确工作
    await session.send(FAKE_KEY, { until: { text: '••••' }, timeoutMs: 10_000 })
    const before = fixture.requests().length
    await pressKey(session, 'enter') // 保存（**不是** esc——那是取消）
    // 保存成不成、列表取没取到，**屏上说得清**：等到型号出现在列表里，才说明整条链走通了
    // （保存 → 回话 → 外壳接着问一次列表 → 内核真去 HTTP 取）
    await session.wait({ text: 'MiniMax-M3' }, { timeoutMs: 25_000 })
    check(fixture.requests().length > before, '**保存之后真去供应商那儿取了列表**（夹具收到了 GET）')

    // —— ③ 列表里出现 HTTP 给的型号 ——
    await session.wait({ text: 'MiniMax-M3' }, { timeoutMs: 15_000 })
    const listed = await session.capture({ label: '16-列表（来自 HTTP）' })
    keep(out, listed, '16-列表（来自 HTTP）')
    check(has(listed, 'MiniMax-Text-01'), '**一个连接下的多个型号来自真实列表**')
    keepTrace(out, fixture, '16-请求轨迹')

    // —— ④ 选一个 → 真发一句 ——
    await pressKey(session, 'down') // 挪到第二个型号
    await pressKey(session, 'enter', { until: { text: '已换模型' }, timeoutMs: 10_000 })
    await typeLine(session, '看一眼登录')
    const chatsBefore = fixture.requests().filter((one) => one.endpoint === '/chat/completions').length
    await pressKey(session, 'enter', { until: { text: '先看登录那一段' }, timeoutMs: 20_000 })
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 15_000 })

    const calls = fixture.requests().filter((one) => one.endpoint === '/chat/completions')
    check(calls.length === chatsBefore + 1, '一次交代 ＝ 一次调用')
    check(calls.at(-1)?.model === 'MiniMax-Text-01', '**出站的就是列表里选中的那一条**', String(calls.at(-1)?.model))
    check(calls.at(-1)?.auth === 'ok', '凭据用的是刚接上时输入的那把（夹具认了）')
    const answered = await session.capture({ label: '17-调用之后' })
    keep(out, answered, '17-调用之后')
    keepTrace(out, fixture, '17-请求轨迹')

    // —— ⑤ 设为默认（详情屏 → 设为默认） ——
    // 列表开在**当前那条**上（刚换过去的 MiniMax-Text-01），故不必挪——直接按 `→` 进详情。
    // （挪一下反而会落到末尾那几条**入口行**上，而入口行没有「详情」这回事）
    await typeLine(session, '/model')
    await pressKey(session, 'enter', { until: { text: 'MiniMax-Text-01' }, timeoutMs: 10_000 })
    await pressKey(session, 'right') // → 详情
    await session.wait({ text: '设为默认' }, { timeoutMs: 10_000 })
    const detail = await session.capture({ label: '18a-详情（选中的那条）' })
    keep(out, detail, '18a-详情（选中的那条）')
    check(has(detail, 'MiniMax-Text-01'), '详情开着的是**选中的那一条**')
    await pressKey(session, 'down')
    await pressKey(session, 'enter', { until: { text: '默认' }, timeoutMs: 10_000 })
    await Bun.sleep(400)
    const afterDefault = await session.capture({ label: '18-设为默认' })
    keep(out, afterDefault, '18-设为默认')

    // —— ⑤b 分母：切到**有窗长依据**的那一条，屏上当场出现分母 ——
    //
    // ⚠️ 先 `esc` 收起详情那一屏：抽屉开着时打的字一律被吞（选择器接管输入）——
    // 直接打 `/model` 会等不到它上屏（本装置第一版就是这么断的）。
    await pressKey(session, 'esc', { until: { absent: '设为默认' }, timeoutMs: 10_000 })
    await Bun.sleep(200)
    //
    // M3 在内置容量表里（1,000,000）而 Text-01 没有 ⇒ 切过去那一刻分母就该出来
    // （`model.switched` 自己带着 `inputBudget`＝1,000,000 − 本次预留输出）；
    // 再切回 Text-01 ⇒ **清空**（不知道就是不知道，不沿用上一个的数）。
    // 列表开在**当前那条**（Text-01，第 2 行）上——按一下 `↑` 就是 M3（第 1 行）。
    // ⚠️ 别多按：再往下是末尾那三条**入口行**，回车会跑去「连接供应商」（本装置栽过）。
    await typeLine(session, '/model')
    await pressKey(session, 'enter', { until: { text: 'MiniMax-M3' }, timeoutMs: 10_000 })
    await pressKey(session, 'up')
    await pressKey(session, 'enter', { until: { text: '已换模型' }, timeoutMs: 10_000 })
    await Bun.sleep(300)
    const withBudget = await session.capture({ label: '18b-分母（有窗长依据的那条）' })
    keep(out, withBudget, '18b-分母（有窗长依据的那条）')
    check(has(withBudget, '996k'), '**分母跟着切换出现**（1,000,000 − 本次预留输出）', withBudget.statusLine)

    // 这回当前那条是 M3（第 1 行）——按一下 `↓` 到 Text-01（第 2 行）
    await typeLine(session, '/model')
    await pressKey(session, 'enter', { until: { text: 'MiniMax-Text-01' }, timeoutMs: 10_000 })
    await pressKey(session, 'down')
    await pressKey(session, 'enter', { until: { text: '已换模型' }, timeoutMs: 10_000 })
    await Bun.sleep(300)
    const noBudget = await session.capture({ label: '18c-没有窗长依据就不给分母' })
    keep(out, noBudget, '18c-没有窗长依据就不给分母')
    check(!has(noBudget, '996k'), '**换到没有依据的那条 ⇒ 分母清空**（不沿用上一个的数）', noBudget.statusLine)

    // —— ⑥ 读盘：连接与默认都在 ——
    const configPath = join(session.facts().home, '.magic', 'config.json')
    const saved = JSON.parse(readFileSync(configPath, 'utf8')) as {
      readonly providers?: Record<string, Record<string, unknown>>
      readonly defaultProvider?: string
    }
    writeFileSync(join(out, '18-保存下来的配置.json'), `${JSON.stringify(saved, null, 2)}\n`, 'utf8')

    check(saved.defaultProvider === 'minimax', '保存默认写进了配置', JSON.stringify(saved.defaultProvider))
    check(saved.providers?.['minimax']?.vendor === 'minimax', '连接的 `vendor` 也写下来了')
    check(saved.providers?.['minimax']?.region === undefined, '只有一个区域 ⇒ **不写** `region`（用缺省那项）')
    // 三格：`vendor`（哪一家）· `apiKey`（凭据）· `model`（**用户设的默认那一条**）。
    // 型号清单**不进配置**——列表是缓存（在 dataDir 下），这正是「不因发现模型而膨胀」。
    check(
      Object.keys(saved.providers?.['minimax'] ?? {}).sort().join(',') === 'apiKey,model,vendor',
      '配置里就这几格（**列表里的型号没被塞进来**）',
      JSON.stringify(Object.keys(saved.providers?.['minimax'] ?? {})),
    )
    check(saved.providers?.['minimax']?.model === 'MiniMax-Text-01', '`model` 是刚设为默认的那一条')

    kept = true
  } finally {
    // **留住沙地**：下一段「重开」要用同一块（HOME / 配置 / 缓存都在里面）
    await close(session, true)
    // ⚠️ **夹具先别停**：下一段「重开」还要用它（同一个端点，另起一个进程再打一次）
    keepTrace(out, fixture, kept ? '20-请求轨迹（到收摊为止）' : '20-请求轨迹（失败现场）')
  }

  // —— ⑦ 重开：同一块沙地、**另起一个进程** ——
  //
  // 用 `--script`（无人值守那一入口，不是 TUI）：它把「一次交代」跑到底，
  // 而**出站用的是配置里保存的默认**——这正是「重开之后还认得那条连接」的物证。
  const home = session.facts().home
  const workspace = session.facts().workspace
  const script = { inputs: ['再看一眼登录'] }
  const scriptPath = join(out, '重开-脚本.json')
  writeFileSync(scriptPath, JSON.stringify(script), 'utf8')

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/^MAGIC_.*_API_KEY$/.test(key)) continue
    if (key === 'MAGIC_HOME') continue // 沙地不设它 ⇒ 基础目录仍是 `<HOME>/.magic`（U42 的缺省那条）
    env[key] = value
  }
  env['HOME'] = home

  const before = fixture.requests().filter((one) => one.endpoint === '/chat/completions').length
  const proc = Bun.spawn([process.execPath, '--preload', preload, join(REPO, 'packages/app/src/cli.ts'), '--script', scriptPath], {
    cwd: workspace,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  writeFileSync(join(out, '19-重开那一趟.txt'), `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`, 'utf8')

  const calls = fixture.requests().filter((one) => one.endpoint === '/chat/completions')
  check(proc.exitCode === 0, '**重开那一趟正常跑完**（exit 0）', stderr.slice(0, 300))
  check(calls.length === before + 1, `重开之后又发了一次调用（实测 ${calls.length - before}）`, stderr.slice(0, 300))
  check(calls.at(-1)?.model === 'MiniMax-Text-01', '**出站的是保存下来的默认型号**', String(calls.at(-1)?.model))
  keepTrace(out, fixture, '21-请求轨迹（全程）')

  await fixture.stop()
}

// ══ ⑥ 管理：连接一览 → 某一条的明细 ═══════════════════════════════════

/**
 * `/model manage` 那一屏（管理面的真读数：`provider.list` 这一条**已经真接**了）。
 *
 * 看的是**层级与文案**：一览上一个连接一行（供应商 · 认证来处），进明细是四件动作，
 * 连接自己的那几格写在下方说明里。
 */
async function managing(out: string): Promise<void> {
  const bench = compatBench()
  const session = await start({ label: 'u41-管理' }, bench, out)

  try {
    await typeLine(session, '/model manage')
    await pressKey(session, 'enter')
    await Bun.sleep(800)
    const list = await session.capture({ label: '11-连接一览' })
    keep(out, list, '11-连接一览')

    check(has(list, '认证：配置文件'), '`/model manage` 开到「连接一览」那一屏（含认证来处）')
    check(has(list, 'personal'), '一览里有那条连接')
    check(has(list, '认证：配置文件'), '**认证来处说得清**（配置文件 / 环境变量，不含糊说「已设置」）')

    await pressKey(session, 'enter', { until: { text: '移除这条连接' }, timeoutMs: 10_000 })
    const detail = await session.capture({ label: '12-这一条的明细' })
    keep(out, detail, '12-这一条的明细')

    check(has(detail, '改名'), '四件动作都在：改名')
    check(has(detail, '更新认证'), '更新认证')
    check(has(detail, '移除这条连接'), '移除（并标明已有记录不随它删除）')
    check(has(detail, '连接 personal'), '连接自己的那几格写在下方说明里')
  } finally {
    await close(session)
    await bench.fixture.stop()
  }
}

// ══ ⑦ 配置不被发现模型撑大（**读盘**，不是读屏）════════════════════════

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
  { name: '接入', run: connecting },
  { name: '接通并重开', run: connectingLive },
  { name: '管理', run: managing },
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
