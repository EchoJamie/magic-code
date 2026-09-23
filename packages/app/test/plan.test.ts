/**
 * U34 · **计划与历史全链**（真装配 × 真记录库 × 真闸门 × 真对话域，只有模型是替身）。
 *
 * 判据照设计的验收条走，各咬一处接线：
 *
 * 1. **模型真的能写能读**——工具调用 → 条目落账（直读库表）→ `plan.changed` 通报 →
 *    下一趟请求里带着完整笔记。不是测试专用函数：走的是装配接出来的那三件真工具。
 * 2. **跨会话不串**——另一条会话读不到这边建的笔记（读面绑的是会话，不是进程）。
 * 3. **压缩之后仍取得到**——旧段被摘要顶掉之后，最新笔记重新落进请求里；
 *    清空同样生效，重开不复活。
 * 4. **回查真的回得到**——压掉的那段历史按记录位置读得回来（含续读位置与节选标记）。
 * 5. **权限是窄的**——三件自动放行、不留卡；别的工具照旧要问（规则只匹配那三个名字）。
 *
 * ⚠️ 这一条用例咬的是**装配那一行接线**（`open` 里造读面 ＋ 追加三件工具 ＋ 追加三条规则）：
 * 去掉任何一处，下面各自的那条就红。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent, ModelMessage, PlanNote } from '@magic/contracts'
import { attachShell } from '../src/index.ts'
import { eventsOfKind, lastModel, makeStage, readDatabase } from './support.ts'

const PLAN: PlanNote = {
  steps: [
    { text: '定位登录失败提示', status: 'completed' },
    { text: '覆盖四个失败分支', status: 'in_progress' },
  ],
  notes: '约束：保留已输入内容',
}

/** 送模型的那一份拼成一段文本（判「模型看没看见」用）。 */
function sentText(messages: readonly ModelMessage[]): string {
  return messages
    .map((message) => (message.role === 'tool' ? message.output : message.content))
    .join('\n')
}

/** 一次「模型请求写计划、下一轮再说话」的脚本。 */
function planWriteTurns(plan: PlanNote | null): readonly Record<string, unknown>[] {
  return [
    { toolCalls: [{ name: 'plan_update', args: { plan } }] },
    { text: '记下了' },
  ]
}

describe('U34 · 模型真的能写计划（写 → 落账 → 通报 → 进上下文）', () => {
  test('更新：条目落账 · `plan.changed` 通报 · 下一趟请求里带着完整笔记 · 全程不弹卡', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({ turns: planWriteTurns(PLAN) })
      const shell = attachShell(assembly.shell)

      await shell.submit('把登录失败提示改清楚，保留已输入内容')
      shell.dispose()

      // —— ① 通报：落账之后那一条，带条目 id 与内容 ——
      const changed = eventsOfKind(shell.events, 'plan.changed')
      expect(changed).toHaveLength(1)
      expect(changed[0]?.data.plan).toEqual(PLAN)

      // —— ② 条目载荷落进库（直读库表，不经 API 回读）——
      const db = readDatabase(assembly.paths.database)
      const result = db.entries.find((entry) => entry.kind === 'tool-result')
      const payload = JSON.parse(result?.payload ?? '{}') as { plan?: PlanNote }
      db.close()

      expect(payload.plan).toEqual(PLAN)
      // 通报带的 id 就是那条条目（界面按它比较新旧）
      expect(changed[0]?.data.entry).toBe(result?.id)

      // —— ③ 下一趟请求里看得见最新笔记（回执正文带着它）——
      const requests = lastModel(stage).requests
      const sent = sentText(requests[1]?.messages ?? [])
      expect(sent).toContain('定位登录失败提示')
      expect(sent).toContain('覆盖四个失败分支')
      expect(sent).toContain('约束：保留已输入内容')

      // —— ④ 权限：三件走自动放行，不留卡 ——
      expect(eventsOfKind(shell.events, 'tool.decision.request')).toEqual([])
      expect(
        eventsOfKind(shell.events, 'tool.decision').map((one) => one.data.decider),
      ).toEqual(['auto'])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('清空：`plan.changed` 带 `plan: null`（界面据以移除清单），条目载荷也写着 null', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({ turns: planWriteTurns(null) })
      const shell = attachShell(assembly.shell)

      await shell.submit('这件事收了，别留清单')
      shell.dispose()

      const changed = eventsOfKind(shell.events, 'plan.changed')
      expect(changed).toHaveLength(1)
      expect(changed[0]?.data.plan).toBeNull()

      const db = readDatabase(assembly.paths.database)
      const result = db.entries.find((entry) => entry.kind === 'tool-result')
      db.close()
      // **键在、值为 null**——与「没有这一位」不是一回事（契约那条三态）
      expect(JSON.parse(result?.payload ?? '{}')).toEqual({
        ok: true,
        output: { text: expect.any(String) },
        plan: null,
      })

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U34 · 同一份来源、跨会话不串（重开接得上、别的会话读不到）', () => {
  /** 模型那一轮：先读一次笔记，再说话。 */
  const READ_TURNS = [
    { toolCalls: [{ name: 'plan_read', args: {} }] },
    { text: '看到了' },
  ]

  /** 一次装配里**工具读回来的那一段文本**（`role: 'tool'` 那条）。 */
  function toolOutputOf(stage: ReturnType<typeof makeStage>): string {
    return lastModel(stage)
      .requests.flatMap((request) => request.messages)
      .filter((message): message is Extract<ModelMessage, { role: 'tool' }> => message.role === 'tool')
      .map((message) => message.output)
      .join('\n')
  }

  test('重开同一条会话：笔记仍取得到（内容在记录里，不在进程里）', async () => {
    const stage = makeStage()

    try {
      const first = stage.assemble({ turns: planWriteTurns(PLAN) })
      const shell = attachShell(first.shell)
      await shell.submit('甲这边建个计划')
      const session = first.session
      shell.dispose()
      first.close()

      // **换一次装配**（同一个数据目录、同一条会话）——模拟关掉再打开
      const reopened = stage.assemble({ turns: READ_TURNS, session })
      const again = attachShell(reopened.shell)
      await again.submit('接着来')
      again.dispose()

      const read = toolOutputOf(stage)
      expect(read).toContain('覆盖四个失败分支')
      expect(read).toContain('约束：保留已输入内容')

      reopened.close()
    } finally {
      stage.dispose()
    }
  })

  test('另一条会话读不到（读面绑会话，不是进程）', async () => {
    const stage = makeStage()

    try {
      const first = stage.assemble({ turns: planWriteTurns(PLAN) })
      const shell = attachShell(first.shell)
      await shell.submit('甲这边建个计划')
      shell.dispose()
      first.close()

      // **空手打开**（D5：不给会话就是新建一条）——乙那边看不到甲的计划
      const other = stage.assemble({ turns: READ_TURNS })
      const shellB = attachShell(other.shell)
      await shellB.submit('乙这边问一句')
      shellB.dispose()

      const read = toolOutputOf(stage)
      expect(read).toContain('还没有计划笔记')
      expect(read).not.toContain('覆盖四个失败分支')

      // 甲的记录仍原样在（隔离的是读面，不是把内容删了）——落账的**结果**那一条就是这份计划
      const db = readDatabase(other.paths.database)
      const withPlan = db.entries.filter(
        (entry) => entry.kind === 'tool-result' && entry.payload?.includes('覆盖四个失败分支'),
      )
      expect(withPlan).toHaveLength(1)
      db.close()

      other.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U34 · 压缩之后仍取得到最新笔记', () => {
  test('旧段被摘要顶掉之后，计划材料重新落进请求里（且回执本身已不在窗口里）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({
        // ① 建计划 ② 答复（用量越阈值）③ 摘要（压缩那次调用）④ 压完之后那一轮
        turns: [
          { toolCalls: [{ name: 'plan_update', args: { plan: PLAN } }] },
          { text: '答复一', usage: { inputTokens: 500, outputTokens: 5 } },
          { text: '摘要：前面在改登录提示' },
          { text: '接着干' },
        ],
        // 阈值与近段都压到脚本体量（装配期入参，不是用户配置）
        context: { compactAtTokens: 100, nearEntries: 1 },
      })
      const shell = attachShell(assembly.shell)

      await shell.submit('第一件事')
      await shell.submit('第二件事')
      shell.dispose()

      const requests = lastModel(stage).requests
      // 0 建计划 · 1 答复 · 2 压缩 · 3 压完之后那一轮
      expect(requests).toHaveLength(4)

      const sent = sentText(requests[3]?.messages ?? [])
      // 回执那一份已经被压出去了（旧段不再送）
      expect(sent).not.toContain('计划笔记已更新')
      // 但**计划本身还在**——按记录位置重新交付的那一份材料
      expect(sent).toContain('既有计划笔记')
      expect(sent).toContain('覆盖四个失败分支')
      expect(sent).toContain('约束：保留已输入内容')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('清空之后压缩：不把旧计划重新投影成当前清单', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({
        turns: [
          { toolCalls: [{ name: 'plan_update', args: { plan: PLAN } }] },
          { text: '答复一' },
          { toolCalls: [{ name: 'plan_update', args: { plan: null } }] },
          { text: '答复二', usage: { inputTokens: 500, outputTokens: 5 } },
          { text: '摘要：前面改完了登录提示' },
          { text: '接着干' },
        ],
        context: { compactAtTokens: 100, nearEntries: 1 },
      })
      const shell = attachShell(assembly.shell)

      await shell.submit('第一件事')
      await shell.submit('这件事收尾了')
      await shell.submit('第三件事')
      shell.dispose()

      const requests = lastModel(stage).requests
      const sent = sentText(requests.at(-1)?.messages ?? [])
      // 清空过：要么看不到计划材料，要么只有一句「已清空」——**不能**再出现旧步骤
      expect(sent).not.toContain('覆盖四个失败分支')
      expect(sent).not.toContain('既有计划笔记')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U34 · 回查真的回得到', () => {
  test('压掉的那一段按记录位置读得回来（含节选标记与续读位置）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({
        turns: [
          { text: '答复一', usage: { inputTokens: 500, outputTokens: 5 } },
          { text: '摘要：前面几件事' },
          // 压完之后那一轮：模型回查历史
          // 回查那一轮的用量**压到阈值以下**——不然紧接着会再压一次，
          // 把要看的那一段又顶出窗口（这条例用案要的是「压完还能读回来」）
          { toolCalls: [{ name: 'history_read', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
          { text: '看到了', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        context: { compactAtTokens: 100, nearEntries: 0 },
      })
      const shell = attachShell(assembly.shell)

      await shell.submit('第一件事')
      await shell.submit('第二件事')
      shell.dispose()

      const toolOutput = lastModel(stage)
        .requests.flatMap((request) => request.messages)
        .filter((message): message is Extract<ModelMessage, { role: 'tool' }> => message.role === 'tool')
        .map((message) => message.output)
        .join('\n')

      // 压掉的那句交代**读得回来**（窗口之外那一段）
      expect(toolOutput).toContain('第一件事')
      // 每条带记录位置（`#id`）
      expect(toolOutput).toMatch(/#\d+/)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U34 · 指导与工具随请求送达（首次即到、压缩后仍在）', () => {
  test('首趟请求就带着规划指导与三件工具；压过之后指导仍在', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({
        turns: [
          { text: '答复一', usage: { inputTokens: 500, outputTokens: 5 } },
          { text: '摘要：前面那件事' },
          { text: '接着干' },
        ],
        context: { compactAtTokens: 100, nearEntries: 0 },
      })
      const shell = attachShell(assembly.shell)
      await shell.submit('第一件事')
      await shell.submit('第二件事')
      shell.dispose()

      const requests = lastModel(stage).requests
      const head = requests[0]?.messages[0]
      const tail = requests.at(-1)?.messages[0]
      if (head?.role !== 'system' || tail?.role !== 'system') throw new Error('首条该是系统提示词')

      // **指导在第一次调用里就送达**（不是等模型想起笔记工具才出现）——
      // 断的是**实际请求**里那一段，不是提示词模板本身
      for (const system of [head.content, tail.content]) {
        expect(system).toContain('该计划时')
        expect(system).toContain('维护计划笔记')
        expect(system).toContain('完成前核查')
        expect(system).toContain('确认这项工作结束后清空计划笔记')
      }
      // 压缩换的是会话材料，不动系统提示词（它由内核持有，不随历史漂）
      expect(tail.content).toBe(head.content)

      // **工具说明与实际可用能力一致**：三件真在送出去的工具表里
      // （能调通见本文件其余用例——不是「表里写着、实际调不动」）
      const names = (requests[0]?.tools ?? []).map((tool) => tool.name)
      expect(names).toEqual(expect.arrayContaining(['plan_read', 'plan_update', 'history_read']))
      const update = (requests[0]?.tools ?? []).find((tool) => tool.name === 'plan_update')
      expect(JSON.stringify(update?.parameters)).toContain('建议二十个字左右')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('清单还有未完成项时，模型不再请求工具 ⇒ 本轮就此收束（不自动续跑）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({
        turns: [
          {
            toolCalls: [
              {
                name: 'plan_update',
                args: { plan: { steps: [{ text: '还有一步没做', status: 'pending' }], notes: '' } },
              },
            ],
          },
          { text: '先说到这儿' },
        ],
      })
      const shell = attachShell(assembly.shell)

      await shell.submit('先做一半')
      shell.dispose()

      // 两次调用：写计划那一轮 ＋ 说那一句话。**没有第三次**——
      // 「还剩一项没勾」不是内核的续跑判据（设计：不以全部勾选代替完成判断）
      expect(lastModel(stage).requests).toHaveLength(2)
      expect(eventsOfKind(shell.events, 'turn.end').map((one) => one.data.reason)).toEqual([
        'settled',
        'settled',
      ])
      expect(shell.events.at(-1)?.data).toEqual({ state: 'waiting' })

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U34 · 反例：那条节选上限只管 blob，不碰内联正文', () => {
  /**
   * **独立验收退回的第一条**：`contentTextOf` 一度把**所有内联正文**也过了一遍
   * 2000 字符的节选——真装配里 2225 字符的用户交代只剩 2030，尾巴上的要求当场丢掉
   * （main 上是完整的）。这条用例照验收那次的同一手法钉住：同一个输入，尾部必须在。
   */
  test('2225 字符的用户交代整份送达——尾部要求不丢、没有截断标记', async () => {
    const long = `${'a'.repeat(2200)}TAIL_REQUIREMENT_PRESERVE`
    const stage = makeStage()

    try {
      const assembly = stage.assemble({ turns: [{ text: '知道了' }] })
      const shell = attachShell(assembly.shell)
      await shell.submit(long)
      shell.dispose()

      const sent = lastModel(stage).requests[0]?.messages ?? []
      const user = sent.find((message) => message.role === 'user')
      const body = user === undefined ? '' : sentText([user])

      expect(body).toHaveLength(long.length)
      expect(body).toContain('TAIL_REQUIREMENT_PRESERVE')
      expect(body).not.toContain('截断')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  /**
   * **长历史页的页尾**：那条记录在回查里该标节选，而**接着读的两格参数要真发到下一趟请求里**
   * （验收明写：断言落在实际请求上，不是只看域内部的 `HistoryPage`）。
   */
  test('长记录的节选把 `entry` / `offset` 交给模型——下趟请求里看得到', async () => {
    const long = '甲'.repeat(2500)
    const stage = makeStage()

    try {
      const assembly = stage.assemble({
        turns: [
          { text: '答复一', usage: { inputTokens: 500, outputTokens: 5 } },
          { text: '摘要：前面那条很长' },
          { toolCalls: [{ name: 'history_read', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
          { text: '接着读', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        context: { compactAtTokens: 100, nearEntries: 0 },
      })
      const shell = attachShell(assembly.shell)

      await shell.submit(long)
      await shell.submit('第二件事')
      shell.dispose()

      const toolOutput = lastModel(stage)
        .requests.flatMap((request) => request.messages)
        .filter((message): message is Extract<ModelMessage, { role: 'tool' }> => message.role === 'tool')
        .map((message) => message.output)
        .join('\n')

      // 节选：前 2000 字在、后 500 字不在，且**续读参数**就在回执里
      expect(toolOutput).toContain('甲'.repeat(50))
      expect(toolOutput).toContain('节选')
      expect(toolOutput).toMatch(/entry=\d+ offset=2000/)
      expect(toolOutput).not.toContain('甲'.repeat(2500))

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  /** **长计划完整送达**：回执是内联文本，再长也整份走（不截断、也不重复两份）。 */
  test('长计划（内联回执远超 2000 字符）整份送达；压缩后重送的那份也是全的、只有一份', async () => {
    const plan: PlanNote = {
      steps: [{ text: '定位登录失败提示', status: 'completed' }],
      notes: `约束：${'乙'.repeat(2400)}TAIL_PLAN_PRESERVE`,
    }
    const stage = makeStage()

    try {
      const assembly = stage.assemble({
        turns: [
          { toolCalls: [{ name: 'plan_update', args: { plan } }], usage: { inputTokens: 500, outputTokens: 5 } },
          { text: '记下了', usage: { inputTokens: 500, outputTokens: 5 } },
          { text: '摘要：前面在改登录提示' },
          { text: '接着干', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        context: { compactAtTokens: 100, nearEntries: 0 },
      })
      const shell = attachShell(assembly.shell)

      await shell.submit('第一件事')
      await shell.submit('第二件事')
      shell.dispose()

      const requests = lastModel(stage).requests
      // 更新那一趟之后：回执整份进上下文（内联不截断）
      const afterUpdate = sentText(requests[1]?.messages ?? [])
      expect(afterUpdate).toContain('TAIL_PLAN_PRESERVE')
      expect(afterUpdate).not.toContain('截断')

      // 压出去之后：重新交付的那一份也是全的，且**只有一份**（不重复正文）
      const afterCompact = sentText(requests.at(-1)?.messages ?? [])
      expect(afterCompact).toContain('TAIL_PLAN_PRESERVE')
      expect(afterCompact.split('既有计划笔记').length - 1).toBe(1)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U34 · 权限是窄的', () => {
  test('三件自动放行；**别的工具照旧要问**（规则只匹配那三个名字）', async () => {
    const stage = makeStage()
    const requests: KernelEvent[] = []

    try {
      const assembly = stage.assemble({
        turns: [
          {
            toolCalls: [
              { name: 'plan_read', args: {} },
              { name: 'read', args: { path: 'src/login.ts' } },
            ],
          },
          { text: '好' },
        ],
      })
      const off = assembly.shell.subscribe((event) => requests.push(event))
      const shell = attachShell(assembly.shell)

      await shell.submit('看一眼')
      off()
      shell.dispose()

      const asked = eventsOfKind(requests, 'tool.decision.request')
      expect(asked).toHaveLength(1)
      // 被问的是 `read`，不是 `plan_read`
      expect(asked[0]?.data.name).toBe('read')

      const verdicts = eventsOfKind(requests, 'tool.decision')
      expect(verdicts.map((one) => [one.data.decider, one.data.decision])).toEqual([
        ['auto', 'approve'],
        ['user', 'approve'],
      ])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
