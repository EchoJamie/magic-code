#!/usr/bin/env bun
/**
 * U78 · **`/config` 补上「取网页用的模型」那一行**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真终端 ＋ 真进程**才说得清
 * 的那几件：那一行在屏上长什么样（值那一格读着像不像人话）、照 `web_fetch` 报错那句走一遍
 * 走不走得通、配完之后**同一条会话**再跑是不是真就通了、会话那个模型有没有被动过。
 *
 * ## 一趟会话，走完用户撞上的那条路
 *
 * 本单的由头是「**报错指的路走不通**」——故这里**不复刻那三个动作，而是照那条路走一遍**：
 * 报错说了「去 `/config` 挑一个」，那就去 `/config` 挑一个，再回来接着跑。
 *
 * | 段 | 干什么 | 要看见什么 |
 * | --- | --- | --- |
 * | ① **撞上报错** | 没配 `webFetch`，让模型取一次网页 | 屏上 `✗ … 还没配提炼用的模型——去 /config 挑一个` |
 * | ② **照那句话走** | `/config` ⇒ 真有那一行，值写着「还没配」⇒ 选中 ⇒ 模型选择器（**说清作用对象**）⇒ 选一条回车 | 那一行／选择器那一屏／保存之后那一格**跟着变**（现读） |
 * | ③ **回来接着跑** | 同一条会话再交代一句 | **不再报「还没配」**：真取回、真提炼、答案上屏 |
 *
 * ## 判据怎么咬
 *
 * - **屏上**：帧里的字（那一行的名称与值、选择器的说明、回执、结果行的结论）；
 * - **出站**：`session.requests()` 那一串——四次调用四个模型名，**提炼那一跳用的是刚挑的那个**，
 *   且**当前会话那个模型一个字没变**（② 的反面）；
 * - **盘上**：配完那一刻的 `config.json` 原样抄一份进帧目录（写没写进去，看文件）。
 *
 * ## 真帧（第 ③ 段会真出网）
 *
 * 取回那一跳没有注入的口子（真 PTY 跑的是真 `cli.ts`），而工单要的正是「配完再跑就通了」——
 * 故第 ③ 段取的是 `https://example.com/`（U72 那支帧套件同一个稳定公开页）。提炼那一跳
 * 仍走环回夹具（答案由剧本给，判据不押真模型的措辞）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u78-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUiSession, createSandbox, startFixture, statusLineOf } from './ui/index.ts'
import type { Capture, UiSession, WaitCondition } from './ui/index.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 写一次并等一个条件（驱动那个 `WriteUntil` 没有出包，按它那份形写一份）。 */
type WriteUntil = { readonly until: WaitCondition; readonly timeoutMs?: number }

/** 这一趟的产物根——入口解析 `--out` 之后填。 */
let out = ''

/** 判据攒着最后一起报（同既有几支帧套件：改前改后各跑一遍做对照）。 */
const failures: string[] = []

function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}${detail === '' ? '' : `（${detail}）`}`)
    return
  }

  failures.push(what)
  console.log(`  ✗ ${what}${detail === '' ? '' : `（${detail}）`}`)
}

/** 留一屏——文本写进 `<out>/<名字>.txt`，字格写进同名 `.json`。 */
function keep(shot: Capture): void {
  writeFileSync(join(out, `${shot.label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${shot.label}.json`),
    `${JSON.stringify({ lines: shot.lines, cells: shot.lines.map((_l, row) => shot.cellsOf(row)) }, null, 1)}\n`,
    'utf8',
  )
}

/** 等一个条件在**可见屏**上成立（默认 25 秒——真出网那一跳要给它时间）。 */
async function waitUntil(
  session: UiSession,
  what: string,
  ok: (lines: readonly string[]) => boolean,
  timeoutMs = 25_000,
): Promise<readonly string[]> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6
  for (;;) {
    const screen = await session.screen()
    const lines = screen.lines.map((line) => line.text)
    if (ok(lines)) return lines
    if (Bun.nanoseconds() > until) {
      throw new Error(`等「${what}」超时（${timeoutMs}ms）。屏：\n${lines.join('\n')}`)
    }
    await Bun.sleep(40)
  }
}

/** 敲一行字（先等它落到输入行上，再交给调用方按回车）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/**
 * 按一个键——**写之前先隔一拍**（由头与 U71 那支帧套件同一条）。
 *
 * ⚠️ PTY 上两次写挨得太近，应用一次 read 会把它们**并成一块**读进来：`esc`（`\x1b`）后面
 * 紧跟正文时，那一串会被当成**一个转义序列**——`esc` 于是不生效，而打的字全进了那一屏的
 * 筛词（本单实测：`/config` 那一屏没收起来，接着打的字变成了筛词）。
 */
async function pressKey(
  session: UiSession,
  name: 'enter' | 'esc' | 'left' | 'right' | 'up' | 'down' | 'backspace',
  until?: WriteUntil,
): Promise<void> {
  await Bun.sleep(150)
  await session.key(name, until)
}

/** 屏上有没有那一句（按整行比对，避免半句匹配）。 */
function hasLine(lines: readonly string[], fragment: string): boolean {
  return lines.some((line) => line.includes(fragment))
}

/** 屏上含某词的整行（报错时贴给人看）。 */
function linesWith(lines: readonly string[], fragment: string): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.includes(fragment))
    .join(' ⏎ ')
}

/** 屏上含某词的行数——「这一轮**又**多出一句没有」用它（记录区里旧那一条还在）。 */
function countOf(lines: readonly string[], fragment: string): number {
  return lines.filter((line) => line.includes(fragment)).length
}

/**
 * **`/config` 里那一行**（按项名找）——整行文本（名称 ＋ 值都在里面）。
 *
 * ⚠️ 判据**必须只看这一行**：记录区里还留着早先那些话（① 那句报错里也有「还没配」，
 * 「外部工具」那一行本身也可能写着「还没配」）——整屏找字会把它们当成本行的话。
 */
function rowLineOf(lines: readonly string[], name: string): string {
  return lines.find((line) => line.includes(name)) ?? ''
}

/**
 * 等屏上出现**某一个**判据——「这一轮走到哪一步了」。
 *
 * ⚠️ **别拿「空闲」当「这一轮跑完了」**（U72 那条注）：提交之后到状态行翻过去之间有那么
 * 一小会儿，屏上还写着上一轮的空闲。判据锚在**这一轮才会出现的那句话**上。
 */
async function waitFor(
  session: UiSession,
  what: string,
  fragments: readonly string[],
  timeoutMs = 30_000,
): Promise<readonly string[]> {
  return waitUntil(session, what, (lines) => fragments.some((one) => hasLine(lines, one)), timeoutMs)
}

/** 夹具收到的**对话**那几跳（本沙地的连接没有 `vendor`，不会先来一发目录刷新）。 */
function chatsOf(session: UiSession) {
  return session.requests().filter((request) => request.path.endsWith('/chat/completions'))
}

/**
 * **出站请求物证**落一份盘——四次调用分别用的哪个模型、提炼那一跳带没带工具，全在里面。
 */
function keepRequests(session: UiSession, label: string): void {
  const dump = session.requests().map((request) => ({
    n: request.n,
    path: request.path,
    model: request.model,
    // ⚠️ **两种「没工具」分得开**：`没有这个键`（压根没发）与一个数（发了这么多件）
    tools: 'tools' in request.body ? (request.body['tools'] as unknown[]).length : '（没有这个键）',
    body: request.body,
  }))

  writeFileSync(join(out, `${label}.json`), `${JSON.stringify(dump, null, 2)}\n`, 'utf8')
}

const PAGE = 'https://example.com/'
/** 会话那一条连接上的模型（状态行那一格报的就是它）。 */
const SESSION_MODEL = 'MiniMax-M3'
/** 「取网页用的模型」——**另一条连接**上的另一个（判据要的是「与会话那个是两个」）。 */
const DISTILL_MODEL = 'distill-small'
const DISTILL_CONNECTION = '小模型'

/** 提炼那一跳回的答案。 */
const ANSWER = '这一页说的是 example.com 这个域名专门留作示例用，不归谁所有。'

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u78-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  const fixture = startFixture({
    model: SESSION_MODEL,
    turns: [
      // ① 没配那一趟：主轮要取网页 ⇒ **这个地方就是用户撞上来的那一处**
      { kind: 'tool', name: 'web_fetch', args: { url: PAGE, prompt: '这一页是做什么用的？' } },
      // ③ 配好之后**同一句话再说一遍**：这回要走到底（主轮 → 提炼 → 主轮）
      { kind: 'tool', name: 'web_fetch', args: { url: PAGE, prompt: '这一页是做什么用的？' } },
      { kind: 'text', text: ANSWER },
      { kind: 'text', text: '知道了。' },
    ],
  })

  /**
   * 沙地：**两条连接**——会话走 `local`，取网页那一趟挑 `small` 那一条。
   *
   * 两条都指向环回夹具（提炼是夹具回的话，判据不押真模型的措辞）；两条都是**兼容接入**
   * （没有 `vendor`）⇒ 不会先去拉一次模型列表，选择器上那两行就是各自配置里那个默认。
   * 配置里**不给 `webFetch`**——那正是「还没配」那一形，本单要修的就是它。
   */
  const sandbox = createSandbox({
    baseURL: fixture.baseURL,
    config: {
      defaultProvider: 'local',
      providers: {
        local: { baseURL: fixture.baseURL, apiKey: 'sk-fake-u78', model: SESSION_MODEL },
        small: { baseURL: fixture.baseURL, apiKey: 'sk-fake-u78', model: DISTILL_MODEL, name: DISTILL_CONNECTION },
      },
    },
  })

  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: 'u78-照报错走一遍',
      columns: 100,
      rows: 34,
      sandbox,
      fixture,
      artifacts: join(out, 'runs'),
    })
    await session.wait({ text: '空闲' }, { timeoutMs: 25_000 })

    // ══ ① 撞上报错：还没配「取网页用的模型」 ═══════════════════════════
    console.log('· ① 没配那一趟：报错那句要看得见，且它指的路在 /config 里真有一行')

    await typeLine(session, '查一下 example.com 是干什么的')
    await pressKey(session, 'enter', { until: { text: 'y 批准' }, timeoutMs: 20_000 })
    await session.send('y')
    const halted = await waitFor(session, '「还没配」上屏', ['还没配提炼用的模型'])
    const first = await session.capture({ label: '①-01-报错那一屏' })
    keep(first)

    check(
      hasLine(first.lines, '还没配提炼用的模型'),
      '① 屏上有「还没配提炼用的模型」（这就是用户撞到的那一句）',
      linesWith(first.lines, '还没配'),
    )
    check(
      hasLine(first.lines, '/config'),
      '① 那句报错**指了路**：去 /config 挑一个',
      linesWith(first.lines, '/config'),
    )
    check(halted.some((line) => line.includes('空闲')), '① 这一轮就地收束（回到等待输入）', statusLineOf(halted))

    // ══ ② 照那句话走一遍：`/config` ⇒ 那一行 ⇒ 选择器 ⇒ 保存 ══════════
    console.log('· ② 照报错那句走：/config 里真有那一行（还没配）⇒ 选中 ⇒ 选择器 ⇒ 选一条')

    await typeLine(session, '/config')
    await pressKey(session, 'enter', { until: { text: '数据目录与工作区根' }, timeoutMs: 20_000 })
    const config = await session.capture({ label: '②-01-config 那一行还没配' })
    keep(config)

    check(
      hasLine(config.lines, '取网页用的模型'),
      '② ⚠️ **本单最要紧的一条**：`/config` 里真有一行「取网页用的模型」',
      rowLineOf(config.lines, '取网页用的模型').trim() || '（没有这一行）',
    )
    check(
      rowLineOf(config.lines, '取网页用的模型').includes('还没配'),
      '② 没配时它显示「还没配」（不留空、不编一个默认）',
      rowLineOf(config.lines, '取网页用的模型').trim(),
    )
    check(
      ['模型与连接', '本工作区授权', '外部工具', '数据目录与工作区根'].every((name) =>
        hasLine(config.lines, name),
      ),
      '② 留下那四项**逐字未变**，都还在这一屏上',
    )

    // —— 选中那一行（第 2 行）⇒ 进模型选择器 ——
    await pressKey(session, 'down')
    await pressKey(session, 'enter', { until: { text: '取网页用的模型：' }, timeoutMs: 20_000 })
    const picker = await session.capture({ label: '②-02-模型选择器（说清作用对象）' })
    keep(picker)

    check(
      hasLine(picker.lines, '取网页用的模型：'),
      '② 选中它 ⇒ **进了模型选择器**（与 `/model` 那一套同形）',
      linesWith(picker.lines, '取网页用的模型：'),
    )
    check(
      hasLine(picker.lines, '当前会话的模型不受影响'),
      '② ⚠️ **屏上说清作用对象**：改的是「取网页」，不是当前会话',
      linesWith(picker.lines, '当前会话'),
    )
    check(
      !hasLine(picker.lines, '→ 看这条的详情'),
      '② 取网页那一趟**不提 `→`**（那个键在这儿是空的——报一个按下去没反应的键更坏）',
    )
    check(
      hasLine(picker.lines, SESSION_MODEL) && hasLine(picker.lines, DISTILL_MODEL),
      '② 两条连接各自的模型都在（同一个铺行的函数）',
      `要找 ${SESSION_MODEL} 与 ${DISTILL_MODEL}`,
    )
    // 「进这一屏之前」那一眼看的是**报错那一屏的状态行**——这一屏（选择器）开着时，
    // 左半那几格要给右位那句键位提示让位，模型那一格是**被省掉的**（`status.ts` 的让位次序）
    check(
      statusLineOf(first.lines).includes(SESSION_MODEL),
      '② 那一趟之前：状态行那个模型是会话那个（后面拿它当对照）',
      statusLineOf(first.lines),
    )

    // —— 挪到「取网页要用的那一个」，回车＝保存 ——
    await pressKey(session, 'down')
    await pressKey(session, 'enter', { until: { text: '取网页用的模型：distill-small' }, timeoutMs: 20_000 })
    const saved = await session.capture({ label: '②-03-保存的回执' })
    keep(saved)

    check(
      hasLine(saved.lines, `取网页用的模型：${DISTILL_MODEL} · ${DISTILL_CONNECTION}`),
      '② 回车＝**保存**，并留一行回执（说清存了哪一对）',
      linesWith(saved.lines, '取网页用的模型：'),
    )
    check(
      statusLineOf(saved.lines).includes(SESSION_MODEL),
      '② ④ 反面：**当前会话的模型没被改**（状态行照旧是会话那个）',
      statusLineOf(saved.lines),
    )

    // —— 盘上物证：那一格真写进去了 ——
    const onDisk = readFileSync(sandbox.configPath, 'utf8')
    writeFileSync(join(out, '物证-配完之后的配置文件.json'), onDisk, 'utf8')
    const parsed = JSON.parse(onDisk) as { readonly webFetch?: unknown }
    check(
      JSON.stringify(parsed.webFetch) === JSON.stringify({ provider: 'small', model: DISTILL_MODEL }),
      '② 盘上 `webFetch` 那一格写的就是刚挑的那一对',
      JSON.stringify(parsed.webFetch ?? '（没有这一格）'),
    )

    // —— 再看一眼 `/config`：那一行**跟着变了**（现读）——
    await typeLine(session, '/config')
    await pressKey(session, 'enter', { until: { text: '数据目录与工作区根' }, timeoutMs: 20_000 })
    const after = await session.capture({ label: '②-04-再看一眼（值跟着变了）' })
    keep(after)

    const row = rowLineOf(after.lines, '取网页用的模型')
    check(
      row.includes(`${DISTILL_MODEL} · ${DISTILL_CONNECTION}`),
      '② ③ 配完之后 `/config` 那一行的值**跟着变**（现读，不必重启）',
      row.trim() || '（没有这一行）',
    )
    check(
      !row.includes('还没配'),
      '② 那一行不再写着「还没配」',
      row.trim(),
    )
    check(
      hasLine(after.lines, `${SESSION_MODEL} · local`),
      '② 「模型与连接」那一行**照旧**（两行各说各的，没被连坐）',
      linesWith(after.lines, SESSION_MODEL),
    )

    // ══ ③ 回来接着跑：**同一条会话**再跑一次，不再报「还没配」 ═════════
    console.log('· ③ 配完接着说一句：同一趟会话再跑 web_fetch，不再报「还没配」')

    // ⚠️ 记下**这一趟之前**屏幕上那几句「还没配」有几条：记录区里 ① 那一条**一直还在**，
    //    故「这一趟没再报」只能拿**多没多出一条**来判（整屏找字会撞上旧那一条）
    const before = countOf(after.lines, '还没配提炼用的模型')

    // 收起 `/config` 那一屏——**等它真收起来**（右位提示回到空闲那一句）再接着打字：
    // 不等的话，正文会赶在这一下还没落地时进来（`pressKey` 那一条注里的坑）
    await pressKey(session, 'esc', { until: { text: '/ 命令' }, timeoutMs: 10_000 })
    await typeLine(session, '现在再查一次 example.com')
    await pressKey(session, 'enter', { until: { text: 'y 批准' }, timeoutMs: 20_000 })
    await session.send('y')
    /**
     * ⚠️ **`ctrl+o` 要在这一轮还在跑的时候按**（U72 那条注）：已定局的行写进 `<Static>`、
     * 写一次就不再重绘——那一轮收束之后再去展开，那一屏一个字都不会变。
     *
     * 为什么要展开：回执那几行（`提炼 …模型 …` 与那句「不是原文」）在这条目**折着**的时候
     * 不在屏上——屏上只有那半句结论。判据要读的是整段。
     */
    await session.key('ctrl+o')
    await waitFor(session, '这一趟的结论', ['这一页说的是', '取不得这一页', '取回失败'])
    const done = await session.capture({ label: '③-01-配完之后再跑（通了）' })
    keep(done)

    check(
      countOf(done.lines, '还没配提炼用的模型') === before,
      '③ ⚠️ **不再报「还没配」**——这一趟没再多出那一条',
      `这一趟前 ${before} 条、这一趟后 ${countOf(done.lines, '还没配提炼用的模型')} 条`,
    )
    check(
      hasLine(done.lines, ANSWER),
      '③ 真取回、真提炼，**答案上屏**（不是「还没配」也不是别的失败）',
      linesWith(done.lines, '这一页说的是') || linesWith(done.lines, '✗'),
    )
    check(
      hasLine(done.lines, DISTILL_MODEL) && hasLine(done.lines, '不是原文'),
      '③ 收据上说得出**提炼用的是哪个模型**（就是刚在 `/config` 里挑的那个）',
      linesWith(done.lines, '提炼 '),
    )

    // —— 出站物证：四次调用、四个模型名 ——
    const chats = chatsOf(session)
    const models = chats.map((chat) => chat.model)
    check(
      models.join(' → ') === [SESSION_MODEL, SESSION_MODEL, DISTILL_MODEL, SESSION_MODEL].join(' → '),
      '③ 出站物证：没配那一趟主轮 → 配完那一趟主轮 → **提炼（刚挑的那个）** → 主轮',
      `实测 ${models.join(' → ')}`,
    )
    const distill = chats[2]
    check(
      distill !== undefined && !('tools' in distill.body),
      '③ 提炼那一跳**不带任何工具**（U72 那条护栏照旧）',
      distill === undefined ? '（没有第三次请求）' : `keys: ${Object.keys(distill.body).join(', ')}`,
    )
    check(
      chats[3] !== undefined && !JSON.stringify(chats[3].body).includes('<html>'),
      '③ 主模型那一轮看到的仍是**提炼后的答案**（原文没进上下文）',
    )
    keepRequests(session, '出站物证-照报错走一遍')

    // —— 收尾：再验一次「当前会话的模型没动过」 ——
    const idle = await waitFor(session, '这一轮收束', ['空闲'])
    check(
      statusLineOf(idle).includes(SESSION_MODEL),
      '③ 全程走完，状态行那个模型**从头到尾都是会话那个**（U78 一处都没碰它）',
      statusLineOf(idle),
    )

    if (failures.length === 0) {
      console.log(`\n全部判据通过。帧落在 ${out}`)
    } else {
      console.log(`\n${failures.length} 条判据不过：`)
      for (const what of failures) console.log(`  ✗ ${what}`)
      console.log(`帧落在 ${out}`)
      process.exitCode = 1
    }
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
    await fixture.stop().catch(() => {})
    sandbox.dispose()
    if (at === -1) removeDir(root)
  }
}
