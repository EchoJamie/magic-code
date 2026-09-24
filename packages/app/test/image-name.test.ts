/**
 * U62 · **图片的名字**（`Image#N`）—— 真装配那一半。
 *
 * 判据就是工单的完成出口（`交接/工单/U62.md` · 设计 · 文件与图片「图片的身份与名字」）：
 *
 * - **身份＝内容**（字节的 sha256）——不靠名字、不靠路径。故这里拿**盘上真字节**去比：
 *   同一个身份就是 `blobs/` 里那一个文件的名字（`records/blobs.ts` 本来就是内容寻址）；
 * - **名字＝一段输入内的编号**（`Image#N`）——它在**稿子**那一侧编（`packages/tui` 的
 *   `spec.u62.test.ts` 走按键验），本文件验的是它**接得上**的那两处：
 *   ① 选定那一条问得出**内容身份**（`paths.identify` → `paths.identified`）；
 *   ② 那个身份**真的进了出站请求体**（模型看到的正文写的是编号，抬头也是同一个编号）。
 *
 * 沙地由 `makeStage` 落在唯一临时目录里（不碰真东西）。
 */

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventStamper, InputRef, KernelEvent, ModelGateway } from '@magic/contracts'
import { createModelGateway } from '@magic/model'
import { attachShell } from '../src/index.ts'
import type { ShellHandle } from '@magic/app'
import { makeStage, type Stage } from './support.ts'

/** 1×1 真 PNG（67 字节）——「用户交上来的那张报错截图」。 */
const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

/**
 * 另一张**内容不同、但一样是完整的图**（同样是 1×1 的真 PNG，像素是蓝的）。
 *
 * ⚠️ **不能靠改几个字节凑一张「不同的图」**：`checkImageIntact` 会当场认出那不是一张
 * 完整的图（CRC 对不上），答复里就没有 `image` 那一格——验的就不是命名而是完整性了。
 */
const OTHER = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==',
    'base64',
  ),
)

function putBytes(root: string, relative: string, bytes: Uint8Array): string {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

/** 等**第 `count` 条**同 kind 的事件（数着等——同一条命令问两次，答复长得一模一样）。 */
function waitCount<K extends KernelEvent['kind']>(
  handle: ShellHandle,
  kind: K,
  count: number,
): Promise<Extract<KernelEvent, { kind: K }>> {
  const all = (): readonly Extract<KernelEvent, { kind: K }>[] =>
    handle.events.filter((event): event is Extract<KernelEvent, { kind: K }> => event.kind === kind)

  return new Promise((settle) => {
    const soon = all()[count - 1]
    if (soon !== undefined) {
      settle(soon)
      return
    }

    const watch = setInterval(() => {
      const found = all()[count - 1]
      if (found === undefined) return
      clearInterval(watch)
      settle(found)
    }, 5)
  })
}

/** 问一次「选定的这一条是什么」，等这一趟的答复（数着等，不拿上一趟的顶上）。 */
function identify(handle: ShellHandle, path: string): Promise<Extract<KernelEvent, { kind: 'paths.identified' }>> {
  const before = handle.events.filter((event) => event.kind === 'paths.identified').length
  handle.send({ type: 'paths.identify', path })

  return waitCount(handle, 'paths.identified', before + 1)
}

function waitIdle(handle: ShellHandle, times: number): Promise<void> {
  return new Promise((settle) => {
    const watch = setInterval(() => {
      const idle = handle.events.filter(
        (event) => event.kind === 'agent.state' && event.data.state === 'waiting',
      )
      if (idle.length < times) return
      clearInterval(watch)
      settle()
    }, 5)
  })
}

/** 一支真网关 ＋ 注入 fetch——出站请求体留在闭包里。 */
function realGateway(): { readonly make: (stamper: EventStamper) => ModelGateway; readonly bodies: string[] } {
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
        return new Response(
          `data: ${JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test',
            choices: [{ index: 0, delta: { content: '好的' }, finish_reason: null }],
          })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })

  return { make, bodies }
}

/** 一次出站请求体里最后那条用户消息的正文（拼起来的那一段文字）。 */
function userTextOf(body: string): string {
  const parsed = JSON.parse(body) as { messages: readonly { role: string; content: unknown }[] }
  const user = [...parsed.messages].reverse().find((message) => message.role === 'user')
  const content = user?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return (content as readonly Record<string, unknown>[])
    .filter((part) => part['type'] === 'text')
    .map((part) => String(part['text']))
    .join('')
}

function attach(stage: Stage, options: Parameters<Stage['assemble']>[0] = {}) {
  const assembly = stage.assemble(options)
  return { assembly, handle: attachShell(assembly.shell) }
}

// ═══════════════════════════════════════════════════════════════════════

describe('U62 · 选定那一条 ⇒ 认得出内容身份', () => {
  test('一张图：答复里给的是**按字节认出来**的那几格，身份＝字节的 sha256', async () => {
    const stage = makeStage()
    try {
      const path = putBytes(stage.workspace, '报错.png', PNG)
      const { assembly, handle } = attach(stage)

      const said = await identify(handle, path)

      expect(said.data.path).toBe(path) // 原样回声（外壳据它认领那一处引用）
      expect(said.data.image?.mime).toBe('image/png')
      expect(said.data.image?.name).toBe('报错.png')
      expect(said.data.image?.bytes).toBe(PNG.length)
      // **身份就是内容**——拿字节自己算一遍 sha256，与答复里那串**逐字相同**
      expect(said.data.image?.blob).toBe(createHash('sha256').update(PNG).digest('hex'))
      // 也是 blob 落点里的那一个名字（内容寻址：同内容只落一份）
      expect(existsSync(join(stage.dataDir, 'blobs', said.data.image?.blob ?? ''))).toBe(true)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('普通文本文件：**没有**那几格（那一处照旧是 `@路径`）', async () => {
    const stage = makeStage()
    try {
      const path = putBytes(stage.workspace, '说明.md', new TextEncoder().encode('# 说明\n'))
      const { assembly, handle } = attach(stage)

      const said = await identify(handle, path)

      expect(said.data.path).toBe(path)
      expect(said.data.image).toBeUndefined()

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**同一份内容**：换个路径挑（复制一份）⇒ 还是同一个身份（同内容只落一份）', async () => {
    const stage = makeStage()
    try {
      const first = putBytes(stage.workspace, 'a/报错.png', PNG)
      const second = putBytes(stage.workspace, 'b/报错.png', PNG)
      const { assembly, handle } = attach(stage)

      const one = await identify(handle, first)
      const two = await identify(handle, second)

      // 名同、目录不同、内容相同 ⇒ **身份相同**（名字不是身份，路径也不是）
      expect(two.data.image?.name).toBe(one.data.image?.name)
      expect(two.data.image?.blob).toBe(one.data.image?.blob)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**同名但内容不同**的两张 ⇒ 身份分得开（这正是文件名当身份时的那个坑）', async () => {
    const stage = makeStage()
    try {
      const first = putBytes(stage.workspace, 'a/报错.png', PNG)
      const second = putBytes(stage.workspace, 'b/报错.png', OTHER)
      const { assembly, handle } = attach(stage)

      const one = await identify(handle, first)
      const two = await identify(handle, second)

      // 名同、目录不同、内容也不同 ⇒ 身份**必须**分得开
      expect(two.data.image?.name).toBe(one.data.image?.name)
      expect(two.data.image?.blob).not.toBe(one.data.image?.blob)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('读不了的（不在了）⇒ 也只是一句「没认出图」，不炸、不报错给屏', async () => {
    const stage = makeStage()
    try {
      const { assembly, handle } = attach(stage)

      const said = await identify(handle, join(stage.workspace, '从来就没有.png'))

      expect(said.data.image).toBeUndefined()

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U62 · 那个身份真的进了出站请求体', () => {
  test('选定之后交出去：正文里是编号，抬头也是同一个编号', async () => {
    const stage = makeStage()
    try {
      const path = putBytes(stage.workspace, '报错.png', PNG)
      const gateway = realGateway()
      const { assembly, handle } = attach(stage, { modelGateway: gateway.make })

      const said = await identify(handle, path)
      const image = said.data.image
      expect(image).toBeDefined()
      if (image === undefined) return

      // 外壳把那一处写成什么由它自己定（见 `spec.u62.test.ts`）；这里走的是**它交出去的那一份**
      const wire: InputRef = {
        kind: 'image',
        at: 4,
        marker: 'Image#1',
        source: path,
        label: image.label,
        name: image.name,
        mime: image.mime,
        blob: image.blob,
      }

      handle.send({ type: 'input.submit', text: '看 Image#1', ref: 'draft-1', refs: [wire] })
      await waitIdle(handle, 1)

      const text = userTextOf(gateway.bodies[0] ?? '')
      // 正文那一段就是那个编号；抬头**说的是同一个名字**（图不一定来自文件，名字不是文件名）
      expect(text).toContain('看 Image#1')
      expect(text).toContain('〔本次材料 · 图片 Image#1（来源')
      expect(text).toContain('〔图片完 · Image#1〕')
      // 文件名退到「来源」那一格——它是出处，不是这份材料叫什么
      expect(text).not.toContain('图片 报错.png')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
