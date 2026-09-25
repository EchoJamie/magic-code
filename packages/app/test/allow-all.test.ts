/**
 * U73 立 · **U76 改定** · **全放行**（装配根这一半）—— 端到端接线：**启动入参 → 真闸门**。
 *
 * 出处：`设计/工具执行与权限`·「全放行：**只在起会话那一刻给**」：
 *
 * > - **只能起会话时给**：命令行带一个参数起。**对话期间不许切进全放行**……
 * > - ⚠️ **它连必闸也放——真的什么都不问**（2026-09-25 用户定，**改过一次**）。
 *
 * 权限域自己的用例（`@magic/permission` 的 `allow-all.test.ts`）咬的是**那一刀本身**；
 * 这一份咬**接线**：`assemble({ allowAll })` 真的接进闸门了吗——跳了任何一跳，
 * 下面第一条就红。走**真装配 · 真工具 · 真闸门**，只有模型是替身。
 *
 * ⚠️ **U73 那一版「必闸照样弹」是旧版**：本文件当时钉的是那个形状，现在整条反过来钉
 * ——名单那两条（删除 · 改权限）**也不弹**。
 *
 * ⚠️ 还有一条谁也替不了的：全放行**是装配期入参、没有事后改它的口**。
 * 下面那条「它没有 setter」是**形状**上的事实——`Assembly` 上没有这个动词，
 * 而「对话期间切不进去」在代码里正是**这个形状**（不是一句纪律）。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent } from '@magic/contracts'
import type { Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage } from './support.ts'

/** 一条只读命令（机械分析判「轻」· `ops: ['read']`）——**不问**。 */
const LIGHT_TURN = { toolCalls: [{ name: 'exec', args: { cmd: 'echo hello-magic' } }] }
/** 一条**名单里**的命令（判重 · `delete` → 不可逆）——默认下照问，全放行下**也不问**。 */
const HEAVY_TURN = { toolCalls: [{ name: 'exec', args: { cmd: 'chmod 755 .' } }] }

/** 裸接控制面——订阅事件，要答复时自己答（同 `permission.test.ts` 那一手）。 */
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
    answer: (id: number) => assembly.shell.send({ type: 'decision.answer', id, decision: 'approve' }),
    dispose: off,
  }
}

async function until(test: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(10)
  }
}

describe('全放行 —— 启动入参真的接进闸门', () => {
  test('判轻的调用**不问**——工具照跑，裁决留痕（`decider: auto`）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({ allowAll: true, turns: [LIGHT_TURN, { text: '好' }] })
      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '跑一下' })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '工具跑完')
      shell.dispose()

      expect(eventsOfKind(shell.events, 'tool.decision.request')).toEqual([])
      const verdicts = eventsOfKind(shell.events, 'tool.decision')
      expect(verdicts.map((one) => [one.data.decision, one.data.decider])).toEqual([['approve', 'auto']])
      expect(eventsOfKind(shell.events, 'tool.result')[0]?.data.ok).toBe(true)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**名单里那一条也不弹**——工具真跑了，裁决留痕（`decider: auto`）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({ allowAll: true, turns: [HEAVY_TURN, { text: '好' }] })
      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '改一下权限' })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '工具跑完')
      shell.dispose()

      expect(eventsOfKind(shell.events, 'tool.decision.request')).toEqual([])
      expect(eventsOfKind(shell.events, 'tool.result')[0]?.data.ok).toBe(true)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**不给它时：判轻的照样不问、名单里那一条照问**——两档的差别就在那一条上', async () => {
    const stage = makeStage()

    try {
      // 只读：默认通（U76 起不必配规则也不问）
      const light = stage.assemble({ turns: [LIGHT_TURN, { text: '好' }] })
      const lightShell = bareShell(light)
      light.shell.send({ type: 'input.submit', text: '跑一下' })
      await until(() => eventsOfKind(lightShell.events, 'tool.result').length >= 1, '工具跑完')
      lightShell.dispose()
      expect(eventsOfKind(lightShell.events, 'tool.decision.request')).toEqual([])
      light.close()

      // 名单里那一条（改权限）：照问（卡挂着，没答之前一步都不跑）
      const heavy = stage.assemble({ turns: [HEAVY_TURN, { text: '好' }] })
      const heavyShell = bareShell(heavy)
      heavy.shell.send({ type: 'input.submit', text: '改一下权限' })
      await until(() => heavyShell.requests.length >= 1, '裁决请求')
      heavyShell.dispose()

      expect(eventsOfKind(heavyShell.events, 'tool.decision.request')[0]?.data.weight).toBe('heavy')
      expect(eventsOfKind(heavyShell.events, 'tool.decision.request')[0]?.data.material).toContain('改权限')
      expect(eventsOfKind(heavyShell.events, 'tool.result')).toEqual([]) // 没答之前没跑

      heavy.close()
    } finally {
      stage.dispose()
    }
  })

  /**
   * **删除那一类：全放行下也照拒**（U77 · 规划侧定）——**拒的理由是"这个命令不可逆"，
   * 不是"你该问我"**；而 `--allow-all` 只动「问不问」那一维，两件事不混。
   *
   * 装配级判三件：**不问**（这一档的承诺）· **也不放**（工具那一步压根没跑）·
   * **回执说得出该用什么**（`trash`——只拒不说，模型只会换着花样再试）。
   */
  test('**删除那一类：这一档下也照拒**——不问，但也不放（回执指路 `trash`）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({
        allowAll: true,
        turns: [{ toolCalls: [{ name: 'exec', args: { cmd: 'rm -rf build' } }] }, { text: '好' }],
      })
      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '删掉 build' })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '回填')

      expect(eventsOfKind(shell.events, 'tool.decision.request'), '这一档的承诺照旧：不问').toEqual([])

      const result = eventsOfKind(shell.events, 'tool.result')[0]
      expect(result?.data.ok, '照拒——工具那一步压根没跑').toBe(false)
      const output = (result?.data.output as { text?: string } | undefined)?.text ?? ''
      expect(output, '回执要说得出为什么').toContain('不可逆')
      expect(output, '回执要指路').toContain('trash')

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('全放行**是装配期入参**——`Assembly` 上没有改它的动词（「对话期间切不进去」的形状）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({ allowAll: true, turns: [{ text: '好' }] })

      // 「能中途切的，就等于模型能说服用户切、或误按就切」——故**没有那个口**：
      // 装配产物上任何带 allow/bypass/permission 字样的**动作**都不存在。
      // （参数位不是动作位：`assemble()` 收它，`Assembly` 本身不改它。）
      const verbs = Object.keys(assembly).filter((key) => typeof (assembly as never)[key as never] === 'function')
      expect(verbs.filter((key) => /allow|bypass|permission/i.test(key))).toEqual([])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
