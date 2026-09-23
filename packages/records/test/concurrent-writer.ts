/**
 * U47 · **并发写入用的独立执行者**——被 `concurrency.test.ts` 用子进程拉起，不自己跑。
 *
 * 为什么非要子进程：本单元治的就是「**两个执行者**同时读写同一份库」。同一进程里的两次
 * 调用是**顺序**的（`bun:sqlite` 同步），拿它证不了任何并发的事——只有一个真进程才是
 * 一个真执行者。故这里是一支「只做一件事」的小脚本：起库 → 在栅栏上等 → 写若干条目 →
 * 空转若干号 → 把**发过的每一个号**落进一个文件、把**写下的那一串**打印出去。
 *
 * 栅栏（`readyFile` / `goFile`）是**为了让并发真的发生**：八个子进程各自要跑几十毫秒的
 * 模块装载与建库，先放跑的那个早就写完收摊了。故每个先报到（`ready`），再一起放行（`go`）
 * ——相撞的窗口才落在「预留水位」那一段上。
 *
 * 发过的号**全量落文件**而不是只报个摘要：号是「唯一性」的被测物，摘要（求和 / 取首尾）
 * 都会把「两个执行者发同一批号」漏过去。全量交出去，判据就只剩一条集合比对。
 *
 * 用法：`bun concurrent-writer.ts <dataDir> <session> <条目数> <空转号数> <ready> <go>`
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordId } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'

const [dataDir, session, entriesArg, idsArg, readyFile, goFile] = process.argv.slice(2)
if (
  dataDir === undefined ||
  session === undefined ||
  readyFile === undefined ||
  goFile === undefined
) {
  throw new Error('用法：concurrent-writer.ts <dataDir> <session> <条目数> <空转号数> <ready> <go>')
}

const entries = Number(entriesArg ?? '0')
const burn = Number(idsArg ?? '0')
const T0 = 1_700_000_000_000
/** 发过的号落这儿（一行一个）——父进程据此判「不重号」。 */
const issuedPath = join(dataDir, `issued-${session}.txt`)

// 建库（＝各自把 schema、blob 目录那些一次性开销走完）**在报到之前**——报到之后只剩
// 「写」这一件事，几个子进程才挤在同一个时间窗里。
const store = createRecordsStore({ dataDir, workspace: [dataDir] })
const service = store.serviceFor(session)

writeFileSync(readyFile, '')
while (!existsSync(goFile)) Bun.sleepSync(1) // 栅栏——等到一声令下

/** 发过的每一个号——收尾时一次落盘（逐号开一次文件会把这里变成磁盘测试）。 */
const issued: RecordId[] = []

// —— 一 · 真写条目（每次一个事务：「会话行 ＋ 条目」）——
const written: RecordId[] = []
for (let i = 0; i < entries; i += 1) {
  const id = service.appendEntry({ kind: 'user', content: { text: `${session} 的第 ${i} 条` }, at: T0 + i })
  written.push(id)
  issued.push(id)
}

// —— 二 · 空转号（把「块预留」那一跳**反复**撞起来）——
//
// 只写字条目的进程一块号用很久，相撞的机会就少；空转把「预留」压成一件高频的事。
// ⚠️ 号本身**不落库**（瞬时事件也吃号，故发号与落库本就不是一回事，见 `ids.ts`），
// 故这一段只吃号、不写条目——它是把水位推上去，不是伪造记录。
for (let i = 0; i < burn; i += 1) issued.push(service.nextId())

store.close()
writeFileSync(issuedPath, issued.join('\n'))
console.log(JSON.stringify({ session, written }))
