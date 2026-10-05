import { describe, expect, test } from 'bun:test'
import type {
  AgentIdentity, AgentMessage, Entry, InboxItem, MessagePart, RecordsService, UserMessageContent,
} from '@magic/contracts'
import { makeFauxRecords } from '@magic/faux'
import { assembleContext, pairingKeyOf } from '../src/context.ts'

const self: AgentIdentity = {
  agentId: 'receiver', sessionId: 'receiving-session', name: 'Receiver', role: '',
  model: { alias: 'default', provider: 'test', model: 'test' }, workspace: ['/work'],
  collaborationId: 'collaboration', reachability: 'active', at: 1,
}
function message(id: number, body: readonly MessagePart[]): AgentMessage {
  return { messageId: id, collaborationId: 'collaboration', senderId: 'sender',
    recipients: [self.agentId], purpose: 'constraint', body, at: 1, withdrawn: false }
}
function reference(id: number, messageId: number): Entry {
  return { id, kind: 'agent-message', content: { text: '' }, at: 1, source: 'source-session',
    payload: { messageId, collaborationId: 'collaboration', senderId: 'sender' } }
}
function fixture() {
  const messages = new Map<number, AgentMessage>()
  const sessions = new Map<string, Entry[]>([[self.sessionId, []]])
  const receipts: InboxItem[] = []
  const reads: string[] = []
  const included: number[][] = []
  const base = makeFauxRecords()
  const collaboration = {
    ...base.collaboration,
    agentForSession: () => self,
    readMessage(actor: string, id: number) {
      reads.push(`message:${actor}:${id}`)
      return messages.get(id)
    },
    inbox: () => receipts,
  }
  const records: RecordsService = {
    ...base, collaboration,
    async *readEntries(session, range) {
      reads.push(`entries:${session}:${range?.from ?? 'all'}`)
      for (const entry of sessions.get(session) ?? []) {
        if (range?.from !== undefined && entry.id < range.from) continue
        if (range?.to !== undefined && entry.id > range.to) continue
        yield entry
      }
    },
  }
  function add(m: AgentMessage, entryId: number, includedAt?: number) {
    messages.set(m.messageId, m)
    sessions.get(self.sessionId)!.push(reference(entryId, m.messageId))
    receipts.push({ position: receipts.length + 1, recipientId: self.agentId, messageId: m.messageId,
      state: 'consumed', entryId, consumedAt: 2, ...(includedAt === undefined ? {} : { includedAt }) })
  }
  const assemble = (nearEntries?: number) => assembleContext({ records, session: self.sessionId,
    systemPrompt: 'system', blobTextLimit: 5, ...(nearEntries === undefined ? {} : { nearEntries }),
    onIncluded: ids => included.push([...ids]),
  })
  return { messages, sessions, receipts, reads, included, base, records, add, assemble }
}
function text(content: UserMessageContent): string {
  return typeof content === 'string' ? content : content.map(p => p.type === 'text' ? p.text : '<image>').join('')
}

describe('协作上下文 · 权威材料投影', () => {
  test('授权后按有序正文读取 entry/blob，用户 refs、技能、图片和来源都保留', async () => {
    const f = fixture()
    const bytes = new Uint8Array([137, 80, 78, 71, 5, 6])
    const image = await f.base.blobs.put(bytes)
    const longPrefix = '较长的用户交代'.repeat(8)
    const said = `${longPrefix}先看 @note.md，再看 Image#1，然后 /review，结束。`
    const sourceBody = await f.base.blobs.put(said)
    const directBlob = await f.base.blobs.put('消息自身的完整 blob 正文')
    f.sessions.set('source-session', [{ id: 7, kind: 'user', content: { blob: sourceBody }, at: 1,
      payload: {
        refs: [
          { kind: 'skill', at: said.indexOf('/review'), marker: '/review', source: '/work/skills/review', label: '项目技能', name: 'review', text: '逐项复核' },
          { kind: 'image', at: said.indexOf('Image#1'), marker: 'Image#1', source: '/work/photo.png', label: '用户选择的图片', name: 'photo.png', mime: 'image/png', blob: image },
          { kind: 'file', at: said.indexOf('@note.md'), marker: '@note.md', source: '/outside/note.md', label: '外部说明', text: '文件内的要求', external: true },
        ],
        skills: [{ name: 'legacy', source: '/work/legacy', label: '历史技能来源', text: '旧技能实际正文' }],
      },
    }])
    f.add({ ...message(91, [
      { kind: 'text', text: '在材料之前' },
      { kind: 'entry', ref: { sessionId: 'source-session', entryId: 7 }, label: '原始交代' },
      { kind: 'blob', blob: directBlob },
      { kind: 'text', text: '在材料之后' },
    ]), userSource: { sessionId: 'source-session', entryId: 7 } }, 20)

    const assembled = await f.assemble()
    const delivered = assembled.at(-1)!
    expect(delivered.role).toBe('user')
    if (delivered.role !== 'user') throw new Error('expected user material')
    expect(typeof delivered.content).not.toBe('string')
    const visible = text(delivered.content)
    const ordered = ['在材料之前', 'source-session#7', '旧技能实际正文', longPrefix,
      '@note.md', '文件内的要求', 'Image#1', '<image>', '/review', '逐项复核', '结束。',
      '消息自身的完整 blob 正文', '在材料之后']
    let cursor = -1
    for (const part of ordered) { const next = visible.indexOf(part, cursor + 1); expect(next).toBeGreaterThan(cursor); cursor = next }
    expect(visible).toContain('不是新的用户授权或审批')
    expect(visible).toContain('工作区外 · 只读附件')
    expect(visible).toContain('用户选择的图片')
    expect(visible).toContain('历史技能来源')
    const parts = typeof delivered.content === 'string' ? [] : delivered.content
    expect(parts.filter(p => p.type === 'image')).toEqual([{ type: 'image', mime: 'image/png', data: bytes }])
    expect(f.reads.indexOf('message:receiver:91')).toBeLessThan(f.reads.indexOf('entries:source-session:7'))
    expect(f.included).toEqual([[91]])
  })

  test('只有 skills 的旧用户材料与无正文的按需引用沿原语义投影', async () => {
    const f = fixture()
    f.sessions.set('source-session', [
      { id: 1, kind: 'user', content: { text: '旧式交代' }, at: 1, payload: { skills: [
        { name: 'review', source: '/skills/review', label: '旧来源', text: '旧技能步骤' },
      ] } },
      { id: 2, kind: 'user', content: { text: '请读 @a.ts 再继续' }, at: 2, payload: { refs: [
        { kind: 'file', at: 3, marker: '@a.ts', source: '/work/a.ts', label: 'a.ts' },
      ] } },
    ])
    f.add(message(81, [
      { kind: 'entry', ref: { sessionId: 'source-session', entryId: 1 } },
      { kind: 'entry', ref: { sessionId: 'source-session', entryId: 2 } },
    ]), 20)
    const last = (await f.assemble()).at(-1)!
    if (last.role !== 'user') throw new Error('expected material')
    expect(typeof last.content).toBe('string')
    expect(text(last.content)).toContain('旧技能步骤\n\n旧式交代')
    expect(text(last.content)).toContain('请读 @a.ts 再继续')
    expect(text(last.content)).not.toContain('已读取文件')
  })

  test('工具条目被引用时仅是材料，不新增工具调用或破坏本会话配对', async () => {
    const f = fixture()
    f.sessions.set('source-session', [{ id: 4, kind: 'tool-call', content: { text: '另一会话的调用说明' }, payload: { name: 'exec', args: { cmd: 'must-not-replay' } }, at: 1 }])
    f.sessions.get(self.sessionId)!.push({ id: 1, kind: 'assistant', content: { text: '执行一件事' }, at: 1 })
    f.add(message(41, [{ kind: 'entry', ref: { sessionId: 'source-session', entryId: 4 } }]), 2)
    f.sessions.get(self.sessionId)!.push({ id: 3, kind: 'tool-call', content: { text: '' }, payload: { name: 'exec', args: { cmd: 'local' } }, at: 1 })
    f.add(message(42, [{ kind: 'text', text: '两条工具记录之间的协作消息' }]), 4)
    f.sessions.get(self.sessionId)!.push({ id: 5, kind: 'tool-result', content: { text: '结果' }, payload: { ok: true, output: { text: '结果' } }, at: 1 })
    const assembled = await f.assemble()
    expect(assembled.map(m => m.role)).toEqual(['system', 'assistant', 'tool', 'user', 'user'])
    expect(assembled[1]).toMatchObject({ toolCalls: [{ id: pairingKeyOf(3), name: 'exec', args: { cmd: 'local' } }] })
    expect(assembled[2]).toMatchObject({ callId: pairingKeyOf(3), output: '结果' })
    expect(JSON.stringify(assembled)).not.toContain('must-not-replay')
    expect(f.included).toEqual([[41, 42]])
  })
})

describe('协作上下文 · 压缩与准确带入', () => {
  test('压缩不裁掉未 included 的已消费消息；已带入旧消息按压缩边界退出，撤回不计入', async () => {
    const f = fixture()
    f.add(message(90, [{ kind: 'text', text: '已经带入并已压缩' }]), 1, 2)
    f.add(message(12, [{ kind: 'text', text: '已消费但仍未带入' }]), 2)
    f.sessions.get(self.sessionId)!.push({ id: 3, kind: 'summary', content: { text: '旧记录摘要' }, at: 3 })
    f.add(message(50, [{ kind: 'text', text: '当前窗口消息' }]), 4, 5)
    f.add({ ...message(70, [{ kind: 'text', text: '已撤回正文' }]), withdrawn: true }, 5)
    // 同一消息出现重复引用，也只能展开一次。
    f.sessions.get(self.sessionId)!.push(reference(6, 50))
    const assembled = await f.assemble(0)
    const output = JSON.stringify(assembled)
    expect(output).toContain('已消费但仍未带入')
    expect(output).toContain('当前窗口消息')
    expect(output).not.toContain('已经带入并已压缩')
    expect(output).not.toContain('已撤回正文')
    expect(output.match(/当前窗口消息/g)).toHaveLength(1)
    expect(f.included).toEqual([[12, 50]])
    // 装配只报告投影，不偷偷把消费事实提升为真实请求。
    expect(f.receipts.find(i => i.messageId === 12)?.includedAt).toBeUndefined()
    f.receipts[1] = { ...f.receipts[1]!, includedAt: 10 }
    expect(JSON.stringify(await f.assemble(0))).not.toContain('已消费但仍未带入')
    expect(f.included.at(-1)).toEqual([50])
  })

  test('压缩窗口外的未带入原始图片仍然成为真实图像部件', async () => {
    const f = fixture()
    const bytes = new Uint8Array([3, 1, 4])
    const blob = await f.base.blobs.put(bytes)
    f.sessions.set('source-session', [{ id: 1, kind: 'user', content: { text: '看 Image#1 处理' }, at: 1, payload: { refs: [
      { kind: 'image', at: 2, marker: 'Image#1', name: 'a.png', source: '/a.png', label: '图片来源', mime: 'image/png', blob },
    ] } }])
    f.add(message(3, [{ kind: 'entry', ref: { sessionId: 'source-session', entryId: 1 } }]), 1)
    f.sessions.get(self.sessionId)!.push({ id: 2, kind: 'summary', content: { text: '摘要不含图片' }, at: 2 })
    const assembled = await f.assemble(0)
    const delivered = assembled.at(-1)!
    if (delivered.role !== 'user' || typeof delivered.content === 'string') throw new Error('image was lost')
    expect(delivered.content.find(p => p.type === 'image')).toEqual({ type: 'image', mime: 'image/png', data: bytes })
    expect(f.included).toEqual([[3]])
  })

  test('普通会话不访问协作目录，成功装配回传空 ID 列表', async () => {
    const records = makeFauxRecords()
    const calls: number[][] = []
    await assembleContext({ records: { ...records, get collaboration(): RecordsService['collaboration'] { throw new Error('not accessed') } }, session: 'plain', systemPrompt: 'system', onIncluded: ids => calls.push([...ids]) })
    expect(calls).toEqual([[]])
  })
})

describe('协作上下文 · 读取失败不降级', () => {
  test('readMessage 未授权时不读引用；缺 entry 或 blob 均使整次装配失败且不回报 included', async () => {
    const f = fixture()
    f.add(message(11, [{ kind: 'entry', ref: { sessionId: 'secret', entryId: 1 } }]), 1)
    f.messages.delete(11)
    await expect(f.assemble()).rejects.toThrow('无权读取')
    expect(f.reads.some(r => r.startsWith('entries:secret:'))).toBe(false)
    expect(f.included).toEqual([])
    f.messages.set(11, message(11, [{ kind: 'entry', ref: { sessionId: 'missing', entryId: 2 } }]))
    await expect(f.assemble()).rejects.toThrow('missing#2')
    f.messages.set(11, message(11, [{ kind: 'blob', blob: 'missing-blob' }]))
    await expect(f.assemble()).rejects.toThrow('missing-blob')
    f.sessions.set('source-session', [{ id: 3, kind: 'user', content: { blob: 'missing-body-blob' }, at: 1 }])
    f.messages.set(11, message(11, [{ kind: 'entry', ref: { sessionId: 'source-session', entryId: 3 } }]))
    await expect(f.assemble()).rejects.toThrow('missing-body-blob')
    expect(f.included).toEqual([])
  })

  test('引用用户图片缺字节时，不降成有路径的文本；已有其他消息也不提前报告成功', async () => {
    const f = fixture()
    f.add(message(1, [{ kind: 'text', text: '第一条可成功' }]), 1)
    f.sessions.set('source-session', [{ id: 7, kind: 'user', content: { text: '看 Image#1' }, at: 1, payload: { refs: [
      { kind: 'image', at: 2, marker: 'Image#1', name: 'photo.png', source: '/photo.png', label: 'photo', mime: 'image/png', blob: 'missing-image' },
    ] } }])
    f.add(message(2, [{ kind: 'entry', ref: { sessionId: 'source-session', entryId: 7 } }]), 2)
    await expect(f.assemble()).rejects.toThrow('missing-image')
    expect(f.included).toEqual([])
  })

  test('引用另一条协作记录时重新检查消息权限，并明确拒绝循环引用', async () => {
    const f = fixture()
    f.sessions.set('source-session', [reference(7, 10)])
    f.add(message(9, [{ kind: 'entry', ref: { sessionId: 'source-session', entryId: 7 } }]), 1)
    await expect(f.assemble()).rejects.toThrow('消息 10 不可读取')
    f.messages.set(10, message(10, [{ kind: 'entry', ref: { sessionId: 'source-session', entryId: 7 } }]))
    await expect(f.assemble()).rejects.toThrow('循环')
    f.messages.set(10, message(10, [{ kind: 'text', text: '内层真实正文' }]))
    const assembled = await f.assemble()
    expect(JSON.stringify(assembled)).toContain('内层真实正文')
    expect(f.included).toEqual([[9]])
  })
})

test('读取条目期间新消费的消息按持久收件位置补入；尚未消费的消息不越过领取', async () => {
  const f = fixture()
  f.add(message(20, [{ kind: 'text', text: '原有消息' }]), 1, 2)
  f.messages.set(11, message(11, [{ kind: 'text', text: '刚完成消费' }]))
  f.messages.set(9, message(9, [{ kind: 'text', text: '仍未消费' }]))
  f.receipts.push({ position: 2, recipientId: self.agentId, messageId: 11, state: 'consumed', consumedAt: 3, entryId: 2 })
  f.receipts.push({ position: 3, recipientId: self.agentId, messageId: 9, state: 'pending' })
  const assembled = await f.assemble()
  expect(JSON.stringify(assembled)).toContain('刚完成消费')
  expect(JSON.stringify(assembled)).not.toContain('仍未消费')
  expect(f.included).toEqual([[20, 11]])
})
