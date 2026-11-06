import { expect, test } from 'bun:test'
import { createRecordsStore } from '@magic/records'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMaterialReader } from '@magic/conversation'
import { makeFauxRecords } from '@magic/faux'
import type { AgentIdentity, RecordsService } from '@magic/contracts'

test('真实空正文工具调用按 payload 完整分页，保留操作名称、参数与身份', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'memory-tool-source-'))
  const store = createRecordsStore({ dataDir, workspace: [dataDir] })
  try {
    const records = store.serviceFor('source')
    const args = { cmd: '核对参数 😀\n'.repeat(6000), cwd: '/isolated/workspace' }
    const entry = records.appendEntry({ kind: 'tool-call', content: { text: '' }, payload: { id: 'call-fixture-1', name: 'exec', args }, at: 1 })
    const read = createMaterialReader({ records, session: 'source' })
    let restored = ''; let offset = 0; let pages = 0
    for (;;) {
      const page = await read({ session: 'source', entry, offset, limit: 8000 })
      expect(page.speaker).toBe('tool-call')
      expect(page.kind).toBe('tool-call')
      expect(page.source).toMatchObject({ session: 'source', entry, offset })
      restored += page.text; pages += 1
      if (page.complete) break
      expect(page.next).toBeGreaterThan(offset)
      offset = page.next!
    }
    expect(restored).toBe(`exec ${JSON.stringify(args)}`)
    expect(pages).toBeGreaterThan(1)
  } finally { store.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('长材料分页可还原，精确段可定位，不读取思考或跨会话材料', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'memory-source-'))
  const store = createRecordsStore({ dataDir, workspace: [dataDir] })
  try {
    const records = store.serviceFor('source')
    const text = '正文 abc\n'.repeat(6000)
    const blob = await records.blobs.put(text)
    const entry = records.appendEntry({ kind: 'assistant', content: { blob }, payload: { reasoning: '禁止读取思考' }, at: 1 })
    const source = createMaterialReader({ records, session: 'source' })
    let restored = ''; let offset = 0
    for (;;) {
      const page = await source({ session: 'source', entry, offset, limit: 8000 })
      restored += page.text
      if (page.next === undefined) break
      offset = page.next
    }
    expect(restored).toBe(text)
    expect((await source({ session: 'source', entry, offset: 8000, limit: 20 })).text).toBe(text.slice(8000, 8020))
    expect(restored).not.toContain('禁止读取思考')
    const resultEntry = records.appendEntry({ kind: 'tool-result', content: { text: '省略后的输出' }, payload: { ok: true, output: { blob } }, at: 2 })
    expect((await source({ session: 'source', entry: resultEntry, offset: 100, limit: 50 })).text).toBe(text.slice(100, 150))
    await expect(source({ session: 'other', entry })).rejects.toThrow('绑定范围')
    await expect(source({ session: 'source', entry: resultEntry + 1 })).rejects.toThrow('不存在')
  } finally { store.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('明确会话引用仅允许首次上界内来源，源会话后来追加不扩大权限', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'memory-source-'))
  const store = createRecordsStore({ dataDir, workspace: [dataDir] })
  try {
    const records = store.serviceFor('target')
    const source = store.serviceFor('source')
    const entry = source.appendEntry({ kind: 'user', content: { text: '原交代' }, at: 1 })
    const read = createMaterialReader({ records, session: 'target', references: [{ kind: 'session', source: 'source', through: entry, at: 0, marker: '@调查' }] })
    const later = source.appendEntry({ kind: 'assistant', content: { text: '后来认识' }, at: 2 })
    expect((await read({ session: 'source', entry })).text).toBe('原交代')
    await expect(read({ session: 'source', entry: later })).rejects.toThrow('范围')
    await expect(read({ session: 'other', entry })).rejects.toThrow('范围')
    const draft = createMaterialReader({ records, session: 'target', references: [{ kind: 'session', source: 'source', at: 0, marker: '@调查' }] })
    await expect(draft({ session: 'source', entry })).rejects.toThrow('范围')
  } finally { store.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('所选知识仅开放具体证据与后续分页，不开放同项目其他条目或证据前段', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'knowledge-source-'))
  const store = createRecordsStore({ dataDir, workspace: [dataDir] })
  try {
    const records = store.serviceFor('target')
    const source = store.serviceFor('source')
    const entry = source.appendEntry({ kind: 'assistant', content: { text: '前段\n明确证据和后文' }, at: 1 })
    const other = source.appendEntry({ kind: 'assistant', content: { text: '无关内容' }, at: 2 })
    const read = createMaterialReader({ records, session: 'target', allowedSources: [{ session: 'source', entry, offset: 3 }] })
    const page = await read({ session: 'source', entry, offset: 3, limit: 4 })
    expect(page.text).toBe('明确证据')
    expect(page.next).toBe(7)
    expect((await read({ session: 'source', entry, offset: page.next })).text).toBe('和后文')
    await expect(read({ session: 'source', entry, offset: 0 })).rejects.toThrow('范围')
    await expect(read({ session: 'source', entry: other })).rejects.toThrow('范围')
    await expect(read({ session: 'source', entry, part: 0, offset: 3 })).rejects.toThrow('范围')
  } finally { store.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('授权读取跨会话协作材料时，以来源收件身份解释正文，不借用浏览者身份', async () => {
  const base = makeFauxRecords()
  const actor: AgentIdentity = { agentId: 'source-receiver', sessionId: 'source', name: '来源成员', role: '',
    model: { protocol: 'chat-completions', endpoint: 'http://fixture.invalid', choice: 'default', provider: 'fixture', model: 'fixture' },
    workspace: ['/workspace'], collaborationId: 'work', reachability: 'active', at: 1 }
  const reads: string[] = []
  const records: RecordsService = { ...base,
    async *readEntries() { yield { id: 10, kind: 'agent-message' as const, content: { text: '' }, at: 1, source: 'source', payload: { messageId: 5, collaborationId: 'work', senderId: 'sender' } } },
    collaboration: { ...base.collaboration,
      agentForSession: session => session === 'source' ? actor : undefined,
      readMessage: (recipient, messageId) => {
        reads.push(recipient)
        return recipient === actor.agentId ? { messageId, collaborationId: 'work', senderId: 'sender', recipients: [actor.agentId], purpose: 'inform', body: [{ kind: 'text', text: '来源成员实际收到的回报' }], at: 1, withdrawn: false } : undefined
      },
    },
  }
  const read = createMaterialReader({ records, session: 'viewer', allowedSources: [{ session: 'source', entry: 10 }] })
  const page = await read({ session: 'source', entry: 10 })
  expect(page.text).toContain('来源成员实际收到的回报')
  expect(page.text).toContain('不是新的用户授权或审批')
  expect(page.speaker).toBe('agent:sender')
  expect(reads).toEqual(['source-receiver'])
})
