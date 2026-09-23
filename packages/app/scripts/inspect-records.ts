#!/usr/bin/env bun
/**
 * 验收查询脚本 —— **直读记录库**（阶段 1 的验收读法：技术方案 · 记录 · 存储）。
 *
 * 「交代一件事，它跑一条命令，记录里看得到全过程」——本脚本就是**读那个记录**的眼睛：
 * 拿裸 `bun:sqlite` 打开配置里那个 `dataDir` 下的 `records.db`（默认＝**统一基础路径**
 * 下的 `<基础目录>/records.db`，即不设 `MAGIC_HOME` 时的 `~/.magic/records.db`），
 * 把事件流与会话条目摊开给人看。
 * **不经记录域的 API**——正是要证明「库在那儿、谁都读得动」，而不是「经我们的代码才看得见」。
 *
 * 一处别处没有的红利：**条目与事件共用同一个 id 空间**（记录域拥有 · `nextId()`），
 * 故两张表按 id 归并即为**发生序**——不必猜时间戳的先后、也不必假设写入次序。
 *
 * 用法：
 *   bun packages/app/scripts/inspect-records.ts                 # 最近一个会话
 *   bun packages/app/scripts/inspect-records.ts --session <id>
 *   bun packages/app/scripts/inspect-records.ts --sessions      # 只列会话
 *   bun packages/app/scripts/inspect-records.ts --db <path>     # 指认库文件（默认按配置找）
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expandHome, TRANSIENT_EVENT_KINDS } from '@magic/contracts'
import { homedir } from 'node:os'
import { DATABASE_FILE } from '@magic/records'
import { loadConfig } from '../src/index.ts'

// —— 入参 ——

type Args = {
  readonly db?: string | undefined
  readonly session?: string | undefined
  readonly sessionsOnly: boolean
  readonly help: boolean
}

const USAGE = `magic 记录库查询 —— 直读记录库

用法：
  inspect-records.ts                 列会话 + 最近一个会话的全过程
  inspect-records.ts --sessions      只列会话
  inspect-records.ts --session <id>  指定会话
  inspect-records.ts --db <路径>     指认库文件（默认按配置的 dataDir 找）

默认那条路问的是配置：读 Magic 基础目录下的 config.json（不设 MAGIC_HOME 时就是
~/.magic/config.json），再取它里面 dataDir 那一格——与 magic 自己用同一份配置，
故不会看错地方。数据落在别处时用 --db 指认。
`

function parseArgs(argv: readonly string[]): Args {
  let db: string | undefined
  let session: string | undefined
  let sessionsOnly = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true, sessionsOnly: false }
    if (arg === '--sessions') {
      sessionsOnly = true
      continue
    }
    if (arg === '--db' || arg === '--session') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} 缺值（见 --help）`)
      if (arg === '--db') db = value
      else session = value
      i += 1
      continue
    }
    throw new Error(`不认得的参数「${arg}」（见 --help）`)
  }

  return { db, session, sessionsOnly, help: false }
}

// —— 落点 ——

/**
 * 库文件在哪——默认**问配置**（与运行时同一个来处，故不会看错地方）；
 * 文件名取自记录域公开的常量（`DATABASE_FILE`），不在 app 里重写一份字面量。
 *
 * `loadConfig()` 不带参数时走**统一基础路径**（U42：`MAGIC_HOME` 指到别处就读那一处）
 * ——脚本因此与主程序看同一个地方，不必自己拼一遍家目录。
 * `--db` 给的路径**照字面**（`~` 展开到真家目录）：那是「我明确要读这一个文件」，
 * 不再替用户改道。
 */
function resolveDatabasePath(explicit: string | undefined): string {
  if (explicit !== undefined) return expandHome(explicit, homedir())

  const loaded = loadConfig()
  return join(loaded.config.dataDir, DATABASE_FILE)
}

// —— 行形态（列名即落盘形态）——

type SessionRow = { id: string; at: number }
type EntryRow = {
  id: number
  kind: string
  content_kind: string
  content_text: string | null
  content_blob: string | null
  payload: string | null
  at: number
}
type EventRow = {
  id: number
  turn: number | null
  at: number
  kind: string
  data: string
}

/** 一条摊平后的记录——事件与条目归并后的统一行。 */
type Row = {
  readonly id: number
  readonly kind: string
  readonly turn: number | null
  readonly at: number
  readonly what: string
}

// —— 呈现助手（本脚本自己的事；不是内核产物）——

function clockOf(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 正文一句话——换行折成 `⏎`，免得一条记录撑破一屏。 */
function inline(text: string, limit = 72): string {
  const flat = text.replace(/\n/g, '⏎')
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function contentOf(row: EntryRow): string {
  if (row.content_kind === 'blob') return `<blob ${row.content_blob ?? '?'}>`
  return inline(row.content_text ?? '')
}

/** 事件的「发生了什么」——载荷里的关键字段挑出来说人话。 */
function describeEvent(row: EventRow): string {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(row.data) as Record<string, unknown>
  } catch {
    return row.data
  }

  switch (row.kind) {
    case 'agent.state':
      return String(data['state'] ?? '')
    case 'turn.end':
      return `结束方式 ${String(data['reason'] ?? '')}`
    case 'message.user':
    case 'message.assistant':
      return `内容归条目 #${String(data['entry'] ?? '?')}`
    case 'model.call.start':
      return `模型 ${String(data['model'] ?? '')}`
    case 'model.usage':
      return `用量 in ${String(data['inputTokens'])} / out ${String(data['outputTokens'])}`
    case 'model.error':
      return `分档 ${String(data['tier'])}：${inline(String(data['message'] ?? ''), 48)}`
    case 'tool.call':
      return `${String(data['name'])} ${inline(JSON.stringify(data['args'] ?? {}), 48)}`
    case 'tool.decision.request':
      return `询问 ${String(data['name'])}（${String(data['weight'])}）· 调用链 #${String(data['call'])}`
    case 'tool.decision':
      return `裁决 ${String(data['decision'])} · 裁者 ${String(data['decider'])} · ${String(data['elapsedMs'])}ms · 调用链 #${String(data['call'])}`
    case 'tool.result':
      return `ok=${String(data['ok'])} · 输出 ${inline(JSON.stringify(data['output'] ?? {}), 48)} · 调用链 #${String(data['call'])}`
    default:
      return inline(row.data, 60)
  }
}

/** 条目的「是什么」——工具条目把载荷带上（重放真源就在这儿）。 */
function describeEntry(row: EntryRow): string {
  const body = contentOf(row)
  if (row.payload === null) return body

  const payload = JSON.parse(row.payload) as { name?: string; args?: unknown; ok?: boolean }
  if (payload.name !== undefined) return `${payload.name} ${inline(JSON.stringify(payload.args ?? {}), 48)}`
  if (payload.ok !== undefined) return `ok=${String(payload.ok)}${body === '' ? '' : ` · ${body}`}`
  return body
}

// —— 主流程 ——

function assertDatabase(path: string): void {
  if (!existsSync(path)) {
    throw new Error(
      `记录库不在 ${path}——先跑一次 magic（或 magic --script <文件>）让它落盘；` +
        `若数据落在别处，用 --db <路径> 指认。`,
    )
  }
}

function main(): number {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  if (args.help) {
    console.log(USAGE)
    return 0
  }

  let databasePath: string
  try {
    databasePath = resolveDatabasePath(args.db)
  } catch (error) {
    console.error(`找不到库：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  try {
    assertDatabase(databasePath)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  const db = new Database(databasePath, { readonly: true })

  try {
    const sessions = db
      .query<SessionRow, []>('SELECT id, at FROM sessions ORDER BY at DESC, id DESC')
      .all()

    if (sessions.length === 0) {
      console.log(`记录库 ${databasePath}`)
      console.log('（还没有会话——写过的会话才现形）')
      return 0
    }

    const counts = db
      .query<{ session: string; events: number; entries: number }, []>(
        `SELECT s.id AS session,
                (SELECT COUNT(*) FROM events  e WHERE e.session = s.id) AS events,
                (SELECT COUNT(*) FROM entries n WHERE n.session = s.id) AS entries
           FROM sessions s`,
      )
      .all()
    const countOf = new Map(counts.map((row) => [row.session, row]))

    console.log(`═══ 记录库 ═══`)
    console.log(databasePath)
    console.log()
    console.log(`═══ 会话（${sessions.length} 个）═══`)

    const target = args.session ?? sessions[0]?.id ?? ''
    for (const session of sessions) {
      const tally = countOf.get(session.id)
      const mark = session.id === target ? '●' : ' '
      console.log(
        `  ${mark} ${session.id}  ${clockOf(session.at)}  ` +
          `事件 ${tally?.events ?? 0} · 条目 ${tally?.entries ?? 0}`,
      )
    }

    if (args.sessionsOnly) return 0

    const entries = db
      .query<EntryRow, [string]>(
        `SELECT id, kind, content_kind, content_text, content_blob, payload, at
           FROM entries WHERE session = ? ORDER BY id`,
      )
      .all(target)
    const events = db
      .query<EventRow, [string]>(
        `SELECT id, turn, at, kind, data FROM events WHERE session = ? ORDER BY id`,
      )
      .all(target)

    // 归并——同一 id 空间，故按 id 排即发生序
    const rows: Row[] = [
      ...events.map(
        (row): Row => ({
          id: row.id,
          kind: row.kind,
          turn: row.turn,
          at: row.at,
          what: describeEvent(row),
        }),
      ),
      ...entries.map(
        (row): Row => ({
          id: row.id,
          kind: `条目·${row.kind}`,
          turn: null,
          at: row.at,
          what: describeEntry(row),
        }),
      ),
    ].sort((a, b) => a.id - b.id)

    console.log()
    console.log(`═══ 全过程 · 会话 ${target} ═══`)
    console.log('     id  轮   事件 / 条目                发生了什么')
    console.log('  ─────  ───  ────────────────────────  ──────────────────────────────')

    for (const row of rows) {
      const turn = row.turn === null ? ' · ' : String(row.turn).padStart(2, ' ')
      console.log(`  ${String(row.id).padStart(5, ' ')}  ${turn}  ${row.kind.padEnd(22, ' ')}  ${row.what}`)
    }

    // 调用链——「请求 → 询问 → 裁决 → 结果」四事件按 `call` 串起来（配对键是请求事件 id）
    const calls = events.filter((row) => row.kind === 'tool.call')
    if (calls.length > 0) {
      console.log()
      console.log('═══ 工具调用链 ═══')
      for (const call of calls) {
        const chain = (kind: string): EventRow | undefined =>
          events.find((row) => {
            if (row.kind !== kind) return false
            try {
              return JSON.parse(row.data)['call'] === call.id
            } catch {
              return false
            }
          })

        const request = chain('tool.decision.request')
        const decision = chain('tool.decision')
        const result = chain('tool.result')
        const name = (JSON.parse(call.data) as { name?: string }).name ?? '?'

        console.log(
          `  #${call.id} ${name} → 询问 #${request?.id ?? '—'} → ` +
            `裁决 #${decision?.id ?? '—'} → 结果 #${result?.id ?? '—'}`,
        )
        if (decision !== undefined) {
          const data = JSON.parse(decision.data) as { decision?: string; elapsedMs?: number }
          console.log(`      裁决 ${data.decision}（用时 ${data.elapsedMs}ms——提示 → 答复）`)
        }
      }
    }

    console.log()
    console.log(
      `小结：事件 ${events.length} 条 · 条目 ${entries.length} 条 · ` +
        `瞬时类（${TRANSIENT_EVENT_KINDS.join(' / ')}）不在事件表——它们只走订阅。`,
    )
    return 0
  } finally {
    db.close()
  }
}

process.exit(main())
