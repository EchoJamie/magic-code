/**
 * U37 · 图片 —— **真装配的端到端**（从真输入到**真出站请求体**、持久记录与重开）。
 *
 * ## 判据就是工单的完成出口
 *
 * - 「文字配图和纯图片输入均能**实际送达**模型」——断言落在 **HTTP 请求体**上
 *   （一支真网关 ＋ 注入 fetch，与 `skills.test.ts` 的 `realGateway` 同法）：
 *   把 `image_url` 里那段数据 URL 解回来，与盘上那份文件**逐字节**比；
 * - 「重开会话、**源文件删除**后仍能取回原图」——把文件删掉、关掉装配、用同一个
 *   dataDir 与工作区**重开**，再走 `/attachments` → 导出 → 再次送模，字节仍然对得上。
 *
 * 沙地三块（数据目录 / 工作区 / 家目录）都由 `makeStage` 落在唯一临时目录里（不碰真东西）；
 * 导出的临时文件另落在系统临时目录（那是这一条功能的**设计落点**，用例用完即删）。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AttachmentRow, EventStamper, InputRef, KernelEvent, ModelGateway } from '@magic/contracts'
import { createModelGateway } from '@magic/model'
import { attachShell } from '../src/index.ts'
import type { ShellHandle } from '@magic/app'
import { readDatabase, makeStage, type Stage } from './support.ts'

// —— 夹具 ——

/** 1×1 真 PNG（67 字节）——「用户交上来的那张报错截图」。 */
const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

function putBytes(root: string, relative: string, bytes: Uint8Array): string {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

/** 等「回到等待输入」攒够几次。 */
function waitIdle(shell: ShellHandle, times: number): Promise<void> {
  return new Promise((settle) => {
    const watch = setInterval(() => {
      const idle = shell.events.filter(
        (event) => event.kind === 'agent.state' && event.data.state === 'waiting',
      )
      if (idle.length < times) return
      clearInterval(watch)
      settle()
    }, 5)
  })
}

function sendAndWait(
  shell: ShellHandle,
  input: { readonly text: string; readonly refs?: readonly InputRef[]; readonly ref?: string },
): Promise<void> {
  const before = shell.events.filter(
    (event: KernelEvent) => event.kind === 'agent.state' && event.data.state === 'waiting',
  ).length
  shell.send({ type: 'input.submit', ...input })
  return waitIdle(shell, before + 1)
}

/** 一个 OpenAI 兼容的流式分片（真格式——取件层怎么解析真端点，就怎么解析这里）。 */
function chunk(content: string): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`
}

/**
 * 一支**真实网关**（真 SDK）＋ 注入 fetch——**出站请求体留在闭包里**。
 *
 * 这是「受控模型端点」那一件：被判的不是内核侧的形态，而是**真发出去的那串 JSON**。
 */
function realGateway(): {
  readonly make: (stamper: EventStamper) => ModelGateway
  readonly bodies: string[]
} {
  const bodies: string[] = []

  const make = (stamper: EventStamper): ModelGateway =>
    createModelGateway({
      providerId: 'test',
      config: { baseURL: 'http://test.invalid/v1', model: 'test', apiKey: 'fake-test-key' },
      env: {},
      stamper,
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      fetch: async (_input, init) => {
        bodies.push(String(init?.body))
        return new Response(`${chunk('好的')}data: [DONE]\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })

  return { make, bodies }
}

/** 一次出站请求体里**最后那条**用户消息的解码字节（有图时是部件数组，没有就是字符串）。 */
function armedWithImagesOf(body: string): { readonly images: readonly Uint8Array[]; readonly text: string } {
  const parsed = JSON.parse(body) as { messages: readonly { role: string; content: unknown }[] }
  const user = [...parsed.messages].reverse().find((message) => message.role === 'user')
  const content = user?.content

  if (typeof content === 'string') return { images: [], text: content }
  if (!Array.isArray(content)) return { images: [], text: '' }

  const images: Uint8Array[] = []
  let text = ''
  for (const part of content as readonly Record<string, unknown>[]) {
    if (part['type'] === 'text') {
      text += String(part['text'])
      continue
    }
    const url = String((part['image_url'] as { url?: string } | undefined)?.url ?? '')
    const comma = url.indexOf(',')
    if (url.startsWith('data:') && comma > 0) {
      images.push(new Uint8Array(Buffer.from(url.slice(comma + 1), 'base64')))
    }
  }

  return { images, text }
}

/** 收一条 `attachments.catalog`（`/attachments` 的答复）——按「在等它」的那一次认领。 */
function attachmentsOf(handle: ShellHandle): AttachmentRow[] | undefined {
  const said = [...handle.events].reverse().find((event) => event.kind === 'attachments.catalog')

  return said?.kind === 'attachments.catalog' ? [...said.data.rows] : undefined
}

function noteOf(handle: ShellHandle): string | undefined {
  const said = [...handle.events].reverse().find((event) => event.kind === 'attachments.catalog')

  return said?.kind === 'attachments.catalog' ? said.data.note : undefined
}

function attach(stage: Stage, options: Parameters<Stage['assemble']>[0] = {}) {
  const assembly = stage.assemble(options)
  return { assembly, handle: attachShell(assembly.shell) }
}

// ═══════════════════════════════════════════════════════════════════════

describe('U37 · 纯图片：从真输入到真出站请求体', () => {
  test('一张图（正文里只写了它）——出站请求体里就是那张图的字节', async () => {
    const stage = makeStage()
    try {
      const path = putBytes(stage.workspace, '截图.png', PNG)
      const gateway = realGateway()
      const { assembly, handle } = attach(stage, { modelGateway: gateway.make })

      await sendAndWait(handle, {
        text: '看一下 @截图.png',
        refs: [{ kind: 'file', at: 4, marker: '@截图.png', source: path }],
      })

      expect(gateway.bodies).toHaveLength(1)
      const wire = armedWithImagesOf(gateway.bodies[0] ?? '')

      // **逐字节对得上**——不是「有个 image_url」就算数
      expect(wire.images).toHaveLength(1)
      expect([...(wire.images[0] ?? [])]).toEqual([...PNG])
      // 正文一个字不剥（引用那一段还在句子里）
      expect(wire.text).toContain('看一下 @截图.png')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('记录里：用户条目带一份 image 引用，字节**另存 blob**', async () => {
    const stage = makeStage()
    try {
      const path = putBytes(stage.workspace, '截图.png', PNG)
      const { assembly, handle } = attach(stage, { modelGateway: realGateway().make })

      await sendAndWait(handle, {
        text: '看这张',
        refs: [{ kind: 'file', at: 0, marker: '@截图.png', source: path }],
      })

      const rows = readDatabase(assembly.paths.database).entries.filter((entry) => entry.kind === 'user')
      expect(rows).toHaveLength(1)

      const payload = JSON.parse(rows[0]?.payload ?? '{}') as {
        refs?: readonly Record<string, unknown>[]
      }
      const ref = payload.refs?.[0]
      expect(ref?.['kind']).toBe('image')
      expect(ref?.['mime']).toBe('image/png')
      expect(ref?.['name']).toBe('截图.png')
      // **载荷里放的是引用，不是字节**（二进制不进那张表）
      expect(typeof ref?.['blob']).toBe('string')
      expect(JSON.stringify(payload)).not.toContain('iVBORw0KGgo')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U37 · 文字配图与多图：次序与张数都照用户排的来', () => {
  test('文字 — 图 — 文字：出站部件按这个次序排', async () => {
    const stage = makeStage()
    try {
      const path = putBytes(stage.workspace, 'a.png', PNG)
      const gateway = realGateway()
      const { assembly, handle } = attach(stage, { modelGateway: gateway.make })

      await sendAndWait(handle, {
        text: '开头 @a.png 结尾',
        refs: [{ kind: 'file', at: 3, marker: '@a.png', source: path }],
      })

      const parsed = JSON.parse(gateway.bodies[0] ?? '{}') as {
        messages: readonly { role: string; content: unknown }[]
      }
      const user = [...parsed.messages].reverse().find((message) => message.role === 'user')
      const content = user?.content
      expect(Array.isArray(content)).toBe(true)
      if (!Array.isArray(content)) return

      const kinds = (content as readonly { type: string }[]).map((part) => part.type)
      expect(kinds).toContain('image_url')

      const wire = armedWithImagesOf(gateway.bodies[0] ?? '')
      expect(wire.text.indexOf('开头 @a.png')).toBeLessThan(wire.text.indexOf('〔')) // 图之前是那句话
      expect(wire.text).toContain('结尾')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('两张图各是各的字节（不串、不丢）', async () => {
    const stage = makeStage()
    try {
      // 第二张另造一份**不同的** PNG：改中间一个字节（**不动 IEND 那一块**——动了就不是
      // 一张完整的图了，材料那关会当场拒，用例就变成在考别的事）
      const other = new Uint8Array(PNG)
      other[40] = (other[40] ?? 0) ^ 0xff
      const first = putBytes(stage.workspace, '一.png', PNG)
      const second = putBytes(stage.workspace, '二.png', other)

      const gateway = realGateway()
      const { assembly, handle } = attach(stage, { modelGateway: gateway.make })

      await sendAndWait(handle, {
        text: '看 @一.png 和 @二.png',
        refs: [
          { kind: 'file', at: 2, marker: '@一.png', source: first },
          { kind: 'file', at: 11, marker: '@二.png', source: second },
        ],
      })

      const wire = armedWithImagesOf(gateway.bodies[0] ?? '')
      expect(wire.images).toHaveLength(2)
      expect([...(wire.images[0] ?? [])]).toEqual([...PNG])
      expect([...(wire.images[1] ?? [])]).toEqual([...other])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U37 · 删掉源文件、重开会话之后仍取得回', () => {
  test('/attachments 列得出 → 导出字节一致 → 再次送模还是那份字节', async () => {
    const stage = makeStage()
    const exported: string[] = []
    try {
      const path = putBytes(stage.workspace, '截图.png', PNG)
      // 真路径要在**删掉之前**取（下面要按它比对记录里那份出处）
      const realPath = realpathSync(path)
      const gateway = realGateway()

      // —— 第一次：送一次图 ——
      const first = attach(stage, { modelGateway: gateway.make })
      await sendAndWait(first.handle, {
        text: '看这张',
        refs: [{ kind: 'file', at: 0, marker: '@截图.png', source: path }],
      })
      const session = first.assembly.session
      if (session === undefined) throw new Error('首条消息之后该有会话了')
      first.assembly.close()

      // —— **把源文件删掉**（「源文件已删除」那一档）——
      rmSync(path)

      // —— 重开：同一个 dataDir / 工作区，显式接续那条会话 ——
      const reopened = attach(stage, { modelGateway: gateway.make, session })

      // ① 列得出（列表说的是**记录里那一份**，与盘上还在不在无关）
      reopened.handle.send({ type: 'attachments.list' })
      await waitIdle(reopened.handle, 0) // 不惊动主循环——只等答复
      const rows = attachmentsOf(reopened.handle)
      expect(rows).toHaveLength(1)
      expect(rows?.[0]?.name).toBe('截图.png')
      expect(rows?.[0]?.mime).toBe('image/png')
      expect(rows?.[0]?.bytes).toBe(PNG.length)
      // 出处照记（「从哪儿来的」答得上）——而取回**不依赖它**：下面那一步用的是 blob
      expect(rows?.[0]?.source).toBe(realPath)

      const row = rows?.[0]
      if (row === undefined) return

      // ② 导出原图：字节与当初那一份**逐字节一致**
      reopened.handle.send({ type: 'attachments.export', entry: row.entry })
      await new Promise((settle) => setTimeout(settle, 50))
      const note = noteOf(reopened.handle)
      expect(note).toContain('原图已导出 → ')

      const at = (note ?? '').replace('原图已导出 → ', '').trim()
      expect(readFileSync(at)).toEqual(Buffer.from(PNG))
      exported.push(at)

      // ③ 再次送模：用**记录里那份字节**（不回头找那个已经删掉的路径）
      const before = gateway.bodies.length
      await sendAndWait(reopened.handle, {
        text: '还是这张',
        refs: [
          {
            kind: 'image',
            at: 0,
            marker: '@截图.png',
            source: row.source,
            label: row.label,
            name: row.name,
            mime: row.mime,
            blob: row.blob,
          },
        ],
      })

      expect(gateway.bodies.length).toBe(before + 1)
      const wire = armedWithImagesOf(gateway.bodies.at(-1) ?? '')
      expect(wire.images).toHaveLength(1)
      expect([...(wire.images[0] ?? [])]).toEqual([...PNG])

      reopened.assembly.close()
    } finally {
      for (const at of exported) rmSync(at, { force: true })
      stage.dispose()
    }
  })
})

describe('U37 · 端点不认图（能力未知那一档）：如实报错，不假报成功', () => {
  test('端点上 400 ⇒ 一条模型错误报出来（不是「静默丢图、当文本发过去」）', async () => {
    const stage = makeStage()
    try {
      const path = putBytes(stage.workspace, '截图.png', PNG)
      const bodies: string[] = []

      // 一支**明确拒图**的端点：请求体里有 `image_url` 就 400（真供应商对文本模型的常见反应）
      const gateway = (stamper: EventStamper): ModelGateway =>
        createModelGateway({
          providerId: 'test',
          config: { baseURL: 'http://test.invalid/v1', model: 'test', apiKey: 'fake-test-key' },
          env: {},
          stamper,
          retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
          fetch: async (_input, init) => {
            const body = String(init?.body)
            bodies.push(body)
            if (body.includes('image_url')) {
              return new Response(JSON.stringify({ error: { message: 'this model does not support image input' } }), {
                status: 400,
                headers: { 'content-type': 'application/json' },
              })
            }

            return new Response(`${chunk('好的')}data: [DONE]\n\n`, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            })
          },
        })

      const { assembly, handle } = attach(stage, { modelGateway: gateway })
      await sendAndWait(handle, {
        text: '看这张',
        refs: [{ kind: 'file', at: 0, marker: '@截图.png', source: path }],
      })

      // ① 图**真发出去了**（不是悄悄换成纯文本）——那正是「不静默丢图」这一条
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toContain('image_url')

      // ② 失败**如实报出来**（一条模型错误 ＋ 那一轮以 error 收场）
      const errors = handle.events.filter((event) => event.kind === 'model.error')
      expect(errors.length).toBeGreaterThan(0)
      const ended = handle.events.filter((event) => event.kind === 'turn.end').at(-1)
      expect(ended?.kind === 'turn.end' && ended.data.reason).toBe('error')

      // ③ **保存的附件仍可取回**（设计：未知能力的实际请求失败如实报错，附件还在）
      handle.send({ type: 'attachments.list' })
      await new Promise((settle) => setTimeout(settle, 50))
      const rows = attachmentsOf(handle)
      expect(rows).toHaveLength(1)
      expect(rows?.[0]?.name).toBe('截图.png')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U37 · 坏文件与超限：不假报成功', () => {
  test('半截的图：这一条**不跑**，原稿还回输入区（且一个模型请求都没发）', async () => {
    const stage = makeStage()
    try {
      const cut = putBytes(stage.workspace, 'cut.png', PNG.subarray(0, PNG.length - 12))
      const gateway = realGateway()
      const { assembly, handle } = attach(stage, { modelGateway: gateway.make })

      await sendAndWait(handle, {
        text: '看这张',
        refs: [{ kind: 'file', at: 0, marker: '@cut.png', source: cut }],
        ref: 'draft-1',
      })

      // 一个请求都没发出去
      expect(gateway.bodies).toHaveLength(0)

      const settled = handle.events.find((event) => event.kind === 'input.settled')
      expect(settled?.kind === 'input.settled' && settled.data.ok).toBe(false)
      if (settled?.kind === 'input.settled') expect(settled.data.reason).toContain('没传完')

      // 也没落进会话（那句交代内核没接住）
      const rows = readDatabase(assembly.paths.database).entries.filter((entry) => entry.kind === 'user')
      expect(rows).toHaveLength(0)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('名字像图、内容不是图：按文本收（内容说了算），不谎称送了图', async () => {
    const stage = makeStage()
    try {
      const path = putBytes(stage.workspace, 'fake.png', new TextEncoder().encode('其实是文字'))
      const gateway = realGateway()
      const { assembly, handle } = attach(stage, { modelGateway: gateway.make })

      await sendAndWait(handle, {
        text: '看 @fake.png',
        refs: [{ kind: 'file', at: 2, marker: '@fake.png', source: path }],
      })

      const wire = armedWithImagesOf(gateway.bodies[0] ?? '')
      expect(wire.images).toHaveLength(0) // 没有图像部件
      expect(wire.text).toContain('其实是文字') // 但内容真送到了（当文本）

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
