/**
 * U47 · **多执行者并发写入记录库**——判据建在**真进程**上，不建在「同一进程里调两遍」上。
 *
 * 本单元收的那件事：块预留原先「读水位 → 加一块 → 写回」是三次分开的动作，两个执行者
 * 同时预留会读到同一个水位、各自从同一个 base 发号 ⇒ **重号**。重号的后果不是数字难看：
 * 条目 / 事件表拿 id 当主键，重号＝**写不进去**（后半程当场抛），就算侥幸错开，也在
 * 「同一会话内按 id 排序」这条权威上排错。
 *
 * 故这里拉起 `WRITERS` 个**子进程**（`concurrent-writer.ts`），栅栏放行之后同时：
 * ① 真写 `ENTRIES` 条条目（每次一个事务）——用于**不漏读**；② 空转 `BURN` 个号
 * ——把「预留」那一跳**反复**撞起来（只写字条目的进程一块号用很久，相撞机会太少）。
 *
 * 三条断言各自咬一件事：
 * - **不重号**——八个执行者发过的每一个号（各自全量落盘）合起来**一个不重**；
 * - **不漏读**——父进程重开库、逐会话读回，**逐号等于**各执行者自报写下的那一串；
 * - **会话内递增**——各会话的那一串按发生先后排（号即排序权威）。
 *
 * ⚠️ 本用例**不是**「单线程跑一百遍」的替身：它要么真撞、要么白跑。为了让它真撞，
 * 空转量取得比相撞窗口大几个数量级（见 `BURN`），子进程数取到八个。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRecordsStore } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

/** 几个执行者。八个是「够挤」与「跑得动」之间的取中：相撞靠人多的概率，不靠机器快。 */
const WRITERS = 8
/** 每个执行者真写多少条条目（写进库、可读回——「不漏读」的原料）。 */
const ENTRIES = 600
/**
 * 每个执行者空转多少号。取 `ids.ts` 那块长（512）的整数倍＝**正好**压出这么多个块，
 * 即五十来次预留——相撞的机会在这一段里最密。块长是实现常量：它若改了，这一条只是
 * 「撞得少些 / 多些」，判据不受影响（号是**全量**交上来的，不靠数块）。
 */
const BURN = 512 * 50

/** 子进程那一头（`concurrent-writer.ts`）打印回来的读数。 */
type Report = {
  readonly session: string
  /** 它真写下的那一串号（按写下先后）——「不漏读」拿它当对照物。 */
  readonly written: readonly number[]
}

/** 拉起全部执行者：先等齐（栅栏），再一起放行，收齐读数与各自的发号流水。 */
async function runWriters(dataDir: string): Promise<{ reports: Report[]; issued: number[] }> {
  const go = join(dataDir, 'go')
  const children = Array.from({ length: WRITERS }, (_, index) => {
    const session = `s-${String(index).padStart(2, '0')}`
    const ready = join(dataDir, `ready-${session}`)
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'concurrent-writer.ts'),
        dataDir,
        session,
        String(ENTRIES),
        String(BURN),
        ready,
        go,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    return { proc, ready, session }
  })

  // 报到是有界等待：卡住就报出来，不无限等（同装配侧那把锁的纪律）。
  // 中途死了的也当场报出来——不然「等不到报到」会把一句 `database is locked`
  // 盖成一次超时，那就成了看着像「慢」的失败。
  const deadline = Date.now() + 30_000
  while (children.some((child) => !existsSync(child.ready))) {
    for (const child of children) {
      if (child.proc.exitCode === null) continue
      throw new Error(
        `${child.session} 没报到就退出了（码 ${child.proc.exitCode}）：` +
          `${await new Response(child.proc.stderr).text()}`,
      )
    }
    if (Date.now() > deadline) throw new Error('等不到子进程报到——并发用例没法开跑')
    await Bun.sleep(5)
  }
  writeFileSync(go, '') // 一声令下

  const reports = await Promise.all(
    children.map(async (child) => {
      // 先开始读输出（管道写满会把子进程堵在那里，而它堵着就永远不退出）
      const stdout = new Response(child.proc.stdout).text()
      const code = await child.proc.exited
      const out = await stdout
      const err = await new Response(child.proc.stderr).text()

      if (code !== 0) {
        throw new Error(
          `${child.session} 退出码 ${code}` +
            `（重号会让条目主键冲突当场抛）：${err || out}`,
        )
      }
      return JSON.parse(out) as Report
    }),
  )

  const issued = reports.flatMap((report) =>
    readFileSync(join(dataDir, `issued-${report.session}.txt`), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map(Number),
  )

  return { reports, issued }
}

describe('U47 · 多执行者并发写入（真进程）', () => {
  // 时限放宽：这一条要**起八个进程并把它们跑完**（`bun test` 的缺省时限是 5 秒，
  // 那是按「一条用例跑几毫秒」定的，不适用于「真起几个执行者」）。
  test('不重号 · 不漏读 · 会话内递增', async () => {
    const dataDir = tempDataDir()
    try {
      const { reports, issued } = await runWriters(dataDir)

      // ① 都写满了——半途而废的进程会让下面那些「不重号」变成空话
      expect(reports).toHaveLength(WRITERS)
      for (const report of reports) expect(report.written).toHaveLength(ENTRIES)

      // ② **不重号**——八个执行者发过的号合起来，一个不重（全量流水，不是摘要）
      expect(issued).toHaveLength(WRITERS * (ENTRIES + BURN))
      expect(new Set(issued).size).toBe(issued.length)

      // ③ **会话内递增**——本会话那一串按发生先后排（号是会话内的排序权威）
      for (const report of reports) {
        expect(report.written).toEqual([...report.written].sort((a, b) => a - b))
      }

      // ④ **不漏读**——另开一个连接逐会话读回，**逐号等于**各自自报写下的那一串
      const store = createRecordsStore({ dataDir, workspace: [dataDir] })
      try {
        for (const report of reports) {
          const back: number[] = []
          for await (const entry of store.readEntries(report.session)) back.push(entry.id)
          expect(back).toEqual([...report.written])
        }
      } finally {
        store.close()
      }
    } finally {
      removeDataDir(dataDir)
    }
  }, 120_000)
})
