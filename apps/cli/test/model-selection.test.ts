import type { MagicConfig } from '@magic/contracts'
import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import type { AgentModelConfig, ModelSwitchRequest } from '@magic/contracts'
import { makeTestStamper } from '@magic/faux'
import { createModelRegistry } from '@magic/model'
import { createAgentModels, resolveModelChoice } from '@magic/host'
import { configureModel } from '@magic/state'
import { loadConfig } from '@magic/state'
import { parseArgs } from '../src/cli.ts'
import { attachShell } from '../src/shell.ts'
import { makeStage, eventsOfKind, readDatabase } from './support.ts'
import { magicAt, removeDir, tempDir, writeConfig } from './tmp.ts'

const providers = {
  main: { vendor: 'deepseek', protocol: 'chat-completions' as const, apiKey: 'local-main', baseURL: 'https://main.example/v1' },
  aux: { vendor: 'deepseek', protocol: 'chat-completions' as const, apiKey: 'local-aux', baseURL: 'https://aux.example/v1' },
}
const configuredModels = {
  cantrip: { provider: 'aux', model: 'deepseek-flash' },
  spell: { provider: 'main', model: 'deepseek-v4-pro' },
  arcane: { provider: 'main', model: 'deepseek-flash' },
} satisfies NonNullable<MagicConfig['models']>
const defaults: AgentModelConfig = { protocol: 'chat-completions', endpoint: providers.main.baseURL, choice: 'arcane', provider: 'main', model: 'deepseek-flash', reasoning: { mode: 'level', level: 'high' } }

const isPreparation = (body: Record<string, any>): boolean => body.messages?.[0]?.content?.startsWith('你是这次交接的记录者') === true

function endpoint(options: { failure?: 'server' | 'auth' | 'network' | 'empty' | 'incomplete' | 'cancel'; mainLimit?: boolean } = {}) {
  const seen: { url: string; body: Record<string, any> }[] = []
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'deepseek-flash', reasoning: { disable: true, levels: ['high'] } }, { id: 'deepseek-v4-pro' }] })
    const body = JSON.parse(String(init?.body))
    seen.push({ url, body })
    const prepare = isPreparation(body)
    if (!prepare && options.mainLimit && seen.filter(one => !isPreparation(one.body)).length === 2) return Response.json({ error: { message: 'maximum context length exceeded' } }, { status: 400 })
    if (prepare && options.failure === 'auth') return Response.json({ error: { message: 'authentication failed' } }, { status: 401 })
    if (prepare && options.failure === 'network') throw new TypeError('fetch failed: controlled network failure')
    if (prepare && options.failure === 'cancel') return await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('controlled cancelled', 'AbortError')), { once: true }) })
    if (prepare && options.failure === 'server') return Response.json({ error: { message: 'maximum context length exceeded' } }, { status: 400 })
    const frame = (choices: unknown, usage?: unknown) => `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: body.model, choices, usage })}\n\n`
    const turn = prepare && !options.failure ? { text: '## 目标与阶段\n保留这项约束\n## 下一步\n继续' } : { text: prepare ? options.failure === 'empty' ? '' : '半截准备' : '工作答复' }
    return new Response(
      frame([{ index: 0, delta: { role: 'assistant', ...(prepare ? { reasoning_content: '真实接续思考：先读证据再保存' } : {}), content: turn.text ?? '' } }]) +
      (prepare && options.failure === 'incomplete' ? '' : frame([{ index: 0, delta: {}, finish_reason: 'stop' }], { prompt_tokens: 100, completion_tokens: 10 })) + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof globalThis.fetch
  return { seen, fetch }
}

describe('统一模型配置与执行选择', () => {
  test('首次初始化只填缺失档位；日后改 Default 不连改三档，无模型调用', async () => {
    const root = tempDir('u113-save-')
    try {
      const path = writeConfig(root, { providers, models: { arcane: configuredModels.arcane }, permissions: { rules: [] }, marker: '保留' })
      expect((await configureModel({ path, request: { choice: 'cantrip', provider: 'main', model: 'deepseek-flash', initialize: true } }))).toEqual({ ok: true })
      const first = JSON.parse(readFileSync(path, 'utf8'))
      const seeded = { provider: 'main', model: 'deepseek-flash' }
      expect(first.models).toEqual({ cantrip: seeded, spell: seeded, arcane: configuredModels.arcane })
      expect(first.defaultTier).toBe('cantrip')
      expect((await configureModel({ path, request: { choice: 'cantrip', provider: 'aux', model: 'other' } }))).toEqual({ ok: true })
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      expect(saved.models.cantrip).toEqual({ provider: 'aux', model: 'other' })
      expect(saved.models.spell).toEqual(seeded)
      expect(saved.marker).toBe('保留')
      expect(saved.permissions).toEqual({ rules: [] })
      expect(loadConfig({ path, magic: magicAt(root) }).config.models).toEqual(saved.models)
    } finally { removeDir(root) }
  })

  test('配置损坏和旧来源明确拒绝，不覆盖、不迁移', async () => {
    const root = tempDir('u113-invalid-')
    try {
      for (const config of [
        { providers: { main: { ...providers.main, model: 'raw' } } },
        { providers: { main: { ...providers.main, modelOverrides: { 'deepseek-flash': { reasoning: { mode: 'off' } } } } } },
        { providers, models: { wrong: configuredModels.cantrip } },
        { providers, models: { cantrip: { provider: 'missing', model: 'raw' } } },
        { providers, agentRoles: { worker: { name: '执行', instructions: '执行', model: { provider: 'main', model: 'raw' } } } },
      ]) {
        const path = writeConfig(root, config)
        const before = readFileSync(path, 'utf8')
        expect(() => loadConfig({ path, magic: magicAt(root) })).toThrow()
        expect(readFileSync(path, 'utf8')).toBe(before)
      }
      const path = writeConfig(root, { providers, models: [] })
      expect((await configureModel({ path, request: { choice: 'cantrip', ...configuredModels.cantrip } })).ok).toBe(false)
    } finally { removeDir(root) }
  })

  test('CLI 只接受四个小写标识，供应商与原始型号在调用前被拒绝', () => {
    expect(parseArgs(['--model', 'spell']).switch).toEqual({ choice: 'spell' })
    expect(() => parseArgs(['--model', 'deepseek-flash'])).toThrow('只能选择')
    expect(() => parseArgs(['--provider', 'main'])).toThrow('不认得')
    expect(() => parseArgs(['--model', 'Spell'])).toThrow('只能选择')
    expect(resolveModelChoice({ providers, configuredModels: {}, config: { choice: 'cantrip' } })).toEqual({ ok: false, reason: 'Cantrip 尚未配置；请在 /model → 模型档位 中设置' })
    for (const config of [{ provider: 'main', model: 'deepseek-flash' }, { choice: 'cantrip', provider: 'main' }]) {
      expect(resolveModelChoice({ providers, configuredModels, config: config as ModelSwitchRequest }).ok).toBe(false)
    }
  })

  test('思考修改不重新解析可变映射；更换实际组合重置不适用思考，成员隔离', () => {
    const modelInfoOf = (_provider: string, id: string) => ({ id, reasoning: { disable: true, levels: ['high'] } })
    const changed = { ...configuredModels, default: configuredModels.cantrip }
    const reasoning = resolveModelChoice({ providers, modelInfoOf, configuredModels: changed, defaults, config: { reasoning: { mode: 'off' } } })
    expect(reasoning).toEqual({ ok: true, selection: { ...defaults, reasoning: { mode: 'off' } } })
    const chosen = resolveModelChoice({ providers, configuredModels: changed, defaults, config: { choice: 'cantrip' } })
    expect(chosen).toEqual({ ok: true, selection: { choice: 'cantrip', ...configuredModels.cantrip, protocol: 'chat-completions', endpoint: providers.aux.baseURL } })
    const options = { providers, modelInfoOf, stamper: makeTestStamper(), env: {} }
    const first = createAgentModels({ options, configuredModels, defaults })
    const second = createAgentModels({ options, configuredModels, defaults, config: { choice: 'cantrip' } })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('成员未创建')
    expect(second.models.use({ ...second.selection, reasoning: { mode: 'off' } }).ok).toBe(true)
    expect(first.models.current()).toEqual(defaults)
    const resumed = createModelRegistry(options)
    expect(resumed.use(first.selection)).toEqual({ ok: true, selection: defaults })
    const created = createAgentModels({ options, configuredModels: changed, defaults: first.selection })
    // 新成员原样继承此前有效组合（映射编辑不重解析）；显式选择才换映射（下面两行守）
    expect(created.ok && created.selection).toEqual(first.selection)
    expect(resolveModelChoice({ providers, configuredModels, defaults, role: { choice: 'spell' }, config: { choice: 'cantrip' } })).toEqual({ ok: true, selection: { choice: 'cantrip', ...configuredModels.cantrip, protocol: 'chat-completions', endpoint: providers.aux.baseURL } })
    expect(resolveModelChoice({ providers, configuredModels: { cantrip: configuredModels.cantrip }, defaults, role: { choice: 'spell' }, config: { choice: 'cantrip' } })).toEqual({ ok: true, selection: { choice: 'cantrip', ...configuredModels.cantrip, protocol: 'chat-completions', endpoint: providers.aux.baseURL } })
  })

  test('真装配出站来自配置；映射编辑保留当前成员，明确切换才采用新组合', async () => {
    const wire = endpoint()
    const stage = makeStage({ config: { providers, models: configuredModels } })
    const assembly = stage.assemble({ modelGateway: undefined, modelFetch: wire.fetch })
    const shell = attachShell(assembly.shell)
    try {
      await shell.submit('第一轮')
      const before = assembly.models?.current()
      const changed = { ...configuredModels, spell: { provider: 'main', model: 'deepseek-v4-pro' } }
      const raw = JSON.parse(readFileSync(stage.configPath, 'utf8'))
      writeFileSync(stage.configPath, JSON.stringify({ ...raw, models: changed }))
      expect(assembly.switchModel({ provider: 'aux', model: 'deepseek-flash' } as unknown as ModelSwitchRequest).ok).toBe(false)
      expect(assembly.models?.current()).toEqual(before)
      await shell.submit('原成员继续')
      expect(wire.seen.map(one => one.url)).toEqual(['https://aux.example/v1/chat/completions', 'https://aux.example/v1/chat/completions'])
      expect(assembly.switchModel({ choice: 'spell' }).ok).toBe(true)
      await shell.submit('明确应用新配置')
      expect(wire.seen.at(-1)?.url).toBe('https://main.example/v1/chat/completions')
      expect(wire.seen.at(-1)?.body.model).toBe('deepseek-v4-pro')
      expect(assembly.models?.current()).toEqual({ choice: 'spell', ...changed.spell, protocol: 'chat-completions', endpoint: providers.main.baseURL })
    } finally { shell.dispose(); assembly.close(); stage.dispose() }
  })

  test('当前模型接续简报：单次无工具调用，不切换 Cantrip', async () => {
    const wire = endpoint()
    const stage = makeStage({ config: { providers, models: configuredModels } })
    const assembly = stage.assemble({ modelGateway: undefined, modelFetch: wire.fetch,
      context: { nearTokens: 0, compactAtTokens: 1, compactAtFraction: 0.000001 } })
    const shell = attachShell(assembly.shell)
    try {
      await shell.submit('保留这项约束')
      await shell.submit('继续这项工作')
      const calls = wire.seen.filter(one => isPreparation(one.body))
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every(one => one.body.tools === undefined)).toBe(true)
      expect(wire.seen.every(one => one.url === 'https://aux.example/v1/chat/completions' && one.body.model === 'deepseek-flash')).toBe(true)
      const database = readDatabase(assembly.paths.database)
      try {
        // 两条用户交代 ＋ 一条交接材料（新上下文的第一句用户输入）
        expect(database.entries.filter(one => one.kind === 'user')).toHaveLength(3)
        expect(database.entries.filter(one => one.kind === 'summary').length).toBeGreaterThan(0)
        expect(database.entries.some(one => one.kind === 'continuation')).toBe(false)
      } finally { database.close() }
      expect(eventsOfKind(shell.events, 'context.compacted').length).toBeGreaterThan(0)
      expect(assembly.models?.current()).toEqual({ choice: 'cantrip', ...configuredModels.cantrip, protocol: 'chat-completions', endpoint: providers.aux.baseURL })
    } finally { shell.dispose(); assembly.close(); stage.dispose() }
  }, 10000)

  test('原上下文超限且当前模型接续准备失败，不重复业务请求或切换模型', async () => {
    const wire = endpoint({ mainLimit: true, failure: 'server' })
    const stage = makeStage({ config: { providers, models: configuredModels } })
    const app = stage.assemble({ modelGateway: undefined, modelFetch: wire.fetch, context: { nearTokens: 0, compactAtTokens: 100000000, compactAtFraction: 2 } })
    const shell = attachShell(app.shell)
    try {
      await shell.submit('已经确认的约束与原始工作')
      await shell.submit('继续这件工作')
      expect(wire.seen.filter(one => !isPreparation(one.body))).toHaveLength(2)
      expect(wire.seen.filter(one => isPreparation(one.body)).length).toBeGreaterThan(0)
      expect(wire.seen.every(one => one.url.includes('aux.example'))).toBe(true)
      expect(eventsOfKind(shell.events, 'error').map(one => one.data.message).join('\n')).toContain('暂不能继续')
      const db = readDatabase(app.paths.database)
      try {
        expect(db.entries.filter(one => one.kind === 'user')).toHaveLength(2)
        expect(db.entries.filter(one => one.kind === 'summary')).toEqual([])
      } finally { db.close() }
      expect(eventsOfKind(shell.events, 'context.compacted')).toEqual([])
      expect(app.models?.current()).toEqual({ choice: 'cantrip', ...configuredModels.cantrip, protocol: 'chat-completions', endpoint: providers.aux.baseURL })
    } finally { shell.dispose(); app.close(); stage.dispose() }
  })

  test('取消中断当前模型接续准备，原记录与模型选择保留', async () => {
    const wire = endpoint({ failure: 'cancel' })
    const stage = makeStage({ config: { providers, models: configuredModels } })
    const app = stage.assemble({ modelGateway: undefined, modelFetch: wire.fetch, context: { nearTokens: 0, compactAtTokens: 1, compactAtFraction: 0.000001 } })
    const shell = attachShell(app.shell)
    try {
      await shell.submit('保留原始约束')
      const pending = shell.submit('继续工作')
      const until = Date.now() + 3000
      while (!wire.seen.some(one => isPreparation(one.body))) { if (Date.now() > until) throw new Error('接续准备未出站'); await Bun.sleep(5) }
      shell.send({ type: 'turn.interrupt' })
      await pending
      expect(eventsOfKind(shell.events, 'error')).toEqual([])
      expect(eventsOfKind(shell.events, 'turn.end').at(-1)?.data.reason).toBe('aborted')
      const db = readDatabase(app.paths.database)
      try {
        expect(db.entries.filter(one => one.kind === 'summary')).toEqual([])
        expect(db.entries.filter(one => one.kind === 'user')).toHaveLength(2)
      } finally { db.close() }
      expect(wire.seen.filter(one => isPreparation(one.body))).toHaveLength(1)
      expect(wire.seen.every(one => one.url.includes('aux.example'))).toBe(true)
      expect(app.models?.current()).toEqual({ choice: 'cantrip', ...configuredModels.cantrip, protocol: 'chat-completions', endpoint: providers.aux.baseURL })
    } finally { shell.dispose(); app.close(); stage.dispose() }
  })

  test('模型域没有隐含缺省或请求型号旁路；未提交选择不发请求', async () => {
    const wire = endpoint()
    const models = createModelRegistry({ providers, stamper: makeTestStamper(), fetch: wire.fetch })
    const stream = models.stream({  messages: [{ role: 'user', content: '输入' }] })
    for await (const _event of stream.events) { /* 消费流 */ }
    expect((await stream.result).error).toBeDefined()
    expect(wire.seen).toHaveLength(0)
  })
})
