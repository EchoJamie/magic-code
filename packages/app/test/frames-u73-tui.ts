#!/usr/bin/env bun
/**
 * U73 立 · **U76 改定** · **全放行：只在起会话那一刻给**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。
 *
 * ⚠️ **本装置 U76 大改过一次**（2026-09-25 用户定）：U73 那一版落的是
 * 「**放轻的、必闸照样挡**」，而用户随后**改定**为「**连必闸也放——真的什么都不问**」
 * （由头：默认已经是「通」，只剩那张例外表要问；若全放行也不放它，**这一档就是个空开关**）。
 * 同时「**默认问**」翻成了「**默认通**」（判轻的不必配规则）。
 *
 * ⇒ **装置本身留着**（它的四条护栏一个字没变），但**两处锚换了**：
 *
 * - 「判轻的会弹卡」→ **判轻的不弹卡**（故凡要一张卡的地方，夹的都是**名单里那一条**）；
 * - 「全放行时必闸照样弹」→ **全放行时连它也不弹**（④ 整条反过来）。
 *
 * ## 判的是哪一件事
 *
 * 设计（本单权威 · `设计/工具执行与权限`·「全放行：**只在起会话那一刻给**」）四条：
 *
 * 1. **只能起会话时给**（命令行带参数）——**对话期间不许切进全放行**；
 * 2. **但「退出去、用全放行 resume 回来」要成立**（照接续那条既有路，别新造一条）；
 * 3. ⚠️ **它连必闸也放**（U76 改定：删除 · 改权限/属主/属性/ACL 两类名单）；
 * 4. ⚠️ **必须在屏上看得见**（状态行报着——「看不见的裸奔是最坏的一形」）。
 *
 * ## 八张帧（工单那六条 ＋ 一形对照）
 *
 * | 张 | 工单那一格 | 该在屏上看见什么 |
 * | --- | --- | --- |
 * | ① | **不带参数起** | 名单里那一条照问：`│ exec · 不可逆` 那张卡**照出**；判轻的不弹卡 |
 * | ①b | 名单上按 `a`（U73 那条搬这儿） | 「**必闸类不可「总是允许」**」——默认档下同样成立 |
 * | ② | **带参数起** | `✓ Nms · …` 直接跑完——**一张卡都没有** |
 * | ③ | 状态行那一格（宽窗 100） | `○ 空闲 · 全放行 · …`（那一格**永不省**） |
 * | ④ | **全放行：连名单那两条也放** | 同一个 `rm`，带参数时**也不弹卡**（工具真跑） |
 * | ⑥ | **反证 · 对话期间切不进去** | 参照面那个 `shift+tab` **按下去什么也没发生**；slash 面上**没有那一格** |
 * | ⑦ | 状态行那一格（窄窗 46） | `○ 空闲 · 全放行 · …`——四格次序不乱、降级照旧 |
 *
 * 外加一程两趟（⑧⑨）：**退出后用全放行 resume 回来** ⇒ 接上了、状态行照报、
 * 常规调用不问；**同一趟不带参数 resume** ⇒ 名单里那一条**回去照旧问**。
 *
 * ## 每条判据怎么咬
 *
 * - **屏上的字**：`session.wait({ text })` —— 条件是**行内包含**（与驱动同一条尺子）。
 * - **状态行那一格**：`statusLineOf`（`ui/anchors.ts`）——取**输入行与状态行之间那条分隔线
 *   之下**那一行，不是「全屏找那几个字」。⚠️ 这一条是要害：全屏找「全放行」在
 *   **记录区的材料里**也成立（裁决卡上就写着它），量到的就成了「这一屏上有没有这三个字」。
 * - **反证那一条**（第 ⑥ 张）**直接按那个键**：`shift+tab` 的字节（`\u001b[Z`）**写进真 PTY**，
 *   屏上一个字都不许变。**slash 面**那一半比的是**候选表本身**（与 `COMMANDS` 逐名相等）
 *   ——「表上没有那一格」不能只写在注释里。
 * - **不问**的判据是**卡没出**（整屏没有裁决卡：`· 不可逆` 那一行不在）＋
 *   **工具真跑了**（`✓` 那一行在）——两条一起才说明「放行」而不是「卡住了」。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u73-tui.ts --out <目录>
 * ```
 *
 * ⚠️ **这一趟不留任何权限规则**（`Sandbox` 的缺省配置里 `permissions.rules` 一条不给）：
 * 要验的正是「**不配规则**时全放行管不管用」——配了规则就把两条来路搅在一起了。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALLOW_ALL_LABEL, COMMANDS } from '@magic/tui'
import { readDatabase } from './support.ts'
import { createSandbox, createUiSession, startFixture, statusLineOf } from './ui/index.ts'
import type { Capture, FixtureTurn, Sandbox, UiSession } from './ui/index.ts'
import { tempDir } from './tmp.ts'

/** 这一趟的产物根——入口解析 `--out` 之后填。 */
let out = ''

/**
 * 产品那一侧那一格的字——**直接从 `@magic/tui` 取**，不在这里抄一份。
 *
 * 判据锚在**产品那个常量**上：改了它，这一趟跟着走（不会「两边各记一个数」）；
 * 而「那一格还在不在屏上」这一条**仍然咬得住**——常量改了而没上屏，取景就找不到它。
 */
const MARK = ALLOW_ALL_LABEL

/**
 * **参照面那套「运行中切模式」的键**——`shift+tab`（CSI Z）。
 *
 * ⚠️ 写成 `\u001b[Z` 三个码位，**不是把裸 ESC 字节贴进源码**：后者在编辑器里看不见、
 * 也放进不 diff 里——「按的是哪个键」这件事得在源码上看得出来。
 */
const SHIFT_TAB = '\u001b[Z'

/** 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/** 留一屏——文本写进 `<out>/<序号>-<名字>.txt`，字格与光标写进同名 `.json`。 */
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
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${name} ──（${shot.columns}×${shot.rows} · scrollback ${shot.scrollback}）\n${shot.text}`)
}

/** 一行在不在（按行找，与 `session.wait` 同一条尺子）。 */
function has(shot: Capture, needle: string): boolean {
  return shot.lines.some((line) => line.includes(needle))
}

/** 打一行字并**等它真出现在屏上**（文本与回车分两次写——挤在同一次写里按键会丢）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/**
 * 等**状态行那一行**里出现某句话——**等的是屏，不是状态**。
 *
 * ⚠️ 为什么不能「发完命令、取一帧、就断言」：那一格**由执行者随快照报来**，
 * 而快照是**挂上那一代之后**才到的一趟往返（还有 `shell.ts` 的 `RESUME_SETTLE_MS` 那一跳）
 * ——它上屏的时刻**排在第一条命令之后**，与「这一轮跑完了」并不同刻。
 * 取帧装置要判的是「用户看得见这一格」，故判据**等它上屏**，而不是赌一个时刻。
 * （实测：起手就跑完一条只读命令时，那一格会晚于「这一轮跑完了」那一行几帧才画出来。）
 *
 * 等的就是 `statusLineOf` 取的那一行——不是全屏找：全屏找在**记录区的材料里**也成立。
 */
async function waitStatusLine(session: UiSession, needle: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let line = ''

  while (Date.now() < deadline) {
    line = statusLineOf((await session.capture()).lines)
    if (line.includes(needle)) return line
    await Bun.sleep(50)
  }

  throw new Error(`等不到状态行里的「${needle}」——此刻那一行是：${JSON.stringify(line)}`)
}

/** 一句交代跑完并回到空闲。 */
async function settle(session: UiSession, said: string, until: string): Promise<void> {
  await typeLine(session, said)
  await session.key('enter', { until: { text: until }, timeoutMs: 40_000 })
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })
}

/**
 * 沙地里现在有几个**执行者**——`pgrep` 按启动目录认（它们都带着沙地里的路径）。
 *
 * ⚠️ **为什么要等它**（本单实测）：它是**这一代执行者**的属性（闸门在它的装配里）。
 * 上一程刚退出、它那一代**还没被收回**时，下一程 `--session` 会**挂回同一代**
 * ——那一代带的那个布尔就被如实报出来（带 `--allow-all` 起的那一代，接上去仍是全放行）。
 * 那是**对的行为**（报的是闸门真的怎么判），但它不是工单 ⑥ 那一句话的现场：
 * 「**退出后用全放行 resume 回来**」说的是**退出之后**——那一代已经收了，本程另起一代。
 * 故这一程**等它收干净**再起下一程（与 `frames-u53-tui` 等同一件事同一口径）。
 */
async function executorsIn(sandbox: Sandbox): Promise<number> {
  const proc = Bun.spawn(['pgrep', '-fl', sandbox.root], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited

  return text.split('\n').filter((line) => line.includes('internal-executor')).length
}

/** 等一个条件成立（默认 20 秒）。 */
async function waitFor(what: string, ok: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(50)
  }
}

/** 那条会话的 id——**从库里读**（会话是首写即建的，这是它唯一的落点）。 */
function onlySessionOf(sandbox: Sandbox): string {
  const db = readDatabase(join(sandbox.dataDir, 'records.db'))
  try {
    const sessions = db.sessions
    if (sessions.length !== 1) throw new Error(`库里不止一条会话（${sessions.length} 条）`)
    return (sessions[0] as { id: string }).id
  } finally {
    db.close()
  }
}

/**
 * 一条只读命令（机械分析判「轻」）——**两档都不问**（U76：默认通 ⇒ 全放行更是如此）。
 *
 * ⚠️ **U73 那一版拿它当"默认档会弹卡"的对照**，那个对照**没了**：判轻的**一律不问**。
 * 它如今用来量另一件事——**默认档与全放行档在这类调用上分不出差别**（差别在名单那两条上）。
 */
const LIGHT: FixtureTurn = { kind: 'tool', name: 'exec', args: { cmd: 'ls -la' } }
/** 一条**名单里**的命令（判重 · 删除 → 不可逆）——默认档照问，**全放行档也不问**（U76）。 */
const HEAVY: FixtureTurn = { kind: 'tool', name: 'exec', args: { cmd: 'rm -rf build' } }

// ══ ①②③④⑤⑦ · 四个窗口（各自一块沙地）════════════════════════════════

/**
 * **不带参数起 ⇒ 名单里那一条照问**（①）＋ 判轻的不弹卡 ＋ 状态行**没有**那一格。
 *
 * 这一趟同时是「它的反面」：与下一趟（带参数）只差一个参数，而那一条命令在那一趟
 * **也不弹卡**（④）——两档的差别全落在这里。
 */
async function scenePlain(): Promise<void> {
  const session = await createUiSession({
    label: 'u73-不带参数',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [LIGHT, { kind: 'text', text: '看过了。' }, HEAVY, { kind: 'text', text: '那我先不动它。' }],
  })

  try {
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

    // —— 先跑一条判轻的：**不弹卡**（U76：默认通，不必配规则）——
    await typeLine(session, '跑一下 ls')
    await session.key('enter', { until: { text: '看过了。' }, timeoutMs: 40_000 })
    const light = await session.capture({ label: '01a-不带参数起-判轻的不弹卡' })
    keep(light, '01a-不带参数起-判轻的不弹卡')

    check(!has(light, '· 可逆'), '① 判轻的：**不弹卡**（U76 起默认通）')
    check(has(light, '✓'), '① 工具**真跑了**（放行不是卡住）')
    check(!has(light, MARK), '① 状态行**没有**那一格（这一趟不在全放行）')

    // —— 再跑一条名单里的：**照问** ——
    await typeLine(session, '删掉 build')
    await session.key('enter', { until: { text: '· 不可逆' }, timeoutMs: 40_000 })

    const shot = await session.capture({ label: '01-不带参数起-名单那条照问' })
    keep(shot, '01-不带参数起-名单那条照问')

    check(has(shot, '· 不可逆'), '① 不带参数起：**卡照出**（`│ exec · 不可逆`）')
    check(has(shot, '删除（不可逆）'), '① 卡上说得出是名单里那一类')
    check(has(shot, 'y 批准'), '① 卡上有键位（`y 批准`）')
    check(!statusLineOf(shot.lines).includes(MARK), '① **状态行那一行**里也没有它')

    // —— ⑤（U73 那一格搬到这里）：名单上按 `a` **照样被挡** ——
    // ⚠️ **为什么搬**：U73 时这一条是在「全放行」窗口里量的；U76 起全放行**连它也不弹卡**
    // （那一趟没有卡可按），故这条判据落在**默认档**这一张卡上——它说的是同一件事：
    // 「名单里的东西不可用『总是允许』绕过」。
    await session.send('a', { until: { text: '必闸类不可' }, timeoutMs: 10_000 })
    const refused = await session.capture({ label: '01b-名单上按a-被挡' })
    keep(refused, '01b-名单上按a-被挡')

    check(has(refused, '必闸类不可「总是允许」'), '⑤ 名单上按 `a`：被挡下并说清缘由')
    check(has(refused, '· 不可逆'), '⑤ 卡**还挂着**（那一下没有答复掉它）')

    await session.send('n', { until: { text: '那我先不动它。' }, timeoutMs: 40_000 })
    await session.quit()
  } finally {
    await session.close({ graceMs: 3_000 })
  }
}

/**
 * **带参数起 ⇒ 常规调用不问**（②）＋ **状态行报着**（③ 宽窗 / ⑦ 窄窗）。
 *
 * ⚠️ 两种宽度各起一个窗口（同一份剧本）：宽窗看那一格**长什么样**，
 * 窄窗看**四格次序与降级**——「多一格之后降级照旧」只有真屏上才说得清。
 */
async function sceneAllowAll(columns: number, rows: number, mark: string): Promise<void> {
  const session = await createUiSession({
    label: `u73-带参数-${mark}`,
    columns,
    rows,
    artifacts: join(out, 'runs'),
    argv: ['--allow-all'],
    turns: [LIGHT, { kind: 'text', text: '看过了。' }],
  })

  try {
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

    // 起手那一帧留位（**不判**「有没有那一格」——见下），再跑一条只读命令。
    //
    // ⚠️ **为什么起手不判**：那一格报的是**执行者那一代带没带它**（闸门长在那儿），
    // 而这条路上「不给 `--session` ＝ 起来时一个执行者都没有」（空白启动页只有客户端，
    // 执行者是**第一条命令**才起来的）。故起手那几秒**没有闸门**——也就没有
    // 「全放行放了什么」可言，那一格**空着是实话**。判据落在**闸门存在之后**（下面那几条）。
    // 反过来那一路（`--allow-all --session <id>`：执行者随 hello 就起来）在 ⑧ 那一程里，
    // 那一程就是「接上就有」——两张帧合起来才是这件事的全貌。
    await session.capture({ label: `${mark}-起手` })

    await typeLine(session, '跑一下 ls')
    await session.key('enter', { until: { text: '看过了。' }, timeoutMs: 40_000 })
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })
    // 那一格是**随快照**上屏的（见 `waitStatusLine`）——判据等它，不赌时刻
    await waitStatusLine(session, MARK)

    const shot = await session.capture({ label: mark })
    keep(shot, mark)

    check(!has(shot, '· 不可逆'), '② 带参数起：**一张卡都没有**（整屏没有裁决卡）')
    check(has(shot, '✓'), '② 工具**真跑了**（`✓` 那一行在——放行不是卡住）')
    check(has(shot, '看过了。'), '② 模型收到了结果、接着说下一句')

    const line = statusLineOf(shot.lines)
    check(line.includes(MARK), '③ **状态行那一格报着**（`statusLineOf` 取的那一行里）')
    check(line.includes('○ 空闲'), '③ ① 状态仍在本行最前（次序不乱）')
    check(
      line.indexOf('○ 空闲') < line.indexOf(MARK),
      '③ 那一格在 ① 之后（次序：状态 → 全放行 → 会话 → …）',
      line,
    )

    await session.quit()
  } finally {
    await session.close({ graceMs: 3_000 })
  }
}

/**
 * **全放行：连名单那两条也放**（④）——与上一趟只差一个参数。
 *
 * ⚠️ **这一张帧 U76 整条反过来过**：U73 那一版是「必闸类照样弹」（旧设计），
 * 用户 2026-09-25 改定为「**真的什么都不问**」。原来那张卡（含按 `a` 被挡那半）
 * 现在落在**默认档**那一趟里（见 `scenePlain` 的 ① / ①b）。
 */
async function sceneGated(): Promise<void> {
  const session = await createUiSession({
    label: 'u73-必闸',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    argv: ['--allow-all'],
    turns: [HEAVY, { kind: 'text', text: '删掉了。' }],
  })

  try {
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })
    await typeLine(session, '删掉 build')
    await session.key('enter', { until: { text: '删掉了。' }, timeoutMs: 40_000 })
    await waitStatusLine(session, MARK)

    const shot = await session.capture({ label: '04-全放行-连名单那一条也放' })
    keep(shot, '04-全放行-连名单那一条也放')

    check(!has(shot, '· 不可逆'), '④ **一张卡都没有**（连名单里那一条也不问——U76 改定）')
    check(!statusLineOf(shot.lines).includes('y / n'), '④ 右位不是裁决键位（根本没问）')
    check(has(shot, '✓'), '④ 工具**真跑了**（放行不是卡住）')
    check(statusLineOf(shot.lines).includes(MARK), '④ 那一格照旧报着（不问了**不是**把状态也丢了）')

    await session.quit()
  } finally {
    await session.close({ graceMs: 3_000 })
  }
}

/**
 * **反证 · 对话期间切不进去**（⑥）——**直接按那个键**，不是写在注释里。
 *
 * 两半：
 * - **键位面**：把参照面那套「运行中切模式」的键（`shift+tab` = `\u001b[Z`）**写进真 PTY**，
 *   屏上**一个 `全放行` 都不许出现**；顺带把 `tab` 也试一遍（本产品的 `tab` 是补全）。
 * - **slash 面**：把候选表打出来，与 `COMMANDS` **逐名相等**——表上**没有**这一格，
 *   也就不存在「打一条命令切进去」。
 *
 * ⚠️ **两半都在一个「不带参数起」的窗口里做**：全放行要真能中途进去，这条路才对得上。
 */
async function sceneNoWayIn(): Promise<void> {
  const session = await createUiSession({
    label: 'u73-反证',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '收到，我在。' }],
  })

  try {
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

    const before = await session.capture({ label: '06a-反证-按之前' })
    check(!statusLineOf(before.lines).includes(MARK), '⑥ 起手：不在全放行')

    // —— 键位面：参照面那个键，按三遍 ——
    for (let n = 0; n < 3; n += 1) {
      await session.send(SHIFT_TAB)
      await Bun.sleep(120)
    }
    await session.send('\t')
    await Bun.sleep(200)

    const afterKeys = await session.capture({ label: '06-反证-shift加tab按不动' })
    keep(afterKeys, '06-反证-shift加tab按不动')

    check(!has(afterKeys, MARK), '⑥ `shift+tab` 连按三下 ＋ `tab`：屏上**一个 `全放行` 都没有**')
    check(
      !statusLineOf(afterKeys.lines).includes(MARK),
      '⑥ 状态行那一行里也没有（不是被别处挡住）',
      statusLineOf(afterKeys.lines),
    )

    // —— slash 面：候选表逐名比 ——
    //
    // ⚠️ **不能拿 `'/'` 当「它上屏了」的锚**：状态行右位那句 `/ 命令 · ctrl+c 退出` 里就有
    // 一个 `/`——等它会**当场就过**，而候选表一个都还没画出来。锚在**表上的第一条命令**上。
    await session.send('/')
    await session.wait({ text: COMMANDS[0]?.name ?? '/clear' }, { timeoutMs: 10_000 })
    const slash = await session.capture({ label: '07-反证-slash面没有那一格' })
    keep(slash, '07-反证-slash面没有那一格')

    const names = COMMANDS.map((command) => command.name)
    const shown = names.filter((name) => has(slash, name)).length
    // 抽屉高度有界，装不下的那几条由右位如实报「（还有 N 条）」（既有口径）——
    // 故「表就是这一份」＝ **看得见的 ＋ 报出来的 ＝ 表长**，不是「全看得见」。
    const rest = /还有 (\d+) 条/u.exec(statusLineOf(slash.lines))?.[1] ?? '0'

    check(shown + Number(rest) === names.length, '⑥ slash 候选表**就是那一份内置表**（看得见的 ＋ 报出来的 ＝ 表长）', `看见 ${shown} ＋ 还有 ${rest} ／ 表长 ${names.length}`)
    check(has(slash, '↑↓ 选'), '⑥ 括号里那一屏确实是**候选表**（右位报着选择键位）')
    check(
      names.every((name) => !/allow|bypass|permission|放行/i.test(name)),
      '⑥ **表上没有**任何切它的命令',
      JSON.stringify(names),
    )
    check(!has(slash, MARK), '⑥ slash 那一屏上也没有那一格')

    await session.key('esc')
    await session.quit()
  } finally {
    await session.close({ graceMs: 3_000 })
  }
}

// ══ ⑧⑨ · 三程一块沙地：全放行 resume 回来 / 不带参数 resume 回去 ══════

/**
 * **退出后用全放行 resume 回来**（⑧）· **同一趟不带参数 resume**（⑨）。
 *
 * 三程同借**一块沙地**（同一条会话）：
 *
 * | 程 | 怎么起 | 该看到什么 |
 * | --- | --- | --- |
 * | 1 | `--allow-all` | 起一条会话（记一句话） |
 * | 2 | `--allow-all --session <id>` | **接上了**（历史在）· 状态行**报着** · 常规调用**不问** |
 * | 3 | `--session <id>`（**不带参数**） | 接上了 · 状态行**不报** · 常规调用**照旧问** |
 *
 * 剧本按请求次序取：`text` → `tool` → `text` → `tool` → `text`——
 * 于是第 2 程与第 3 程**各拿到一条命令**，两程的差别只剩「带没带那个参数」。
 *
 * ⚠️ **第 3 程那一条是名单里那一条**（U76 起）：判轻的**两档都不问**，
 * 故「回去照旧问」这件事**只有夹在名单上才量得出来**；第 2 程那条判轻的，
 * 在带参数那一程里照样不问（放行不是它带来的，两者都通）。
 */
async function sceneResume(): Promise<void> {
  const fixture = startFixture({
    turns: [
      { kind: 'text', text: '记下了。' },
      LIGHT,
      { kind: 'text', text: '看过了。' },
      HEAVY,
      { kind: 'text', text: '那我先不动它。' },
    ],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const windows: UiSession[] = []

  try {
    // —— 第一程：起一条有内容的会话，再**照产品的方式退出** ——
    const first = await createUiSession({
      label: 'u73-resume-第一程',
      // 产物落在**同一处**（`out/runs`）——这一程的现场要和别的几趟一起归档
      artifacts: join(out, 'runs'),
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
      argv: ['--allow-all'],
    })
    windows.push(first)
    await first.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })
    // 起手那一帧留位（同样**不判**有没有那一格：这一程不给 `--session`，起来时还没有执行者
    // ——与 `sceneAllowAll` 那条同一条理由，见那边的注）
    await first.capture({ label: '08a-第一程-起手' })
    await settle(first, '记一句短话', '记下了。')
    await first.quit()
    // **等那一代收干净**再起下一程（见 `executorsIn` 的注）
    await waitFor('第一程的执行者收掉', async () => (await executorsIn(sandbox)) === 0)

    const id = onlySessionOf(sandbox)
    console.log(`\n（那条会话是 ${id}）`)

    // —— 第二程：**带参数 resume 回来** ——
    const second = await createUiSession({
      label: 'u73-resume-第二程-带参数',
      // 产物落在**同一处**（`out/runs`）——这一程的现场要和别的几趟一起归档
      artifacts: join(out, 'runs'),
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
      argv: ['--allow-all', '--session', id],
    })
    windows.push(second)
    await second.wait({ text: '记下了。' }, { timeoutMs: 30_000 })
    await waitStatusLine(second, MARK)

    const back = await second.capture({ label: '08-全放行resume回来' })
    keep(back, '08-全放行resume回来')

    check(has(back, '记一句短话'), '⑧ 接上了——那一程的记录铺出来了')
    check(statusLineOf(back.lines).includes(MARK), '⑧ **状态行照报**（接上之后仍是全放行）')

    await typeLine(second, '跑一下 ls')
    await second.key('enter', { until: { text: '看过了。' }, timeoutMs: 40_000 })
    await second.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

    const secondShot = await second.capture({ label: '08b-第二程-照旧不问' })
    // ⚠️ 判据锚的是「**整屏没有卡**」——U76 起判轻的**两档都不弹卡**（'· 可逆' 那一形
    // 已经没有产出了，拿它当锚会变成一句空话），故改锚在重件那句话上。
    check(!has(secondShot, '· 不可逆'), '⑧ 接回来的这一程：**没有卡**（轻类不问）')
    check(has(secondShot, '✓'), '⑧ 工具真跑了')
    await second.quit()
    await waitFor('第二程的执行者收掉', async () => (await executorsIn(sandbox)) === 0)

    // —— 第三程：**同一趟，不带参数 resume** ——
    const third = await createUiSession({
      label: 'u73-resume-第三程-不带参数',
      // 产物落在**同一处**（`out/runs`）——这一程的现场要和别的几趟一起归档
      artifacts: join(out, 'runs'),
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
      argv: ['--session', id],
    })
    windows.push(third)
    await third.wait({ text: '记下了。' }, { timeoutMs: 30_000 })

    const plain = await third.capture({ label: '09-不带参数resume-回去照旧问' })
    keep(plain, '09-不带参数resume-回去照旧问')

    check(has(plain, '记一句短话'), '⑨ 也接上了（同一条会话、没重开一条）')
    check(
      !statusLineOf(plain.lines).includes(MARK),
      '⑨ **状态行不报**（不带参数就是不带参数——它不跟着会话走）',
      statusLineOf(plain.lines),
    )

    await typeLine(third, '删掉 build')
    await third.key('enter', { until: { text: '· 不可逆' }, timeoutMs: 40_000 })

    const thirdShot = await third.capture({ label: '09b-第三程-照旧问' })
    check(has(thirdShot, '· 不可逆'), '⑨ **回去照旧问**：卡照出（名单里那一条、同一条会话）')
    check(has(thirdShot, '删除（不可逆）'), '⑨ 卡上说得出是名单里那一类')

    await third.send('y', { until: { text: '看过了。' }, timeoutMs: 40_000 })
    await third.quit()
  } finally {
    for (const window of windows) {
      await window.close({ graceMs: 3_000 })
    }
    await fixture.stop()
    sandbox.dispose()
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u73-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  // ① 不带参数起 —— 照旧问（它的反面）
  console.log('\n══ ① 不带参数起 ══')
  await scenePlain()

  // ②③ 带参数起 —— 常规调用不问 ＋ 状态行报着（宽窗 100）
  console.log('\n══ ②③ 带参数起（100×30）══')
  await sceneAllowAll(100, 30, '02-带参数起-常规不问')

  // ⑦ 带参数起 —— 窄窗 46：那一格永不省、四格次序不乱
  console.log('\n══ ⑦ 带参数起（46×30）══')
  await sceneAllowAll(46, 30, '03-带参数起-窄窗46-那一格报着')

  // ④⑤ 必闸类照样弹 ＋ 必闸上按 a 被挡
  console.log('\n══ ④⑤ 必闸类照样弹 ══')
  await sceneGated()

  // ⑥ 反证 —— 对话期间切不进去
  console.log('\n══ ⑥ 反证 · 对话期间切不进去 ══')
  await sceneNoWayIn()

  // ⑧⑨ 退出后用全放行 resume 回来 / 不带参数 resume 回去
  console.log('\n══ ⑧⑨ resume ══')
  await sceneResume()

  console.log(`\n帧落在 ${out}`)
}
