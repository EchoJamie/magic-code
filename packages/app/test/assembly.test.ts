/**
 * U11 · 装配根 —— 判据：**顺序纪律** · **扇出** · **铸造器按会话实例**（id 取自记录域）。
 *
 * 三条都不是「实现细节」：顺序反了＝用户输入无声丢失；扇出错了＝记录缺过程；
 * 铸造器接错了＝同一张库里两串 id（裁决配对当场断）。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventDataOf, EventKind, KernelEvent } from '@magic/contracts'
import { ConfigError, attachShell, createStamper } from '../src/index.ts'
import { eventsOfKind, makeStage } from './support.ts'
import { removeDir, tempDir } from './tmp.ts'

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

  /**
   * U27 · **非规范形落点一路通到沙箱**（`U18` 待决 4）——模型给的声明原形不再被误判越界。
   *
   * 夹具照 macOS 的 `/tmp` → `/private/tmp`：**声明原形**经符号链接指向真目录。
   * 这条链上（工作区注册 → 工具的参数 → 沙箱的 `resolve`）每一跳都得认它——只认规范形
   * 正是本单元要收的那个坑（**模型照用户手写的路径给**，却被判越界）。
   *
   * 走 `read` 而不走 `exec`：**模型手上没有 `exec.cwd` 这个参数**（参数键只锚了 `cmd`——
   * 技术方案 · 工具 · 参数键）；`exec.cwd` 那一跳（内部调用者才走）由 `exec.test.ts` 钉。
   */
  test('模型给的**声明原形绝对路径**通得到真文件（U27——多根激活的那个坑）', async () => {
    const real = tempDir('magic-u27-real-')
    const choice = join(tempDir('magic-u27-choice-'), 'proj')
    symlinkSync(real, choice)
    mkdirSync(join(real, 'sub'))
    writeFileSync(join(real, 'sub', 'note.txt'), 'non-canonical-ok\n')

    try {
      const stage = makeStage({ config: { workspaceRoots: [choice] } })
      try {
        const assembly = stage.assemble({
          turns: [
            // 路径取**声明原形**（用户写在配置里的那个写法）——只比规范形时这里判越界
            { toolCalls: [{ name: 'read', args: { path: join(choice, 'sub', 'note.txt') } }] },
            { text: '读到了' },
          ],
        })
        const shell = attachShell(assembly.shell)

        await shell.submit('读一下那儿的东西')
        shell.dispose()
        assembly.close()

        const result = eventsOfKind(shell.events, 'tool.result')[0]
        // 判成越界时是 `ok: false` ＋ 报文（沙箱侧抛精确报文，工具边界收敛为判别式）
        expect(result?.data.ok).toBe(true)
        expect((result?.data.output as { text: string }).text).toContain('non-canonical-ok')
      } finally {
        stage.dispose()
      }
    } finally {
      removeDir(real)
      removeDir(choice)
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
})
