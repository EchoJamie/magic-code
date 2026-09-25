#!/usr/bin/env bun
/**
 * U70 · **`exec` 的后台那一形** —— 真 PTY 留帧 ＋ 逐格验收。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。跑法：
 *
 * ```
 * bun packages/app/test/frames-u70-tui.ts --out <目录>
 * ```
 *
 * ## 取的是哪几屏
 *
 * 真 `cli.ts`（真装配 · 真沙箱 · 真闸门 · 真记录 · 真 Ink 外壳）跑在**真 PTY** 里，
 * 只有模型那一头是本机夹具（`ui/fixture.ts`，环回地址、一个付费请求都不发）。
 *
 * | 张 | 工单那一格 | 该在屏上看见什么 |
 * | --- | --- | --- |
 * | ① | 照旧过闸门 | 带 `background` 的调用**照样弹卡**（后台不是绕过裁决的口子） |
 * | ② | 发起 | `✓ … 已交出去，这一轮不等它：bg-1` ＋ 输出文件路径；模型**接着说话** |
 * | ③ | 跑完 ⇒ 给屏那一声 | `· bg-1 跑完了（exit 0）· …`（**带那个路径**） |
 * | ④ | 取输出 | 模型用**既有的 `read`** 读那个文件（它在**工作区之外**），读出内容 |
 * | ⑤ | dev server 那一形 | 一条**永不结束**的命令：**没有**「跑完」那一声，而 `read`
 *      那个文件**看得到后续新增的输出**（读两遍，第二遍多出几行） |
 *
 * 另有第六屏 `…-停`：**按 id 停**落在**进程组**上（`pgrep` 实数，见文件末尾那一节）。
 *
 * ## 两处装置上的讲究
 *
 * - **输出文件的路径要在**写剧本那一刻就知道**：夹具的剧本是**按次取**的（第 n 次请求用
 *   第 n 个回合），而沙地的家目录是随机的 ⇒ 先起夹具、再建沙地、**算出路径之后再往剧本
 *   里补那一回合**。借用式起会话（`sandbox` ＋ `fixture` 外借）正是为这条链准备的。
 * - ⚠️ **一条权限规则都不加**：这一单要留的恰恰是「**该弹卡还是弹卡**」（工单反面那一句）。
 *   加规则＝把要验的东西验没了。
 *
 * ## 判据怎么咬
 *
 * 每条都是**逐字**比对屏上的字（`check`），对不上当场抛——不是「看看而已」。
 * 帧落在 `<out>/NN-<名字>.txt`（纯文本）与 `.json`（字格 / 光标），原始字节与查看页在
 * `<out>/runs/` 那一份运行档案里（`createUiSession` 的 artifacts）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MagicHome } from '@magic/contracts'
import {
  MAGIC_IDLE_MARK,
  createSandbox,
  createUiSession,
  startFixture,
  statusLineOf,
} from './ui/index.ts'
import type { Capture, FixtureTurn, Sandbox, UiSession } from './ui/index.ts'
import { backgroundOutputDirOf, runPathsOf } from '../src/run/paths.ts'
import { attachShell } from '../src/index.ts'
import { makeStage } from './support.ts'
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

/** 留一屏——文本 ＋ 字格（色与重量只能从 `.json` 的格子上看）。 */
function keep(shot: Capture): void {
  writeFileSync(join(out, `${shot.label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${shot.label}.json`),
    `${JSON.stringify(
      { columns: shot.columns, rows: shot.rows, cursor: shot.cursor, lines: shot.lines },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${shot.label} ──（scrollback ${shot.scrollback}）\n${shot.text}`)
}

/** 屏上（可见那一屏＋滚进去的）有没有这句话。 */
function has(shot: Capture, needle: string): boolean {
  return shot.text.includes(needle) || shot.history.some((line) => line.includes(needle))
}

/**
 * 屏上有没有**整整这么一行**（裁掉行首缩进之后逐字相同）。
 *
 * ⚠️ **判内容必须用这一支，不能用 `has`**（本轮实测踩过）：`has` 是**包含**，
 * 而工具卡那一行写着命令本身（`● exec {"cmd":"echo 起手; …"}`）⇒ 拿 `has('起手')` 去认
 * 「read 读到了那一行」，命令串里的同一串字会**替它通过**——判据当场变成假绿。
 * 行级相等没有这个洞：命令那一行整行不等于 `起手`。
 */
function hasLine(shot: Capture, text: string): boolean {
  return [...shot.history, ...shot.lines].some((line) => line.trim() === text)
}

/**
 * **展开**（`ctrl+o`）——工具卡收起时只报「N 行」，展开了才看得见读了什么。
 *
 * ⚠️ **必须在这一行落进记录区之前拨**：`Static` 写一次就不再重绘（D11 的护栏），
 * 已经定局的行拨了也不动。故这一拨要走在「读」那一次执行**之前**——
 * 拨完它一直有效，后面几次读照旧是展开的。
 */
async function expand(session: UiSession): Promise<void> {
  await session.send('\u000f')
  await Bun.sleep(300)
}

/**
 * **那一条后台命令的输出文件路径**——按产品自己的那两件算（`runPathsOf` ＋
 * `backgroundOutputDirOf`），不是照目录结构猜的：装配怎么算的，这里就怎么算。
 *
 * `bg-1` ＝ 这一代进程里第一条（沙地是全新的，号从 1 起）。
 */
function outputPathOf(sandbox: Sandbox, id = 'bg-1'): string {
  const magic: MagicHome = { home: sandbox.home, base: join(sandbox.home, '.magic') }
  return join(backgroundOutputDirOf(runPathsOf(magic, sandbox.dataDir, tmpdir())), `${id}.log`)
}

/** 敲一行字并**等它真出现在屏上**（文本与回车分两次写——挤在一次里会丢键）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/**
 * 一次裁决卡的答复——**逐张把它留在帧里**。
 *
 * 这一趟**一条规则都不加**（见文件头注），故每一次调用都会问一次：后台那一形要留下的
 * 证据正是「**它照旧过闸门**」。
 */
async function passCard(session: UiSession, label: string, answer: 'y' | 'a' = 'y'): Promise<void> {
  await waitCard(session)
  keep(await session.capture({ label }))
  await session.send(answer)
  // 等这一张真撤了再往下走——不等的话下一步的等待可能被**上一张的回执**满足
  // （`· 「…」等你定夺：read` 那一行留在屏上，「等你定夺」那四个字照旧在）
  await waitCardGone(session)
}

/**
 * 等**状态行**上出现「等你定夺」——⚠️ **不能拿全屏找这四个字代替**。
 *
 * 由头（本轮实测踩过）：那个短语**也在上一张卡的回执里**
 * （`· 「把这条构建交出去」等你定夺：read`），而回执写完就留在屏上 ⇒ 全屏找它会
 * **当场命中上一张的回执**，于是「y」在卡还没开出来的时候就写进了输入区，
 * 卡随后开出来、一直挂着（帧上留下一个 `› y` 的现场）。
 *
 * 状态行是**一格**（`statusLineOf` 取的就是它），卡撤了那一格就变了——故只有它够准。
 */
async function waitCard(session: UiSession, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const screen = await session.screen()
    if (statusLineOf(screen.lines.map((line) => line.text)).includes('等你定夺')) return
    await Bun.sleep(20)
  }

  throw new Error('等不到裁决卡——状态行一直没写到「等你定夺」')
}

/** 等那一张卡**真撤了**（状态行不再是「等你定夺」）。 */
async function waitCardGone(session: UiSession, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const screen = await session.screen()
    if (!statusLineOf(screen.lines.map((line) => line.text)).includes('等你定夺')) return
    await Bun.sleep(20)
  }

  throw new Error('那一张卡一直没撤')
}

/** 等这一轮真收束（状态行回到空闲）。 */
async function settled(session: UiSession): Promise<void> {
  await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 30_000 })
}

// ══ ① 起手那一形（交出去 · 跑完 · 读输出）════════════════════════════

async function startFrame(): Promise<void> {
  // 剧本**可变**：第三条（读输出）要知道那个路径，而路径要先有沙地才算得出（见文件头注）
  const turns: FixtureTurn[] = [
    {
      kind: 'tool',
      name: 'exec',
      args: { cmd: 'echo 起手; sleep 0.8; echo 收工', background: true },
      text: '这条命令交出去跑，我不占着这一轮。',
    },
    { kind: 'text', text: '交出去了，我先做别的。' },
  ]

  const fixture = startFixture({ turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const outputPath = outputPathOf(sandbox)
  // 第三条：**由「跑完」那一条唤醒**，模型用既有的 `read` 去读那个文件
  turns.push({
    kind: 'tool',
    name: 'read',
    args: { path: outputPath },
    text: '我去读一下它的输出。',
  })
  turns.push({ kind: 'text', text: '读到了，输出确实在文件里。' })

  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: 'u70-起手',
      artifacts: join(out, 'runs'),
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })

    await typeLine(session, '把这条构建交出去')
    await session.key('enter')

    // —— ① 带后台参数的调用**照旧弹卡**（反面那一句） ——
    await passCard(session, '01-裁决卡（后台那一形照旧过闸门）')

    // —— ② 交出去了：回执当场给模型，而这一轮**接着走** ——
    //
    // 锚取**模型接着说的那句**：命令还在跑（`sleep 0.8`），而这一轮已经往下走了——
    // 「不占着这一轮」在屏上就是这个样子。
    await session.wait({ text: '交出去了，我先做别的' }, { timeoutMs: 20_000 })
    const handed = await session.capture({ label: '02-交出去了（这一轮不占着）' })
    keep(handed)
    check(has(handed, '〔bg-1〕'), '② 回执那一行点着那个 id', handed.text)
    check(has(handed, '输出文件：'), '② 回执那一行点名输出文件', handed.text)
    check(
      has(handed, '交出去了，我先做别的'),
      '② **这一轮不占着**——命令还在跑，模型已经接着说话了',
      handed.text,
    )

    // —— ③ 跑完 ⇒ 自动多一条带那个路径的消息（给屏那一行） ——
    await settled(session)
    await session.wait({ text: 'bg-1 跑完了' }, { timeoutMs: 20_000 })
    const done = await session.capture({ label: '03-跑完那一声（给屏）' })
    keep(done)
    check(has(done, 'bg-1 跑完了'), '③ 屏上多了一行「跑完了」', done.text)
    check(has(done, `/bg/bg-1.log`), '③ 那一行带着**输出文件的路径**', done.text)

    // —— ④ 取输出：模型用**既有的 `read`** 读那个文件（它在工作区之外） ——
    //
    // 拨展开**走在这一次读之前**（见 `expand` 的注：定局之后拨不动）
    await expand(session)
    await passCard(session, '04-读输出的裁决卡（写的是「根外」）')
    await session.wait({ text: '读到了，输出确实在文件里' }, { timeoutMs: 20_000 })
    await settled(session)

    // 收起来那一行只报「几行」——**展开**才看得见读了什么（`ctrl+o`）。
    // 「贴出那条 read 的结果」要的就是展开后的这一屏。
    await session.send('\u000f')
    await Bun.sleep(400)
    const read = await session.capture({ label: '05-读输出（既有 read 读到了工作区外那个文件）' })
    keep(read)
    check(has(read, 'bg-1.log'), '④ 读的就是那个工作区之外的文件（路径在参数里）', read.text)
    check(hasLine(read, '起手'), '④ **读到了内容**（命令吐的第一行）', read.text)
    check(hasLine(read, '收工'), '④ 读到的是完整那一段（末行也在）', read.text)

    await session.quit()
    const closed = await session.close({ graceMs: 3_000 })
    check(closed.exit.by === 'app', '收摊：应用自己走的', String(closed.exit.by))
  } finally {
    session = undefined
    await fixture.stop()
    // **外借的那两件归借出方收**（见 `UiSessionOptions.sandbox`）：驱动不删它
    sandbox.dispose()
  }
}

// ══ ② dev server 那一形（永不结束 · 不发「跑完」· 文件接着长）══════════

async function serverFrame(): Promise<void> {
  // 一条**永不结束**的命令：先吐一行，之后每 0.4 秒长一行——「一直挂着」正是要取的那一形
  const ticks =
    'echo 服务起来了; i=1; while [ $i -le 40 ]; do sleep 0.4; echo tick-$i; i=$((i+1)); done; sleep 300'

  const turns: FixtureTurn[] = [
    { kind: 'tool', name: 'exec', args: { cmd: ticks, background: true }, text: '服务交出去挂着。' },
    { kind: 'text', text: '它没结束——我不会当它跑完了。' },
  ]

  const fixture = startFixture({ turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const outputPath = outputPathOf(sandbox)

  turns.push({ kind: 'tool', name: 'read', args: { path: outputPath }, text: '' })
  turns.push({ kind: 'text', text: '读了一遍。' })
  turns.push({ kind: 'tool', name: 'read', args: { path: outputPath }, text: '' })
  turns.push({ kind: 'text', text: '又读了一遍。' })

  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: 'u70-服务',
      artifacts: join(out, 'runs'),
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })

    await typeLine(session, '起一个一直跑的服务')
    await session.key('enter')
    await passCard(session, '06-服务的裁决卡')
    await session.wait({ text: '它没结束' }, { timeoutMs: 20_000 })
    await settled(session)

    // —— ⑤ 一直挂着：**没有**「跑完」那一声 ——
    await Bun.sleep(1_500)
    const alive = await session.capture({ label: '07-dev-server（挂着，没有「跑完」）' })
    keep(alive)
    check(has(alive, 'bg-1'), '⑤ 交出去了', alive.text)
    check(!has(alive, 'bg-1 跑完了'), '⑤ ⚠️ **没有**「跑完」那一声（它还在跑）', alive.text)

    // —— ⑤ 之一：read 那个文件，看得到此刻已有的输出 ——
    // 同上：展开要走在读之前（这一拨之后一直有效，第二遍读照旧看得见）
    await expand(session)
    await typeLine(session, '读一眼它的输出')
    await session.key('enter')
    await passCard(session, '08-读服务输出的裁决卡')
    await session.wait({ text: '读了一遍' }, { timeoutMs: 20_000 })
    await settled(session)
    // 收起来那一行只报「几行」——展开才看得见读了什么（同 ④ 那一处）
    await session.send('\u000f')
    await Bun.sleep(400)
    const first = await session.capture({ label: '09-第一次读（此刻已有的那一段）' })
    keep(first)
    check(hasLine(first, '服务起来了'), '⑤ 读得到开头那一行', first.text)
    const tickAtFirstRead = tickNumberOf(first)
    check(tickAtFirstRead >= 1, '⑤ 读得到计数器在长', first.text)

    // —— ⑤ 之二：过一会儿再读**同一份文件**，后面那段也读得到（文件一直在长） ——
    await Bun.sleep(2_000)
    await typeLine(session, '再看看它长到哪儿了')
    await session.key('enter')
    // ⚠️ **打字会把展开位收回**（`shell.ts` 的输入编辑那一支：`edit({…, expanded: false})`）
    // ——故每一次输入之后都要重拨一次，不然这一遍读出来的正文又收起来了
    await expand(session)
    await passCard(session, '10-再读一次的裁决卡')
    await session.wait({ text: '又读了一遍' }, { timeoutMs: 20_000 })
    await settled(session)
    await session.send('\u000f')
    await Bun.sleep(400)
    const again = await session.capture({ label: '11-再读一遍（后面新增的那段）' })
    keep(again)
    const tickAtSecondRead = tickNumberOf(again)
    check(
      tickAtSecondRead > tickAtFirstRead,
      '⑤ **文件一直在长**——第二遍读到的比第一遍多',
      `第一遍 tick-${tickAtFirstRead} · 第二遍 tick-${tickAtSecondRead}`,
    )

    await session.quit()
    const closed = await session.close({ graceMs: 3_000 })
    check(closed.exit.by === 'app', '收摊：应用自己走的', String(closed.exit.by))
  } finally {
    session = undefined
    await fixture.stop()
    sandbox.dispose()
  }
}

/**
 * 屏上出现过的**最大 tick 号**（`tick-12` → 12）；一个都没出现＝`0`。
 *
 * 取「最大」而不是「最后一行」：帧是**当时的屏**，滚进 scrollback 的那些也在 `history` 里。
 */
function tickNumberOf(shot: Capture): number {
  let max = 0
  for (const line of [...shot.history, ...shot.lines]) {
    for (const match of line.matchAll(/tick-(\d+)/gu)) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return max
}

// ══ ⑥ 停——按 id 停，落在**进程组**上（`pgrep` 实数）════════════════════
//
// 这一节的判据是**进程表**，不是屏——而「按 id 停」今天**没有用户入口**
// （`/ps` 那一屏另开一单，见工单）。故它不进真 PTY 那两趟，改在**进程内真链路**里做：
// 真装配（真沙箱 / 真闸门 / 真记录 / 真对话域）＋ 假外壳，拿 `assembly.background` 那个把手
// 按 id 停，再把 `pgrep` 的**前后两行实数**留成证据。

async function stopEvidence(): Promise<void> {
  const stage = makeStage()
  const lines: string[] = []

  const say = (line: string): void => {
    lines.push(line)
    console.log(line)
  }

  try {
    const assembly = stage.assemble({
      // ⚠️ 这一节走的是 **Faux**（进程内台词），剧本形态与上面那两趟的 HTTP 夹具不同：
      // 一回合 = 一段工具调用 / 一段正文（见 `@magic/faux` 的 `FauxTurn`）。
      turns: [
        // **命令自己再起一个**（孙进程）——「按组收」收的就是它
        { toolCalls: [{ name: 'exec', args: { cmd: 'sleep 300 & sleep 300', background: true } }] },
        { text: '交了。' },
      ],
    })
    const shell = attachShell(assembly.shell)

    await shell.submit('起一条带孙进程的后台命令')
    await Bun.sleep(400)

    const background = assembly.background
    if (background === undefined) throw new Error('这次装配没接后台那一形')

    const pgid = assembly.ledger.list()[0]?.pgid
    if (pgid === undefined) throw new Error('归属账上没有这一组——记账那一跳没走到')

    const before = pids(pgid)
    say(`停之前：进程组 ${pgid} 里有 ${String(before.length)} 个进程 —— ${before.join(' ')}`)
    check(before.length >= 2, '⑥ 组里有**不止一个**（命令 ＋ 它起的孙进程）', before.join(' '))

    const stopped = await background.stop('bg-1')
    say(`停的结果：${JSON.stringify(stopped)}`)
    check(stopped.ok, '⑥ 按 id 停得掉', JSON.stringify(stopped))

    // 组没了这一下要等一下（SIGKILL 之后进程表更新有一瞬）
    await Bun.sleep(300)
    const after = pids(pgid)
    say(`停之后：进程组 ${pgid} 里有 ${String(after.length)} 个进程 —— ${after.join(' ')}`)
    check(after.length === 0, '⑥ ⚠️ **孙进程也没了**（组里一个都不剩）', after.join(' '))

    shell.dispose()
    assembly.close()
  } finally {
    writeFileSync(join(out, '12-按id停（进程组实数）.txt'), `${lines.join('\n')}\n`, 'utf8')
    stage.dispose()
  }
}

/** 那个进程组里现在有哪些进程（`pgrep -g`）——「收干净了没有」的**唯一**判据。 */
function pids(pgid: number): readonly string[] {
  const done = Bun.spawnSync(['pgrep', '-g', String(pgid)], { stdout: 'pipe', stderr: 'ignore' })
  return new TextDecoder()
    .decode(done.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u70-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    console.log('\n══ ① 起手那一形（交出去 · 跑完 · 取输出）══')
    await startFrame()
    console.log('\n══ ② dev server 那一形（永不结束）══')
    await serverFrame()
    console.log('\n══ ⑥ 按 id 停（进程组实数）══')
    await stopEvidence()
    console.log(`\n帧落在 ${out}`)
  } catch (error) {
    writeFileSync(join(out, 'ERROR.txt'), `${String(error)}\n`, 'utf8')
    throw error
  }
}
