#!/usr/bin/env bun
/**
 * U34 · **步骤清单的留帧装置**（界面线）——真 PTY ＋ 真外壳，落成可核对的帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它干一件界面线不能不做的事
 * （`AGENTS.md`·工作模式：「外壳改动，验收必须含**看帧判外观**」）：把用户看得见的
 * 那几屏落成**字**（读屏读出来的）与**字格**，好让人按四项读——布局 · 文案 · 层级 ·
 * 从上到下通读。
 *
 * ## 走的是真链路（到外壳为止），**夹具边界写在这儿**
 *
 * 真 PTY（`Bun.Terminal` ＋ `Bun.spawn`，经共用驱动的 `createUiSession`）→ 真外壳
 * （`runTui`：真 Ink 渲染 · 真键盘路径 · 真归约）→ 按键**从 PTY 写进它的 stdin**、
 * 屏上的字**从它写出的字节里读**（VT 模型读屏）。
 *
 * ⚠️ **夹具边界（不许含糊）**：被替换的是**内核那一端**——子进程里跑的是真外壳，
 * 它手上的传输是个**脚本化的假内核**（下面 `childCode` 那份）：事件按契约的形状预排，
 * 照真内核的次序发（`plan.changed` 在条目落账之后）。
 * 故本装置证明的是**显示与按键路径**（清单怎么画、`Ctrl T` 与翻页怎么走、零额外命令），
 * **不证明**真实模型真的会调用 `plan_update`、也不证明工具落账那一趟。真实装配的联调
 * 要含内核线交付，由规划协调集成（工单：「不能用预排事件冒充真实模型工具通路」）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/scripts/frames-plan.ts --out <目录>            # 夹具边界那一半（脚本化传输）
 * bun packages/app/scripts/frames-plan.ts --out <目录> --live     # 联调那一半（真装配 · 只换模型网关）
 * ```
 *
 * 出十二屏：开机（不占位）· 计划建立 · 改路线 · 收起 · 展开回来 · 结束移除 ·
 * 窄窗长标题 · 溢出 · 翻到下一屏 · 矮窗让位 · 无色 · 清空后重开（不复活）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PlanNote } from '@magic/contracts'
import { PALETTE } from '@magic/tui'
import { createSandbox, createUiSession, startFixture } from '../test/ui/index.ts'
import type { Capture, FixtureRequest, FixtureTurn, Sandbox, UiSession } from '../test/ui/index.ts'
import { createVt } from '../test/ui/vt.ts'
import { readDatabase } from '../test/support.ts'

const REPO = resolve(import.meta.dir, '../../..')
const TUI_RUN = join(REPO, 'packages/tui/src/run.ts')

/** `Ctrl T` 那一个字节（`0x14`）——写的是**真字节**：与手按同一个键、进同一个 stdin。 */
const CTRL_T = String.fromCharCode(0x14)
/** `Ctrl C` 那一个字节（`0x03`）——空闲＝退出 · 工作中＝中断（归外壳判）。 */
const CTRL_C = String.fromCharCode(0x03)
/** `Ctrl O` 那一个字节（`0x0f`，既有那一个展开键）——同上。 */
const CTRL_O = String.fromCharCode(0x0f)
/** `PgDn`（`CSI 6 ~`）——同上。 */
const PG_DN = `${String.fromCharCode(0x1b)}[6~`
/** 退格（`0x7f`）——清草稿用（那半句是「收起/展开不动草稿」那一屏的证据）。 */
const BACKSPACE = String.fromCharCode(0x7f)
/** 转义符——量字节用（下面那两处检查都拿它拼串，源码里不留控制字节）。 */
const ESC = String.fromCharCode(0x1b)

/** 长标题那一条（与子进程那份**同一个串**——判据要拿它拼回原文对一遍）。 */
const LONG_STEP =
  '先读一遍登录失败那三条分支现在的写法，确认空密码、认证失败与网络失败各自走到了哪儿'

/** `#rrggbb` → 三个通道（量「主题色」那一条用）。 */
function hexOf(color: string): readonly number[] {
  return [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16))
}

/**
 * 整趟原始字节里出现过**几档**「主题色那一族」的前景（呼吸的客观痕迹）。
 *
 * 判法：把真彩前景码收出来，按**同族**筛（暖色：红 > 绿 > 蓝，且落在主题色那一带的量级）
 * ——呼吸是把主题色按亮度缩放，缩出来的每一档都还在这一族里，而别的语义色
 * （青 `user` · 绿 `ok` · 蓝 `tool` · 白 `fg`）都因为「红 > 绿 > 蓝」这一条被挡在外面。
 */
function amberShades(raw: string): number {
  const warm = new Set<string>()

  for (const found of raw.matchAll(/\[38;2;(\d+);(\d+);(\d+)m/g)) {
    const [r, g, b] = [Number(found[1]), Number(found[2]), Number(found[3])]
    if (r > g && g > b && r > 90 && r < 245 && b < 150) warm.add(found[0])
  }

  return warm.size
}

/**
 * 留一屏（**联调那一半**）——文本 ＋ 外壳写出的原始字节（色与重量在里面），并印一份给人读。
 *
 * 与上面那个 `keep()` 分开：那一半用的是共用驱动的 `Capture`（含字格与光标），
 * 这一半是真应用**自己起的一趟**，读数按同一套口径取（可见区行 ＋ 原始字节）。
 */
function keepLive(out: string, app: { text(): string; raw(): string }, label: string): string {
  const text = app.text()
  writeFileSync(join(out, `${label}.txt`), `${text}\n`, 'utf8')
  writeFileSync(join(out, `${label}.ansi`), app.raw(), 'utf8')
  console.log(`\n── ${label} ──\n${text}`)

  return text
}

/**
 * **真实请求轨迹**落盘——夹具收到的每一次模型请求（次序 · 工具件数 · 最后一条 user 说了什么）。
 *
 * 它是「模型真的调了工具」那一件的物证：请求里有 `tools`（工具说明真的送进去了）、
 * 一条交代换来几次往返（工具调一次、回一句，共两次）、以及**发起之前零请求**之类。
 */
function keepTrace(out: string, fixture: { requests(): readonly FixtureRequest[] }, label: string): readonly FixtureRequest[] {
  const requests = fixture.requests()
  const lines = requests.map(
    (one) => `${one.n}. ${one.path} · model=${one.model} · messages=${one.messages} · tools=${one.tools} · user=${one.lastUser}`,
  )

  writeFileSync(join(out, `${label}.txt`), `${lines.join('\n')}\n`, 'utf8')
  console.log(`\n── ${label}（${requests.length} 次请求）──\n${lines.join('\n')}`)

  return requests
}

/** 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/** 留一屏：文本写进 `<out>/<名字>.txt`，字格与光标写进同名 `.json`，并印一份给人读。 */
function keep(out: string, shot: Capture, label: string): void {
  writeFileSync(join(out, `${label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${label}.json`),
    `${JSON.stringify(
      { columns: shot.columns, rows: shot.rows, cursor: shot.cursor, scrollback: shot.scrollback, lines: shot.lines },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${label} ──\n${shot.text}`)
}

// ══ 假内核那一端（子进程）════════════════════════════════════════════

/** 一条步骤（照契约形态）。 */
type Step = { readonly text: string; readonly status: 'pending' | 'in_progress' | 'completed' }

/** 一份计划（照契约形态）。 */
type Note = { readonly steps: readonly Step[]; readonly notes: string }

const PLAN_FIRST: Note = {
  steps: [
    { text: '读登录提示那三处分支', status: 'completed' },
    { text: '改提示文案', status: 'in_progress' },
    { text: '跑一遍失败的几条路', status: 'pending' },
  ],
  notes: '用户要的是「保留输入、说清下一步」',
}

/** 改路线那一份：**已完成保留**，未完成的两步改一处、增一处（设计 · 使用场景）。 */
const PLAN_EDITED: Note = {
  steps: [
    { text: '读登录提示那三处分支', status: 'completed' },
    { text: '先补空密码那条分支', status: 'completed' },
    { text: '认证失败按原文案改', status: 'in_progress' },
    { text: '补一条网络失败的提示', status: 'pending' },
    { text: '跑一遍失败的几条路', status: 'pending' },
  ],
  notes: '网络失败那条是新加的',
}

/**
 * 子进程那份代码——**同一个文件再跑一遍自己**（`--child` 那一支不存在：这里直接
 * `bun -e` 把代码交进去）。外壳与渲染都是真的，只有**内核那一端**是预排的。
 *
 * 为什么用 `bun -e` 而不另落一个小文件：工单给这一个文件（及同名测试/fixture），
 * 子进程需要的那三件（哪份脚本 · 报告写哪儿 · 从哪儿 import）都在这儿生成好，
 * argv 直传、不经 shell，也就不必拼引号、不必再维护第二个入口。
 */
function childCode(variant: string, reportPath: string): string {
  return `
const { runTui } = await import(${JSON.stringify(TUI_RUN)})

const variant = ${JSON.stringify(variant)}
const report = ${JSON.stringify(reportPath)}
const SESSION = 's-frame'

const commands = []
const listeners = new Set()
let seq = 0

/** 发一条事件（照契约的信封）——**返回它的 id**，好让结果认回那次调用（同真内核）。 */
const emit = (kind, data) => {
  seq += 1
  const event = { id: seq, session: SESSION, turn: 1, at: 1_700_000_000_000 + seq, kind, data }
  for (const listener of [...listeners]) listener(event)
  return event.id
}

const PLAN_FIRST = ${JSON.stringify(PLAN_FIRST)}
const PLAN_EDITED = ${JSON.stringify(PLAN_EDITED)}

/** 长标题那一份：一条很长、折成好几行的步骤（窄窗那条判据用它）。 */
const PLAN_LONG = {
  steps: [
    { text: '先读一遍登录失败那三条分支现在的写法，确认空密码、认证失败与网络失败各自走到了哪儿', status: 'in_progress' },
    { text: '按结果改', status: 'pending' },
  ],
  notes: '',
}

/** 长清单那一份：三十步（屏上放不下 ⇒ 起行视口）。 */
const PLAN_MANY = {
  steps: Array.from({ length: 30 }, (_unused, at) => ({
    text: '第 ' + (at + 1) + ' 步：做完这一件',
    status: at === 0 ? 'completed' : at === 1 ? 'in_progress' : 'pending',
  })),
  notes: '',
}

let round = 0

/**
 * 这一步交上去之后该发生什么（一次提交 ＝ 一轮；round 已自增过，第一轮是 1）。
 * 完整那一趟三笔：建立 → 改路线 → **清空**（工作结束，清单退出界面）。
 */
const planOf = () => {
  if (variant === 'long') return PLAN_LONG
  if (variant === 'many') return PLAN_MANY
  if (variant === 'cleared') return round === 1 ? PLAN_FIRST : null
  if (round === 1) return PLAN_FIRST
  if (round === 2) return PLAN_EDITED
  return null
}

function runTurn() {
  round += 1
  const plan = planOf()

  emit('turn.start', {})
  emit('model.delta', { channel: 'text', text: '我先把这件事理一遍，再动手。' })
  const call = emit('tool.call', { name: 'plan_update', args: { plan } })
  const entry = emit('tool.result', { call, ok: true, output: { text: plan === null ? '计划已清空' : '计划已更新' }, plan })
  emit('plan.changed', { entry, plan })
  emit('model.delta', { channel: 'text', text: '\\n正在改这一处。' })
  // ⚠️ **这一轮故意不收束**：屏上要的是「实际执行中」那一副面孔（进行中项 ＋ 呼吸）。
  // 收束由 ctrl+c 那一跳给（外壳发 turn.interrupt，这儿如实回一条 turn.end）。
}

/**
 * 重建那一趟的读面（复验退回那一处的最小反例）：六段，每段一条 assistant ＋ **两个成功的
 * 辅助调用**——最老那一段不在「末尾几组不收」里，故它会走上收拢那条路。
 */
const REBUILT = []
{
  let id = 1
  for (let round = 0; round < 6; round += 1) {
    REBUILT.push({ id: id++, kind: 'assistant', content: { text: 'round' + round }, at: 1_700_000_000_000 + id })
    for (const name of ['plan_update', 'plan_read']) {
      REBUILT.push({ id: id++, kind: 'tool-call', payload: { name, args: {} }, content: { text: '' }, at: 1_700_000_000_000 + id })
      REBUILT.push({
        id: id++,
        kind: 'tool-result',
        payload: { ok: true, output: { text: name + ' 回执' } },
        content: { text: '' },
        at: 1_700_000_000_000 + id,
      })
    }
  }
}

/** 重开那一趟的读面：末条是**清空**那一条 ⇒ 清单不该复活。 */
const HISTORY =
  variant === 'rebuilt'
    ? REBUILT
    : variant === 'reopened'
    ? [
        { id: 201, kind: 'assistant', content: { text: '这件事做完了。' }, at: 1_700_000_000_100 },
        {
          id: 202,
          kind: 'tool-result',
          payload: { ok: true, output: { text: '计划已清空' }, plan: null },
          content: { text: '' },
          at: 1_700_000_000_200,
        },
      ]
    : []

const transport = {
  send(command) {
    commands.push(command)
    if (command.type === 'input.submit') runTurn()
    if (command.type === 'turn.interrupt') emit('turn.end', { reason: 'aborted' })
    if (command.type === 'history.read') emit('session.history', { session: SESSION, entries: HISTORY, done: true })
  },
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

const handle = await runTui({ transport })
await handle.waitUntilExit()
await Bun.write(report, JSON.stringify(commands, null, 2))
`
}

// ══ 驱动那一端（父进程）════════════════════════════════════════════════

type RunOptions = {
  readonly label: string
  readonly variant: string
  readonly columns: number
  readonly rows: number
  readonly forceColor: string
}

/** 起一趟运行（真 PTY ＋ 真外壳）——交回会话与「假内核收到的命令」那份报告在哪。 */
async function start(options: RunOptions, out: string): Promise<{ session: UiSession; reportPath: string }> {
  const reportPath = join(out, `${options.label}-commands.json`)
  const session = await createUiSession({
    command: [process.execPath, '-e', childCode(options.variant, reportPath)],
    columns: options.columns,
    rows: options.rows,
    forceColor: options.forceColor,
    label: `plan-${options.label}`,
    artifacts: join(out, 'runs'),
  })

  return { session, reportPath }
}

/** 打一行字并**等它真出现在屏上**（按键丢了就等不到——不重发，如实失败）。 */
async function typeLine(session: UiSession, text: string, shown = text): Promise<void> {
  await session.send(text, { until: { text: shown }, timeoutMs: 10_000 })
}

/** 收摊——走共用驱动那一套，并交回**它是怎么走的**（`app` ＝ 自己走的）。 */
async function finish(session: UiSession): Promise<string> {
  // 工作中按 ctrl+c ＝ 中断（外壳的既有语义），空闲时再按 ＝ 退出
  for (let at = 0; at < 3; at += 1) {
    await session.key('ctrl+c').catch(() => {})
    await Bun.sleep(150)
  }

  const closed = await session.close({ graceMs: 1500 })

  return closed.exit.by
}

async function main(): Promise<void> {
  const at = process.argv.indexOf('--out')
  const out = process.argv[at + 1] ?? ''
  if (at === -1 || out === '') throw new Error('用法：bun packages/app/scripts/frames-plan.ts --out <目录>')

  mkdirSync(out, { recursive: true })

  // **联调那一半**（真装配）——与夹具那一半分两趟跑，别混在一个产物目录里解释
  if (process.argv.includes('--live')) {
    await live(out)
    await Bun.write(Bun.stdout, `\n联调帧落在：${out}\n`)
    return
  }

  // —— 一 · 完整那一趟（100×30 · 有色）：建立 → 改路线 → 收起 → 展开 → 结束移除 ——
  {
    const { session, reportPath } = await start(
      { label: '01-flow', variant: 'full', columns: 100, rows: 30, forceColor: '3' },
      out,
    )

    try {
      const boot = await session.capture({ label: '01-开机' })
      keep(out, boot, '01-开机')
      check(!boot.text.includes('□'), '没有计划时不占位（屏上一个方块行都没有）')

      await typeLine(session, '登录失败那条提示太笼统了，改一下')
      await session.key('enter')
      await session.wait({ text: '▪ 改提示文案' }, { timeoutMs: 10_000 })
      const built = await session.capture({ label: '02-计划建立' })
      keep(out, built, '02-计划建立')
      check(built.text.includes('▪ 改提示文案'), '默认展开：进行中那一步在屏上（小实心）')
      check(built.text.includes('□ 跑一遍失败的几条路'), '未开始那一步也在（空心）')
      check(built.text.includes('■ 读登录提示那三处分支'), '已完成那一步在（实心）')
      check(!built.text.includes('PgUp/PgDn'), '放得下就不起提示行')
      check(!built.text.includes('plan_update'), '辅助工具的成功调用不刷工具卡')

      await typeLine(session, '网络失败那条也补上')
      await session.key('enter')
      await session.wait({ text: '补一条网络失败的提示' }, { timeoutMs: 10_000 })
      const edited = await session.capture({ label: '03-改路线' })
      keep(out, edited, '03-改路线')
      check(edited.text.includes('■ 读登录提示那三处分支'), '改路线之后已完成项**还在**')
      check(edited.text.includes('□ 补一条网络失败的提示'), '新加的那一步在')

      // Ctrl T 收起（草稿先打半句——收起/展开不许动它）
      await typeLine(session, '半句草稿')
      await session.send(CTRL_T, { until: { text: '计划已收起' }, timeoutMs: 10_000 })
      const folded = await session.capture({ label: '04-收起' })
      keep(out, folded, '04-收起')
      check(folded.text.includes('计划已收起 · ctrl+t 展开'), '收起之后留一行把手')
      check(!folded.text.includes('▪ 改提示文案'), '收起之后步骤行不画')
      check(folded.text.includes('半句草稿'), '收起不动草稿')

      await session.send(CTRL_T, { until: { text: '▪ 认证失败按原文案改' }, timeoutMs: 10_000 })
      const back = await session.capture({ label: '05-展开回来' })
      keep(out, back, '05-展开回来')
      check(back.text.includes('半句草稿'), '展开也不动草稿')
      check(!back.text.includes('计划已收起'), '展开之后把手那一行没了')

      // 结束：清空 ⇒ 清单退出界面
      await session.send(BACKSPACE.repeat(4), { until: { absent: '半句草稿' }, timeoutMs: 10_000 })
      await typeLine(session, '就这样，收工')
      await session.key('enter')
      await session.wait({ absent: '▪ 认证失败按原文案改' }, { timeoutMs: 10_000 })
      const cleared = await session.capture({ label: '06-结束移除' })
      keep(out, cleared, '06-结束移除')
      check(!cleared.text.includes('□ 跑一遍失败的几条路'), '清空之后步骤行全没了')
      check(!cleared.text.includes('计划已收起'), '也不留「已完成」那一类常驻行')

      // 三态的样子在**原始字节**上量一遍（`.txt` 把色与重量都剥掉了，看不见它们）
      const raw = session.rawText()
      const amber = `[38;2;${hexOf(PALETTE.warn).join(';')}m`
      check(raw.includes(`${ESC}[2m`), '已完成那一行压暗（SGR 2）')
      check(raw.includes(amber), `进行中那个方块是主题色（${PALETTE.warn}）`)
      check(amberShades(raw) >= 2, '进行中那个方块在呼吸（整趟里出现过不止一档亮度）')

      const by = await finish(session)
      check(by === 'app', `外壳自己收的场（exit.by=${by}）`)

      // **零额外命令**：整趟只该有 input.submit（读历史那一发由外壳开局发）——
      // 呈现、收起/展开、翻页都不发模型请求（设计：零模型请求、零工具副作用）
      const seen = JSON.parse(await Bun.file(reportPath).text()) as readonly { readonly type: string }[]
      const kinds = [...new Set(seen.map((command) => command.type))]
      // `turn.interrupt` 是**收摊那一下**（我们自己按的 ctrl+c，工作在跑＝中断）——不是屏上那几件发的
      check(
        kinds.every(
          (kind) => kind === 'input.submit' || kind === 'history.read' || kind === 'turn.interrupt',
        ),
        '整趟只发过 提交 / 开局读历史 / 收摊中断（收起 · 展开 · 翻页零模型请求）',
        kinds.join(' · '),
      )
      check(
        seen.filter((command) => command.type === 'input.submit').length === 3,
        '三笔交代就是三次提交——没有多出来的请求',
      )
    } finally {
      await session.close().catch(() => {})
    }
  }

  // —— 二 · 窄窗长标题（40×24）：正常换行、不裁短 ——
  {
    const { session } = await start({ label: '02-long', variant: 'long', columns: 40, rows: 24, forceColor: '3' }, out)

    try {
      await typeLine(session, '先看看现在的写法')
      await session.key('enter')
      await session.wait({ text: '空密码' }, { timeoutMs: 10_000 })
      const shot = await session.capture({ label: '07-窄窗长标题' })
      keep(out, shot, '07-窄窗长标题')
      // 判据：**折行拼回来还是原文**（一行装不下就折下去——不裁短、不省略）
      check(
        shot.lines.map((line) => line.trim()).join('').includes(LONG_STEP),
        '长标题一字不少（折行拼回来仍是原文）',
      )
    } finally {
      await session.close().catch(() => {})
    }
  }

  // —— 三 · 溢出与翻页（60×16 · 三十步）——
  {
    const { session } = await start({ label: '03-many', variant: 'many', columns: 60, rows: 16, forceColor: '3' }, out)

    try {
      await typeLine(session, '这活有点长')
      await session.key('enter')
      await session.wait({ text: 'PgUp/PgDn 翻页' }, { timeoutMs: 10_000 })
      const top = await session.capture({ label: '08-溢出' })
      keep(out, top, '08-溢出')
      check(top.text.includes('下面还有'), '溢出时报出下面还有几行')
      check(top.text.includes('第 1 步'), '第一屏从顶上开始')

      // 「上面 N 行」只在滚过一页之后才出现（第一屏时上面一行都不缺）
      await session.send(PG_DN, { until: { text: '上面 ' }, timeoutMs: 10_000 })
      const paged = await session.capture({ label: '09-翻到下一屏' })
      keep(out, paged, '09-翻到下一屏')
      check(paged.text.includes('上面 '), '翻过一页之后「上面几行」那半句出来了')
      check(!paged.text.includes('第 1 步'), '第一屏那几行翻过去了')
    } finally {
      await session.close().catch(() => {})
    }
  }

  // —— 四 · 矮窗让位（60×8）：清单暂不绘，输入区与状态行照旧 ——
  {
    const { session } = await start({ label: '04-short', variant: 'full', columns: 60, rows: 8, forceColor: '3' }, out)

    try {
      await typeLine(session, '窗口太矮了')
      await session.key('enter')
      // 等正文那一句（它在任何余量下都画得出来）——清单画不画是这条判据要看的
      await session.wait({ text: '正在改这一处' }, { timeoutMs: 10_000 })
      const shot = await session.capture({ label: '10-矮窗让位' })
      keep(out, shot, '10-矮窗让位')
      check(!shot.text.includes('▪ 改提示文案'), '矮窗里清单一行都不画（不落历史、不清屏）')
      check(shot.text.includes('›'), '输入行照旧在（先保证它）')
    } finally {
      await session.close().catch(() => {})
    }
  }

  // —— 五 · 无色（100×30 · FORCE_COLOR=0）——
  {
    const { session } = await start({ label: '05-plain', variant: 'full', columns: 100, rows: 30, forceColor: '0' }, out)

    try {
      await typeLine(session, '无色也读得出来')
      await session.key('enter')
      await session.wait({ text: '▪ 改提示文案' }, { timeoutMs: 10_000 })
      const shot = await session.capture({ label: '11-无色' })
      keep(out, shot, '11-无色')

      // 真无色：**一个 SGR 都不发**（色 · 粗体 · 压暗全是 SGR）——三态只剩字形可依
      const sgr = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
      check(!sgr.test(session.rawText()), '无色那一趟一个 SGR 都没发（含粗体与压暗）')
      check(shot.text.includes('□ 跑一遍失败的几条路'), '无色下「未开始」是空心方块')
      check(shot.text.includes('▪ 改提示文案'), '无色下「进行中」是小实心方块')
      check(shot.text.includes('■ 读登录提示那三处分支'), '无色下「已完成」是实心方块——三态各有各的字形')
    } finally {
      await session.close().catch(() => {})
    }
  }

  // —— 六 · 清空之后重开：清单不复活（读面末条是清空那一条）——
  {
    const { session } = await start(
      { label: '06-reopened', variant: 'reopened', columns: 100, rows: 30, forceColor: '3' },
      out,
    )

    try {
      await Bun.sleep(600) // 等重建那一趟（`history.read` 的答复）走完
      const shot = await session.capture({ label: '12-重开不复活' })
      keep(out, shot, '12-重开不复活')
      check(!shot.text.includes('□'), '重开之后旧清单一个方块都不剩')
      check(shot.text.includes('这件事做完了。'), '记录还在（过程沿既有记录留作排障）')
    } finally {
      await session.close().catch(() => {})
    }
  }

  // —— 七 · 窄窗收起（20 列）：提示截断，**一行** ——
  {
    const { session } = await start({ label: '07-fold20', variant: 'full', columns: 20, rows: 12, forceColor: '3' }, out)

    try {
      await typeLine(session, '窄窗')
      await session.key('enter')
      await session.wait({ text: '跑一遍失败的几条路' }, { timeoutMs: 10_000 })
      await session.send(CTRL_T, { until: { text: '计划已收起' }, timeoutMs: 10_000 })
      const shot = await session.capture({ label: '13-窄窗收起' })
      keep(out, shot, '13-窄窗收起')
      check(
        shot.lines.filter((line) => line.includes('计划已收起')).length === 1,
        '20 列：收起提示只占一行（截断，不是折成两行）',
      )
      check(!shot.lines.some((line) => line.trim() === '展开'), '折下去的那半截没有冒出来')
    } finally {
      await session.close().catch(() => {})
    }
  }

  // —— 八 · 工具详情（ctrl+o）：默认不画，展开就看得到 ——
  {
    const { session } = await start({ label: '08-detail', variant: 'full', columns: 100, rows: 30, forceColor: '3' }, out)

    try {
      await typeLine(session, '改一下提示')
      await session.key('enter')
      await session.wait({ text: '▪ 改提示文案' }, { timeoutMs: 10_000 })
      const quiet = await session.capture({ label: '14-工具详情（收起）' })
      keep(out, quiet, '14-工具详情-收起')
      check(!quiet.text.includes('plan_update'), '辅助工具默认不刷工具卡')

      await session.send(CTRL_O, { until: { text: 'plan_update' }, timeoutMs: 10_000 })
      const shown = await session.capture({ label: '15-工具详情（展开）' })
      keep(out, shown, '15-工具详情-展开')
      check(shown.text.includes('plan_update'), '`ctrl+o` 之后工具名在（既有那一个展开键）')
      check(shown.text.includes('计划已更新'), '结果也在（详情可查）')
    } finally {
      await session.close().catch(() => {})
    }
  }

  // —— 九 · 历史重建（六段 · 复验退回那一处）：分组里不许冒出辅助调用 ——
  {
    const { session } = await start({ label: '09-rebuilt', variant: 'rebuilt', columns: 100, rows: 30, forceColor: '3' }, out)

    try {
      await Bun.sleep(600) // 等重建那一趟（`history.read` 的答复）走完
      const shot = await session.capture({ label: '16-历史重建' })
      keep(out, shot, '16-历史重建')
      check(!shot.text.includes('次工具调用'), '重建出来的分组里没有辅助调用的名字与计数')
      check(!shot.text.includes('plan_update'), '辅助调用一个都没被重新印出来')
      check(shot.text.includes('round0') && shot.text.includes('round5'), '正文照旧（记录完整）')
    } finally {
      await session.close().catch(() => {})
    }
  }

  await Bun.write(Bun.stdout, `\n帧落在：${out}\n`)
}


// ══ 联调那一半（`--live`）：真装配 · 真工具落账 · 真终端 ═══════════════════
//
// 与上面那一半的分工，一句话：
// - **默认**（不带 `--live`）：**夹具边界**——传输是脚本化的假内核（预排事件），
//   证的是显示与按键路径；
// - **`--live`**：**真装配**——真 `cli.ts`（真装配根 · 真记录域 · 真工具域 · 真权限 · 真外壳），
//   **只把模型网关换成受控返回**（loopback 夹具 ＋ 合成假 key，一个付费请求都不发、
//   真 `~/.magic` 零触碰）：模型**真的调** `plan_update`，工具**真的落账**，屏上的清单
//   **真的从记录里长出来**——不是预排内核事件。
//
// 三趟跑在**同一块沙地**上（同一份配置 / 数据库 / 工作区），故「关闭重开」是真的关掉
// 那个进程、再拿 `--session <id>` 另起一个：清单该保留的保留、该不复活的就不复活。

/** 联调那一半的剧本——模型**真的调**辅助工具（不是预排内核事件）。 */
const LIVE_TURNS: readonly FixtureTurn[] = [
  { kind: 'tool', name: 'plan_update', args: { plan: PLAN_FIRST } },
  { kind: 'text', text: '先理了一遍，这就动手。' },
  { kind: 'tool', name: 'plan_update', args: { plan: PLAN_EDITED } },
  { kind: 'text', text: '路线改了，已完成那两步留着。' },
  { kind: 'tool', name: 'plan_update', args: { plan: null } },
  { kind: 'text', text: '这件事到这儿。' },
]

type LiveOptions = {
  readonly label: string
  readonly argv: readonly string[]
  readonly columns: number
  readonly rows: number
}

/** 一趟真应用（真 PTY）——用共用的那几件拼：`Bun.Terminal` ＋ VT 读屏。 */
type LiveApp = {
  readonly pty: Bun.Terminal
  readonly child: Bun.Subprocess
  /** 往 PTY 写（＝手打）。 */
  write(text: string): Promise<void>
  /** 敲一个字节串（回车 / 退格 / `Ctrl T` …）。 */
  key(bytes: string): Promise<void>
  /** 等屏上出现某一串（只查**可见区**——超了就是没等到，如实失败）。 */
  waitFor(needle: string, timeoutMs?: number): Promise<void>
  /** 此刻可见区的那几行。 */
  lines(): readonly string[]
  text(): string
  /** 原始字节（色与重量在里面）。 */
  raw(): string
  /** 收摊：先给 `Ctrl C` 自己走的余地，再 SIGTERM、再 SIGKILL，如实报怎么走的。 */
  close(): Promise<string>
}

async function liveApp(sandbox: Sandbox, options: LiveOptions): Promise<LiveApp> {
  const vt = createVt({ columns: options.columns, rows: options.rows, scrollback: 2_000 })
  const decoder = new TextDecoder()
  let raw = ''

  const pty = new Bun.Terminal({
    cols: options.columns,
    rows: options.rows,
    data: (_terminal: Bun.Terminal, chunk: Uint8Array) => {
      const text = decoder.decode(chunk, { stream: true })
      if (text === '') return
      raw += text
      vt.write(text)
    },
  })

  const child = Bun.spawn([process.execPath, ...options.argv], {
    terminal: pty,
    cwd: sandbox.workspace,
    env: sandbox.env,
  })

  const lines = (): readonly string[] => vt.screen().lines.map((line) => line.text)

  // **起手那一下的余量**（共用驱动文件头注 1 那条坑，实测会丢键）：首帧落了之后还得等
  // 一小会儿——Ink 那一下 `tcsetattr`（开 raw 模式）落定**之前**写进去的字节会被丢掉。
  // ⚠️ 这是**一次**的余量，不是场景同步的手段（后面每一步仍靠 `waitFor` 等屏上的条件）。
  for (let at = 0; at < 250; at += 1) {
    await vt.settled()
    if (lines().some((line) => line.trim() !== '')) break
    await Bun.sleep(40)
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`「${options.label}」还没画出第一帧就退了（code=${child.exitCode} signal=${child.signalCode}）`)
  }
  await Bun.sleep(150)

  const app: LiveApp = {
    pty,
    child,
    write: async (text) => {
      pty.write(text)
      await Bun.sleep(60) // 与手打同形：先让它读走
    },
    key: async (bytes) => {
      pty.write(bytes)
      await Bun.sleep(80)
    },
    waitFor: async (needle, timeoutMs = 12_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await vt.settled()
        if (lines().some((line) => line.includes(needle))) return
        await Bun.sleep(40)
      }

      throw new Error(`等「${needle}」超时。此刻屏上：\n${lines().join('\n')}`)
    },
    lines,
    text: () => lines().join('\n'),
    raw: () => raw,
    close: async () => {
      pty.write(CTRL_C)
      await Bun.sleep(200)
      pty.write(CTRL_C)
      await Bun.sleep(400)

      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await Bun.sleep(600)
      }
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited

      return child.exitCode === 0 && child.signalCode === null ? 'app' : `code=${child.exitCode} signal=${child.signalCode}`
    },
  }

  return app
}

/** 记录里**带计划**的那些条目（按记录序）——「工具真的落账了吗」看它。 */
function planEntriesOf(sandbox: Sandbox): readonly (PlanNote | null)[] {
  const db = readDatabase(join(sandbox.dataDir, 'records.db'))
  try {
    return db.entries.flatMap((entry) => {
      if (entry.kind !== 'tool-result' || entry.payload === null) return []

      const payload = JSON.parse(entry.payload) as { readonly ok?: boolean; readonly plan?: PlanNote | null }
      if (!Object.hasOwn(payload, 'plan')) return []

      return [payload.plan ?? null]
    })
  } finally {
    db.close()
  }
}

/** 一条计划的步骤文字（比对「屏上那一份」与「记录里那一份」用）。 */
const stepTextsOf = (plan: PlanNote | null): readonly string[] => plan?.steps.map((one) => one.text) ?? []

async function live(out: string): Promise<void> {
  // 夹具（受控模型网关）＋ 一块**三趟共用**的沙地
  const fixture = startFixture({ turns: LIVE_TURNS })
  const sandbox = createSandbox({ baseURL: fixture.baseURL, forceColor: '3' })
  const cli = join(REPO, 'packages/app/src/cli.ts')
  const argv = [cli]

  let sessionId = ''

  try {
    // —— 一 · 新会话：交代一句，模型真的调 plan_update ——
    const first = await liveApp(sandbox, { label: 'L1', argv, columns: 100, rows: 30 })
    try {
      await first.waitFor('○ 空闲')
      await first.write('登录失败那条提示太笼统了，改一下')
      await first.waitFor('登录失败那条提示太笼统了，改一下')
      await first.key('\r')
      await first.waitFor('▪ 改提示文案')
      await first.waitFor('○ 空闲')

      const shot = keepLive(out, first, 'L1-建立（真装配）')
      for (const [at, step] of PLAN_FIRST.steps.entries()) {
        const mark = step.status === 'completed' ? '■' : step.status === 'in_progress' ? '▪' : '□'
        check(shot.includes(`${mark} ${step.text}`), `清单第 ${at + 1} 步在屏上（${mark}）`)
      }
      check(!shot.includes('plan_update'), '辅助工具的成功调用不刷工具卡（真装配这一趟也是）')

      // **工具真的落账**：记录里有那一条带 `plan` 的结果；它与屏上那一份**一致**
      const stored = planEntriesOf(sandbox)
      check(stored.length === 1, '记录里有一条带计划的工具结果', `实得 ${stored.length} 条`)
      check(
        stepTextsOf(stored[0] ?? null).join('｜') === stepTextsOf(PLAN_FIRST).join('｜'),
        '清单与持久记录一致（两步文字逐条相同）',
      )

      // 收起 / 展开：**零模型请求**，草稿仍在
      const before = fixture.requests().length
      await first.write('半句草稿')
      await first.waitFor('半句草稿')
      await first.key(CTRL_T)
      await first.waitFor('计划已收起')
      check(first.text().includes('半句草稿'), '收起之后草稿仍在')
      await first.key(CTRL_T)
      await first.waitFor('▪ 改提示文案')
      check(fixture.requests().length === before, '收起 / 展开一个模型请求都没追加', `${before} → ${fixture.requests().length}`)
      keepLive(out, first, 'L1-收起展开后')

      // **真实请求轨迹**：一条交代换来两次往返（调工具 ＋ 回话），工具说明真的送进去了
      const trace = keepTrace(out, fixture, 'L1-请求轨迹')
      check(trace.length === 2, '一条交代 ＝ 两次模型往返（先调工具、再回话）', `实得 ${trace.length}`)
      check((trace[0]?.tools ?? 0) >= 3, '工具说明真的随请求送进去了（至少那三件）', `实得 ${trace[0]?.tools ?? 0}`)
      check(trace[0]?.lastUser.includes('登录失败那条提示太笼统了'), '第一次请求里就是那句交代')
      check(trace[1]?.messages > trace[0]?.messages, '第二次往返带着工具结果（上下文长了）')

      const how = await first.close()
      check(how === 'app', `第一趟自己收的场（${how}）`)
    } finally {
      first.pty.close()
    }

    // —— 二 · 关闭重开（`--session`）：清单该**保留**，改路线、再清空 ——
    const db = readDatabase(join(sandbox.dataDir, 'records.db'))
    sessionId = db.sessions.at(-1)?.id ?? ''
    db.close()
    check(sessionId !== '', '拿到那条会话的 id（重开要它）')

    const second = await liveApp(sandbox, { label: 'L2', argv: [...argv, '--session', sessionId], columns: 100, rows: 30 })
    try {
      await second.waitFor('○ 空闲')
      await second.waitFor('▪ 改提示文案') // 清单从**记录**里回来
      const reopened = keepLive(out, second, 'L2-重开保留')

      check(
        PLAN_FIRST.steps.every((step) => reopened.includes(step.text)),
        '重开之后清单整份回来了（取自记录，不是重发事件）',
      )
      check(fixture.requests().length === 2, '重开那一跳**零模型请求**', `实得 ${fixture.requests().length}`)

      // 改路线：模型真的再调一次 plan_update
      await second.write('网络失败那条也补上')
      await second.waitFor('网络失败那条也补上')
      await second.key('\r')
      await second.waitFor('补一条网络失败的提示')
      await second.waitFor('○ 空闲')
      const edited = keepLive(out, second, 'L3-改路线（真装配）')
      check(edited.includes('■ 读登录提示那三处分支'), '改路线之后已完成项还在')

      const afterEdit = planEntriesOf(sandbox)
      check(afterEdit.length === 2, '第二次更新也落了账', `实得 ${afterEdit.length} 条`)
      check(
        stepTextsOf(afterEdit[1] ?? null).join('｜') === stepTextsOf(PLAN_EDITED).join('｜'),
        '记录里那一份就是屏上这一份（改路线之后）',
      )

      // 清空：模型真的调 `plan_update {plan: null}`
      await second.write('就这样，收工')
      await second.waitFor('就这样，收工')
      await second.key('\r')
      await second.waitFor('○ 空闲')
      await Bun.sleep(300)
      const cleared = keepLive(out, second, 'L4-清空（真装配）')
      check(!cleared.includes('□ 跑一遍失败的几条路'), '清空之后清单退出界面')

      const afterClear = planEntriesOf(sandbox)
      check(afterClear.length === 3 && afterClear[2] === null, '清空也落了账（那一条的 `plan` 是 null）')
      check(
        stepTextsOf(afterClear[0] ?? null).join('｜') === stepTextsOf(PLAN_FIRST).join('｜') &&
          stepTextsOf(afterClear[1] ?? null).join('｜') === stepTextsOf(PLAN_EDITED).join('｜'),
        '先前那两条**没被改写**（历史是追加的）',
      )

      const trace2 = keepTrace(out, fixture, 'L2-请求轨迹')
      check(trace2.length === 6, '整趟（建立 · 改路线 · 清空）＝ 六次往返', `实得 ${trace2.length}`)

      const how = await second.close()
      check(how === 'app', `第二趟自己收的场（${how}）`)
    } finally {
      second.pty.close()
    }

    // —— 三 · 再关闭重开：清空过了 ⇒ 清单**不复活**，记录仍在 ——
    const third = await liveApp(sandbox, { label: 'L3', argv: [...argv, '--session', sessionId], columns: 100, rows: 30 })
    try {
      await third.waitFor('○ 空闲')
      await Bun.sleep(500)
      const again = keepLive(out, third, 'L5-重开不复活（真装配）')
      check(!again.includes('□ ') && !again.includes('▪ '), '清空之后重开：旧清单一个方块都不剩')
      check(again.includes('这件事到这儿。'), '记录还在（过程沿既有记录留作排障）')

      const how = await third.close()
      check(how === 'app', `第三趟自己收的场（${how}）`)
    } finally {
      third.pty.close()
    }
  } finally {
    await fixture.stop()
    sandbox.dispose()
  }
}

if (import.meta.main) await main()
