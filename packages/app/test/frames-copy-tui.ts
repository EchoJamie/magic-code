#!/usr/bin/env bun
/**
 * D28甲 · D29 · **真 PTY 留帧**（单元 `mc-copy`）——会话回执与审批接管去重。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真终端才说得清的那几件**：
 * 屏上长什么样（布局 · 文案 · 层级 · 通读），以及**审批卡那一屏到底少没少一行**。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 loopback 夹具（合成假 key），
 * 真 `~/.magic` 零触碰（沙地见 `ui/sandbox.ts`）。
 *
 * ## 两组共 10 屏
 *
 * | 组 | 屏 | 判什么 |
 * | --- | --- | --- |
 * | D28甲 | `01-起手` · `02-首条消息之后` · `03-新建会话之后` · `04-再新建一次（换了会话）` · `05-切回旧会话` | 新建会话**不印回执**；首条消息前**不建空会话**、首条消息**正常建**；切换与失败回执**不受影响** |
 * | D29 | `06-轻审批接管` · `07-连续裁决（草稿已收）` · `08-草稿归还` · `09-重审批接管` · `10-窄启动审批` | 接管态**不显示输入提示行**；卡的材料 / 键位 / 状态行仍在；草稿与插入点**答完归还**、**不自动发送** |
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-copy-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { DATABASE_FILE } from '@magic/records'
import { HINT_IDLE } from '@magic/tui'
import { createUiSession } from './ui/index.ts'
import type { Capture, UiSession } from './ui/index.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 这一趟的产物根——`keep()` 要用（入口解析 `--out` 之后填）。 */
let out = ''

/**
 * `--collect`：**只用于复现「修前」现场**（判据照常逐条打印、但不停下来，一趟收齐所有坏现场）。
 * **验收一律不加它**——默认一栽就当场抛。
 */
let collect = false

/** 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  if (collect) {
    console.log(`  ✗ ${what}${detail === '' ? '' : `：${detail}`}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/** 留一屏——文本写进 `<out>/<序号>-<名字>.txt`，字格与光标写进同名 `.json`。 */
function keep(shot: Capture): void {
  const path = join(out, `${shot.label}.txt`)

  writeFileSync(path, `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${shot.label}.json`),
    `${JSON.stringify(
      {
        columns: shot.columns,
        rows: shot.rows,
        cursor: shot.cursor,
        scrollback: shot.scrollback,
        lines: shot.lines,
        files: shot.files,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${shot.label} ──\n${shot.text}`)
}

/** 打一行字并**等它真出现在屏上**（文本与回车分两次写——挤在同一次写里按键会丢）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/**
 * 等屏上的某个**条件**成立（`wait` 的闭集装不下「数一数」这类判据，故自己轮询 `screen()`）。
 *
 * 超时**如实失败**（带上此刻的整屏）——不重发、不重试、不拿固定 sleep 当同步。
 *
 * （U43 期间删过一次又回来：原先它守的是「换会话后又多出一份字标」那条等待——那句随裁定
 * 作废；现在守的是「两次 `/session new` 各留过一行回执」，同样是**数一数**才判得出的。）
 */
async function waitUntil(
  session: UiSession,
  what: string,
  ok: (lines: readonly string[]) => boolean,
  timeoutMs = 10_000,
): Promise<readonly string[]> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6

  for (;;) {
    const { lines } = await session.screen()
    const text = lines.map((line) => line.text)

    if (ok(text)) return text
    if (Bun.nanoseconds() > until) throw new Error(`等「${what}」超时（${timeoutMs}ms）。屏：\n${text.join('\n')}`)

    await Bun.sleep(40)
  }
}

/**
 * 等**真光标挪到别处**（`from` 是挪之前那一列）——返回新列。
 *
 * 由头：按键是异步被吃下的，`key()` 返回时**渲染未必已经跟上**（实测：连敲两下左移，
 * 紧接着取帧抓到的还是第一下之后的位置）。这里等光标**真动了**再往下走。
 */
async function waitCursorChange(session: UiSession, from: number): Promise<number> {
  for (let at = 0; at < 100; at += 1) {
    const { cursor } = await session.screen()
    if (cursor.x !== from) return cursor.x

    await Bun.sleep(40)
  }

  throw new Error(`真光标一直停在 x=${from}（等它挪一格）`)
}

/** 屏上 `needle` 出现几次。 */
function countOn(lines: readonly string[], needle: string): number {
  return lines.filter((line) => line.includes(needle)).length
}

/** 字标那一块占几行（块字版的每一行都有 `█`）——用来数「屏上有几份字标」。 */
function bannerRows(lines: readonly string[]): number {
  return lines.filter((line) => line.includes('█')).length
}

/**
 * 记录库里的会话条数——**不看屏**，直读应用自己落的库。
 *
 * 判「首条消息前不建空会话」只能用这个：屏上说没说不等于库里建没建。
 */
function sessionCount(session: UiSession): number {
  const file = join(session.facts().dataDir, DATABASE_FILE)
  const db = new Database(file, { readonly: true })

  try {
    return db.query<{ n: number }, []>('SELECT count(*) AS n FROM sessions').get()?.n ?? -1
  } finally {
    db.close()
  }
}

// ══ D28甲 · 会话回执 ═════════════════════════════════════════════════

async function sessionNew(): Promise<void> {
  const session = await createUiSession({
    label: 'copy-会话新建',
    columns: 100,
    rows: 30,
    // 现场（原始字节 · 步骤 · 退出确认）落在产物目录里——**证据自带一份**，不靠 `.ui-runs`
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '收到。' }],
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
    keep(await session.capture({ label: '01-起手' }))

    check(sessionCount(session) === 0, '空手打开：库里一条会话都没有（D5 基线）', `实际 ${sessionCount(session)} 条`)

    await typeLine(session, '第一件事')
    await session.key('enter', { until: { text: '收到。' }, timeoutMs: 15_000 })
    const first = await session.capture({ label: '02-首条消息之后' })
    keep(first)

    check(
      sessionCount(session) === 1,
      '首条消息按下回车**才**建会话（库里正好一条）',
      `实际 ${sessionCount(session)} 条`,
    )

    // ⚠️ **等这一轮真跑完**（`○ 空闲`）再切：会话忙的时候 `/session new` 会被内核挡回
    // （`fresh()` 的 BUSY 那一支），那一下**不换会话**——拿它当「切过了」就是空转。
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })

    // —— `/session new`：**不再印那行存储回执** ——
    //
    // ⚠️ 为什么敲**两次**：第一次新建时外壳还没收到过 `session.state`（`view.sessionId` 仍是
    // `null`），`reduceSessionState` 认不出「换了会话」⇒ 记录区**照旧不重建**（这是既有实现，
    // 本单不动）。**第二次**才走「切走一条 ⇒ 记录区重建」那一支。
    //
    // ⚠️ **那一下原先靠「屏上多出第二份字标」当可等的观察**——2026-09-24 U43 裁定「换会话不重印
    // 字标」之后，那个观察**没有了**：换会话只清空记录区、不种新字标，而这一条会话又是空的，
    // 于是这一跳**在屏上什么都不印**（回执那半早已由 D28 甲删掉）。故这里改成等「这一下被吃下」
    // （草稿清空）——与上一处同一个信号；紧接着**就这么判**：屏上仍只有一份字标。
    // 严判（整份缓冲、来回切、窄窗）归 `frames-u43-tui.ts`。
    await typeLine(session, '/session new')
    await session.key('enter')
    // 等**这一下被吃下**（草稿被清空）再取帧——「屏上有没有那行回执」要在同一帧上判
    await session.wait({ absent: '/session new' }, { timeoutMs: 10_000 })
    const once = await session.capture({ label: '03-新建会话之后' })
    keep(once)

    check(!once.text.includes('已新建一条会话'), '屏上没有那行会话创建 / 落库回执')
    check(!once.text.includes('落库'), '回执那句存储细节一个字都不在屏上')

    await typeLine(session, '/session new')
    await session.key('enter')
    // 这一跳现在**看得见**了（U43 补条：`· 已开一条新会话`）——等**第二行**到（第一行在 `03` 那一步）
    await waitUntil(
      session,
      '第二次 `/session new` 的回执',
      (lines) => countOn(lines, '· 已开一条新会话') >= 2,
      10_000,
    )
    const twice = await session.capture({ label: '04-再新建一次（换了会话）' })
    keep(twice)

    check(
      bannerRows(twice.history) === 5,
      '换会话之后**仍只有一份字标**（不再重印——U43）',
      `整份缓冲实际 ${bannerRows(twice.history)} 行块字`,
    )
    check(
      countOn(twice.history, '· 已开一条新会话') === 2,
      '两次 `/session new` 各留**一行**回执（只说动作，不说落库时机）',
      `整份缓冲实际 ${countOn(twice.history, '· 已开一条新会话')} 行`,
    )
    check(
      !twice.history.some((line) => line.includes('已新建一条会话')),
      '整份缓冲里都没有那行回执（含滚进 scrollback 的）',
    )
    check(!twice.history.some((line) => line.includes('落库')), '整份缓冲里也没有那句存储细节')
    check(countOn(twice.lines, '新会话') >= 1, '状态行仍是「新会话」那一格（新建这条路没坏）')
    check(
      sessionCount(session) === 1,
      '两次新建之后库里**仍只有一条**会话（空会话不落库——D5 语义未回退）',
      `实际 ${sessionCount(session)} 条`,
    )

    // —— 既有会话的切换回执**不动**：从 `/session` 里切回旧那条 ——
    await typeLine(session, '/session')
    // ⚠️ 等的必须是**抽屉真开了**（那句右位提示），不能等「第一件事」——记录区里本来就有
    //    那四个字（首条消息的回显），拿它当条件**恒真**，第二下回车就会在抽屉开出之前打出去
    //    （实测栽过一次：两下回车挤在一起，哪一下都没选中）。
    await session.key('enter', { until: { text: '↑↓ 选 · 回车 定 · esc 收起' }, timeoutMs: 10_000 })
    await session.key('enter', { until: { text: '已切到' }, timeoutMs: 10_000 })
    const back = await session.capture({ label: '05-切回旧会话' })
    keep(back)

    check(back.text.includes('已切到'), '切换回执照旧在（「现有会话选择和切换结果仍按实际结果反馈」）')
    check(
      back.text.includes('第一件事'),
      '切回的那条按实际结果反馈（标题就在屏上）',
      '原锚＝被切那条的标签',
    )

    await session.key('ctrl+c')
    const report = await session.close({ graceMs: 3_000 })
    check(report.exit.by === 'app', '应用自己走的（收摊确认）', `exit.by=${report.exit.by}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ D29 · 审批接管 ═══════════════════════════════════════════════════

/** 交互区那几行（**分隔线之下、状态行之上**——不含状态行，也不含状态行底下那些空屏行）。 */
function dockRows(shot: Capture): readonly string[] {
  const divider = shot.lines.findIndex((line) => /^─{8,}$/u.test(line.trim()))
  const lastNonBlank = shot.lines.reduce((at, line, row) => (line.trim() === '' ? at : row), -1)

  return shot.lines.slice(divider + 1, lastNonBlank)
}

/** 接管那一屏**逐条对**：卡在、键位在、状态行在，**输入提示行不在**。 */
function checkTakeover(shot: Capture, what: string, keys: string): void {
  check(shot.text.includes(keys), `${what}：卡上仍列出可用键位（${keys}）`)
  check(shot.text.includes('● 等你定夺'), `${what}：状态行仍是「等你定夺」（状态与进度不丢）`)
  check(
    !shot.text.includes('等你的答复'),
    `${what}：**不显示输入提示行**（「等你的答复」整屏一处都没有）`,
  )
  // 输入提示行没了 ⇒ 卡底下不该留一格空占位行：交互区里剩下的空行**只有标题前那一行**
  //（`DecisionCard` 的 `marginTop: 1`）。原锚＝「空行数」；为何变＝接管态不再画输入行；
  // 新锚＝交互区里的空行仍**恰好一行**（账面 `dockHeightOf` 与屏同减一行，见 `app.ts`）。
  const blanks = dockRows(shot).filter((line) => line.trim() === '').length
  check(blanks === 1, `${what}：卡底下只剩标题前那一行留白（不留空占位行）`, `实际 ${blanks} 行空行`)
}

/**
 * 从裁决卡里**干净退场**：先 `n` 拒绝（不执行任何东西），再等空闲、`ctrl+c`。
 *
 * ⚠️ 卡还挂着时 `ctrl+c` 是**中断**（不是退出）——那样收摊只能靠 SIGTERM，
 * `exit.by` 就不是 `app` 了（实测栽过）。
 */
async function quitFromCard(session: UiSession, said: string): Promise<void> {
  // ⚠️ 敲的是 `n` 这个**字符**（PTY 上按键本来就是它）——`key()` 只收功能键，没有 `n`
  await session.send('n')
  // 等**这一轮真走完的那句答复**，而不是 `HINT_IDLE`：拒绝之后那一小段里状态行会先回一次
  // 「空闲」（卡收了、下一趟模型还没回来），拿它当条件会**抓到半路**——那一刻 `ctrl+c`
  // 是**中断**不是退出，收摊就只能靠 SIGTERM（`mcp-approval` 那支的注记过同一跤）。
  await session.wait({ text: said }, { timeoutMs: 20_000 })
  await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
  await Bun.sleep(300)
  await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
  await session.key('ctrl+c')
  const report = await session.close({ graceMs: 3_000 })

  check(report.exit.by === 'app', '应用自己走的（收摊确认）', `exit.by=${report.exit.by}`)
}

async function approvals(): Promise<void> {
  const session = await createUiSession({
    label: 'copy-审批接管',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [
      // ① 轻审批：`sleep 2` 让工具**真跑两秒**——那两秒里输入行是可编辑的，
      //    草稿正好在「第二件裁决接管」之前打好（真场景，不是摆出来的）
      { kind: 'tool', name: 'exec', args: { cmd: 'sleep 2; echo slow-done' } },
      // ② 连续第二件（同一轮里逐件问）
      { kind: 'tool', name: 'exec', args: { cmd: 'echo second' } },
      { kind: 'text', text: '两件都办完了' },
    ],
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })

    // —— ① 轻审批接管 ——
    await typeLine(session, '跑一下')
    await session.key('enter', { until: { text: 'y 批准' }, timeoutMs: 20_000 })
    const light = await session.capture({ label: '06-轻审批接管' })
    keep(light)

    checkTakeover(light, '轻审批', 'y 批准')
    check(light.cursor.hidden, '接管中**真光标藏起来了**（没有可编辑的落点）', JSON.stringify(light.cursor))

    // —— 批准 → 工具真跑两秒：**趁这两秒打草稿**（工作中可打，真场景不是摆出来的） ——
    await session.send('y')
    await session.send('打了一半', { until: { text: '打了一半' }, timeoutMs: 10_000 })
    // **插入点挪到中间**（`打一|半`）——答完要归还的是**这个位置**，不只是那串字。
    // 挪两下、每下都等光标真动了（不然取到的还是上一下之后的位置）
    const atEnd = (await session.screen()).cursor.x
    await session.key('left')
    const once = await waitCursorChange(session, atEnd)
    await session.key('left')
    await waitCursorChange(session, once)
    const midway = await session.capture({ label: '07a-草稿与插入点在中间' })
    keep(midway)

    check(midway.cursor.x < atEnd, '插入点确实挪到了草稿中间', `末尾 x=${atEnd} → 中间 x=${midway.cursor.x}`)

    // —— ② 第二件接管：草稿**收起来**、屏上不闪可编辑草稿 ——
    await session.wait({ text: 'y 批准' }, { timeoutMs: 20_000 })
    const second = await session.capture({ label: '07-连续裁决（草稿已收）' })
    keep(second)

    checkTakeover(second, '连续裁决的第二件', 'y 批准')
    check(!second.text.includes('打了一半'), '连续裁决中**不闪现可编辑草稿**（草稿收起，不在屏上）')

    // —— 答完最后一件：草稿与插入点**归还**、**不自动发送** ——
    await session.send('y')
    await session.wait({ text: '两件都办完了' }, { timeoutMs: 20_000 })
    await session.wait({ text: '› 打了一半' }, { timeoutMs: 10_000 })
    const back = await session.capture({ label: '08-草稿归还' })
    keep(back)

    check(back.text.includes('› 打了一半'), '答完**原样归还**草稿（`› 打了一半` 回到输入行）')
    check(!back.text.includes('等你的答复'), '接管解除——「等你的答复」不再出现')
    check(
      back.cursor.hidden === false && back.cursor.x === midway.cursor.x,
      '**中间插入点**也归还（真光标回到接管前那一列——`打|了一半` 的第 2 个字素后）',
      `接管前 x=${midway.cursor.x}，答完 x=${back.cursor.x}（隐藏=${back.cursor.hidden}）`,
    )
    check(
      countOn(back.history, '› 打了一半') === 1,
      '草稿**没有**被自动发送（记录区里没有第二条 `› 打了一半`）',
      `整份缓冲实际 ${countOn(back.history, '› 打了一半')} 条`,
    )
    check(
      session.requests().every((request) => !request.lastUser.includes('打了一半')),
      '夹具也证明没发出去（没有一条请求带着那半句草稿）',
      session.requests().map((request) => request.lastUser).join(' | '),
    )

    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })
    await session.key('ctrl+c')
    const report = await session.close({ graceMs: 3_000 })
    check(report.exit.by === 'app', '应用自己走的（收摊确认）', `exit.by=${report.exit.by}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

/** 重审批（`write`＝必闸类）＋ 窄启动各一屏。 */
async function heavyAndNarrow(): Promise<void> {
  const session = await createUiSession({
    label: 'copy-重审批',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [
      { kind: 'tool', name: 'write', args: { path: 'note.txt', content: '第二版' } },
      { kind: 'text', text: '写完了' },
    ],
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
    writeFileSync(join(session.facts().workspace, 'note.txt'), '第一版\n', 'utf8')

    await typeLine(session, '覆盖那份 note')
    await session.key('enter', { until: { text: 'y 批准' }, timeoutMs: 20_000 })
    const heavy = await session.capture({ label: '09-重审批接管' })
    keep(heavy)

    checkTakeover(heavy, '重审批', 'y 批准')
    check(heavy.text.includes('不可逆'), '重审批仍是重口径（红线的副题不丢）')

    await quitFromCard(session, '写完了')
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

/** **直接以窄尺寸启动**（不是改窗）——接管态在窄窗上还成不成行。 */
async function narrowBoot(): Promise<void> {
  const session = await createUiSession({
    label: 'copy-窄启动审批',
    columns: 44,
    rows: 24,
    artifacts: join(out, 'runs'),
    turns: [
      { kind: 'tool', name: 'write', args: { path: 'note.txt', content: '窄窗下的第二版' } },
      { kind: 'text', text: '写完了' },
    ],
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })

    await typeLine(session, '覆盖写')
    await session.key('enter', { until: { text: 'y 批准' }, timeoutMs: 20_000 })
    const narrow = await session.capture({ label: '10-窄启动审批' })
    keep(narrow)

    checkTakeover(narrow, '窄启动审批', 'y 批准')
    check(narrow.columns === 44 && narrow.rows === 24, 'VT 认了启动尺寸（直接以窄尺寸起，不是改窗）')
    check(
      narrow.lines.every((line) => [...line].length <= 44),
      '窄窗上没有一行超出宽度',
      `最长一行 ${Math.max(...narrow.lines.map((line) => [...line].length))} 列`,
    )

    await quitFromCard(session, '写完了')
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-copy-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root
  collect = process.argv.includes('--collect')

  // `--only d28` / `--only d29`：只跑一组（复现与逐组复验时用；不给＝全跑）
  const onlyAt = process.argv.indexOf('--only')
  const only = onlyAt === -1 ? '' : (process.argv[onlyAt + 1] ?? '')

  try {
    if (only === '' || only === 'd28') await sessionNew()
    if (only === '' || only === 'd29') {
      await approvals()
      await heavyAndNarrow()
      await narrowBoot()
    }
    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    if (at === -1) removeDir(root)
  }
}
