/**
 * U50 · **自有进程组的归属与收尾**——那一层的真进程用例。
 *
 * 这一支量的全是**真进程**（`sh -c` 起、自成一组）：假 pid 判定不了「有界等待 → TERM →
 * KILL → 等待退出」到底有没有走完，也判定不了「有没有误杀」。
 *
 * 四条判据（对应设计那一行「仅操作**已证明归属**的进程/组，**PID 重用不能误杀**」）：
 *
 * 1. **账是活的**——起的记一笔，组没了自己摘掉（越记越长的册子不是账）；
 * 2. **不理会 TERM 的组**：TERM → 有界等 → KILL → 等，**只碰这一组**（邻居一个不动）；
 * 3. **PID 重用**：号上站着的是别人的进程（启动时刻对不上）⇒ **一个信号都不发**；
 * 4. **组长没了、组里还有**：证实不了归属 ⇒ **不动**，并如实说（不冒充「收到了」）。
 */

import { describe, expect, test } from 'bun:test'
import {
  createProcessLedger,
  groupAlive,
  reapOwned,
  sameProcess,
  signalGroup,
  startTimeOf,
} from '@magic/execution'

/** 起一组真进程（自成一组，组长 ＝ 返回的那个 pid）——用例自己收尾，不留残骸。 */
function spawnGroup(script: string): { readonly pid: number; kill(): void } {
  const child = Bun.spawn(['sh', '-c', script], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  })
  return {
    pid: child.pid,
    kill() {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // 已经没了
      }
      try {
        child.kill('SIGKILL')
      } catch {
        // 同上
      }
    },
  }
}

/** 等一个条件成立（默认 5 秒）——轮询是用例的事。 */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(20)
  }
}

describe('U50 · 自有进程的账与收尾', () => {
  test('记一笔：组长身份当场读下；组没了账自己摘掉', async () => {
    const ledger = createProcessLedger()
    const group = spawnGroup('sleep 30')

    try {
      ledger.add({ pgid: group.pid, what: 'exec:sleep 30' })
      const [one] = ledger.list()

      expect(one?.pgid).toBe(group.pid)
      expect(one?.what).toBe('exec:sleep 30')
      // **身份那一位不是空的**——收尾时全靠它（读不到就证明不了归属）
      expect(typeof one?.startedAt).toBe('number')
      // 与操作系统自己说的对得上
      expect(one?.startedAt).toBe(startTimeOf(group.pid) as number)
    } finally {
      group.kill()
    }

    // 组没了 ⇒ 账上不该再留着它（账随生死走）
    await waitFor('摘掉', () => ledger.list().length === 0)
  })

  test('不理会 TERM 的组：TERM → KILL → 等退出；隔壁那一组一个指头都不碰', async () => {
    const shouty = spawnGroup('trap "" TERM; sleep 30')
    const neighbour = spawnGroup('sleep 30')

    try {
      // 等它把 trap 挂上（不然 TERM 可能赶在 trap 之前到，那一枪就白打了）
      await Bun.sleep(200)
      const handle = { pgid: shouty.pid, startedAt: startTimeOf(shouty.pid), what: 'exec:trap TERM' }

      const outcome = await reapOwned(handle, { settleMs: 100, termMs: 300, killMs: 2_000 })

      expect(outcome.kind).toBe('reaped')
      expect(groupAlive(shouty.pid)).toBe(false)
      // **只碰证明得了归属的那一组**——邻居照旧站着
      expect(groupAlive(neighbour.pid)).toBe(true)
    } finally {
      shouty.kill()
      neighbour.kill()
    }
  })

  test('PID 重用：号上站着别人的进程 ⇒ 一个信号都不发', async () => {
    const alive = spawnGroup('sleep 30')

    try {
      // 一笔**故意对不上**的账：号是真的（这条进程真站着），可是「组长启动时刻」报成
      // 一小时前——那正是「号被回收再分配」在现场的样子
      const stale = {
        pgid: alive.pid,
        startedAt: (startTimeOf(alive.pid) as number) - 3_600_000,
        what: 'exec:早就不在的那一条',
      }

      const outcome = await reapOwned(stale, { settleMs: 50, termMs: 100, killMs: 100 })

      expect(outcome.kind).toBe('stranger')
      // 判据与现场一致，且**人还活着**（误杀就是在这儿发生的）
      expect(sameProcess(stale, startTimeOf(alive.pid))).toBe(false)
      expect(groupAlive(alive.pid)).toBe(true)
    } finally {
      alive.kill()
    }
  })

  test('组长没了、组里还有人：证实不了归属 ⇒ 不动它（并如实说）', async () => {
    // 组长自己退，留下的那个孙子仍在**同一组**里（`detached` 的组跟着组长走，不跟着退出走）
    const orphaned = spawnGroup('sleep 30 & exit 0')
    const groupPid = orphaned.pid

    try {
      await waitFor('组长退了', () => startTimeOf(groupPid) === undefined)
      expect(groupAlive(groupPid)).toBe(true) // 组还在（孙子那一支）

      const outcome = await reapOwned(
        { pgid: groupPid, startedAt: undefined, what: 'exec:组长先走的那个' },
        { settleMs: 50, termMs: 100, killMs: 100 },
      )

      expect(outcome.kind).toBe('unprovable')
      expect(outcome.kind === 'unprovable' ? outcome.note : '').toContain('证实不了')
      // **没动它**——这一条正是「拿不准的不杀」
      expect(groupAlive(groupPid)).toBe(true)
    } finally {
      signalGroup(groupPid, 'SIGKILL')
      orphaned.kill()
    }
  })
})
