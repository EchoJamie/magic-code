/** --script 也是 App 客户端：真核心由专用 stdin 宿主持有，不在 CLI 内另装配内核。 */
import { describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSandbox, startFixture } from './ui/index.ts'
import { startResidentHost } from './resident-host-fixture.ts'
import { readDatabase } from './support.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')

describe('App 连接上的脚本入口', () => {
  test('空脚本不建工作，真实输入与中途换模型均交给宿主管理者；CLI退出宿主仍在', async () => {
    const fixture = startFixture({ turns: [{ kind: 'text', text: '第一答' }, { kind: 'text', text: '第二答' }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const host = await startResidentHost(sandbox)
    const script = join(sandbox.root, 'script.json')
    const run = async (inputs: unknown[]) => {
      writeFileSync(script, JSON.stringify({ inputs, timeoutMs: 5_000 }))
      const child = Bun.spawn([process.execPath, CLI, '--script', script], { cwd: sandbox.workspace, env: sandbox.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { code, stdout, stderr }
    }
    try {
      const blank = await run([])
      expect(blank, blank.stderr).toMatchObject({ code: 0, stderr: '' })
      expect(blank.stdout).toContain('会话 未建立')
      const empty = readDatabase(join(sandbox.dataDir, 'records.db'))
      try { expect(empty.sessions).toHaveLength(0) } finally { empty.close() }
      expect(fixture.requests()).toHaveLength(0)
      const executed = await run(['第一条', { switch: { alias: 'spell' } }, { input: { text: '第二条' } }])
      expect(executed, executed.stderr).toMatchObject({ code: 0, stderr: '' })
      expect(executed.stdout).toContain('换模型 1 次')
      expect(executed.stdout).toContain('条目 4 条')
      expect(fixture.requests()).toHaveLength(2)
      const db = readDatabase(join(sandbox.dataDir, 'records.db'))
      try {
        expect(db.sessions).toHaveLength(1)
        expect(db.entries.filter((row) => row.kind === 'user').map((row) => row.content_text)).toEqual(['第一条', '第二条'])
      } finally { db.close() }
      expect(process.kill(host.pid, 0)).toBe(true)
      expect(existsSync(host.discovery.socket)).toBe(true)
    } finally { await host.close(); await fixture.stop(); await sandbox.dispose() }
  }, 30_000)

  test('源码脚本无App宿主具体失败，不绕过宿主直接执行', async () => {
    const fixture = startFixture({ turns: [{ kind: 'text', text: '不该请求' }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    try {
      const script = join(sandbox.root, 'script.json')
      writeFileSync(script, JSON.stringify({ inputs: ['不可独立执行'], timeoutMs: 300 }))
      const child = Bun.spawn([process.execPath, CLI, '--script', script], { cwd: sandbox.workspace, env: sandbox.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(code).toBe(1)
      expect(stderr).toContain('源码模式请先显式启动同来源的原生 App 宿主')
      expect(fixture.requests()).toHaveLength(0)
      expect(existsSync(join(sandbox.dataDir, 'records.db'))).toBe(false)
    } finally { await fixture.stop(); await sandbox.dispose() }
  }, 10_000)
})

test('真脚本等待两次工具中间轮之后的最终turn.end；审批答复、工具回填和最终正文完整落账', async () => {
  const fixture = startFixture({ turns: [
    { kind: 'tool', name: 'exec', args: { cmd: 'chmod 755 .' } },
    { kind: 'tool', name: 'exec', args: { cmd: 'printf script-tool-finished' } },
    { kind: 'text', text: '工具全做完后的最终答复', chunks: 4, chunkDelayMs: 40 },
  ] })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const host = await startResidentHost(sandbox)
  try {
    const script = join(sandbox.root, 'multi-turn.json')
    writeFileSync(script, JSON.stringify({ inputs: ['做完两步再回答'], decisions: ['approve'], timeoutMs: 8_000 }))
    const child = Bun.spawn([process.execPath, CLI, '--script', script], { cwd: sandbox.workspace, env: sandbox.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ code, stderr }, stderr).toEqual({ code: 0, stderr: '' })
    expect(fixture.requests()).toHaveLength(3)
    const events = stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)) as import('@magic/contracts').KernelEvent[]
    const ends = events.filter((event) => event.kind === 'turn.end')
    expect(ends.map((event) => event.data.continues ?? false)).toEqual([true, true, false])
    expect(stdout).toContain('裁决 1 次')
    const db = readDatabase(join(sandbox.dataDir, 'records.db'))
    try {
      expect(db.sessions).toHaveLength(1)
      expect(db.entries.filter((row) => row.kind === 'tool-result')).toHaveLength(2)
      expect(db.entries.some((row) => row.kind === 'assistant' && row.content_text === '工具全做完后的最终答复')).toBe(true)
    } finally { db.close() }
  } finally { await host.close(); await fixture.stop(); await sandbox.dispose() }
}, 30_000)
