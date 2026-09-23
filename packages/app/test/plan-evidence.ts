/**
 * U34 · **内核线的证据驱动**——把「模型实际收到了什么、记录里落了什么、事件报了哪些」
 * 从**真装配**（真记录库 · 真闸门 · 真对话域 · 真控制面）里落成可核对的文本。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。判据（写没写、读得到、串不串）归
 * `plan.test.ts`；这里出的是**给人从上到下一行行读的那一份**——规划交付要求
 * 「以实际模型请求证明指导首次即送达、压缩后仍在」，而请求留痕在测试断言里只是一串
 * 断言，看不出全貌。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/plan-evidence.ts --out <目录>
 * ```
 *
 * 出四份：
 * - `请求.txt`——每趟模型请求的**逐条消息**（真实发送的那一份）；
 * - `记录.txt`——**裸读库表**（关连接后直读 SQLite，不经 API 回读）的条目清单；
 * - `事件.txt`——事件轨迹（含 `plan.changed` 与 `tool.decision` 的裁者）；
 * - `会话.txt`——一条与另一条会话的对照（重开接得上 · 别条读不到）。
 *
 * ## 边界（照实写）
 *
 * 模型那一头是 **Faux**（假端点回放固定事件序列）：**一个付费请求都不发**，
 * 也不读任何真实 key。故本驱动证明的是**通路与呈现**（指导送达 · 落账 · 读取 ·
 * 上下文装配 · 权限放行），**不是真实模型行为**——后者没有合规环境时单列「未验证」。
 * 沙地的 `HOME` / `dataDir` / `grants` 全在临时目录里（`makeStage`），真 `~/.magic` 零触碰。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelMessage, PlanNote } from '@magic/contracts'
import { attachShell } from '../src/index.ts'
import type { Stage } from './support.ts'
import { lastModel, makeStage, readDatabase } from './support.ts'

const argv = process.argv.slice(2)
const at = argv.indexOf('--out')
const out = at === -1 ? undefined : argv[at + 1]
if (out === undefined) throw new Error('跑法：bun packages/app/test/plan-evidence.ts --out <目录>')
mkdirSync(out, { recursive: true })

const PLAN: PlanNote = {
  steps: [
    { text: '定位登录失败提示', status: 'completed' },
    { text: '覆盖空密码与网络失败', status: 'in_progress' },
    { text: '补一条正常登录的回归', status: 'pending' },
  ],
  notes: '约束：保留用户已输入的内容；失败分支按 401 / 网络错误分别处理',
}

/** 一条消息 → 一行文本（判别联合两支都取得到正文）。 */
function lineOf(message: ModelMessage): string {
  const body = message.role === 'tool' ? message.output : message.content
  const toolCalls =
    message.role === 'assistant' && message.toolCalls !== undefined
      ? ` ⇢ ${message.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.args)})`).join(' · ')}`
      : ''
  const head = message.role === 'tool' ? `tool[${message.name}/${message.ok ? 'ok' : '失败'}]` : message.role

  return `── ${head}\n${body}${toolCalls}`
}

/** 每趟请求落成一段文本。 */
function requestsText(stage: Stage): string {
  return lastModel(stage)
    .requests.map((request, index) => {
      const tools = (request.tools ?? []).map((tool) => tool.name).join(' · ')
      const messages = request.messages.map(lineOf).join('\n\n')
      return `═══ 请求 #${index}（工具表：${tools || '（无）'}）\n\n${messages}`
    })
    .join('\n\n\n')
}

/** 裸读库表——条目（含计划载荷那一条）。 */
function entriesText(stage: ReturnType<Stage['assemble']>): string {
  const db = readDatabase(stage.paths.database)
  const lines = db.entries.map((entry) => {
    const payload = entry.payload === null ? '（无载荷）' : entry.payload
    const content = entry.content_text ?? `（blob ${entry.content_blob}）`
    return `#${entry.id} ${entry.kind}\n  正文：${content}\n  载荷：${payload}`
  })
  const events = db.events.map((event) => `#${event.id} ${event.kind} ${event.data}`)
  db.close()

  return `【条目】\n${lines.join('\n')}\n\n【事件（落库的那些）】\n${events.join('\n')}\n`
}

const stage = makeStage()

try {
  // —— 第一条会话：建计划 →（用量越阈值）→ 压缩 → 回查 → 清空 ——
  const assembly = stage.assemble({
    // ⚠️ 脚本按**每次提交实际会走的那几趟调用**排（一段一轮）：一次提交里
    // 「工具调用那一趟 → 结果回填 → 再走一趟」，故每多一次工具往返就多一段。
    turns: [
      // ① 建计划（这一趟的答复把用量顶过阈值，好让下一次提交开跑前压一次）
      { toolCalls: [{ name: 'plan_update', args: { plan: PLAN } }], usage: { inputTokens: 500, outputTokens: 20 } },
      { text: '记下了。先定位登录失败那一条提示。', usage: { inputTokens: 500, outputTokens: 20 } },
      // ② 压缩（内核自己的那一次调用）→ 回查历史 → **压完再读一次笔记** → 收尾那一趟
      { text: '摘要：改登录失败提示，已定位、正在覆盖失败分支；约束是保留用户已输入内容。' },
      { toolCalls: [{ name: 'history_read', args: {} }], usage: { inputTokens: 30, outputTokens: 20 } },
      { toolCalls: [{ name: 'plan_read', args: {} }], usage: { inputTokens: 30, outputTokens: 20 } },
      { text: '回查过了：第一句交代是「把登录失败提示改清楚」，笔记也还在。' },
      // ③ 收尾：清空
      { toolCalls: [{ name: 'plan_update', args: { plan: null } }], usage: { inputTokens: 30, outputTokens: 20 } },
      { text: '这件事收了，清单撤了。' },
    ],
    // 阈值与近段压到脚本体量（装配期入参，不是用户配置）——为的是在一段短会话里真看见压缩
    context: { compactAtTokens: 100, nearEntries: 0 },
  })
  const shell = attachShell(assembly.shell)

  await shell.submit('把登录失败提示改清楚，保留我已经输入的内容')
  await shell.submit('再做一件事，随便什么')
  await shell.submit('收尾吧')
  shell.dispose()

  const session = assembly.session
  writeFileSync(join(out, '请求.txt'), requestsText(stage))
  writeFileSync(join(out, '记录.txt'), entriesText(assembly))
  writeFileSync(
    join(out, '事件.txt'),
    shell.events
      .map((event) => `${String(event.id).padStart(3)} ${event.kind} ${JSON.stringify(event.data)}`)
      .join('\n') + '\n',
  )
  assembly.close()

  // —— 对照：重开同一条会话（读得到）vs 空手另开一条（读不到）——
  const reopened = stage.assemble({
    turns: [
      { toolCalls: [{ name: 'plan_read', args: {} }] },
      { text: '（重开那一条的答复）' },
    ],
    session,
  })
  const handle = attachShell(reopened.shell)
  await handle.submit('接着来')
  handle.dispose()
  const reopenedRequests = requestsText(stage)
  reopened.close()

  const fresh = stage.assemble({
    turns: [
      { toolCalls: [{ name: 'plan_read', args: {} }] },
      { text: '（新会话那一条的答复）' },
    ],
  })
  const other = attachShell(fresh.shell)
  await other.submit('这边是另一件事')
  other.dispose()
  const freshRequests = requestsText(stage)
  fresh.close()

  writeFileSync(
    join(out, '会话.txt'),
    [
      '【重开同一条会话（给了 --session 那种）——那边已经清空过，读到的是「已清空」：',
      '  清空生效、重开不复活（旧清单不会自己回来）】',
      reopenedRequests.split('═══ 请求').at(-1) ?? '',
      '',
      '【空手另开一条会话——那边从没建过计划，读到的是「还没有计划笔记」：',
      '  读面绑会话，不是绑进程】',
      freshRequests.split('═══ 请求').at(-1) ?? '',
    ].join('\n'),
  )

  console.log(`证据已落到 ${out}`)
} finally {
  stage.dispose()
}
