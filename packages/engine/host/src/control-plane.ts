/**
 * 控制面门面——**唯一**把消息写进客户端连接的地方。
 *
 * 2026-11-21 的教训：产生侧可以合法造出任意大的语义消息，传输层只会看到
 * 「这一帧太大」。用户的底线是**无论数据多大，界面都要可用**——所以：
 *
 * - 产生侧的目标是 `CONTROL_FRAME_BUDGET_BYTES`（1MiB）；超了就分页/预览/引用；
 * - 门面在这里做**最后一道成形**：先量整帧，超预算就按消息类型降一档；
 * - 降不动（或未知类型）就拒发这一帧，**连接保持**，诊断里留下 kind 与字节数。
 *
 * 门面不认识业务语义，只认识「这条消息的哪一段可以收」：
 * 目录减半、历史减半并保持 `done`、待处理输入减半、welcome 先剥提醒再剥运行行、
 * 投影减半。所有降级都带 `truncated`/`omitted`/`total` 之类的可选字段——
 * 旧客户端忽略它们，新客户端据此说「还有 N 条」。
 *
 * ⚠️ 不在这里做分页游标：分页是产生侧的事（目录/历史各自知道怎么续）。
 * 门面只在产生侧漏了的时候**保证连接不被压断**。
 */

import { CONTROL_FRAME_BUDGET_BYTES, CONTROL_PREVIEW_TEXT_BYTES } from '@magic/contracts'
import type { Wire } from '@magic/contracts'
import type { Link } from './wire.ts'

export type ControlFault = (event: string, data: Record<string, unknown>) => void

const encoder = new TextEncoder()

function frameBytes(value: unknown): number {
  try {
    return encoder.encode(`${JSON.stringify(value)}\n`).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** 诊断用：消息 t 与事件 kind 的短 token（不带正文）。 */
function kindOf(message: Wire): string {
  const record = message as { t?: unknown; event?: { kind?: unknown } }
  const t = typeof record.t === 'string' ? record.t : 'unknown'
  const kind = typeof record.event?.kind === 'string' ? record.event.kind : undefined
  return (kind === undefined ? t : `${t}:${kind}`).slice(0, 48)
}

/** 按 UTF-8 字节裁文本——逐码点收，不切坏多字节字符。 */
function clipText(text: string, maxBytes: number): string {
  if (encoder.encode(text).byteLength <= maxBytes) return text
  let used = 0
  let out = ''
  for (const char of text) {
    const size = encoder.encode(char).byteLength
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

function clipDetail<T extends { readonly detail?: string }>(notice: T): T {
  if (notice.detail === undefined) return notice
  return { ...notice, detail: clipText(notice.detail, CONTROL_PREVIEW_TEXT_BYTES) }
}

/** 把数组砍半；空数组或只剩 1 条返回 undefined ＝ 这一类降不动了，换下一种。 */
function half<T>(items: readonly T[]): readonly T[] | undefined {
  if (items.length <= 1) return undefined
  return items.slice(0, Math.floor(items.length / 2))
}

/**
 * 降一档。返回 `undefined` ＝ 这一类消息没有可再降的部分。
 *
 * 所有分支都只**收窄**内容，不改语义：`done` 仍是 `done`，
 * 目录/投影仍是完整替换语义，历史减半时 `next` 指向最后一条**已发送**的条目。
 */
function reduceOnce(message: Wire): Wire | undefined {
  const record = message as Record<string, any>

  if (record.t === 'ev' && record.event !== null && typeof record.event === 'object') {
    const event = record.event
    const data = event.data
    switch (event.kind) {
      case 'session.state': {
        const sessions = Array.isArray(data?.sessions) ? data.sessions : []
        const kept = half(sessions) ?? (sessions.length > 0 ? [] : undefined)
        if (kept === undefined) return undefined
        return {
          ...record,
          event: { ...event, data: { ...data, sessions: kept, total: data.total ?? sessions.length, truncated: true } },
        } as unknown as Wire
      }
      case 'input.pending': {
        const inputs = Array.isArray(data?.inputs) ? data.inputs : []
        const kept = half(inputs) ?? (inputs.length > 0 ? [] : undefined)
        if (kept === undefined) return undefined
        return {
          ...record,
          event: {
            ...event,
            data: {
              ...data, inputs: kept,
              omitted: (typeof data.omitted === 'number' ? data.omitted : 0) + (inputs.length - kept.length),
            },
          },
        } as unknown as Wire
      }
      case 'session.history': {
        const entries = Array.isArray(data?.entries) ? data.entries : []
        if (data?.done === true) {
          // 终止帧必须保持 done：先丢正文，留住「读完了」这件事与续读点。
          if (entries.length === 0 && data.truncated === true) return undefined
          return {
            ...record,
            event: {
              ...event,
              data: {
                session: data.session, entries: [], done: true, truncated: true,
                ...(data.next === undefined ? {} : { next: data.next }),
                ...(entries.length === 0 ? {} : { next: (entries.at(-1) as { id?: number } | undefined)?.id }),
              },
            },
          } as unknown as Wire
        }
        const kept = half(entries)
        if (kept === undefined) return undefined
        return {
          ...record,
          event: { ...event, data: { ...data, entries: kept, truncated: true, next: (kept.at(-1) as { id?: number } | undefined)?.id } },
        } as unknown as Wire
      }
      case 'plan.changed': {
        if (data?.plan === undefined) return undefined
        return { ...record, event: { ...event, data: { ...data, plan: undefined, truncated: true } } } as unknown as Wire
      }
      case 'error':
      case 'model.error': {
        if (typeof data?.message !== 'string') return undefined
        return { ...record, event: { ...event, data: { ...data, message: clipText(data.message, CONTROL_PREVIEW_TEXT_BYTES) } } } as unknown as Wire
      }
      case 'input.local': {
        if (typeof data?.text !== 'string') return undefined
        return { ...record, event: { ...event, data: { ...data, text: clipText(data.text, CONTROL_PREVIEW_TEXT_BYTES) } } } as unknown as Wire
      }
      default:
        return undefined
    }
  }

  if (record.t === 'welcome') {
    const notices = Array.isArray(record.notices) ? record.notices : []
    const keptNotices = half(notices) ?? (notices.length > 0 ? [] : undefined)
    if (keptNotices !== undefined) {
      return {
        ...record,
        notices: keptNotices.map(clipDetail),
        omittedNotices: (typeof record.omittedNotices === 'number' ? record.omittedNotices : 0) + (notices.length - keptNotices.length),
      } as unknown as Wire
    }
    const runs = Array.isArray(record.runs) ? record.runs : []
    const keptRuns = half(runs) ?? (runs.length > 0 ? [] : undefined)
    if (keptRuns !== undefined) {
      return { ...record, runs: keptRuns, omittedRuns: (typeof record.omittedRuns === 'number' ? record.omittedRuns : 0) + (runs.length - keptRuns.length) } as unknown as Wire
    }
    // welcome 是握手帧——最后剥 MCP 预检目录、截拒绝原因，保证它一定能送达。
    if (Array.isArray(record.mcp) && record.mcp.length > 0) return { ...record, mcp: [] } as unknown as Wire
    if (typeof record.refuse === 'string') return { ...record, refuse: clipText(record.refuse, CONTROL_PREVIEW_TEXT_BYTES) } as unknown as Wire
    return undefined
  }

  if (record.t === 'runs' && Array.isArray(record.rows)) {
    const kept = half(record.rows)
    if (kept === undefined) return undefined
    return { ...record, rows: kept, omitted: (typeof record.omitted === 'number' ? record.omitted : 0) + (record.rows.length - kept.length) } as unknown as Wire
  }

  if (record.t === 'notice' && record.notice !== null && typeof record.notice === 'object') {
    if (typeof record.notice.detail !== 'string') return undefined
    return { ...record, notice: clipDetail(record.notice) } as unknown as Wire
  }

  if (record.t === 'line' && typeof record.text === 'string') {
    return { ...record, text: clipText(record.text, CONTROL_PREVIEW_TEXT_BYTES) } as unknown as Wire
  }

  // 错误原因也是必须送达的一种：截短可以，整帧丢掉用户就看不到发生了什么。
  if (record.t === 'native.error' && typeof record.reason === 'string') {
    return { ...record, reason: clipText(record.reason, CONTROL_PREVIEW_TEXT_BYTES) } as unknown as Wire
  }

  if (record.t === 'resumed' && record.snapshot !== null && typeof record.snapshot === 'object') {
    // 恢复快照先丢工具状态、再裁正文——「接上」比「接上全部细节」优先。
    const snapshot = record.snapshot
    return {
      ...record,
      snapshot: {
        ...snapshot,
        ...(typeof snapshot.text === 'string' ? { text: clipText(snapshot.text, 64 * 1024) } : {}),
        ...(typeof snapshot.thinking === 'string' ? { thinking: clipText(snapshot.thinking, 16 * 1024) } : {}),
        tools: [],
        truncated: true,
      },
    } as unknown as Wire
  }

  if (record.t === 'native.projection' && record.projection !== null && typeof record.projection === 'object') {
    const works = Array.isArray(record.projection.works) ? record.projection.works : []
    const kept = half(works) ?? (works.length > 0 ? [] : undefined)
    if (kept === undefined) return undefined
    return {
      ...record,
      projection: {
        ...record.projection, works: kept,
        omitted: (typeof record.projection.omitted === 'number' ? record.projection.omitted : 0) + (works.length - kept.length),
      },
    } as unknown as Wire
  }

  if (record.t === 'native.welcome' && record.projection !== null && typeof record.projection === 'object') {
    const works = Array.isArray(record.projection.works) ? record.projection.works : []
    const kept = half(works) ?? (works.length > 0 ? [] : undefined)
    if (kept === undefined) return undefined
    return {
      ...record,
      projection: {
        ...record.projection, works: kept,
        omitted: (typeof record.projection.omitted === 'number' ? record.projection.omitted : 0) + (works.length - kept.length),
      },
    } as unknown as Wire
  }

  if (record.t === 'native.history.result' && Array.isArray(record.entries)) {
    const kept = half(record.entries) ?? (record.entries.length > 0 ? [] : undefined)
    if (kept === undefined) return undefined
    return { ...record, entries: kept, done: false, truncated: true, ...(kept.length === 0 ? {} : { next: (kept.at(-1) as { id?: number } | undefined)?.id }) } as unknown as Wire
  }

  if (record.t === 'native.inspected' && record.work !== null && typeof record.work === 'object') {
    const work = record.work
    const notice = work.currentNotice
    if (notice === null || typeof notice !== 'object' || typeof notice.detail !== 'string') return undefined
    return { ...record, work: { ...work, currentNotice: clipDetail(notice) } } as unknown as Wire
  }

  return undefined
}

/**
 * 把一条 raw `Link` 包成受控出口。`send` 先量整帧，超预算就逐档降级；
 * 降不动就拒发（返回 false），**不关闭连接**。
 */
export function controlLink<In extends Wire = Wire>(raw: Link<In>, fault?: ControlFault): Link<In> {
  return {
    send(message) {
      const original = frameBytes(message)
      if (original <= CONTROL_FRAME_BUDGET_BYTES) return raw.send(message)

      let current: Wire = message
      for (let round = 0; round < 8; round += 1) {
        const reduced = reduceOnce(current)
        if (reduced === undefined) break
        current = reduced
        if (frameBytes(current) <= CONTROL_FRAME_BUDGET_BYTES) {
          fault?.('control.frame.reduced', { kind: kindOf(message), bytes: original })
          return raw.send(current)
        }
      }

      // 降不动：丢这一帧，连接保持。调用方按 false 决定是否重试/提示。
      fault?.('control.frame.rejected', { kind: kindOf(message), bytes: original })
      return false
    },
    onMessage(listener) { raw.onMessage(listener) },
    onClose(listener) { raw.onClose(listener) },
    close() { raw.close() },
    get closed() { return raw.closed },
  }
}
