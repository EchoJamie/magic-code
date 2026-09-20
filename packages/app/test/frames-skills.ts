/**
 * U33 · **留帧装置**（第一轮）——技能那几屏在**真外壳**上是什么样，落成可核对的帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。判据（送到没送到 · 记没记下 · 失没失效）
 * 归 `skills.test.ts`；这里把**用户看得见的那一屏**落成文本与原始字节，好让人**从上到下一行行读**
 * （`AGENTS.md`·工作模式：「看图」是四项：布局 · 文案 · 层级 · 通读）。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真装配（`assemble` → 真沙箱 · 真记录 · 真对话域 · **真技能目录**）→ 真外壳（`runTui`，真 Ink）
 * → 真字节（假 TTY 记下写出的每一个字节）。模型那一头是 **Faux**（假端点回放），
 * 故**一个付费请求都不发**；沙地的 `HOME` / `dataDir` / `grants` / **用户技能目录**全在临时
 * 目录里（`makeStage` 把 `home` 也沙地化了），**真 `~/.magic` 零触碰**。
 *
 * ## 交代从哪儿进（工单明写的那条路）
 *
 * 结构化输入经**现有控制入口**注入（`attachShell` 的 `submit({ text, skills })`）——
 * 技能绑定与配对键要能**经入口**递进去。真外壳的按键（`/<skill-name>` 与 `/skills`）
 * 归**第二轮**：本轮不开发选择界面，故屏上这几帧**不含**任何选择动作，
 * 只有「内核报回来的事实怎么显示」。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-skills.ts --out <目录>
 * ```
 *
 * 出六份：`check`（`--check` 那一屏的字：技能那一行）·
 * `check-broken`（有一份读不懂时，那一行怎么说）·
 * `explicit`（显式选定：主文送达 ＋ `本次使用技能` 那一行）·
 * `missing`（来源失效：`没送出` 那一行，且**一个模型请求都没发**）·
 * `autonomous`（模型自主选用：`skill` 工具的调用与结果两行）·
 * `plain`（普通交代：有技能目录，但屏上不多一个字——回归那一条）。
 */

import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillRef, UserInput } from '@magic/contracts'
import { attachShell } from '../src/index.ts'
import type { Assembly, ShellHandle } from '../src/index.ts'
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

/** 假 stdin——Ink 挂 `'readable'` 之后自己 `read()` 取件。 */
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

/** 一份讲道理的 `SKILL.md`。 */
function skillText(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

/** 留一屏——真装配 → 真外壳 → 经控制入口递一条结构化交代 → 等屏上出现某句话 → 收字节。 */
async function shoot(
  assembly: Assembly,
  input: UserInput,
  waitFor: string,
  out: string,
  name: string,
): Promise<void> {
  const tty = new CaptureTty()
  const stdin = new FakeStdin()
  const { runTui } = await import('@magic/tui')

  const handle = await runTui({
    ...tuiOptions(assembly),
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: tty as unknown as NodeJS.WriteStream,
  })

  const driver: ShellHandle = attachShell(assembly.shell)
  await driver.submit(input)
  await until(tty, waitFor)
  driver.dispose()
  // 让它把最后一帧画完（Ink 按 30fps 写档）
  await Bun.sleep(200)

  const bytes = tty.bytes()
  writeFileSync(join(out, `${name}.ansi`), bytes, 'utf8')
  writeFileSync(join(out, `${name}.txt`), visible(bytes), 'utf8')
  console.log(visible(bytes).slice(-1200))

  stdin.push('\u0003')
  await handle.waitUntilExit()
  assembly.close()
}

/**
 * 跑一次 `--check`（沙地由调用方摆好），把那一屏落成文本。
 *
 * 走的是**真进程**（`bun cli.ts --check`）——自检那一行是不是真印出来的，只有这一路说了算。
 */
function checkShot(out: string, name: string, workspace: string, home: string): void {
  const run = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), '--check'],
    cwd: workspace,
    env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
  })

  const text = new TextDecoder().decode(run.stdout)
  writeFileSync(join(out, `${name}.txt`), text, 'utf8')
  console.log(text)
}

// ══ ① 显式选定：主文送达 ＋ 回执 ═══════════════════════════════════

/** 屏上该看到的两样：用户那句话的回显 ＋ 内核报回来的 `本次使用技能`。 */
export async function explicitFrame(out: string): Promise<void> {
  const stage = makeStage()

  try {
    const path = put(
      stage.workspace,
      '.magic/skills/pdf/SKILL.md',
      skillText('pdf', '处理 PDF：抽文本、填表、合并。用户提到 PDF 时用。', '第一步：先数页数。'),
    ).replace(/\/SKILL\.md$/, '')

    const assembly = stage.assemble({ turns: [{ text: '照它做，先数页数。' }] } satisfies StageAssembleOptions)
    const skills: readonly SkillRef[] = [{ name: 'pdf', path }]

    await shoot(assembly, { text: '把这份 PDF 处理一下', skills, ref: 'draft-1' }, '本次使用技能', out, 'explicit')
  } finally {
    stage.dispose()
  }
}

// ══ ② 来源失效：没送出那一行 ═══════════════════════════════════════

/** 屏上该看到的：`没送出：…`（含是哪一份来源出的问题），且**一次模型请求都没发**。 */
export async function missingFrame(out: string): Promise<void> {
  const stage = makeStage()

  try {
    const dir = put(
      stage.workspace,
      '.magic/skills/doomed/SKILL.md',
      skillText('doomed', '会失效的技能', '正文。'),
    ).replace(/\/SKILL\.md$/, '')
    // 绑草稿时它还在——递出去之前那一份没了（「来源失效」的真实样子）
    rmSync(dir, { recursive: true, force: true })

    const assembly = stage.assemble({ turns: [{ text: '（这一轮不该发生）' }] } satisfies StageAssembleOptions)

    await shoot(assembly, { text: '照它做', skills: [{ name: 'doomed', path: dir }], ref: 'draft-bad' }, '没送出', out, 'missing')
  } finally {
    stage.dispose()
  }
}

// ══ ③ 模型自主选用：工具那两行 ════════════════════════════════════

/** 屏上该看到的：`skill` 工具的调用行与结果行（模型按描述自己取的那一次）。 */
export async function autonomousFrame(out: string): Promise<void> {
  const stage = makeStage()

  try {
    put(
      stage.workspace,
      '.magic/skills/pdf/SKILL.md',
      skillText('pdf', '处理 PDF：抽文本、填表、合并。用户提到 PDF 时用。', '第一步：先数页数。'),
    )

    const assembly = stage.assemble({
      turns: [{ toolCalls: [{ name: 'skill', args: { name: 'pdf' } }] }, { text: '取到了，照它做。' }],
    } satisfies StageAssembleOptions)

    await shoot(assembly, { text: '把这份 PDF 处理一下' }, 'skill', out, 'autonomous')
  } finally {
    stage.dispose()
  }
}

// ══ ④ 普通交代：不多一个字（回归那一条）════════════════════════════

/** 有技能目录，但**没选中任何一个**——屏上与加这一整条之前一字不差。 */
export async function plainFrame(out: string): Promise<void> {
  const stage = makeStage()

  try {
    put(
      stage.workspace,
      '.magic/skills/pdf/SKILL.md',
      skillText('pdf', '处理 PDF：抽文本、填表、合并。', '第一步：先数页数。'),
    )

    const assembly = stage.assemble({ turns: [{ text: '好。' }] } satisfies StageAssembleOptions)

    await shoot(assembly, { text: '随便聊一句' }, '好。', out, 'plain')
  } finally {
    stage.dispose()
  }
}

// ══ ⑤ `--check`：技能那一行 ═══════════════════════════════════════════

/** 自检那一行——发现到的照报，坏的那一份**指明来源与缘由**（用户唯一的可见面）。 */
export function checkFrame(out: string): void {
  const home = tempDir('magic-frames-skills-')
  const workspace = join(home, 'ws')

  try {
    mkdirSync(workspace, { recursive: true })
    put(home, '.magic/config.json', JSON.stringify(validConfig({ dataDir: join(home, 'data') })))
    put(home, '.magic/skills/pdf/SKILL.md', skillText('pdf', '处理 PDF：抽文本、填表、合并。', '第一步：先数页数。'))

    checkShot(out, 'check', workspace, home)

    // 再加一份读不懂的——看那一行怎么报「没读进来」
    put(home, '.magic/skills/broken/SKILL.md', '---\nname: broken\n---\n\n没有 description\n')
    checkShot(out, 'check-broken', workspace, home)
  } finally {
    removeDir(home)
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const out = at === -1 ? tempDir('magic-frames-') : (process.argv[at + 1] as string)
  mkdirSync(out, { recursive: true })

  checkFrame(out)
  await explicitFrame(out)
  await missingFrame(out)
  await autonomousFrame(out)
  await plainFrame(out)
  console.log(`\n帧落在 ${out}`)
}
