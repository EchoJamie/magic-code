/**
 * U48 · **启动竞争的独立一方**——被 `run-manager.test.ts` 用子进程拉起，不自己跑。
 *
 * 为什么非要子进程：「同一用户、同一规范化 dataDir 只有一个管理者」这句话说的是
 * **两个进程**之间的事。同一进程里先后调两次是顺序的，证不了任何竞争——只有真进程
 * 才是真的一方。故这里是一支「只做一件事」的小脚本：算路径 → 在栅栏上等 →
 * 起管理者（或认出已经有的那一个）→ 把结论打出去 → 当上管理者的那个**守着不退**。
 *
 * 栅栏（`ready` / `go`）是为了让竞争真的发生：每个子进程都要先跑几十毫秒的模块装载，
 * 先放跑的那个早占上了，晚的六个就只是在做「顺序的后手」。故各先报到，再一起放行。
 *
 * ⚠️ **结论落文件，不落 stdout**：当上的那个**守着不退**，它的 stdout 也就一直开着——
 * 父进程「等 stdout 到头再读」会当场挂死（第一版就是这么挂的）。落文件之后父进程
 * 按「文件出现没有」收，与那个进程还开不开着 stdout 再无关系。
 *
 * 用法：`bun run-manager-child.ts <home> <base> <dataDir> <tmpdir> <ready> <go> <result>`
 */

import { existsSync, writeFileSync } from 'node:fs'
import { runPathsOf } from '../src/run/paths.ts'
import { startManager } from '../src/run/manager.ts'
import type { ExecutorLauncher } from '../src/run/manager.ts'

const [home, base, dataDir, tmpdir, readyFile, goFile, resultFile] = process.argv.slice(2)
if (
  home === undefined ||
  base === undefined ||
  dataDir === undefined ||
  tmpdir === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  resultFile === undefined
) {
  throw new Error('用法：run-manager-child.ts <home> <base> <dataDir> <tmpdir> <ready> <go> <result>')
}

/** 这一段（立管理者）用不到执行者——真起执行者的是第二段那条用例。 */
const launch: ExecutorLauncher = {
  launch() {
    throw new Error('这一段不该有人要执行者')
  },
}

const paths = runPathsOf({ home, base }, dataDir, tmpdir)

writeFileSync(readyFile, '')
while (!existsSync(goFile)) Bun.sleepSync(1) // 栅栏——等到一声令下

const started = await startManager({ paths, dataDir, launch })

if (started.role !== 'manager') {
  writeFileSync(resultFile, JSON.stringify({ role: started.role, socket: paths.socket }))
  process.exit(0)
}

writeFileSync(resultFile, JSON.stringify({ role: 'manager', pid: process.pid, socket: paths.socket }))

// 当上的那个**守着不退**——父进程要的正是「有且只有一个还活着」这个状态。
// 收摊走管理者的路（socket 摘掉、自报那一份清掉），别用 `process.exit` 绕过它：
// 绕过的话 socket 文件留在盘上，下一条用例读到的是个尸首。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => started.manager.stop(`收到 ${signal}`))
}

await started.manager.waitUntilExit()
process.exit(0)
