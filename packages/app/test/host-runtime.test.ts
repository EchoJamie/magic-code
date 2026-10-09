import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostResponse } from '@magic/contracts'

for (const how of ['shutdown', 'eof'] as const) {
  test(`App 生命管道 ${how}：空闲管理者只有宿主能终结`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'magic-host-'))
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), '--internal-manager', '--host-instance', 'isolated-host', '--app', '/tmp/Magic Test.app'], {
      cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, MAGIC_HOME: root },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    const messages: HostResponse[] = []
    let buffered = ''
    const errors = new Response(child.stderr).text()
    const reading = (async () => {
      for await (const bytes of child.stdout) {
        buffered += new TextDecoder().decode(bytes)
        for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
          const line = buffered.slice(0, at); buffered = buffered.slice(at + 1)
          messages.push(JSON.parse(line) as HostResponse)
        }
      }
    })()
    try {
      const deadline = Date.now() + 5000
      while (!messages.some((one) => one.t === 'host.ready') && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10)
      if (!messages.some((one) => one.t === 'host.ready') && child.exitCode !== null) throw new Error(JSON.stringify(messages) + await errors)
      expect(messages.some((one) => one.t === 'host.ready')).toBe(true)
      const ready = messages.find((one) => one.t === 'host.ready')!
      if (ready.t !== 'host.ready') throw new Error('未就绪')
      expect(ready.identity.hostInstance).toBe('isolated-host')
      expect(ready.identity.base.startsWith(root) || ready.identity.base.startsWith('/private' + root)).toBe(true)
      expect(existsSync(ready.socket)).toBe(true)
      expect(child.exitCode).toBeNull()
      if (how === 'shutdown') child.stdin.write(JSON.stringify({ t: 'host.shutdown', request: 'quit-one' }) + '\n')
      else child.stdin.end()
      expect(await child.exited).toBe(0)
      await reading
      expect(messages.some((one) => one.t === 'host.stopped')).toBe(true)
      expect(existsSync(ready.socket)).toBe(false)
      expect(await errors).not.toContain('未能确认')
    } finally {
      if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
      await reading
      rmSync(root, { recursive: true, force: true })
    }
  }, 10000)
}
