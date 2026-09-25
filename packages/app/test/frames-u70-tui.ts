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
 * | ① | 照旧过闸门 | 带 `background` 的调用**照样弹卡**（后台不是绕过裁决的口子）——命令里带一段 `rm`（**名单里那一条**，U76 起名单只剩两条），那一张卡照出 |
 * | ② | 发起 | `✓ … 已交出去，这一轮不等它：bg-1` ＋ 输出文件路径；模型**接着说话** |
 * | ③ | 跑完 ⇒ 给屏那一声 | `· bg-1 跑完了（exit 0）· …`（**带那个路径**） |
 * | ④ | 取输出 | 模型用**既有的 `read`** 读那个文件（它在**工作区之外**），读出内容——**不弹卡**（读判轻） |
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
 *   加规则＝把要验的东西验没了。⚠️ 这句话的射程 U76 起变小了：**默认通**之下还该弹的
 *   只剩**名单里那一段**（下一节），"该不该问"由命令自己说了算——本支照旧一条规则不加。
 *
 * ## ⚠️ U76 起：这个装置里的卡只剩一张
 *
 * 链的底从「默认问」翻成「**默认通**」——判轻的（读 · 只读命令 · 判不出来的）**不问**，
 * 名单收缩到**两条**（删除 · 改权限 / 属主 / 属性 / ACL，且射程只到 `exec`）。故：
 *
 * - **① 那一张卡要靠「命令里带一段名单里的动作」造出来**（这里用 `rm -rf build`）——
 *   后台那一形照旧过闸门这件事**一个字没松**，松的是"哪些命令要问"；
 * - 其余几屏（②③ 的发起 · ④ 的取输出 · ⑤ 的两次读）从前的卡**只是推进流程的手段**，
 *   如今一律换成**等工具真跑完**（模型那一句答复 ＝ 它收到了工具结果）。
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
 * 一次裁决卡的答复——**逐张把它留在帧里**，并把它交回给调用方判内容。
 *
 * ⚠️ **U76 起这个装置里只剩一张卡**（① 那一张：命令里带了一段名单里的动作）。
 * 答复写 `y`（批准这一次）——`a`（「总是允许」）在**必闸类上是划掉的**（`decision.ts`），
 * U76 起它只在**取网**那件上按域名给（U72）。
 */
async function passCard(session: UiSession, label: string, answer: 'y' | 'a' = 'y'): Promise<Capture> {
  await waitCard(session)
  const card = await session.capture({ label })
  keep(card)
  await session.send(answer)
  // 等这一张真撤了再往下走——不等的话下一步的等待可能被**上一张的回执**满足
  // （`· 「…」等你定夺：read` 那一行留在屏上，「等你定夺」那四个字照旧在）
  await waitCardGone(session)

  return card
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

/**
 * 判「这一趟**没有卡**」——判轻的调用**默认通**（U76 链的底换了），屏上什么都不该多。
 *
 * ⚠️ **不能拿全屏找「等你定夺」代替**：那四个字**也在旧卡的回执行里**
 * （`· 「把这条构建交出去」等你定夺：exec`，见 `waitCard` 那条注），回执写完就留在屏上
 * ⇒ 一场里只要开过一张卡，后面每一帧都命中它（U70 的 ④ 就这么**假红**了一回：
 * 屏上那句是 ① 那张卡的回执，卡早收了、状态行也早归位了）。
 *
 * 够准的两件：**卡自己的东西不在**（键位行 `y 批准` 只在卡上——屏上没有它就说明没卡）
 * ＋ **状态行不是裁决态**（那一格说的是「此刻」，卡撤了就变回「工作中 / 空闲」）。
 * ⚠️ 键位提示**两串都要判**（轻 `y / a / n` · 重 `y / n`，`HINT_DECIDE_LIGHT / HEAVY`）：
 * 只判 `y / n` 会把轻卡放过去（`y / a / n` 里没有连续的 `y / n`）。
 */
function noCardHere(shot: Capture, what: string): void {
  const status = statusLineOf(shot.lines)
  check(!has(shot, 'y 批准'), `${what}：**没有卡**（卡上的键位行不在——判轻的默认通）`, shot.text)
  check(
    !status.includes('等你定夺') && !status.includes('y / n') && !status.includes('y / a / n'),
    `${what}：状态行也不是裁决态（根本没问）`,
    status,
  )
}

/** 等这一轮真收束（状态行回到空闲）。 */
async function settled(session: UiSession): Promise<void> {
  await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 30_000 })
}

// ══ ① 起手那一形（交出去 · 跑完 · 读输出）════════════════════════════

async function startFrame(): Promise<void> {
  // 剧本**可变**：第三条（读输出）要知道那个路径，而路径要先有沙地才算得出（见文件头注）
  //
  // ⚠️ **命令开头那一段 `rm -rf build` 是装置上的讲究**（U76）：判轻的调用**默认通、
  // 不弹卡**（链的底换了），而本屏要留的正是「**带 `background` 的调用照旧过闸门**」——
  // 故命令里必须有一段**名单里的动作**（U76 起名单只剩两条：删除 · 改权限/属主/属性/ACL）。
  // 它不影响后面几屏：输出照旧是 `起手` / `收工` 那两行，交出去的号照旧是 `bg-1`。
  // `sleep 2`（原 0.8）是给「交出去 → 模型接着说下一句」留足余量（命令得**还在跑**）。
  const turns: FixtureTurn[] = [
    {
      kind: 'tool',
      name: 'exec',
      args: { cmd: 'rm -rf build; echo 起手; sleep 2; echo 收工', background: true },
      text: '这条命令交出去跑，我不占着这一轮。',
    },
    { kind: 'text', text: '交出去了，我先做别的。' },
  ]

  const fixture = startFixture({ turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const outputPath = outputPathOf(sandbox)
  // 让那一段 `rm` **真删掉点东西**（卡上说的事要在沙地里真发生）——`-f` 之下删不存在的
  // 也不报错，但「这一下真删了一棵目录」经得起看
  mkdirSync(join(sandbox.workspace, 'build'), { recursive: true })
  writeFileSync(join(sandbox.workspace, 'build', '产物.txt'), 'U70 的构建产物\n', 'utf8')
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

    // —— ① 带后台参数的调用**照旧弹卡**（反面那一句）——卡上点得出名单里那一段 ——
    const card = await passCard(session, '01-裁决卡（后台那一形照旧过闸门）')
    check(
      has(card, 'rm -rf build —— 删除（不可逆）'),
      '① 卡上点名的正是**名单里那一段**——后台不是绕过裁决的口子（命令分解照列）',
      card.text,
    )
    check(has(card, '判据：不可逆（收不回）'), '① 判据那一行说得出为什么问', card.text)

    // —— ② 交出去了：回执当场给模型，而这一轮**接着走** ——
    //
    // 锚取**模型接着说的那句**：命令还在跑（`sleep 2`），而这一轮已经往下走了——
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
    // ⚠️ **这一拨的时机 U76 起变了**（见 `expand` 的注：定局之后拨不动）：
    // 从前那张「读输出」的卡挡在读前面，卡挂着的时候拨**一定**来得及；如今读**不问**
    // （判轻的默认通），而它是被「跑完」那一声**唤醒**的——故这一拨要赶在那一句
    // 落地**之前**（命令还在 `sleep 2` 里，窗口够宽）。轮 1 的行这时已经定局
    // （`settled` 等到了空闲），故这一拨**不会改动 02 / 03 两帧**。
    await expand(session)
    await session.wait({ text: 'bg-1 跑完了' }, { timeoutMs: 20_000 })
    const done = await session.capture({ label: '03-跑完那一声（给屏）' })
    keep(done)
    check(has(done, 'bg-1 跑完了'), '③ 屏上多了一行「跑完了」', done.text)
    check(has(done, `/bg/bg-1.log`), '③ 那一行带着**输出文件的路径**', done.text)

    // —— ④ 取输出：模型用**既有的 `read`** 读那个文件（它在工作区之外） ——
    //
    // ⚠️ **这一趟不弹卡**（读判轻——U76 起默认通；根外的**读**也不在必闸里：越界那一条
    // 管的是「工作区外的写 / 删 / 移」）。从前的卡只是推进流程的手段，如今等**工具真跑完**
    // （模型当时那一句答复）就够。
    await session.wait({ text: '读到了，输出确实在文件里' }, { timeoutMs: 20_000 })
    const noCard = await session.capture({ label: '04-读输出不弹卡（默认通）' })
    keep(noCard)
    noCardHere(noCard, '④ 取输出那一趟')
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
    // ⚠️ **这一笔不弹卡**（U76：`exec` 判轻的默认通——这条命令一段都不在名单里；
    // 而①那一张卡照出的原因在**命令里带了 `rm`**，不是"后台"这件事）。
    // 从前那张卡只是推进流程的手段，如今**等回执那一行**（`〔bg-1〕…`）＝真交出去了。
    await session.wait({ text: '〔bg-1〕' }, { timeoutMs: 20_000 })
    const handed = await session.capture({ label: '06-服务交出去不弹卡（默认通）' })
    keep(handed)
    noCardHere(handed, '⑥ 交出去那一趟')
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
    await typeLine(session, '读一眼它的输出')
    // ⚠️ **展开位要赶在这一遍读渲染之前拨**（`expand` 的注：行一定局就重画不动了）：
    // 从前拨在这张卡挂着的时候（卡挡在读前面，一定来得及），如今读**不问**（U76）——
    // 而打字**不会**把这一格收回（`shell.ts` 里写 `expanded: false` 的只有「`esc` ＋ 空稿」
    // 那一支，3240 行），故这一拨就落在**回车之前**；拨完一直有效，第二遍读照旧看得见
    await expand(session)
    await session.key('enter')
    // ⚠️ 读不问（U76）——等工具真跑完（模型那一句答复）就够，没有卡可等
    await session.wait({ text: '读了一遍' }, { timeoutMs: 20_000 })
    const readOnce = await session.capture({ label: '08-读一眼不弹卡（默认通）' })
    keep(readOnce)
    noCardHere(readOnce, '⑤ 读那一眼')
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
    // ⚠️ **展开位要在这一遍读执行之前拨**（`expand` 的注：定局之后拨不动）——
    // （原注说「打字会把展开位收回」：照 `shell.ts` 看**不成立**——写 `expanded: false` 的
    // 只有「`esc` ＋ 空稿」那一支。位置照原样留着：它落在读执行之前，那才是要紧的。）
    // 从前有一张卡挡在读前面，卡挂着的时候拨一定来得及；如今读**不问**（U76），
    // 故这一拨紧跟着回车落下去（它只是个视图开关，不挡任何东西）。
    await expand(session)
    // ⚠️ 读不问（U76）——等工具真跑完（模型那一句答复）就够
    await session.wait({ text: '又读了一遍' }, { timeoutMs: 20_000 })
    const readTwice = await session.capture({ label: '10-再读不弹卡（默认通）' })
    keep(readTwice)
    noCardHere(readTwice, '⑤ 第二遍读')
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
