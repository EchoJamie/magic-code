import { expect, test } from 'bun:test'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent, SettingsAction } from '@magic/contracts'
import { createSettings } from '../src/settings.ts'
import { attachShell } from '../src/shell.ts'
import { makeStage } from './support.ts'
import { magicAt } from './tmp.ts'
import { startFixture } from './ui/fixture.ts'

test('设置保存的根与三类材料由下次真实装配消费，旧根与已送上下文保留，来源不扩执行域', async () => {
  const stage = makeStage(), root = join(stage.root, 'new-root'), outside = join(stage.root, 'materials')
  mkdirSync(root); mkdirSync(outside); mkdirSync(join(root, 'src'))
  writeFileSync(join(stage.workspace, 'note.txt'), 'OLD_ROOT_CONTENT')
  writeFileSync(join(root, 'note.txt'), 'NEW_ROOT_CONTENT')
  const team = join(outside, 'team.md'), linked = join(outside, 'linked.md')
  writeFileSync(team, 'EXPLICIT_SOURCE_U116'); writeFileSync(linked, 'LINK_SOURCE_U116')
  symlinkSync(linked, join(root, 'src', 'AGENTS.md'))
  for (const [path, description] of [[join(root, '.agents/skills/demo'), '项目优先'], [join(outside, 'skills/demo'), '配置同名低优先'], [join(outside, 'skills/extra'), '配置补充']] as const) {
    mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'SKILL.md'), `---\nname: ${path.endsWith('extra') ? 'extra' : 'demo'}\ndescription: ${description}\n---\n技能原文`)
  }
  const old = stage.assemble({ turns: [{ toolCalls: [{ name: 'read', args: { path: 'note.txt' } }] }, { text: '旧工作读完' }] })
  let next: ReturnType<typeof stage.assemble> | undefined
  const settings = createSettings({ magic: { ...magicAt(stage.root), base: stage.root }, cwd: stage.workspace, store: old.records, mcp: [], canChangeData: () => false, mcpWorks: async () => [], preferencesChanged: async () => {}, grantsChanged: async () => {}, reconnect: async () => { throw new Error('没有目标') } })
  const save = async (action: SettingsAction) => settings.apply(action, (await settings.read()).stamp)
  try {
    await save({ type: 'workspace.set', roots: [root] })
    await save({ type: 'sources.set', source: 'rules.sources', paths: [team] })
    await save({ type: 'sources.set', source: 'rules.linkSources', paths: [outside] })
    await save({ type: 'sources.set', source: 'skills.sources', paths: [join(outside, 'skills')] })
    const oldShell = attachShell(old.shell); await oldShell.submit('读取原有根的文件'); oldShell.dispose()
    expect(oldShell.events.find(e => e.kind === 'tool.result')?.data.output).toMatchObject({ text: expect.stringContaining('OLD_ROOT_CONTENT') })
    const oldRequest = JSON.stringify(stage.models[0]!.requests)
    expect(oldRequest).not.toContain('EXPLICIT_SOURCE_U116')
    next = stage.assemble({ turns: [{ toolCalls: [{ name: 'read', args: { path: 'note.txt' } }] }, { toolCalls: [{ name: 'read', args: { path: team } }] }, { text: '新工作读完' }] })
    expect(old.workspaceRoots).toEqual([realpathSync(stage.workspace)]); expect(next.workspaceRoots).toEqual([realpathSync(root)])
    expect(next.readRules([join(root, 'src', 'note.txt')]).documents.map(d => d.text).join('\n')).toContain('LINK_SOURCE_U116')
    expect(next.readSkills().skills.find(s => s.name === 'demo')?.description).toBe('项目优先')
    expect(next.readSkills().skills.find(s => s.name === 'extra')?.description).toBe('配置补充')
    // 脚本外壳默认自动批准；这里明确拒绝，验证来源配置本身不授予执行权限。
    const shell = attachShell(next.shell, { decide: () => 'reject' }); await shell.submit('读取新的根，再尝试来源原文'); shell.dispose()
    const results = shell.events.filter((e): e is Extract<KernelEvent, { kind: 'tool.result' }> => e.kind === 'tool.result')
    expect(results[0]?.data).toMatchObject({ ok: true, output: { text: expect.stringContaining('NEW_ROOT_CONTENT') } })
    expect(results[1]?.data.ok).toBe(false) // 允许规则来源不等于授予工具访问该目录。
    const requests = shell.events.filter(e => e.kind === 'tool.decision.request')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.data.material).toContain('只读该文件')
    expect(requests[0]?.data.material).toContain(realpathSync(team))
    expect(requests[0]?.data).toMatchObject({ name: 'read', weight: 'heavy' })
    expect(shell.decisions).toMatchObject([{ name: 'read', decision: 'reject' }])
    expect(shell.events.find(e => e.kind === 'tool.decision' && e.data.call === requests[0]?.data.call)?.data).toMatchObject({ decision: 'reject', decider: 'user' })
    expect(JSON.stringify(stage.models[1]!.requests[0]?.messages)).toContain('EXPLICIT_SOURCE_U116')
    expect(JSON.stringify(stage.models[0]!.requests)).toBe(oldRequest)
    const evidence = process.env['MAGIC_SETTINGS_EXECUTION_EVIDENCE']
    if (evidence) writeFileSync(evidence, JSON.stringify({ entry: 'settings.apply → actual assembly → real read tool + outgoing context', oldRootPreserved: true, nextRootAdopted: true, explicitSourceSent: true, linkedSourceAdopted: true, skillPriorityPreserved: true, sourceDidNotExpandExecution: true }, null, 2))
  } finally { await old.close(); await next?.close(); stage.dispose() }
})

test('保存权限规则只影响下次装配，撤销真实授权影响现有闸门，配置规则与授权分开', async () => {
  const tool = { kind: 'tool' as const, name: 'web_fetch', args: { url: 'https://example.com/u116', prompt: '提炼受控页面' } }
  const text = { kind: 'text' as const, text: '受控结果', chunks: 1, chunkDelayMs: 5 }
  const fixture = startFixture({ turns: [tool, text, tool, text, text, tool, text, text, tool, text] })
  const stage = makeStage({ config: { providers: { local: { vendor: 'deepseek', baseURL: fixture.baseURL, apiKey: 'U116_FAKE_ONLY' } }, models: { default: { provider: 'local', model: 'entry' }, cantrip: { provider: 'local', model: 'distill' } } } })
  const assemblies: ReturnType<typeof stage.assemble>[] = []
  let fetched = 0
  const webSource = { fetchPage: async (url: string) => { fetched++; return { ok: true as const, url, status: 200, bytes: 20, body: '<p>U116 受控页面</p>', contentType: 'text/html' } } }
  const grantsFile = join(stage.root, 'grants.json')
  const make = () => { const assembly = stage.assemble({ modelGateway: undefined, webSource, grantsFile }); assemblies.push(assembly); return assembly }
  const old = make()
  const settings = createSettings({ magic: { ...magicAt(stage.root), base: stage.root }, cwd: stage.workspace, store: old.records, mcp: [], canChangeData: () => false, mcpWorks: async () => [], preferencesChanged: async () => {}, grantsChanged: async () => { assemblies.forEach(a => a.refreshSettings()) }, reconnect: async () => { throw new Error('没有目标') } })
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
    await save({ type: 'permissions.set', rules: [{ tool: 'web_fetch', host: 'example.com' }] })
    await run(old, true); expect(fetched).toBe(0)
    const configured = make(); await run(configured, false); expect(fetched).toBe(1)
    await save({ type: 'permissions.set', rules: [] })
    expect(configured.permissionRules).toEqual([{ tool: 'web_fetch', host: 'example.com' }])
    const workspace = realpathSync(stage.workspace)
    writeFileSync(grantsFile, JSON.stringify({ version: 1, workspaces: { [workspace]: [{ tool: 'web_fetch', host: 'example.com', grantedAt: 1 }] } }))
    const granted = make(); await run(granted, false); expect(fetched).toBe(2)
    const snapshot = await settings.read()
    await save({ type: 'grants.revoke', workspace, index: 0, grantStamp: snapshot.grantStamp })
    await run(granted, true); expect(fetched).toBe(2)
    expect(configured.permissionRules).toEqual([{ tool: 'web_fetch', host: 'example.com' }])
    const evidence = process.env['MAGIC_SETTINGS_PERMISSIONS_EVIDENCE']
    if (evidence) writeFileSync(evidence, JSON.stringify({ entry: 'settings.apply → actual permission gate → local HTTP extraction + synthetic page', oldRulesPreserved: true, nextRulesAdopted: true, grantedCallActuallyFetched: true, revokedExistingGateAsked: true, revokedCallDidNotFetch: true, configRulesKeptSeparate: true }, null, 2))
  } finally { for (const assembly of assemblies) await assembly.close(); stage.dispose(); await fixture.stop() }
}, 30000)
