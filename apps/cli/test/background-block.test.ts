/**
 * U89 · **「还在跑的后台命令」进那个每回合重建的块** —— 全链（工单 ①–⑤）。
 *
 * 真家伙一圈（真装配 → 真沙箱 → 真闸门 → 真工具域 → 真对话域 → 真记录库），
 * **只有模型是替身**。判据全落在**发给模型的请求体**上（那一块在系统提示里，
 * 屏上看不见——见回报里那一句「物证是哪一种」）：
 *
 * | 工单 | 咬什么 |
 * | --- | --- |
 * | ① | 起一条 ⇒ **下一趟请求**的系统提示里有它（编号 · 命令 · 还在跑） |
 * | ② | 它跑完 ⇒ **再下一趟就没有了**（不是还在列着） |
 * | ③ ⚠️ | 一条后台任务都没有 ⇒ 那一块**不出现**（不钉空话） |
 * | ④ ⚠️ | 换了条会话 ⇒ A 会话的在跑命令**不进 B 会话的请求**；切回 A 还看得见 |
 * | ⑤ | 它**不进记录**（条目里一个字都没有）· **每请求重算**（压缩碰不到它） |
 *
 * ⚠️ **两处装置上的坑，先记在这儿**：
 *
 * - **留痕是「一条会话链一份」**：`open(session)` 每次都按会话新造一个替身网关
 *   （`AssembleOptions.modelGateway` 是工厂），故 `stage.models` 上**一条链一个**——
 *   多会话那一支必须取**该链自己**那一个（`gatewayAt`），不能拿最后那个当全局流水。
 * - **脚本体也是「一条链一份」**：新链从头吃脚本——故多会话那一支的脚本写成
 *   **重放无害**的样子（每链头一段都起同一条后台命令，各是各的 `bg-N`）。
 * - ⚠️ **用例红了也得把手上的后台命令收干净**（`reapBackground`）：`stage.dispose()` 只删
 *   临时目录，**留在系统上的进程它管不着**——判据红在半路时，收尾那几行压根跑不到，
 *   于是留下一窝孤儿（本单反向验证时就撞上过两个 `sleep`，按 PID 收了）。
 */

import { describe, expect, test } from 'bun:test'
import type { FauxTurn } from '@magic/faux'
import type { ModelMessage } from '@magic/contracts'
import { attachShell } from '../src/index.ts'

import { eventsOfKind, lastModel, makeStage } from './support.ts'

/** 那一块的标题（`prompt/assembly.ts` 的 `BACKGROUND_HEADING`）——按它认「块在不在」。 */
const HEADING = '## 还在跑的后台命令'

/** 等到条件成立（或超时）——「跑完那一声」是**内核自己**起的轮，得等。 */
async function until(probe: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !probe()) await Bun.sleep(10)
  if (!probe()) throw new Error('等不到那一下——超时了')
}

/** 迄今为止每一趟请求的**系统提示**（按调用序）——这一块只住在这儿。 */
function systemsAt(stage: ReturnType<typeof makeStage>): string[] {
  return systemsOf(lastModel(stage))
}

/** 同上的取法，但网关显式给（多会话那一支：一条链一个替身，得指名道姓）。 */
function systemsOf(gateway: { readonly requests: readonly { readonly messages: readonly ModelMessage[] }[] }): string[] {
  return gateway.requests.map((request) => {
    const first: ModelMessage | undefined = request.messages[0]
    return first !== undefined && first.role === 'system' && typeof first.content === 'string'
      ? first.content
      : ''
  })
}

describe('③ 反面：一条后台任务都没有 ⇒ 那一块不出现', () => {
  test('普通两轮：每一趟请求都没有那一块，也没有一句「没有后台任务」的空话', async () => {
    const stage = makeStage()

    try {
      const turns: readonly FauxTurn[] = [{ text: '甲答第1句' }, { text: '甲答第2句' }]
      const assembly = stage.assemble({ turns })
      const shell = attachShell(assembly.shell)

      await shell.submit('第一件事')
      await shell.submit('第二件事')
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= 2)

      const systems = systemsAt(stage)
      expect(systems.length).toBe(2)
      for (const system of systems) {
        expect(system).not.toContain(HEADING)
        // ⚠️ 也不钉一句空话——「当前没有后台任务」那种占位一个字都没有
        expect(system).not.toContain('当前没有后台任务')
      }

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
