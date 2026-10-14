

import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runtimeLaunch } from '../src/run/runtime-launch.ts'

function ground() {
  const home = mkdtempSync(join(tmpdir(), 'magic-settings-offline-')), base = join(home, '.magic'), configPath = join(base, 'config.json')
  mkdirSync(base)
  return { home, base, configPath, request: crypto.randomUUID(), close: () => rmSync(home, { recursive: true, force: true }) }
}

test('单次配置进程离线保存，stdin 密钥不回显、不创建业务库或 Engine', async () => {
  const g = ground()
  try {
    const child = Bun.spawn([...runtimeLaunch(), '--internal-settings'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', HOME: g.home } })
    child.stdin.write(JSON.stringify({ ...g, stamp: null, action: { type: 'provider.save', provider: 'deepseek', vendor: 'deepseek', apiKey: 'ONLY_STDIN_SECRET' } }))
    child.stdin.end()
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code, errors, output: JSON.parse(output) }).toMatchObject({ code: 0, errors: '' }); expect(errors).toBe(''); expect(output).not.toContain('ONLY_STDIN_SECRET')
    const result = JSON.parse(output)
    expect(result.saved).toBe(true); expect(result.snapshot.configuration.providers.deepseek.keyConfigured).toBe(true)
    expect(readFileSync(g.configPath, 'utf8')).toContain('ONLY_STDIN_SECRET')
    expect(existsSync(join(g.base, 'records.db'))).toBe(false)
    expect(existsSync(join(g.base, 'run'))).toBe(false)
  } finally { g.close() }
})
