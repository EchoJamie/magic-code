/**
 * U11 · **全链冒烟** —— 阶段 1 验证句：**交代一件事，它跑一条命令，记录里看得到全过程。**
 *
 * 一圈走完的真家伙：装配根（真配置加载 → 真记录库 → 真沙箱 → 真闸门 → 真工具域 →
 * 真对话域 → 真控制域）＋ **脚本化的假外壳**（`attachShell`——订阅 `shell.subscribe`、
 * 发 `shell.send`）。**只有模型是替身**（Faux——不碰网络、不要 key）。
 *
 * 判据四条：
 * 1. **链走通**——交代 → 模型 → 工具（**经闸门**）→ 回填 → 收束；
 * 2. **落库**——持久类事件与条目都在库里，**瞬时类不在**（`TRANSIENT_EVENT_KINDS`）；
 * 3. **记录可直读**——关库后拿裸 `bun:sqlite` 打开文件，全过程看得见（不经 API 回读）；
 * 4. **裁决配对**——答复按**请求事件** id 回来（不是 `call`——两个 id 空间）。
 */

import { describe, expect, test } from 'bun:test'

import { attachShell } from '../src/index.ts'
import type { KernelEvent } from '@magic/contracts'
import type { FauxTurn } from '@magic/faux'
import { eventsOfKind, makeStage, readDatabase } from './support.ts'

/**
 * 冒烟剧本（U76 起**本文件自带一份**，不再用 `support.ts` 的 `SMOKE_TURNS`）。
 *
 * ⚠️ **原锚**：`exec echo hello-magic`（判轻）；**为何变**：U76 起**判轻的不再问**
 * （默认通——「经闸门」那一段只在 `tool.decision` 上记一条 `decider: 'auto'`），
 * 拿它当夹具，`tool.decision.request` 根本不会出现，「链走通」与「拒绝路径」两支
 * 要判的那件事（请求 → 答复 → 回填）就没有对象；**U76 的新锚**：`rm -rf build && echo hello-magic`
 * ——第一段是**名单里**的删除（必问），第二段把 `hello-magic` 那串输出原样留着。
 *
 * ⚠️ **U77 又换了一次锚**：删除那一类改成**直接拒**（不问），故那条 `rm` **造不出卡**了
 * ——第一段换成 `chmod 755 .`（名单里剩下的那一条，照旧必问），第二段一字不动
 * ⇒ 下面「输出落库 / 回填送达」那几条判据的锚**照旧一个字不用换**。
 *
 * （`support.ts` 的 `SMOKE_TURNS` 仍留在原处：那是**判轻不问**那一形的现成夹具，
 * 别的用例若要它，拿默认那份即可——本文件要的是「有卡」那一形，故自带。）
 */
const GATED_TURNS: readonly FauxTurn[] = [
  {
    toolCalls: [{ name: 'exec', args: { cmd: 'chmod 755 . && echo hello-magic' } }],
    usage: { inputTokens: 11, outputTokens: 3 },
  },
  { text: '跑完了', usage: { inputTokens: 21, outputTokens: 7 } },
]

describe('全链冒烟（Faux 模型 ＋ 真沙箱 / 真闸门 / 真记录 / 真控制）', () => {

  test('拒绝路径——被拒的调用不执行，以「拒绝」回填', async () => {
    const stage = makeStage()

    try {
      // 夹具同上：**名单里**的命令才有卡可拒（U76 起判轻的不问，见 `GATED_TURNS`）
      const assembly = stage.assemble({ turns: GATED_TURNS })
      const shell = attachShell(assembly.shell, { decide: () => 'reject' })

      await shell.submit('清一下构建目录，再回显一句')
      shell.dispose()
      assembly.close()

      const events = shell.events
      expect(eventsOfKind(events, 'tool.decision').map((e) => e.data.decision)).toEqual(['reject'])
      // 问过、答过、结果照发（拒绝也是一种结果——回填不能断）
      expect(eventsOfKind(events, 'tool.result')).toHaveLength(1)

      const raw = readDatabase(assembly.paths.database)
      try {
        // 拒绝的裁决**只走事件、不入条目**；工具结果条目仍在（模型要知道「没跑」）
        expect(raw.entries.map((row) => row.kind)).toContain('tool-result')
        const payload = JSON.parse(
          raw.entries.find((row) => row.kind === 'tool-result')?.payload ?? '{}',
        ) as { ok: boolean }
        expect(payload.ok).toBe(false)
      } finally {
        raw.close()
      }
    } finally {
      stage.dispose()
    }
  })

  test('中断路径——在途打断，本轮以「中止」收束、回到等待输入', async () => {
    const stage = makeStage()

    const PIECES = ['一', '二', '三', '四', '五', '六'] as const

    try {
      // 每步留窗口（10ms × 6 段），好让中断真赶在收束之前——不然验的是「跑完才停」
      const assembly = stage.assemble({ turns: [{ text: [...PIECES] }], stepDelayMs: 10 })
      const shell = attachShell(assembly.shell)

      const submitted = shell.submit('说点什么')
      await shell.until((event: KernelEvent) => event.kind === 'model.delta')
      shell.send({ type: 'turn.interrupt' })
      // 中断后仍回到等待输入——`submit` 照常收束（不是挂死，也不是抛）
      await submitted

      shell.dispose()
      assembly.close()

      const events = shell.events
      expect(eventsOfKind(events, 'turn.end').at(-1)?.data.reason).toBe('aborted')
      // 中断**不是**模型错误——不产 `model.error`
      expect(eventsOfKind(events, 'model.error')).toHaveLength(0)
      // 回到等待输入
      expect(eventsOfKind(events, 'agent.state').at(-1)?.data.state).toBe('waiting')
      // **当场的停**（不是跑完才停）：增量没走满脚本段数
      expect(eventsOfKind(events, 'model.delta').length).toBeLessThan(PIECES.length)
    } finally {
      stage.dispose()
    }
  })
})
