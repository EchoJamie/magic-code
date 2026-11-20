/**
 * 控制面消息的**成形原语**——manager 与 native observer 共用一份。
 *
 * 2026-11-21 审计：同一条记录既可能从 `session.history` 下发，也可能从
 * `native.history` 下发；两处各写一份裁剪，迟早一处漏字段。这里只做三件事：
 * 量字节、按 UTF-8 裁文本、把一条 `Entry` 的所有字段压进预算。
 *
 * 不在这里决定「发不发」——那是产生侧的分批/分页与 `control-plane.ts` 的门面。
 */

import type { Content, Entry } from '@magic/contracts'

const encoder = new TextEncoder()

export const TRUNCATED_MARK = '\n[记录过大，显示已截断]'

/** 一帧序列化后的 UTF-8 字节数（与 wire 的量法一致）。 */
export function wireBytesOf(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** 按 UTF-8 字节裁文本——逐码点收，不切坏多字节字符；截断处留一句说明。 */
export function clipTextBytes(text: string, maxBytes: number): string {
  if (encoder.encode(text).byteLength <= maxBytes) return text
  const room = Math.max(0, maxBytes - encoder.encode(TRUNCATED_MARK).byteLength)
  let used = 0
  let out = ''
  for (const char of text) {
    const bytes = encoder.encode(char).byteLength
    if (used + bytes > room) break
    out += char
    used += bytes
  }
  return `${out}${TRUNCATED_MARK}`
}

export function clipContent(content: Content, maxBytes: number): Content {
  return 'text' in content ? { text: clipTextBytes(content.text, maxBytes) } : content
}

/** 递归裁值：字符串按预算裁，数组/对象按成员数分配预算，其余原样。 */
export function clipValue(value: unknown, maxBytes: number): unknown {
  if (typeof value === 'string') return clipTextBytes(value, maxBytes)
  if (Array.isArray(value)) {
    const each = Math.max(1, Math.floor(maxBytes / Math.max(1, value.length)))
    return value.map(one => clipValue(one, each))
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    const each = Math.max(1, Math.floor(maxBytes / Math.max(1, keys.length)))
    const out: Record<string, unknown> = {}
    for (const key of keys) out[key] = clipValue(record[key], each)
    return out
  }
  return value
}

/**
 * 把一条历史记录压进预算——**所有字段**都受约束，不只是正文与工具输出。
 *
 * `tool-call.args`、`assistant.reasoning`、`user.refs[].text`、`plan`/`knowledge`
 * 都能单独把一条记录撑到 MB 级。每轮把预算减半，最多三轮；三轮后仍超就交给
 * 门面兜底（连接不会被砍）。
 */
export function clipEntryForWire(entry: Entry, maxBytes: number): Entry {
  let current = entry
  let budget = maxBytes
  for (let round = 0; round < 3 && wireBytesOf(current) > budget; round += 1) {
    const half = Math.max(1, Math.floor(budget / 2))
    const content = clipContent(current.content, half)
    const payload = current.payload === undefined ? undefined : clipValue(current.payload, half) as Entry['payload']
    current = { ...current, content, ...(payload === undefined ? {} : { payload }) }
    budget = Math.max(1, Math.floor(budget / 2))
  }
  return current
}

/** 把一条记录裁到「装得进一帧」：反复降档直到量出来的字节不再下降或已达标。 */
export function fitEntryToWire(entry: Entry, maxBytes: number): { readonly entry: Entry; readonly bytes: number } {
  let current = clipEntryForWire(entry, maxBytes)
  let bytes = wireBytesOf(current)
  while (bytes > maxBytes) {
    const tighter = clipEntryForWire(current, Math.max(1, Math.floor(bytes / 2)))
    const next = wireBytesOf(tighter)
    if (next >= bytes) break
    current = tighter
    bytes = next
  }
  return { entry: current, bytes }
}
