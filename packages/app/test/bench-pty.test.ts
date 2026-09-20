/**
 * `bench-pty` 的**收场**（D26 · 工单第 4 条）——只杀 `script` 不算回收。
 *
 * 由来：这条探针量完首帧就杀**直接子进程**（`script`），而被测命令是 `script` 的孩子、
 * 长命令的子进程又是它的孙子——**父进程没了、孩子留在机器上**，正是这种形状。
 *
 * （D26 现场那七个的确定来源是「旧探针没有可靠回收自己起的应用」；它们`PPID=1`、
 * 抱着 PTY slave 空转的**形状**与此同类——形状同类不等于来源就是这一条，别混着说。）
 *
 * ⚠️ 本机（macOS 26.6.2）的 `ps` **不认 `-P`**（`ps: illegal option -- P`）——
 * 名册那一步第一版就是拿它写的，还把退出码扔了：名册恒空，收场静默退化成
 * 「只杀 script」。本用例咬的正是这件事：**连孙子都得没**。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ptyOnce } from './bench-pty.ts'
import { removeDir, tempDir } from './tmp.ts'

describe('D26 · bench-pty 的收场', () => {
  test('量完首帧之后，被测命令**连同它的孩子**一起回收', async () => {
    const dir = tempDir('magic-d26-bench-')
    const pidFile = join(dir, 'target.pid')
    const kidFile = join(dir, 'kid.pid')

    // 假的目标命令：写两个 pid 下来（自己的、和一个**长命的孩子**），
    // 吐一屏带 ESC 的东西（＝这条探针认的「外壳」），然后一直活着等被收
    const target = [
      process.execPath,
      '-e',
      `const fs = require('node:fs');` +
        `const { spawn } = require('node:child_process');` +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
        `const kid = spawn('sleep', ['90'], { stdio: 'ignore' });` +
        `fs.writeFileSync(${JSON.stringify(kidFile)}, String(kid.pid));` +
        `process.stdout.write('\\u001b[>1u 假外壳\\n');` +
        `setInterval(() => {}, 1000)`,
    ]

    try {
      // 量到首帧即收场——这一跳里就该把名下的都收干净
      await ptyOnce(target)

      const pid = Number(readFileSync(pidFile, 'utf8'))
      const kid = Number(readFileSync(kidFile, 'utf8'))
      expect(Number.isInteger(pid)).toBe(true)
      expect(Number.isInteger(kid)).toBe(true)

      // 目标：没了（`kill(pid, 0)` 抛 ＝ 确实不在了）
      expect(() => process.kill(pid, 0)).toThrow()
      // **孩子也没了**——这一条才是本用例的判据：只杀 `script` 时它会被 reparent 到 1，
      // 上面那个 `process.kill(pid, 0)` 照样抛（父死了），漏掉它看不出来
      expect(() => process.kill(kid, 0)).toThrow()
    } finally {
      removeDir(dir)
    }
  }, 60_000)
})
