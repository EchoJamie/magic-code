import { expect, test } from 'bun:test'
import type { AttentionItem } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

test('注意事项共享连接多调用：稳定 id 仅一方插入，确认不互相覆盖，不丢未读', async () => {
  const dir = tempDataDir()
  const writers = 4
  const count = 120
  const store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  try {
    const reports = await Promise.all(Array.from({ length: writers }, async (_, writer) => {
      let inserted = 0
      for (let index = 0; index < count; index++) {
        await new Promise<void>(resolve => setImmediate(resolve))
        const shared: AttentionItem = { id: `shared:${index}`, session: 'same-session', kind: 'needs-you', fact: `event:${index}`, at: 1_700_000_000_000 + index, unread: true, delivered: false }
        if (store.attention.put(shared)) inserted++
        if (writer === 0 && index % 2 === 0) store.attention.markRead([shared.id])
        if (writer === 1 && index % 3 === 0) store.attention.markDelivered([shared.id])
        expect(store.attention.put(shared)).toBe(false)
        expect(store.attention.put({ ...shared, id: `private:${writer}:${index}`, fact: `private:${writer}:${index}` })).toBe(true)
      }
      return { inserted }
    }))
    expect(reports.reduce((total, report) => total + report.inserted, 0)).toBe(count)

    const expected: AttentionItem[] = []
    for (let index = 0; index < count; index += 1) {
      const value: AttentionItem = {
        id: `shared:${index}`, session: 'same-session', kind: 'needs-you',
        fact: `event:${index}`, at: 1_700_000_000_000 + index,
        unread: index % 2 !== 0, delivered: index % 3 === 0,
      }
      expected.push(value)
      for (let writer = 0; writer < writers; writer += 1) {
        expected.push({
          ...value, id: `private:${writer}:${index}`, fact: `private:${writer}:${index}`,
          unread: true, delivered: false,
        })
      }
    }
    expected.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    expect(store.attention.list()).toEqual(expected)
    expect(await store.listSessions()).toEqual([])
  } finally { store.close(); removeDataDir(dir) }
})
