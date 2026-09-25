#!/usr/bin/env bun
/**
 * U83 · **失败的话，动作名只说一遍**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。
 *
 * ## 判的是哪一件事
 *
 * 缺陷 D41（`缺陷/D41 失败的话把动作名说两遍.md`）：同一条链上**两层各加了一次前缀**——
 * 内层 `execution/files.ts` 产出 `写入失败（path）：原因`，外层 `tools/messages.ts` 再缀
 * 一个 `写入失败：`，屏上成了
 *
 * ```
 * 写入失败：写入失败（/Users/…/docs/design.md）：上级目录不存在——先建目录
 * ```
 *
 * **同一条事实说了两遍**，而唯一能照做的那句指引（「先建目录」）被淹在前缀里。
 *
 * ## 四张帧
 *
 * | 帧 | 工单那一格 | 该在屏上看见什么 |
 * | --- | --- | --- |
 * | `01` | **② 写**（上级目录不存在） | `写入失败（path）：上级目录不存在——先建目录`——**名分一次**；目录**没被悄悄建出来** |
 * | `02` | **③ 读**（文件不存在） | `读取失败（path）：文件不存在`——同上 |
 * | `03` | **③ 列目录**（目录不存在） | `列目录失败（path）：目录不存在`——同上 |
 * | `04` | **④ 反面 · 编辑** | 编辑这一支**形制齐**（原先缀 `编辑失败：`，成了「名分 ＋ 名分 ＋ 沙箱的话」）——**不缺不重** |
 *
 * ## 判据怎么咬
 *
 * - **名分只出现一次**：那一行里 `写入失败` / `读取失败` / `列目录失败` 各数一遍，恒等于 1
 *   （D41 那天是 2）；
 * - **指引一个字都在**：`上级目录不存在——先建目录` **逐字**在那一行上（工单明文：
 *   内层那句指引一个字不许删）；
 * - **物证**：写那一笔的上级目录**真没被建出来**、文件不存在那两笔的 `ENOENT` 是真的
 *   （不是替身桩编出来的话）。
 *
 * ⚠️ **`write` 那一笔会过一道裁决卡**：整写在权限域是 `by-call` 必闸（判不出新建还是
 * 覆盖 ⇒ 从严），而必闸类**任何规则都放不动**（U76 起）⇒ 照默认姿态走就必然问一次。
 * 帧里照产品的方式按 `y` 批了它——本单要判的是**卡后面那一步**（执行失败怎么措辞）。
 *
 * ⚠️ **那一行在屏上会被裁到 ~48 列**（`components/log.ts` 的 `truncateLine`——失败的
 * 那一行只铺首行缘由，**既有显示口径，不在本单里**）：折起来时那半截只够看见名分与半个
 * 路径，够判「名分一次」，**不够判「指引还在」**。故这一趟**开局就按 `ctrl+o`**（展开态
 * 一直挂着）：那一行的**整句**在它正下方那几行里（工具行的正文），四个动作各看得到一次。
 *
 * 展开要**在那一行落地之前**按（U72 那趟踩过）：已进 scrollback 的行是 `<Static>` 写死
 * 的，之后再按 `ctrl+o` 也不会重绘——这一趟就在开工前按。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u83-tui.ts --out <目录>
 * ```
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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

/** 留一屏——文本写进 `<out>/<序号>-<名字>.txt`，字格与光标写进同名 `.json`。 */
function keep(shot: Capture, name: string): void {
  writeFileSync(join(out, `${name}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${name}.json`),
    `${JSON.stringify(
      { columns: shot.columns, rows: shot.rows, cursor: shot.cursor, scrollback: shot.scrollback, lines: shot.lines },
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

/** `needle` 在这一行里出现几次——D41 判的就是这个数（原先＝2）。 */
function countIn(line: string, needle: string): number {
  return line.split(needle).length - 1
}

/**
 * **D41 那一形在整屏上都不出现**——`写入失败：写入失败（…）`。
 *
 * 这一条是判据本体，且**按整屏查**：那一行折起来被裁、展开又另铺一份正文，两处都是
 * 同一句话的两个渲染，逐处数名分要数两次才对；而「两遍前缀」这一形**哪里都不该有**。
 */
function checkNoStutter(shot: Capture, name: string): void {
  const stuttered = shot.lines.filter((line) => line.includes(`${name}失败：${name}失败`))

  check(
    shot.lines.some((line) => line.includes(`${name}失败（`)),
    `${name}失败那句在屏上（${name}失败（path）：原因）`,
  )
  check(stuttered.length === 0, `不是「${name}失败：${name}失败（…）」那一形（D41 的原样）`, stuttered[0] ?? '')
}

/** 结果那一行（`✗ …`）——名分在那儿**只说一遍**。 */
function checkVerdictLine(shot: Capture, name: string, at: string): void {
  const line = linesWith(shot, '✗').find((one) => one.includes(`${name}失败`))

  check(line !== undefined, `${at} 结果那一行在（✗ … ${name}失败（path）：…）`)
  check(countIn(line as string, `${name}失败`) === 1, `${at} 那一行名分只说一遍`, line as string)
}

/** 打一行字并**等它真出现在屏上**（文本与回车分两次写——挤在同一次写里按键会丢）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 敲一发工具调用、等它跑完（失败的照样落一条 `tool.result`，模型照样接着说下一句）。 */
async function ask(session: UiSession, said: string, until: string): Promise<void> {
  await typeLine(session, said)
  await session.key('enter', { until: { text: until }, timeoutMs: 60_000 })
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })
}

/**
 * 同 `ask`，但这一笔**会弹裁决卡**——等卡出来、按 `y` 批准，再看它跑成什么样。
 *
 * `write` 是权限域那一档 `by-call` 必闸（判不出新建还是覆盖 ⇒ 从严），而必闸类
 * **任何规则都放不动**（U76 起）⇒ 这一笔照默认姿态走就必然过一道卡。本单要判的是
 * **卡后面那一步**（执行失败怎么措辞），故照产品的走法批了它。
 */
async function askApprove(session: UiSession, said: string, until: string): Promise<void> {
  await typeLine(session, said)
  await session.key('enter', { until: { text: 'y 批准' }, timeoutMs: 20_000 })
  await session.send('y', { until: { text: until }, timeoutMs: 60_000 })
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })
}

// ══ 一趟窗口：三种失败各一屏 ＋ 编辑那一支 ═══════════════════════════

/**
 * 四笔**注定失败**的调用，只说一件事：失败那句话怎么措辞。
 *
 * 同一趟窗口里连着走——同一份配置、同一个模型，四行**并排可读**：
 * 「名分一次」这件事在四行上是同一个形状（编辑那一支原先不是）。
 *
 * 四笔的落点都在工作区**内**（越界那一路不在本单：那是权限域的话，见 `messages.ts`）。
 * 名字带 `u83-` 前缀：这一趟只会碰这几件，且**一件都不建**（那一头就是物证）。
 */
async function sceneFailures(): Promise<void> {
  const fixture = startFixture({
    turns: [
      { kind: 'tool', name: 'write', args: { path: 'u83-no-dir/u83-new.txt', content: '写不进去\n' } },
      { kind: 'text', text: '上级目录不存在——那我先建目录。' },
      { kind: 'tool', name: 'read', args: { path: 'u83-none.txt' } },
      { kind: 'text', text: '那个文件不在。' },
      { kind: 'tool', name: 'ls', args: { path: 'u83-no-such-dir' } },
      { kind: 'text', text: '目录也不在。' },
      { kind: 'tool', name: 'edit', args: { path: 'u83-none.txt', old: '甲', new: '乙' } },
      { kind: 'text', text: '总之先建目录。' },
      { kind: 'tool', name: 'edit', args: { path: 'u83-here.txt', old: '乙', new: '丙' } },
      { kind: 'text', text: '那段原文不在文件里。' },
    ] satisfies readonly FixtureTurn[],
  })

  const sandbox: Sandbox = createSandbox({ baseURL: fixture.baseURL })

  // 一件**真在**的文件——给 ⑤ 那一笔（编辑的**失配**那一路：文件在、那段原文不在），
  // 与上面三笔「压根没有」分开看。名字同样带 `u83-` 前缀：这一趟只碰这几件。
  writeFileSync(join(sandbox.workspace, 'u83-here.txt'), '文件在这儿，里面没有那段原文。\n', 'utf8')

  const session = await createUiSession({
    label: 'u83-失败的话',
    artifacts: join(out, 'runs'),
    sandbox,
    fixture,
    columns: 100,
    rows: 32,
  })

  try {
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

    // **开局就把工具行展开**（`ctrl+o` 是切换）——那一行折起来只铺 48 列，看不全整句；
    // 而展开要**赶在那一行落地之前**按（进了 scrollback 就不再重绘，见文件头注）。
    await session.key('ctrl+o')

    // —— ② 写：上级目录不存在（整写是必闸，照默认姿态过一道卡再跑）——
    await askApprove(session, '把那段说明写进 u83-no-dir/u83-new.txt', '上级目录不存在——那我先建目录。')

    const write = await session.capture({ label: '01-写-上级目录不存在' })
    keep(write, '01-写-上级目录不存在')

    checkVerdictLine(write, '写入', '② 写')
    checkNoStutter(write, '写入')
    check(has(write, '上级目录不存在——先建目录'), '② 那句指引**一个字都在**（工单明文：不许删）')
    check(!existsSync(join(sandbox.workspace, 'u83-no-dir')), '② 上级目录**没被悄悄建出来**（执行域不替模型做决定）')
    check(!existsSync(join(sandbox.workspace, 'u83-no-dir', 'u83-new.txt')), '② 文件也没落地')

    // —— ③ 读：文件不存在 ——
    await ask(session, '读一下 u83-none.txt', '那个文件不在。')

    const read = await session.capture({ label: '02-读-文件不存在' })
    keep(read, '02-读-文件不存在')

    checkVerdictLine(read, '读取', '③ 读')
    checkNoStutter(read, '读取')
    check(has(read, '文件不存在'), '③ 缘由在（文件不存在）')
    check(!existsSync(join(sandbox.workspace, 'u83-none.txt')), '③ 那个文件**真不在**（这一笔的 ENOENT 是真的）')

    // —— ③ 列目录：目录不存在 ——
    await ask(session, '看看 u83-no-such-dir 里有什么', '目录也不在。')

    const ls = await session.capture({ label: '03-列目录-目录不存在' })
    keep(ls, '03-列目录-目录不存在')

    checkVerdictLine(ls, '列目录', '③ 列目录')
    checkNoStutter(ls, '列目录')
    check(has(ls, '目录不存在'), '③ 缘由在（目录不存在）')
    check(!existsSync(join(sandbox.workspace, 'u83-no-such-dir')), '③ 那个目录**真不在**')

    // —— ④ 反面：编辑那一支 ——
    await ask(session, '把 u83-none.txt 里的「甲」改成「乙」', '总之先建目录。')

    const edit = await session.capture({ label: '04-反面-编辑那一支' })
    keep(edit, '04-反面-编辑那一支')

    // 编辑就是「读 → 改 → 写回」：这里卡在**读**那一步，故名分是「读取失败」——
    // 而那正是这一支要齐的形制（原先它是「编辑失败：读取失败（…）：…」：名分两遍）。
    checkVerdictLine(edit, '读取', '④ 编辑那一支（卡在读）')
    checkNoStutter(edit, '读取')
    check(!has(edit, '编辑失败'), '④ **不再缀 `编辑失败：`**——那是第三个名分（回执上一行已经写着 `● edit`）')
    check(has(edit, '● edit'), '④ 而「哪件工具失败了」在回执那一行上（`● edit`）')
    check(has(edit, '文件不存在'), '④ 缘由照旧在')

    // —— ④ 反面 · 编辑那一支的**别几条**（失配那一路）——
    //
    // 这一条护的是工单那条边界：**只去重、不改内容**。编辑自己那几句话
    // （未找到待替换文本 / 出现多处 / 文件超长 / 新旧相同）**本来就没有名分**，
    // 本单一个字没动——摆出来是为了让「编辑那一支形制齐」这件事看得全：
    // 齐的是**沙箱抛的那一路**（原先它被缀成了「名分 ＋ 名分 ＋ 沙箱的话」）。
    await ask(session, '把 u83-here.txt 里的「乙」改成「丙」', '那段原文不在文件里。')

    const miss = await session.capture({ label: '05-反面-编辑失配那一路未改' })
    keep(miss, '05-反面-编辑失配那一路未改')

    check(has(miss, '未找到待替换文本——文件未改'), '④ 失配那一路**逐字未改**（本单只去重、不改内容）')
    check(has(miss, '● edit'), '④ 它的回执头一行照旧（`● edit`）')
  } finally {
    try {
      await session.quit()
    } finally {
      await session.close({ graceMs: 3_000 })
      await fixture.stop()
      sandbox.dispose()
    }
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u83-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    console.log('\n══ ② ③ ④ 失败的话：名分一次 · 理由与指引都在 ══')
    await sceneFailures()
  } finally {
    console.log(`\n帧落在 ${out}`)
  }
}
