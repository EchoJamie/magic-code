/**
 * U11 · 装配根 —— 判据：**顺序纪律** · **扇出** · **铸造器按会话实例**（id 取自记录域）。
 *
 * 三条都不是「实现细节」：顺序反了＝用户输入无声丢失；扇出错了＝记录缺过程；
 * 铸造器接错了＝同一张库里两串 id（裁决配对当场断）。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, realpathSync } from 'node:fs'

import { attachShell } from '../src/index.ts'
import { eventsOfKind, kindTrail, lastModel, makeStage, readDatabase } from './support.ts'
import { removeDir, tempDir } from './tmp.ts'

describe('顺序纪律——先接订阅、后放开输入', () => {
  test('未订阅时的事件推送**丢弃**（不排队、不补发）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble()

      // ① 装配完成、**还没订阅**——此刻放开输入
      assembly.shell.send({ type: 'input.submit', text: '早了一步' })
      const deadline = Date.now() + 3000
      for (;;) {
        if (existsSync(assembly.paths.database)) {
          const records = readDatabase(assembly.paths.database)
          const ended = records.events.some(event => event.kind === 'turn.end')
          records.close()
          if (ended && !assembly.hasPendingInput()) break
        }
        if (Date.now() >= deadline) throw new Error('未订阅回合未结束')
        await Bun.sleep(5)
      }

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

      // 装配不发事件；首次提交可先发布只读后台快照，输入仍先受理再开工。
      expect(shell.events).toHaveLength(0)

      await shell.submit('第一条')
      const first = shell.events.find(event => event.kind !== 'background.state')
      expect(first?.kind).toBe('input.settled')
      expect(first?.kind === 'input.settled' && first.data.stage).toBe('accepted')

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
        expect(stored).toEqual(trail.filter((k) => !['background.state','model.delta','tool.output.delta','input.pending','input.settled'].includes(k)))
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
        (event) => !['background.state','model.delta','tool.output.delta','input.pending','input.settled'].includes(event.kind),
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

describe('执行域——单根＝启动目录（缺省）／多根＝配置接管（阶段 3）', () => {

  /**
   * U27 · **提示词报全根列表**（`U18` 待决 5）——多根下模型不知道另几条根存在时，
   * 只有当它给出越界绝对路径才从报文里知道 ⇒ **一开始就报全**（一行提示词的成本，
   * 换少撞几次越界）。默认根标出来（相对路径与新文件落它），其余根逐个列出。
   */
  test('提示词的 `cwd` 报**全根列表**（多根——默认根标出、其余根在列）', async () => {
    const [first, second] = [tempDir('magic-u27-a-'), tempDir('magic-u27-b-')]

    try {
      const stage = makeStage({ config: { workspaceRoots: [first, second] } })
      try {
        const assembly = stage.assemble()
        const shell = attachShell(assembly.shell)
        await shell.submit('看看这儿有什么')

        // 系统提示词是首条消息（`requests` 留痕——同 `smoke.test.ts` 那一跳）
        const system = lastModel(stage).requests[0]?.messages[0]
        expect(system?.role).toBe('system')
        const prompt = (system as { content: string }).content

        expect(prompt).toContain(
          `工作目录：${realpathSync(first)}（默认根——相对路径与新文件落它）` +
            ` · 另注册：${realpathSync(second)}`,
        )

        shell.dispose()
        assembly.close()
      } finally {
        stage.dispose()
      }
    } finally {
      removeDir(first)
      removeDir(second)
    }
  })

  test('单根——那一行**不加前后缀**（不为多根这条功能给单根长噪音）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble()
      const shell = attachShell(assembly.shell)
      await shell.submit('看看这儿有什么')

      const system = lastModel(stage).requests[0]?.messages[0]
      const prompt = (system as { content: string }).content

      // 值就是那条根本身——行以换行收（环境块逐行一项）
      expect(prompt).toContain(`- 工作目录：${realpathSync(stage.workspace)}\n`)

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
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
