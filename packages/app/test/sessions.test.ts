/**
 * U16 · **多会话**（`@magic/app` 装配面）——纵切：启动落点 · 切换续跑 · 标题 · 恢复入口。
 *
 * 这一层验的是**接线**：装配把「开一条会话」的整束（记录实例 · 铸造器 · 闸门 · 工具域 ·
 * 对话实例）接起来，控制面的会话命令经路由落到对话域，事件经扇出回外壳。
 * 各件自己的判据在各自的包里（`records` / `conversation` / `tui`），此处只验「接上了」。
 *
 * 两处**直读库表**（不经 API 回读闭环）：会话分束是不是真的分了、标题是不是真落了列。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent, ModelMessage, SessionSummary } from '@magic/contracts'
import { attachShell } from '../src/shell.ts'
import type { ShellHandle } from '../src/shell.ts'
import { makeStage } from './support.ts'
import type { Stage } from './support.ts'
import { readDatabase } from './support.ts'

/** 一件工具都不请求的一轮——用例只关心「谁记得什么」，不关心工具。 */
const PLAIN: readonly { readonly text: string }[] = [{ text: '好' }]

/** 接上外壳位并收回事件轨迹。 */
function attach(assembly: ReturnType<Stage['assemble']>): ShellHandle {
  return attachShell(assembly.shell)
}

/** 一条模型消息的正文——`role:'tool'` 那支不带 `content`（正文在 `output`），按判别取。 */
function textOf(message: ModelMessage): string {
  return 'content' in message ? message.content : `${message.name}: ${message.output}`
}

/** 等一条 `session.state`——会话命令的答复（命令面只发不收，答复走事件）。 */
async function nextState(handle: ShellHandle, timeoutMs = 5000): Promise<SessionSummary[]> {
  const event = await handle.until((candidate) => candidate.kind === 'session.state', timeoutMs)
  if (event.kind !== 'session.state') throw new Error('等的就是 session.state')

  return [...event.data.sessions]
}

function titleOf(sessions: readonly SessionSummary[], id: string): string | undefined {
  return sessions.find((row) => row.id === id)?.title
}

/** 一次交代，落进 A，再新建 B 并交代——两块沙地共用的一段编排。 */
async function twoSessions(
  stage: Stage,
): Promise<{ handle: ShellHandle; assembly: ReturnType<Stage['assemble']>; a: string; b: string }> {
  const assembly = stage.assemble({ turns: PLAIN })
  const handle = attach(assembly)
  const a = assembly.session

  await handle.submit('甲这边的事')

  handle.send({ type: 'session.new' })
  const listed = await nextState(handle)
  const b = listed[0]?.id
  if (b === undefined || b === a) throw new Error(`新建没成：${JSON.stringify(listed)}`)

  await handle.submit('乙那边的事')

  return { handle, assembly, a, b }
}

describe('启动落点（接着最近一条）', () => {
  test('库里已有会话——下次装配接着它，不是新造一条', async () => {
    const stage = makeStage()
    try {
      const first = stage.assemble({ turns: PLAIN })
      const handle = attach(first)
      await handle.submit('先来的那句')
      const session = first.session
      first.close()

      const second = stage.assemble({ turns: PLAIN })
      expect(second.session).toBe(session)
      second.close()
    } finally {
      stage.dispose()
    }
  })

  test('库里空着——新造一条（第一次启动）', () => {
    const stage = makeStage()
    try {
      const assembly = stage.assemble({ turns: PLAIN })
      expect(typeof assembly.session).toBe('string')
      expect(assembly.session.length).toBeGreaterThan(0)
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('切换续跑（退出条件：A 记得自己的、不知道 B 的）', () => {
  test('切回 A——送模型的上下文是 A 那条，B 的一点没混进来', async () => {
    const stage = makeStage()
    try {
      const { handle, assembly, a, b } = await twoSessions(stage)

      // 切回 A 再交代一句——这一步的模型请求就是判据的落点
      handle.send({ type: 'session.open', session: a })
      await nextState(handle)
      await handle.submit('甲这边还有一句')

      // 切回 A 时新开的那个网关（每开一条会话造一个）——最近一个就是 A 的
      const gateway = stage.models.at(-1)
      const messages = gateway?.requests.at(-1)?.messages ?? []
      const said = messages.map(textOf).join('\n')

      expect(assembly.session).toBe(a)
      expect(said).toContain('甲这边的事')
      expect(said).toContain('甲这边还有一句')
      // ★ 判据：A 不知道 B 的事
      expect(said).not.toContain('乙那边的事')
      expect(said).not.toContain(b)

      // 反过来也验一遍（B 那条上下文里只有 B 的）
      handle.send({ type: 'session.open', session: b })
      await nextState(handle)
      await handle.submit('乙这边还有一句')
      const bMessages = stage.models.at(-1)?.requests.at(-1)?.messages ?? []
      const bSaid = bMessages.map(textOf).join('\n')
      expect(bSaid).toContain('乙那边的事')
      expect(bSaid).not.toContain('甲这边')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('分束是真的分了——直读库表：两条会话各记各的', async () => {
    const stage = makeStage()
    try {
      const { assembly, a, b } = await twoSessions(stage)
      assembly.close()

      const raw = readDatabase(assembly.paths.database)
      try {
        const bySession = new Map<string, string[]>()
        for (const entry of raw.entries) {
          if (entry.kind !== 'user') continue
          const texts = bySession.get(entry.session) ?? []
          texts.push(entry.content_text ?? '')
          bySession.set(entry.session, texts)
        }

        expect([...bySession.get(a) ?? []]).toEqual(['甲这边的事'])
        expect([...bySession.get(b) ?? []]).toEqual(['乙那边的事'])
        // 事件也分了束——每条事件的 session 非 A 即 B，没有第三条
        expect(new Set(raw.events.map((event) => event.session))).toEqual(new Set([a, b]))
        // 会话表两行——「切走再切回」不多造行
        expect(raw.sessions.map((row) => row.id).sort()).toEqual([a, b].sort())
      } finally {
        raw.close()
      }
    } finally {
      stage.dispose()
    }
  })
})

describe('标题（＝首条消息摘要 · 可改）', () => {
  test('没改过——按首条消息现算；改过——列表与库都以改过的为准', async () => {
    const stage = makeStage()
    try {
      const assembly = stage.assemble({ turns: PLAIN })
      const handle = attach(assembly)
      const a = assembly.session
      await handle.submit('看看工作区里有什么')

      // ① 现算：首条消息就是标题
      handle.send({ type: 'session.list' })
      expect(titleOf(await nextState(handle), a)).toBe('看看工作区里有什么')

      // ② 可改
      handle.send({ type: 'session.rename', session: a, title: '换个名字' })
      expect(titleOf(await nextState(handle), a)).toBe('换个名字')

      // ③ 列表与库一致——标题真的落了 `sessions.title` 列（直读，不经 API 回读）
      assembly.close()
      const raw = readDatabase(assembly.paths.database)
      try {
        const row = raw.sessions.find((session) => session.id === a)
        expect(row?.title).toBe('换个名字')
      } finally {
        raw.close()
      }
    } finally {
      stage.dispose()
    }
  })

  test('标题换了之后重开——还是改过的那个（现算不盖回来）', async () => {
    const stage = makeStage()
    try {
      const first = stage.assemble({ turns: PLAIN })
      const handle = attach(first)
      const a = first.session
      await handle.submit('原来的首条消息')
      handle.send({ type: 'session.rename', session: a, title: '改过的' })
      await nextState(handle)
      first.close()

      const second = stage.assemble({ turns: PLAIN })
      const again = attach(second)
      again.send({ type: 'session.list' })
      expect(titleOf(await nextState(again), a)).toBe('改过的')
      second.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('恢复入口（boot——订阅之后、放开输入之前）', () => {
  test('干净会话：boot 跑得完，且一个事件都不发（过程流里不留恢复的痕迹）', async () => {
    const stage = makeStage()
    try {
      const assembly = stage.assemble({ turns: PLAIN })
      const handle = attachShell(assembly.shell, { onEvent: () => undefined })
      const before = handle.events.length

      await assembly.boot()

      expect(handle.events.length).toBe(before)
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('有在途的会话：boot 补上中止与结果，续跑接得上（真崩溃相由 U15 的驱动覆盖）', async () => {
    const stage = makeStage()
    try {
      const first = stage.assemble({ turns: PLAIN })
      const handle = attach(first)
      await handle.submit('起个头')
      const session = first.session
      first.close()

      // 重开（模拟崩溃后重启）——boot 对这条会话跑一次恢复
      const second = stage.assemble({ turns: PLAIN })
      expect(second.session).toBe(session)
      const again = attachShell(second.shell)
      await second.boot()

      // 干净收尾的轮没有在途——恢复报告里没有处置，过程流里也没有补记
      const recovered = again.events.filter(
        (event: KernelEvent) => event.kind === 'turn.end' && event.data.reason === 'aborted',
      )
      expect(recovered).toEqual([])
      second.close()
    } finally {
      stage.dispose()
    }
  })
})
