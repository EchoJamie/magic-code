import { describe, expect, test } from 'bun:test'
import { createRecordsStore } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

const ROOTS = ['/work/alpha']

describe('协作账本', () => {
  test('账本、成员、条目与成员记录引用', () => {
    const dir = tempDataDir()
    const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
    try {
      const ledger = store.ledger.create({ originSession: 's-root', at: 10, title: '一次协作' })
      store.ledger.addMember({ ledger: ledger.id, session: 's-root', role: 'lead', joinedAt: 10 })
      store.ledger.addMember({ ledger: ledger.id, session: 's-member', joinedAt: 11 })
      expect(store.ledger.members(ledger.id)).toHaveLength(2)

      const first = store.ledger.append({ ledger: ledger.id, actor: 's-root', kind: 'message', at: 12, data: { text: '开工' } })
      const second = store.ledger.append({ ledger: ledger.id, actor: 's-member', kind: 'message', at: 13, data: { text: '收到' } })
      expect([first.seq, second.seq]).toEqual([1, 2])

      const entry = store.serviceFor('s-member').appendEntry({ kind: 'assistant', content: { text: '收到' }, at: 14 })
      store.ledger.reference(entry, second.id)
      expect(store.ledger.refsOf(entry)).toEqual([second.id])
    } finally { store.close(); removeDataDir(dir) }
  })
})
