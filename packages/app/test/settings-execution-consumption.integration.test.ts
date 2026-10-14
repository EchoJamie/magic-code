import { expect, test } from 'bun:test'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent, SettingsAction } from '@magic/contracts'
import { createSettings } from '../src/settings.ts'

import { makeStage } from './support.ts'
import { magicAt } from './tmp.ts'
import { startFixture } from './ui/fixture.ts'

test('保存权限规则和撤销授权在后续裁决采用，已开始的工具不倒撤', async () => {
  const tool = { kind: 'tool' as const, name: 'web_fetch', args: { url: 'https://example.com/u116', prompt: '提炼受控页面' } }
  const text = { kind: 'text' as const, text: '受控结果', chunks: 1, chunkDelayMs: 5 }
  const fixture = startFixture({ turns: [tool, text, tool, text, text, tool, text, text, tool, text] })
  const stage = makeStage({ config: { providers: { local: { protocol: 'chat-completions', baseURL: fixture.baseURL, apiKey: 'U116_FAKE_ONLY' } }, models: { default: { provider: 'local', model: 'entry' }, cantrip: { provider: 'local', model: 'distill' } } } })
  const assemblies: ReturnType<typeof stage.assemble>[] = []
  let fetched = 0
  const webSource = { fetchPage: async (url: string) => { fetched++; return { ok: true as const, url, status: 200, bytes: 20, body: '<p>U116 受控页面</p>', contentType: 'text/html' } } }
  const grantsFile = join(magicAt(stage.root).base, 'grants.json')
  const make = () => { const assembly = stage.assemble({ modelGateway: undefined, webSource, grantsFile }); assemblies.push(assembly); return assembly }
  const old = make()
  const settings = createSettings({ magic: magicAt(stage.root), environment: {}, fetch: globalThis.fetch })
  const save = async (action: SettingsAction) => settings.apply(action, (await settings.read()).stamp)
  async function run(assembly: ReturnType<typeof make>, ask: boolean) {
    const events: KernelEvent[] = []
    const off = assembly.shell.subscribe(e => { events.push(e); if (e.kind === 'tool.decision.request') assembly.shell.send({ type: 'decision.answer', id: e.id, decision: 'reject' }) })
    assembly.shell.send({ type: 'input.submit', text: '取受控页面验证闸门' })
    const end = Date.now() + 10000
    try {
      while (!events.some(e => e.kind === 'agent.state' && e.data.state === 'waiting')) { if (Date.now() > end) throw new Error('受控调用没有收束'); await Bun.sleep(10) }
      expect(events.some(e => e.kind === 'tool.decision.request')).toBe(ask)
      expect(events.find(e => e.kind === 'tool.result')?.data.ok).toBe(!ask)
    } finally { off() }
  }
  try {
    await run(old, true); expect(fetched).toBe(0)
    await save({ type: 'permissions.set', rules: [{ tool: 'web_fetch', host: 'example.com' }] })
    await run(old, false); expect(fetched).toBe(1)
    await save({ type: 'permissions.set', rules: [] })
    const workspace = realpathSync(stage.workspace)
    writeFileSync(grantsFile, JSON.stringify({ version: 1, workspaces: { [workspace]: [{ tool: 'web_fetch', host: 'example.com', grantedAt: 1 }] } }))
    const granted = make(); await run(granted, false); expect(fetched).toBe(2)
    const snapshot = await settings.read()
    await save({ type: 'grants.revoke', workspace, index: 0, grantStamp: snapshot.grantStamp })
    await run(granted, true); expect(fetched).toBe(2)
    const evidence = process.env['MAGIC_SETTINGS_PERMISSIONS_EVIDENCE']
    if (evidence) writeFileSync(evidence, JSON.stringify({ entry: 'settings.apply → actual permission gate → local HTTP extraction + synthetic page', oldRulesPreserved: true, nextRulesAdopted: true, grantedCallActuallyFetched: true, revokedExistingGateAsked: true, revokedCallDidNotFetch: true, configRulesKeptSeparate: true }, null, 2))
  } finally { for (const assembly of assemblies) await assembly.close(); stage.dispose(); await fixture.stop() }
}, 30000)
