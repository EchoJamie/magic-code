import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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

test('沙箱记住命令跑出来的目录——下一条不传 cwd 就接着在那里', async () => {  const r = room()
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

test('相对 cwd 以会话目录为基准；会话目录被删后回默认根', async () => {
  const r = room()
  try {
    mkdirSync(join(r.sub, 'nested'))
    const sandbox = createSandbox({ workspace: createWorkspaceService({ roots: [r.root] }) })
    await sandbox.exec('cd sub', {})
    const nested = await sandbox.exec('pwd', { cwd: 'nested' })
    expect(nested.ok && nested.stdout.trim()).toBe(join(r.sub, 'nested'))
    // 一次性覆盖不改会话；下一条仍回到 sub
    const after = await sandbox.exec('pwd', {})
    expect(after.ok && after.stdout.trim()).toBe(r.sub)
    // 目录被删 ⇒ 回默认根（不是每条都 spawn 失败）
    rmSync(r.sub, { recursive: true, force: true })
    const recovered = await sandbox.exec('pwd', {})
    expect(recovered.ok && recovered.stdout.trim()).toBe(r.root)
  } finally { r.done() }
})

test('cd - 回到上一条开始时所在的目录', async () => {
  const r = room()
  try {
    // `cd -` 要 OLDPWD——注入只在有 env 时生效（生产装配总有登录环境；测试给一份最小 env）
    const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? r.root }
    const sandbox = createSandbox({ workspace: createWorkspaceService({ roots: [r.root] }), env })
    await sandbox.exec('cd sub', {})
    const back = await sandbox.exec('cd -', {})
    expect(back.ok && back.cwd).toBe(r.root)
    const here = await sandbox.exec('pwd', {})
    expect(here.ok && here.stdout.trim()).toBe(r.root)
  } finally { r.done() }
})

test('非 POSIX shell 照跑命令但不加目录钩子；跑不起来的 shell 回落 sh', async () => {
  const r = room()
  try {
    if (existsSync('/bin/csh')) {
      const csh = createSandbox({ workspace: createWorkspaceService({ roots: [r.root] }), shell: '/bin/csh' })
      const out = await csh.exec('echo ok', {})
      expect(out.ok && out.stdout.trim()).toBe('ok')
      // csh 不认那层 POSIX 包装 ⇒ 不包装、也不报目录（而不是报 Command not found）
      expect(out.ok && out.cwd).toBeUndefined()
    }
    const broken = createSandbox({ workspace: createWorkspaceService({ roots: [r.root] }), shell: '/no-such-shell-magic' })
    const ran = await broken.exec('echo ok', {})
    expect(ran.ok && ran.stdout.trim()).toBe('ok')
  } finally { r.done() }
})
