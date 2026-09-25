#!/usr/bin/env bun
/**
 * U77 · **`rm` 直接拒，指路 `trash`**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。
 *
 * ## 判的是哪一件事
 *
 * 设计（本单权威 · `设计/工具执行与权限`·「`rm` 直接拒，指路 `trash`」）：
 *
 * > **`rm` 那类 ⇒ 直接拒**（**不是"问"**），**回执里告诉模型用什么**……
 * > **`trash` 本身不拦**——**它可逆** ⇒ 不必问；**`shred` / `srm` 照旧拒**（不给替代）。
 * > ⇒ **「删除」从"要授权"那一类里整个移出** ⇒ 名单里只剩**改权限那一类**。
 *
 * ## 八张帧
 *
 * | 帧 | 工单那一格 | 该在屏上（与盘上）看见什么 |
 * | --- | --- | --- |
 * | `01` | **① `rm -f 一个文件`** | **没有卡**（不是"问"）；回执＝**已拒绝 ＋ 为什么（不可逆）＋ 用什么（`trash`）**；**文件还在** |
 * | `02` | **② `trash 一个文件`** | **不弹卡、直接跑**；文件**进了废纸篓**（工作区里没了 · `~/.Trash` 里有） |
 * | `03` `04` | **③ 目录那一形 ＋ 复合命令里那一段** | `rm -rf u77-build` / `cd x && rm -rf u77-y` 都**照拒**；**东西都还在** |
 * | `05` | **④ `shred` / `srm`** | 拒，且回执**不给替代**（它要的就是不可逆）；文件还在 |
 * | `06` | **⑤ 这台机器上没有 `trash`** | 把 `trash` 从 `PATH` 里挪开 ⇒ 回执**如实说没有**，**不许**再指它 |
 * | `07` | **⑥ `--allow-all` 下** | `rm` **照拒**；判轻的照旧什么都不问——留帧 |
 * | `08` | **⑦ 反面** | 非删除的命令**逐字未变**（引号里那段 `rm` 一个字母都没动） |
 *
 * ## 每条判据怎么咬
 *
 * - **屏上的字**：按行找（与 `session.wait` 同一条尺子）。
 * - **「拒」是四件一起**（不是"看着像"）：**没有卡**（也没有 `y / n` 那行）＋ **回执里有
 *   「已拒绝」** ＋ **说得出为什么 / 用什么** ＋ **那一份东西还在盘上**
 *   ——"没跑"这件事只有最后一条是**物理**的，前三条都可能由"卡住了"冒充。
 * - **「进了废纸篓」是三件一起**：工作区里没了 ＋ `~/.Trash` 里有它 ＋ 屏上那一句是"完成"。
 *
 * ## 两处装置上的讲究（都不是产品行为）
 *
 * - **`trash` 是系统自带的**（macOS 15 起，`/usr/bin/trash`）——本机有它；「没有它」那一形
 *   靠**把 `/usr/bin` 从子进程的 `PATH` 里摘掉**造出来（**不动任何系统文件**，工单明文）。
 * - **废纸篓是用户真那个**（子壳换掉的 `HOME` 管不着系统挪东西那一路），故这一趟会往
 *   `~/.Trash` 里放**一件**东西（`u77-` 打头），跑完**自己清掉**（只认那个前缀）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u77-tui.ts --out <目录>
 * ```
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ALLOW_ALL_LABEL } from '@magic/tui'
import { createSandbox, createUiSession, startFixture, statusLineOf } from './ui/index.ts'
import type { Capture, FixtureTurn, Sandbox, UiSession } from './ui/index.ts'
import { tempDir } from './tmp.ts'

/** 这一趟的产物根——入口解析 `--out` 之后填。 */
let out = ''

/** 用户真那个废纸篓（系统挪东西那一路落的就是它）。 */
const TRASH = join(homedir(), '.Trash')

/** 这一趟放进废纸篓的东西**都以此开头**——清扫只认它（一件别人的都不碰）。 */
const PREFIX = 'u77-'

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

/** 打一行字并**等它真出现在屏上**（文本与回车分两次写——挤在同一次写里按键会丢）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/**
 * **敲一发工具调用、等它跑完**——被拒的那些也走这一条（它们照样落一条 `tool.result`，
 * 模型照样收到回执、照样接着说下一句）。
 */
async function ask(session: UiSession, said: string, until: string): Promise<void> {
  await typeLine(session, said)
  await session.key('enter', { until: { text: until }, timeoutMs: 60_000 })
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })
}

// ══ 废纸篓那一头（物证就在这儿）═════════════════════════════════════

/** 废纸篓里有没有它——撞名时系统会给后缀，故按**前缀**找。 */
function trashEntryOf(name: string): string | undefined {
  return readdirSync(TRASH).find((entry) => entry === name || entry.startsWith(`${name} `))
}

/**
 * **清扫**——只清 `u77-` 开头的那几件（本装置自己放进去的）。
 *
 * 用户的废纸篓不该攒着验收的垃圾；而"只认前缀"这一条是硬规矩：`rm -rf` 的是**用户的东西**，
 * 认错一个字母就是删了他的文件（故夹具的名字全部带这个前缀）。
 */
function sweepTrash(): readonly string[] {
  const removed: string[] = []

  for (const entry of readdirSync(TRASH)) {
    if (!entry.startsWith(PREFIX)) continue
    rmSync(join(TRASH, entry), { recursive: true, force: true })
    removed.push(entry)
  }

  return removed
}

// ══ 夹具 ═════════════════════════════════════════════════════════════

/**
 * 备沙地——这一趟要碰的那几件（**名字全部带 `u77-` 前缀**，见 `sweepTrash`）。
 *
 * `u77-fresh.txt` 是留给 ② 的：**它要真被挪进废纸篓**；其余几件是给"拒"那几帧用的
 * ——它们**必须还在**（那是"一步都没跑"的物理判据）。
 */
function prepareWorkspace(workspace: string): void {
  writeFileSync(join(workspace, 'u77-keep.txt'), '等着被拒的\n', 'utf8')
  writeFileSync(join(workspace, 'u77-fresh.txt'), '等着进废纸篓的\n', 'utf8')
  writeFileSync(join(workspace, 'u77-secret.key'), '不是真的钥匙\n', 'utf8')
  writeFileSync(join(workspace, 'u77-x'), '引号里那段 rm 说的就是它\n', 'utf8')

  mkdirSync(join(workspace, 'u77-build', 'sub'), { recursive: true })
  writeFileSync(join(workspace, 'u77-build', 'sub', 'deep.txt'), '深一层的\n', 'utf8')
  mkdirSync(join(workspace, 'x', 'u77-y'), { recursive: true })
  writeFileSync(join(workspace, 'x', 'u77-y', 'inside.txt'), '在子目录里\n', 'utf8')
}

/** 一帧的底架：起一块**备好的**沙地 ＋ 一台夹具。 */
async function openScene(options: {
  readonly label: string
  readonly turns: readonly FixtureTurn[]
  readonly argv?: readonly string[]
  /** 要不要**把 `trash` 从 `PATH` 里摘掉**（⑤ 那一形）。 */
  readonly withoutTrash?: boolean
}): Promise<{ readonly session: UiSession; readonly sandbox: Sandbox; readonly fixture: { stop(): Promise<void> } }> {
  const fixture = startFixture({ turns: options.turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  prepareWorkspace(sandbox.workspace)

  // ⑤ · **把 `trash` 从 `PATH` 里摘掉**——`trash` 落在 `/usr/bin`，把那一条剔了就是
  // 「这台机器上没有它」那一形。**不动任何系统文件**（工单明文：临时改 PATH 即可）；
  // 也别剔多了：`bun` 自己还在 PATH 上（被测进程就是它起的）。
  if (options.withoutTrash === true) {
    // **认的是"那个目录里有没有 `trash`"**，不是"这个目录叫不叫 `/usr/bin`"：
    // 本机 PATH 里带 `usr/bin` 字样的目录不止一处（cryptex 那几条），按名字剔会剔错。
    const path = (sandbox.env['PATH'] ?? '')
      .split(':')
      .filter((dir) => dir !== '' && !existsSync(join(dir, 'trash')))
    if (path.some((dir) => existsSync(join(dir, 'trash')))) throw new Error('装置出错：`trash` 没摘干净')

    sandbox.env['PATH'] = path.join(':')
  }

  const session = await createUiSession({
    label: options.label,
    artifacts: join(out, 'runs'),
    sandbox,
    fixture,
    columns: 100,
    rows: 32,
    ...(options.argv === undefined ? {} : { argv: options.argv }),
  })
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

  return { session, sandbox, fixture }
}

/** 收摊：先照产品的方式退，再停夹具、删沙地。 */
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

// ══ ① ② ③ ④ · 拒哪一类、放哪一条 ═══════════════════════════════════

/**
 * **① `rm` 被拒 ＋ ② `trash` 跑通、进废纸篓 ＋ ③ 目录与复合命令 ＋ ④ `shred` 不给替代**。
 *
 * 一趟窗口里四条都走一遍：同一份配置、同一个模型，只差命令——这样「谁被拒、谁放行」
 * 是**同一屏上比出来的**，不是两台机器上各说各的。
 */
async function sceneRefuseAndTrash(): Promise<void> {
  const scene = await openScene({
    label: 'u77-拒与指路',
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: 'rm -f u77-keep.txt' } },
      { kind: 'text', text: '那我改用 trash。' },
      { kind: 'tool', name: 'exec', args: { cmd: 'trash u77-fresh.txt' } },
      { kind: 'text', text: '挪进去了。' },
      { kind: 'tool', name: 'exec', args: { cmd: 'rm -rf u77-build' } },
      { kind: 'text', text: '目录那条也被拒了。' },
      { kind: 'tool', name: 'exec', args: { cmd: 'cd x && rm -rf u77-y' } },
      { kind: 'text', text: '复合命令里那段也拒了。' },
      { kind: 'tool', name: 'exec', args: { cmd: 'shred -u u77-secret.key' } },
      { kind: 'text', text: '碾不了就算了。' },
    ],
  })

  const workspace = scene.sandbox.workspace

  try {
    // —— ① 一个文件：**拒**（不是弹卡）——
    await ask(scene.session, '删掉 u77-keep.txt', '那我改用 trash。')

    const refused = await scene.session.capture({ label: '01-rm直接拒' })
    keep(refused, '01-rm直接拒')

    check(!has(refused, '· 不可逆'), '① **没有卡**——不是"问"，是"直接拒"（`rm` 那类不弹 `y/a/n`）')
    check(!statusLineOf(refused.lines).includes('y / n'), '① 右位不是裁决键位（真的没问）')
    check(has(refused, '已拒绝'), '① 回执是「拒绝」那一形（不是"完成"）')
    check(has(refused, '不可逆'), '① 回执说得出**为什么**（`rm` 不可逆）')
    check(has(refused, 'trash'), '① 回执说得出**用什么**（`trash`——不是只说一句"拒绝"）')
    check(existsSync(join(workspace, 'u77-keep.txt')), '① **那一份文件还在**（拒＝一步都没跑）')

    // —— ② `trash` 一条：**不问、直接跑**，东西真进废纸篓 ——
    await ask(scene.session, '那就用 trash 挪走 u77-fresh.txt', '挪进去了。')

    const trashed = await scene.session.capture({ label: '02-trash跑通进废纸篓' })
    keep(trashed, '02-trash跑通进废纸篓')

    check(!has(trashed, '· 不可逆'), '② `trash`：**不弹卡**（它可逆 ⇒ 默认通）')
    check(has(trashed, '✓'), '② 它**真跑了**（屏上是完成那一形，不是拒绝）')
    check(!existsSync(join(workspace, 'u77-fresh.txt')), '② 工作区里**看不到它了**')
    check(trashEntryOf('u77-fresh.txt') !== undefined, '② **它在废纸篓里**', `废纸篓＝${TRASH}`)

    // —— ③ 目录那一形 ＋ 复合命令里那一段 ——
    await ask(scene.session, '把 u77-build 那个目录删掉', '目录那条也被拒了。')
    const dir = await scene.session.capture({ label: '03-目录那一形也照拒' })
    keep(dir, '03-目录那一形也照拒')
    check(!has(dir, '· 不可逆'), '③ `rm -rf 目录`：**没有卡**')
    check(has(dir, '已拒绝'), '③ 照拒')
    check(existsSync(join(workspace, 'u77-build', 'sub', 'deep.txt')), '③ **整棵目录还在**（连里面那份）')

    await ask(scene.session, '进 x 里把 u77-y 删掉', '复合命令里那段也拒了。')
    const chained = await scene.session.capture({ label: '04-复合命令里那段也照拒' })
    keep(chained, '04-复合命令里那段也照拒')
    check(!has(chained, '· 不可逆'), '③ `cd x && rm -rf u77-y`：**没有卡**（段里那段照拒）')
    check(has(chained, '已拒绝'), '③ 整串照拒')
    check(existsSync(join(workspace, 'x', 'u77-y', 'inside.txt')), '③ `x/u77-y` 也还在')

    // —— ④ `shred`：拒，且**不给替代** ——
    await ask(scene.session, '把 u77-secret.key 碾掉', '碾不了就算了。')
    const shred = await scene.session.capture({ label: '05-shred拒且不给替代' })
    keep(shred, '05-shred拒且不给替代')
    check(!has(shred, '· 不可逆'), '④ `shred`：**没有卡**')
    check(has(shred, '已拒绝') && has(shred, 'shred'), '④ 照拒，且点名说得出是它')
    // ⚠️ 判据读的是**它那一条回执**（不是整屏）：前面几条"指路 `trash`"的拒还在屏上，
    // 整屏找 `trash` 必然找到——那就等于把这条判据废掉了。
    const shredLine = shred.lines.find((line) => line.includes('已拒绝') && line.includes('shred')) ?? ''
    check(shredLine !== '' && !shredLine.includes('trash'), '④ **不给替代**——它要的就是不可逆（换个更弱的做法等于没照它办）', shredLine)
    check(existsSync(join(workspace, 'u77-secret.key')), '④ 文件还在')
  } finally {
    await closeScene(scene)
  }
}

// ══ ⑤ · 这台机器上没有 `trash` ═══════════════════════════════════════

/**
 * **老系统的兜底**（工单第五格）：`trash` 是 **macOS 15 起**才自带的。
 *
 * ⚠️ 判据是**两件一起**：**如实说没有**（「这台机器上没有 `trash`」）＋ **不再指它**
 * ——**指一个跑不了的命令，比不指更坏**（工单明文）。
 *
 * 造这一形**不动任何系统文件**：把 `/usr/bin` 从子进程的 `PATH` 里摘掉即可
 * （`trash` 就落在那里；`bun` 在 homebrew，不受影响）。
 */
async function sceneWithoutTrash(): Promise<void> {
  const scene = await openScene({
    label: 'u77-没有trash',
    withoutTrash: true,
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: 'rm -f u77-keep.txt' } },
      { kind: 'text', text: '那我不删了。' },
    ],
  })

  try {
    await ask(scene.session, '删掉 u77-keep.txt', '那我不删了。')

    const shot = await scene.session.capture({ label: '06-没有trash就如实说' })
    keep(shot, '06-没有trash就如实说')

    check(!has(shot, '· 不可逆'), '⑤ **没有卡**（删除那一类照旧直接拒）')
    check(has(shot, '这台机器上没有 `trash`'), '⑤ **如实说没有**——不许假装它一定在')
    check(!has(shot, '改用 `trash`'), '⑤ **不再指它**（指一个跑不了的命令比不指更坏）')
    check(existsSync(join(scene.sandbox.workspace, 'u77-keep.txt')), '⑤ 文件还在')
  } finally {
    await closeScene(scene)
  }
}

// ══ ⑥ · 全放行下：`rm` 照拒 ═════════════════════════════════════════

/**
 * 工单第六格（规划侧定，**不是留给领取者判的**）：
 *
 * > **全放行（`--allow-all`）下 `rm` 也照拒**——**拒的理由是"这个命令不可逆"，
 * > 不是"你该问我"**；而 `--allow-all` **只动「问不问」那一维**。两件事不混。
 */
async function sceneAllowAll(): Promise<void> {
  const scene = await openScene({
    label: 'u77-全放行',
    argv: ['--allow-all'],
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: 'rm -rf u77-build' } },
      { kind: 'text', text: '那我改用 trash。' },
      { kind: 'tool', name: 'exec', args: { cmd: 'git status' } },
      { kind: 'text', text: '状态看过了。' },
    ],
  })

  try {
    await ask(scene.session, '把 u77-build 删掉', '那我改用 trash。')

    const shot = await scene.session.capture({ label: '07-全放行里rm照拒' })
    keep(shot, '07-全放行里rm照拒')

    check(!has(shot, '· 不可逆'), '⑥ 全放行下删除**也不问**（这一档的承诺照旧兑现）')
    check(has(shot, '已拒绝'), '⑥ **但也不放**——照拒（拒的理由不是"你该问我"）')
    check(statusLineOf(shot.lines).includes(ALLOW_ALL_LABEL), '⑥ 状态行那一格**照报着**')
    check(existsSync(join(scene.sandbox.workspace, 'u77-build', 'sub', 'deep.txt')), '⑥ 那棵目录还在')

    // 而这一档的承诺本身没变：判轻的照旧什么都不问、直接跑
    await ask(scene.session, '看一眼仓库状态', '状态看过了。')
    const pass = await scene.session.capture({ label: '07b-全放行里判轻的照旧不问' })
    check(!has(pass, '· 不可逆'), '⑥ 判轻的照旧不问')
    check(has(pass, '状态看过了。'), '⑥ 而且真跑了')
  } finally {
    await closeScene(scene)
  }
}

// ══ ⑦ · 反面：非删除的命令逐字未变 ══════════════════════════════════

/**
 * **引号里那段 `rm -f u77-x` 一个字母都不许动**——它是**正文**，不是命令。
 *
 * 这一条护的是本单那条"不做改写"的边界（工单：**不做"改写命令"**——不解析 shell、
 * 不改写、不替换成别的命令）：门只认**结构化调用**里的命令字段，正文里的字面量
 * 既不该被拦、更不该被改。
 */
async function sceneUntouched(): Promise<void> {
  const scene = await openScene({
    label: 'u77-反面',
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: 'echo "a && rm -f u77-x && b"' } },
      { kind: 'text', text: '念了一遍。' },
    ],
  })

  try {
    await ask(scene.session, '把这句话念一遍', '念了一遍。')

    const shot = await scene.session.capture({ label: '08-反面-非删除逐字未变' })
    keep(shot, '08-反面-非删除逐字未变')

    check(!has(shot, '· 不可逆'), '⑦ 非删除的命令**不弹卡**')
    check(!has(shot, '已拒绝'), '⑦ 也**没被拒**（它压根不是删除）')
    check(
      shot.lines.some((line) => line.includes('a && rm -f u77-x && b')),
      '⑦ **照原样念出来了**（引号里那段一个字都没动）',
    )
    check(existsSync(join(scene.sandbox.workspace, 'u77-x')), '⑦ 引号里的 `rm` **没有被执行**——那文件还在')
  } finally {
    await closeScene(scene)
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u77-') : (process.argv[at + 1] as string)
  const only = process.argv.includes('--only')
    ? (process.argv[process.argv.indexOf('--only') + 1] as string)
    : ''
  mkdirSync(root, { recursive: true })
  out = root

  const wanted = (name: string): boolean => only === '' || only === name

  // 开跑前先清一遍**我们自己的**旧摊子（上一次跑到一半留下的）——只认 `u77-` 前缀
  const stale = sweepTrash()
  if (stale.length > 0) console.log(`（开跑前清掉上次留下的：${stale.join(' · ')}）`)

  // 废纸篓里有同名旧件时系统会给新来的加后缀（`name 2`）——故每条判据按**前缀**认
  // （`trashEntryOf`），而开跑这一扫把上一次的摊子先清了，两头都顾上。
  // ⚠️ **别同时跑两支本装置**：开跑那一扫会把另一支刚放进去的件也清掉。

  try {
    if (wanted('refuse')) {
      console.log('\n══ ①②③④ 拒哪一类 · 放哪一条 ══')
      await sceneRefuseAndTrash()
    }

    if (wanted('no-trash')) {
      console.log('\n══ ⑤ 这台机器上没有 `trash` ══')
      await sceneWithoutTrash()
    }

    if (wanted('allow-all')) {
      console.log('\n══ ⑥ 全放行下 `rm` 照拒 ══')
      await sceneAllowAll()
    }

    if (wanted('untouched')) {
      console.log('\n══ ⑦ 反面：非删除的命令逐字未变 ══')
      await sceneUntouched()
    }

    // 物证先留档，再清摊子
    const listing = readdirSync(TRASH).filter((entry) => entry.startsWith(PREFIX))
    writeFileSync(
      join(out, '废纸篓.json'),
      `${JSON.stringify({ '废纸篓里此刻的 u77 件': listing }, null, 2)}\n`,
      'utf8',
    )
    console.log(`\n══ 废纸篓那一头 ══\n  · 此刻的 u77 件：${listing.join(' · ') || '（一件都没有）'}`)

    // ⚠️ **「放回原处」那一份记录不在判据里**：它由 Finder 攒着批量刷
    // （`~/.Trash/.DS_Store`），本机实测**没能在可等的时间内观察到**——如实记在回报的
    // 限度里。这一趟的硬判据是「**它在废纸篓里**」——那是查得到的。
    const swept = sweepTrash()
    console.log(`（清掉本装置放进废纸篓的 ${swept.length} 件：${swept.join(' · ')}）`)
    writeFileSync(join(out, '废纸篓-清扫.txt'), `${swept.join('\n')}\n`, 'utf8')
  } finally {
    console.log(`\n帧落在 ${out}`)
  }
}
