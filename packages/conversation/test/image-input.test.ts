/**
 * U37 · 图片与模型能力 —— 判据：**明确不支持就整条不跑** · **不知道就照发**。
 *
 * 这一层咬的是**发出去之前那一道闸**（设计 · 文件与图片：「模型明确不支持图像时保留输入，
 * 提示换模型或移除图片，**不能静默丢图发文字**」；「未知能力的实际请求失败如实报错」）。
 *
 * 三态各考一条（探针的返回值就是这三态）：
 * - `false` —— **明确不支持** ⇒ `rejected`：不落 `user` 条目 · 不进请求 · 说得出为什么；
 * - `true` —— 支持 ⇒ 照常跑；
 * - `undefined`（不给探针）——**不知道** ⇒ 照常跑（未知**不冒充**「不支持」）。
 *
 * 「图到底进没进请求」在本文件只验到 `ModelRequest`（内核侧形态）；**出站请求体**那一层
 * 在 `@magic/model` 的用例里（那边才有真 HTTP 体的形状），端到端在 `packages/app/test/`。
 */

import { describe, expect, test } from 'bun:test'
import type { MaterialLoad, Materials } from '@magic/contracts'
import { agentLoop } from '../src/agent-loop.ts'
import type { InputOutcome, LoopRuntime } from '../src/agent-loop.ts'
import { createRefDelivery } from '../src/refs.ts'
import { makeLoopRuntime, makeStage } from './support/harness.ts'
import type { Stage } from './support/harness.ts'

/** 1×1 真 PNG——这里当「用户选的那张图」（本文件不判完整性，那在执行域）。 */
const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

/** 固定给一张图的材料面。 */
function imageMaterials(): Materials {
  return {
    load: async (requests): Promise<MaterialLoad> => ({
      ok: true,
      materials: requests.map((request) => ({
        kind: 'image' as const,
        path: request.source,
        label: 'shot.png',
        name: 'shot.png',
        mime: 'image/png',
        bytes: PNG,
      })),
    }),
    candidates: async () => ({ rows: [] }),
  }
}

const IMAGE_REF = { kind: 'file' as const, at: 2, marker: '@shot.png', source: '/ws/shot.png' }

/** 一条**带图**的交代——三态用例共用这一份开场白。 */
function runWithImage(
  stage: Stage,
  acceptsImages: (() => boolean | undefined) | undefined,
): Promise<InputOutcome> {
  const runtime: LoopRuntime = makeLoopRuntime(stage, {
    refs: createRefDelivery({ materials: imageMaterials(), blobs: stage.records.blobs }),
    ...(acceptsImages === undefined ? {} : { acceptsImages }),
  })

  return agentLoop(runtime, { text: '看 @shot.png', refs: [IMAGE_REF] }, new AbortController().signal)
}

describe('U37 · 图片与当前模型对不对得上', () => {
  test('**明确不支持** ⇒ 整条不跑：不落用户条目 · 不进请求 · 说得清为什么、怎么办', async () => {
    const stage = makeStage({ turns: [{ text: '看图说话' }] })

    expect(await runWithImage(stage, () => false)).toBe('rejected')

    // ① 没进会话（那句话内核没接住——不落 `user` 条目）
    expect(stage.records.entries.filter((entry) => entry.kind === 'user')).toHaveLength(0)
    // ② 一个模型请求都没发
    expect(stage.gateway.requests).toHaveLength(0)

    // ③ 缘由说得出「哪几张、两条出路」
    const settled = stage.sink.events.find((event) => event.kind === 'input.settled')
    expect(settled?.kind).toBe('input.settled')
    if (settled?.kind !== 'input.settled') return
    expect(settled.data.ok).toBe(false)
    expect(settled.data.reason).toContain('shot.png')
    expect(settled.data.reason).toContain('不支持图片')
    expect(settled.data.reason).toContain('换一个支持看图的模型')
  })

  test('**支持** ⇒ 照常跑，图跟着进请求', async () => {
    const stage = makeStage({ turns: [{ text: '看图说话' }] })

    expect(await runWithImage(stage, () => true)).toBe('settled')
    expect(stage.gateway.requests).toHaveLength(1)

    const user = stage.gateway.requests[0]?.messages.find((message) => message.role === 'user')
    expect(Array.isArray(user?.content)).toBe(true)
    if (!Array.isArray(user?.content)) return

    const image = user.content.find((part) => part.type === 'image')
    expect(image?.type === 'image' && image.mime).toBe('image/png')
  })

  test('**不知道**（没有探针）⇒ 照发——未知不冒充「不支持」', async () => {
    const stage = makeStage({ turns: [{ text: '看图说话' }] })

    expect(await runWithImage(stage, undefined)).toBe('settled')
    expect(stage.gateway.requests).toHaveLength(1)
  })

  test('纯文字交代**不惊动**这道闸（探针说「不支持」也照跑）', async () => {
    const stage = makeStage({ turns: [{ text: '好' }] })
    const outcome = await agentLoop(
      makeLoopRuntime(stage, { acceptsImages: () => false }),
      { text: '就一句话' },
      new AbortController().signal,
    )

    expect(outcome).toBe('settled')
    expect(stage.gateway.requests).toHaveLength(1)
  })
})
