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
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { removeDir, tempDir, validConfig, writeConfig } from './tmp.ts'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

/** 在沙地的工作区里摆一份文件（中间目录自动建）。 */
function put(where: string, relative: string, text: string): string {
  const path = join(where, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

describe('真 CLI 帧 · `--check` 那一行', () => {
  /**
   * ⚠️ **显式超时**（U41 补）：这一条起的是**真 CLI 子进程**（冷启动 ＋ 全链装配），
   * 而全量跑是上百个文件并发——挂钟抖动下 5 秒的缺省判据会偶发不够
   *（实测：一次全量跑里这一条红、单跑与重跑都绿；同一条在基线上也是 5 秒判据）。
   * 它钉的是**输出内容**，不是启动速度——放宽挂钟不改判据。
   */
  test('报「有几份、都是什么来源」；没进来的那几条一并列出来', async () => {
    const home = tempDir('magic-cli-rules-')
    mkdirSync(join(home, '.magic'), { recursive: true })
    writeConfig(join(home, '.magic'), validConfig({ dataDir: join(home, 'data') }))

    try {
      writeFileSync(join(home, 'AGENTS.md'), '根约定', 'utf8')
      put(home, '.magic/rules/one.md', '一条原生规则')
      put(home, '.magic/rules/bad.md', '---\npaths:\n  - "src/{a,}/**"\n---\n读不懂的')

      const proc = Bun.spawn([process.execPath, CLI, '--check'], {
        cwd: home,
        env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])

      expect(exitCode).toBe(0)
      expect(stdout).toContain('项目规约　')
      expect(stdout).toContain('目录规约 1')
      expect(stdout).toContain('原生规则 1')
      // 没进来的那几条**一条一行**列在下面（堆成一句长跑会横着冲出屏幕）
      expect(stdout).toContain('有 1 条没进来')
      expect(stdout).toContain('大括号里有一项是空的')
    } finally {
      removeDir(home)
    }
  }), { timeout: 20_000 }

  test('目录读不动：**具体是哪一处、为什么**照说（不是「规约太多」那种含糊话）', async () => {
    // 四轮退回：停批的触发有三种（份数 / 总量到顶 · 目录读不动 · 层级太深），三类共用
    // 回执那一句「没读完整」——**是哪一种由这一屏说**，用户照着它去改。
    const home = tempDir('magic-cli-rules-')
    mkdirSync(join(home, '.magic'), { recursive: true })
    writeConfig(join(home, '.magic'), validConfig({ dataDir: join(home, 'data') }))
    const locked = join(home, '.magic/rules/locked')

    try {
      put(home, '.magic/rules/locked/required.md', '读不动的那一份')
      chmodSync(locked, 0)

      const proc = Bun.spawn([process.execPath, CLI, '--check'], {
        cwd: home,
        env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])

      expect(exitCode).toBe(0)
      expect(stdout).toContain('项目规约　无（') // 一份都没能进来
      expect(stdout).toContain('有 1 条没进来')
      expect(stdout).toContain('目录读不动') // **具体缘由**：哪一处、为什么（不是「多到装不下」）
      expect(stdout).toContain('locked')
    } finally {
      chmodSync(locked, 0o700)
      removeDir(home)
    }
  })

  test('一份规约都没有时明说「怎么才有」——不留白让人以为是漏配', async () => {
    const home = tempDir('magic-cli-rules-')
    mkdirSync(join(home, '.magic'), { recursive: true })
    writeConfig(join(home, '.magic'), validConfig({ dataDir: join(home, 'data') }))

    try {
      const proc = Bun.spawn([process.execPath, CLI, '--check'], {
        cwd: home,
        env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])

      expect(exitCode).toBe(0)
      expect(stdout).toContain('项目规约　无（')
    } finally {
      removeDir(home)
    }
  })
})
