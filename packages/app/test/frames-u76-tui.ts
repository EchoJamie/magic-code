#!/usr/bin/env bun
/**
 * U76 · **全放行要连必闸也放** ＋ **名单收缩到两条**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。
 *
 * ## 判的是哪两件事
 *
 * 设计（本单权威 · `设计/工具执行与权限`·「全放行」与「危险命令名单：收缩到两条」）：
 *
 * 1. **`--allow-all` 改成「连必闸也放」**——U73 落的「放轻的、必闸照样挡」是**旧版**；
 *    用户 2026-09-25 改定：**全放行就是真的什么都不问**（由头：默认已经是「通」，
 *    只剩那张例外表要问；若全放行也不放它，**这一档就是个空开关**）。
 * 2. **名单只留两条**——**删除**（`rm` 那类）· **改权限 / 属主 / 属性 / ACL**；
 *    其余（移动 · 覆盖 · 破坏性 git · `sudo` 那类 · 越界 · 外发 · **判不出来**）
 *    **默认通**，靠**提示词**——⚠️ **那是一道软防线**（模型可以不听；闸门才是硬的，
 *    而这几类不在闸门里）。**判轻的不必配规则**（链的底从「默认问」翻成「默认通」）。
 *
 * ## 八张帧
 *
 * | 帧 | 工单那一格 | 该在屏上看见什么 |
 * | --- | --- | --- |
 * | `01` `02` | **① 名单那两条照问** | `删除（不可逆）` 与 `改权限 · 属主 · 属性 / ACL（不可逆）` 两张卡**照出**——它们**是唯一还问的** |
 * | `03`–`07` | **② 其余不问、直接跑** | 破坏性 git · 外发 · 越界 · `sudo` · 判不出来：**一张卡都没有**，工具真跑了（各留一帧） |
 * | `08` `09` | **③ 外发不问，`byHost` 规则路照旧** | `git push`（外发）不问；取网页那件**按域名**：写明域的**不问**、换一个域名**照问**（正反各一趟） |
 * | `10` `11` | **④ 全放行：连名单那两条也放** | 同一个 `rm` / `chmod`，带 `--allow-all` 时**不问**（不带时照问——`01` `02` 就是它的反面） |
 * | `12` `13` | **⑤ 复合命令按段判、取最严** | `cd x && rm -rf y` ⇒ 卡**照出**，材料里两段都在（删的那段看得出）；`cd x && git status` ⇒ **不问** |
 * | `14`–`16` | **⑥ `sudo` 当场失败 ＋ 反证** | 产品：`sudo` 不弹卡、**当场得 EOF 失败**（不悬着）；**反证**：把 `stdin: 'ignore'` 改成 `inherit` 跑同一份装置 ⇒ **挂住** |
 *
 * ## 每条判据怎么咬
 *
 * - **屏上的字**：按行找（与 `session.wait` 同一条尺子）。
 * - **「不问」的判据是两条一起**：**卡没出** ＋ **工具真跑了**（模型收到了结果、接着说下一句）
 *   ——只判前者会把「卡住了」误读成「放行了」。
 * - **状态行那一格**：`statusLineOf` ——取**输入行与状态行之间那条分隔线之下**那一行，
 *   不是「全屏找那几个字」。
 * - **反证那一条（⑥）**用的是**同一份装置、同一个命令**，只把被测 checkout 换成
 *   一份**改了一行**的复制品（`stdin: 'ignore'` → `'inherit'`）——那一行的承重
 *   （「谁改成继承宿主 stdin，这一类当场变成会挂住」）因此是**跑出来的**，不是注释里的。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u76-tui.ts --out <目录>
 * ```
 *
 * ⚠️ **这一趟的沙地都备成了一个 git 仓库**（两笔提交 ＋ 一个子仓库 `x/`）：
 * 「破坏性 git」与 `cd x && git status` 那几帧要真跑得过去，屏上才读得出「不问、直接跑」。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALLOW_ALL_LABEL } from '@magic/tui'
import { createSandbox, createUiSession, REPO_ROOT, startFixture, statusLineOf } from './ui/index.ts'
import type { Capture, FixtureTurn, Sandbox, UiSession } from './ui/index.ts'
import { tempDir } from './tmp.ts'

/** 这一趟的产物根——入口解析 `--out` 之后填。 */
let out = ''

/**
 * 产品那一侧那一格的字——**直接从 `@magic/tui` 取**，不在这里抄一份。
 * 判据锚在**产品那个常量**上：改了它，这一趟跟着走；而「那一格还在不在屏上」
 * 这一条**仍然咬得住**（常量改了而没上屏，取景就找不到它）。
 */
const MARK = ALLOW_ALL_LABEL

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

/** 打一行字并**等它真出现在屏上**（文本与回车分两次写——挤在同一次写里按键会丢）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 一句交代跑完并回到空闲（`until` ＝ 模型那一句答复）。 */
async function said(session: UiSession, text: string, until: string): Promise<void> {
  await typeLine(session, text)
  await session.key('enter', { until: { text: until }, timeoutMs: 40_000 })
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })
}

/**
 * 等**状态行那一行**里出现某句话——**等的是屏，不是状态**。
 *
 * ⚠️ 由头同 `frames-u73-tui.ts`：那一格**由执行者随快照报来**，而快照是挂上那一代之后
 * 才到的一趟往返——它上屏的时刻**排在第一条命令之后**。判据要的是「用户看得见这一格」，
 * 故**等它上屏**，不赌一个时刻。
 */
async function waitStatusLine(session: UiSession, needle: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let line = ''

  while (Date.now() < deadline) {
    line = statusLineOf((await session.capture()).lines)
    if (line.includes(needle)) return line
    await Bun.sleep(50)
  }

  throw new Error(`等不到状态行里的「${needle}」——此刻那一行是：${JSON.stringify(line)}`)
}

/** git 跑一条（备沙地那几下）——失败不响，用例要的只是"它在那儿"。 */
function git(cwd: string, args: readonly string[]): void {
  Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
}

/**
 * **把工作区备成一个 git 仓库**：两笔提交 ＋ 一个子仓库 `x/`。
 *
 * 由头：`git reset --hard HEAD~1`（破坏性 git）与 `cd x && git status`（复合命令那一条）
 * 都要**真跑得过去**——跑不过去的屏上只剩一句 `fatal: not a git repository`，
 * 那句读不出「不问、直接跑」这件事（它把"没拦"和"没跑成"混在一起了）。
 */
function prepareWorkspace(workspace: string): void {
  git(workspace, ['init', '-q'])
  git(workspace, ['config', 'user.email', 'u76@example.invalid'])
  git(workspace, ['config', 'user.name', 'U76'])
  writeFileSync(join(workspace, 'README.md'), '# 沙地\n', 'utf8')
  git(workspace, ['add', '.'])
  git(workspace, ['commit', '-qm', '第一笔'])
  writeFileSync(join(workspace, 'README.md'), '# 沙地\n\n第二笔\n', 'utf8')
  git(workspace, ['add', '.'])
  git(workspace, ['commit', '-qm', '第二笔'])

  mkdirSync(join(workspace, 'x'), { recursive: true })
  git(join(workspace, 'x'), ['init', '-q'])

  // 名单第二条那几帧要 `chmod`/`chown` 真成功（不然屏上只剩一句 `No such file`，
  // 而那张帧要说的是「它**真跑了**」）
  writeFileSync(join(workspace, 'secret.key'), '不是真的钥匙\n', 'utf8')

  // **删除那一类的两帧要一座"真有东西"的 build/**（U77）：被拒之后屏上那句「文件还在」
  // 得**真有份文件**可查——空手说"没删掉"是查不出来的
  mkdirSync(join(workspace, 'build'), { recursive: true })
  writeFileSync(join(workspace, 'build', '产物.txt'), 'U76/U77 的构建产物\n', 'utf8')
}

/** 一帧的底架：起一块**备好的**沙地 ＋ 一台夹具，收摊那一跳也一并交出去。 */
async function openScene(options: {
  readonly label: string
  readonly turns: readonly FixtureTurn[]
  readonly argv?: readonly string[]
  readonly config?: Record<string, unknown>
  readonly columns?: number
  readonly rows?: number
}): Promise<{ readonly session: UiSession; readonly sandbox: Sandbox; readonly fixture: { stop(): Promise<void> } }> {
  const fixture = startFixture({ turns: options.turns })
  const sandbox = createSandbox({
    baseURL: fixture.baseURL,
    ...(options.config === undefined ? {} : { config: options.config }),
  })
  prepareWorkspace(sandbox.workspace)

  const session = await createUiSession({
    label: options.label,
    artifacts: join(out, 'runs'),
    sandbox,
    fixture,
    columns: options.columns ?? 100,
    rows: options.rows ?? 30,
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

// ══ ①②④ · 名单那两条照问 / 其余不问 / 全放行连它们也放 ══════════════

/**
 * **① 删除那一类"直接拒" ＋ 名单里那条"照问"**（U77 换的锚）。
 *
 * ⚠️ **U76 那一版是「名单那两条照问」**（删除 ＋ 改权限，**都弹卡**）。
 * **U77 起删除从"要授权"整类移出**——它**不问、直接拒**（回执里指路 `trash`），
 * 故能弹卡的只剩**改权限那一族**。两半一起留帧，才是现在的名单。
 *
 * ⚠️ **删除那两帧的判据是四件一起**（不是"看着像"）：**没有卡** ＋ **回执说了为什么**
 * ＋ **回执指了路** ＋ **那一份文件还在**（`build/产物.txt` 真在沙地里）。
 */
async function sceneList(): Promise<void> {
  const scene = await openScene({
    label: 'u76-名单两条',
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: 'rm -rf build' } },
      { kind: 'text', text: '那我改用 trash。' },
      { kind: 'tool', name: 'exec', args: { cmd: 'chmod 600 secret.key' } },
      { kind: 'text', text: '权限也没动。' },
    ],
  })

  try {
    // —— 删除：**不弹卡、直接拒**（U77）——
    await typeLine(scene.session, '删掉 build')
    await scene.session.key('enter', { until: { text: '那我改用 trash。' }, timeoutMs: 40_000 })
    await scene.session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

    const remove = await scene.session.capture({ label: '01-删除直接拒' })
    keep(remove, '01-删除直接拒')

    check(!has(remove, '· 不可逆'), '① 删除：**一张卡都没有**（不是"问"，是"直接拒"）')
    check(!statusLineOf(remove.lines).includes('y / n'), '① 右位不是裁决键位（根本没问）')
    check(has(remove, '已拒绝'), '① 回执是「拒绝」那一形（不是"完成"）')
    check(has(remove, '不可逆'), '① 回执说得出**为什么**')
    check(has(remove, 'trash'), '① 回执**指了路**（只拒不说，模型只会换着花样再试）')
    check(
      existsSync(join(scene.sandbox.workspace, 'build', '产物.txt')),
      '① **那一份文件还在**（拒＝一步都没跑）',
    )

    // —— 名单里剩下那一条：改权限 ——
    await typeLine(scene.session, '改一下 secret.key 的权限')
    await scene.session.key('enter', { until: { text: '· 不可逆' }, timeoutMs: 40_000 })

    const chmod = await scene.session.capture({ label: '02-改权限照问' })
    keep(chmod, '02-改权限照问')

    check(has(chmod, 'chmod 600 secret.key —— 改权限 · 属主 · 属性 / ACL（不可逆）'), '① 改权限：卡照出，材料点名那一类')
    check(has(chmod, '判据：系统级（改权限 / 属主 / 属性 / ACL）'), '① 判据那一行说得出为什么问')
    check(statusLineOf(chmod.lines).includes('y / n'), '① 右位是重件键位 `y / n`')
    check(!has(chmod, '✓'), '① 没答复之前**一步都没跑**')

    await scene.session.send('n', { until: { text: '权限也没动。' }, timeoutMs: 40_000 })
  } finally {
    await closeScene(scene)
  }
}

/**
 * **② 其余一律不问、直接跑**——**本单的要害**（工单明文）。
 *
 * 五条各留一帧：破坏性 git · 外发 · 越界 · `sudo` 那类 · 判不出来。
 * ⚠️ 每一条都**真的在沙地里跑了**（不是"卡住了"）：判据是**两件一起**——
 * **卡没出** ＋ **模型收到结果接着说下一句**。
 */
async function sceneDefaultPass(): Promise<void> {
  const outsideDir = tempDir('magic-u76-outside-')
  const outside = join(outsideDir, 'hosts-copy')
  const scene = await openScene({
    label: 'u76-默认通',
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: 'git reset --hard HEAD~1' } },
      { kind: 'text', text: '重置好了。' },
      { kind: 'tool', name: 'exec', args: { cmd: 'git push origin main' } },
      { kind: 'text', text: '推过了。' },
      { kind: 'tool', name: 'exec', args: { cmd: `cp /etc/hosts ${outside}` } },
      { kind: 'text', text: '拷好了。' },
      { kind: 'tool', name: 'exec', args: { cmd: 'sudo ls' } },
      { kind: 'text', text: '它自己跑不起来。' },
      { kind: 'tool', name: 'exec', args: { cmd: 'eval "echo 判不出来也通"' } },
      { kind: 'text', text: '也跑过了。' },
    ],
  })

  const steps: readonly { readonly frame: string; readonly said: string; readonly until: string; readonly why: string }[] = [
    { frame: '03-破坏性git不问', said: '把上一次提交撤掉', until: '重置好了。', why: '② 破坏性 git（`git reset --hard`）' },
    { frame: '04-外发不问', said: '推一下', until: '推过了。', why: '② 外发（`git push`）' },
    { frame: '05-越界不问', said: '把 hosts 拷到工作区外', until: '拷好了。', why: '② 越界（根外的写）' },
    { frame: '06-sudo不问', said: '用 sudo 列一下', until: '它自己跑不起来。', why: '② `sudo` 那类（要交互输入）' },
    { frame: '07-判不出来不问', said: '跑一段拼出来的命令', until: '也跑过了。', why: '② 判不出来（`eval` / 动态拼接）' },
  ]

  try {
    for (const step of steps) {
      await said(scene.session, step.said, step.until)

      const shot = await scene.session.capture({ label: step.frame })
      keep(shot, step.frame)

      check(!has(shot, '· 不可逆'), `${step.why}：**一张卡都没有**`)
      check(!statusLineOf(shot.lines).includes('y / n'), `${step.why}：右位不是裁决键位（根本没问）`)
      check(has(shot, step.until), `${step.why}：工具**真跑了**（模型收到了结果、接着说下一句）`)
    }

    const shot = await scene.session.capture({ label: '07b-默认通-整屏' })
    check(!has(shot, MARK), '① 不带 `--allow-all`：屏上**一个「全放行」都没有**')
  } finally {
    await closeScene(scene)
    rmSync(outsideDir, { recursive: true, force: true })
  }
}

/**
 * **④ 全放行：要授权的那一条也不问，而删除照拒**（U77 换的锚）。
 *
 * ⚠️ **U76 那一版是「连名单那两条也放」**；**U77 起删除那一类是个例外**——
 * **全放行下也照拒**（规划侧定）。由头：**拒的理由是"这个命令不可逆"，不是"你该问我"**，
 * 而 `--allow-all` **只动「问不问」那一维**（设计的三个维度里的第一个）。两件事不混。
 *
 * 故这一趟两帧：**改权限不问（这一档的承诺照旧兑现）** ＋ **删除照拒（例外照旧成立）**。
 */
async function sceneAllowAll(): Promise<void> {
  const scene = await openScene({
    label: 'u76-全放行',
    argv: ['--allow-all'],
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: 'chmod 600 secret.key' } },
      { kind: 'text', text: '改好了。' },
      { kind: 'tool', name: 'exec', args: { cmd: 'rm -rf build' } },
      { kind: 'text', text: '那我改用 trash。' },
    ],
  })

  try {
    await said(scene.session, '改一下 secret.key 的权限', '改好了。')
    // 那一格是**随快照**上屏的（见 `waitStatusLine`）——判据等它，不赌时刻
    await waitStatusLine(scene.session, MARK)

    const shot = await scene.session.capture({ label: '10-全放行-改权限也不问' })
    keep(shot, '10-全放行-改权限也不问')
    check(!has(shot, '· 不可逆'), '④ 改权限：全放行时**也不问**（卡没出）')
    check(has(shot, '改好了。'), '④ 工具**真跑了**')
    check(statusLineOf(shot.lines).includes(MARK), '④ 状态行那一格**照报着**（② 常驻）')

    // —— 而**删除那一类照拒**（U77 的例外）——
    await typeLine(scene.session, '删掉 build')
    await scene.session.key('enter', { until: { text: '那我改用 trash。' }, timeoutMs: 40_000 })
    await scene.session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

    const refused = await scene.session.capture({ label: '11-全放行-删除照拒' })
    keep(refused, '11-全放行-删除照拒')
    check(!has(refused, '· 不可逆'), '④ 删除：全放行下**也不问**（这一档的承诺照旧）')
    check(has(refused, '已拒绝'), '④ **但也不放**——照拒（拒的理由不是"你该问我"）')
    check(has(refused, 'trash'), '④ 回执照旧指路')
    check(
      existsSync(join(scene.sandbox.workspace, 'build', '产物.txt')),
      '④ **那一份文件还在**（照拒＝一步都没跑）',
    )
  } finally {
    await closeScene(scene)
  }
}

// ══ ③ · 外发不问，但 byHost 那条规则路照旧（U72 不许被改坏）════════════

/**
 * **按域名放行**（U72）——**正反各一趟**。
 *
 * ⚠️ 第一条帧要的是「那段 `rm` **看得出**」——材料里两段都列着，抹掉哪一段都读不出来。
 */
async function sceneByHost(): Promise<void> {
  const scene = await openScene({
    label: 'u76-按域名',
    config: {
      // ⚠️ **`webFetch` 要配**：不配「提炼用的模型」时，取网页那一轮**就地收束**
      // （工具的 `halt` 分支，见 `@magic/tools`）——那一轮连取回都不做，屏上也就读不出
      // 「闸门放没放它」。配了之后：闸门先判（这一张帧要看的），取回再自己失败
      // （`.invalid` 是保留域名，永远解析不出来）——**那正是"不问、直接跑"该有的形状**。
      webFetch: { provider: 'local', model: 'MiniMax-M3' },
      permissions: { rules: [{ tool: 'web_fetch', host: 'magic-u76.invalid' }] },
    },
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: 'git push origin main' } },
      { kind: 'text', text: '推过了。' },
      { kind: 'tool', name: 'web_fetch', args: { url: 'https://magic-u76.invalid/a', prompt: '看什么' } },
      { kind: 'text', text: '取过了。' },
      { kind: 'tool', name: 'web_fetch', args: { url: 'https://other-u76.invalid/a', prompt: '看什么' } },
      { kind: 'text', text: '这个我得问一句。' },
    ],
  })

  try {
    await said(scene.session, '推一下', '推过了。')
    const push = await scene.session.capture({ label: '08-外发不问' })
    keep(push, '08-外发不问')
    check(!has(push, '· 不可逆'), '③ 外发（`git push`）：**不问**')
    check(has(push, '推过了。'), '③ 工具**真跑了**')

    await said(scene.session, '把这个网页取来看看', '取过了。')
    const ruled = await scene.session.capture({ label: '09a-按域名-写了规则的那个域名不问' })
    keep(ruled, '09a-按域名-写了规则的那个域名不问')
    check(!has(ruled, '· 不可逆'), '③ **写了规则的那个域名**：不问（U72 那条路没被改坏）')
    check(has(ruled, '取过了。'), '③ 那一件**真跑了**')

    await typeLine(scene.session, '另一家的网页也取一下')
    await scene.session.key('enter', { until: { text: '· 不可逆' }, timeoutMs: 40_000 })
    const other = await scene.session.capture({ label: '09b-按域名-换了域名照问' })
    keep(other, '09b-按域名-换了域名照问')
    check(has(other, '域名：other-u76.invalid'), '③ **换了域名**：卡照出，卡上写清去向')
    check(has(other, 'a 总是允许这个域名'), '③ 那一张卡上**有** `a`（这一件按域名给「总是允许」）')
    // ⚠️ **看帧读出来的一处不一致**（**不是本单改的**，U72 起就有）：卡上明明给了 `a`，
    // 而状态行右位报的是重件那句 `y / n`——右位只看 `weight`（`view.ts` 的
    // `withDecisionStatus`），看不见 `host`。**本单没动它**（那是另一个面），
    // 故这里照实钉住现状；要改另立一件。
    check(
      statusLineOf(other.lines).includes('y / n'),
      '③ 状态行右位仍是 `y / n`（与卡上那个 `a` 不一致——如实记下，见注释）',
    )

    await scene.session.send('n', { until: { text: '这个我得问一句。' }, timeoutMs: 40_000 })
  } finally {
    await closeScene(scene)
  }
}

// ══ ⑤ · 复合命令按段判、取最严 ═══════════════════════════════════════

/**
 * **一段"要授权"，整串就照问**（取最严，不是取最宽）；**两段都不在名单里，整串不问**。
 *
 * ⚠️ **U77 换的锚**：从前这一段用的是 `cd x && rm -rf y`（删除那一类）——
 * 如今它**直接拒**（连卡都不出），故"按段判"的正面改用**复合命令里那段被拒的**
 * （材料里照样看得出是**第二段**的事），反面照旧用 `cd x && git status`。
 */
async function sceneCompound(): Promise<void> {
  const scene = await openScene({
    label: 'u76-复合命令',
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: 'cd x && rm -rf y' } },
      { kind: 'text', text: '那我改用 trash。' },
      { kind: 'tool', name: 'exec', args: { cmd: 'cd x && git status' } },
      { kind: 'text', text: '看过了。' },
    ],
  })

  try {
    await typeLine(scene.session, '进 x 里把 y 删掉')
    await scene.session.key('enter', { until: { text: '那我改用 trash。' }, timeoutMs: 40_000 })
    await scene.session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

    const chained = await scene.session.capture({ label: '12-复合命令-里面那段rm照拒' })
    keep(chained, '12-复合命令-里面那段rm照拒')
    check(!has(chained, '· 不可逆'), '⑤ `cd x && rm -rf y`：**没有卡**（删除那一类直接拒）')
    check(has(chained, '已拒绝'), '⑤ 整串照拒')
    check(has(chained, 'trash'), '⑤ 回执指路')

    await said(scene.session, '进 x 里看看仓库状态', '看过了。')
    const plain = await scene.session.capture({ label: '13-复合命令-两段都不在名单里不问' })
    keep(plain, '13-复合命令-两段都不在名单里不问')
    check(!has(plain, '· 不可逆'), '⑤ `cd x && git status`：**不问**（一串不因"是一串"就整条落进名单）')
    check(has(plain, '看过了。'), '⑤ 它**真跑了**')
  } finally {
    await closeScene(scene)
  }
}

// ══ ⑥ · `sudo` 当场失败 ＋ 反证：改成继承宿主 stdin ⇒ 挂住 ═══════════

/** 反证用的命令——**要 stdin 的**那种（`cat` 不给参数就读 stdin）。 */
const STDIN_HUNGRY: FixtureTurn = { kind: 'tool', name: 'exec', args: { cmd: 'cat' } }

/**
 * **复制一份本仓，把 `stdin: 'ignore'` 全改成 `'inherit'`**——反证那一趟的被测对象。
 *
 * ## ⚠️ 实跑查出来的一件事：那一句的承重**不止一处**
 *
 * 头一回只改了 `exec.ts` 那一行——**挂不住**（`cat` 照样毫秒级就回了）。查下来：
 * **执行者进程自己那一跳也是 `stdin: 'ignore'`**（`run/spawn-manager.ts`）⇒
 * 命令"继承"到的是「执行者的 stdin ＝ 空」，而不是宿主终端。
 *
 * ⇒ **要挂住，整条链都得喂真 stdin**（本函数一次全改）。这一条**值得记下来**：
 * 设计里那句「前提就是那句 `stdin: 'ignore'`」**在实况里是两处**——
 * 反过来说，**"这一类跑不起来"这件事比设计说的更结实**（只松一处仍不挂）。
 *
 * 三件都要在注释里说清（不然这是一段没人敢碰的魔法）：
 * - **为什么复制整仓**：被测对象是一个真进程（`bun <checkout>/packages/app/src/cli.ts`），
 *   要它带上这些改动，只能给它一份改过的 checkout。`node_modules/@magic/*` 是
 *   **相对软链**（`../../packages/app`）⇒ 连链接一起搬过去，复制品就自洽了。
 * - **为什么这不是"改产品"**：它只活在这一趟验收里（跑完就删），产物是**两份帧的对照**
 *   ＋ 一份 diff——产品那棵树上一个字没动。
 */
function patchedCheckout(): { readonly root: string; readonly diff: string } {
  const dest = tempDir('magic-u76-patched-')
  // `rsync -a` **保留软链**（`node_modules/@magic/*` 是相对链 ⇒ 复制品自洽的关键）；
  // `.git` 与 `.ui-runs` 不必带（前者是历史、后者是产物）
  const copied = Bun.spawnSync([
    'rsync',
    '-a',
    '--exclude=.git',
    '--exclude=.ui-runs',
    `${REPO_ROOT}/`,
    dest,
  ])
  if (copied.exitCode !== 0) throw new Error('复制 checkout 失败')

  /** 命令这条链上喂 stdin 的每一处——**一处不落**（落下了这一趟就是假的反证）。 */
  const files: readonly string[] = [
    'packages/execution/src/exec.ts',
    'packages/app/src/run/spawn-manager.ts',
    'packages/app/src/run/launch.ts',
  ]

  const hunks: string[] = []
  for (const relative of files) {
    const file = join(dest, relative)
    const before = readFileSync(file, 'utf8')
    const after = before
      .replaceAll("stdin: 'ignore'", "stdin: 'inherit'")
      .replaceAll("Bun.Subprocess<'ignore'", "Bun.Subprocess<'inherit'")
    if (after === before) throw new Error(`没找到那一行（${relative} 里的 \`stdin: 'ignore'\`）`)

    before.split('\n').forEach((text, index) => {
      if (!text.includes("stdin: 'ignore'")) return
      hunks.push(`--- a/${relative}`, `+++ b/${relative}`, `@@ 第 ${index + 1} 行 @@`, text.replace("stdin: 'ignore'", "stdin: 'inherit'"))
    })
    writeFileSync(file, after, 'utf8')
  }

  return {
    root: dest,
    diff: [
      '# 反证：把「喂 stdin」这条链上的每一处 `stdin: \'ignore\'` 改成 `\'inherit\'`',
      ...hunks,
      `# 复制品落在 ${dest}（跑完即删；这一份 diff 与两份帧留在验证目录里）`,
    ].join('\n'),
  }
}

/** 反证那一趟的命令。 */
const hungTurns: readonly FixtureTurn[] = [STDIN_HUNGRY, { kind: 'text', text: '读完了。' }]

/** 产品那一侧跑同一个命令——**当场回**（stdin 是 `ignore` ⇒ 立刻 EOF）。 */
async function sceneStdinProduct(): Promise<void> {
  const scene = await openScene({ label: 'u76-stdin-产品', turns: hungTurns })

  try {
    await said(scene.session, '读一下标准输入', '读完了。')
    const shot = await scene.session.capture({ label: '14-产品-要stdin的命令当场回' })
    keep(shot, '14-产品-要stdin的命令当场回')
    check(!has(shot, '· 不可逆'), '⑥ `cat`（要 stdin）：**不弹卡**')
    check(has(shot, '读完了。'), '⑥ **当场就回了**（`stdin: ignore` ⇒ 立刻 EOF，不悬着）')
  } finally {
    await closeScene(scene)
  }
}

/**
 * **反证**：同一份装置、同一个命令，只把被测 checkout 换成**改了那一行**的复制品。
 *
 * 判据：**它挂住**——工具没回、模型没收到结果、屏上那条工具行一直停在那儿。
 * 这一条**直接咬住那句注释的承重**（谁把 `stdin` 改成继承宿主 stdin，要交互输入的那一类
 * 当场变成"会挂住"——而"缺省不设超时"之下，挂住＝那一轮永远不回）。
 */
async function sceneStdinProof(): Promise<void> {
  const patched = patchedCheckout()
  writeFileSync(join(out, 'stdin-反证.diff'), `${patched.diff}\n`, 'utf8')
  console.log(`\n（反证的复制品：${patched.root}）`)

  const fixture = startFixture({ turns: hungTurns })
  const session = await createUiSession({
    label: 'u76-stdin-反证',
    checkout: patched.root,
    artifacts: join(out, 'runs'),
    columns: 100,
    rows: 30,
    fixture,
  })

  try {
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })
    await typeLine(session, '读一下标准输入')
    // 锚在**工具调用那一行**上（`● exec {"cmd":"cat"}`——参数原样印在工具行里）
    await session.key('enter', { until: { text: '{"cmd":"cat"}' }, timeoutMs: 40_000 })

    // **给它足够久**：产品那一侧同一条命令在毫秒级就回了（上一帧），这里等满 10 秒
    await Bun.sleep(10_000)

    const shot = await session.capture({ label: '15-反证-改成继承stdin就挂住' })
    keep(shot, '15-反证-改成继承stdin就挂住')

    check(has(shot, '{"cmd":"cat"}'), '⑥ 反证：命令**确实发出去了**（工具行在屏上）')
    check(!has(shot, '读完了。'), '⑥ 反证：**它挂住了**——模型没收到结果（产品那一侧同一件事毫秒级就回）')
    check(!has(shot, '○ 空闲'), '⑥ 反证：那一轮**没回**（不是"跑完了没印出来"）')
  } finally {
    try {
      await session.close({ graceMs: 1_000 })
    } finally {
      await fixture.stop()
      rmSync(patched.root, { recursive: true, force: true })
    }
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u76-') : (process.argv[at + 1] as string)
  const only = process.argv.includes('--only') ? (process.argv[process.argv.indexOf('--only') + 1] as string) : ''
  mkdirSync(root, { recursive: true })
  out = root

  const wanted = (name: string): boolean => only === '' || only === name

  // ①②④ 名单那两条照问 / 其余不问 / 全放行连它们也放
  if (wanted('list')) {
    console.log('\n══ ① 名单那两条照问 ══')
    await sceneList()
  }

  if (wanted('default')) {
    console.log('\n══ ② 其余一律默认通（不问、直接跑）══')
    await sceneDefaultPass()
  }

  if (wanted('allow-all')) {
    console.log('\n══ ④ 全放行：连名单那两条也放 ══')
    await sceneAllowAll()
  }

  if (wanted('by-host')) {
    console.log('\n══ ③ 外发不问 · 按域名那条路照旧 ══')
    await sceneByHost()
  }

  if (wanted('compound')) {
    console.log('\n══ ⑤ 复合命令按段判、取最严 ══')
    await sceneCompound()
  }

  if (wanted('stdin')) {
    console.log('\n══ ⑥ 要 stdin 的命令：产品当场回 ══')
    await sceneStdinProduct()
  }

  if (wanted('proof')) {
    console.log('\n══ ⑥ 反证：把那行改成继承宿主 stdin ⇒ 挂住 ══')
    await sceneStdinProof()
  }

  console.log(`\n帧落在 ${out}`)
}
