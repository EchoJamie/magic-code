import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import type { AgentModelConfig, ModelAliases, ModelSwitchRequest } from '@magic/contracts'
import { makeTestStamper } from '@magic/faux'
import { createModelRegistry } from '@magic/model'
import { createAgentModels, resolveModelChoice } from '../src/agent-models.ts'
import { setModelAlias } from '../src/config-save.ts'
import { loadConfig } from '../src/config.ts'
import { parseArgs } from '../src/cli.ts'
import { attachShell } from '../src/shell.ts'
import { makeStage, eventsOfKind, readDatabase } from './support.ts'
import { magicAt, removeDir, tempDir, writeConfig } from './tmp.ts'

const providers = {
  main: { vendor: 'deepseek', apiKey: 'local-main', baseURL: 'https://main.example/v1' },
  aux: { vendor: 'deepseek', apiKey: 'local-aux', baseURL: 'https://aux.example/v1' },
}
const aliases = {
  default: { provider: 'main', model: 'deepseek-chat' },
  cantrip: { provider: 'aux', model: 'deepseek-chat' },
  spell: { provider: 'main', model: 'deepseek-reasoner' },
  arcane: { provider: 'main', model: 'deepseek-chat' },
} satisfies ModelAliases
const defaults: AgentModelConfig = { alias: 'default', provider: 'main', model: 'deepseek-chat', reasoning: { mode: 'level', level: 'high' } }

function endpoint(options: { failure?: boolean; summaryFailure?: 'auth' | 'network' | 'empty' | 'incomplete' | 'cancel'; mainLimit?: boolean } = {}) {
  const seen: { url: string; body: Record<string, any> }[] = []
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] })
    const body = JSON.parse(String(init?.body))
    seen.push({ url, body })
    const summary = body.messages?.[0]?.content?.startsWith('你是会话压缩器') === true
    if (!summary && options.mainLimit && seen.filter(one => one.url.includes('main.example')).length === 2) return Response.json({ error: { message: 'maximum context length exceeded' } }, { status: 400 })
    if (summary && options.summaryFailure === 'auth') return Response.json({ error: { message: 'authentication failed' } }, { status: 401 })
    if (summary && options.summaryFailure === 'network') throw new TypeError('fetch failed: controlled network failure')
    if (summary && options.summaryFailure === 'cancel') return await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('controlled cancelled', 'AbortError')), { once: true }) })
    if (summary && options.failure) return Response.json({ error: { message: 'maximum context length exceeded' } }, { status: 400 })
    const frame = (choices: unknown, usage?: unknown) => `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: body.model, choices, usage })}\n\n`
    return new Response(
      frame([{ index: 0, delta: { role: 'assistant', content: summary ? options.summaryFailure === 'empty' ? '' : '保留用户约束与未完成工作' : '工作答复' } }]) +
      (summary && options.summaryFailure === 'incomplete' ? '' : frame([{ index: 0, delta: {}, finish_reason: 'stop' }], { prompt_tokens: 100, completion_tokens: 10 })) + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof globalThis.fetch
  return { seen, fetch }
}

describe('U113 统一模型配置与执行选择', () => {
  test('首次初始化只填缺失档位；日后改 Default 不连改三档，无模型调用', () => {
    const root = tempDir('u113-save-')
    try {
      const path = writeConfig(root, { providers, modelAliases: { arcane: aliases.arcane }, permissions: { rules: [] }, marker: '保留' })
      expect(setModelAlias({ path, request: { alias: 'default', provider: 'main', model: 'deepseek-chat', initialize: true } })).toEqual({ ok: true })
      const first = JSON.parse(readFileSync(path, 'utf8'))
      expect(first.modelAliases).toEqual({ default: aliases.default, cantrip: aliases.default, spell: aliases.default, arcane: aliases.arcane })
      expect(setModelAlias({ path, request: { alias: 'default', provider: 'aux', model: 'other' } })).toEqual({ ok: true })
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      expect(saved.modelAliases.default).toEqual({ provider: 'aux', model: 'other' })
      expect(saved.modelAliases.cantrip).toEqual(aliases.default)
      expect(saved.marker).toBe('保留')
      expect(saved.permissions).toEqual({ rules: [] })
      expect(loadConfig({ path, magic: magicAt(root) }).config.modelAliases).toEqual(saved.modelAliases)
    } finally { removeDir(root) }
  })

  test('配置损坏和旧来源明确拒绝，不覆盖、不迁移', () => {
    const root = tempDir('u113-invalid-')
    try {
      for (const config of [
        { providers, defaultProvider: 'main' }, { providers, webFetch: aliases.cantrip },
        { providers: { main: { ...providers.main, model: 'raw' } } },
        { providers: { main: { ...providers.main, modelOverrides: { 'deepseek-chat': { reasoning: { mode: 'off' } } } } } },
        { providers, modelAliases: { wrong: aliases.default } },
        { providers, modelAliases: { default: { provider: 'missing', model: 'raw' } } },
        { providers, agentRoles: { worker: { name: '执行', instructions: '执行', model: { provider: 'main', model: 'raw' } } } },
      ]) {
        const path = writeConfig(root, config)
        const before = readFileSync(path, 'utf8')
        expect(() => loadConfig({ path, magic: magicAt(root) })).toThrow()
        expect(readFileSync(path, 'utf8')).toBe(before)
      }
      const path = writeConfig(root, { providers, modelAliases: [] })
      expect(setModelAlias({ path, request: { alias: 'default', ...aliases.default! } }).ok).toBe(false)
    } finally { removeDir(root) }
  })

  test('CLI 只接受四个小写标识，供应商与原始型号在调用前被拒绝', () => {
    expect(parseArgs(['--model', 'spell']).switch).toEqual({ alias: 'spell' })
    expect(() => parseArgs(['--model', 'deepseek-chat'])).toThrow('只能选择')
    expect(() => parseArgs(['--provider', 'main'])).toThrow('不认得')
    expect(() => parseArgs(['--model', 'Spell'])).toThrow('只能选择')
    expect(resolveModelChoice({ providers, aliases: {}, config: { alias: 'cantrip' } })).toEqual({ ok: false, reason: 'Cantrip 尚未配置；请在 /model → 模型档位 中设置' })
    for (const config of [{ provider: 'main', model: 'deepseek-chat' }, { alias: 'default', provider: 'main' }]) {
      expect(resolveModelChoice({ providers, aliases, config: config as ModelSwitchRequest }).ok).toBe(false)
    }
  })

  test('思考修改不重新解析可变映射；更换实际组合重置不适用思考，成员隔离', () => {
    const changed = { ...aliases, default: aliases.cantrip }
    const reasoning = resolveModelChoice({ providers, aliases: changed, defaults, config: { reasoning: { mode: 'off' } } })
    expect(reasoning).toEqual({ ok: true, selection: { ...defaults, reasoning: { mode: 'off' } } })
    const chosen = resolveModelChoice({ providers, aliases: changed, defaults, config: { alias: 'default' } })
    expect(chosen).toEqual({ ok: true, selection: { alias: 'default', ...aliases.cantrip } })
    const options = { providers, stamper: makeTestStamper(), env: {} }
    const first = createAgentModels({ options, aliases, defaults })
    const second = createAgentModels({ options, aliases, defaults, config: { alias: 'cantrip' } })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('成员未创建')
    expect(second.models.use({ ...second.selection, reasoning: { mode: 'off' } }).ok).toBe(true)
    expect(first.models.current()).toEqual(defaults)
    const resumed = createModelRegistry(options)
    expect(resumed.use(first.selection)).toEqual({ ok: true, selection: defaults })
    const created = createAgentModels({ options, aliases: changed, defaults: first.selection })
    expect(created.ok && created.selection).toEqual({ alias: 'default', ...aliases.cantrip })
    expect(resolveModelChoice({ providers, aliases, defaults, role: { alias: 'spell' }, config: { alias: 'cantrip' } })).toEqual({ ok: true, selection: { alias: 'cantrip', ...aliases.cantrip } })
    expect(resolveModelChoice({ providers, aliases: { cantrip: aliases.cantrip }, defaults, role: { alias: 'spell' }, config: { alias: 'cantrip' } })).toEqual({ ok: true, selection: { alias: 'cantrip', ...aliases.cantrip } })
  })

  test('真装配出站来自配置；映射编辑保留当前成员，明确切换才采用新组合', async () => {
    const wire = endpoint()
    const stage = makeStage({ config: { providers, modelAliases: aliases } })
    const assembly = stage.assemble({ modelGateway: undefined, modelFetch: wire.fetch })
    const shell = attachShell(assembly.shell)
    try {
      await shell.submit('第一轮')
      const before = assembly.models?.current()
      const changed = { ...aliases, default: aliases.cantrip }
      const raw = JSON.parse(readFileSync(stage.configPath, 'utf8'))
      writeFileSync(stage.configPath, JSON.stringify({ ...raw, modelAliases: changed }))
      expect(assembly.switchModel({ provider: 'aux', model: 'deepseek-chat' } as unknown as ModelSwitchRequest).ok).toBe(false)
      expect(assembly.models?.current()).toEqual(before)
      await shell.submit('原成员继续')
      expect(wire.seen.map(one => one.url)).toEqual(['https://main.example/v1/chat/completions', 'https://main.example/v1/chat/completions'])
      expect(assembly.switchModel({ alias: 'default' }).ok).toBe(true)
      await shell.submit('明确应用新配置')
      expect(wire.seen.at(-1)?.url).toBe('https://aux.example/v1/chat/completions')
      expect(wire.seen.every(one => one.body.model === 'deepseek-chat')).toBe(true)
      expect(assembly.models?.current()).toEqual({ alias: 'default', ...aliases.cantrip })
    } finally { shell.dispose(); assembly.close(); stage.dispose() }
  })

  for (const scenario of ['success', 'capacity', 'server', 'server-large', 'missing', 'auth', 'network', 'empty', 'incomplete'] as const) test(`独立 Cantrip 压缩：${scenario}，请求无工具且关闭思考，失败保留原文`, async () => {
    const wire = endpoint({ failure: scenario === 'server' || scenario === 'server-large', ...(['auth', 'network', 'empty', 'incomplete'].includes(scenario) ? { summaryFailure: scenario as 'auth' | 'network' | 'empty' | 'incomplete' } : {}) })
    const configured = scenario === 'capacity' ? { ...providers, aux: { ...providers.aux, modelOverrides: { 'deepseek-chat': { limits: { maxInputTokens: 1 } } } } } : scenario === 'server-large' ? { ...providers, aux: { ...providers.aux, modelOverrides: { 'deepseek-chat': { limits: { maxInputTokens: 10000000 } } } } } : providers
    const configuredAliases: ModelAliases = scenario === 'missing' ? { default: aliases.default, spell: aliases.spell, arcane: aliases.arcane } : aliases
    const stage = makeStage({ config: { providers: configured, modelAliases: configuredAliases } })
    const assembly = stage.assemble({ modelGateway: undefined, modelFetch: wire.fetch,
      context: { nearEntries: 1, compactAtTokens: 1, compactAtFraction: 0.000001 } })
    const shell = attachShell(assembly.shell)
    try {
      await shell.submit('保留这项约束')
      await shell.submit('继续这项工作')
      const summaryCalls = wire.seen.filter(one => one.url.includes('aux.example'))
      if (scenario === 'capacity' || scenario === 'missing') expect(summaryCalls).toHaveLength(0)
      else {
        expect(summaryCalls).toHaveLength(scenario === 'network' ? 3 : 1)
        expect(summaryCalls[0]?.body.thinking).toEqual({ type: 'disabled' })
        expect(summaryCalls[0]?.body.tools).toBeUndefined()
      }
      const database = readDatabase(assembly.paths.database)
      const entries = database.entries
      database.close()
      expect(entries.filter(one => one.kind === 'user')).toHaveLength(2)
      expect(assembly.models?.current()).toEqual({ alias: 'default', ...aliases.default })
      if (scenario === 'success') {
        expect(entries.filter(one => one.kind === 'summary')).toHaveLength(1)
        expect(eventsOfKind(shell.events, 'context.compacted')).toHaveLength(1)
      } else {
        expect(entries.filter(one => one.kind === 'summary')).toHaveLength(0)
        expect(eventsOfKind(shell.events, 'context.compacted')).toHaveLength(0)
        const error = eventsOfKind(shell.events, 'error').map(event => event.data.message).join('\n')
        expect(error).toContain('原始记录已保留')
        expect(error).toContain(({ capacity: '当前设置的上下文窗口不足', server: '所用模型拒绝了这次请求', 'server-large': '所用模型拒绝了这次请求', missing: 'Cantrip 尚未配置', auth: 'authentication failed', network: 'controlled network failure', empty: '没给出摘要正文', incomplete: '摘要生成未走完' } as Record<string, string>)[scenario]!)
        if (['capacity', 'server', 'server-large'].includes(scenario)) expect(error).toContain(stage.configPath)
        expect(error).not.toContain('local-aux')
      }
      const evidence = process.env['MAGIC_U113_EVIDENCE']
      if (evidence) writeFileSync(`${evidence}/compression-${scenario}.json`, JSON.stringify({ scenario, configPath: stage.configPath, requests: wire.seen, errors: eventsOfKind(shell.events, 'error'), summaries: entries.filter(one => one.kind === 'summary'), compacted: eventsOfKind(shell.events, 'context.compacted') }, null, 2))
    } finally { shell.dispose(); assembly.close(); stage.dispose() }
  }, 10000)

  test('原上下文已超限且 Cantrip 压缩失败，只发一次原超限请求，不递归或升档', async () => {
    const wire = endpoint({ mainLimit: true, failure: true })
    const stage = makeStage({ config: { providers, modelAliases: aliases } })
    const app = stage.assemble({ modelGateway: undefined, modelFetch: wire.fetch, context: { nearEntries: 1, compactAtTokens: 100000000, compactAtFraction: 2 } })
    const shell = attachShell(app.shell)
    try {
      await shell.submit('已经确认的约束与原始工作')
      await shell.submit('继续这件工作')
      expect(wire.seen.filter(one => one.url.includes('main.example'))).toHaveLength(2)
      expect(wire.seen.filter(one => one.url.includes('aux.example'))).toHaveLength(1)
      expect(eventsOfKind(shell.events, 'error').map(one => one.data.message).join('\n')).toContain('暂不能继续')
      const db = readDatabase(app.paths.database)
      expect(db.entries.filter(one => one.kind === 'user')).toHaveLength(2)
      expect(db.entries.filter(one => one.kind === 'summary')).toEqual([])
      db.close()
      expect(eventsOfKind(shell.events, 'context.compacted')).toEqual([])
      expect(app.models?.current()).toEqual({ alias: 'default', ...aliases.default })
    } finally { shell.dispose(); app.close(); stage.dispose() }
  })

  test('取消只中断正在生成的 Cantrip 摘要，原记录与主选择保留', async () => {
    const wire = endpoint({ summaryFailure: 'cancel' })
    const stage = makeStage({ config: { providers, modelAliases: aliases } })
    const app = stage.assemble({ modelGateway: undefined, modelFetch: wire.fetch, context: { nearEntries: 1, compactAtTokens: 1, compactAtFraction: 0.000001 } })
    const shell = attachShell(app.shell)
    try {
      await shell.submit('保留原始约束')
      const pending = shell.submit('继续工作')
      const until = Date.now() + 3000
      while (!wire.seen.some(one => one.url.includes('aux.example'))) { if (Date.now() > until) throw new Error('摘要未出站'); await Bun.sleep(5) }
      shell.send({ type: 'turn.interrupt' })
      await pending
      expect(eventsOfKind(shell.events, 'error').map(one => one.data.message).join('\n')).toContain('上下文压缩已取消，原始记录已保留')
      const db = readDatabase(app.paths.database)
      expect(db.entries.filter(one => one.kind === 'summary')).toEqual([])
      expect(db.entries.filter(one => one.kind === 'user')).toHaveLength(2)
      db.close()
      expect(wire.seen.filter(one => one.url.includes('aux.example'))).toHaveLength(1)
      expect(app.models?.current()).toEqual({ alias: 'default', ...aliases.default })
    } finally { shell.dispose(); app.close(); stage.dispose() }
  })

  test('模型域没有隐含缺省或请求型号旁路；未提交选择不发请求', async () => {
    const wire = endpoint()
    const models = createModelRegistry({ providers, stamper: makeTestStamper(), fetch: wire.fetch })
    const stream = models.stream({ model: 'deepseek-chat', messages: [{ role: 'user', content: '输入' }] })
    for await (const _event of stream.events) { /* 消费流 */ }
    expect((await stream.result).error).toBeDefined()
    expect(wire.seen).toHaveLength(0)
  })
})
