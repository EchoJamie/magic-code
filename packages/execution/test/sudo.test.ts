import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateSudoPassword } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * 一台**受控假 sudo**：把 argv / 环境 / 读到的 stdin 各写一份，供用例核对。
 * 密码写在 stdin 的那一行里，`correct-password` 才算过。
 */
function fakeSudo(): { readonly dir: string; readonly env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'magic-sudo-'))
  roots.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const script = join(bin, 'sudo')
  writeFileSync(script, [
    '#!/bin/sh',
    'printf "%s" "$*" > "$FAKE_SUDO_ARGS"',
    'env > "$FAKE_SUDO_ENV"',
    'IFS= read -r password',
    'printf "%s" "$password" > "$FAKE_SUDO_STDIN"',
    '[ "$password" = "correct-password" ] || { echo "Sorry, try again." >&2; exit 1; }',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(script, 0o755)
  return {
    dir,
    env: {
      ...process.env as Record<string, string>,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_SUDO_ARGS: join(dir, 'args'),
      FAKE_SUDO_ENV: join(dir, 'env'),
      FAKE_SUDO_STDIN: join(dir, 'stdin'),
    },
  }
}

describe('sudo -S -v 专用认证', () => {
  test('密码只走认证进程的 stdin；argv 与环境污染里都没有它', async () => {
    const fake = fakeSudo()
    const result = await validateSudoPassword('correct-password', { cwd: fake.dir, env: fake.env })
    expect(result).toEqual({ ok: true })
    expect(readFileSync(join(fake.dir, 'args'), 'utf8')).toBe('-S -v')
    expect(readFileSync(join(fake.dir, 'stdin'), 'utf8')).toBe('correct-password')
    const env = readFileSync(join(fake.dir, 'env'), 'utf8')
    expect(env).not.toContain('correct-password')
    expect(env).toContain('FAKE_SUDO_STDIN=')
  })

  test('密码错误如实回缘由，不自动重试', async () => {
    const fake = fakeSudo()
    const result = await validateSudoPassword('wrong-password', { cwd: fake.dir, env: fake.env })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ detail: expect.stringContaining('Sorry, try again.') })
    // 只跑了一次认证进程——没有第二次尝试
    expect(readFileSync(join(fake.dir, 'stdin'), 'utf8')).toBe('wrong-password')
  })

  test('已中止的信号不启动认证进程', async () => {
    const fake = fakeSudo()
    const controller = new AbortController()
    controller.abort()
    const result = await validateSudoPassword('correct-password', { cwd: fake.dir, env: fake.env, signal: controller.signal })
    expect(result).toEqual({ ok: false, detail: '已取消' })
  })

  test('sudo 不存在时如实说启动失败', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'magic-sudo-'))
    roots.push(dir)
    const result = await validateSudoPassword('x', { cwd: dir, env: { PATH: dir } })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ detail: expect.stringContaining('无法启动 sudo') })
  })
})
