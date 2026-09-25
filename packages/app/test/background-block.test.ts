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
import type { BackgroundRuns, ModelMessage } from '@magic/contracts'
import { attachShell } from '../src/index.ts'
import type { ShellHandle } from '../src/shell.ts'
import { eventsOfKind, lastModel, makeStage, readDatabase } from './support.ts'

/** 那一块的标题（`prompt/assembly.ts` 的 `BACKGROUND_HEADING`）——按它认「块在不在」。 */
const HEADING = '## 还在跑的后台命令'

/** 后台命令吐的那一行——回读输出与命令正文都按它认。 */
const MARK = 'BG_BLOCK_MARK'

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

/** 那一块里的一行（`- 〔bg-N〕…`）——按编号找，免得挑到系统提示别处的条目行。 */
function blockLine(system: string, id: string): string | undefined {
  return system.split('\n').find((one) => one.startsWith(`- 〔${id}〕`))
}

/** 一条模型消息的正文（判别联合：`role:'tool'` 那支的正文在 `output` 上）。 */
function textOf(message: ModelMessage): string {
  return message.role === 'tool' ? message.output : String(message.content)
}

/** 一趟请求里所有消息拼成的文本（那一条「跑完了」的通知按它认）。 */
function sentText(messages: readonly ModelMessage[]): string {
  return messages.map(textOf).join('\n')
}

/**
 * **收干净这一趟起的后台命令**（收尾里调，判据红了也照收）——按 id 停，一个都不漏。
 *
 * 装配没接那一形（`background === undefined`）时**什么都没有可收**——那不是「收了但没成」，
 * 是压根没有这一件。
 */
async function reapBackground(assembly: { readonly background?: BackgroundRuns } | undefined): Promise<void> {
  const runs = assembly?.background
  if (runs === undefined) return

  for (const run of runs.running()) await runs.stop(run.id)
}

/** 等一条 `session.state`（会话命令的答复——命令面只发不收）。 */
async function nextState(handle: ShellHandle): Promise<{ readonly active: string }> {
  const event = await handle.until((candidate) => candidate.kind === 'session.state', 5000)
  if (event.kind !== 'session.state') throw new Error('等的就是 session.state')
  return { active: event.data.active }
}

describe('U89 · ① 在跑的在请求里 · ② 跑完就没有了 · ⑤ 不进记录', () => {
  test('起一条 ⇒ 下一趟请求里有它（编号 · 命令 · 还在跑）；它跑完 ⇒ 再下一趟没有它', async () => {
    const stage = makeStage()
    let reap: (() => Promise<void>) | undefined

    try {
      const turns: readonly FauxTurn[] = [
        // ① 交出去一条**会自己跑完**的后台命令
        {
          toolCalls: [
            { name: 'exec', args: { cmd: `sleep 0.6; echo ${MARK}`, background: true } },
          ],
        },
        // ② 这一轮不等它——模型接着说话（此刻它在跑）
        { text: '交出去了，我接着做别的', usage: { inputTokens: 20, outputTokens: 5 } },
        // ③ 由「跑完」那一声带起来的那一轮
        { text: '看到它跑完了' },
      ]
      const assembly = stage.assemble({ turns })
      reap = () => reapBackground(assembly)
      const shell = attachShell(assembly.shell)

      await shell.submit('起一条后台命令')
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= 3)

      const systems = systemsAt(stage)
      expect(systems.length).toBe(3)

      // —— ① 交出去那**之前**那一趟：还没有在跑的（块不出现） ——
      expect(systems[0]).not.toContain(HEADING)

      // —— ① 交出去**之后**那一趟：那一块里有它（三件齐） ——
      const done = eventsOfKind(shell.events, 'exec.background.done')[0]
      const outputPath = done?.data.outputPath ?? ''
      const during = systems[1] ?? ''
      expect(during).toContain(HEADING)
      // 逐字：编号（与 U70 回执同一个词）· 命令 · **还在跑** · 输出在哪儿
      expect(blockLine(during, 'bg-1')).toBe(
        `- 〔bg-1〕sleep 0.6; echo ${MARK}（还在跑 · 输出文件 ${outputPath}）`,
      )

      // —— ② 它跑完之后的下一趟：那一块**没有它了**（不是还在列着） ——
      const after = systems[2] ?? ''
      expect(after).not.toContain(HEADING)
      expect(after).not.toContain('bg-1')
      // 而且这一趟确实是「跑完那一声」带起来的（顺序：先摘账、后投递）
      const noticeTurn = lastModel(stage).requests[2]
      expect(sentText(noticeTurn?.messages ?? [])).toContain('后台命令跑完了')

      // —— ⑤ 这一块**不进记录**：条目里一个字都没有 ——
      assembly.close()
      const raw = readDatabase(assembly.paths.database)
      try {
        const spoken = raw.entries.map((entry) => entry.content_text ?? '')
        expect(spoken.some((text) => text.includes(HEADING))).toBe(false)
        expect(spoken.some((text) => text.includes('还在跑 · 输出文件'))).toBe(false)
      } finally {
        raw.close()
      }
    } finally {
      await reap?.()
      stage.dispose()
    }
  })
})

describe('U89 · 物证：把发给模型的请求体印出来（这一块在屏上不可见）', () => {
  /**
   * **归档要的就是这一份**（工单：这一块在屏上不可见——`ctrl+o` 展开的是工具结果那一行，
   * 系统提示不上面——故物证是**发给模型的请求体**，不是真帧）。
   *
   * 印三件，够逐字核：
   * ① 起之前那一趟的**系统提示全文**（没有那一块）；
   * ② 在跑着那一趟的**系统提示全文**（那一块在里面，逐字）；
   * ③ 跑完那一趟的**系统提示全文**（那一块没了）＋ 那一趟**最后一条消息**（「跑完」那一声）。
   */
  test('三趟请求的系统提示全文印出来（归档物证）', async () => {
    const stage = makeStage()
    let reap: (() => Promise<void>) | undefined

    try {
      const turns: readonly FauxTurn[] = [
        { toolCalls: [{ name: 'exec', args: { cmd: `sleep 0.6; echo ${MARK}`, background: true } }] },
        { text: '交出去了，我接着做别的', usage: { inputTokens: 20, outputTokens: 5 } },
        { text: '看到它跑完了' },
      ]
      const assembly = stage.assemble({ turns })
      reap = () => reapBackground(assembly)
      const shell = attachShell(assembly.shell)

      await shell.submit('起一条后台命令')
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= 3)

      const requests = lastModel(stage).requests
      const say = (line: string): void => console.log(line)

      say('══ U89 物证 · 发给模型的请求体（那一块只住在系统提示里）══')
      requests.forEach((request, index) => {
        const system = request.messages[0]
        say('')
        say(`── 第 ${index + 1} 趟请求 ── 消息 ${request.messages.length} 条 ──`)
        say(request.messages.map((message) => message.role).join(' / '))
        say('── 系统提示全文 ──')
        say(system === undefined ? '（没有系统提示）' : textOf(system))
      })

      const last = requests.at(-1)
      const tail = last?.messages.at(-1)
      say('')
      say('── 跑完那一趟的**最后一条消息**（「跑完」那一声投进来的）──')
      say(tail === undefined ? '（没有消息）' : textOf(tail))

      shell.dispose()
      assembly.close()
    } finally {
      await reap?.()
      stage.dispose()
    }
  })
})

describe('U89 · ③ 反面：一条后台任务都没有 ⇒ 那一块不出现', () => {
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
        expect(system).not.toContain('后台')
      }

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U89 · ④ 反面：每会话一份（A 的在跑命令不进 B 的请求）', () => {
  /**
   * 三条链（A → B → 回 A），**每链各起一条自己的**（脚本可重放：头一段恒是同一条后台
   * 命令，故 A 拿到 `bg-1`、B 拿到 `bg-2`、回 A 那条拿到 `bg-3`）。
   *
   * 两向都咬：**B 的请求里没有 A 的**，且**A 的请求里没有 B 的**——单咬一向的话，
   * 「谁的都不列」也能过。
   */
  test('A 的与 B 的各是各的；切回 A 还看得见它自己那条；停掉 ⇒ 那一块里就没有它了', async () => {
    const stage = makeStage()
    let reap: (() => Promise<void>) | undefined

    try {
      const turns: readonly FauxTurn[] = [
        // 每链头一段：交出去一条**永不结束**的命令（活到用例把它停掉为止）
        { toolCalls: [{ name: 'exec', args: { cmd: 'sleep 60', background: true } }] },
        // 每链第二段：这一轮不等它——模型接着说话（此刻它在跑）
        { text: '交出去了' },
        // 底下几段留给「停掉」之后那几声（每链自己吃自己的那一份）
        { text: '知道它停了' },
        { text: '知道它停了' },
        { text: '知道它停了' },
        { text: '知道它停了' },
      ]
      const assembly = stage.assemble({ turns })
      reap = () => reapBackground(assembly)
      const shell = attachShell(assembly.shell)

      // —— A：起一条 ——
      await shell.submit('甲这边起个服务')
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= 2)
      const a = assembly.session
      if (a === undefined) throw new Error('首条消息之后该有会话了')
      const chainA1 = stage.models[0]
      if (chainA1 === undefined) throw new Error('一条链该有一个替身网关')
      expect(systemsOf(chainA1)[1]).toContain(HEADING)
      expect(blockLine(systemsOf(chainA1)[1] ?? '', 'bg-1')).toContain('sleep 60')

      // —— 换到 B（新会话，自己的链）——
      shell.send({ type: 'session.new' })
      const b = (await nextState(shell)).active
      expect(b).not.toBe(a)

      await shell.submit('乙这边起个服务')
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= 4)
      const chainB = stage.models[1]
      if (chainB === undefined) throw new Error('换会话该另起一个替身网关（一条链一份）')

      const inB = systemsOf(chainB)[1] ?? ''
      // ⚠️ B 自己那条在列（`bg-2`）——**A 那条一个字都没有**：不是「列出来了但标着别人的」
      expect(blockLine(inB, 'bg-2')).toContain('sleep 60')
      expect(inB).not.toContain('bg-1')

      // —— 切回 A：它起的那些既没停、也没换主人 ⇒ 照样看得见 ——
      shell.send({ type: 'session.open', session: a })
      await until(() => eventsOfKind(shell.events, 'session.state').length >= 2)
      await shell.submit('甲再来说一句')
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= 6)

      const chainA2 = stage.models[2]
      if (chainA2 === undefined) throw new Error('切回来该另起一条链')
      const backInA = systemsOf(chainA2)[1] ?? ''
      // A 先起的那条（bg-1）**还在**，这一趟 A 自己新起的（bg-3）也在；B 的（bg-2）不在
      expect(blockLine(backInA, 'bg-1')).toContain('sleep 60')
      expect(blockLine(backInA, 'bg-3')).toContain('sleep 60')
      expect(backInA).not.toContain('bg-2')

      // —— 停掉 ⇒ 那一块里就没有它了（②在「被停」这条路上同样成立）——
      const background = assembly.background
      if (background === undefined) throw new Error('这次装配没接后台那一形')
      const before = eventsOfKind(shell.events, 'turn.end').length
      for (const id of ['bg-1', 'bg-2', 'bg-3']) expect((await background.stop(id)).ok).toBe(true)
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= before + 2)

      const afterStop = systemsOf(chainA2).at(-1) ?? ''
      expect(afterStop).not.toContain(HEADING)

      shell.dispose()
      assembly.close()
    } finally {
      await reap?.()
      stage.dispose()
    }
  })
})

describe('U89 · ⑤ 每请求重算（压缩碰不到它）', () => {
  test('压过一次之后，那一块照旧在（它不是条目，压缩够不着）', async () => {
    const stage = makeStage()
    let reap: (() => Promise<void>) | undefined

    try {
      const turns: readonly FauxTurn[] = [
        // 起一条**挂着不动**的（这样中途不会有「跑完」那一声来搅乱次序）
        { toolCalls: [{ name: 'exec', args: { cmd: 'sleep 60', background: true } }] },
        // 用量报高一点——下一轮开跑前就会触发压缩
        { text: '交出去了', usage: { inputTokens: 500, outputTokens: 5 } },
        // 压缩那一趟（一次调用 ＝ 一段脚本）
        { text: '摘要：前头那件事办完了' },
        { text: '答复' },
        // 收尾：停掉之后那一声带起来的一轮
        { text: '知道它停了' },
      ]
      const assembly = stage.assemble({
        turns,
        // 触发与近段都压到脚本体量（实现级常量——装配期入参，与 U19 那支同一手法）
        context: { compactAtTokens: 100, nearEntries: 1 },
      })
      reap = () => reapBackground(assembly)
      const shell = attachShell(assembly.shell)

      await shell.submit('起一条后台命令')
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= 2)
      expect(systemsAt(stage)[1]).toContain(HEADING)

      await shell.submit('再来一件')
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= 3)

      // **压缩真发生了**（不是「没触发所以没碰到」）——事件为凭
      expect(eventsOfKind(shell.events, 'context.compacted').length).toBeGreaterThanOrEqual(1)

      // 压完那一趟：那一块照旧在（它是每请求现算的，不进条目流，压缩碰不到）
      const afterCompact = systemsAt(stage).at(-1) ?? ''
      expect(afterCompact).toContain(HEADING)
      expect(afterCompact).toContain('sleep 60')
      expect(afterCompact).toContain('还在跑')

      const background = assembly.background
      if (background === undefined) throw new Error('这次装配没接后台那一形')
      await background.stop('bg-1')
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= 4)

      shell.dispose()
      assembly.close()
    } finally {
      await reap?.()
      stage.dispose()
    }
  })
})
