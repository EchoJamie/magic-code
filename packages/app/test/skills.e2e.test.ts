/**
 * U33 · 技能 —— **真装配的端到端**（第一轮：内核与真实应用闭环）。
 *
 * 判据落在四样真东西上（不是解析器的自证，也不是手工复写一条接线）：
 * - **真模型请求**——`lastModel(stage).requests[i].messages` 就是送去模型的那一份；
 * - **真控制入口**——结构化输入经 `shell.send({type:'input.submit', …})` 进内核（现有那条路）；
 * - **真记录**——直读库表（`readDatabase`），不看内存里的副本；
 * - **真工具通路**——模型自主选用走真的 `skill` 工具（真注册表 · 真闸门 · 真回填）。
 *
 * 沙地三块（数据目录 / 工作区 / 家目录）都由 `makeStage` 落在唯一临时目录里——
 * **家目录也在沙地里**（用户那一类技能来源在 `<home>/.magic/skills`，不沙地化就会去扫
 * 这台机器上真的那两个目录）。不碰任何真东西。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 机械分析面（`@magic/permission` 出口 ③）——**供外壳预览与测试直取**（见其头注）。
// U76 起判轻的不再过闸、也**不发请求事件**，故「这一格判轻」这件事只剩它答得出（见用例里的注）。

import { removeDir, tempDir, validConfig, writeConfig } from './tmp.ts'

/** CLI 入口——`--check` 那一屏的字由它产出（与 `rules.test.ts` 同一个取法）。 */
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

/** 在沙地里写一个文件（中间目录自动建）。 */
function put(where: string, relative: string, text: string): string {
  const path = join(where, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

/** 一份讲道理的 `SKILL.md`。 */
function skillText(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

describe('U33 · 真 CLI 帧 · `--check` 那一行', () => {
  test('报「发现了哪些、有哪些没读进来」——坏的那一条**指明来源与缘由**', async () => {
    const home = tempDir('magic-cli-skills-')
    mkdirSync(join(home, '.magic'), { recursive: true })
    writeConfig(join(home, '.magic'), validConfig({ dataDir: join(home, 'data') }))

    try {
      put(home, '.magic/skills/pdf/SKILL.md', skillText('pdf', '处理 PDF', '正文'))
      put(home, '.magic/skills/broken/SKILL.md', '---\nname: broken\n---\n\n没有 description\n')

      const proc = Bun.spawn([process.execPath, CLI, '--check'], {
        cwd: home,
        env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])

      expect(exitCode).toBe(0)
      expect(stdout).toContain('技能　　　')
      // 发现到的照报（名字 ＋ 来源）
      expect(stdout).toContain('pdf（项目 .magic/skills）')
      // 坏的那一条**一条两行**（路径一行、缘由一行）——用户照着去改
      expect(stdout).toContain('有 1 个没读进来')
      expect(stdout).toContain('broken')
      expect(stdout).toContain('description')
    } finally {
      removeDir(home)
    }
  })

  test('一个技能都没有：说清「放哪儿就来」，不留白', async () => {
    const home = tempDir('magic-cli-skills-')
    mkdirSync(join(home, '.magic'), { recursive: true })
    writeConfig(join(home, '.magic'), validConfig({ dataDir: join(home, 'data') }))

    try {
      const proc = Bun.spawn([process.execPath, CLI, '--check'], {
        cwd: home,
        env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stdout = await new Response(proc.stdout).text()
      await proc.exited

      expect(stdout).toContain('技能　　　无（放 .magic/skills/<名称>/SKILL.md 就来')
    } finally {
      removeDir(home)
    }
  })
})
