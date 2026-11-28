import { describe, expect, test } from 'bun:test'
import type { ModelGateway, ModelRequest, NoteState, WorkingNotes } from '@magic/contracts'
import { makeFauxRecords, makeTestStamper } from '@magic/faux'
import { tidyWorkingMemory } from '../src/memory-tidy.ts'

function makeMemoryNotes(session: string): WorkingNotes {
  const files = new Map<string, string>()
  return {
    directory: `/virtual/${session}/notes`,
    async read(query = {}): Promise<NoteState> {
      const path = query.path ?? 'MEMORY.md'
      const content = files.get(path)
      const names = [...files.keys()]
      if (content === undefined) {
        return { directory: `/virtual/${session}/notes`, path, status: names.length === 0 ? 'empty' : 'missing', files: names }
      }
      const lines = content.split('\n')
      return {
        directory: `/virtual/${session}/notes`,
        path,
        status: 'ready',
        files: names,
        page: {
          session,
          path,
          absolute: `/virtual/${session}/notes/${path}`,
          text: content,
          from: 1,
          through: lines.length,
          totalLines: lines.length,
          complete: true,
          cursor: 'c1',
          links: [],
        },
      }
    },
    async snapshot() {
      return Object.fromEntries(files.entries())
    },
    writes() {
      return Object.fromEntries(files.entries())
    },
    resolve() {
      return undefined
    },
    bindTarget() {
      throw new Error('not needed in unit test')
    },
    saved() {
      return files.size
    },
    fork() {
      return this
    },
    async overwrite(path: string, text: string) {
      files.set(path, text)
    },
  }
}

describe('/memory tidy 笔记阶段精简', () => {
  test('读取现有 MEMORY.md 与近期记录并精简回写，不动 coverage，记录 memory.model', async () => {
    const records = makeFauxRecords()
    const session = 'tidy-s1'
    const notes = makeMemoryNotes(session)
    const stamper = makeTestStamper()
    const events: unknown[] = []

    await notes.overwrite!('MEMORY.md', '阶段一排查过程：尝试 A 失败，尝试 B 成功。\n阶段二待办：实现微压缩。')
    const u1 = records.appendEntry({ kind: 'user', content: { text: '先处理阶段一，再做阶段二' }, at: 1 })
    records.appendEntry({ kind: 'assistant', content: { text: '阶段一已验证通过' }, at: 2 })
    records.coverage.publish({ previousSummary: null, from: u1, through: u1, at: 3, format: 'compaction-v2', text: '旧交接' })
    const covBefore = records.coverage.read()

    const requests: ModelRequest[] = []
    const gateway: ModelGateway = {
      stream(req) {
        requests.push(req)
        async function* ev() {
          yield stamper.stamp('model.call.start', { model: 'deepseek-flash', provider: 'deepseek' })
          yield stamper.stamp('model.delta', { channel: 'text', text: '# 工作笔记\n## 已完成\n- 阶段一：已验证（会话#2）\n## 进行中\n- 阶段二：实现微压缩' })
          yield stamper.stamp('model.call.end', {})
        }
        return {
          events: ev(),
          result: Promise.resolve({ complete: true, finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 40 } }),
        }
      },
    }

    const result = await tidyWorkingMemory({
      records,
      session,
      gateway,
      notes,
      sink: { emit: event => events.push(event) },
      stamper,
      now: () => 1000,
    }, { requestId: 'tidy-1', focus: '阶段一已完成' })

    expect(result).toEqual({ requestId: 'tidy-1', state: 'completed', path: 'MEMORY.md', focus: '阶段一已完成' })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.tools).toBeUndefined()
    expect(JSON.stringify(requests[0]!.messages)).toContain('尝试 A 失败')
    expect(JSON.stringify(requests[0]!.messages)).toContain('阶段一已完成')
    expect((await notes.read({ path: 'MEMORY.md' })).page?.text).toContain('阶段一：已验证')
    expect(records.coverage.read()).toEqual(covBefore)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'memory.model', data: { purpose: 'memory-tidy', ok: true } })
  })

  test('空笔记且无实质记录时返回 no-material，不调用模型', async () => {
    const records = makeFauxRecords()
    const notes = makeMemoryNotes('empty')
    let called = 0

    const result = await tidyWorkingMemory({
      records,
      session: 'empty',
      gateway: { stream() { called++; throw new Error('should not be called') } },
      notes,
      sink: { emit() {} },
      stamper: makeTestStamper(),
      now: () => 1000,
    }, { requestId: 'tidy-empty' })
    expect(result).toMatchObject({ requestId: 'tidy-empty', state: 'no-material' })
    expect(called).toBe(0)
  })

  test('模型返回空正文或报错时保留原有 MEMORY.md 不覆盖', async () => {
    const records = makeFauxRecords()
    const notes = makeMemoryNotes('fail')
    const stamper = makeTestStamper()

    await notes.overwrite!('MEMORY.md', '珍贵的原始笔记内容')
    const gateway: ModelGateway = {
      stream() {
        async function* ev() {
          yield stamper.stamp('model.call.start', { model: 'GLM', provider: 'sinoma' })
          yield stamper.stamp('model.call.end', {})
        }
        return {
          events: ev(),
          result: Promise.resolve({ complete: true, finishReason: 'stop' }),
        }
      },
    }
    const result = await tidyWorkingMemory({
      records,
      session: 'fail',
      gateway,
      notes,
      sink: { emit() {} },
      stamper,
      now: () => 1000,
    }, { requestId: 'tidy-fail' })
    expect(result.state).toBe('failed')
    expect((await notes.read({ path: 'MEMORY.md' })).page?.text).toBe('珍贵的原始笔记内容')
  })
})
