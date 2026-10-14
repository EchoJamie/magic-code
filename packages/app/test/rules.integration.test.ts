/**
 * U32 · 项目规约 —— **真装配的端到端**。
 *
 * 判据落在四样真东西上（不是解析器的自证）：
 * - **真模型请求**——`lastModel(stage).requests[i].messages` 就是送去模型的那一份；
 * - **真文件副作用**——工具经真沙箱落盘，写没写、写了几次看盘上那份文件；
 * - **真配置**——`rules.sources` 走真的加载器进装配（漏接＝静默失效，这条用例咬住它）；
 * - **真 CLI 帧**——`--check` 那一行真是屏幕上的字。
 *
 * 沙地三块（数据目录 / 工作区 / 配置）都由 `makeStage` 落在唯一临时目录里，
 * 家目录与授权文件同样在沙地里——不碰任何真东西。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createView, reduce } from '@magic/tui'
import type { ShellView } from '@magic/tui'

import { attachShell } from '../src/index.ts'
import { makeStage } from './support.ts'

describe('真装配 · 「没跑」与「跑了没成」分得开（2026-09-20 三轮裁）', () => {
  test('**真执行并失败**、输出首行写着「未执行后续步骤」——照旧失败，耗时保留', async () => {
    const stage = makeStage()

    try {
      // 真跑一次：写下一个文件（副作用真的发生了）＋ 打一行以「未执行」起头的输出 ＋ 非 0 退出
      const call = {
        name: 'exec',
        args: {
          cmd: 'echo SIDE_EFFECT > side-effect.txt; echo "未执行后续步骤：前一步已经写入，但校验失败"; exit 1',
        },
      }
      const assembly = stage.assemble({ turns: [{ toolCalls: [call] }, { text: '没成' }] })
      const shell = attachShell(assembly.shell)
      await shell.submit('跑一下')

      // —— ① 它**真的跑了**：盘上那份文件就是证据 ——
      expect(existsSync(join(stage.workspace, 'side-effect.txt'))).toBe(true)

      // —— ② 产生处**没**说它「没跑」：事件上一位都不带 ——
      const results = shell.events.filter((event) => event.kind === 'tool.result')
      expect(results[0]?.data).toMatchObject({ ok: false })
      expect((results[0]?.data as { notExecuted?: true }).notExecuted).toBeUndefined()

      // —— ③ 屏上：**失败**（那个叉）＋ **耗时保留** ——
      // 旧判据按正文首行认「没跑」——这一笔的首行正好以「未执行」起头，于是真跑过的一次
      // 调用被画成「压根没动手」、耗时被抹掉。状态从此只看产生处那一位，不看这行字
      const view: ShellView = shell.events.reduce((acc, event) => reduce(acc, event), createView())
      const tools = view.settled.filter((row) => row.kind === 'tool')

      expect(tools[0]?.state).toBe('failed')
      expect(tools[0]?.elapsedMs).not.toBe(null)
      expect(tools[0]?.output[0]).toBe('未执行后续步骤：前一步已经写入，但校验失败')

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
