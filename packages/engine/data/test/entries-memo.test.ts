/**
 * 条目后缀记忆 —— readEntries 全后缀形态的水位记忆。
 *
 * 判据（行为级，不碰内部结构）：
 * 1. **命中同一批对象**——未追加时两次读交回同一批 Entry 实例（记忆在生效）；
 * 2. **追加即增量可见**——任何写入路径落的条目，下一次读按序补上，旧对象保持同一；
 * 3. **跨实例可见**——另一个 serviceFor 实例追加（协作收件同款路径），先前的读者照样看见；
 * 4. **中段起点**——从中间开始读与全量读的尾段一致（段的连续性不缺口）；
 * 5. **读回逐字段等于不走记忆的对照**（aux 读绕开记忆，作为对照面）。
 */

import { describe, expect, test } from 'bun:test'
import type { Entry, NewEntry, RecordId, SessionId } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

const ROOTS = ['/work/memo']
const SESSION: SessionId = 's-memo'
const T0 = 1_700_000_000_000

const userEntry = (text: string, at = T0): NewEntry => ({ kind: 'user', content: { text }, at })

async function collect(iterable: AsyncIterable<Entry>): Promise<Entry[]> {
  const out: Entry[] = []
  for await (const entry of iterable) out.push(entry)
  return out
}

describe('条目后缀记忆', () => {
  test('命中同一批对象；追加后增量可见且旧对象保持同一', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)
      const ids = [1, 2, 3].map(n => records.appendEntry(userEntry(`第 ${n} 条`, T0 + n)))

      const first = await collect(store.readEntries(SESSION))
      expect(first.map(e => e.id)).toEqual(ids)

      const second = await collect(store.readEntries(SESSION))
      // 未追加：同一批实例（记忆命中），逐字段等价
      expect(second).toEqual(first)
      expect(second.map((entry, index) => entry === first[index])).toEqual([true, true, true])

      // 追加两条：增量可见，旧条目仍是同一批实例
      const more = [4, 5].map(n => records.appendEntry(userEntry(`第 ${n} 条`, T0 + n)))
      const third = await collect(store.readEntries(SESSION))
      expect(third.map(e => e.id)).toEqual([...ids, ...more])
      expect(third.slice(0, 3).map((entry, index) => entry === first[index])).toEqual([true, true, true])
      store.close()
    } finally { removeDataDir(dir) }
  })

  test('跨实例追加可见（另一 serviceFor / 另一视图路径）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const reader = store.serviceFor(SESSION)
      reader.appendEntry(userEntry('开局', T0))
      await collect(store.readEntries(SESSION))

      // 另一个实例追加（模拟协作收件 / 恢复补记这些不走同一实例的写入）
      const writer = store.serviceFor(SESSION)
      const appended: RecordId = writer.appendEntry(userEntry('后来', T0 + 1))

      const seen = await collect(store.readEntries(SESSION))
      expect(seen.map(e => e.id)).toEqual([appended - 1, appended])
      expect(seen.at(-1)?.content).toEqual({ text: '后来' })
      store.close()
    } finally { removeDataDir(dir) }
  })

  test('中段起点与全量读的尾段一致；与绕开记忆的对照面逐字段相等', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)
      const ids = [1, 2, 3, 4, 5].map(n => records.appendEntry(userEntry(`第 ${n} 条`, T0 + n)))

      // 先建全量记忆，再从中段读
      await collect(store.readEntries(SESSION))
      const middle = await collect(store.readEntries(SESSION, { from: ids[2]! }))
      expect(middle.map(e => e.id)).toEqual(ids.slice(2))

      // 对照面：aux 读绕开记忆（走原分页路径），两边逐字段相等
      const viaAux = await collect(store.readEntries(SESSION, { auxiliary: true }))
      const viaMemo = await collect(store.readEntries(SESSION))
      expect(viaMemo).toEqual(viaAux.filter(entry => entry.kind !== 'continuation'))
      store.close()
    } finally { removeDataDir(dir) }
  })

  test('会话间互不串：另一会话的追加不影响本会话的记忆', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const mine = store.serviceFor(SESSION)
      const mineId = mine.appendEntry(userEntry('我的', T0))
      await collect(store.readEntries(SESSION))

      const other = store.serviceFor('s-other')
      other.appendEntry(userEntry('别人的', T0 + 1))

      const seen = await collect(store.readEntries(SESSION))
      expect(seen.map(e => e.id)).toEqual([mineId])
      store.close()
    } finally { removeDataDir(dir) }
  })
})
