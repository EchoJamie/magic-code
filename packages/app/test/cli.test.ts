/**
 * U11 · 入口 —— 判据：**`magic` 可调用**（`bun run magic`）。
 *
 * 「可调用」取实证：**真开子进程跑**（不是 import 了事）。三面：
 * ① `--help` 与坏参数；② 配置有问题时响亮退场；③ **装配自检真跑得通**——
 * 全链构造一遍（配置 → 记录库 → 工作区 → 沙箱 → 网关 → 各域 → 控制域），
 * 数据目录都建出来了，然后干净收尾。
 *
 * 家目录用 `HOME` 注入（`os.homedir()` 认它），故不碰真的 `~/.magic`。
 * 假 key 只用于**构造**——网关构造不发请求（缺 key 会在构造期抛，那也在本用例的射程内）。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { removeDir, tempDir, validConfig, writeConfig } from './tmp.ts'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

type Run = { readonly stdout: string; readonly stderr: string; readonly exitCode: number }

async function run(home: string, ...args: readonly string[]): Promise<Run> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout, stderr, exitCode }
}

/** 装一块带配置的沙地（家目录＝`home`，配置文件在 `<home>/.magic/config.json`）。 */
function stageWithConfig(config: unknown): { home: string; dataDir: string } {
  const home = tempDir('magic-cli-')
  mkdirSync(join(home, '.magic'), { recursive: true })
  writeConfig(join(home, '.magic'), config)
  return { home, dataDir: join(home, 'data') }
}

describe('入口 magic', () => {
  test('`--help`——说清用法与脚本形制', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home, '--help')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('magic —— 软件工程智能体')
      expect(result.stdout).toContain('--script')
      // 无人值守替人批准这件事要在用法里说破——别让它看着像产品行为
      expect(result.stdout).toContain('人工门')
    } finally {
      removeDir(home)
    }
  })

  test('坏参数——响亮退场（退 1，不是静默忽略）', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home, '--nosuchflag')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('不认得的参数')
    } finally {
      removeDir(home)
    }
  })

  test('配置缺——报「配置有问题」并退 1', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home)

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('配置有问题')
      expect(result.stderr).toContain('config.json')
    } finally {
      removeDir(home)
    }
  })

  test('装配自检——全链构造一遍，数据落点真建出来', async () => {
    // dataDir 用**加载器展开得了的**写法的反面也用上：这里直接给绝对路径
    const { home, dataDir } = (() => {
      const home = tempDir('magic-cli-')
      mkdirSync(join(home, '.magic'), { recursive: true })
      const dataDir = join(home, 'data')
      writeConfig(join(home, '.magic'), validConfig({ dataDir }))
      return { home, dataDir }
    })()

    try {
      // 无参现在是「起真外壳」（要 TTY，测试跑不了）——自检改由 `--check` 触发
      const result = await run(home, '--check')

      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('装配自检')
      expect(result.stdout).toContain(dataDir)
      // 模型名与「key 来处」都在自检里；key 本身不在（密钥纪律）
      expect(result.stdout).toContain('MiniMax-M3')
      expect(result.stdout).toContain('key 取自配置文件')
      expect(result.stdout).not.toContain('sk-test-not-a-real-key')
      // 外壳位如实交代（真外壳归 U09）
      expect(result.stdout).toContain('U09')

      // 全链真构造过：库与 blob 目录都在
      expect(existsSync(join(dataDir, 'records.db'))).toBe(true)
      expect(existsSync(join(dataDir, 'blobs'))).toBe(true)
    } finally {
      removeDir(home)
    }
  })

  test('`--script` 指向不存在的文件——退 1 并点名', async () => {
    const { home } = stageWithConfig(validConfig({ dataDir: '/tmp/magic-cli-never' }))

    try {
      const result = await run(home, '--script', join(home, 'nope.json'))

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('脚本文件不存在')
    } finally {
      removeDir(home)
    }
  })
})
