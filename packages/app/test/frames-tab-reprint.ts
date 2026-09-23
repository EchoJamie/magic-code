/**
 * **Tab 多行重印**的留帧装置（2026-09-22 · [[交接/工单/Tab多行重印]]）——真 PTY，固定窗口。
 *
 * 判据（工单「交付判据 1」）：**单次提交之后等到空闲，用户每一条原始逻辑行在整块缓冲
 * （可见区 ＋ scrollback）里只出现一次**——不能只判请求数或「某句还在」。为做到这一点，
 * 装置把应用写出的**全部字节**喂给 VT 模型，读回含 scrollback 的整块缓冲（`screen.history`），
 * 逐行与「原始逻辑行（空白折叠后）」比对。
 *
 * 另外三档（判据 2）：**无 Tab 多行**与**单行**作对照；**46×30** 窄窗同段再来一遍。
 * 每档都核对：模型请求**恰好 1 条**、用户记录**恰好 1 条**、载荷**逐字**（Tab 仍是 Tab——
 * 屏上展开成空白是**显示**，不是原文）。
 *
 * **首行带 Tab**（独立复核退回①）与**组合字素 ＋ Tab**（退回②）是本节补的反例：前者把 Tab
 * 放在**第一条逻辑行**上（原四档都只在续行），后者按整段字素量宽（`👩‍💻` 是**一个字素、三个
 * 码点**）。折行那一档的逻辑行跨物理行 ⇒ 判据换成「首段只占一条物理行 ＋ 尾段只此一份」。
 *
 * **样式分段不改变 Tab 间距**（独立复核 `b25b9ff`）：答复里同一段可见文字写成两行（一行普通、
 * 一行加粗），屏上这两行去掉行首标记后必须**逐字相同**——段是色界、不是行界，列要接着上一段累加。
 *
 * 另有插入点一档：草稿里带 Tab 时，真光标必须落在**终端把它画出来的那一格**
 * （展开后的列号），不是按「Tab 算 0／1 列」算出来的那一格。
 *
 * ```
 * bun packages/app/test/frames-tab-reprint.ts --out <目录> [--only <档名>]
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUiSession } from './ui/index.ts'
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

/** 空白折叠（Tab、连续空格都算一个空格）——**屏上的样子**与**原文**用同一把尺子比。 */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

async function open(label: string, out: string, columns?: number, reply = '收到。'): Promise<UiSession> {
  return createUiSession({
    label,
    artifacts: join(out, 'runs'),
    ...(columns === undefined ? {} : { columns }),
    turns: [{ kind: 'text', text: reply }],
  })
}

const closed = new WeakSet<UiSession>()

async function close(session: UiSession): Promise<void> {
  if (closed.has(session)) return
  closed.add(session)

  await session.wait({ text: '○ 空闲' }, { timeoutMs: 10_000 }).catch(() => undefined)
  // 空闲**按两次**才走（U46）——`quit()` 就是那一套
  await session.quit()
  const report = await session.close({ graceMs: 3_000 })
  const how = `${report.exit.by}（code ${report.exit.code ?? '-'} / signal ${report.exit.signal ?? '-'}）`

  if (report.exit.by !== 'app') throw new Error(`应用不是自己走的（${how}）——收摊那条路没走完`)

  console.log(`  · 收摊：${how} · 帧 ${report.frames} 张 · 现场 ${report.runDir}`)
}

// ══ 一档：粘贴 → 提交 → 等空闲 → 逐行只出现一次 ═════════════════════════

/**
 * **这一帧里**草稿末行的样子：行号、文本、以及**终端把它画到了第几格**（`cellsOf` 的格子数，
 * 宽字符占两格——比码元数可靠：`👩‍💻` 是 5 个码元、终端画 2 格）。
 *
 * ⚠️ **取帧之后当场调**：`cellsOf` 是**活视图**（闭包里走的是当前缓冲），这一刻之后应用还会
 * 画很多帧，事后再调读到的是**别的行**（真栽过：交完卷再量，14 格的那一行读成 7 格）。
 * 行文本也是「状态行上面那一行」——这一档没有候选/抽屉，交互区就是输入行 ＋ 状态行。
 */
function draftRowOf(shot: Capture): { readonly at: number; readonly text: string; readonly width: number } {
  const statusAt = shot.lines.findIndex((line) => /[○●▲]/.test(line) && line.includes('·'))
  const at = statusAt - 1

  return { at, text: shot.lines[at] ?? '', width: shot.cellsOf(at).length }
}

/**
 * 等真光标**真的挪了一格**（从 `from` 走到别处）。
 *
 * 由头（同 `frames-copy-tui.ts` 的 `waitCursorChange`）：两下方向键**连着写**会合成一个数据块，
 * 而 Ink 一次只解一个键（`parseKeypress(整块)` 只认头一个序列）⇒ 第二下白按。每下都等它落定，
 * 取帧也就不会取到「上一下之后」的位置。
 */
async function waitCursorMove(session: UiSession, from: number): Promise<void> {
  for (let at = 0; at < 100; at += 1) {
    if ((await session.screen()).cursor.x !== from) return

    await Bun.sleep(40)
  }

  throw new Error(`真光标一直停在 x=${from}（等它挪一格）`)
}

/** 每条原始逻辑行在整块缓冲里**只出现一次**（判据 1 的正文面）。 */
function checkOnce(lines: readonly string[], text: string): void {
  for (const raw of text.split('\n')) {
    const want = flatten(raw)
    const times = lines.filter((line) => line === want || line.endsWith(` ${want}`)).length
    check(times === 1, `「${want}」在整块缓冲里只出现一次（实测 ${times} 次）`, lines.join(' / '))
  }
}

async function scenario(options: {
  readonly out: string
  readonly label: string
  readonly text: string
  readonly columns?: number
  /** 这一档是不是**含 Tab**（含 Tab 的档是修前会重印的那一档） */
  readonly tabs: boolean
  /**
   * 正文**首行会折**的一档（工单判据 2 的折行档）：逻辑行跨物理行 ⇒ **没有一条物理行**等于
   * 整条逻辑行，`checkOnce` 那一条判不了，改用两条账：**首段只占一条物理行**（重印会占很多条）
   * ＋ **尾段那个字符在正文段里只该有这么多**（重印会翻成好几倍——整块缓冲含 scrollback，
   * 多留的那几份都算得进来；只数状态行以上，见那一条的注）。
   */
  readonly folded?: {
    readonly head: string
    readonly mark: { readonly char: string; readonly times: number }
  }
  /**
   * 提交之前再把插入点**往左挪几格**（组合字素那一档的「中间插入点」）——`x` 是按终端把它
   * 画出来的那一列算的（含左留白），由调用处给死并写明算式。
   *
   * ⚠️ 挪的是**方向键**，每下都要等光标落定（见 `waitCursorMove`）——数量对不上会静悄悄
   * 停在上一下的位置上。
   */
  readonly caretSteps?: { readonly steps: number; readonly x: number }
  /** 夹具这一轮的答复（缺省「收到。」）——「样式不动制表位」那一档要一段带标记的正文。 */
  readonly reply?: string
  /**
   * **同一段可见文字、只换了样式**的那几行（独立复核 `b25b9ff`）：答复里含 `needle` 的显示行
   * 应当有 `count` 条，且**去掉行首那两格标记后逐字相同**——加粗/行内代码只该换粗细，不该动
   * 制表位（修前：加粗那一行的 Tab 从第 1 列起算，屏上比普通行多两格）。
   */
  readonly alike?: {
    readonly needle: string
    readonly count: number
    /** 去掉行首标记后那几行**该长什么样**（由调用处按终端列算给死；缺省只比彼此相同）。 */
    readonly shown?: string
  }
}): Promise<void> {
  const session = await open(options.label, options.out, options.columns, options.reply)
  const size = options.columns === undefined ? '100×30' : `${options.columns}×30`
  /** 答复到了没有——取它的**头一段**当针（渲染会把 Tab 展开、样式标记也会去掉，原句对不上屏）。 */
  const landed = (options.reply ?? '收到。').split(/\s+/)[0] ?? '收到。'

  try {
    console.log(`\n══ ${options.label}（${size}）══`)
    const needle = options.text.split('\n').at(-1) ?? options.text

    // —— 粘贴（bracketed paste：真终端那条信道）——
    await session.send(`\u001b[200~${options.text}\u001b[201~`, { until: { text: flatten(needle).split(' ')[0] ?? needle }, timeoutMs: 10_000 })
    const before = await session.capture({ label: `${options.label}-01-粘贴之后（未发）` })
    // 草稿末行要到**这一刻**量（见 `draftRowOf` 的注）——插在取帧与 `keep` 之间，中间不 await
    const draftBefore = draftRowOf(before)
    keep(options.out, before, `${options.label}-01-粘贴之后（未发）`)

    check(session.requests().length === 0, '**粘贴不发送**（夹具 0 条请求）')

    // —— 插入点**中间**那一档：把光标往左挪几格再取一帧（组合字素＋Tab）——
    if (options.caretSteps !== undefined) {
      for (let at = 0; at < options.caretSteps.steps; at += 1) {
        const from = (await session.screen()).cursor.x
        await session.key('left')
        await waitCursorMove(session, from)
      }
      const mid = await session.capture({ label: `${options.label}-01b-插入点左移之后` })
      keep(options.out, mid, `${options.label}-01b-插入点左移之后`)
      check(
        mid.cursor.x === options.caretSteps.x,
        `插入点左移 ${options.caretSteps.steps} 格后落在第 ${options.caretSteps.x} 列（实测 ${mid.cursor.x}）`,
        JSON.stringify(mid.lines.filter((line) => line !== '')),
      )
    }

    // —— 提交：按一次回车 ——
    await session.key('enter')
    // 「提交到收束」的那几帧：**这一轮在跑**（活动区里那句正文正是修前会一份份堆起来的地方）
    const working = await session.wait({ text: '● 工作' }, { timeoutMs: 10_000 }).then(
      () => true,
      () => false,
    )
    const sent = await session.capture({ label: `${options.label}-02-提交之后（这一轮在跑）` })
    keep(options.out, sent, `${options.label}-02-提交之后（这一轮在跑）`)
    check(working, '回车之后进入工作中（这一轮真跑起来了）')

    // ⚠️ **先等这一轮的答复**（`收到。`）再等空闲——只等 `○ 空闲` 会在「按下回车、工作帧还没画」
    //    那一瞬**匹配上上一帧的空闲行**（真跑栽过：紧接着发的 ctrl+c 于是成了「中断」而不是
    //    「退出」，收摊那条判据当场判不出来）
    await session.wait({ text: landed }, { timeoutMs: 15_000 })
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 15_000 })
    const idle = await session.capture({ label: `${options.label}-03-空闲` })
    keep(options.out, idle, `${options.label}-03-空闲`)

    // —— 整块缓冲（可见区 ＋ scrollback）：每条原始逻辑行**只出现一次** ——
    const screen = await session.screen()
    const lines = screen.history.map(flatten).filter((line) => line !== '')
    if (options.folded === undefined) {
      checkOnce(lines, options.text)
    } else {
      // 折行那一档：首行折成了几条 ⇒ 分开判（见 `folded` 的注），其余逻辑行照旧
      const folded = options.folded
      const head = lines.filter((line) => line.includes(folded.head))
      check(head.length === 1, `首段「${folded.head}」只占一条物理行（实测 ${head.length} 条）`, head.join(' / '))
      // ⚠️ **只数正文那一段**（状态行以上）：状态行里有供应商名（`MiniMax-M3` 带一个 `x`），
      //    全屏数会多出一两个——那与「正文留了几份」无关
      const statusAt = lines.findIndex((line) => /[○●▲]/.test(line) && line.includes('·'))
      const body = statusAt === -1 ? lines : lines.slice(0, statusAt)
      const marks = body.join('').split(folded.mark.char).length - 1
      check(
        marks === folded.mark.times,
        `尾段那 ${folded.mark.times} 个「${folded.mark.char}」在屏上只有这么多（实测 ${marks}）`,
        lines.slice(0, 4).join(' / '),
      )
      checkOnce(lines, options.text.split('\n').slice(1).join('\n'))
    }

    // —— **样式不动制表位**（独立复核 `b25b9ff`）：同一段可见文字，加粗/行内代码那几行要一样 ——
    if (options.alike !== undefined) {
      // 去掉行首那两格标记（`⏺ ` / 悬挂缩进 `  `）再比：那两格是**行首标记**，不是正文
      const hit = idle.lines.filter((line) => line.includes(options.alike?.needle ?? '')).map((line) => line.slice(2))
      check(hit.length === options.alike.count, `答复里含「${options.alike.needle}」的显示行有 ${options.alike.count} 条（实测 ${hit.length}）`, JSON.stringify(idle.lines))
      check(
        hit.every((line) => line === hit[0]),
        '那几行**去掉行首标记后逐字相同**（加粗不改变 Tab 间距）',
        JSON.stringify(hit),
      )
      check(
        options.alike.shown === undefined || hit.every((line) => line === options.alike?.shown),
        `那几行画出来是 ${JSON.stringify(options.alike.shown)}（实测 ${JSON.stringify(hit)}）`,
        JSON.stringify(hit),
      )
      check(hit.every((line) => !line.includes('\t')), '显示行里没有裸 Tab', JSON.stringify(hit))
    }

    // —— 请求与记录：恰好一条、逐字 ——
    check(session.requests().length === 1, `模型请求恰好 1 条（实测 ${session.requests().length}）`)
    const carried = session.requests()[0]?.lastUser ?? ''
    check(carried.includes(options.text), '模型请求里那一段**逐字**在（Tab 与换行都在）', JSON.stringify(carried))

    const raw = readDatabase(join(session.facts().dataDir, 'records.db'))
    const user = raw.entries.filter((row) => row.kind === 'user')
    raw.close()
    check(user.length === 1, `用户记录恰好 1 条（实测 ${user.length}）`)
    check(user[0]?.content_text === options.text, '记录里**逐字**相同（Tab 仍是 Tab）', JSON.stringify(user[0]?.content_text))
    check(options.tabs === (user[0]?.content_text ?? '').includes('\t'), '含 Tab 与用例一致')

    // —— 插入点：真光标落在草稿末行的**行尾**（按终端把它画出来的列算）——
    // ⚠️ 放在最后核（对着**粘贴后那一帧**）：判据次序照工单（先「只出现一次」，再插入点）。
    // 格数是取帧那一刻量下的（`draftBefore`，见 `draftRowOf` 的注）
    check(
      before.cursor.x === draftBefore.width && before.cursor.y === draftBefore.at,
      `插入点在草稿末行末尾（实测 (${before.cursor.x},${before.cursor.y}) · 应为 (${draftBefore.width},${draftBefore.at})` +
        ` · 那一行 ${JSON.stringify(draftBefore.text)}）`,
      JSON.stringify(before.lines.slice(draftBefore.at - 2, draftBefore.at + 2)),
    )
  } finally {
    await close(session)
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

/**
 * **组合字素**：`👩‍💻`（ZWJ 串，一个字素三个码点）——按码点拼出来，源码里因此不带看不见的
 * 控制字符（ZWJ 是 `U+200D`，肉眼与编辑器都看不出来）。
 */
const COMBINED = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb)

/** 一档的全部参数——`out` 由入口统一补（见下）。 */
type ScenarioOptions = Omit<Parameters<typeof scenario>[0], 'out'>

if (import.meta.main) {
  const of = (flag: string): string | undefined => {
    const at = process.argv.indexOf(flag)

    return at === -1 ? undefined : process.argv[at + 1]
  }
  const out = of('--out') ?? tempDir('magic-frames-tab-')
  mkdirSync(out, { recursive: true })

  // 工单那一档：含 Tab 的多行代码（行首 Tab ＋ 行内 Tab ＋ 多行）
  const code = 'if ready:\n\tprint(1)\nleft\tright'

  const scenarios: readonly ScenarioOptions[] = [
    { label: 'tab-100x30', text: code, tabs: true },
    { label: 'tab-46x30', text: code, columns: 46, tabs: true },
    // 对照：无 Tab 多行 · 单行
    { label: 'plain-multiline', text: 'if ready:\n  print(1)\nleft right', tabs: false },
    { label: 'single-line', text: 'if ready:', tabs: false },

    // —— 独立复核退回①：**首行**带 Tab（原四档的 Tab 都在续行上）——
    { label: 'first-line-single', text: 'left\tright', tabs: true },
    { label: 'first-line-multiline', text: 'left\tright\nnext', tabs: true },
    { label: 'first-line-multiline-46', text: 'left\tright\nnext', columns: 46, tabs: true },
    // 折行：首行折成两条 ⇒ 按「首段一条物理行 ＋ 尾段只此一份」判（见 `folded` 的注）。
    // ⚠️ 第二行与状态行**都不带 `x`**：尾段那个字符是**数出来的**，正文之外混进一个就多算一个
    //（`next` 里有一个、`MiniMax-M3` 里也有一个——两处都栽过）
    {
      label: 'first-line-wrap',
      text: `left\tright ${'x'.repeat(120)}\ntail`,
      tabs: true,
      folded: { head: 'left right', mark: { char: 'x', times: 120 } },
    },

    // —— 独立复核退回②：组合字素（ZWJ 串）＋ Tab，行尾与**中间**插入点 ——
    // 草稿 `👩‍💻⇥XY`：`› ` 2 ＋ emoji 2 ⇒ 第 4 列打 Tab ⇒ 到第 8 列（4 格空白）
    // 行尾：`X` 与 `Y` 之后 ⇒ 内容第 10 列，加上左留白 1 格 ⇒ 第 11 列
    // 中间：左移两格（越过 `Y` 与 `X`）⇒ 落在**那 4 格空白之后**（内容第 8 列）⇒ 第 9 列
    //       ——正是逐码点量（emoji 算 4 列 ⇒ Tab 只剩 2 格）时插入点会偏出去的那一格
    { label: 'combined-emoji-tab', text: `${COMBINED}\tXY`, tabs: true, caretSteps: { steps: 2, x: 9 } },

    // —— 样式分段不改变 Tab 间距（独立复核 `b25b9ff`）——
    // 答复两行是**同一段可见文字**（第二行只是加粗）：屏上两行去掉行首标记后必须**逐字相同**，
    // 且都等于 `alpha omega`（`⏺ `/悬挂缩进 2 格 ＋ `alpha` 5 列 ＝ 7 列 ⇒ Tab 到第 8 列 ⇒ 1 格）
    {
      label: 'styled-segments',
      text: 'left\tright',
      tabs: true,
      reply: 'alpha\tomega\n**alpha**\tomega',
      alike: { needle: 'alpha', count: 2, shown: 'alpha omega' },
    },
  ]

  // `--only <档名>`：单跑一档（留帧装置出问题时定位用；也用来在**修前**的源码上单取某一档的
  // 失败现场——那一趟前面几档必挂，跑不到后面）
  const only = of('--only')
  const picked = only === undefined ? scenarios : scenarios.filter((one) => one.label === only)
  if (picked.length === 0) throw new Error(`没有叫做「${String(only)}」的那一档`)

  for (const one of picked) await scenario({ out, ...one })

  console.log(`\n全部判据通过。帧落在 ${out}`)
}
