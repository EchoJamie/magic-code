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
 * 出三份：`check.txt`（`--check` 那一屏的字）· `hold.txt`（外壳屏上的字）·
 * `hold.ansi`（外壳写出的原始字节，带色——颜色与字重只能从字节上看）。
 */

import { EventEmitter } from 'node:events'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachShell } from '../src/index.ts'
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

    const run = Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), '--check'],
      cwd: workspace,
      env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
    })

    const text = run.stdout.toString() + run.stderr.toString()
    writeFileSync(join(out, 'check.txt'), text, 'utf8')
    console.log(text)
  } finally {
    removeDir(land)
  }
}

// ══ ② 外壳那一屏（扣下的那一次）══════════════════════════════════════

/**
 * 剧本（Faux，三回合）：① 直接写 `src/a.ts`（那底下有 `src/AGENTS.md`）⇒ **该被扣下**；
 * ② 照新规约重提 ⇒ 真写；③ 收束。
 *
 * 屏上该看到两行工具：第一行 `✗ 未执行——…`（首轮是**一个永远转圈的幽灵**），
 * 第二行 `✓ 已写入 …`。
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

    const tty = new CaptureTty()
    const stdin = new FakeStdin()
    const { runTui } = await import('@magic/tui')

    const handle = await runTui({
      ...tuiOptions(assembly),
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: tty as unknown as NodeJS.WriteStream,
    })

    const driver = attachShell(assembly.shell)
    await driver.submit('新建 src/a.ts')
    driver.dispose()

    await until(tty, '已写入')
    // 让它把最后一帧画完（Ink 按 30fps 写档）
    await Bun.sleep(200)

    const bytes = tty.bytes()
    writeFileSync(join(out, 'hold.ansi'), bytes, 'utf8')
    writeFileSync(join(out, 'hold.txt'), visible(bytes), 'utf8')
    console.log(visible(bytes).slice(-1200))

    stdin.push('\u0003')
    await handle.waitUntilExit()
    assembly.close()
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
  await holdFrame(out)
  console.log(`\n帧落在 ${out}`)
}
