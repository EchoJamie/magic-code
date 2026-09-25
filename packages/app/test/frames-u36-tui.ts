/**
 * U36 · **引用原位编辑与文件目录输入的留帧装置**——真 PTY ＋ 本地模型夹具，落成可核对的帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。判据（按键 → 视图 → 命令）有一部分在
 * `packages/tui/test/spec.u36.test.ts`；这里补的是**只有真终端才说得清的那几件**：
 * - 屏上**长什么样**（布局 · 文案 · 层级 · 通读——`AGENTS.md` 的看帧四项）；
 * - `@` 的候选**是真的去看了一眼目录**（真文件系统，不是桩）；
 * - **提交之后那几处材料真交到了模型手上**（U63 起正文按需自读：提交那一趟不带正文、
 *   模型要了之后那次才有；夹具的请求表是物证——见 ③ 那一处的注）；
 * - **记录里那一条**（位置 · 身份；U63 起「实际交付的那一份」落在 `tool-result` 条目里）——直读库表；
 * - 应用与夹具**由监督者收干净**（`close()` 的 `exit.by`：它自己走的 / 我们杀的）。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 **loopback 夹具**
 * （`127.0.0.1`，端口自动分配，合成假 key）——**一个付费请求都不发**，真 `~/.magic` 零触碰。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u36-tui.ts --out <目录>
 * ```
 *
 * 出七屏：`01-@候选` · `02-选入之后`（引用留在原位）· `03-提交之后`（回显与请求）·
 * `04-原位删除`（退格整处移除）· `05-窄窗候选` · `06-取不到则保稿` · `07-目录引用`。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAGIC_IDLE_MARK, createUiSession } from './ui/index.ts'
import type { Capture, FixtureRequest, UiSession } from './ui/index.ts'
import { readDatabase } from './support.ts'
import { tempDir } from './tmp.ts'

/** 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/** 留一屏——文本写进 `<out>/<序号>-<名字>.txt`，字格与光标写进同名 `.json`。 */
function keep(out: string, shot: Capture, label: string): void {
  writeFileSync(join(out, `${label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${label}.json`),
    `${JSON.stringify(
      { columns: shot.columns, rows: shot.rows, cursor: shot.cursor, scrollback: shot.scrollback, lines: shot.lines, runFiles: shot.files },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${label} ──\n${shot.text}`)
}

/**
 * 打一行字并**等它真出现在屏上**（按键丢了就等不到——不重发，如实失败）。
 *
 * 文本与回车**分两次写**，且**先等草稿上屏再回车**（挤在同一次写里整段按键会被丢掉）。
 */
async function typeLine(session: UiSession, text: string, shown = text.trimEnd()): Promise<void> {
  await session.send(text, { until: { text: shown }, timeoutMs: 10_000 })
}

/** 打一个 `@`（开路径候选那一下）——等它真上屏。 */
async function typeAt(session: UiSession): Promise<void> {
  await session.send('@', { until: { text: '@' }, timeoutMs: 10_000 })
}

/**
 * 按一个**非文字键**（回车 / 退格 / Tab）——先等一小会儿再写。
 *
 * 由头（真跑栽过两次）：PTY 上两次写挨得太近时，应用**一次 read 就会把它们并成一块**
 * 读进来，Ink 那边于是收到一个「输入 = `\r\x7f`」的怪键（`key.return` 为假）——
 * 回车会变成一个**正文里的控制字符**。等一等，让上一次写先被读走，再写下一次。
 */
async function pressKey(
  session: UiSession,
  name: 'enter' | 'backspace' | 'tab' | 'up' | 'down',
  until?: Parameters<UiSession['key']>[1],
): Promise<void> {
  await Bun.sleep(150)
  await session.key(name, until)
}

/** 屏上有没有这一行。 */
function has(shot: Capture, needle: string): boolean {
  return shot.lines.some((line) => line.includes(needle))
}

/** 摆一个文件（中间目录自动建）。 */
function put(where: string, relative: string, text: string): string {
  const path = join(where, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

/**
 * 一次出站请求的**整份请求体**（判「某段正文在不在这一次请求里」要看它）。
 *
 * ⚠️ **不能拿 `lastUser` 代替**：那个字段是**截到 200 字符**的「最后一条 user 正文」，
 * 而 U63 起**正文走的是工具结果**（role 是 `tool`，不是 `user`）——`lastUser` 里
 * 压根看不到它。判「材料到没到模型手上」得读整份 `body`。
 */
function bodyTextOf(request: FixtureRequest | undefined): string {
  return request === undefined ? '' : JSON.stringify(request.body)
}

/**
 * 一次请求里**最后一条消息**的样子——「**这一步最新**发出去的是什么」。
 *
 * 由头（U87 真跑栽过一趟）：同一会话里第二轮再提交时，整份请求体**本来就带着第一轮的
 * 全部历史**（那一次读回来的 `第一版` 也在里头）——拿整份请求体去判「有没有当初那一份」，
 * **永远为真**，判不出「这一趟读回来的是哪一份」。
 * 最新那一次读的结果**只可能落在最后一条消息上**，故把它单独取出来判。
 */
function lastMessageOf(request: FixtureRequest | undefined): string {
  const messages = request?.body['messages']
  if (!Array.isArray(messages) || messages.length === 0) return ''

  return JSON.stringify(messages[messages.length - 1])
}

/** 收过摊的（同一会话只收一次——驱动的 `close` 没有二次调用守卫）。 */
const closed = new WeakSet<UiSession>()

async function close(session: UiSession): Promise<void> {
  if (closed.has(session)) return
  closed.add(session)

  // 先等它闲下来——忙的时候 `ctrl+c` 是**中断**不是退出（外壳的既有语义）
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 10_000 }).catch(() => undefined)
  // 空闲**按两次**才走（U46）——`quit()` 就是那一套（第一下只印那一行）
  await session.quit()
  const report = await session.close({ graceMs: 3_000 })
  const how = `${report.exit.by}（code ${report.exit.code ?? '-'} / signal ${report.exit.signal ?? '-'}）`

  if (report.exit.by !== 'app') throw new Error(`应用不是自己走的（${how}）——收摊那条路没走完`)

  console.log(`  · 收摊：${how} · 帧 ${report.frames} 张 · 现场 ${report.runDir}`)
}

// ══ ①～③ 工单的示例场景 ═══════════════════════════════════════════════

async function example(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u36-示例',
    artifacts: join(out, 'runs'),
    // ⚠️ **模型自己去要那三处材料**（U63 起正文按需自读，见 ③ 那一处的注）——
    //    三处引用它是按句子的次序读的（这正是这一节要判的「位置」在今天的形状）
    turns: [
      { kind: 'tool', name: 'read', args: { path: '需求.md' } },
      { kind: 'tool', name: 'read', args: { path: 'src/login.ts' } },
      { kind: 'tool', name: 'skill', args: { name: 'review' } },
      { kind: 'text', text: '好，先看登录。', chunks: 3, chunkDelayMs: 40 },
    ],
  })

  try {
    const { workspace } = session.facts()
    put(workspace, '需求.md', '要求：先看登录逻辑。')
    put(workspace, 'src/login.ts', 'export const login = () => 1')
    put(
      workspace,
      '.magic/skills/review/SKILL.md',
      '---\nname: review\ndescription: 检查改动\n---\n\n逐条核对清单。\n',
    )

    // —— ① `@` 开候选：真去看了一眼工作区 ——
    await typeLine(session, '先读 ')
    await typeAt(session)
    await session.wait({ text: 'src' }, { timeoutMs: 10_000 })
    const opening = await session.capture({ label: '01-@候选' })
    keep(out, opening, '01-@候选')
    check(has(opening, '先读 @'), '输入行留着（引用正长在那句话里，看得见）')

    check(has(opening, '目录'), '候选里说得出哪一条是目录')
    check(has(opening, '文件'), '候选里说得出哪一条是文件')
    check(has(opening, '需求.md'), '**真工作区**里的文件在候选里（不是桩）')

    // —— ② 选入：引用留在原位 ——
    // ⚠️ 等的是**草稿里**那一截（`@需求`）——候选行里也有「需求」（`需求.md`），
    //    等错了词会在按键还没落到草稿上时就放行（真跑栽过：回车选走了第一行 `.magic`）
    await session.send('需求', { until: { text: '@需求' }, timeoutMs: 10_000 })
    // ⚠️ 等**候选行**（它带类型那一格，草稿行没有）——等草稿是不够的：那一截在按键落下的
    //    同一瞬间就有了，而 Enter 与文本**同一次读**进去时，终端会把 `\r` 当成正文字符
    //    （真跑栽过：`src/login.ts\r\r` 成了筛选词）。等答复铺上行，Enter 才是单独一次。
    await session.wait({ text: '需求.md　文件' }, { timeoutMs: 10_000 })
    const requestsBeforePick = session.requests().length
    await pressKey(session, 'enter', { until: { absent: '　文件' }, timeoutMs: 10_000 })
    const picked = await session.capture({ label: '02-选入之后' })
    keep(out, picked, '02-选入之后')

    check(has(picked, '先读 @需求.md'), '引用留在它被说出来的位置（前面那句正文还在）')
    check(!has(picked, '（待发送）'), '不另列「待发送材料」那一行（引用就在正文里）')
    check(session.requests().length === 0, '**选入不发模型请求**（夹具收到 0 条）')
    check(session.requests().length === requestsBeforePick, '**一次选定零模型请求**（选定前后条数不变）')

    // 记下提交前的请求数（选定三处都不该动它；提交那一下要恰好 +1）
    const wantRequests = session.requests().length + 1

    // —— ③ 句中再放两处（技能 ＋ 文件）：**选定都不发送** ——
    await typeLine(session, '，再按 ')
    await session.send('/review', { until: { text: '/review' }, timeoutMs: 10_000 })
    // 句中的 `/名称` **要显式选定**（候选里认得出就 Tab 放进草稿）——不扫描正文去猜
    await pressKey(session, 'tab')
    await Bun.sleep(200) // 选定只改草稿上的身份（屏上的字不变）——等一小会儿再往下走
    await typeLine(session, ' 检查 ')
    await typeAt(session)
    await session.send('src/login.ts', { until: { text: '@src/login.ts' }, timeoutMs: 10_000 })
    await session.wait({ text: 'src/login.ts　文件' }, { timeoutMs: 10_000 })
    const beforePick = await session.capture({ label: '03b-候选就位' })
    keep(out, beforePick, '03b-候选就位')
    await pressKey(session, 'enter', { until: { absent: '　文件' }, timeoutMs: 10_000 })

    const composed = await session.capture({ label: '03a-一句话三处引用' })
    keep(out, composed, '03a-一句话三处引用')

    check(has(composed, '先读 @需求.md，再按 /review 检查 @src/login.ts'), '三处引用都在它们被说出来的位置')
    check(session.requests().length === 0, '**三处都选好了，一个模型请求都还没发**')
    check(session.requests().length === wantRequests - 1, '**每一次选定都零请求**（三处选完仍是 0）')

    // —— ④ 提交：正文原样送出去；三处材料**由模型自己取**（U63）——
    //
    // ⚠️ **判据换过（U87）**——**换的不是「该咬什么」，是「拿什么证」**。
    //
    //   原来咬的是「提交之后 **需求.md / login.ts 的当前内容进了这次请求**」＋
    //   「材料按原句次序展开」——那是 U63 之前的产品行为：**材料随用户消息整段递进去**。
    //   U63 把送达方式改成**模型按需自读**（`conversation/refs.ts` 文件头注：文件 / 目录 /
    //   技能都不再随请求展开，引用留在交代里的原位），于是那几句**没有对象了**：
    //   第一次请求里不可能有正文——**再拿它们当判据，红的会是产品今天正确的样子**。
    //
    //   **它们要证的那件事一个字没变：这一趟里那三处材料真交到了模型手上。**今天这件事
    //   的证据分成两半（与 `frames-u33-tui` ③ 同形）：
    //
    //   | 半 | 咬的是 |
    //   | --- | --- |
    //   | ① 第一次请求里**三份正文都没有**，而引用原样在句子里 | 送达方式是自读、不是整段递进 |
    //   | ② 模型要过之后，三份正文**真进了紧接着那几次请求** | 要了**真给到**（取件那一趟没断） |
    //
    //   ⚠️ **「按原句次序展开」这一条没有搬到 ② 上**：自读这一版里，「哪一份先到」由
    //   **模型读的次序**定（这一趟的剧本里就是按句子次序读的）——拿它当判据，量的是
    //   **剧本**，不是产品。次序那件事今天由「**引用留在原位**」承担：正文一个字不剥，
    //   三处的 `at` 各自记着位置（下面那几条），模型读到哪一句就知道哪一份管哪一处。
    await pressKey(session, 'enter', { until: { text: '好，先看登录。' }, timeoutMs: 20_000 })
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 20_000 })
    const sent = await session.capture({ label: '03-提交之后' })
    keep(out, sent, '03-提交之后')

    const requests = session.requests()
    // 提交那一趟 ＋ 三处材料各要一次（最后一次要完，模型才回话）
    check(
      requests.length === wantRequests + 3,
      `这一趟**四次模型请求**（提交那一次 ＋ 三处材料各一次；选定三处零请求 ⇒ ${wantRequests}+3；实测 ${requests.length} 条）`,
    )

    // ① 第一次请求：**三份正文一份都不在**，而正文原样、引用在原位
    const first = bodyTextOf(requests[0])
    check(!first.includes('要求：先看登录逻辑。'), '第一次请求里**没有 需求.md 的正文**（U63：不整段递进去）', first.slice(0, 400))
    check(!first.includes('export const login = () => 1'), '也没有 login.ts 的正文')
    check(!first.includes('逐条核对清单。'), '也没有技能主文（三处都不随请求展开）')
    check(first.includes('先读 @需求.md，再按 /review 检查 @src/login.ts'), '正文一个字不剥（引用那一段原样在）')
    check(has(sent, '先读 @需求.md'), '记录区回显的是**原话**（不是剥过的那半截）')

    // ② 模型要过之后：**三份正文真到了它手上**（每一处各自在**它被要到之后**的那次请求里）
    const bodies = requests.map((one) => bodyTextOf(one))
    const at需求 = bodies.findIndex((text) => text.includes('要求：先看登录逻辑。'))
    const at登录 = bodies.findIndex((text) => text.includes('export const login = () => 1'))
    const at技能 = bodies.findIndex((text) => text.includes('逐条核对清单。'))
    check(at需求 === 1, `**需求.md 的当前内容真到了模型手上**（第 ${at需求} 次请求里认得出它）`)
    check(at登录 === 2, `**login.ts 的当前内容也到了**（第 ${at登录} 次请求里认得出它）`)
    check(at技能 === 3, `**技能主文也到了**（第 ${at技能} 次请求里认得出它）`)

    // —— 记录：位置 / 身份 ——（「实际交付的那一份」的落点见下面的注）
    const raw = readDatabase(join(session.facts().dataDir, 'records.db'))
    const user = raw.entries.filter((row) => row.kind === 'user')
    // ⚠️ **「当时实际交付的那一份内容」今天的落点是 `tool-result` 条目**（U63 起引用条目
    //    不带正文，见下）——读一次就落一条，正文在那一格里（与屏幕上的工具行同源）。
    const results = raw.entries.filter((row) => row.kind === 'tool-result')
    const calls = raw.entries.filter((row) => row.kind === 'tool-call')
    raw.close()

    check(user.length === 1, `库里正好一条用户条目（实测 ${user.length} 条）`)
    const payload = JSON.parse(user[0]?.payload ?? '{}') as {
      readonly refs?: readonly { readonly at: number; readonly marker: string; readonly text?: string }[]
    }
    check(payload.refs?.length === 3, `记录里是三处引用（实测 ${payload.refs?.length ?? 0} 处）`)
    check(payload.refs?.[0]?.marker === '@需求.md', '第一处的正文标记记着（位置的自证）')
    check(payload.refs?.[0]?.at === 3, '位置是 3（「先读 」之后）——**不是**统一前置')
    check(payload.refs?.[1]?.marker === '/review', '第二处是句中的那个技能（名称留在原位）')
    check(payload.refs?.[2]?.marker === '@src/login.ts', '第三处是句尾那个文件')
    // ⚠️ **原判「当时实际交付的那一份内容留在记录里」（`refs[i].text`）——U63 起引用条目
    //    不带正文**：送达方式是自读，条目里留的是**身份与位置**，正文由模型自己取、
    //    落在 `tool-result` 那一格里（下面两条就是它的新落点）。**没删，换了地方证。**
    check(
      payload.refs?.every((ref) => ref.text === undefined) === true,
      '三处引用条目**都不带正文**（U63：正文由模型按需自取，条目只留身份与位置）',
    )
    check(user[0]?.content_text === '先读 @需求.md，再按 /review 检查 @src/login.ts', '条目正文＝用户原话')
    check(calls.length === 3, `三次取件各留了一条调用条目（实测 ${calls.length} 条）`)
    check(
      results.some((row) => (row.content_text ?? '').includes('要求：先看登录逻辑。')),
      '**当时取回来的那一份内容留在记录里**（`tool-result` 那条——需求.md）',
    )
    check(
      results.some((row) => (row.content_text ?? '').includes('逐条核对清单。')),
      '技能主文也在（这一条交代用它做事——`tool-result` 里认得出它）',
    )

    // 物证留一份（人能直接读的那两段）：**每次出站请求** ＋ **库里的载荷**
    writeFileSync(
      join(out, '03c-记录与请求.txt'),
      [
        '【四次出站请求的整份请求体（夹具收到的）——第 1 次没有正文，第 2/3/4 次各多一份】',
        ...bodies.flatMap((text, index) => [`——— 第 ${index + 1} 次 ———`, text, '']),
        '【库里那三份取回来的结果（`tool-result` 条目正文）】',
        ...results.map((row) => `- ${(row.content_text ?? '').slice(0, 120)}`),
        '',
        '【库里的 user 条目（直读）】',
        `content_text: ${user[0]?.content_text ?? ''}`,
        `payload: ${JSON.stringify(payload, null, 2)}`,
        '',
      ].join('\n'),
      'utf8',
    )
  } finally {
    await close(session)
  }
}

// ══ ④ 原位删除：退格整处移除 ═══════════════════════════════════════

async function removing(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u36-原位删除',
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    const { workspace } = session.facts()
    put(workspace, 'a.txt', '甲的正文')

    await typeLine(session, '看 ')
    await typeAt(session)
    await session.wait({ text: 'a.txt　文件' }, { timeoutMs: 10_000 })
    await pressKey(session, 'enter', { until: { absent: '　文件' }, timeoutMs: 10_000 })
    const picked = await session.capture({ label: '04a-选入' })
    keep(out, picked, '04a-选入')

    // 插入点正停在引用之后——退格那一下摘掉的是**整处引用**
    // 等**引用那一段消失**（`@a.txt` 不在屏上）——等「看 」是不够的：它本来就在屏上
    await pressKey(session, 'backspace', { until: { absent: '@a.txt' }, timeoutMs: 10_000 })
    const removed = await session.capture({ label: '04-原位删除' })
    keep(out, removed, '04-原位删除')

    check(!has(removed, '@a.txt'), '整处引用没了（没有留下半截 `@a.tx`）')
    check(has(removed, '看'), '前后那句话一个字不动')
    check(session.requests().length === 0, '全程零模型请求')
  } finally {
    await close(session)
  }
}

// ══ ⑤ 窄窗：候选还成不成行 ═══════════════════════════════════════════

async function narrow(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u36-窄窗',
    artifacts: join(out, 'runs'),
    columns: 46,
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    const { workspace } = session.facts()
    put(workspace, 'src/components/very-long-name-for-a-file.ts', 'x')
    put(workspace, 'src/sprawling-name-that-will-not-fit-on-one-line.ts', 'y')

    await typeLine(session, '看 ')
    await typeAt(session)
    await session.send('src/', { until: { text: '@src/' }, timeoutMs: 10_000 })
    // ⚠️ 窄窗下行会被**截断**（`src/sprawling-name-that-will-not-fit-…`）——等一个截不断的前缀
    await session.wait({ text: 'sprawling-name-that-will-not-fit' }, { timeoutMs: 10_000 })
    const shot = await session.capture({ label: '05-窄窗候选' })
    keep(out, shot, '05-窄窗候选')

    check(has(shot, 'sprawling-name'), '窄窗下候选列出来了')
    check(has(shot, 'components'), '目录那一条也在')
    // 一行一条（折行了高度账与屏就分家——U31 的老病）：候选行都带序号那一格
    const rows = shot.lines.filter((line) => /^\s*\d+ /.test(line))
    check(rows.length >= 2, `候选一行一条（实测 ${rows.length} 行）`)
    check(
      rows.every((line) => line.trimEnd().length <= 46),
      '候选行一行都不超宽（没折行）',
      rows.join(' / '),
    )

    // —— 选一个**长到会折行**的文件名：引用跨两行时那两段仍上对色 ——
    await session.send('sprawling', { until: { text: '@src/sprawling' }, timeoutMs: 10_000 })
    // 候选那行的 meta 在 46 列下被截成 `…`（正是「一行一条」该有的样子）——不等它，
    // 等**选定之后**折下去的那半截名字上屏（它只可能来自「引用真放进了这句话里」）
    // 折行把名字劈成两半：等**下一行**那半截（`n-one-line.ts`）——它只可能来自这一次选定
    await pressKey(session, 'enter', { until: { text: 'n-one-line.ts' }, timeoutMs: 10_000 })
    const wrapped = await session.capture({ label: '05b-引用折行' })
    keep(out, wrapped, '05b-引用折行')

    const screen = await session.screen()
    const lines = screen.lines.map((line) => line.text)
    const first = lines.findIndex((line) => line.includes('看 @src/sprawling'))
    check(first !== -1, '引用那一段在屏上')

    /**
     * 引用那几格的色 —— **与同一屏上的「用户色」比，不硬比 RGB 常量**。
     *
     * 由头（2026-09-22 · 独立复核）：色**档**是终端能力说了算的——同一份代码在真彩终端上吐
     * `#56b6c2`，在 256 色终端上吐最近的 `ansi:116`（chalk 的降档，**色还是那个色**）。
     * 硬比 `#56b6c2` 于是量的是「这一趟的终端有多能显色」，不是「引用有没有上用户色」。
     * 判据改成分母在**同一帧**里取：`› ` 提示符用的就是 `PALETTE.user`（`composer.ts`）——
     * 引用那几格必须与它**同色**，且与正文那句**不同色**。
     */
    const on = (row: number): readonly { readonly text: string; readonly fg: string | null }[] =>
      screen.cellsOf(row).filter((cell) => cell.text.trim() !== '')
    const at = (row: number, text: string): number => on(row).findIndex((cell) => cell.text === text)

    const userColor = on(first).find((cell) => cell.text === '›')?.fg
    check(userColor !== undefined && userColor !== null, '这一屏有「用户色」（`› ` 提示符上量得到）')

    // 这一行：`› 看 @src/sprawling…`——引用从那个 `@` 一直排到行尾
    const refAt = at(first, '@')
    const bodyAt = at(first, '看')
    check(refAt !== -1 && bodyAt !== -1, '引用与正文都在同一行上')

    const quote = on(first).slice(refAt).map((cell) => cell.fg ?? '（无色）')
    const body = on(first)[bodyAt]?.fg ?? '（无色）'
    check(quote.length > 0 && quote.every((color) => color === userColor), '引用与 `› ` 同色（同一档里就是同一个色）', quote.join(','))
    check(body !== userColor, '正文那句不是用户色（两样分得开）', body)

    // 折下去的那半截：**区间逐行算**，第二行上照样是用户色
    const tail = on(first + 1).map((cell) => cell.fg ?? '（无色）')
    check(tail.length > 0 && tail.every((color) => color === userColor), '折下去那半截也是用户色', tail.join(','))
    check(
      lines.every((line) => line.length <= 46),
      '整屏一行都不超宽（没折行账与屏分家）',
    )
  } finally {
    await close(session)
  }
}

// ══ ⑥ 取不到就保稿（二进制 / 不在了）════════════════════════════════

async function keepDraft(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u36-保稿',
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    const { workspace } = session.facts()
    const gone = put(workspace, 'gone.txt', '等会儿就删掉')

    await typeLine(session, '看 ')
    await typeAt(session)
    await session.send('gone', { until: { text: '@gone' }, timeoutMs: 10_000 })
    await session.wait({ text: 'gone.txt　文件' }, { timeoutMs: 10_000 })
    await pressKey(session, 'enter', { until: { absent: '　文件' }, timeoutMs: 10_000 })

    // 提交之前把它删掉——取不到就整条不跑，原稿还回输入区
    const { rmSync } = await import('node:fs')
    rmSync(gone)
    await pressKey(session, 'enter', { until: { text: '没送出' }, timeoutMs: 15_000 })
    const shot = await session.capture({ label: '06-取不到则保稿' })
    keep(out, shot, '06-取不到则保稿')

    check(has(shot, '没送出'), '回执说了这一条没送出')
    check(has(shot, '看 @gone.txt'), '原稿原样还回输入区（含那处引用）')
    check(session.requests().length === 0, '**一次模型请求都没发**（不发残缺输入）')
  } finally {
    await close(session)
  }
}

// ══ ⑦ 目录引用：有界清单 ═══════════════════════════════════════════

async function directory(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u36-目录',
    artifacts: join(out, 'runs'),
    // ⚠️ **目录也归「模型按需自读」那一类**（U63）——它自己要一次 `ls`，见下面那一处的注
    turns: [
      { kind: 'tool', name: 'ls', args: { path: 'src' } },
      { kind: 'text', text: '好。' },
    ],
  })

  try {
    const { workspace } = session.facts()
    put(workspace, 'src/a.ts', 'a')
    put(workspace, 'src/sub/b.ts', 'b')

    await typeLine(session, '看看 ')
    await typeAt(session)
    await session.send('src/', { until: { text: '@src/' }, timeoutMs: 10_000 })
    await session.wait({ text: 'a.ts' }, { timeoutMs: 10_000 })
    const candidates = await session.capture({ label: '07a-目录候选' })
    keep(out, candidates, '07a-目录候选')

    // 目录那一条排在文件之后（`a.ts` / `sub`）——按 `↓` 挪到它上面再回车？不必：
    // 直接把查询打全（`@src/sub` 之类）——这里选的是**整条 src 目录**
    await pressKey(session, 'backspace') // 去掉尾斜杠，让候选收成「src 这一条目录」
    await session.wait({ text: 'src　目录' }, { timeoutMs: 10_000 })
    await pressKey(session, 'enter', { until: { absent: '　目录' }, timeoutMs: 10_000 })
    await typeLine(session, ' 里有什么')
    await pressKey(session, 'enter', { until: { text: '好。' }, timeoutMs: 20_000 })
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 20_000 })
    const sent = await session.capture({ label: '07-目录引用' })
    keep(out, sent, '07-目录引用')

    // ⚠️ **判据换过（U87）**——与 ③ 同一条：U63 起**目录材料也不随请求展开**，
    //    模型自己 `ls` 去取。**要证的那件事一个字没变**：这一处目录引用交到模型手上时
    //    是**有界的一层清单**（带尾斜杠、不递归）——只是今天「交」发生在它自己要的那一趟。
    const requests = session.requests()
    const first = bodyTextOf(requests[0])
    check(!first.includes('a.ts'), '第一次请求里**没有目录清单**（U63：不整段递进去）', first.slice(0, 400))
    check(first.includes('@src/'), '引用原样留在句子里')

    check(requests.length === 2, `这一趟**两次模型请求**（提交那一次 ＋ 模型要目录那一次；实测 ${requests.length} 条）`)
    const after = bodyTextOf(requests[1])
    check(after.includes('a.ts'), '**模型要了就拿到了那份清单**——目录材料是有界清单（一层）', after.slice(0, 400))
    check(after.includes('sub/'), '目录那一项带尾斜杠（一眼分得出）')
    check(!after.includes('b.ts'), '**不递归**（下一层的内容不进来）')
  } finally {
    await close(session)
  }
}

// ══ ⑧ 输入历史：召回整份草稿，编辑之后再提交 ═══════════════════════════

async function recall(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u36-召回再提交',
    artifacts: join(out, 'runs'),
    // 两轮的答复**写得不一样**：等条件要等「只有这一次才会出现的东西」
    // （两轮同文的话，第二次的等待会被第一轮那行字提前满足——真跑栽过）
    //
    // ⚠️ **每一轮各要一次那两处材料**（U63 起按需自读；这一节要证的正是
    //    「重新提交时读到的是**改动之后**那一份」，见下面那一处的注）——故是六回合：
    //    读文件 · 读技能 · 回话，再来一遍。
    turns: [
      { kind: 'tool', name: 'read', args: { path: 'a.txt' } },
      { kind: 'tool', name: 'skill', args: { name: 'review' } },
      { kind: 'text', text: '好。' },
      { kind: 'tool', name: 'read', args: { path: 'a.txt' } },
      { kind: 'tool', name: 'skill', args: { name: 'review' } },
      { kind: 'text', text: '再看了一遍。' },
    ],
  })

  try {
    const { workspace } = session.facts()
    const file = put(workspace, 'a.txt', '第一版')
    put(workspace, '.magic/skills/review/SKILL.md', '---\nname: review\ndescription: 检查改动\n---\n\n逐条核对清单。')

    // —— 头一条：文件 ＋ 技能，两句都选出来，再提交 ——
    await typeLine(session, '先读 ')
    await typeAt(session)
    // 打进筛选（不筛的话选中的是列表第一行 `.magic`——那是挑走了另一条）
    await session.send('a.txt', { until: { text: '@a.txt' }, timeoutMs: 10_000 })
    await session.wait({ text: 'a.txt　文件' }, { timeoutMs: 10_000 })
    await pressKey(session, 'enter', { until: { absent: '　文件' }, timeoutMs: 10_000 })
    await typeLine(session, '，再按 ')
    await session.send('/rev', { until: { text: '/rev' }, timeoutMs: 10_000 })
    // 等**候选行**上屏（目录答复是异步的）：`Tab` 才有东西可选定
    await session.wait({ text: '检查改动' }, { timeoutMs: 10_000 })
    await pressKey(session, 'tab')
    await Bun.sleep(200)
    await pressKey(session, 'enter', { until: { text: '好。' }, timeoutMs: 20_000 })
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 20_000 })

    const sentOne = await session.capture({ label: '08a-第一条送出去' })
    keep(out, sentOne, '08a-第一条送出去')

    // ⚠️ **判据换过（U87）**——与 ③ 同一条：U63 起**材料不随请求展开**，模型自己取。
    //    **要证的那件事一个字没变：这一趟里那两处材料真交到了它手上，且交的是
    //    `那时候盘上的那一份`。**证据换成「提交那一趟没有正文 ＋ 模型要了之后那次有」。
    const bodies = (): readonly string[] => session.requests().map((one) => bodyTextOf(one))
    check(bodies().length === 3, `第一次提交后**三次请求**（提交 ＋ 两处材料各一次；实测 ${bodies().length}）`)
    check(bodies()[0]?.includes('第一版') !== true, '提交那一趟里**没有正文**（U63：不整段递进去）')
    check(
      lastMessageOf(session.requests()[1]).includes('第一版'),
      '**模型要了、拿到的正是当时那一份**（`第一版`——它落在最后那条消息上）',
    )

    // —— 改源文件：已发送的那一份不该被改写 ——
    writeFileSync(file, '第二版', 'utf8')

    // —— 用户已经在打新的一条（原稿），这时上下翻历史 ——
    // ⚠️ 文本与按键**分次写**且等一会儿（挤在一次读里 `\r` 会变成正文字符，见文件头注）
    await typeLine(session, '原稿半句')
    // ⚠️ 等的是**输入行那一份**（行首那个空格是盒子的内边距）——记录区里也有一行同样的字
    //    （第一条的回显），拿它当判据会在召回**还没发生**时就放行（真跑栽过：08b 拍早了）
    await pressKey(session, 'up', { until: { text: ' › 先读 @a.txt，再按 /review' }, timeoutMs: 10_000 })
    const recalled = await session.capture({ label: '08b-召回（引用也在）' })
    keep(out, recalled, '08b-召回（引用也在）')

    check(has(recalled, ' › 先读 @a.txt，再按 /review'), '召回的是**整份草稿**（正文与两处引用都在原位）')
    check(bodies().length === 3, '**翻历史不发请求**（夹具仍只有那三条）')

    // 往回一下：原稿整份回来
    await pressKey(session, 'down', { until: { text: ' › 原稿半句' }, timeoutMs: 10_000 })
    const back = await session.capture({ label: '08c-返回原稿' })
    keep(out, back, '08c-返回原稿')
    check(has(back, ' › 原稿半句'), '从最新历史按下 `↓` ⇒ 原稿整份回来')

    // —— 再召回来、接着编辑、提交 ——
    await pressKey(session, 'up', { until: { text: ' › 先读 @a.txt，再按 /review' }, timeoutMs: 10_000 })
    await typeLine(session, ' 再看一遍')
    await pressKey(session, 'enter', { until: { text: '再看了一遍。' }, timeoutMs: 20_000 })
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 20_000 })

    const again = await session.capture({ label: '08-召回后编辑再提交' })
    keep(out, again, '08-召回后编辑再提交')

    // 第二轮的三个回合：再提交那一次 ＋ 两处材料各一次
    check(bodies().length === 6, `第二次提交后**六次请求**（两轮各三次；实测 ${bodies().length}）`)
    const requests = session.requests()
    const secondRound = bodies().slice(3)
    check(secondRound[0]?.includes('再看一遍') === true, '召回之后编辑的那几个字在')
    // ⚠️ **判的是「最后一条消息」**（见 `lastMessageOf` 的注）：整份请求体里本来就带着第一轮
    //    的历史（那一次读回来的 `第一版` 也在），拿它判「有没有正文」**永远为真**。
    check(lastMessageOf(requests[3]).includes('第二版') !== true, '再提交那一趟里**没有当前正文**（照样是自读，不预取）')
    // ⚠️ **这一条是这一节的原判据**（原来咬的是「重新提交时 `lastUser` 里是 `第二版`」）——
    //    今天「读」发生在模型要的那一趟，故咬在**它这一趟要回来的那一份**上：改动之后的当前内容。
    check(
      lastMessageOf(requests[4]).includes('第二版'),
      '**重新提交时才读**：模型拿到的是改动之后的当前内容（`第二版`）',
      lastMessageOf(requests[4]).slice(0, 300),
    )
    check(lastMessageOf(requests[4]).includes('第一版') !== true, '**这一趟要回来的**不是当初那一份')
    check(secondRound[2]?.includes('逐条核对清单。') === true, '技能那处身份随召回一起回来了（读的是当前那一份主文）')

    // —— 记录：两笔各自留着当时那一份，位置自证 ——
    const raw = readDatabase(join(session.facts().dataDir, 'records.db'))
    const user = raw.entries.filter((row) => row.kind === 'user')
    // ⚠️ 「当时那一份」今天的落点是 **`tool-result` 条目**（U63 起引用条目不带正文，见下）
    const tookBack = raw.entries
      .filter((row) => row.kind === 'tool-result')
      .map((row) => row.content_text ?? '')
    raw.close()

    check(user.length === 2, `库里两条用户条目（实测 ${user.length}）`)
    const payloads = user.map((row) => JSON.parse(row.payload ?? '{}') as {
      readonly refs?: readonly { readonly at: number; readonly marker: string; readonly text?: string }[]
    })

    check(payloads[0]?.refs?.length === 2, '第一条记着两处引用（文件 ＋ 技能）')
    // ⚠️ **原判「第一条留的是当时那一份」（`refs[0].text === '第一版'`）——U63 起引用条目
    //    不带正文**（见 ③ 那一处的注）。**没删，换了地方证**：读回来的那一份落在
    //    `tool-result` 条目里，两趟各留各的——「当时那一份留在记录里」这句话照旧成立。
    check(
      payloads[0]?.refs?.every((ref) => ref.text === undefined) === true,
      '两条的引用条目**都不带正文**（U63：正文由模型按需自取）',
    )
    check(
      tookBack.some((text) => text.includes('第一版')),
      '第一趟取回来的那一份（`第一版`）留在记录里',
    )
    check(
      tookBack.some((text) => text.includes('第二版')),
      '第二趟取回来的是**新的那一份**（`第二版`）——两趟各留各的，互不覆盖',
    )
    for (const [index, payload] of payloads.entries()) {
      const text = user[index]?.content_text ?? ''
      for (const ref of payload.refs ?? []) {
        check(text.slice(ref.at, ref.at + ref.marker.length) === ref.marker, `第 ${index + 1} 条的引用位置对得上（${ref.marker}）`)
      }
    }

    // 物证留一份（人能直接读的那两段）：**两轮各三次出站请求** ＋ **库里两条载荷**
    writeFileSync(
      join(out, '08d-召回后的记录与请求.txt'),
      [
        '【两轮各三次出站请求的整份请求体（夹具收到的）——每轮：提交那一次没有正文，'
          + '文件与技能各要一次之后才有】',
        ...bodies().flatMap((text, index) => [`——— 第 ${index + 1} 次 ———`, text, '']),
        '【库里取回来的那几份（`tool-result` 条目正文）】',
        ...tookBack.map((text) => `- ${text.replace(/\n/g, ' / ').slice(0, 160)}`),
        '',
        '【库里两条 user 条目（直读）】',
        ...user.flatMap((row, index) => [
          `—— 第 ${index + 1} 条 ——`,
          `content_text: ${row.content_text ?? ''}`,
          `payload: ${JSON.stringify(payloads[index], null, 2)}`,
          '',
        ]),
      ].join('\n'),
      'utf8',
    )
  } finally {
    await close(session)
  }
}

// ══ ⑨ 粘贴：原文照收（Tab 与多行）——独立复核给的那一段 ═══════════════

async function pasting(out: string): Promise<void> {
  const session = await createUiSession({
    label: 'u36-粘贴原文',
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '收到。' }],
  })

  try {
    // 复核给的那一段：**行首 Tab 缩进 ＋ 行内 Tab 分隔 ＋ 多行**，一个都不许动
    const pasted = 'if ready:\n\tprint(1)\nleft\tright'

    // bracketed paste（真终端那一条信道）：外面那两串是 Ink `usePaste` 认的包裹标记
    await session.send(`\u001b[200~${pasted}\u001b[201~`, { until: { text: 'print(1)' }, timeoutMs: 10_000 })
    const held = await session.capture({ label: '09a-粘贴之后（还没发）' })
    keep(out, held, '09a-粘贴之后（还没发）')

    check(session.requests().length === 0, '**粘贴不发送**（夹具仍 0 条）')

    await pressKey(session, 'enter', { until: { text: '收到。' }, timeoutMs: 15_000 })
    const sent = await session.capture({ label: '09-粘贴原文照收' })
    keep(out, sent, '09-粘贴原文照收')

    const carried = session.requests()[0]?.lastUser ?? ''
    check(carried.includes(pasted), '模型请求里那一段**逐字**在（Tab 与换行都在）', JSON.stringify(carried))
    check(carried.includes('\tprint(1)'), '行首那个 Tab 没被删（缩进还在）')
    check(carried.includes('left\tright'), '行内那个 Tab 没被删（分隔还在）')

    const raw = readDatabase(join(session.facts().dataDir, 'records.db'))
    const user = raw.entries.filter((row) => row.kind === 'user')
    raw.close()
    check(user[0]?.content_text === pasted, '记录里也逐字相同', JSON.stringify(user[0]?.content_text))
  } finally {
    await close(session)
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const out = at === -1 ? tempDir('magic-frames-u36-') : (process.argv[at + 1] as string)
  mkdirSync(out, { recursive: true })

  await example(out)
  await removing(out)
  await narrow(out)
  await keepDraft(out)
  await directory(out)
  await recall(out)
  await pasting(out)
  console.log(`\n全部判据通过。帧落在 ${out}`)
}
