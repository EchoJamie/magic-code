import { expect, test } from 'bun:test'
import type { AttentionItem } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

test('并发投递更新同一位置，迟到旧回执不消费最后来源', async () => {
  const dir = tempDataDir()
  const store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  const item = (event: number): AttentionItem => ({ id: `event:${event}`, session: 'same', kind: 'done', fact: `event:${event}`, at: event,
    source: { session: 'same', event }, unread: true, delivered: false })
  try {
    await Promise.all(Array.from({ length: 4 }, async (_, writer) => {
      for (let event = 1; event <= 120; event++) {
        await new Promise<void>(resolve => setImmediate(resolve))
        store.attention.put(item(event))
        if (writer === 0 && event < 120) store.attention.markRead([`event:${event}`])
        if (writer === 1 && event < 120) store.attention.markDelivered([`event:${event}`])
        expect(store.attention.put(item(event))).toBe(false)
      }
    }))
    expect(store.attention.list()).toEqual([item(120)])
    store.attention.markRead(['event:1'])
    store.attention.markDelivered(['event:119'])
    expect(store.attention.list()).toEqual([item(120)])
  } finally { store.close(); removeDataDir(dir) }
})
