#!/usr/bin/env bun
/**
 * U93 · **截断一律保头保尾**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。
 *
 * ## 这一单治的两处病（同一条规律的两处落点）
 *
 * **结论常在尾部**（构建日志的报错 · 测试报告的结果）——**只留头等于没给**：
 *
 * - **甲 · `exec` 的输出上限**（`execution/src/exec.ts` 的 `drain`）：原先
 *   `value.subarray(0, room)`，越过 64 KiB 的部分**只丢不换** ⇒ 模型手里只剩开头那
 *   65557 字符，构建报错（在尾部）**进不了模型**（`D40` 现场：模型看不见，于是改写命令去探）。
 *   U82 在上下文那一侧落过同一手（blob 取回改成头尾都留），本单照它的形状补上这一处；
 * - **乙 · 屏上失败那一行**（`tui/src/components/log.ts`）：原先按头裁到 48 列，长路径下
 *   内层那句指引被切在半路，要 `ctrl+o` 展开才看得到（`D41` 的「只解决了一半」，U83 如实报的）。
 *
 * ⚠️ **上限那个数（`EXEC_MAX_OUTPUT_BYTES = 64 KiB`）本单一个字没动**——改的是**留哪一头**。
 *
 * ## 四张帧
 *
 * | 帧 | 工单那一格 | 该看见什么 |
 * | --- | --- | --- |
 * | `01` | **① 甲 · 尾部才有结论的大输出** | 模型手里那一份：**头在、尾在**，中段省掉并报数指路；屏幕那一行照旧「大块、没铺全」 |
 * | `02` | **② 乙 · 长路径写失败（折叠态）** | 那一行**没展开**就读得出「写入失败（…（路径两头都在）…上级目录不存在——先建目录」 |
 * | `03` | **③ 反面 · 短的那一形逐字未变** | 编辑失配那一行照旧（40 列，够短，裁法碰不到它） |
 * | `04` | **③ 反面 · 短路径仍是一行原样** | 换一条**短工作区根**（`/tmp/u9w`）造出真短的失败路径：那一行≤48 列 ⇒ **逐字原样**（裁法连门都没进） |
 *
 * ## 两处装置上的讲究（都不是产品行为）
 *
 * - **别按 `ctrl+o`**：`02` 要判的正是**折叠态**那一行（U83 那趟开局就展开，是为了绕过
 *   当时那句「指引要展开才看得到」——本单要的恰是它不再需要展开）；
 * - **`04` 那条短路径得靠一份配置**：帧里的工作区根是 `mkdtemp` 出来的（
 *   `/var/folders/…`，本身就长过 48 列）⇒ 真短的失败路径造不出来。故那一路**换一条
 *   短根**（`workspaceRoots: ['/tmp/u9w']`，`realpath` 之后 19 列）——那是产品真有的键
 *   （配置里的 `workspaceRoots` 整组接管默认根），不是给测试开的后门。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u93-tui.ts --out <目录> [--soft]
 * ```
 *
 * `--soft` ＝ 判据不过**不抛**、攒到最后一起报。它是给**反向验证**用的：把这支装置
 * **原样**放到**修前的检出**（基线 `3e989e9`）上跑一遍，看哪些判据**当场就红**——
 * 红的那几条才咬得住旧行为（`①` 那一组的头尾、`②` 那一句指引都该在基线上红），
 * 而绿的那几条（`③④` 两形）正是「本单没碰它们」的那一面。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { displayWidth } from '@magic/tui'
import { createSandbox, createUiSession, startFixture } from './ui/index.ts'
import type { Capture, FixtureTurn, Sandbox, UiSession } from './ui/index.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 这一趟的产物根——入口解析 `--out` 之后填。 */
let out = ''

/** `--soft`：判据不过**不抛**，攒着最后一起报（见文件头「反向验证」那一条）。 */
let soft = false

/** 软档下没过的判据——收尾一起报。 */
const failed: string[] = []

/**
 * 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。
 *
 * ⚠️ `--soft` 那一档是给**反向验证**用的：把**同一支装置**放到**修前的检出**上跑，
 * 看哪些判据**当场就红**（红＝它咬得住旧行为，不是事后挑的说法），而哪些仍然绿
 * （绿＝那一形本就没被碰）。硬档在第一处红就停了，看不到后面几条。
 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  const said = `判据「${what}」没过${detail === '' ? '' : `：${detail}`}`
  if (soft) {
    failed.push(said)
    console.log(`  ✗ ${said}`)
    return
  }

  throw new Error(said)
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

/** 含 `needle` 的那几行（判据要看的是**它自己那一行**，不是整屏）。 */
function linesWith(shot: Capture, needle: string): readonly string[] {
  return shot.lines.filter((line) => line.includes(needle))
}

/** 64 位十六进制——**blob 的引用长相**（sha256）。屏上、模型那份里都不该有它。 */
const SHA256 = /\b[0-9a-f]{64}\b/

/**
 * 结果那一行的**正文**部分——`  ✗ [耗时 · ]` 那一小截标记不参与 48 列这笔账
 * （48 列是 `log.ts` 给那句正文的预算，见 `FAILED_LINE_COLUMNS`）。
 */
function verdictText(line: string): string {
  return line.replace(/^\s*[✗!]\s+(?:\S+\s+·\s+)?/, '')
}

/**
 * 那一行之后的**第一个非空行**是什么——「折叠态只有一行」这条靠它判：
 * 折了的话它就是那一句的续行；没折的话它直接是下一条（助手那句）。
 */
function lineAfter(shot: Capture, line: string): string {
  return shot.lines.slice(shot.lines.indexOf(line) + 1).find((one) => one.trim() !== '') ?? ''
}

// ══ 造样本用的命令与路径 ═════════════════════════════════════════════

/**
 * **尾部才有结论**的大输出（工单 ① 点的那种）：20000 行噪声 ＋ 末尾一句结论。
 *
 * 每行带前缀 `u93h-`：判据按行找它，不与别的东西撞脸（`u93h-1` 是头、`u93h-20000` 是尾）。
 * 总量约 220 KB——**远超 `EXEC_MAX_OUTPUT_BYTES`（64 KiB）**，故中段必定被省。
 */
const HUGE_CMD = 'seq 1 20000 | sed "s/^/u93h-/"; echo 结论在这'

/** 长到能把那一行撑过 48 列的路径（上级目录两级都不在）。 */
const LONG_WRITE = 'u93-no-dir-deep/nested-still-missing/u93-new.txt'

/** 编辑失配那一笔用的文件（**真在**——失配是「那段原文不在」，不是「文件不在」）。 */
const HERE_FILE = 'u93-here.txt'

/** `04` 那一趟的**短工作区根**——`realpath` 之后 19 列，装得下「名分 ＋ 路径 ＋ 原委」。 */
const SHORT_ROOT = '/tmp/u9w'

// ══ 起手与收摊 ══════════════════════════════════════════════════════

async function openScene(options: {
  readonly label: string
  readonly turns: readonly FixtureTurn[]
  readonly config?: Record<string, unknown>
  readonly prepare?: (sandbox: Sandbox) => void
}): Promise<{ readonly session: UiSession; readonly sandbox: Sandbox; readonly fixture: { stop(): Promise<void> } }> {
  const fixture = startFixture({ turns: options.turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL, ...(options.config === undefined ? {} : { config: options.config }) })
  options.prepare?.(sandbox)

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

async function closeScene(scene: {
  readonly session: UiSession
  readonly sandbox: Sandbox
  readonly fixture: { stop(): Promise<void> }
}): Promise<void> {
  try {
    await scene.session.quit()
  } finally {
    await scene.session.close({ graceMs: 3_000 })
    await scene.fixture.stop()
    scene.sandbox.dispose()
  }
}

/** 打一行字并**等它真出现在屏上**（文本与回车分两次写——挤在同一次写里按键会丢）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 敲一发工具调用、等它跑完。 */
async function ask(session: UiSession, said: string, until: string, timeoutMs = 60_000): Promise<void> {
  await typeLine(session, said)
  await session.key('enter', { until: { text: until }, timeoutMs })
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 30_000 })
}

/**
 * 同 `ask`，但这一笔**会弹裁决卡**——等卡出来、按 `y` 批准，再看它跑成什么样。
 *
 * `write` 是权限域那一档 `by-call` 必闸（判不出新建还是覆盖 ⇒ 从严），而必闸类
 * **任何规则都放不动**（U76 起）⇒ 照默认姿态走就必然过一道卡。帧里照产品的方式批了它。
 */
async function askApprove(session: UiSession, said: string, until: string): Promise<void> {
  await typeLine(session, said)
  await session.key('enter', { until: { text: 'y 批准' }, timeoutMs: 20_000 })
  await session.send('y', { until: { text: until }, timeoutMs: 60_000 })
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 30_000 })
}

/**
 * 夹具收到的请求里**某个角色的消息正文**（按请求序）——读的是 `FixtureRequest.body`
 * 原样（不是夹具另做的那几格摘要），判据因此问的是「真发出去的是什么」。
 */
function messagesOf(session: UiSession, role: string): readonly string[] {
  const found: string[] = []

  for (const request of session.requests()) {
    const messages = request.body['messages']
    if (!Array.isArray(messages)) continue

    for (const one of messages as readonly Record<string, unknown>[]) {
      if (one['role'] !== role) continue
      const content = one['content']
      if (typeof content === 'string') found.push(content)
    }
  }

  return found
}

/** 最后一条**含这个标记**的 `tool` 消息正文（这一趟的物证）。 */
function lastToolOf(session: UiSession, marker: string): string {
  const hits = messagesOf(session, 'tool').filter((one) => one.includes(marker))

  return hits[hits.length - 1] ?? ''
}

// ══ ① 甲 · 尾部才有结论的那一份 ══════════════════════════════════════

async function sceneExecTail(): Promise<void> {
  const scene = await openScene({
    label: 'u93-甲-exec上限',
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: HUGE_CMD } },
      { kind: 'text', text: '大的跑完了。' },
    ],
  })

  try {
    await ask(scene.session, '跑个大输出，结论在末尾', '大的跑完了。', 120_000)

    const shot = await scene.session.capture({ label: '01-甲-大输出那一屏' })
    keep(shot, '01-甲-大输出那一屏')

    // 物证：**夹具真收到的那一条 `tool` 消息**（模型手里那一份的原样）
    const handed = lastToolOf(scene.session, 'u93h-1')
    writeFileSync(join(out, '01-甲-模型那一份.txt'), `${handed}\n`, 'utf8')

    const shown = handed.includes('…（截断：')
    check(handed !== '', '① 夹具真收到了一条 `tool` 消息（不是「哪儿都没到」）')
    check(handed.startsWith('u93h-1\n'), '① **头在**（第一行就是它）')
    check(handed.includes('u93h-20000'), '① **尾在**（最后那一行也到了——结论就在这一头）')
    check(
      handed.trimEnd().endsWith('结论在这'),
      '① 尾部那句结论**是这一份的最后一行**（改前它根本不在——只留开头 65557 字符）',
      JSON.stringify(handed.slice(-80)),
    )
    check(shown, '① 中段省掉处**留了记号**（`…（截断：`）')
    check(/中间省略 \d{3,} 字节/.test(handed), '① 省掉处**报数**（省了多少 · 原文多大）')
    check(
      handed.includes('要看全'),
      '① 省掉处**指得出怎么看全**（引导，不是干截）',
      handed.slice(Math.max(0, handed.indexOf('…（截断：')), handed.indexOf('…（截断：') + 120),
    )
    check(
      !handed.includes('u93h-10000'),
      '① 中段**真省掉了**（不是「说了截断其实全给了」）',
    )
    check(!SHA256.test(handed), '① 模型那一份里不含任何内部 id')

    // 屏幕那一行照旧是 U82 的口径（这一改不该动它）
    check(has(shot, '大块输出'), '① 屏幕上那一行照旧报得出规模（`大块输出 …`）', linesWith(shot, 'exec').join(' ⏎ '))
    check(!shot.lines.some((line) => SHA256.test(line)), '① 屏上也不出现那串 sha256')
  } finally {
    await closeScene(scene)
  }
}

// ══ ② ③ 乙 · 失败那一行：长路径保头保尾 · 短的那一形逐字未变 ═════════

async function sceneFailedLine(): Promise<void> {
  const scene = await openScene({
    label: 'u93-乙-失败那一行',
    turns: [
      // ② 长路径写失败（上级目录不存在）——整写是必闸，照默认姿态过一道卡
      { kind: 'tool', name: 'write', args: { path: LONG_WRITE, content: '写不进去\n' } },
      { kind: 'text', text: '那我先建目录。' },
      // ③ 反面：编辑失配那一笔（那句话 40 列，够短——裁法碰不到它）
      { kind: 'tool', name: 'edit', args: { path: HERE_FILE, old: '乙', new: '丙' } },
      { kind: 'text', text: '那段原文不在文件里。' },
    ] satisfies readonly FixtureTurn[],
    prepare: (sandbox) => {
      writeFileSync(join(sandbox.workspace, HERE_FILE), '文件在这儿，里面没有那段原文。\n', 'utf8')
    },
  })

  try {
    // ⚠️ **不按 `ctrl+o`**——这一趟要判的正是**折叠态**（U83 那趟开局就展开，
    //    绕过的就是这句「指引要展开才看得到」）。
    await askApprove(scene.session, '把那段说明写进那个很深的目录里', '那我先建目录。')

    const write = await scene.session.capture({ label: '02-乙-长路径折叠态' })
    keep(write, '02-乙-长路径折叠态')

    const line = linesWith(write, '✗').find((one) => one.includes('写入失败')) ?? ''
    const said = verdictText(line)

    check(line !== '', '② 结果那一行在（`✗ … 写入失败（…）`）', linesWith(write, '写入失败').join(' ⏎ '))
    check(said.includes('写入失败'), '② **名分**读得到（头那一半）', line)
    check(said.includes('…'), '② 中段省掉、留了记号（不是硬切）', line)
    check(
      said.endsWith('上级目录不存在——先建目录'),
      '② **折叠态就读得出「为什么 ＋ 该怎么办」**（本单的要害：改前只到「名分 ＋ 半个路径」）',
      line,
    )
    check(
      [...said].length <= 48,
      '② 折叠态正文在 48 个字的预算里（不撑乱）',
      `正文 ${[...said].length} 字`,
    )
    check(
      displayWidth(line) < write.columns,
      '② 整行没到屏宽（100 列）——仍是一行',
      `${displayWidth(line)} 列`,
    )
    check(
      lineAfter(write, line).includes('那我先建目录'),
      '② **折叠态只有一行**：那一行之后直接是助手那句（折了的话那里会是它的续行）',
      JSON.stringify(lineAfter(write, line)),
    )
    check(!existsSync(join(scene.sandbox.workspace, 'u93-no-dir-deep')), '② 上级目录**没被悄悄建出来**（物证）')
    check(!existsSync(join(scene.sandbox.workspace, LONG_WRITE)), '② 文件也没落地')

    // —— ③ 反面：编辑失配那一行（短的那一形）——
    await ask(scene.session, `把 ${HERE_FILE} 里的「乙」改成「丙」`, '那段原文不在文件里。')

    const miss = await scene.session.capture({ label: '03-乙-反面-短的那一形' })
    keep(miss, '03-乙-反面-短的那一形')

    const missLine = linesWith(miss, '✗').find((one) => one.includes('未找到待替换文本')) ?? ''
    check(
      verdictText(missLine) === '未找到待替换文本——文件未改',
      '③ 反面：那一句**逐字未变**（本单只改裁法，不改措辞）',
      missLine,
    )
    check(
      [...verdictText(missLine)].length <= 48,
      '③ 它本来就够短——裁法连门都没进（短的那一形原样出来）',
      `正文 ${[...verdictText(missLine)].length} 字`,
    )
  } finally {
    await closeScene(scene)
  }
}

// ══ ④ 反面 · 短路径：那一行也逐字未变 ═══════════════════════════════

/**
 * 帧里的工作区根是 `mkdtemp` 出来的（`/var/folders/…`，本身就长过 48 列）——**真短的失败
 * 路径**在那块沙地里造不出来。故这一格换一条**短根**（配置里的 `workspaceRoots` 是真有的键：
 * 「整组接管，不再并入启动目录」）。路径一短，那一行就够不着 48 列 ⇒ 裁法连门都没进，
 * 出来的应当是**逐字原样**的整句。
 */
async function sceneShortPath(): Promise<void> {
  mkdirSync(SHORT_ROOT, { recursive: true })

  const scene = await openScene({
    label: 'u93-乙-短路径',
    config: { workspaceRoots: [SHORT_ROOT] },
    turns: [
      { kind: 'tool', name: 'read', args: { path: 'a.txt' } },
      { kind: 'text', text: '那个文件不在。' },
    ],
  })

  try {
    await ask(scene.session, '读一下 a.txt', '那个文件不在。')

    const shot = await scene.session.capture({ label: '04-乙-反面-短路径' })
    keep(shot, '04-乙-反面-短路径')

    const line = linesWith(shot, '✗').find((one) => one.includes('读取失败')) ?? ''
    const said = verdictText(line)

    check(line !== '', '④ 短路径那一行在（`✗ … 读取失败（…）：文件不存在`）', linesWith(shot, '读取失败').join(' ⏎ '))
    check(displayWidth(said) <= 48, '④ 这一句真够短（≤48 列）——反面那一格的由头', `${displayWidth(said)} 列`)
    check(
      said === '读取失败（/private/tmp/u9w/a.txt）：文件不存在',
      '④ **逐字原样**：名分 ＋ 完整路径 ＋ 原委，一个字不多、一个 `…` 都不加（短的那一形没被碰）',
      JSON.stringify(said),
    )
  } finally {
    await closeScene(scene)
    removeDir(SHORT_ROOT)
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u93-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root
  soft = process.argv.includes('--soft')

  console.log(`产物目录：${out}${soft ? '（软档：判据不过不抛）' : ''}\n`)
  try {
    console.log('══ ① 甲：越过上限的那一份——头尾都留 ══')
    await sceneExecTail()
    console.log('\n══ ② ③ 乙：失败那一行（长路径保头保尾 · 短的那一形逐字未变）══')
    await sceneFailedLine()
    console.log('\n══ ④ 反面：短路径下那一行逐字未变 ══')
    await sceneShortPath()

    if (failed.length > 0) {
      console.log(`\n没过 ${failed.length} 条：`)
      for (const one of failed) console.log(`  ✗ ${one}`)
      process.exitCode = 1
    } else {
      console.log('\n全部判据通过。')
    }
  } finally {
    console.log(`\n帧落在 ${out}`)
  }
}
