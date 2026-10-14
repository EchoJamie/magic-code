import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { diagnosticsOf } from '@magic/contracts'
import { loadConfig } from '../src/config.ts'

import { cliGround } from './resident-cli-fixture.ts'
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
function setup() { const g = cliGround(); cleanups.push(g.close); return { ...g, magic: { base: g.base, home: g.home }, path: join(g.base, 'config.json') } }

test('诊断配置独立保存，不依赖 App 或创建运行工作', async () => {
  const { applyHostDiagnostics } = await import('../src/run/diagnostics-client.ts')
  const g = setup()
  expect(await applyHostDiagnostics({ base: g.magic.base }, { debugMode: true, logLevel: 'trace' })).toContain('已保存')
  expect(diagnosticsOf(loadConfig({ magic: g.magic }).config)).toEqual({ debugMode: true, logLevel: 'trace' })
  expect(await applyHostDiagnostics({ base: g.magic.base }, { debugMode: false })).toContain('已保存')
  expect(diagnosticsOf(loadConfig({ magic: g.magic }).config)).toEqual({ debugMode: false, logLevel: 'trace' })
  expect(existsSync(join(g.magic.base, 'records.db'))).toBe(false)
})
