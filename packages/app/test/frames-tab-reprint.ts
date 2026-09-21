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
 * 另有插入点一档：草稿里带 Tab 时，真光标必须落在**终端把它画出来的那一格**
 * （展开后的列号），不是按「Tab 算 0／1 列」算出来的那一格。
 *
 * ```
 * bun packages/app/test/frames-tab-reprint.ts --out <目录>
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

async function open(label: string, out: string, columns?: number): Promise<UiSession> {
  return createUiSession({
    label,
    artifacts: join(out, 'runs'),
    ...(columns === undefined ? {} : { columns }),
    turns: [{ kind: 'text', text: '收到。' }],
  })
}

const closed = new WeakSet<UiSession>()

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

// ══ 一档：粘贴 → 提交 → 等空闲 → 逐行只出现一次 ═════════════════════════

async function scenario(options: {
  readonly out: string
  readonly label: string
  readonly text: string
  readonly columns?: number
  /** 这一档是不是**含 Tab**（含 Tab 的档是修前会重印的那一档） */
  readonly tabs: boolean
}): Promise<void> {
  const session = await open(options.label, options.out, options.columns)
  const size = options.columns === undefined ? '100×30' : `${options.columns}×30`

  try {
    console.log(`\n══ ${options.label}（${size}）══`)
    const needle = options.text.split('\n').at(-1) ?? options.text

    // —— 粘贴（bracketed paste：真终端那条信道）——
    await session.send(`\u001b[200~${options.text}\u001b[201~`, { until: { text: flatten(needle).split(' ')[0] ?? needle }, timeoutMs: 10_000 })
    const before = await session.capture({ label: `${options.label}-01-粘贴之后（未发）` })
    keep(options.out, before, `${options.label}-01-粘贴之后（未发）`)

    check(session.requests().length === 0, '**粘贴不发送**（夹具 0 条请求）')

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
    await session.wait({ text: '收到。' }, { timeoutMs: 15_000 })
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 15_000 })
    const idle = await session.capture({ label: `${options.label}-03-空闲` })
    keep(options.out, idle, `${options.label}-03-空闲`)

    // —— 整块缓冲（可见区 ＋ scrollback）：每条原始逻辑行**只出现一次** ——
    const screen = await session.screen()
    const lines = screen.history.map(flatten).filter((line) => line !== '')
    for (const raw of options.text.split('\n')) {
      const want = flatten(raw)
      const times = lines.filter((line) => line === want || line.endsWith(` ${want}`)).length
      check(times === 1, `「${want}」在整块缓冲里只出现一次（实测 ${times} 次）`, lines.join(' / '))
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
    // 草稿末行 ＝ 状态行上面那一行（这一档没有候选/抽屉，交互区就是输入行 ＋ 状态行）。
    // ⚠️ 放在最后核（对着**粘贴后那一帧**）：判据次序照工单（先「只出现一次」，再插入点）
    const statusAt = before.lines.findIndex((line) => /[○●▲]/.test(line) && line.includes('·'))
    const lastDraftAt = statusAt - 1
    const lastDraft = before.lines[lastDraftAt] ?? ''
    check(
      before.cursor.x === lastDraft.length && before.cursor.y === lastDraftAt,
      `插入点在草稿末行末尾（实测 (${before.cursor.x},${before.cursor.y}) · 应为 (${lastDraft.length},${lastDraftAt})）`,
      JSON.stringify(before.lines.slice(lastDraftAt - 2, statusAt + 1)),
    )
  } finally {
    await close(session)
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const out = at === -1 ? tempDir('magic-frames-tab-') : (process.argv[at + 1] as string)
  mkdirSync(out, { recursive: true })

  // 工单那一档：含 Tab 的多行代码（行首 Tab ＋ 行内 Tab ＋ 多行）
  const code = 'if ready:\n\tprint(1)\nleft\tright'

  await scenario({ out, label: 'tab-100x30', text: code, tabs: true })
  await scenario({ out, label: 'tab-46x30', text: code, columns: 46, tabs: true })
  // 对照：无 Tab 多行 · 单行
  await scenario({ out, label: 'plain-multiline', text: 'if ready:\n  print(1)\nleft right', tabs: false })
  await scenario({ out, label: 'single-line', text: 'if ready:', tabs: false })

  console.log(`\n全部判据通过。帧落在 ${out}`)
}
