

import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runNativeSettings } from './native-settings-fixture.ts'

function ground() {
  const home = mkdtempSync(join(tmpdir(), 'magic-settings-offline-')), base = join(home, '.magic'), configPath = join(base, 'config.json')
  mkdirSync(base)
  return { home, base, configPath, request: crypto.randomUUID(), close: () => rmSync(home, { recursive: true, force: true }) }
}

test('App 原生设置离线保存，密钥不回显、不创建业务库或 Engine', async () => {
  const g = ground()
  try {
    const result = await runNativeSettings({ ...g, stamp: null, action: { type: 'provider.save', provider: 'deepseek', vendor: 'deepseek', apiKey: 'ONLY_STDIN_SECRET' } })
    expect(JSON.stringify(result)).not.toContain('ONLY_STDIN_SECRET')
    expect(result.saved).toBe(true); expect(result.snapshot!.configuration.providers).toMatchObject({ deepseek: { keyConfigured: true } })
    expect(readFileSync(g.configPath, 'utf8')).toContain('ONLY_STDIN_SECRET')
    expect(existsSync(join(g.base, 'records.db'))).toBe(false)
    expect(existsSync(join(g.base, 'run'))).toBe(false)
  } finally { g.close() }
})
