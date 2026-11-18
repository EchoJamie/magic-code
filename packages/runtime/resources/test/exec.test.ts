import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from '../src/exec.ts'
import { createSandbox, timeoutBoundOf } from '../src/sandbox.ts'
import { createWorkspaceService } from '../src/workspace.ts'

test('缺省、null 与非法超时均无上界，显式正值原样保留', () => {
  for (const value of [undefined, null, 0, -1, Number.NaN]) {
    expect(timeoutBoundOf(value)).toBeNull()
  }
  expect(timeoutBoundOf(400)).toBe(400)
})

/** 造一个临时工作区（真实目录，测试结束删掉）。 */
function room(): { root: string; sub: string; file: string; done(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'magic-cwd-')))
  const sub = join(root, 'sub')
  mkdirSync(sub)
  return { root, sub, file: join(root, 'reported-cwd'), done: () => rmSync(root, { recursive: true, force: true }) }
}

const command = (cwd: string, cwdFile: string) => ({
  cwd,
  cwdFile,
  timeoutMs: 10_000,
  maxOutputBytes: 64 * 1024,
})

test('命令结束时报回真实 PWD——正常结束、exit N、set -e 都报', async () => {
  const r = room()
  try {
    const normal = await runCommand('cd sub', command(r.root, r.file))
    expect(normal.ok && normal.cwd).toBe(r.sub)

    const exited = await runCommand('cd sub; exit 3', command(r.root, r.file))
    expect(exited.ok && exited.exit).toBe(3)
    expect(exited.ok && exited.cwd).toBe(r.sub)

    // `set -e` 让 shell 提前退出，退出钩子照样跑——报的是当时仍在的目录
    const failed = await runCommand('set -e; cd /no-such-magic-dir', command(r.root, r.file))
    expect(failed.ok && failed.exit).not.toBe(0)
    expect(failed.ok && failed.cwd).toBe(r.root)
  } finally { r.done() }
})

test('cd 失败不改目录；`exec` 换掉 shell 时取不到（缺席，不编值）', async () => {
  const r = room()
  try {
    const kept = await runCommand('cd /no-such-magic-dir || true', command(r.root, r.file))
    expect(kept.ok && kept.cwd).toBe(r.root)

    const replaced = await runCommand('exec true', command(r.root, r.file))
    expect(replaced.ok && replaced.cwd).toBeUndefined()
  } finally { r.done() }
})

test('沙箱记住命令跑出来的目录——下一条不传 cwd 就接着在那里', async () => {
  const r = room()
  try {
    const sandbox = createSandbox({ workspace: createWorkspaceService({ roots: [r.root] }) })
    const moved = await sandbox.exec('cd sub', {})
    expect(moved.ok && moved.cwd).toBe(r.sub)
    expect(sandbox.sessionCwd?.()).toBe(r.sub)

    const next = await sandbox.exec('pwd', {})
    expect(next.ok && next.stdout.trim()).toBe(r.sub)

    // 一次性覆盖：给了 cwd 就在那里跑，命令内的 cd 也不回写会话
    const override = await sandbox.exec('pwd', { cwd: r.root })
    expect(override.ok && override.stdout.trim()).toBe(r.root)
    expect(sandbox.sessionCwd?.()).toBe(r.sub)
  } finally { r.done() }
})
