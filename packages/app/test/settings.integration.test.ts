import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRecordsStore } from '@magic/records'

import { createSettings, type SettingsContext } from '../src/settings.ts'

import { cliGround } from './resident-cli-fixture.ts'
import type { SettingsAction } from '@magic/contracts'
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
function setup() {
  const g = cliGround(), workspace = join(g.root, 'workspace'), config = join(g.base, 'config.json')
  mkdirSync(workspace)
  const store = createRecordsStore({ dataDir: g.dataDir, workspace: [] })
  cleanups.push(() => { store.close(); g.close() })
  const context: SettingsContext = { magic: { base: g.base, home: g.home }, environment: {}, fetch: globalThis.fetch }
  const settings = createSettings(context)
  return { ...g, workspace, config, store, settings, context,
    apply: async (action: SettingsAction) => settings.apply(action, (await settings.read()).stamp),
    raw: () => JSON.parse(readFileSync(config, 'utf8')) as Record<string, unknown> }
}

test('显式刷新真实本地列表，保存映射与偏好后仍能读取缓存；无自动外连', async () => {
  const g = setup(); let requests = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return Response.json({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }] }) } })
  cleanups.push(() => server.stop(true))
  await g.apply({ type: 'provider.save', provider: 'local', vendor: 'deepseek', baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'SENTINEL_REFRESH' })
  await g.settings.read(); expect(requests).toBe(0)
  await g.apply({ type: 'model.refresh', provider: 'local' }); expect(requests).toBe(1)
  expect(JSON.stringify(await g.settings.read())).toContain('deepseek-v4-pro')
  await g.apply({ type: 'model.configure', choice: 'default', provider: 'local', model: 'deepseek-v4-pro' })
  await g.apply({ type: 'prefs.set', reducedMotion: true })
  const after = await g.settings.read(); expect(JSON.stringify(after.catalog)).toContain('deepseek-v4-pro'); expect(JSON.stringify(after)).not.toContain('SENTINEL_REFRESH'); expect(requests).toBe(1)
})
