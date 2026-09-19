/**
 * 第 15 轮 · 阶段 2 波次 1 —— **端到端接线**的判据（装配根 × 权限域）。
 *
 * 两件都是「光看域内测试看不出来」的事：
 * - **`permissions.rules` 真的接进闸门了**吗——配置 → `parseRules` → `createPermissionGate`；
 *   接没接上，只有从装配跑一遍才看得见（权限域自己的测试注入的是现成规则数组）。
 * - **「总是允许」整条链通了吗**——外壳答复带 `remember` → 控制域原样转手 →
 *   装配递给闸门 → 会话级记忆生效（同类第二次不再问）。任何一跳断了，下面第二个用例就红。
 *
 * 走**真配置加载器**（`makeStage` 里的 `loadConfig`）与**真闸门**——只有模型是替身。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent } from '@magic/contracts'
import type { Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage } from './support.ts'

/** 一条只读命令（机械分析判「轻」、`ops: ['read']`）——规则与会话记忆都从它身上验。 */
const READ_ONLY_TURN = { toolCalls: [{ name: 'exec', args: { cmd: 'echo hello-magic' } }] }

/**
 * 裸接控制面——订阅事件 ＋ **按需答复**。
 *
 * 不用 `attachShell`：它收到询问**当场自动批准**（验收装置的方便），答复那个窗口抓不住，
 * 「带不带 `remember`」也就无从谈起。这里要的正是那个窗口。
 */
function bareShell(assembly: Assembly) {
  const events: KernelEvent[] = []
  const requests: number[] = []

  const off = assembly.shell.subscribe((event) => {
    events.push(event)
    if (event.kind === 'tool.decision.request') requests.push(event.id)
  })

  return {
    events,
    requests,
    /** 答复一次询问——`remember` 给了就带上（与外壳按「总是允许」时发的**同一条消息**）。 */
    answer(id: number, opts?: { remember?: boolean }): void {
      assembly.shell.send({ type: 'decision.answer', id, decision: 'approve', ...opts })
    },
    dispose: off,
  }
}

/** 等条件成立（轮询——域是异步的，测试别假设时序）。 */
async function until(test: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(10)
  }
}

describe('权限规则 —— 配置真的接进闸门', () => {
  test('命中即自动放行——不问、裁者是 `auto`', async () => {
    const stage = makeStage({ config: { permissions: { rules: [{ tool: 'exec', op: 'read' }] } } })

    try {
      const assembly = stage.assemble({ turns: [READ_ONLY_TURN, { text: '好' }] })

      // 装配侧先自证：规则经 `parseRules` 落了地（没被拒、条数对）
      expect(assembly.permissionRules).toEqual([{ tool: 'exec', op: 'read' }])
      expect(assembly.rejectedRules).toEqual([])

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '跑一下' })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '工具跑完')
      shell.dispose()

      // 规则命中 ⇒ **闸门没问**（没有询问事件，自然也没有答复）
      expect(eventsOfKind(shell.events, 'tool.decision.request')).toEqual([])
      // 但裁决**照样留痕**——自动放行不是「没发生裁决」，是裁者是 `auto`
      const verdicts = eventsOfKind(shell.events, 'tool.decision')
      expect(verdicts.map((v) => [v.data.decision, v.data.decider])).toEqual([['approve', 'auto']])
      expect(eventsOfKind(shell.events, 'tool.result')[0]?.data.ok).toBe(true)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('键缺省 ＝ 无规则 ＝ 一律问（阶段 1 姿态；不接线也能跑）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({ turns: [READ_ONLY_TURN, { text: '好' }] })
      expect(assembly.permissionRules).toEqual([])

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '跑一下' })
      await until(() => shell.requests.length >= 1, '闸门问起')

      expect(shell.requests).toHaveLength(1)
      shell.answer(shell.requests[0] ?? -1)
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '工具跑完')
      shell.dispose()

      expect(eventsOfKind(shell.events, 'tool.decision')[0]?.data.decider).toBe('user')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('被拒的规则条目**交回装配**（不静默丢弃——读不懂就不生效）', () => {
    const stage = makeStage({
      config: { permissions: { rules: [{ tool: 'exec', op: 'read' }, { tool: 'exec', pth: '/w' }] } },
    })

    try {
      const assembly = stage.assemble()

      expect(assembly.permissionRules).toEqual([{ tool: 'exec', op: 'read' }])
      expect(assembly.rejectedRules).toHaveLength(1)
      expect(assembly.rejectedRules[0]?.index).toBe(1) // 第 2 条（0 起）
      expect(assembly.rejectedRules[0]?.reason).toContain('pth')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('「总是允许」——全链（外壳答复 → 控制域 → 装配 → 授权账本）', () => {
  /**
   * ⚠️ **原锚**：「会话级记忆生效」——`a` 凝出的规则活在闸门实例里（新会话即清零）。
   * **为何变**：`U22` 把授权的落点改到**工作区**（技术方案 · 权限「授权的落点」：
   * 会话不是信任的边界）；闸门里那本账换成了注入的**工作区级账本**。
   * **新锚**：同一条链（答复带 `remember` → 控制域转手 → 装配 → 闸门）**仍然通**，
   * 只是记的地方跟着换——跨会话存活那一条在 `grants.test.ts` 里钉。
   */
  test('答复带 `remember`：同类**第二次不再问**（授权落进工作区级账本）', async () => {
    const stage = makeStage()

    try {
      // 同一轮里两次**一模一样**的只读调用：第一次要问，第二次该被记忆挡下
      const assembly = stage.assemble({ turns: [READ_ONLY_TURN, READ_ONLY_TURN, { text: '都跑完了' }] })
      const shell = bareShell(assembly)

      assembly.shell.send({ type: 'input.submit', text: '同样的命令跑两遍' })

      await until(() => shell.requests.length >= 1, '第一次询问')
      expect(shell.requests).toHaveLength(1)

      // 外壳按「总是允许」时发的正是这一条（批准 ＋ remember 位）
      shell.answer(shell.requests[0] ?? -1, { remember: true })

      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 2, '两次都跑完')
      shell.dispose()

      // 关键判据：**只问了那一次**——第二次没有再冒询问
      expect(shell.requests).toHaveLength(1)

      const verdicts = eventsOfKind(shell.events, 'tool.decision')
      expect(verdicts.map((v) => v.data.decider)).toEqual(['user', 'auto'])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('不给 `remember` ＝ 一次性——同类第二次**照问**（向后兼容）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({ turns: [READ_ONLY_TURN, READ_ONLY_TURN, { text: '都跑完了' }] })
      const shell = bareShell(assembly)

      assembly.shell.send({ type: 'input.submit', text: '同样的命令跑两遍' })

      await until(() => shell.requests.length >= 1, '第一次询问')
      shell.answer(shell.requests[0] ?? -1) // 与阶段 1 逐字同义的答复

      await until(() => shell.requests.length >= 2, '第二次仍然问起')
      expect(shell.requests).toHaveLength(2)
      shell.answer(shell.requests[1] ?? -1)

      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 2, '两次都跑完')
      shell.dispose()

      expect(eventsOfKind(shell.events, 'tool.decision').map((v) => v.data.decider)).toEqual([
        'user',
        'user',
      ])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
