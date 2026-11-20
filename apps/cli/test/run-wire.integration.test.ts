/** 验证 Unix socket 消息完整性：超过发送缓冲时按已写字节数续写，接收端不得缺失或错位。 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Socket } from 'bun'
import { linkOf, socketHandlers } from '@magic/host'
import type { LinkHooks } from '@magic/host'
import type { Wire } from '@magic/contracts'
import { WIRE_MESSAGE_BUDGET_BYTES } from '@magic/contracts'
import { removeDir, tempDir } from './tmp.ts'

/** 等一个条件成立（默认 5 秒）——轮询是用例的事，产品那几跳都是事件驱动的。 */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(10)
  }
}

/**
 * 起一对连着的 `Link`（真 unix socket，两端同一套 `socketHandlers`）——用完请调 `stop`。
 *
 * 走的是**真** `Bun.listen` / `Bun.connect`：这一条量的正是「socket 写出去多少」这件事，
 * 换成一对内存里的假 socket 就把要验的那个机制整个换掉了。
 */
async function pair(hooks?: LinkHooks): Promise<{
  readonly client: ReturnType<typeof linkOf<Wire>>
  readonly server: ReturnType<typeof linkOf<Wire>>
  readonly received: Wire[]
  stop(): void
}> {
  const root = tempDir('magic-u75-wire-')
  const path = join(root, 'wire.sock')
  const received: Wire[] = []
  let server: ReturnType<typeof linkOf<Wire>> | undefined

  const listener = Bun.listen({
    unix: path,
    socket: socketHandlers((socket) => {
      server = linkOf<Wire>(socket as Socket<unknown>, hooks)
      server.onMessage((message) => received.push(message))
    }),
  })

  const socket = (await Bun.connect({ unix: path, socket: socketHandlers() })) as Socket<unknown>
  const client = linkOf<Wire>(socket)
  await waitFor('连接接上（服务端那一端包好了）', () => server !== undefined)

  return {
    client,
    server: server as ReturnType<typeof linkOf<Wire>>,
    received,
    stop: () => {
      client.close()
      server?.close()
      listener.stop(true)
      removeDir(root)
    },
  }
}

describe('线上一条消息的完整性', () => {
  test('**超过发送缓冲**的一条，另一头整条收得到（字节一个不少）', async () => {
    const wire = await pair()

    try {
      // 这条消息的体量按**字节**给足（一个汉字三个字节）：几千字就足以盖过那个发送缓冲。
      // ⚠️ **不看条数**——真现场栽的那条 `session.history` 也不过一条消息。
      const text = `${'材料正文'.repeat(20_000)}尾巴`
      wire.client.send({ t: 'line', text })

      await waitFor('对面收到那一条', () => wire.received.length >= 1)
      expect(wire.received).toEqual([{ t: 'line', text }])
    } finally {
      wire.stop()
    }
  })

  test('**连着几条大的**：次序与内容一条不差（欠着的那一截不许顶掉后面那条）', async () => {
    const wire = await pair()

    try {
      const 三条 = [1, 2, 3].map((n) => ({ t: 'line' as const, text: `${n}:${'甲'.repeat(30_000)}` }))

      for (const one of 三条) wire.client.send(one)

      await waitFor('三条都到齐', () => wire.received.length >= 3)
      expect(wire.received).toEqual(三条)
    } finally {
      wire.stop()
    }
  })

  test('两边都发：谁发的谁收得到（这条连接是双向的）', async () => {
    const wire = await pair()

    try {
      const fromClient = { t: 'bye' as const, why: `客户端那一条${'乙'.repeat(30_000)}` }
      const fromServer = { t: 'line' as const, text: `服务端那一条${'丙'.repeat(30_000)}` }
      const atClient: Wire[] = []
      wire.client.onMessage((message) => atClient.push(message))

      wire.client.send(fromClient)
      wire.server.send(fromServer)

      await waitFor('两边各收到一条', () => wire.received.length >= 1 && atClient.length >= 1)
      expect(wire.received).toEqual([fromClient])
      expect(atClient).toEqual([fromServer])
    } finally {
      wire.stop()
    }
  })
})

describe('单条超限与发送积压分开判', () => {
  test('单条超过预算 → 原因写 message-too-large，不冒充「对端不读」', async () => {
    const faults: { event: string; data: Record<string, unknown> }[] = []
    const wire = await pair({ fault: (event, data) => faults.push({ event, data }) })

    try {
      // 服务端发一条自己就超过预算的消息——这一次没有欠账，属于「单条太大」。
      wire.server.send({ t: 'line', text: 'x'.repeat(WIRE_MESSAGE_BUDGET_BYTES + 1) })

      await waitFor('服务端这一端断开', () => wire.server.closed)
      expect(faults).toHaveLength(1)
      expect(faults[0]).toMatchObject({ event: 'link.terminated', data: { reason: 'message-too-large' } })
      expect(Number(faults[0]?.data['bytes'])).toBeGreaterThan(WIRE_MESSAGE_BUDGET_BYTES)
    } finally {
      wire.stop()
    }
  })
})
