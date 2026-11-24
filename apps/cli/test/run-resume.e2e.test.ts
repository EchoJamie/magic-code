/**
 * U49 · **接回真跑**（真窗口 · 真 PTY · 真 `cli.ts` · 真管理者 · 真执行者 · 真模型夹具）。
 *
 * 工单那三条自行验收就落在这儿：
 * 1. **接回同一 Run**——离开期间那一段（在飞的正文）回来补齐，**执行者只有一个**；
 * 2. **多窗口**——两个窗口看同一条会话，一张卡只答一次，答完另一处**当场撤掉**；
 * 3. **已停止的会话，查看不触发重跑**——**用实际调用数证明**（不是看屏）。
 *
 * ⚠️ **每一扇窗都借同一块沙地**（`sandbox` / `fixture` 外借）：它们要落在**同一摊运行**上
 * （同一个 dataDir ⇒ 同一个管理者）——各开一块沙地就成了几个互不相干的管理者，
 * 而这三条判据全都要跨窗口看同一摊。
 */

import { describe, expect, test } from 'bun:test'
import { createUiSession, createSandbox, startFixture } from './ui/index.ts'
import type { UiSession } from './ui/index.ts'
import { tempDir, removeDir } from './tmp.ts'
import { join } from 'node:path'
import { readDatabase } from './support.ts'
import { startResidentHost } from './resident-host-fixture.ts'

describe('接回（真窗口）', () => {
  test('另一扇窗接回同一条在跑的会话——**只有一个执行者**，且在飞的那一段补齐了', async () => {
    const runs = tempDir('magic-u49-resume-runs-')
    // 一句**长出来**的回话（块多、块间慢）——「接回时那一句正说到一半」才抓得到
    const fixture = startFixture({
      turns: [{ kind: 'text', text: '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸', chunks: 12, chunkDelayMs: 400 }],
    })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const windows: UiSession[] = []
    const host = await startResidentHost(sandbox, join(runs, 'host'))

    try {
      const mine = await createUiSession({ label: '甲窗', artifacts: runs, sandbox, fixture })
      windows.push(mine)
      expect(host.executorStarts()).toBe(0)

      // **先等字打进去再回车**（`send` 只写一次、不重放；不等的话回车可能抢在它前头）
      await mine.send('说一句长话', { until: { text: '说一句长话' }, timeoutMs: 10_000 })
      await mine.key('enter')
      // 等到这一句**真开始长**（头两块已经在屏上）
      await mine.wait({ text: '一二三' }, { timeoutMs: 20_000 })

      // CLI resume 接回同一条工作；恢复不再经过另一套选项语法。
      const db = readDatabase(join(sandbox.dataDir, 'records.db'))
      let session: string
      try { session = db.sessions[0]!.id } finally { db.close() }
      const other = await createUiSession({ label: '乙窗', artifacts: runs, sandbox, fixture, argv: ['resume', session] })
      windows.push(other)
      expect(host.executorStarts()).toBe(1)
      expect(fixture.requests().length).toBe(1)

      // 接回来的那一份「此刻」：这一句的**头**（离开期间已经吐出去的那一段）就在屏上
      await other.wait({ text: '一二三' }, { timeoutMs: 20_000 })
      expect(host.executorStarts()).toBe(1)

      const resumed = await other.capture({ label: '02-接回之后' })
      expect(resumed.text).toContain('一二三')

      // **补齐**：这一句的**尾巴**随后照常接上（接回来的是同一股流，不是重新跑一遍）
      await other.wait({ text: '壬癸' }, { timeoutMs: 25_000 })

      const whole = await other.capture({ label: '03-补齐之后' })
      expect(whole.text).toContain('壬癸')

      // 完成即释放执行资源；两扇窗口仍可观察历史。
      await other.wait({ text: '○ 空闲' })
      // 模型也只被问过**一次**（接回没有重新发起那一轮）
      expect(fixture.requests().length).toBe(1)
    } finally {
      for (const window of windows) await window.close().catch(() => {})
      try { await host.close() } finally {
        await fixture.stop()
        await sandbox.dispose()
      }
      removeDir(runs)
    }
  }, 150_000)

  test('两个窗口看同一条会话：默认放行的工具只真跑一次', async () => {
    const runs = tempDir('magic-u49-decide-runs-')
    const fixture = startFixture({
      turns: [
        { kind: 'tool', name: 'exec', args: { description: '测试命令', command: 'printf u49-只跑一次' } },
        { kind: 'text', text: '收工收工' },
      ],
    })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const windows: UiSession[] = []
    const host = await startResidentHost(sandbox, join(runs, 'host'))

    try {
      const one = await createUiSession({ label: '甲窗', artifacts: runs, sandbox, fixture })
      windows.push(one)

      await one.send('跑一条命令', { until: { text: '跑一条命令' }, timeoutMs: 10_000 })
      await one.key('enter', { until: { text: 'u49-只跑一次' }, timeoutMs: 20_000 })

      const db = readDatabase(join(sandbox.dataDir, 'records.db'))
      let session: string
      try { session = db.sessions[0]!.id } finally { db.close() }

      // 第二扇窗接回同一条会话——看到的仍是同一条事实，不是另起一次执行。
      const two = await createUiSession({ label: '乙窗', artifacts: runs, sandbox, fixture, argv: ['resume', session] })
      windows.push(two)
      await two.wait({ text: 'u49-只跑一次' }, { timeoutMs: 20_000 })
      await two.wait({ text: '○ 空闲' })
      // 过程流分块回放：空闲标记先到，工具回施行后到——数之前先等它真上屏（§4：等目标事实，不信「空闲」蕴含「画完」）
      await two.wait({ text: '✓ exec(' }, { timeoutMs: 20_000 })

      expect(host.executorStarts()).toBe(1)
      expect(fixture.requests().length).toBe(2)
      const seen = await two.capture({ label: '02-接回之后' })
      // 括号里现在放的是 `description`（工具的意图那句），不再认命令首行
      const calls = seen.history.join('\n').match(/✓ exec\(/g)?.length ?? 0
      expect(calls).toBe(1)
    } finally {
      for (const window of windows) await window.close().catch(() => {})
      try { await host.close() } finally {
        await fixture.stop()
        await sandbox.dispose()
      }
      removeDir(runs)
    }
  }, 150_000)

  test('已完成（当前空闲）的会话：**查看不触发重新执行**——按实际调用数证', async () => {
    const runs = tempDir('magic-u49-view-runs-')
    const fixture = startFixture({ turns: [{ kind: 'text', text: '这一句只说一次' }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const windows: UiSession[] = []
    const host = await startResidentHost(sandbox, join(runs, 'host'))

    try {
      const first = await createUiSession({ label: '首见', artifacts: runs, sandbox, fixture })
      windows.push(first)

      await first.send('说一句', { until: { text: '说一句' }, timeoutMs: 10_000 })
      await first.key('enter', { until: { text: '这一句只说一次' }, timeoutMs: 20_000 })
      // 这一轮**收束**（状态行回到空闲）——此后这一条就是「当前空闲」
      await first.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })
      expect(fixture.requests().length).toBe(1)

      await first.quit()
      await first.close({ graceMs: 5_000 })
      windows.length = 0

      // —— 另开一扇窗，**只看**那一条 ——
      const looker = await createUiSession({ label: '回头看', artifacts: runs, sandbox, fixture })
      windows.push(looker)

      await looker.send('/resume ', { until: { text: '/resume' }, timeoutMs: 10_000 })
      await looker.key('enter', { until: { text: '打字筛' }, timeoutMs: 20_000 })

      const list = await looker.capture({ label: '01-列表上那一条' })
      expect(list.text).toContain('当前空闲')

      await looker.key('enter')
      // 记录照常铺出来（看得到当时那一句）……
      await looker.wait({ text: '这一句只说一次' }, { timeoutMs: 20_000 })

      // ……而**模型一次都没被再问过**——「查看不触发重新执行」的物证是调用数，不是屏
      expect(host.executorStarts()).toBe(1) // 不能等误起的空白执行者释放后假绿
      expect(fixture.requests().length).toBe(1)
    } finally {
      for (const window of windows) await window.close().catch(() => {})
      try { await host.close() } finally {
        await fixture.stop()
        await sandbox.dispose()
      }
      removeDir(runs)
    }
  }, 150_000)
})
