/**
 * D31 · **留帧装置**——「授权文件读不懂」在**用户看得见的那一屏**上长什么样。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。判据（写没写 · 动不动原文件 · 恢复得了吗）
 * 归 `grants-unreadable.test.ts`；这里只管**外观那一关**——`AGENTS.md`·工作模式：「看图」是
 * 四项：**布局 · 文案 · 层级 · 通读**。故本文件把两屏落成文本，好让人从上到下一行行读：
 *
 * - `boot.txt` ＋ `boot.ansi`——**开机那一屏**（真 TUI）：那句话说在记录区里，用户第一眼看到的就是它；
 * - `check.txt`——`--check` 的**授权那一行**（体检那一屏说的不是「你没有授权」——
 *   那是**读不懂**，两件事不一样）。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真装配（`assemble`）→ 真外壳（`runTui`，真 Ink）→ 真字节（假 TTY 记下写出的每一个字节）。
 * 沙地里的 `grants.json` 由本文件**先摆坏再起**（截断——缺陷档那条触发路径：断电 / 盘满 /
 * 编辑器存盘中途），故开盘那一下读到的就是「读不懂」。模型那一头是 Faux，**不发一个付费请求**；
 * `HOME` / 数据 / 配置 / 授权全在临时目录里，**真 `~/.magic` 零触碰**。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-grants-unreadable.ts --out <目录>
 * ```
 */

import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tuiOptions } from '../src/cli.ts'
import { makeStage } from './support.ts'
import { removeDir, tempDir, validConfig } from './tmp.ts'

/** 剥掉 ANSI 与 OSC——「屏上的字」读它（与 `window.test.ts` 同一个正则口径）。 */
function visible(text: string): string {
  return text
    .replace(/\][^]*(?:|\\)/g, '')
    .replace(/\[[0-9:;<=>?]*[@-~]/g, '')
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
function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

/**
 * 授权文件**先摆坏**——截断一份**合法**的（含一节真授权）。
 *
 * 截断而不是写个「{}」：缺陷档那条触发路径是「文件读到一半」，且这样摆出来的坏件旁边
 * **确实有一份用户点过的授权**（那才是会被抹掉的东西）。
 */
function brokenGrants(section: string): string {
  const body = `${JSON.stringify(
    {
      version: 1,
      workspaces: {
        [section]: [
          { tool: 'exec', op: ['read'], grantedAt: 1_700_000_000_000 },
          { tool: 'write', op: ['read'], grantedAt: 1_700_000_000_001 },
        ],
      },
    },
    null,
    2,
  )}\n`

  return body.slice(0, body.length - 60)
}

/** 跑一次 `--check`（家目录由调用方摆好），把那一屏落成文本。 */
function checkShot(out: string, home: string, workspace: string): void {
  const run = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), '--check'],
    cwd: workspace,
    env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
  })

  const text = run.stdout.toString() + run.stderr.toString()
  writeFileSync(join(out, 'check.txt'), text, 'utf8')
  console.log(text)
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const out = at === -1 ? tempDir('magic-frames-') : (process.argv[at + 1] as string)
  mkdirSync(out, { recursive: true })

  // ── ① 开机那一屏（真 TUI · 真装配）────────────────────────────────────

  const stage = makeStage()

  try {
    // 分节键＝默认根的规范形——先装配一次问它（同 `grants.test.ts`）
    const probe = stage.assemble()
    const section = probe.workspaceRoots[0] as string
    probe.close()

    // 沙地的授权文件就落在 `stage.root/magic/grants.json`（`support.ts` 指的缺省位）
    put(join(stage.root, 'magic', 'grants.json'), brokenGrants(section))

    const assembly = stage.assemble()
    const tty = new CaptureTty()
    const stdin = new FakeStdin()
    const { runTui } = await import('@magic/tui')

    const handle = await runTui({
      ...tuiOptions(assembly),
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: tty as unknown as NodeJS.WriteStream,
    })

    // **开机回执是开局就贴的**——不必等谁敲键
    await until(tty, '授权文件读不懂')
    await Bun.sleep(200) // 让 Ink 把最后一帧画完（按 30fps 写档）

    const bytes = tty.bytes()
    writeFileSync(join(out, 'boot.ansi'), bytes, 'utf8')
    writeFileSync(join(out, 'boot.txt'), visible(bytes), 'utf8')
    console.log(`\n══ 开机那一屏 ══\n${visible(bytes)}`)

    // 退出要按两下（U46 的口径）：第一下挂上那一行，**第二下才走**。
    // 两下之间等那一行真上屏——连着推两次会让两下都成「第一下」。
    stdin.push('')
    await until(tty, '再按一次 ctrl+c 退出')
    stdin.push('')
    await handle.waitUntilExit()

    // 收尾那一跳（`close`）也走一遍：读不懂时它**一个字节都不写**
    assembly.close()
  } finally {
    stage.dispose()
  }

  // ── ② `--check` 那一行（真 CLI · 家目录照它自己的缺省摆）────────────────

  const home = tempDir('magic-frames-home-')
  try {
    // 配置与授权都在 `<HOME>/.magic/` 下——那是 CLI 不设 `MAGIC_HOME` 时的落点
    put(
      join(home, '.magic', 'config.json'),
      JSON.stringify(validConfig({ dataDir: join(home, 'data') }), null, 2),
    )
    // 一屏只看**授权那一行**，分节键是什么无所谓（那一步压根没读进来）
    put(join(home, '.magic', 'grants.json'), brokenGrants('(读不懂的那一份——分节键到不了这一步)'))

    checkShot(out, home, home)
  } finally {
    removeDir(home)
  }

  console.log(`\n帧落在 ${out}`)
}
