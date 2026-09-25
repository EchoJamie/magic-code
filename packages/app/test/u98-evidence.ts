#!/usr/bin/env bun
/**
 * U98 · **真进程证据**——「没人看着的那条会话跑完之后，那一跳到底发没发出去」。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它要让那一条会话在**没有任何窗口看着**
 * 的状态下出事（怎么造出那一形见 `unwatchedTurn` 的注），还要在整趟里盯着**进程表**
 * ——放进常规门里既慢又脆。
 *
 * ## 为什么非要真进程
 *
 * 本单的根子正在**进程边界**上：管者那一层有个注入点（`notifySystem`），而
 * `packages/app/src/run/spawn-manager.ts` 起的那一具是**真子进程**——它没有注入点，
 * 一律落到**缺省那一格**。故「缺省发不发」这件事，**进程内量不到**（进程内的用例把端口
 * 注掉了，量的是注入的那一个），只有真链路到屏为止这一趟算数。
 *
 * ## 一趟做什么（`--expect` 决定判哪一边）
 *
 * | `--expect` | 造的是什么 | 判据 |
 * | --- | --- | --- |
 * | `some`（**尺子自校 · 复现旧形**） | 同一趟，但**代码是修前那一份** | **见证非空**——那一跳真的把话递出去了 |
 * | `none`（**修后**） | 修后那一份 | **见证空** ＋ **进程表里一条都没有** |
 *
 * 两趟都把**同一句通知话术**（`有一件工作出错了——打开看是哪条`，三类通知都带那半句）
 * 当记号：见证那一行、进程表那一笔，指的都是它。
 *
 * 两趟用的是**同一支装置**（同一份 `--shadow` / `--witness`），故「空」不是「没量着」。
 *
 * ## 见证与进程表（两把尺子，各说各的话）
 *
 * - **见证**——`--shadow <目录>`：子进程的 `PATH` **前置**一个目录。那一支要是借外部命令
 *   把通知递出去，`PATH` 一解析就先落到这儿——那是个**记账用的假**：把收到的参数
 *   一字不落追加进 `--witness <文件>`。**它决定「发没发」**（确定性：起没起进程都留痕）。
 * - **进程表**——整趟按几十毫秒的间隔取样 `ps -ax -o pid,ppid,command`，凡是命令行里带着
 *   `--needle <串>` 或 `argv[0]` 落在 `--shadow` 里的，各记一笔（**连 ppid 一起**：
 *   「是谁起的」与「起了什么」一样是判据）。它是工单要的那一件物证
 *   （「同一趟 `ps -ax` 里没有」），也是**人从上往下读的那一份**。
 *
 * ⚠️ **`--shadow` 的缺口如实说**：`PATH` 前置只咬得住**按名字找**的那种起法。要是哪一天
 * 有人**写死绝对路径**，影子就落了空——故**判断以见证为准**，进程表是佐证。
 *
 * ⚠️ 这一支**不碰用户真实的 `~/.magic`**：`HOME` / 工作区 / 数据都在 `mkdtemp` 出来的
 * 沙地里，模型那一头是 loopback 夹具（合成的假 key，一个付费请求都不发）。
 *
 * 跑法：
 *
 * ```
 * bun packages/app/test/u98-evidence.ts --out <目录> [--shadow <目录>] [--witness <文件>] \
 *   [--needle <串>] --expect <none|some>
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandbox, createUiSession, startFixture } from './ui/index.ts'
import type { UiSession } from './ui/index.ts'
import { runPathsOf } from '../src/run/paths.ts'

// ═══════════════════════════════════════════════════════════════════════
// 参数与记账
// ═══════════════════════════════════════════════════════════════════════

const argv = process.argv.slice(2)
const argOf = (name: string): string | undefined => {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

const outArg = argOf('--out')
const expectArg = argOf('--expect') ?? 'none'
if (outArg === undefined) {
  throw new Error('跑法：bun packages/app/test/u98-evidence.ts --out <目录> --expect <none|some>')
}
if (expectArg !== 'none' && expectArg !== 'some') throw new Error(`--expect 只认 none / some，收到 ${expectArg}`)

const out: string = outArg
const expect: 'none' | 'some' = expectArg
const shadow: string | undefined = argOf('--shadow')
const witness: string | undefined = argOf('--witness')
const needle: string | undefined = argOf('--needle')
/** 留现场（不收沙地）——读数对不上时用它进那块沙地看（正常跑不留）。 */
const keep = argv.includes('--keep')
mkdirSync(out, { recursive: true })

/** 一条判据的结论——**不过就记账**（跑完再退非零）。 */
const failures: string[] = []
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail === '' ? '' : `（${detail}）`}`)
  if (!ok) failures.push(what)
}

/** 这一趟会说不完的那一句——夹具那几段拼起来够长，换页发生在这中间。 */
const LONG = '这一句会慢慢长出来：先是一半，然后才是另一半，最后才收尾。关窗就发生在这中间。'

// ═══════════════════════════════════════════════════════════════════════
// 进程表取样（`ps`）
// ═══════════════════════════════════════════════════════════════════════

type Sampler = {
  /** **这一摊的**命中（去重）——整趟见过就算。 */
  readonly hits: readonly string[]
  /** 命中了、但不是这一摊的（**别人机器上的动静**，如另一支 `bun test`）——分开记，别混。 */
  readonly others: readonly string[]
  /** 取的样数（证明这把尺子真的在转）。 */
  readonly samples: number
  stop(): void
}

/**
 * 一行 `ps -o pid,ppid,command` → 命令行那一截（去掉前导的 pid 与 ppid）。
 *
 * ⚠️ **ppid 要有**：命中一行时，「**是谁起的**」与「起了什么」一样是判据的一部分
 * （起它的是管理者，不是这个装置自己——那正是本单根子的那一具进程）。
 */
function commandOf(line: string): string {
  const trimmed = line.trim()
  const parts = trimmed.split(/\s+/u)
  return parts.slice(2).join(' ')
}

/**
 * 起一把**一直在转**的尺子——按 `everyMs` 取样 `ps -ax -o pid,ppid,command`。
 *
 * 判「命中」看两处：**命令行里带着 `needle`**（工单那一句物证），或 **`argv[0]` 落在
 * `shadow` 里**（影子目录下起的东西——`PATH` 一解析就落到那儿）。
 *
 * ⚠️ **本装置自己与它的祖先要排掉**：`--needle` 是**打在这条命令行上**的，不排的话
 * 每一次取样都「命中」自己——那把尺子就成了一根永远为真的针（U87 记过这一族）。
 *
 * ⚠️ **「命中」还要分是不是这一摊的**：这台机器上**别人也在起同名的外部命令**
 * （实测：另一支 `bun test`、一个 Clash Verge 的安装器都起过）。不分开的话，
 * 「修后一条都没有」会被别人的动静弄红，而这个「红」说明不了产品什么事。
 * 认法：**命令行落在影子目录里**，或**起它的那个进程带着沙地根**（管理者那一句就带着）。
 */
function startSampler(o: {
  readonly shadow?: string | undefined
  readonly needle?: string | undefined
  readonly owner: string
  readonly everyMs: number
}): Sampler {
  const hits = new Set<string>()
  const others = new Set<string>()
  const mine = new Set([String(process.pid), String(process.ppid)])
  let samples = 0
  let running = true

  const sweep = async (): Promise<void> => {
    try {
      const proc = Bun.spawn(['ps', '-ax', '-o', 'pid,ppid,command'], { stdout: 'pipe', stderr: 'ignore' })
      const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
      await proc.exited
      samples += 1

      const lines = text.split('\n').filter((line) => line.trim() !== '')
      /** 快照里每个号对应哪一条——命中的那一条要问一句「**是谁起的**」。 */
      const byPid = new Map<string, string>()
      for (const line of lines) {
        const fields = line.trim().split(/\s+/u)
        byPid.set(fields[0] ?? '', line.trim())
      }

      for (const line of lines) {
        const fields = line.trim().split(/\s+/u)
        const pid = fields[0] ?? ''
        if (mine.has(pid)) continue
        const command = commandOf(line)
        if (command === '') continue
        const byNeedle = o.needle !== undefined && o.needle !== '' && command.includes(o.needle)
        const byShadow = o.shadow !== undefined && command.startsWith(o.shadow)
        if (!byNeedle && !byShadow) continue

        const parent = byPid.get(fields[1] ?? '') ?? ''
        const line2 = parent === '' ? line.trim() : `${line.trim()}   ← 起它的那个：${parent}`
        const ours = byShadow || parent.includes(o.owner) || command.includes(o.owner)
        if (ours) hits.add(line2)
        else others.add(line2)
      }
    } catch {
      // 取样失败不算判据失败——它只是一把佐证的尺子（见证那一把才是决定性的）
    }
  }

  const timer = setInterval(() => {
    if (!running) return
    void sweep()
  }, o.everyMs)

  return {
    get hits() {
      return [...hits]
    },
    get others() {
      return [...others]
    },
    get samples() {
      return samples
    },
    stop() {
      running = false
      clearInterval(timer)
    },
  }
}

/** 等一个条件成立（默认 20 秒）。 */
async function waitFor(what: string, ok: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await ok()) return true
    await Bun.sleep(50)
  }
  console.log(`  （等不到：${what}）`)
  return false
}

/** 屏上有没有那句话（按行找）。 */
async function screenHas(session: UiSession, part: string): Promise<boolean> {
  const screen = await session.screen()
  return screen.lines.some((line) => line.text.includes(part))
}

// ═══════════════════════════════════════════════════════════════════════
// 那一趟
// ═══════════════════════════════════════════════════════════════════════

/** 读一个文件，读不到给空串（判据自己判「有没有」）。 */
function readOr(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 那一摊里此刻站着的执行者（按沙地根认，见 `u50-evidence.ts` 的同名手法）。 */
async function executatorsIn(root: string): Promise<string[]> {
  const proc = Bun.spawn(['pgrep', '-fl', root], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited
  return text.split('\n').filter((line) => line.trim() !== '' && line.includes('internal-executor'))
}

/** 一行 `pgrep -fl` 里的进程号（第一个字段）。 */
function pidOf(line: string): number {
  return Number(line.trim().split(/\s+/u)[0])
}

/**
 * 那一条会话**出事**、而**没有任何窗口看着它**——整趟的现场与读数。
 *
 * ## 那一形怎么造出来（三条路，量过两条走不通）
 *
 * 判据那一句话是「**没有窗口正看着这条会话**」，而它在实现上是
 * `watchersOf(session) === 0`：**已经结束的那一代不算看客**（`manager.ts` 那条注——窗口的
 * 目标还停在一代收摊了的运行上时，他看的其实是那个窗口自己的屏）。真 PTY 里造这一形
 * 有三条路，前两条本单都量过：
 *
 * - ❌ **关掉唯一那扇窗**：执行者随即收摊，那一轮记 `aborted`（`runs.json` 里
 *   `why: "连接断了"`），而**中断不报通知**。造出来的不是「没人看着跑完」，是
 *   「没人看着被打断」——**它压根不经过那一跳**；
 * - ❌ **换页**（`/clear`）：界面**当场回绝**——「正在跑一轮——先 Ctrl+C 中断，再切会话」
 *   （帧在 `01-…txt` 里）。跑着的时候切不走，故窗口一直看着它；
 * - ✅ **杀那一代**（本趟用的）：那一轮**真出事了**（`crashed` → `failed` 那一类），
 *   而**结束的那一代按定义不算看客** ⇒ 那一跳照走。这正是用户报的那一形：
 *   他不在看那条会话的时候，桌面上蹦出一条「有一件工作出错了」。
 *
 * ⚠️ 这条路的反面也如实说：它量的是**「出错」那一类**。三类的判据同一把尺子
 * （U86），而「跑完了」那一类要真进程里造出「没人看着跑完」**今天没有干净的造法**
 * ——把这一点写进回报，不装作量过。
 */
async function unwatchedTurn(): Promise<void> {
  const fixture = startFixture({
    // 一轮够长（六十段、每段 400ms）——动手要发生在这中间，那才是「它还在跑」
    turns: [{ kind: 'text', text: LONG, chunks: 60, chunkDelayMs: 400 }],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })

  // **影子前置进 `PATH`**——要先于窗口子进程建出来（子进程的环境在起手那一刻就定了）
  if (shadow !== undefined) {
    sandbox.env['PATH'] = `${shadow}:${sandbox.env['PATH'] ?? ''}`
    console.log(`· 影子：${shadow} 已前置进子进程的 PATH`)
    if (witness !== undefined) console.log(`· 见证：${witness}（追加式，跑前那几行也在）`)
  }

  const paths = runPathsOf(
    { home: sandbox.home, base: join(sandbox.home, '.magic') },
    sandbox.dataDir,
    tmpdir(),
  )
  /**
   * **未读那一份在哪儿**——先按三方共用的算法算，算出的那处不在时**在沙地里找一遍**。
   *
   * ⚠️ 不这么办的话，路径算法哪天挪一格，这一趟会**静默读成「什么都没发生」**，
   * 而读数上分不出「没发生」与「找错地方了」。
   */
  const noticesAt = (): string => {
    if (existsSync(paths.notices)) return paths.notices
    for (const found of new Bun.Glob('**/notices.json').scanSync({ cwd: sandbox.root, absolute: true })) return found
    return paths.notices
  }

  const sampler = startSampler({ shadow, needle, owner: sandbox.root, everyMs: 25 })
  let session: UiSession | undefined

  try {
    const win = await createUiSession({
      label: 'U98证据-没人看着跑完',
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
      artifacts: join(out, 'runs'),
    })
    session = win

    // ① 交代一件事，让那一轮跑起来
    await win.send('长话', { until: { text: '长话' }, timeoutMs: 15_000 })
    await win.key('enter')
    const streaming = await waitFor('开始流式', () => screenHas(win, '这一句会慢慢长出来'), 40_000)
    check(streaming, '那一轮真跑起来了（有东西可以被「没人看着」）')

    const before = await win.capture({ label: '01-动手之前' })
    writeFileSync(join(out, '02-动手之前.txt'), `${before.text}\n`, 'utf8')

    // ② **找到那一代的进程号**——杀的是它的进程，不是叫管理者去停
    //    （叫停那一档记的是「用户自己按的」，本单要的是**出事**）
    const found = await waitFor('执行者进程站着', async () => (await executatorsIn(sandbox.root)).length > 0)
    const standing = await executatorsIn(sandbox.root)
    check(found, '那一代的进程真站着', standing[0] ?? '（没找到）')
    if (standing[0] === undefined) return

    // ③ **一记 SIGKILL**——那一轮到此为止是「出事」（`crashed`），而结束的那一代不算看客
    console.log(`\n· 杀掉那一代（pid ${pidOf(standing[0])}）——它出事，而窗口看的还是这一页\n`)
    process.kill(pidOf(standing[0]), 'SIGKILL')

    // ④ 未读落盘就是「那一跳走到了」的信号（这一半 U98 一字未动）
    const landed = await waitFor(
      '未读落盘（那一跳走到了）',
      () => readOr(noticesAt()).includes('"unread": true') || readOr(noticesAt()).includes('"unread":true'),
      30_000,
    )
    check(landed, '它出事之后，未读**落了盘**（这一半 U98 一字未动）')

    // 多留一歇：收尾那几跳（写盘、缩窗口）都落定之后再看读数
    await Bun.sleep(2_000)

    const notices = readOr(noticesAt())
    writeFileSync(join(out, '03-未读那一份.json'), `${notices}\n`, 'utf8')

    const after = await win.capture({ label: '04-出事之后' })
    writeFileSync(join(out, '04-出事之后.txt'), `${after.text}\n`, 'utf8')

    // ④ 读数
    sampler.stop()
    console.log(`\n· 进程表取样 ${sampler.samples} 次`)
    writeFileSync(
      join(out, '04-进程表.txt'),
      `取样 ${sampler.samples} 次（每 25ms 一次，整趟）\n` +
        `**这一摊的**命中 ${sampler.hits.length} 条：\n${sampler.hits.join('\n')}\n\n` +
        `这一摊之外的命中 ${sampler.others.length} 条（别人机器上的动静，不算在判据里）：\n` +
        `${sampler.others.join('\n')}\n`,
      'utf8',
    )
    for (const hit of sampler.hits) console.log(`  ！${hit}`)
    if (sampler.hits.length === 0) console.log('  （这一摊整趟一条都没有）')
    for (const hit of sampler.others) console.log(`  ·（不是这一摊的）${hit}`)

    const seen = witness === undefined ? '' : readOr(witness)
    const lines = seen.split('\n').filter((line) => line.trim() !== '')
    writeFileSync(join(out, '05-见证.txt'), `读过 ${witness ?? '（没给）'}：${lines.length} 行\n\n${seen}\n`, 'utf8')
    console.log(`· 见证文件：${lines.length} 行`)

    // ⑤ 判
    if (expect === 'some') {
      check(lines.length > 0, '【尺子自校】修前那一份**真把话递出去了**（见证记到了）')
      check(sampler.hits.length > 0, '【尺子自校】进程表里也**看得见**它')
    } else {
      check(lines.length === 0, '修后：见证**一行都没有**（那一条路一次都没走）', `${lines.length} 行`)
      check(sampler.hits.length === 0, '修后：整趟进程表里**一条都没有**')
    }
  } finally {
    if (session !== undefined) await session.close({ graceMs: 3_000 }).catch(() => undefined)
    sampler.stop()
    await fixture.stop().catch(() => undefined)
    if (keep) console.log(`· 现场留着：${sandbox.root}`)
    else sandbox.dispose()
  }
}

if (import.meta.main) {
  console.log(`U98 真进程证据——expect=${expect}`)
  await unwatchedTurn()

  console.log('')
  if (failures.length > 0) {
    console.log(`有 ${failures.length} 条没过：`)
    for (const what of failures) console.log(`  ✗ ${what}`)
    process.exit(1)
  }

  console.log('这一趟的判据全过。')
}
