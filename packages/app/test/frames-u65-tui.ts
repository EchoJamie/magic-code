#!/usr/bin/env bun
/**
 * U65 · **内嵌思考的识别：别再按精确模型名漏** —— 真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真跑才说得清的那一件**：
 * 用户真机那一轮（`MiniMax-M2.7-highspeed` · settled、不是报错）为什么整段
 * `<think>…</think>` 当正文落库、也印在屏上。
 *
 * ## 装置：受控端点
 *
 * 模型那头是**环回夹具**（`fixture.ts`：真 HTTP/SSE · `127.0.0.1` · 端口自动分配 ·
 * 合成的假 key——**一个付费请求都不发**）。本单要的正是它：**两种供应商的回复形态**由剧本
 * 摆出来，而**出站请求**由它记下（`session.requests()`）。
 *
 * | 形态 | 剧本 | 现实里是谁 |
 * | --- | --- | --- |
 * | 思考**内嵌在正文里** | `text: '<think>…</think>\n\n正文'` | MiniMax 那一形 |
 * | 思考走**独立字段** | `text: '…'` ＋ `reasoning: '…'`（`reasoning_content`） | DeepSeek 那条路 / 行为正常的那一类 |
 *
 * ## 五趟
 *
 * | 趟 | 模型 | 形态 | 要看见什么 |
 * | --- | --- | --- | --- |
 * | ① | `MiniMax-M2.7-highspeed`（**用户真机那个名字**）· 宽 100×30 | 内嵌 | **拆开了** |
 * | ② | `MiniMax-M2.5-highspeed` · 窄 46×30 | 内嵌 | 同上（**同一家族的另一档**） |
 * | ③ | `gpt-4o`（表外 · 行为正常） | 独立字段 ＋ 正文里恰好有 `<think>` | **一个字都不切** ＋ 用户贴的**原样进请求** |
 * | ④ | `acme-reasoner-v9`（**表外**） | 内嵌 | 第一次**认出** · 第二次**直接按它办** |
 * | ⑤ | 同上 ＋ 覆盖位 `traits: {}` | 内嵌 | **关得掉**：一个字都不切 |
 *
 * ## 判据怎么咬（**只看屏不算**）
 *
 * 每一趟都拿两样**物证**，屏上那帧只是**给人看的**（`keep` 落的文件就是逐行读过的那一份）：
 *
 * ① **出站请求**（夹具记的 `model` / `lastUser`）——用户贴的标签**逐字**进没进请求；
 * ② **落库条目**（直读 `records.db`）——正文与思考**各在哪一格**、是不是逐字。
 *
 * ④ 的第二次是**决定性**的那一下：那一轮的回复里标签**不在开头**（在正文中间）——
 * 光靠探针接不住它，只有「**上一次认下了这个模型名**」解释得通。故它同时钉住第二层
 * 真的生效了，而不只是「这一轮碰巧切对」。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u65-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDatabase } from './support.ts'
import { createSandbox, createUiSession, startFixture, statusLineOf } from './ui/index.ts'
import type { Capture, Fixture, FixtureTurn, Sandbox, UiSession } from './ui/index.ts'
import { FAKE_API_KEY } from './ui/sandbox.ts'

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

/** 留一屏——文本写进 `<out>/<名字>.txt`，字格写进同名 `.json`。 */
function keep(shot: Capture): void {
  writeFileSync(join(out, `${shot.label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${shot.label}.json`),
    `${JSON.stringify({ lines: shot.lines, cells: shot.lines.map((_l, row) => shot.cellsOf(row)) }, null, 1)}\n`,
    'utf8',
  )
}

/** 折行的判据要**接起来读**（窄窗上长句会被劈成两截）。 */
const flat = (lines: readonly string[]): string => lines.map((line) => line.trim()).join('')

/** 等一屏满足条件（默认 25 秒）——轮询是这一层的事，产品那几跳都是事件驱动的。 */
async function waitUntil(
  session: UiSession,
  what: string,
  ok: (lines: readonly string[]) => boolean,
  timeoutMs = 25_000,
): Promise<readonly string[]> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6
  for (;;) {
    const lines = (await session.screen()).lines.map((line) => line.text)
    if (ok(lines)) return lines
    if (Bun.nanoseconds() > until) {
      throw new Error(`等「${what}」超时（${timeoutMs}ms）。屏：\n${lines.join('\n')}`)
    }
    await Bun.sleep(40)
  }
}

/**
 * 等这一轮**收束**——判据与收摊都等它。
 *
 * 由头（U33 踩过）：忙的时候 `ctrl+c` 是**中断**不是退出，那时收摊，助手那条**落不了账**；
 * 而「回复上屏」与「这一轮收束」也不是同一刻（未完成的流式正文是**还没落账**的）。
 *
 * ⚠️ 判据不是「状态那一格是 `○ 空闲`」——**收束有两种**：好好收的（`○ 空闲`）与
 * **报着错收的**（`▲ 出错`）。要求「必须空闲」会把「这一轮出错了」变成**等超时**，
 * 于是真正该开口的那条判据（这一轮成没成）反倒没人说。
 * 故这里只要求**不在跑**（状态那一格不是 `●` 那几个），成没成由调用方的判据去说。
 */
const waitSettled = (session: UiSession, marker: string): Promise<readonly string[]> =>
  waitUntil(session, `「${marker}」上屏且这一轮收束`, (lines) => {
    const body = flat(lines)
    return body.includes(marker) && !statusLineOf(lines).includes('●')
  })

/** 敲一行字（先等它落到输入行上）。 */
async function say(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 库里那些条目——**直读**（不经 API 回读闭环）。 */
function entriesOf(sandbox: Sandbox): readonly {
  readonly kind: string
  readonly content_kind: string
  readonly content_text: string | null
  readonly payload: string | null
}[] {
  const db = readDatabase(join(sandbox.dataDir, 'records.db'))
  try {
    return db.entries
  } finally {
    db.close()
  }
}

/** 第 n 条助手条目的正文与载荷里的思考——`undefined` ＝ 压根没那条。 */
function assistantOf(
  sandbox: Sandbox,
  index = 0,
): { readonly text: string; readonly thinking: string | undefined } | undefined {
  const entry = entriesOf(sandbox).filter((one) => one.kind === 'assistant')[index]
  if (entry === undefined) return undefined

  const payload = entry.payload === null ? undefined : (JSON.parse(entry.payload) as { reasoning?: string })

  return { text: entry.content_text ?? '', thinking: payload?.reasoning }
}

/** 起一趟——夹具、沙地、会话三件一起（外借给会话，故归本函数管）。 */
async function boot(input: {
  readonly label: string
  readonly columns: number
  readonly rows: number
  readonly model: string
  readonly turns: readonly FixtureTurn[]
  /**
   * 那条连接上**另写**的键（如覆盖位 `modelOverrides`）。
   *
   * `baseURL` / `apiKey` / `model` 三件由本函数填——**端点得指着这一趟的夹具**，
   * 调用方在夹具起好之前写不出来（写了也只是抄一份死地址）。
   */
  readonly connection?: Record<string, unknown>
}): Promise<{ readonly fixture: Fixture; readonly sandbox: Sandbox; readonly session: UiSession }> {
  const fixture = startFixture({ turns: input.turns, model: input.model })
  const sandbox = createSandbox({
    baseURL: fixture.baseURL,
    model: input.model,
    ...(input.connection === undefined
      ? {}
      : {
          config: {
            providers: {
              local: {
                baseURL: fixture.baseURL,
                apiKey: FAKE_API_KEY,
                model: input.model,
                ...input.connection,
              },
            },
          },
        }),
  })

  const session = await createUiSession({
    label: input.label,
    artifacts: join(out, 'runs'),
    sandbox,
    fixture,
    columns: input.columns,
    rows: input.rows,
  })
  await session.wait({ text: '空闲' }, { timeoutMs: 25_000 })

  return { fixture, sandbox, session }
}

/**
 * 收摊——**先等它闲下来**，再走「按两次 ctrl+c」那条路（让它自己走，`by` 才是「app」）。
 *
 * ⚠️ **这一层不抛**（与 U33 那一支的收摊不同）：本套量的是**内容**（屏 · 出站请求 · 落库），
 * 收摊那几步是**为了拿到那三样**才做的。收不干净时如实记一行、照样去读库——
 * 让判据自己开口说哪一条没过，比把整趟断在收尾那一下强。
 */
async function settle(input: {
  readonly session: UiSession
  readonly fixture: { stop(): Promise<void> }
  readonly sandbox: Sandbox
}): Promise<void> {
  await input.session.wait({ text: '○ 空闲' }, { timeoutMs: 10_000 }).catch(() => undefined)
  await input.session
    .quit()
    .catch((error: unknown) => console.log(`  · 收摊：它没按「按两次」那条路走（${String(error)}）`))
  await input.session.close({ graceMs: 5_000 }).catch(() => undefined)
  await input.fixture.stop()
  input.sandbox.dispose()
}

// ═══════════════════════════════════════════════════════════════════════
// ① ② · 家族：用户真机那个名字，与同线的另一档
// ═══════════════════════════════════════════════════════════════════════

/**
 * 内嵌思考那一形——**逐字照真机取证的那个形状**（`<think>` 之后的思考自带换行，
 * 合标签之后空一行再是正文）：
 *
 * ```
 * 条目·assistant  <think>⏎用户在问我能帮他做什么。…⏎</think>⏎⏎我可以帮你完成软件开发相关…
 * ```
 */
const INLINE_REPLY = '<think>\n用户在问我能帮他做什么。\n</think>\n\n我可以帮你完成软件开发相关的事。'
const INLINE_THINKING = '\n用户在问我能帮他做什么。\n'
const INLINE_BODY = '\n\n我可以帮你完成软件开发相关的事。'

async function family(mark: string, model: string, columns: number, rows: number): Promise<void> {
  const asked = '能帮我做什么'
  const { fixture, sandbox, session } = await boot({
    label: `u65-家族-${mark}`,
    columns,
    rows,
    model,
    turns: [{ kind: 'text', text: INLINE_REPLY, chunks: 4 }],
  })

  try {
    await say(session, asked)
    await session.key('enter', { until: { text: '我可以帮你完成软件开发相关的事。' }, timeoutMs: 25_000 })
    await waitSettled(session, '我可以帮你完成软件开发相关的事。')

    const shot = await session.capture({ label: `${mark}-01-带思考的一轮` })
    keep(shot)
    const screen = flat(shot.lines)

    // —— 屏（给人看的那一帧）——
    // ⚠️ **先量「这一轮成没成」**：真机取证那一轮是 settled、不是报错，而「思考被拆出来」
    //    这件事一旦落地，就会去走**落账那一步**——那一步上有另一个病（U64）。
    //    这一条先把那件事挡在门口说清楚，免得它冒充成「拆没拆开」的失败
    check(
      !screen.includes('▲ 出错') && !screen.includes('内核异常'),
      `【${mark}】这一轮**收束**了（不是报错）`,
      screen.slice(0, 300),
    )
    check(screen.includes('（思考）'), `【${mark}】屏上带着「（思考）」标识`, screen.slice(0, 200))
    check(
      screen.includes('用户在问我能帮他做什么。'),
      `【${mark}】思考那半上了屏`,
      screen.slice(0, 200),
    )
    check(
      screen.includes('我可以帮你完成软件开发相关的事。'),
      `【${mark}】正文那半上了屏`,
      screen.slice(0, 200),
    )
    check(
      !screen.includes('<think>'),
      `【${mark}】屏上**没有裸标签**（接起来读过）`,
      screen.slice(0, 300),
    )

    // —— 物证①：出站请求 ——
    const sent = session.requests()
    check(sent.length === 1, `【${mark}】这一趟真发了一次对话请求`, `${sent.length} 次`)
    check(
      sent[0]?.model === model,
      `【${mark}】发出去的模型名**逐字**是它`,
      String(sent[0]?.model),
    )
    check(
      sent[0]?.lastUser === asked,
      `【${mark}】用户那句话原样进了请求`,
      String(sent[0]?.lastUser),
    )

    // —— 物证②：落库条目（**逐字**）——
    const kept = entriesOf(sandbox)
    check(
      kept.filter((one) => one.kind === 'assistant').length === 1,
      `【${mark}】落了一条助手条目`,
      `${kept.length} 条`,
    )
    const assistant = assistantOf(sandbox)
    check(assistant?.text === INLINE_BODY, `【${mark}】落库的正文**逐字**（没有裸标签）`, JSON.stringify(assistant?.text))
    check(
      assistant?.thinking === INLINE_THINKING,
      `【${mark}】落库的思考**逐字**（进了载荷那一格）`,
      JSON.stringify(assistant?.thinking),
    )
  } finally {
    await settle({ session, fixture, sandbox })
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ③ · 反面：行为正常的模型 ＋ 用户贴的标签
// ═══════════════════════════════════════════════════════════════════════

/**
 * 两件一起量（同一条会话，两回事）：
 *
 * ① **不许过度**——思考走独立字段的模型，正文里**恰好有** `<think>` 字样 ⇒ 一个字都不切；
 * ② **不许误伤输入**——用户**贴**一段带 `<think>` 的文字 ⇒ **原样进请求**，不得被当思考切掉。
 *
 * （输入侧那条本来就成立——贴的东西走**输入**、不进模型这条流；这里把它**验出来**，
 * 免得日后有人把探针挪到装配上下文那一侧。）
 */
async function normalModel(): Promise<void> {
  const pasted = '照它说的做：<think>这是我自己贴的</think>'
  const reply = '照它说的：<think>这是你贴的</think>——就这个意思。'
  const model = 'gpt-4o'

  const { fixture, sandbox, session } = await boot({
    label: 'u65-正常模型',
    columns: 100,
    rows: 30,
    model,
    turns: [{ kind: 'text', reasoning: '先想一下这个交代。', text: reply, chunks: 3 }],
  })

  try {
    await say(session, pasted)
    await session.key('enter', { until: { text: '就这个意思。' }, timeoutMs: 25_000 })
    await waitSettled(session, '就这个意思。')

    const shot = await session.capture({ label: '宽-02-正常模型与用户贴的标签' })
    keep(shot)
    const screen = flat(shot.lines)

    check(!screen.includes('▲ 出错'), '【反面】这一轮**收束**了（不是报错）', screen.slice(0, 300))

    // —— 反面：正文一个字都不切 ——
    check(
      screen.includes('照它说的：<think>这是你贴的</think>——就这个意思。'),
      '【反面】正常模型的正文**原样**（标签在中间，一个字都没切）',
      screen.slice(0, 300),
    )
    check(
      screen.includes('（思考）先想一下这个交代。'),
      '【反面】它的思考走**独立字段**（带上「（思考）」标识）',
      screen.slice(0, 300),
    )

    // —— 物证①：出站请求（用户贴的那段逐字进没进请求）——
    const sent = session.requests()
    check(sent.length === 1, '【输入】这一趟真发了一次对话请求', `${sent.length} 次`)
    check(
      sent[0]?.lastUser === pasted,
      '【输入】用户贴的那段**逐字**进了请求（连标签一起）',
      String(sent[0]?.lastUser),
    )

    // —— 物证②：落库条目 ——
    const kept = entriesOf(sandbox)
    const user = kept.find((one) => one.kind === 'user')
    check(user?.content_text === pasted, '【输入】用户那条**原样落库**', JSON.stringify(user?.content_text))

    const assistant = assistantOf(sandbox)
    check(
      assistant?.text === reply,
      '【反面】助手那条的正文**逐字**（标签原样留在正文里）',
      JSON.stringify(assistant?.text),
    )
    check(
      assistant?.thinking === '先想一下这个交代。',
      '【反面】思考归思考（载荷那一格）',
      JSON.stringify(assistant?.thinking),
    )
  } finally {
    await settle({ session, fixture, sandbox })
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ④ · 表外的模型名：第一次认出，第二次直接按它办
// ═══════════════════════════════════════════════════════════════════════

/**
 * 表外的模型名——内置表按家族也认不到它（`MiniMax-M*` 之外的名字）。
 *
 * 两轮的回复形状是**故意不一样**的：
 * - 第一轮**以标签开头**（探针接得住的那一形）⇒ 认出、并**记下**；
 * - 第二轮标签**在正文中间**——**探针接不住**（判据取严：不以它开头就不认），
 *   只有「这个模型名上一次认下了」解释得通它为什么被切开了。
 */
async function learned(): Promise<void> {
  const model = 'acme-reasoner-v9'
  const first = '第一答'
  // ⚠️ 第二轮的**正文里没有「答」字**（切完是「前言」＋「后语」两截）——等的是正文那半
  const second = '后语'
  const midBody = `前言 <think>第二遍想</think> 后语`

  const { fixture, sandbox, session } = await boot({
    label: 'u65-认下的',
    columns: 100,
    rows: 30,
    model,
    turns: [
      { kind: 'text', text: `<think>第一遍想</think>\n\n${first}`, chunks: 3 },
      { kind: 'text', text: midBody, chunks: 3 },
    ],
  })

  try {
    // —— 第一轮：探针认出 ——
    await say(session, '第一件')
    await session.key('enter', { until: { text: first }, timeoutMs: 25_000 })
    await waitSettled(session, first)

    const firstShot = await session.capture({ label: '宽-03-表外模型第一轮' })
    keep(firstShot)
    const firstScreen = flat(firstShot.lines)
    check(firstScreen.includes('（思考）第一遍想'), '【第一次】屏上认出并拆开（带着「（思考）」）', firstScreen.slice(0, 200))
    check(!firstScreen.includes('<think>'), '【第一次】屏上没有裸标签', firstScreen.slice(0, 200))

    const one = assistantOf(sandbox, 0)
    check(one?.text === `\n\n${first}`, '【第一次】落库正文逐字', JSON.stringify(one?.text))
    check(one?.thinking === '第一遍想', '【第一次】落库思考逐字', JSON.stringify(one?.thinking))

    // —— 第二轮：标签**不在开头**，只有「认下了」才切得开 ——
    await say(session, '第二件')
    await session.key('enter', { until: { text: second }, timeoutMs: 25_000 })
    await waitSettled(session, second)

    const secondShot = await session.capture({ label: '宽-04-表外模型第二轮' })
    keep(secondShot)
    const secondScreen = flat(secondShot.lines)
    check(
      !secondScreen.includes('<think>'),
      '【第二次】屏上**没有裸标签**（标签不在开头，探针接不住——只有认下的那份解释得通）',
      secondScreen.slice(0, 300),
    )
    check(secondScreen.includes('（思考）第二遍想'), '【第二次】思考那半上了屏', secondScreen.slice(0, 300))

    const two = assistantOf(sandbox, 1)
    check(two?.text === '前言  后语', '【第二次】落库正文逐字（标签被切走了）', JSON.stringify(two?.text))
    check(two?.thinking === '第二遍想', '【第二次】落库思考逐字', JSON.stringify(two?.thinking))

    // —— 物证①：两轮各发了一次，模型名逐字 ——
    const sent = session.requests()
    check(sent.length === 2, '【认下的】两轮各发了一次请求', `${sent.length} 次`)
    check(
      sent.every((one) => one.model === model),
      '【认下的】两次发出去的都是同一个模型名（逐字）',
      sent.map((one) => one.model).join(' / '),
    )
  } finally {
    await settle({ session, fixture, sandbox })
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ⑤ · 认错了关得掉：覆盖位是出口
// ═══════════════════════════════════════════════════════════════════════

/**
 * 同一个表外模型名，配置里**明说无特征**（`modelOverrides[<精确 id>].traits = {}`）。
 *
 * 那一份是**整组接管**（判据「键在即接管」）——`{}` 压得住内置表，也压得住认下的那些，
 * 且**连探针都不装**（不然「关掉了」只是关掉了一半：屏上照样会被认走）。
 *
 * 回复**故意以标签开头**——那正是探针最想认的那一形，而它必须**一个字都不切**。
 */
async function disabled(): Promise<void> {
  const model = 'acme-reasoner-v9'
  const raw = '<think>不切</think>正文'

  const { fixture, sandbox, session } = await boot({
    label: 'u65-关得掉',
    columns: 100,
    rows: 30,
    model,
    turns: [{ kind: 'text', text: raw, chunks: 2 }],
    connection: { modelOverrides: { [model]: { traits: {} } } },
  })

  try {
    await say(session, '发一句')
    await session.key('enter', { until: { text: '正文' }, timeoutMs: 25_000 })
    await waitSettled(session, '正文')

    const shot = await session.capture({ label: '宽-05-覆盖位关掉' })
    keep(shot)
    check(
      flat(shot.lines).includes('<think>不切</think>正文'),
      '【关得掉】屏上**一个标签都没动**（原样）',
      flat(shot.lines).slice(0, 300),
    )

    const assistant = assistantOf(sandbox)
    check(
      assistant?.text === raw,
      '【关得掉】落库正文**逐字**就是那一段',
      JSON.stringify(assistant?.text),
    )
    check(assistant?.thinking === undefined, '【关得掉】载荷里没有思考那一格', String(assistant?.thinking))
  } finally {
    await settle({ session, fixture, sandbox })
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const at = Bun.argv.indexOf('--out')
  const dir = at === -1 ? undefined : Bun.argv[at + 1]
  if (dir === undefined) throw new Error('要一个 --out <目录>（帧与现场落在那里）')

  out = dir
  mkdirSync(join(out, 'runs'), { recursive: true })

  console.log('· ① 用户真机那个名字 · MiniMax-M2.7-highspeed · 宽 100×30')
  await family('宽-M2.7', 'MiniMax-M2.7-highspeed', 100, 30)

  console.log('· ② 同一家族的另一档 · MiniMax-M2.5-highspeed · 窄 46×30')
  await family('窄-M2.5', 'MiniMax-M2.5-highspeed', 46, 30)

  console.log('· ③ 反面：行为正常的模型 ＋ 用户贴的标签')
  await normalModel()

  console.log('· ④ 表外的模型名：第一次认出 · 第二次直接按它办')
  await learned()

  console.log('· ⑤ 认错了关得掉：覆盖位是出口')
  await disabled()

  console.log(`\n全部判据通过。帧落在 ${out}`)
}

await main()
