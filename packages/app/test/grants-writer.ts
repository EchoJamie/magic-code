/**
 * U47 · **授权文件的并发写入者**——被 `grants-concurrency.test.ts` 用子进程拉起，不自己跑。
 *
 * 为什么非要子进程：本单元治的是「**两个写入者**同时改同一份 `grants.json`」。同一进程里的
 * 两次落盘是**顺序**的，拿它证不了任何并发的事——只有一个真进程才是一个真写入者。
 *
 * 每个写入者做的事只有一件：把「读当前内容 → 应用一项增删 → 原子保存」**反复执行**
 * （`commitGrants`），每次加一条**只属于自己**的授权（名字里带着自己是几号）。判据因此极简：
 * N 个写入者各改 M 次，落定之后那份文件里**一条不少**。
 *
 * ⚠️ 授权里的路径**故意写得很长**：读改写的窗口就是「读文件 ＋ 解析 ＋ 序列化」那一段，
 * 文件越大窗口越宽，相撞才不是撞运气。这不是为了跑得慢，是为了让「没有锁」这件事**真的**
 * 显形（见回报里的反例读数）。
 *
 * 用法：`bun grants-writer.ts <grantsPath> <workspace> <我是几号> <条数> <ready> <go>`
 */

import { existsSync, writeFileSync } from 'node:fs'
import type { Grant } from '@magic/permission'
import { commitGrants } from '../src/grants-file.ts'

const [grantsPath, workspace, who, countArg, readyFile, goFile] = process.argv.slice(2)
if (
  grantsPath === undefined ||
  workspace === undefined ||
  who === undefined ||
  readyFile === undefined ||
  goFile === undefined
) {
  throw new Error('用法：grants-writer.ts <grantsPath> <workspace> <我是几号> <条数> <ready> <go>')
}

const count = Number(countArg ?? '0')
/** 撑大文件用的长度——见文件头注「路径故意写得很长」。 */
const PAD = 'p'.repeat(400)
/** 每条授权的字段不同＝真不同的规则（同形去重不会把它们并掉）。 */
const ruleOf = (index: number): Grant => ({
  tool: 'exec',
  path: `w-${who}/${PAD}/${index}.ts`,
  grantedAt: 1_700_000_000_000 + index,
})

writeFileSync(readyFile, '')
while (!existsSync(goFile)) Bun.sleepSync(1) // 栅栏——等到一声令下

for (let i = 0; i < count; i += 1) {
  commitGrants(grantsPath, [{ kind: 'grant', workspace, grant: ruleOf(i) }])
}

console.log(JSON.stringify({ who, done: count }))
