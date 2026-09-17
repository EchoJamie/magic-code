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
import { realpathSync } from 'node:fs'
import { attachShell } from '../src/index.ts'
import type { KernelEvent } from '@magic/contracts'
import { eventsOfKind, kindTrail, lastModel, makeStage, readDatabase } from './support.ts'

/** 瞬时类——实时订阅专用，**不落库**（记录 schema v0 规则 ①）。 */
const TRANSIENT = ['model.delta', 'tool.output.delta'] as const

describe('全链冒烟（Faux 模型 ＋ 真沙箱 / 真闸门 / 真记录 / 真控制）', () => {
  test('交代 → 模型 → 工具（经闸门）→ 回填 → 收束，全过程落库', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble()
      // 假外壳：**先订阅、后放开输入**（`attachShell` 里订阅，`submit` 才发命令）
      const shell = attachShell(assembly.shell)

      await shell.submit('跑一下 echo')
      shell.dispose()
      assembly.close()

      const events = shell.events
      const trail = kindTrail(events)
      const at = (kind: string): number => trail.indexOf(kind)

      // —— 1 链走通：五步各自到场，且**次序**对 ——
      for (const kind of [
        'agent.start',
        'message.user',
        'turn.start',
        'model.call.start',
        'model.call.end',
        'tool.call',
        'tool.decision.request',
        'tool.decision',
        'tool.result',
        'message.assistant',
        'turn.end',
        'agent.state',
      ]) {
        expect(trail).toContain(kind)
      }

      // 交代先落账，再开轮；轮内：模型 → 工具 → 回填 → 收束
      expect(at('message.user')).toBeLessThan(at('turn.start'))
      expect(at('model.call.start')).toBeLessThan(at('tool.call'))
      expect(at('tool.call')).toBeLessThan(at('tool.decision.request'))
      expect(at('tool.decision.request')).toBeLessThan(at('tool.decision'))
      expect(at('tool.decision')).toBeLessThan(at('tool.result'))

      // 两轮（模型调了工具 → 回填后**再调一次**才收束），各自成轮
      expect(eventsOfKind(events, 'turn.start')).toHaveLength(2)
      expect(eventsOfKind(events, 'turn.end')).toEqual([
        expect.objectContaining({ data: { reason: 'settled' } }),
        expect.objectContaining({ data: { reason: 'settled' } }),
      ])

      // 起 · 干活 · 回到等待输入——状态转场齐全
      expect(eventsOfKind(events, 'agent.state').map((e) => e.data.state)).toEqual([
        'resumed',
        'waiting',
      ])

      // —— 2 经闸门：裁决真被问了、答复真配对 ——
      expect(shell.decisions).toHaveLength(1)
      const request = eventsOfKind(events, 'tool.decision.request')[0]
      expect(request).toBeDefined()
      // 配对键＝**请求事件**的 id；载荷里的 `call` 是另一个空间（链引用）
      expect(shell.decisions[0]?.id).toBe(request?.id)
      expect(request?.data.name).toBe('exec')
      // 判断材料给足了（命令分解）——呈现轻重的判据在权限域，此处只认它非空
      expect(request?.data.material).toContain('echo hello-magic')

      // —— 3 回填送达：**第二次**模型调用的上下文里躺着这次工具结果 ——
      const toolResult = eventsOfKind(events, 'tool.result')[0]
      expect(toolResult?.data.ok).toBe(true)

      const requests = lastModel(stage).requests
      expect(requests).toHaveLength(2)
      const refilled = requests[1]?.messages.at(-1)
      expect(refilled).toMatchObject({ role: 'tool', name: 'exec', ok: true })
      expect((refilled as { output: string }).output).toContain('hello-magic')

      // 提示词注入三件**由装配给**（`cwd` ＝启动目录、平台 / 日期取环境）——
      // 系统提示词是首条消息，注入值在环境块里逐行现形
      const system = requests[0]?.messages[0]
      expect(system?.role).toBe('system')
      const prompt = (system as { content: string }).content
      expect(prompt).toContain(`工作目录：${realpathSync(stage.workspace)}`)
      expect(prompt).toContain('平台：darwin')
      expect(prompt).toContain('日期：2026-09-18')
      // 工具结果条目与事件的 `output` **同物**（契约 `ToolResult.content` 的口径）
      expect(toolResult?.data.output).toEqual({ text: 'hello-magic\n' })

      // —— 4 瞬时类只走订阅、不进库 ——
      for (const kind of TRANSIENT) {
        expect(trail).toContain(kind)
      }

      // ══ 记录可直读：关库后拿裸 sqlite 打开文件，全过程看得见 ══
      const raw = readDatabase(assembly.paths.database)
      try {
        expect(raw.sessions.map((s) => s.id)).toEqual([assembly.session])

        // 事件表＝持久类（瞬时类**不在**）
        const kinds = raw.events.map((row) => row.kind)
        for (const kind of TRANSIENT) {
          expect(kinds).not.toContain(kind)
        }
        expect(kinds).toEqual(trail.filter((kind) => !TRANSIENT.includes(kind as never)))

        // 每行都归本会话，且信封的轮号语义对：轮外（message.user）为 NULL，轮内的都有号
        expect(raw.events.every((row) => row.session === assembly.session)).toBe(true)
        expect(raw.events.find((row) => row.kind === 'message.user')?.turn).toBeNull()
        expect(raw.events.filter((row) => row.kind === 'turn.start').every((row) => row.turn !== null)).toBe(true)

        // 条目表＝内容流，按 id 序即发生序：
        //   交代 → 第一轮助手的产出（本轮是**纯工具调用**，正文为空——但「模型说了什么」
        //   仍成条：事件只记「发生 + 引用」，内容得有条目可引）→ 工具调用 → 工具结果 → 收束语
        expect(raw.entries.map((row) => row.kind)).toEqual([
          'user',
          'assistant',
          'tool-call',
          'tool-result',
          'assistant',
        ])
        expect(raw.entries[1]?.content_text).toBe('')

        const toolCall = raw.entries.find((row) => row.kind === 'tool-call')
        expect(JSON.parse(toolCall?.payload ?? '{}')).toEqual({
          name: 'exec',
          args: { cmd: 'echo hello-magic' },
        })

        const toolResultRow = raw.entries.find((row) => row.kind === 'tool-result')
        const resultPayload = JSON.parse(toolResultRow?.payload ?? '{}') as {
          ok: boolean
          output: { text: string }
        }
        expect(resultPayload.ok).toBe(true)
        expect(resultPayload.output.text).toContain('hello-magic')

        // 事件的 id 与条目的 id **同一空间**（记录域拥有）——故两表 id 不重叠、整体单调
        const ids = [...raw.events.map((row) => row.id), ...raw.entries.map((row) => row.id)]
        expect(new Set(ids).size).toBe(ids.length)
      } finally {
        raw.close()
      }
    } finally {
      stage.dispose()
    }
  })

  test('拒绝路径——被拒的调用不执行，以「拒绝」回填', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble()
      const shell = attachShell(assembly.shell, { decide: () => 'reject' })

      await shell.submit('跑一下 echo')
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
