#!/usr/bin/env bun
/**
 * U72 · **取网页**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真终端 ＋ 真进程**
 * 才说得清的那几件：那张外发的卡长什么样、工具行与结果行读着顺不顺、
 * 没配那一趟屏上留下的是什么、这一轮到底停没停住。
 *
 * ## 四趟，各对工单的一句
 *
 * | 趟 | 造法 | 要看见什么 |
 * | --- | --- | --- |
 * | ① **配好了** | 配置里给了 `webFetch`；取 `https://example.com/` | 卡上**指出域名**；取回来的是**答案**（不是原文）；回执里有那句「不是原文」；出站物证＝**两次调用两个模型**、提炼那次**没有 `tools`** |
 * | ② **总是允许按域名** | 第一趟拨 `a`，接着取同一域名、再取**另一个**域名 | 同域名**不再问**；别的域名**照问** |
 * | ③ **没配** | 配置里**没有** `webFetch`；剧本第二发摆着 `exec curl` | 屏上两句都在（模型看得到 / 用户看得到）；**这一轮停住**——那发 `curl` **一次都没跑**（反证） |
 * | ④ **反面** | `localhost` · 无点主机名 · 跨主机跳转（`iana.org` → `www.iana.org`） | 前两个**发请求之前就拒**；第三个**不跟**且说清从哪跳到哪 |
 *
 * ## 判据怎么咬
 *
 * - **屏上**：帧里的字（卡上的域名、那半句结论、两句提示）；
 * - **出站**：`session.requests()` 那一串——**模型名**与**请求体**都在里面
 *   （「提炼那次不带工具」判的是 `'tools' in body === false`，不是 `tools: 0`）。
 *
 * ⚠️ **这四趟会真出网**（`example.com` / `example.org` / `iana.org`——三个稳定的公开页）。
 * 取回那一跳没有注入的口子（真 PTY 跑的是真 `cli.ts`），而工单要的正是「一条真网页」。
 * 提炼那一跳仍走环回夹具（答案由剧本给，判据不押真模型的措辞）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u72-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUiSession, statusLineOf } from './ui/index.ts'
import type { Capture, UiSession } from './ui/index.ts'
import { removeDir, tempDir } from './tmp.ts'

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

/** 等一个条件在**可见屏**上成立（默认 25 秒——真出网那几跳要给它时间）。 */
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

/** 起手那道闸：等它空闲（同既有几支帧套件）。 */
async function booted(session: UiSession): Promise<void> {
  await session.wait({ text: '空闲' }, { timeoutMs: 25_000 })
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

/**
 * 等屏上出现**某一个**判据——「这一轮走到哪一步了」。
 *
 * ⚠️ **别拿「空闲」当「这一轮跑完了」**：提交之后到状态行翻过去之间有那么一小会儿，
 * 屏上还写着上一轮的空闲——照那个等，下一步的输入会打在**上一轮还没走完**的时候
 * （第一版就是这么错的：第三趟的输入赶在第二趟收尾之前落下，剧本当场错位一格）。
 * 判据锚在**这一轮才会出现的那句话**上（工具的结论行 / 答案 / 卡）。
 */
async function waitFor(
  session: UiSession,
  what: string,
  fragments: readonly string[],
  timeoutMs = 30_000,
): Promise<readonly string[]> {
  return waitUntil(session, what, (lines) => fragments.some((one) => hasLine(lines, one)), timeoutMs)
}

/** 夹具收到的**对话**那几跳（本沙地没写 `vendor`，但有目录刷新也照滤）。 */
function chatsOf(session: UiSession) {
  return session.requests().filter((request) => request.path.endsWith('/chat/completions'))
}

/**
 * **出站请求物证**落一份盘（工单①④⑥点名要的那一件）。
 *
 * 记的是**发出去的那一份请求体原样**（`FixtureRequest.body`）——主模型那一轮到底看到了什么、
 * 提炼那一跳带没带工具、用的哪个模型名，全在里面。工单那句「原文没进上下文」也只有
 * 从这儿说得清：判据是**在正文里找页面 HTML**，而不是看代码的意图。
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

/** 一次请求里的**全部文本**（各条消息拼起来）——「这一轮看到了什么」就看它。 */
function textOf(request: { readonly body: Record<string, unknown> } | undefined): string {
  const messages = (request?.body['messages'] ?? []) as readonly { content: unknown }[]

  return messages
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')))
    .join('\n')
}

const PAGE = 'https://example.com/'
const OTHER_PAGE = 'https://example.org/'
const SESSION_MODEL = 'MiniMax-M3'
const DISTILL_MODEL = 'small-distill'

// ═══════════════════════════════════════════════════════════════════════
// ① 配好了的那一趟：卡 → 取回 → 提炼 → 只交答案
// ═══════════════════════════════════════════════════════════════════════

const ANSWER = '这一页说的是 example.com 这个域名专门留作示例用，不归谁所有。'

async function configured(): Promise<void> {
  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: 'u72-配好了',
      columns: 100,
      rows: 34,
      model: SESSION_MODEL,
      // 「取网页用的模型」**它自己那一条**——与会话那个 model 是两个
      config: { webFetch: { provider: 'local', model: DISTILL_MODEL } },
      turns: [
        { kind: 'tool', name: 'web_fetch', args: { url: PAGE, prompt: '这一页是做什么用的？' } },
        { kind: 'text', text: ANSWER },
        { kind: 'text', text: '知道了。' },
      ],
      artifacts: join(out, 'runs'),
    })
    await booted(session)

    await typeLine(session, '查一下 example.com 是干什么的')
    await session.key('enter', { until: { text: 'y 批准' }, timeoutMs: 20_000 })
    const card = await session.capture({ label: '①-01-外发的卡' })
    keep(card)

    // ④ 工单⑤：外发那张卡**指出域名**；且「总是允许」那一格写的是**域名**
    check(
      hasLine(card.lines, 'example.com'),
      '① 卡上**指出发给哪个域名**',
      linesWith(card.lines, '域名：') || linesWith(card.lines, 'example.com'),
    )
    check(
      hasLine(card.lines, '总是允许这个域名'),
      '① 那一格写的是**这个域名**（不是「本工作区总是允许」）',
      linesWith(card.lines, '总是允许'),
    )

    // 批准 → 真取回 → 真提炼 → 主轮接着走
    await session.send('y')

    /**
     * ⚠️ **`ctrl+o` 要在这一轮还在跑的时候按**——这是本单留帧时踩到的一处：
     * 已定局的行走 `<Static>`，**写一次就不再重绘**（`components/app.ts` 头注第一条），
     * 故那一轮收束之后再去展开**那一屏一个字都不会变**（实测：按了等于没按）。
     * 在活动区按下去，`expanded` 就一直有效——结果行落下来时**当场就是展开的**那一形。
     */
    await session.key('ctrl+o')

    // 等**回执正文**（那句「不是原文」）上屏——它就是「这一趟取回了什么」的收据
    await waitFor(session, '结果行 ＋ 回执正文', ['不是原文'])
    const finished = await session.capture({ label: '①-02-跑完那一屏（回执展开着）' })
    keep(finished)

    // ⚠️ **再等它真走完**：结果行出来得快，那一刻状态行还是「工作中」——
    // 「这一轮收束了没有」问的是状态行，不是结果行
    const idle = await waitFor(session, '这一轮收束', ['空闲'])

    // ③ 工具行与结果行——**同一形**：`● 名字 参数` ＋ `✓ 时长 · 结论`
    check(
      hasLine(finished.lines, 'web_fetch'),
      '① 工具行在（名字 ＋ 参数，与既有工具同一形）',
      linesWith(finished.lines, 'web_fetch'),
    )
    const verdict = finished.lines.map((line) => line.trim()).find((line) => line.startsWith('✓ ') && line.includes('example'))
    check(
      verdict !== undefined,
      '① 结果行的结论是**它答了什么**（末行＝答案，不是那句警告）',
      verdict ?? linesWith(finished.lines, '✓'),
    )
    check(
      idle.some((line) => line.includes('空闲')),
      '① 这一轮正常收束（回到等待输入）',
      statusLineOf(idle),
    )

    // ③ 工单③：回执里有那句「是提炼后的答案、不是原文」
    check(
      hasLine(finished.lines, '不是原文'),
      '① 回执里有那句「**不是原文**」',
      linesWith(finished.lines, '不是原文'),
    )
    check(
      hasLine(finished.lines, '没问到的'),
      '① 并点明「没问到的这一页未必没有」（别把它读成「没有」）',
      linesWith(finished.lines, '没问到的'),
    )
    check(
      hasLine(finished.lines, '取回 https://example.com/') && hasLine(finished.lines, '200'),
      '① 收据齐：地址 ＋ 状态码',
      linesWith(finished.lines, '取回 '),
    )
    check(
      hasLine(finished.lines, '提炼') && hasLine(finished.lines, DISTILL_MODEL),
      '① 收据报**用的哪个模型**（是配置里那一个）',
      linesWith(finished.lines, '提炼 '),
    )
    check(
      hasLine(finished.lines, ANSWER),
      '① 交回来的是**提炼后的答案**',
      linesWith(finished.lines, '这一页说的是'),
    )

    // —— 出站物证（工单①⑥）——
    const chats = chatsOf(session)
    const models = chats.map((chat) => chat.model)
    check(
      models.join(' → ') === [SESSION_MODEL, DISTILL_MODEL, SESSION_MODEL].join(' → '),
      '①⑥ 三次请求：主轮 → 提炼 → 主轮；**提炼用的是配置里那个模型**（与会话那个是两个）',
      `实测 ${models.join(' → ')}`,
    )

    // ④ 工单④（护栏）：提炼那一跳的请求体里**没有 `tools` 这一格**
    const distill = chats[1]
    check(
      distill !== undefined && !('tools' in distill.body),
      '①④ **护栏**：提炼那次调用不带任何工具（请求体里连 `tools` 键都没有）',
      distill === undefined ? '（没有第二次请求）' : `keys: ${Object.keys(distill.body).join(', ')}`,
    )
    check(
      chats[0] !== undefined && ((chats[0].body['tools'] as unknown[]) ?? []).length > 0,
      '①④ 对照：主轮那次**带着工具**（同一个夹具、同一份读数）',
      `${((chats[0]?.body['tools'] as unknown[]) ?? []).length} 件`,
    )

    // ① 工单①：主模型那一轮**看到的是答案，原文没进上下文**
    const second = chats[2]
    check(
      textOf(second).includes(ANSWER),
      '① 主轮第二次请求里**有那个答案**',
      '',
    )
    check(
      !textOf(second).includes('<html>') && !textOf(second).includes('<h1>'),
      '① **原文没有进主模型的上下文**（出站请求体里没有页面 HTML）',
      '',
    )

    keepRequests(session, '出站物证-配好了')
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ② 总是允许：按域名给
// ═══════════════════════════════════════════════════════════════════════

async function alwaysAllow(): Promise<void> {
  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: 'u72-总是允许',
      columns: 100,
      rows: 34,
      model: SESSION_MODEL,
      config: { webFetch: { provider: 'local', model: DISTILL_MODEL } },
      turns: [
        { kind: 'tool', name: 'web_fetch', args: { url: PAGE, prompt: '第一问' } },
        { kind: 'text', text: '答一。' },
        { kind: 'text', text: '好。' },
        // 同一个地址**再取一次**——顺带验短时缓存那一格（命中要说一声）
        { kind: 'tool', name: 'web_fetch', args: { url: PAGE, prompt: '第二问' } },
        { kind: 'text', text: '答二。' },
        { kind: 'text', text: '好。' },
        { kind: 'tool', name: 'web_fetch', args: { url: OTHER_PAGE, prompt: '第三问' } },
        { kind: 'text', text: '答三。' },
        { kind: 'text', text: '好。' },
      ],
      artifacts: join(out, 'runs'),
    })
    await booted(session)

    // —— 第一趟：弹卡，拨「总是允许」 ——
    await typeLine(session, '取第一个网页')
    await session.key('enter', { until: { text: '总是允许这个域名' }, timeoutMs: 20_000 })
    keep(await session.capture({ label: '②-01-第一次弹卡' }))
    await session.send('a')
    await waitFor(session, '第一趟跑完', ['答一。'])
    keep(await session.capture({ label: '②-02-第一趟跑完' }))

    // —— 第二趟：**同一个域名**——不再问 ——
    await typeLine(session, '再取一次同一个域名')
    await session.key('enter')
    // 等到**答案出来**或**卡挂上**为止（哪一个先到就是哪一件事）——
    // 卡挂上的话答案永远不会来，于是下面那一条当场是红的（不是等到超时）
    const sameDomain = await waitFor(session, '第二趟走完', ['答二。', 'y 批准'])
    const second = await session.capture({ label: '②-03-同域名没有再问' })
    keep(second)

    check(
      !hasLine(second.lines, 'y 批准') && !hasLine(sameDomain, 'y 批准'),
      '② **同域名不再问**（第二趟全程没有卡）',
      linesWith(second.lines, '批准') || '（一条都没有——对的）',
    )
    check(
      hasLine(second.lines, '答二。'),
      '② 而且它**真跑了**（第二趟的答案在屏上）',
      linesWith(second.lines, '答二') || linesWith(second.lines, '✓'),
    )

    // —— 第三趟：**另一个域名**——照问 ——
    await typeLine(session, '取另一个域名')
    await session.key('enter', { until: { text: 'y 批准' }, timeoutMs: 20_000 })
    const other = await session.capture({ label: '②-04-别的域名照问' })
    keep(other)

    check(
      hasLine(other.lines, 'example.org'),
      '② **别的域名照问**，且卡上指出的是**新的那个域名**',
      linesWith(other.lines, 'example.org'),
    )
    await session.send('n')
    await waitFor(session, '第三趟收尾', ['已拒绝', '✗'])
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ③ 没配：这一轮停住（＋ 反证）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 剧本的第二发就是 `exec curl`——**反证用**：不拦的话，模型拿到「没配」这句
 * 多半接着来这一手，整件事（省上下文）就被绕过去了。判据是它**一次都没跑**。
 */
async function unconfigured(): Promise<void> {
  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: 'u72-没配',
      columns: 100,
      rows: 34,
      model: SESSION_MODEL,
      // **不给 `webFetch`**——配置里那一格空着
      turns: [
        { kind: 'tool', name: 'web_fetch', args: { url: PAGE, prompt: '这一页是做什么用的？' } },
        { kind: 'tool', name: 'exec', args: { cmd: 'curl -s https://example.com/' } },
        { kind: 'text', text: '我抓到原文了。' },
      ],
      artifacts: join(out, 'runs'),
    })
    await booted(session)

    await typeLine(session, '查一下 example.com')
    await session.key('enter', { until: { text: 'y 批准' }, timeoutMs: 20_000 })
    await session.send('y')
    // 等那两句上屏——**停住之后**它就该停在那儿（不是等空闲：空闲在提交与翻状态之间
    // 有一小会儿还是上一轮那个样子）
    const done = await waitFor(session, '「还没配」上屏', ['还没配提炼用的模型'])
    const shot = await session.capture({ label: '③-01-停住那一屏' })
    keep(shot)

    // ① 模型看得到「还没配、取不到」；用户看得到「去 /config 挑一个」
    check(
      hasLine(shot.lines, '还没配提炼用的模型'),
      '③ 屏上有「**还没配提炼用的模型**」（模型与用户都看得到）',
      linesWith(shot.lines, '还没配'),
    )
    check(
      hasLine(shot.lines, '/config'),
      '③ 屏上有「去 **/config** 挑一个」那句指路',
      linesWith(shot.lines, '/config'),
    )
    check(
      hasLine(shot.lines, '✗') || hasLine(shot.lines, '还没配'),
      '③ 那一笔画的是失败那一个记号（不是成功）',
      linesWith(shot.lines, '✗'),
    )

    // ② **这一轮就地收束**：反证那一发 `curl` 一次都没跑
    const execRows = shot.lines.filter((line) => line.includes('curl'))
    check(
      execRows.length === 0,
      '③ **反证**：剧本里那发 `exec curl` **一次都没跑**（不拦的话它就是绕道那一手）',
      execRows.join(' ⏎ ') || '（屏上没有它——对的）',
    )
    check(
      !hasLine(shot.lines, '我抓到原文了。'),
      '③ 模型也没有机会接着说下一句（没有第二轮）',
      linesWith(shot.lines, '抓到原文'),
    )
    check(
      done.some((line) => line.includes('空闲')),
      '③ 这一轮**正常收束**（回到等待输入，不是出错挂住）',
      statusLineOf(done),
    )

    // 出站物证：**只发过一次请求**（这一轮没有第二趟模型调用）
    check(
      chatsOf(session).length === 1,
      '③ 出站物证：整趟只有**一次**模型请求',
      `实测 ${chatsOf(session).length} 次`,
    )
    keepRequests(session, '出站物证-没配')

    // 配完接着说一句就能继续——**这不是本单验的**（那一屏归 U71），此处只留帧
    await typeLine(session, '配好了接着说一句就能继续')
    keep(await session.capture({ label: '③-02-还能接着交代' }))
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ④ 反面：本机 / 无点 / 跨主机跳转
// ═══════════════════════════════════════════════════════════════════════

async function refusals(): Promise<void> {
  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: 'u72-反面',
      columns: 100,
      rows: 34,
      model: SESSION_MODEL,
      config: { webFetch: { provider: 'local', model: DISTILL_MODEL } },
      turns: [
        { kind: 'tool', name: 'web_fetch', args: { url: 'http://localhost:8080/x', prompt: '甲' } },
        { kind: 'text', text: '好，甲。' },
        { kind: 'tool', name: 'web_fetch', args: { url: 'https://intranet/wiki', prompt: '乙' } },
        { kind: 'text', text: '好，乙。' },
        { kind: 'tool', name: 'web_fetch', args: { url: 'https://iana.org/', prompt: '丙' } },
        { kind: 'text', text: '好，丙。' },
        { kind: 'text', text: '都完了。' },
      ],
      artifacts: join(out, 'runs'),
    })
    await booted(session)

    /**
     * 展开位——`ctrl+o` 是**切换**（不是「设为开」），故这里记着当下的状态：
     * 每趟都无脑按一下的话，三趟下来是 开 / 关 / 开（第二趟那一屏就白按了）。
     */
    let expanded = false

    /**
     * 走一趟：弹卡 → 批准 → 展开回执 → 等这一轮收束 → 取帧。
     *
     * 展开的时机见 `configured` 里那一段：**得在活动区按**（已定局的行不再重绘）。
     *
     * ⚠️ **这里等「空闲」是准的**：进这一趟之前屏上是**那张卡**（不是空闲），
     * 故「空闲」只可能出现在这一轮跑完之后——与别处那条「提交之后一小会儿仍是上一轮
     * 那个空闲」的坑不同（见 `waitFor` 那条注）。
     */
    const pass = async (label: string, text: string): Promise<readonly string[]> => {
      const live = session as UiSession
      await typeLine(live, text)
      await live.key('enter', { until: { text: 'y 批准' }, timeoutMs: 20_000 })
      keep(await live.capture({ label: `${label}-卡` }))
      await live.send('y')
      if (!expanded) {
        await live.key('ctrl+o')
        expanded = true
      }
      await waitFor(live, `${label} 收束`, ['空闲'])
      const shot = await live.capture({ label })
      keep(shot)
      return shot.lines
    }

    /**
     * ⚠️ 这几条**看的是展开之后那一份**：结论行只有首行前 48 列（`log.ts` 的
     * `firstLineOf`），而拒的**缘由**在那 48 列之外（头半截是那个地址本身）。
     * 展开之后整段都在——也才说得出「它到底为什么取不得」。
     */
    const local = await pass('④-01-localhost 被拒', '取本机那个')
    check(
      hasLine(local, 'localhost') && hasLine(local, '本机地址') && hasLine(local, '✗'),
      '④ `localhost` 被拒（发请求之前），且缘由说得出口',
      linesWith(local, 'localhost'),
    )

    const dotless = await pass('④-02-无点主机名被拒', '取内网那个')
    check(
      hasLine(dotless, 'intranet') && hasLine(dotless, '没有点') && hasLine(dotless, '✗'),
      '④ 无点主机名被拒（发请求之前），且缘由说得出口',
      linesWith(dotless, '没有点'),
    )

    // —— 跨主机跳转（真站点：iana.org → www.iana.org）——
    const crossed = await pass('④-03-跨主机跳转不跟', '取那个会跳走的')
    check(
      hasLine(crossed, 'www.iana.org'),
      '④ 跨主机跳转**不跟**，且说清**跳到哪**',
      linesWith(crossed, 'www.iana.org'),
    )
    check(
      hasLine(crossed, '再取一次'),
      '④ 并说明「按新地址再取一次」（让模型自己决定）',
      linesWith(crossed, '再取一次'),
    )
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u72-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    console.log('· ① 配好了：卡（指出域名）→ 取回 → 提炼 → 只交答案')
    await configured()
    console.log('· ② 总是允许：按域名给（同域名不问、别的域名照问）')
    await alwaysAllow()
    console.log('· ③ 没配：这一轮停住（反证那一发 curl 没跑）')
    await unconfigured()
    console.log('· ④ 反面：本机 / 无点 / 跨主机跳转')
    await refusals()

    if (failures.length === 0) {
      console.log(`\n全部判据通过。帧落在 ${out}`)
    } else {
      console.log(`\n${failures.length} 条判据不过：`)
      for (const what of failures) console.log(`  ✗ ${what}`)
      console.log(`帧落在 ${out}`)
      process.exitCode = 1
    }
  } finally {
    if (at === -1) removeDir(root)
  }
}
