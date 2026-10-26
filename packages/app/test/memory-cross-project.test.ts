import { expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryChange, RecordsService } from '@magic/contracts'
import type { RecordsStore } from '@magic/records'
import { bindSessionReferences, createMemoryAccess } from '@magic/conversation'
import { attachShell, type Assembly } from '../src/index.ts'
import { eventsOfKind, lastModel, makeStage, type Stage } from './support.ts'
import { requestFromStoredSession } from './conversation-request.ts'

const CASE = 'A_VALID_CASE_仅A条件下验证的经验'
const DERIVED = 'B_CASE_基于A材料形成的待核判断'
const REQUIREMENT = 'B_REQUIREMENT_仅核对条件，不执行修改'
const INPUT = '参考 @A 作为历史案例待核条件；B的新正文仍须保留'

async function crossProject(run: (fixture: {
  stage: Stage
  app: Assembly
  shell: ReturnType<typeof attachShell>
  session: string
  records: RecordsService
  foreign: RecordsStore
  source: { session: string; entry: number }
  hiddenSource: { session: string; entry: number }
  ownSource: { session: string; entry: number; part: -1 }
}) => Promise<void>) {
  const stage = makeStage()
  const app = stage.assemble({ turns: [{ text: 'B工作准备完成' }, { text: DERIVED }, { text: '继续核对，尚未采用A的规则' }] })
  const shell = attachShell(app.shell)
  try {
    await shell.submit(REQUIREMENT)
    const session = app.session!, records = app.records.serviceFor(session)
    const entry = records.inputs.list().find(row => row.entry !== undefined)!.entry!
    const ownSource = { session, entry, part: -1 as const }
    expect(records.memory.update({ expectedRevision: 0, changes: [{ id: 'requirement', kind: 'requirement', text: REQUIREMENT,
      evidence: 'fact', status: 'active', sources: [ownSource] }] }).ok).toBe(true)
    const workspace = join(stage.root, 'project-a')
    mkdirSync(workspace)
    const foreign = app.records.forWorkspace([workspace])
    const sources: { session: string; entry: number }[] = []
    for (const [id, sourceSession] of [['KA', 'source-a'], ['KA-hidden', 'unreferenced-a']] as const) {
      const source = foreign.serviceFor(sourceSession)
      const evidence = source.appendEntry({ kind: 'user', at: 1, content: { text: 'A原始依据；A的旧工作要求不构成B授权' } })
      expect(foreign.knowledge.write([{ id, expectedRevision: 0, scope: { kind: 'project', workspace: [workspace] }, topic: 'A项目经验', terms: [],
        conclusion: id === 'KA' ? CASE : 'A_HIDDEN_未引用的其他知识', conditions: '仅A条件，B仍需核对', evidence: 'fact', status: 'active',
        sources: [{ session: sourceSession, entry: evidence }], dependencies: [] }]).ok).toBe(true)
      sources.push({ session: sourceSession, entry: source.appendEntry({ kind: 'assistant', at: 2, content: { text: id === 'KA' ? CASE : 'A_HIDDEN_未引用的其他知识' },
        payload: { knowledge: [{ id, revision: 1 }] } }) })
    }
    await run({ stage, app, shell, session, records, foreign, source: sources[0]!, hiddenSource: sources[1]!, ownSource })
    expect(eventsOfKind(shell.events, 'error')).toEqual([])
  } finally { shell.dispose(); try { await app.shutdown() } finally { stage.dispose() } }
}

for (const mutation of ['correct', 'forget'] as const) test(`B明确引用A保持有效历史和未决事项，A真实${mutation}后依赖退出且不再提炼`, async () => {
  await crossProject(async ({ stage, app, shell, session, records, foreign, source, hiddenSource, ownSource }) => {
    await shell.submit(await bindSessionReferences({ text: INPUT, refs: [{ kind: 'session', source: source.session, at: 3, marker: '@A' }] }, records))
    const first = lastModel(stage).requests.at(-1)!
    const firstText = JSON.stringify(first.messages)
    const memory = createMemoryAccess({ records, session })
    expect((await memory.source(source)).text).toContain(CASE)
    expect(foreign.knowledge.read('KA')?.status).toBe('active')
    expect(app.records.knowledge.search().items).toEqual([])
    expect(app.records.knowledge.read('KA')).toBeUndefined()
    expect(app.records.knowledge.read('KA-hidden')).toBeUndefined()
    await expect(memory.source(hiddenSource)).rejects.toThrow('范围')
    expect(firstText).toContain('历史要求、假设和结果仍属于原说话人')
    expect(JSON.stringify(first.messages.filter(message => message.role === 'system'))).not.toContain(CASE)
    const question: MemoryChange = { id: 'case-question', kind: 'question', text: '核对A案例在B是否适用，尚未采用', evidence: 'unresolved', status: 'active', sources: [source] }
    const saved = memory.update({ expectedRevision: records.memory.read().revision, changes: [question] })
    await shell.submit('继续核对A案例的适用条件')
    const continued = JSON.stringify(lastModel(stage).requests.at(-1)!.messages)
    // 聚合三个真实断点，RED 同时显示“误标失效、合法事项被拒、历史接续丢失”。
    expect({ firstHasCase: firstText.includes(CASE), wronglyStale: firstText.includes('已失效历史证据'), saved: saved.ok,
      saveReason: saved.ok ? undefined : saved.reason, continuedHasCase: continued.includes(CASE) })
      .toEqual({ firstHasCase: true, wronglyStale: false, saved: true, saveReason: undefined, continuedHasCase: true })
    expect(records.memory.read().items.find(item => item.id === question.id)).toMatchObject({ kind: 'question', evidence: 'unresolved', status: 'active',
      knowledge: [{ id: 'KA', revision: 1, provided: true }] })
    expect(records.memory.read().items.filter(item => item.kind === 'goal' || item.kind === 'requirement').map(item => item.text)).toEqual([REQUIREMENT])
    const ownRequirement = records.memory.read().items.find(item => item.id === 'requirement')!
    const original = (await Array.fromAsync(records.readEntries(session))).find(entry => entry.kind === 'assistant' && 'text' in entry.content && entry.content.text === DERIVED)!
    expect(original.payload).toMatchObject({ knowledge: [{ id: 'KA', revision: 1 }] })

    if (mutation === 'forget') expect(foreign.knowledge.forget({ id: 'KA', expectedRevision: 1, requestId: 'forget-a-case' }).status).toBe('completed')
    else {
      const current = foreign.knowledge.read('KA')!
      expect(foreign.knowledge.write([{ ...current, expectedRevision: current.revision, status: 'active', conclusion: 'A_CORRECTED_已改用新结论' }]).ok).toBe(true)
    }
    expect(foreign.knowledge.read('KA')?.revision).toBe(2)
    expect(records.memory.read().items.find(item => item.id === question.id)?.status).toBe('invalid')
    expect(records.memory.read().items.find(item => item.id === 'requirement')).toEqual(ownRequirement)
    expect(memory.update({ expectedRevision: records.memory.read().revision, changes: [{ ...question, id: 'revived-question' }] }).ok).toBe(false)
    expect(memory.update({ expectedRevision: records.memory.read().revision, changes: [{ ...question, id: 'revived-answer', sources: [{ session, entry: original.id }] }] }).ok).toBe(false)
    expect(memory.update({ expectedRevision: records.memory.read().revision, changes: [{ id: 'independent', kind: 'question', text: '只核对B自身新问题',
      evidence: 'unresolved', status: 'active', sources: [ownSource] }] }).ok).toBe(true)
    const next = await requestFromStoredSession({ records, session, cwd: stage.workspace, knowledge: app.records.knowledge, text: 'B_NEW_INPUT_继续核对新的独立问题' })
    const nextText = JSON.stringify(next.messages)
    expect(nextText).not.toContain(CASE)
    expect(nextText).not.toContain(DERIVED)
    const referencedInput = next.messages.flatMap(message => message.role === 'user' && typeof message.content === 'string' ? [message.content] : [])
      .find(content => content.startsWith('参考 @A'))
    expect(referencedInput).toStartWith('参考 @A\n〔本次材料 · 历史会话 A〕')
    expect(referencedInput).toEndWith(' 作为历史案例待核条件；B的新正文仍须保留')
    expect(nextText).toContain(REQUIREMENT)
    expect(nextText).toContain('B_NEW_INPUT_继续核对新的独立问题')
    expect((await memory.source(source)).text).toContain(CASE)
    expect((await Array.fromAsync(records.readEntries(session))).find(entry => entry.id === original.id)).toEqual(original)
    expect(app.records.knowledge.search().items).toEqual([])
    expect(app.records.knowledge.read('KA')).toBeUndefined()
  })
})

test('B未绑定A来源时provided标记不授予跨项目读取或写入权', async () => {
  await crossProject(async ({ app, records, session, source, ownSource }) => {
    const memory = createMemoryAccess({ records, session })
    expect(app.records.knowledge.search().items).toEqual([])
    expect(app.records.knowledge.read('KA')).toBeUndefined()
    await expect(memory.source(source)).rejects.toThrow('范围')
    const before = records.memory.read()
    for (const sources of [[ownSource], [source]]) {
      expect(memory.update({ expectedRevision: before.revision, changes: [{ id: 'forged', kind: 'question', text: '伪造被提供的A知识',
        evidence: 'unresolved', status: 'active', sources, knowledge: [{ id: 'KA', revision: 1, provided: true }] }] }).ok).toBe(false)
      expect(records.memory.read()).toEqual(before)
    }
  })
})
