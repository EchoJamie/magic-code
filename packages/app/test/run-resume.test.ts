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
import type { Sandbox, UiSession } from './ui/index.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 等一个条件成立（默认 15 秒）——轮询是用例的事，产品那几跳都是事件驱动的。 */
async function waitFor(
  what: string,
  ok: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(100)
  }
}

/**
 * 沙地里还有几个**执行者**——一个会话至多一个，正是这几条判据要数的东西。
 *
 * ⚠️ **只在「静下来之后」数**：一扇还没有目标的窗口按 `/resume`，目录那一条命令是要
 * 「有人答」才回得来的（记录域的事实握在执行者手里的内核上），故它会先起一代——
 * 那一代答完就收缩（没有连接者、手上也没事）。判据要的是**稳态**：那一条会话的执行者
 * 只有一个（接回**没有另起一个**），而不是「这一刻机器上恰好只有一个进程」。
 */
async function executorsIn(sandbox: Sandbox): Promise<number> {
  const proc = Bun.spawn(['pgrep', '-fl', sandbox.root], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited

  return text
    .split('\n')
    .filter((line) => line.includes('internal-executor')).length
}

describe('U49 · 接回（真窗口）', () => {
  test('另一扇窗接回同一条在跑的会话——**只有一个执行者**，且在飞的那一段补齐了', async () => {
    const runs = tempDir('magic-u49-resume-runs-')
    // 一句**长出来**的回话（块多、块间慢）——「接回时那一句正说到一半」才抓得到
    const fixture = startFixture({
      turns: [{ kind: 'text', text: '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸', chunks: 12, chunkDelayMs: 400 }],
    })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const windows: UiSession[] = []

    try {
      const mine = await createUiSession({ label: '甲窗', artifacts: runs, sandbox, fixture })
      windows.push(mine)

      // **先等字打进去再回车**（`send` 只写一次、不重放；不等的话回车可能抢在它前头）
      await mine.send('说一句长话', { until: { text: '说一句长话' }, timeoutMs: 10_000 })
      await mine.key('enter')
      // 等到这一句**真开始长**（头两块已经在屏上）
      await mine.wait({ text: '一二三' }, { timeoutMs: 20_000 })

      // —— 另一扇窗**接回来** ——
      const other = await createUiSession({ label: '乙窗', artifacts: runs, sandbox, fixture })
      windows.push(other)

      await other.send('/resume', { until: { text: '/resume' }, timeoutMs: 10_000 })
      // 等**抽屉真开出来**（锚它自己的键位提示——屏上别处没有这串字）
      await other.key('enter', { until: { text: '打字筛' }, timeoutMs: 20_000 })

      // 列表上那一条正跑着（U49 的那一行状态与动作）
      const list = await other.capture({ label: '01-接回前那张列表' })
      expect(list.text).toContain('执行中')
      expect(list.text).toContain('正在等')
      expect(list.text).toContain('说一句长话')

      // 选定它——接回同一条会话
      await other.key('enter')
      // 接回来的那一份「此刻」：这一句的**头**（离开期间已经吐出去的那一段）就在屏上
      await other.wait({ text: '一二三' }, { timeoutMs: 20_000 })

      const resumed = await other.capture({ label: '02-接回之后' })
      expect(resumed.text).toContain('一二三')

      // **补齐**：这一句的**尾巴**随后照常接上（接回来的是同一股流，不是重新跑一遍）
      await other.wait({ text: '壬癸' }, { timeoutMs: 25_000 })

      const whole = await other.capture({ label: '03-补齐之后' })
      expect(whole.text).toContain('壬癸')

      // **只有一个执行者**——接回不是「另起一个」，它就是那一条在跑的（稳态：目录那一代已收缩）
      await waitFor('只剩一条执行者', async () => (await executorsIn(sandbox)) === 1)
      // 模型也只被问过**一次**（接回没有重新发起那一轮）
      expect(fixture.requests().length).toBe(1)
    } finally {
      for (const window of windows) await window.close().catch(() => {})
      await fixture.stop()
      sandbox.dispose()
      removeDir(runs)
    }
  }, 150_000)

  test('两个窗口看同一条会话：一张卡只答一次，答完另一处**当场撤掉**', async () => {
    const runs = tempDir('magic-u49-decide-runs-')
    const fixture = startFixture({
      turns: [
        { kind: 'tool', name: 'exec', args: { cmd: 'echo u49-只跑一次' } },
        { kind: 'text', text: '跑完了' },
      ],
    })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const windows: UiSession[] = []

    try {
      const one = await createUiSession({ label: '甲窗', artifacts: runs, sandbox, fixture })
      windows.push(one)

      await one.send('跑一条命令', { until: { text: '跑一条命令' }, timeoutMs: 10_000 })
      await one.key('enter', { until: { text: 'y / a / n' }, timeoutMs: 20_000 })

      // 第二扇窗接回同一条会话——那一张卡**也在它屏上**（快照带回来的「待答项」）
      const two = await createUiSession({ label: '乙窗', artifacts: runs, sandbox, fixture })
      windows.push(two)

      await two.send('/resume', { until: { text: '/resume' }, timeoutMs: 10_000 })
      await two.key('enter', { until: { text: '打字筛' }, timeoutMs: 20_000 })

      // 列表上那一条写着「需要你」（U49 的第一段）
      const asking = await two.capture({ label: '01-列表上那一条在等你' })
      expect(asking.text).toContain('需要你')

      await two.key('enter')
      await two.wait({ text: 'y / a / n' }, { timeoutMs: 20_000 })

      const both = await two.capture({ label: '01-两个窗口都挂着这张卡' })
      expect(both.text).toContain('y / a / n')

      // **甲窗答复**——乙窗那张卡应当**当场撤掉**（同一件事实，两个窗口各画一份）
      await one.send('y')
      await two.wait({ absent: 'y / a / n' }, { timeoutMs: 20_000 })

      const gone = await two.capture({ label: '02-另一处已撤掉' })
      expect(gone.text).not.toContain('y / a / n')
      // 而那一件工具**真跑了一次**（结果在屏上）
      await two.wait({ text: 'u49-只跑一次' }, { timeoutMs: 20_000 })

      await waitFor('只剩一条执行者', async () => (await executorsIn(sandbox)) === 1)
    } finally {
      for (const window of windows) await window.close().catch(() => {})
      await fixture.stop()
      sandbox.dispose()
      removeDir(runs)
    }
  }, 150_000)

  test('已停止（当前空闲）的会话：**查看不触发重新执行**——按实际调用数证', async () => {
    const runs = tempDir('magic-u49-view-runs-')
    const fixture = startFixture({ turns: [{ kind: 'text', text: '这一句只说一次' }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const windows: UiSession[] = []

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

      await looker.send('/resume', { until: { text: '/resume' }, timeoutMs: 10_000 })
      await looker.key('enter', { until: { text: '打字筛' }, timeoutMs: 20_000 })

      const list = await looker.capture({ label: '01-列表上那一条' })
      expect(list.text).toContain('当前空闲')

      await looker.key('enter')
      // 记录照常铺出来（看得到当时那一句）……
      await looker.wait({ text: '这一句只说一次' }, { timeoutMs: 20_000 })

      // ……而**模型一次都没被再问过**——「查看不触发重新执行」的物证是调用数，不是屏
      await Bun.sleep(1_000)
      expect(fixture.requests().length).toBe(1)
    } finally {
      for (const window of windows) await window.close().catch(() => {})
      await fixture.stop()
      sandbox.dispose()
      removeDir(runs)
    }
  }, 150_000)
})
