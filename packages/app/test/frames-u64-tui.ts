#!/usr/bin/env bun
/**
 * U64 · **assistant 条目的思考载荷**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真终端 ＋ 真端点才说得清
 * 的那一件**：真机上第一次接真实供应商、模型**回了思考**的那一轮，**到底跑不跑得通**。
 *
 * ## 为什么原先没人发现
 *
 * 夹具历来**不给思考**（`FixtureTurn.text` 原先没有那一格）⇒ 「回复里带 reasoning」这一形
 * **装置根本造不出来**，于是它一路没被验过——直到有人在真机上接了真供应商。
 * 故本套第一件事就是**把那一形造出来**（夹具加了 `reasoning`，见 `ui/fixture.ts`）。
 *
 * ## 三趟
 *
 * | 趟 | 起手 | 要看见什么 |
 * | --- | --- | --- |
 * | ① 带思考的一轮（宽 100×30） | 受控端点回的**思考 ＋ 正文** | 那一轮**跑通**（正文字在屏上 · 状态空着）· 屏上**没有**出错 · 下一轮请求里那份思考**回传了** |
 * | ② 带思考的一轮（窄 46×30） | 同上 | 判据一字不改（折行照读） |
 * | ③ 反面 · **不带思考**的一轮 | 受控端点只回正文 | 照旧跑通（本单没弄坏那条老路——它正是「一直没被发现」的那条） |
 *
 * ## 判据怎么咬
 *
 * ① 的「跑通了」看**两处**：屏上有那句正文（模型的话真落了地）＋ 状态行是 `○ 空闲`
 * （收束，不是 `▲ 出错`）；「回传了」**只认读数**——`FixtureRequest.assistantReasoning`
 * 取自**真发出去的那个请求体**（不是「我们记得住」）。两条缺一不可：只判前者的话，
 * 思考丢在取件层也照样绿——而那正是 U41 存在的理由（不回传则 400）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u64-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { statusLineOf } from './ui/index.ts'
import { createSandbox, createUiSession, startFixture } from './ui/index.ts'
import type { Capture, Fixture, FixtureRequest, FixtureTurn, Sandbox, UiSession } from './ui/index.ts'
import { FAKE_API_KEY } from './ui/sandbox.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 这一趟的产物根——入口解析 `--out` 之后填。 */
let out = ''

/** 那一轮的思考（**不进屏**那一份）——回传与否逐字对它。 */
const REASONING = '先看清路径再动手：这一份不进屏，但要进下一次请求'

/** 那一轮的正文（**进屏**那一份）。 */
const REPLY = '看完了，没动它。'

/** 第二轮的回话——「上一轮那份思考回传了没有」要在这一跳上看得出来。 */
const SECOND = '好，接着来。'

/** 受控端点回的那几轮（**只有对话跳吃剧本**——见 `ui/fixture.ts` 那条注）。 */
const TURNS = [
  { kind: 'text' as const, text: REPLY, reasoning: REASONING, chunkDelayMs: 0 },
  { kind: 'text' as const, text: SECOND, chunkDelayMs: 0 },
]

/** 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/** 留一屏——文本写进 `<out>/<序号-名字>.txt`，字格写进同名 `.json`。 */
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

/** 等一个条件在**可见屏**上成立（默认 20 秒）。 */
async function waitUntil(
  session: UiSession,
  what: string,
  ok: (lines: readonly string[]) => boolean,
  timeoutMs = 20_000,
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
 * 借来的受控端点 ＋ 一块接在它上面的沙地——**连接走 `deepseek` 官方适配**。
 *
 * ⚠️ `vendor` 是这一趟成立的**前提**：思考回传与否由适配的 `echoesReasoning` 定
 * （U41：DeepSeek 带 tools 时要求历史轮的 `reasoning_content` 原样回传）。
 * 缺了它走的是兼容接入那条路——**同一个思考一个字都不会回传**（那条口径本单没动，
 * 由 `bun test` 里的反面用例钉着）。
 */
function land(turns: readonly FixtureTurn[]): { readonly fixture: Fixture; readonly sandbox: Sandbox } {
  const fixture = startFixture({ model: 'deepseek-flash', turns })

  const sandbox = createSandbox({
    baseURL: fixture.baseURL,
    model: 'deepseek-flash',
    config: {
      defaultProvider: 'local',
      providers: {
        local: {
          vendor: 'deepseek',
          baseURL: fixture.baseURL,
          apiKey: FAKE_API_KEY,
          model: 'deepseek-flash',
        },
      },
    },
  })

  return { fixture, sandbox }
}

/** 夹具收到的**对话**那几跳（`GET /models` 那一发不算——它不吃剧本、也不是一轮对话）。 */
function chatsOf(fixture: Fixture): readonly FixtureRequest[] {
  return fixture.requests().filter((request) => request.path.endsWith('/chat/completions'))
}

/**
 * **① ／ ② 带思考的一轮那一趟**——本单的要害。
 *
 * 走两步：第一轮（端点回了思考）跑通 ＋ 第二轮，然后在**第二跳的请求体**里确认
 * 上一轮那份思考真回传了。
 */
async function askingTurn(mark: string, columns: number, rows: number): Promise<void> {
  const { fixture, sandbox } = land(TURNS)
  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: `u64-思考那一轮-${mark}`,
      sandbox,
      fixture,
      columns,
      rows,
      artifacts: join(out, 'runs'),
    })
    await session.wait({ text: '空闲' }, { timeoutMs: 25_000 })

    // —— 第一轮：回复里带思考 ——
    await typeLine(session, '看一下这个仓库')
    await session.key('enter')
    await waitUntil(session, '模型那句话上屏', (lines) => flat(lines).includes(REPLY), 30_000)
    await waitUntil(session, '回到空闲', (lines) => statusLineOf(lines).includes('○ 空闲'), 30_000)

    const shot = await session.capture({ label: `${mark}-01-带思考的一轮` })
    keep(shot)
    const screen = flat(shot.lines)

    // **那一轮跑通了**：模型的话真落了地
    check(screen.includes(REPLY), `【${mark}】带思考那一轮**跑通了**：模型的回话在屏上`, screen.slice(-400))
    // **不是出错的收尾**（修前这儿正是那条「对话域异常」）
    check(
      !screen.includes('对话域异常') && !screen.includes('▲ 出错'),
      `【${mark}】屏上**没有出错**（修前那一轮就是在这儿丢的）`,
      statusLineOf(shot.lines),
    )
    check(
      statusLineOf(shot.lines).includes('○ 空闲'),
      `【${mark}】状态行照旧（收束了，不是「工作中」也不是「出错」）`,
      statusLineOf(shot.lines),
    )

    // —— 第二轮：上一轮那份思考要随历史轮回传 ——
    await typeLine(session, '接着做')
    await session.key('enter')
    await waitUntil(session, '第二句上屏', (lines) => flat(lines).includes(SECOND), 30_000)
    await waitUntil(session, '再次回到空闲', (lines) => statusLineOf(lines).includes('○ 空闲'), 30_000)

    const later = await session.capture({ label: `${mark}-02-第二轮跑完` })
    keep(later)

    const chats = chatsOf(fixture)
    check(chats.length === 2, `【${mark}】这一趟真发了两次对话请求`, `${chats.length} 次`)
    // **要害**：第二跳的请求体里，上一条 assistant 消息带着那份思考（一字不差）
    check(
      chats[1]?.assistantReasoning === REASONING,
      `【${mark}】下一轮请求里那份思考**回传了**（reasoning_content 一字不差）`,
      `实际＝${JSON.stringify(chats[1]?.assistantReasoning)}`,
    )
    // 第一跳**不该**有它（那时还没有历史轮）——顺带钉住「不是无脑全带上」
    check(
      chats[0]?.assistantReasoning === undefined,
      `【${mark}】而第一跳没有它（那时还没有历史轮可回传）`,
      `实际＝${JSON.stringify(chats[0]?.assistantReasoning)}`,
    )
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
  }
}

/**
 * **③ 反面那一趟**——**不带思考**的一轮照旧。
 *
 * 这条老路正是「它一直没被发现」的原因（夹具历来只给正文），故本单改了夹具之后
 * **得回头确认它没被弄坏**：一个字的思考都不回时，条目照旧落、轮次照旧跑完。
 */
async function withoutThinking(mark: string): Promise<void> {
  // ⚠️ **只改剧本这一格**：把 `reasoning` 去掉——别的（连接 · 沙地 · 判据）一字不动
  const { fixture, sandbox } = land([{ kind: 'text', text: REPLY, chunkDelayMs: 0 }])
  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: `u64-不带思考-${mark}`,
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
      artifacts: join(out, 'runs'),
    })
    await session.wait({ text: '空闲' }, { timeoutMs: 25_000 })

    await typeLine(session, '看一下这个仓库')
    await session.key('enter')
    await waitUntil(session, '模型那句话上屏', (lines) => flat(lines).includes(REPLY), 30_000)
    await waitUntil(session, '回到空闲', (lines) => statusLineOf(lines).includes('○ 空闲'), 30_000)

    const shot = await session.capture({ label: `${mark}-03-不带思考的一轮` })
    keep(shot)

    check(
      flat(shot.lines).includes(REPLY),
      `【${mark}】不带思考那一轮照旧跑通（本单没弄坏它）`,
      flat(shot.lines).slice(-400),
    )
    check(
      !flat(shot.lines).includes('对话域异常'),
      `【${mark}】屏上没有出错`,
      statusLineOf(shot.lines),
    )
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u64-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    console.log('· ① 回复里带思考的一轮 · 宽 100×30')
    await askingTurn('宽', 100, 30)
    console.log('· ② 回复里带思考的一轮 · 窄 46×30')
    await askingTurn('窄', 46, 30)
    console.log('· ③ 反面：不带思考的一轮照旧')
    await withoutThinking('常数')

    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    if (at === -1) removeDir(root)
  }
}
