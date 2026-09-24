/**
 * U32 · **留帧装置**（返工那一轮）——「扣下的调用在屏上什么样」与「`--check` 那几行」，
 * 落成可核对的帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。用途只有一个：**外观那一关看帧**——
 * 判据（拦没拦、送没送、有没有幽灵）归 `rules.test.ts`，这里把**用户看得见的那一屏**
 * 落成文本与原始字节，好让人**从上到下一行行读**（`AGENTS.md`·工作模式：「看图」是四项：
 * 布局 · 文案 · 层级 · 通读）。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真装配（`assemble` → 真沙箱 · 真记录 · 真对话域）→ 真外壳（`runTui`，真 Ink）→
 * 真字节（假 TTY 记下写出的每一个字节）。模型那一头是 **Faux**（假端点回放），
 * 故**一个付费请求都不发**；沙地的 `HOME` / `dataDir` / `grants` 全在临时目录里
 * （`makeStage`），**真 `~/.magic` 零触碰**。
 *
 * ⚠️ **为什么帧在这一侧（app）出**：要的那一屏是「装配跑起来之后外壳画什么」——
 * 对话域与装配都在这一侧；`.claude/rules` 那条链过去，本包的用例**不得**相对引用
 * `@magic/tui` 的内部件（`test/scaffold.test.ts` 那条结构守护），故只用它的**公开面**
 * （`runTui` / `createShell`）与 `cli.ts` 的 `tuiOptions`（照 `window.test.ts` 的先例）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-rules.ts --out <目录>
 * ```
 *
 * 出十四份：`check.txt` ＋ `check-broken-agents.txt` ＋ `check-unreadable.txt` ＋
 * `check-source-unreadable.txt`（`--check` 那四屏的字——分别是首轮那份读数 · **根 `AGENTS.md`
 * 断链**那两条诊断 · **规则目录读不动**那一条 · **五轮：点名的补充来源读不动**那一条）·
 * `hold.txt` ＋ `hold.ansi`（扣下那一次的外壳屏）· `overflow.txt` ＋ `overflow.ansi`
 * （材料没读完整而停批那一屏）· `unreadable.txt` ＋ `.ansi`（**目录 000 那一次的外壳屏**，
 * 同一会话里权限还回来之后接着写成了——**读不动的零副作用与读回来照常推进**在一条时间线上）·
 * `source-unreadable.txt` ＋ `.ansi`（**五轮：点名来源 000 那一次的外壳屏**，同一条时间线上
 * 的零副作用与恢复后写成——与 `unreadable` 是同一条链的另一个入口）·
 * `executed-failure.txt` ＋ `.ansi`（**真跑失败、首行恰是「未执行…」**那一屏——「没跑」与
 * 「跑了没成」分不分得开看它）。`.ansi` 是外壳写出的**原始字节**（带色：颜色与字重只能从
 * 字节上看）。
 */

import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachShell } from '../src/index.ts'
import type { Assembly } from '../src/index.ts'
import { tuiOptions } from '../src/cli.ts'
import { makeStage } from './support.ts'
import type { StageAssembleOptions } from './support.ts'
import { removeDir, tempDir, validConfig } from './tmp.ts'

/** 剥掉 ANSI 与 OSC——「屏上的字」读它（与 `window.test.ts` 同一个正则口径）。 */
function visible(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9:;<=>?]*[@-~]/g, '')
}

/** 假终端——记下写出的每一个字节（`runTui` 只查 `isTTY`；Ink 要窗口尺寸）。 */
class CaptureTty extends EventEmitter {
  readonly isTTY = true
  readonly destroyed = false
  readonly writableEnded = false
  readonly columns = 100
  readonly rows = 30
  private readonly chunks: string[] = []

  write = (chunk: string): boolean => {
    this.chunks.push(String(chunk))
    return true
  }

  bytes(): string {
    return this.chunks.join('')
  }
}

/** 假 stdin——Ink 挂 `'readable'` 之后自己 `read()` 取件（攒队列 ＋ 报 readable）。 */
class FakeStdin extends EventEmitter {
  readonly isTTY = true
  private readonly queue: string[] = []

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => this.queue.shift() ?? null

  push(text: string): void {
    this.queue.push(text)
    this.emit('readable')
  }
}

/** 等屏上出现这段话；等不到就如实报出此刻的屏。 */
async function until(tty: CaptureTty, needle: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (visible(tty.bytes()).includes(needle)) return
    await Bun.sleep(10)
  }

  throw new Error(`等不到「${needle}」——此刻屏上是：\n${visible(tty.bytes())}`)
}

/** 摆一份文件（中间目录自动建）。 */
function put(where: string, relative: string, text: string): string {
  const path = join(where, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

/**
 * 留一屏——真装配 → 真外壳 → 交一句给驱动 → 等屏上出现某句话 → 收字节。
 *
 * 外壳那几屏共用这一手（下面那些函数只管**摆沙地与等哪句话**）：收取那一段一模一样——
 * 写字节、落一份剥过 ANSI 的字、等着收尾。多抄两遍就是几处一起改的账。
 */
async function shoot(
  assembly: Assembly,
  prompt: string,
  waitFor: string,
  out: string,
  name: string,
  /**
   * 第二趟（可选）——拍「同一会话里条件变了之后」的下一屏（如权限还回来、规约读得动了）。
   * `before` 是**改盘上条件**那一下（两趟之间只此一处会动文件系统）。
   */
  then?: {
    readonly prompt: string
    readonly waitFor: string
    readonly before?: () => void
  },
): Promise<void> {
  const tty = new CaptureTty()
  const stdin = new FakeStdin()
  const { runTui } = await import('@magic/tui')

  const handle = await runTui({
    ...tuiOptions(assembly),
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: tty as unknown as NodeJS.WriteStream,
  })

  const driver = attachShell(assembly.shell)
  await driver.submit(prompt)
  await until(tty, waitFor)

  if (then !== undefined) {
    then.before?.()
    await driver.submit(then.prompt)
    await until(tty, then.waitFor)
  }
  driver.dispose()
  // 让它把最后一帧画完（Ink 按 30fps 写档）
  await Bun.sleep(200)

  const bytes = tty.bytes()
  writeFileSync(join(out, `${name}.ansi`), bytes, 'utf8')
  writeFileSync(join(out, `${name}.txt`), visible(bytes), 'utf8')
  console.log(visible(bytes).slice(-1200))

  // ⚠️ **退出要按两下**（U46 改的口径；U51 补上这两行）：空闲按第一下 ctrl+c 只挂上
  //    「再按一次 ctrl+c 退出」那一行，**第二下才走**。本函数原先只推一下，于是
  //    `waitUntilExit()` **永远不返回**——`frames-rules` / `frames-skills` 两支在基线上
  //    「卡死」就是这么来的（2026-09-24 查实：不是平台问题，是这里没跟上产品那次改动）。
  //    两下之间**等那一行真上屏**：连着推两次会让两下都成了「第一下」。
  stdin.push('\u0003')
  await until(tty, '再按一次 ctrl+c 退出')
  stdin.push('\u0003')
  await handle.waitUntilExit()
  assembly.close()
}

/** 跑一次 `--check`（沙地由调用方摆好），把那一屏落成文本。 */
function checkShot(out: string, name: string, workspace: string, home: string): void {
  const run = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), '--check'],
    cwd: workspace,
    env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
  })

  const text = run.stdout.toString() + run.stderr.toString()
  writeFileSync(join(out, `${name}.txt`), text, 'utf8')
  console.log(text)
}

// ══ ① `--check` 那一屏 ═══════════════════════════════════════════════

/**
 * 沙地照首轮那份摆，**多加两样**（返工新裁的那两条要看得见）：
 * - 原生 `.magic/rules/same.md` **写坏了**，而 `.claude/rules/same.md` 同名 ⇒ 看「原生优先」
 *   这句话在屏上怎么说的（首轮那份兼容规则会顶上来）；
 * - `src/AGENTS.md` 软链到根外、**没配 `linkSources`** ⇒ 一条 `error`；
 *   同一份再配一条 `linkSources` ⇒ 它该**照样只在 src 生效**（不进 `--check` 的开局读数，
 *   故这里只验没配时那一条）。
 */
export function checkFrame(out: string): void {
  const land = tempDir('magic-frames-check-')

  try {
    const home = join(land, 'home')
    const workspace = join(land, 'workspace')
    const outside = join(land, 'outside')
    mkdirSync(home, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })

    put(workspace, 'AGENTS.md', '根约定：一律中文')
    put(workspace, '.magic/rules/style.md', '提交信息写中文')
    put(workspace, '.magic/rules/frontend.md', '---\npaths:\n  - "src/**"\n---\n只用函数组件')
    put(workspace, '.magic/rules/bad.md', '---\npaths:\n  - "src/{a,}/**"\n---\n读不懂的那种')
    put(workspace, '.magic/rules/same.md', '---\npaths:\n  - "../bad/**"\n---\n原生这份写坏了')
    put(workspace, '.claude/rules/same.md', '兼容那份不该顶上来')
    put(outside, 'team.md', '外部那份（没配 linkSources）')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    symlinkSync(join(outside, 'team.md'), join(workspace, 'src', 'AGENTS.md'))

    // 配置落在 `$HOME/.magic/config.json`（加载器的缺省落点——不给覆盖位，走真那一条）：
    // `HOME` 一改，配置 / 数据 / 授权三样**全在沙地里**，真 `~/.magic` 一个字节都不碰
    put(home, '.magic/config.json', JSON.stringify(validConfig({ dataDir: join(home, 'data') }), null, 2))

    checkShot(out, 'check', workspace, home)
  } finally {
    removeDir(land)
  }
}

/**
 * 根 `AGENTS.md` **断链**、同目录 `CLAUDE.md` 有效——`--check` 那一屏。
 *
 * 判据（占位归谁、有没有报出来）在 `execution/test/rules.test.ts`；这一屏留的是**外观**：
 * 那两行诊断读起来是什么样、有没有把话说完（「按 AGENTS.md 优先，同目录的 CLAUDE.md
 * 不接管」——用户得知道为什么自己那份兼容规约**没在管**）。
 */
export function brokenAgentsCheckFrame(out: string): void {
  const land = tempDir('magic-frames-broken-')

  try {
    const home = join(land, 'home')
    const workspace = join(land, 'workspace')
    mkdirSync(home, { recursive: true })
    mkdirSync(workspace, { recursive: true })

    symlinkSync(join(land, 'missing-agents.md'), join(workspace, 'AGENTS.md'))
    put(workspace, 'CLAUDE.md', '兼容那份不该顶上来')
    put(home, '.magic/config.json', JSON.stringify(validConfig({ dataDir: join(home, 'data') }), null, 2))

    checkShot(out, 'check-broken-agents', workspace, home)
  } finally {
    removeDir(land)
  }
}

/**
 * `.magic/rules/locked` **目录 000**——`--check` 那一屏（2026-09-20 四轮）。
 *
 * 这一屏的作用是**把原因说清**：回执那一句只说「没读完整」（三种触发共用），
 * **是哪一处、为什么**在这儿——用户照着它去改（恢复权限 / 少几层 / 把规约裁小）。
 */
export function unreadableCheckFrame(out: string): void {
  const land = tempDir('magic-frames-unreadable-')

  try {
    const home = join(land, 'home')
    const workspace = join(land, 'workspace')
    const locked = join(workspace, '.magic/rules/locked')
    mkdirSync(home, { recursive: true })
    mkdirSync(workspace, { recursive: true })

    put(workspace, '.magic/rules/locked/required.md', '写受约束文件之前必读的那一份')
    put(home, '.magic/config.json', JSON.stringify(validConfig({ dataDir: join(home, 'data') }), null, 2))
    chmodSync(locked, 0)

    try {
      checkShot(out, 'check-unreadable', workspace, home)
    } finally {
      chmodSync(locked, 0o700)
    }
  } finally {
    removeDir(land)
  }
}

/**
 * `rules.sources` 点名的**外部目录 000**——`--check` 那一屏（2026-09-20 五轮）。
 *
 * 作用同 `unreadableCheckFrame`：回执那一句只说「没读完整」（几种触发共用），
 * **是哪一处、为什么**在这儿，用户照着它去改。差别只在**入口**——那边是扫 `.magic/rules`
 * 时看不成的目录，这边是**用户点名的补充来源**在**归位那一步**就取不到真身：
 * 诊断报的是配置里的那**一行**（`rules.sources 第 1 条`），与用户自己写的那串对得上。
 */
export function sourceUnreadableCheckFrame(out: string): void {
  const land = tempDir('magic-frames-source-')

  try {
    const home = join(land, 'home')
    const workspace = join(land, 'workspace')
    const shared = join(land, 'shared')
    mkdirSync(home, { recursive: true })
    mkdirSync(workspace, { recursive: true })

    put(shared, 'required.md', '写受约束文件之前必读的那一份')
    put(
      home,
      '.magic/config.json',
      JSON.stringify(
        validConfig({ dataDir: join(home, 'data'), rules: { sources: [shared] } }),
        null,
        2,
      ),
    )
    chmodSync(shared, 0)

    try {
      checkShot(out, 'check-source-unreadable', workspace, home)
    } finally {
      chmodSync(shared, 0o700)
    }
  } finally {
    removeDir(land)
  }
}

// ══ ② 外壳那一屏（扣下的那一次）══════════════════════════════════════

/**
 * 剧本（Faux，三回合）：① 直接写 `src/a.ts`（那底下有 `src/AGENTS.md`）⇒ **该被扣下**；
 * ② 照新规约重提 ⇒ 真写；③ 收束。
 *
 * 屏上该看到两行工具：第一行 `! 未执行 · 规约已更新，重新审视后再操作`（首轮是**一个永远
 * 转圈的幽灵**，二轮是 `✗ 0ms · 未执行——…`——把没跑画成了一次失败的耗时），第二行 `✓ 已写入 …`。
 */
export async function holdFrame(out: string): Promise<void> {
  const stage = makeStage()

  try {
    put(stage.workspace, 'AGENTS.md', '根约定：一律中文')
    put(stage.workspace, 'src/AGENTS.md', 'src 里先跑 bun run check')

    const call = { name: 'write', args: { path: 'src/a.ts', content: 'hello' } }
    const assembly = stage.assemble({
      turns: [
        { toolCalls: [call] },
        { toolCalls: [call] },
        { text: '写好了' },
      ],
    } satisfies StageAssembleOptions)

    await shoot(assembly, '新建 src/a.ts', '已写入', out, 'hold')
  } finally {
    stage.dispose()
  }
}

// ══ ③ 超限那一屏（第 65 份被截掉 ⇒ 整批停住）═════════════════════════

/**
 * 剧本（Faux，两回合）：① 直接写 `guard/result.txt`；② 收束（模型去告诉用户）。
 *
 * 沙地摆的是**份数刚好到顶**的样子：根 `.magic/rules` 里 64 份小规则（＝
 * `DEFAULT_RULES_LIMITS.maxDocuments`），`guard/AGENTS.md` 是**第 65 份**——它在预查那一趟
 * 被上限挡在门外，故「目标上的规约都送到了」这句话不成立，整批停住。
 *
 * 屏上该看到的那行是 `! 未执行 · 项目规约未完整读取`（首行就是回填正文那一句，见
 * `rules.ts` 的 `UNEXECUTED_OVERFLOW`；四轮改口径时从「规约太多，一次装不下」改成这一句
 * ——三种触发共用，**是哪一种由 `--check` 说**）——**没有耗时、没有失败那个叉**，
 * 也没有任何文件被写下去（这一屏的判据在 `rules.test.ts`，这里只留外观）。
 */
export async function overflowFrame(out: string): Promise<void> {
  const stage = makeStage()

  try {
    for (let index = 0; index < 64; index += 1) {
      put(stage.workspace, `.magic/rules/r${String(index).padStart(2, '0')}.md`, `RULE_${index}`)
    }
    put(stage.workspace, 'guard/AGENTS.md', 'GUARD_REQUIRED_BEFORE_WRITE')

    const call = { name: 'write', args: { path: 'guard/result.txt', content: 'SIDE_EFFECT' } }
    const assembly = stage.assemble({
      turns: [{ toolCalls: [call] }, { text: '那我先不动它' }],
    } satisfies StageAssembleOptions)

    await shoot(assembly, '往 guard 里写一个文件', '未完整读取', out, 'overflow')
  } finally {
    stage.dispose()
  }
}

// ══ ④ 目录读不动那一屏（四轮）＋ 权限还回来之后 ═══════════════════════

/**
 * 剧本（Faux，四回合）：① 直接写 `result.txt`（`.magic/rules/locked` 里那份规约**一次都没
 * 看过**）⇒ 整批扣下；② 收束；③ **权限还回来之后**同一会话再提一次 ⇒ 真写；④ 收束。
 *
 * 这一屏拍的是本轮那条链**两头的副作用的对照**：上半屏 `! 未执行 · 项目规约未完整读取`
 * （盘上一个字节都没落下），下半屏 `✓ 已写入 result.txt`——**读回来就照常推进**。
 * 判据（`written === false` 之后 `=== true`）在 `rules.test.ts`，这里只留外观。
 */
export async function unreadableFrame(out: string): Promise<void> {
  const stage = makeStage()
  const locked = join(stage.workspace, '.magic/rules/locked')

  try {
    put(stage.workspace, '.magic/rules/locked/required.md', 'LOCKED_REQUIRED_BEFORE_WRITE')
    chmodSync(locked, 0)

    const call = { name: 'write', args: { path: 'result.txt', content: 'SIDE_EFFECT' } }
    const assembly = stage.assemble({
      turns: [
        { toolCalls: [call] },
        { text: '好' },
        { toolCalls: [call] },
        { text: '写好了' },
      ],
    })

    await shoot(assembly, '写一个', '未完整读取', out, 'unreadable', {
      prompt: '再写一次',
      waitFor: '已写入',
      // **读回来**——两趟之间只改这一处：把目录权限还回去
      before: () => chmodSync(locked, 0o700),
    })
  } finally {
    chmodSync(locked, 0o700)
    stage.dispose()
  }
}

// ══ ⑤ 点名的来源读不动那一屏（五轮）＋ 权限还回来之后 ═════════════════

/**
 * 剧本（Faux，四回合）：同 `unreadableFrame`，只是把「看不成的目录」换成**用户点名的来源**
 * ——`rules.sources` 指的工作区**外**目录设成 000：① 直接写 `result.txt` ⇒ 整批扣下；
 * ② 收束；③ **权限还回来之后**同一会话再提一次 ⇒ 真写；④ 收束。
 *
 * 这一屏与 `unreadable.txt` 是**同一条链的两个入口**：那边栽在扫目录，这边栽在归位来源。
 * 上半屏 `! 未执行 · 项目规约未完整读取`（盘上一个字节都没落下），
 * 下半屏 `✓ 已写入 result.txt`——**读回来就照常推进**。
 * 判据（`before === false` 之后 `=== true`、且各只一次）在 `rules.test.ts`，这里只留外观。
 */
export async function sourceUnreadableFrame(out: string): Promise<void> {
  const shared = tempDir('magic-frames-source-')
  const stage = makeStage({ config: { rules: { sources: [shared] } } })

  try {
    put(shared, 'required.md', 'SOURCE_REQUIRED_BEFORE_WRITE')
    chmodSync(shared, 0)

    const call = { name: 'write', args: { path: 'result.txt', content: 'SIDE_EFFECT' } }
    const assembly = stage.assemble({
      turns: [
        { toolCalls: [call] },
        { text: '好' },
        { toolCalls: [call] },
        { text: '写好了' },
      ],
    })

    await shoot(assembly, '写一个', '未完整读取', out, 'source-unreadable', {
      prompt: '再写一次',
      waitFor: '已写入',
      // **读回来**——两趟之间只改这一处：把点名的那份来源的权限还回去
      before: () => chmodSync(shared, 0o700),
    })
  } finally {
    chmodSync(shared, 0o700)
    stage.dispose()
    removeDir(shared)
  }
}

// ══ ⑥ 真跑失败那一屏（首行恰是「未执行…」）════════════════════════════

/**
 * 剧本（Faux，两回合）：① 跑一条**真会失败**的命令——它先写下一个文件（副作用真的发生了）、
 * 再打一行以「未执行」起头的输出、然后非 0 退出；② 收束。
 *
 * 屏上该看到的那行是 `✗ …ms · 未执行后续步骤：前一步已经写入，但校验失败`——**失败那个叉
 * 与耗时都在**：「跑了没成」与「压根没跑」是两回事。三轮裁之前认的是正文首行，这一行会被
 * 认成「没跑」（耗时被抹掉、叉也换了）——那一版就是这儿当场认错的。
 */
export async function executedFailureFrame(out: string): Promise<void> {
  const stage = makeStage()

  try {
    const call = {
      name: 'exec',
      args: {
        cmd: 'echo SIDE_EFFECT > side-effect.txt; echo "未执行后续步骤：前一步已经写入，但校验失败"; exit 1',
      },
    }
    const assembly = stage.assemble({
      turns: [{ toolCalls: [call] }, { text: '那先不跑了' }],
    } satisfies StageAssembleOptions)

    await shoot(assembly, '跑一下那个脚本', '未执行后续步骤', out, 'executed-failure')
  } finally {
    stage.dispose()
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const out = at === -1 ? tempDir('magic-frames-') : (process.argv[at + 1] as string)
  mkdirSync(out, { recursive: true })

  checkFrame(out)
  brokenAgentsCheckFrame(out)
  unreadableCheckFrame(out)
  sourceUnreadableCheckFrame(out)
  await holdFrame(out)
  await overflowFrame(out)
  await unreadableFrame(out)
  await sourceUnreadableFrame(out)
  await executedFailureFrame(out)
  console.log(`\n帧落在 ${out}`)
}
