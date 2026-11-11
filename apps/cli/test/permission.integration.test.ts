/**
 * 端到端接线判据（装配根 × 权限域）——U129：**默认放行 ＋ 禁止清单照拒**。
 *
 * 要咬的只有一件事：**闸门真的接在装配里**。光看域内测试看不出来——权限域自己的
 * 测试直接调 `decide`；这里从真配置加载器与装配跑一遍，看的是整条链：
 * 工具调用进闸门 → `tool.decision` 落痕 → 放行的真跑、拒的压根不跑。
 *
 * 走**真配置加载器**（`makeStage` 里的 `loadConfig`）与**真闸门**——只有模型是替身。
 *
 * ## U129 之后的口径
 *
 * 不再产生人工询问（没有询问事件、也没有答复命令）：
 * - 判轻的（只读）与不在禁止清单里的（改权限）**一律放行**，裁者 `auto`；
 * - 删除那一族（`rm` / `shred` / `srm`）**直接拒**，裁者 `kernel`，回执指路 `trash`。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent } from '@magic/contracts'
import type { Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage } from './support.ts'

/** 一条只读命令（机械分析判轻）——默认通。 */
const READ_ONLY_TURN = { toolCalls: [{ name: 'exec', args: { cmd: 'echo hello-magic' } }] }

/**
 * 不在禁止清单里的写操作（改权限）——U129 起同样**默认通**，不再弹卡。
 *
 * 用 `chmod 755 .`（工作区目录本身）是装置上的讲究：它一定存在 ⇒ 命令跑得成
 * （`ok: true`），而 `755` 保留属主的 `rwx` ⇒ 不把后面几步走出毛病来。
 */
const PERMISSION_TURN = { toolCalls: [{ name: 'exec', args: { cmd: 'chmod 755 .' } }] }

/** **删除那一族**——U129 起**直接拒**（不问、也没有卡），回执里指路 `trash`。 */
const REFUSED_TURN = { toolCalls: [{ name: 'exec', args: { cmd: 'rm -rf build' } }] }

/** 裸接控制面——只订阅事件（U129 起没有要答复的窗口）。 */
function bareShell(assembly: Assembly) {
  const events: KernelEvent[] = []
  const off = assembly.shell.subscribe((event) => events.push(event))

  return {
    events,
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

/**
 * 等这一轮**收束**（回到等待输入）——收尾前要等它：`agent.state{waiting}` 是这一轮
 * **最后**一条事件，它之前落下来的都还在路上；那时 `close()` 会让尾部的落账打进
 * 已经关掉的库（实测：报错落在下一条用例头上）。
 */
async function untilSettled(shell: { readonly events: readonly KernelEvent[] }): Promise<void> {
  await until(
    () => eventsOfKind(shell.events, 'agent.state').some((event) => event.data.state === 'waiting'),
    '这一轮收束（回到等待输入）',
    20_000,
  )
}

describe('默认放行 —— 装配真的接上了闸门', () => {
  test('判轻的不问、改权限不问、删除照拒', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({
        turns: [READ_ONLY_TURN, PERMISSION_TURN, REFUSED_TURN, { text: '完了' }],
      })

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '跑三下' })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 3, '三发都落定')

      // 三发各留各的痕：前两发默认放行（`auto`）、删除那一条被内核拒（`kernel`）
      expect(eventsOfKind(shell.events, 'tool.decision').map((v) => [v.data.decision, v.data.decider])).toEqual([
        ['approve', 'auto'], // 只读：默认放行
        ['approve', 'auto'], // 改权限：不在禁止清单里，同样默认放行
        ['reject', 'kernel'], // 删除：没问就**拒**
      ])

      const results = eventsOfKind(shell.events, 'tool.result')
      expect(results[0]?.data.ok, '只读那一条真跑了').toBe(true)
      expect(results[1]?.data.ok, '改权限那一条真跑了').toBe(true)
      expect(results[2]?.data.ok, '删除那一条：**被拒、压根没跑**').toBe(false)
      const refusedText = (results[2]?.data.output as { text?: string } | undefined)?.text ?? ''
      expect(refusedText, '回执要说得出为什么').toContain('不可逆')
      expect(refusedText, '回执要指路').toContain('trash')

      await untilSettled(shell)
      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
