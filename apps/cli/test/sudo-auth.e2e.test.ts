/**
 * sudo 专用认证的**真实链路**（U129）——真 CLI / 真 TUI / 真 PTY，只把 `sudo` 换成假件。
 *
 * 咬三件事：
 * - 短 sudo 弹出专用组件，密码不回显；
 * - 认证通过后命令才执行，密码不进模型请求、记录库与数据目录；
 * - 密码错误时命令不执行，回执可重试。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUiSession } from './ui/driver.ts'
import type { UiSession } from './ui/driver.ts'
import { removeDir, tempDir } from './tmp.ts'

const PASSWORD = 'Zx9-q1-sudo-pass'

let artifacts: string
beforeEach(() => { artifacts = tempDir('magic-sudo-ui-') })
afterEach(() => { removeDir(artifacts) })

function fakeSudo(): string {
  const bin = join(artifacts, 'bin')
  mkdirSync(bin, { recursive: true })
  const script = join(bin, 'sudo')
  writeFileSync(script, [
    '#!/bin/sh',
    'if [ "$1" = "-S" ]; then',
    '  IFS= read -r password',
    `  [ "$password" = "${PASSWORD}" ] && exit 0`,
    '  echo "Sorry, try again." >&2',
    '  exit 1',
    'fi',
    'if [ "$1" = "-n" ]; then shift; exec "$@" ; fi',
    'echo "unexpected sudo invocation: $*" >&2',
    'exit 2',
    '',
  ].join('\n'))
  chmodSync(script, 0o755)
  return bin
}

function filesUnder(root: string, found: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) filesUnder(path, found)
    else found.push(path)
  }
  return found
}

function persisted(password: string, dataDir: string): boolean {
  return filesUnder(dataDir).some((path) => readFileSync(path).includes(password))
}

async function session(turns: NonNullable<Parameters<typeof createUiSession>[0]>['turns']): Promise<UiSession> {
  const bin = fakeSudo()
  return createUiSession({
    artifacts,
    label: 'sudo-auth',
    columns: 120,
    rows: 40,
    env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    turns,
  })
}

describe('sudo 专用认证（真 PTY）', () => {
  test('密码不回显；认证通过后命令执行；密码不进模型、记录与数据目录', async () => {
    const ui = await session([
      { kind: 'tool', name: 'exec', args: { command: 'sudo touch sudo-made.txt' } },
      { kind: 'text', text: '文件建好了' },
    ])

    try {
      await ui.send('建一个文件')
      await ui.key('enter')
      await ui.wait({ text: 'sudo 认证' }, { timeoutMs: 10_000 })

      const prompt = await ui.capture({ label: 'sudo-组件' })
      expect(prompt.text).toContain('sudo 认证')
      expect(prompt.text).toContain('sudo touch sudo-made.txt')
      expect(prompt.text).toContain('密码不回显')

      await ui.send(PASSWORD, { until: { text: '密码 •' }, timeoutMs: 5_000 })
      const typed = await ui.capture({ label: 'sudo-已输入' })
      expect(typed.text).not.toContain(PASSWORD)
      expect(typed.text).toContain('密码 •')

      await ui.key('enter', { until: { text: '文件建好了' }, timeoutMs: 10_000 })

      const workspace = ui.facts().workspace
      expect(existsSync(join(workspace, 'sudo-made.txt'))).toBe(true)
      const done = await ui.capture({ label: 'sudo-完成' })
      expect(done.text).not.toContain(PASSWORD)
      // 应用写出的全部字节（含调试日志）里也不能有密码
      expect(ui.rawText()).not.toContain(PASSWORD)

      // 模型请求里没有密码；记录 / 配置 / 数据目录里也没有
      for (const request of ui.requests()) {
        expect(JSON.stringify(request)).not.toContain(PASSWORD)
      }
      expect(persisted(PASSWORD, ui.facts().dataDir)).toBe(false)
    } finally {
      await ui.close()
    }
  }, 40_000)

  test('密码错误：命令不执行，回执说可重试', async () => {
    const ui = await session([
      { kind: 'tool', name: 'exec', args: { command: 'sudo touch should-not-exist.txt' } },
      { kind: 'text', text: '这次没成' },
    ])

    try {
      await ui.send('建一个文件')
      await ui.key('enter')
      await ui.wait({ text: 'sudo 认证' }, { timeoutMs: 10_000 })
      await ui.send('wrong-password')
      await ui.key('enter', { until: { text: 'sudo 认证没通过' }, timeoutMs: 10_000 })

      const failed = await ui.capture({ label: 'sudo-失败' })
      expect(failed.text).toContain('命令未执行')
      expect(failed.text).toContain('可以再发起一次重试')
      expect(failed.text).not.toContain(PASSWORD)
      expect(existsSync(join(ui.facts().workspace, 'should-not-exist.txt'))).toBe(false)
    } finally {
      await ui.close()
    }
  }, 40_000)
})
