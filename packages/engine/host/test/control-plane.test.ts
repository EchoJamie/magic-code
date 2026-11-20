import { expect, test } from 'bun:test'
import { CONTROL_FRAME_BUDGET_BYTES } from '@magic/contracts'
import type { Wire } from '@magic/contracts'
import { controlLink } from '../src/control-plane.ts'
import type { Link } from '../src/wire.ts'

/** 记账用假连接——只验「门面写了什么」，不碰真 socket。 */
function fakeLink(): { readonly sent: Wire[]; readonly link: Link } {
  const sent: Wire[] = []
  const link: Link = {
    send(message) { sent.push(message); return true },
    onMessage() {},
    onClose() {},
    close() {},
    get closed() { return false },
  }
  return { sent, link }
}

const big = (size = CONTROL_FRAME_BUDGET_BYTES + 1024): string => 'x'.repeat(size)

test('小消息原样通过', () => {
  const { sent, link } = fakeLink()
  const control = controlLink(link)
  const message: Wire = { t: 'line', text: 'ok' }
  expect(control.send(message)).toBe(true)
  expect(sent).toEqual([message])
})

test('目录超预算 → 减半并带 truncated，连接不变', () => {
  const { sent, link } = fakeLink()
  const faults: string[] = []
  const control = controlLink(link, event => faults.push(event))
  const sessions = Array.from({ length: 100 }, (_, index) => ({
    id: `s-${index}`, at: index, archived: false, title: 'x'.repeat(20 * 1024),
  }))
  const message = {
    t: 'ev', gen: null, event: {
      id: 0, turn: null, at: 0, session: 's-0', kind: 'session.state',
      data: { active: 's-0', sessions },
    },
  } as unknown as Wire

  expect(control.send(message)).toBe(true)
  expect(sent).toHaveLength(1)
  const event = (sent[0] as any).event
  expect(event.data.sessions.length).toBeLessThan(100)
  expect(event.data.truncated).toBe(true)
  expect(faults).toEqual(['control.frame.reduced'])
})

test('历史终止帧降级后仍是 done:true', () => {
  const { sent, link } = fakeLink()
  const control = controlLink(link)
  const entries = Array.from({ length: 20 }, (_, index) => ({
    id: index, kind: 'assistant', content: { text: big(80 * 1024) }, at: index,
  }))
  const message = {
    t: 'ev', gen: null, event: {
      id: 0, turn: null, at: 0, session: 's', kind: 'session.history',
      data: { session: 's', entries, done: true },
    },
  } as unknown as Wire

  expect(control.send(message)).toBe(true)
  const data = (sent[0] as any).event.data
  expect(data.done).toBe(true)
  expect(data.truncated).toBe(true)
})

test('welcome 超预算 → 先剥提醒再剥运行行，永不拒发', () => {
  const { sent, link } = fakeLink()
  const control = controlLink(link)
  const message = {
    t: 'welcome', identity: {}, conn: 1, base: '/tmp', mcp: [],
    runs: Array.from({ length: 40 }, (_, index) => ({ session: `s-${index}`, padding: big(64 * 1024) })),
    notices: Array.from({ length: 20 }, (_, index) => ({ id: `n-${index}`, detail: big(64 * 1024) })),
  } as unknown as Wire

  expect(control.send(message)).toBe(true)
  expect(sent).toHaveLength(1)
  expect((sent[0] as any).notices.length).toBeLessThanOrEqual(20)
  expect((sent[0] as any).runs.length).toBeLessThan(40)
})

test('降不动的超大消息 → 拒发这一帧、连接保持', () => {
  const { sent, link } = fakeLink()
  const faults: { event: string; data: Record<string, unknown> }[] = []
  const control = controlLink(link, (event, data) => faults.push({ event, data }))
  const message = { t: 'native.error', reason: big() } as unknown as Wire

  expect(control.send(message)).toBe(false)
  expect(sent).toEqual([])
  expect(faults[0]).toMatchObject({ event: 'control.frame.rejected' })
})
