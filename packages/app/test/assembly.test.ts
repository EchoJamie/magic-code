/**
 * U11 · 装配根 —— 判据：**顺序纪律** · **扇出** · **铸造器按会话实例**（id 取自记录域）。
 *
 * 三条都不是「实现细节」：顺序反了＝用户输入无声丢失；扇出错了＝记录缺过程；
 * 铸造器接错了＝同一张库里两串 id（裁决配对当场断）。
 */

import { describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import type { EventDataOf, EventKind, KernelEvent } from '@magic/contracts'
import { ConfigError, attachShell, createStamper } from '../src/index.ts'
import { eventsOfKind, kindTrail, makeStage, readDatabase } from './support.ts'
import { removeDir, tempDir } from './tmp.ts'

describe('顺序纪律——先接订阅、后放开输入', () => {
  test('未订阅时的事件推送**丢弃**（不排队、不补发）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble()

      // ① 装配完成、**还没订阅**——此刻放开输入
      assembly.shell.send({ type: 'input.submit', text: '早了一步' })
      await Bun.sleep(50)

      // ② 这才订阅——前面那一轮的推送已经飘走了（不是排队等着）
      const shell = attachShell(assembly.shell)
      await Bun.sleep(50)

      expect(shell.events).toHaveLength(0)

      // ③ 但**记录还在**——丢的是推送，不是过程（扇出不经订阅：控制广播、记录落库，
      //    两条路各走各的）
      assembly.close()
      const raw = readDatabase(assembly.paths.database)
      try {
        expect(raw.events.map((row) => row.kind)).toContain('agent.start')
        expect(raw.events.map((row) => row.kind)).toContain('message.user')
      } finally {
        raw.close()
      }
    } finally {
      stage.dispose()
    }
  })

  test('装配期**不发事件**——故「订阅」这一步没有追赶窗口', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble()
      const shell = attachShell(assembly.shell)

      // 装配本身一条都没发；第一条事件是首次开工的 `agent.start`（不是「迟到的某条」）
      expect(shell.events).toHaveLength(0)

      await shell.submit('第一条')
      expect(shell.events[0]?.kind).toBe('agent.start')

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('扇出——控制广播全部、记录落持久类', () => {
  test('订阅者收到**全部**（含瞬时增量）；库里只有**持久类**', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble()
      const shell = attachShell(assembly.shell)

      await shell.submit('跑一下 echo')
      shell.dispose()
      assembly.close()

      const trail = kindTrail(shell.events)
      // 控制面：瞬时增量照推（渲染要实时）
      expect(trail).toContain('model.delta')
      expect(trail).toContain('tool.output.delta')

      const raw = readDatabase(assembly.paths.database)
      try {
        const stored = raw.events.map((row) => row.kind)
        // 记录：瞬时类一条不落
        expect(stored).not.toContain('model.delta')
        expect(stored).not.toContain('tool.output.delta')
        // 且**逐条对齐**订阅侧减掉瞬时类——不多不少、次序不移
        expect(stored).toEqual(trail.filter((k) => k !== 'model.delta' && k !== 'tool.output.delta'))
      } finally {
        raw.close()
      }
    } finally {
      stage.dispose()
    }
  })

  test('事件的 id 就是落库的 id——铸造器铸的号，中间没人重编', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble()
      const shell = attachShell(assembly.shell)

      await shell.submit('跑一下 echo')
      shell.dispose()
      assembly.close()

      const durable = shell.events.filter(
        (event) => event.kind !== 'model.delta' && event.kind !== 'tool.output.delta',
      )

      const raw = readDatabase(assembly.paths.database)
      try {
        // 同一批 id、同一批次序——记录域既是号源，也是落点
        expect(raw.events.map((row) => row.id)).toEqual(durable.map((event) => event.id))
      } finally {
        raw.close()
      }
    } finally {
      stage.dispose()
    }
  })
})

describe('信封铸造器——产出方铸（按会话实例）', () => {
  test('id 取自记录域 · session 由装配设 · at 由铸造器盖 · turn 归 beginTurn', () => {
    let issued = 100
    const ats = [1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002]
    let clock = 0

    const stamper = createStamper({
      records: { nextId: () => (issued += 1) },
      session: 's-1',
      now: () => ats[clock++] ?? 0,
    })

    const first = stamper.stamp('turn.start', {})
    stamper.beginTurn(7)
    const second = stamper.stamp('agent.state', { state: 'resumed' })
    // `undefined` ＝轮止 → 信封的 `null`（不是「不改动」）
    stamper.beginTurn(undefined)
    const third = stamper.stamp('agent.end', {})

    expect([first.id, second.id, third.id]).toEqual([101, 102, 103])
    expect([first.at, second.at, third.at]).toEqual(ats)
    expect([first.session, second.session, third.session]).toEqual(['s-1', 's-1', 's-1'])
    expect([first.turn, second.turn, third.turn]).toEqual([null, 7, null])
  })

  test('每个会话实例各持一份——跨实例不共享轮号', () => {
    const makeFor = (session: string) =>
      createStamper({ records: { nextId: () => 1 }, session, now: () => 0 })

    const a = makeFor('a')
    const b = makeFor('b')
    a.beginTurn(1)

    const fromA = a.stamp('turn.start', {}) as KernelEvent
    const fromB = b.stamp('turn.start', {}) as KernelEvent

    expect(fromA.session).toBe('a')
    expect(fromA.turn).toBe(1)
    expect(fromB.session).toBe('b')
    expect(fromB.turn).toBeNull()
  })

  test('铸造面与消费面同形——铸造器产出按 kind 自动收窄', () => {
    const stamper = createStamper({ records: { nextId: () => 1 }, session: 's', now: () => 0 })

    const event = stamper.stamp('tool.decision', {
      call: 14,
      decision: 'approve',
      decider: 'user',
      elapsedMs: 3,
    })

    expect(event.kind).toBe('tool.decision')
    // 消费侧只按 kind 判别即可收窄——**无须强转**（判别联合视图的红利，M01 落码）
    if (event.kind !== 'tool.decision') throw new Error('kind 收窄失败')
    const data: EventDataOf['tool.decision'] = event.data
    const kind: EventKind = event.kind
    expect(kind).toBe('tool.decision')
    expect(data.decision).toBe('approve')
    expect(data.call).toBe(14)
  })
})

describe('执行域——单根＝启动目录（缺省）／多根＝配置接管（阶段 3）', () => {
  test('注册根是**真路径**——装配对外报的、提示词注入的、沙箱认的是同一个', () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble()

      // 入参是 `mkdtemp` 给的 /var/… 路径；执行域构造时取 realpath（macOS 上 /private/var/…）
      expect(assembly.workspaceRoots).toEqual([realpathSync(stage.workspace)])
      // 且确实是「说过要一致」的那一个：提示词注入的 cwd 与沙箱缺省 cwd 都取它
      //   （后一条由下方 `pwd` 用例实证）

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('配置**没有** `workspaceRoots` 键 → 回落启动目录（阶段 1 姿态原样）', () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble()

      expect(assembly.workspaceRoots).toHaveLength(1)
      expect(assembly.workspaceRoots[0]).toBe(realpathSync(stage.workspace))

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('配置**有** `workspaceRoots` → 整组接管（不再并入启动目录）', () => {
    // 「键在即接管」——启动目录是 `stage.workspace`，两根本不含它：若还悄悄塞进去，
    // 注册的东西就没人说得清（见契约 `WorkspaceRoots`）
    const extra = tempDir('magic-extra-')

    try {
      const stage = makeStage({ config: { workspaceRoots: [extra] } })
      try {
        const assembly = stage.assemble()

        expect(assembly.workspaceRoots).toEqual([realpathSync(extra)])
        expect(assembly.workspaceRoots).not.toContain(realpathSync(stage.workspace))

        assembly.close()
      } finally {
        stage.dispose()
      }
    } finally {
      removeDir(extra)
    }
  })

  test('多根——**默认根＝列表第一项**，序保声明序（`roots()` 是规范形）', () => {
    const [first, second] = [tempDir('magic-a-'), tempDir('magic-b-')]

    try {
      const stage = makeStage({ config: { workspaceRoots: [first, second] } })
      try {
        const assembly = stage.assemble()

        expect(assembly.workspaceRoots).toEqual([realpathSync(first), realpathSync(second)])
        // 提示词注入的 cwd ＝ 第一条（相对路径与新文件落它）——由下方 `pwd` 用例实证

        assembly.close()
      } finally {
        stage.dispose()
      }
    } finally {
      removeDir(first)
      removeDir(second)
    }
  })

  test('`exec` 的缺省 cwd ＝ **默认根**（多根下＝第一项，不是启动目录也不是第二根）', async () => {
    const [first, second] = [tempDir('magic-a-'), tempDir('magic-b-')]

    try {
      // 故意让第一项 ≠ 启动目录（`stage.workspace`）
      const stage = makeStage({ config: { workspaceRoots: [second, first] } })
      try {
        const assembly = stage.assemble({
          turns: [{ toolCalls: [{ name: 'exec', args: { cmd: 'pwd' } }] }, { text: '好' }],
        })
        const shell = attachShell(assembly.shell)

        await shell.submit('我在哪')
        shell.dispose()
        assembly.close()

        const result = eventsOfKind(shell.events, 'tool.result')[0]
        const text = (result?.data.output as { text: string }).text.trim()
        expect(text).toBe(realpathSync(second)) // 列表第一项——「默认根」那一位
        expect(text).not.toBe(realpathSync(stage.workspace))
      } finally {
        stage.dispose()
      }
    } finally {
      removeDir(first)
      removeDir(second)
    }
  })

  test('不合格的根 → 装配期抛，且抛的是 **`ConfigError`**（＝入口打「配置有问题：」那一条）', () => {
    // 四项校验的**语义**那三条（相对 / 不存在 / 空列表）；「不是目录」「重复」由
    // 执行域自己的用例钉（那里头有造文件 / 造符号链接的夹具），此处只证「装机真接上了」。
    //
    // ⚠️ **要的是 `ConfigError` 这个类**，不是「抛了就算」——根的错是**配置事故**，
    // 得走入口那条一行话的通道（`cli.ts` 只认这个类，其余的裸抛出去就是三段内部栈）。
    // 故这里连类一起钉：倒回普通 `Error`，本用例当场红。
    const cases: readonly (readonly string[])[] = [['relative/nope'], ['/definitely/not/here'], []]

    for (const workspaceRoots of cases) {
      const stage = makeStage({ config: { workspaceRoots } })
      try {
        expect(() => stage.assemble()).toThrow(ConfigError)
      } finally {
        stage.dispose()
      }
    }
  })

  test('`exec` 的缺省 cwd 就是装配给的启动目录', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({ turns: [{ toolCalls: [{ name: 'exec', args: { cmd: 'pwd' } }] }, { text: '好' }] })
      const shell = attachShell(assembly.shell)

      await shell.submit('我在哪')
      shell.dispose()
      assembly.close()

      const result = eventsOfKind(shell.events, 'tool.result')[0]
      expect(result?.data.ok).toBe(true)
      // 输出是**真路径**（工作区构造取 realpath——macOS 上 /tmp 实为 /private/tmp）
      const text = (result?.data.output as { text: string }).text.trim()
      expect(text).toBe(realpathSync(stage.workspace))
    } finally {
      stage.dispose()
    }
  })
})
