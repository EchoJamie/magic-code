import { expect, test } from 'bun:test'
import { createRecordsStore } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

test('共享连接的八个 Agent 交错写入：不重号、不漏读、会话内递增', async () => {
  const dataDir = tempDataDir()
  const store = createRecordsStore({ dataDir, workspace: [dataDir] })
  const issued: number[] = []
  try {
    const reports = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const session = `s-${index}`
      const view = store.forWorkspace([`${dataDir}/workspace-${index}`])
      const service = view.serviceFor(session)
      const written: number[] = []
      for (let i = 0; i < 600; i++) {
        if (i % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve))
        const id = service.appendEntry({ kind: 'user', content: { text: `${session}:${i}` }, at: i })
        written.push(id); issued.push(id)
        // 跨越编号预留块；交错的瞬时事件同样不能重号。
        for (let j = 0; j < 16; j++) issued.push(service.nextId())
      }
      view.close()
      return { session, written }
    }))
    expect(issued).toHaveLength(8 * 600 * 17)
    expect(new Set(issued).size).toBe(issued.length)
    for (const { session, written } of reports) {
      expect(written).toHaveLength(600)
      expect(written).toEqual([...written].sort((a, b) => a - b))
      expect((await Array.fromAsync(store.readEntries(session))).map(entry => entry.id)).toEqual(written)
    }
  } finally { store.close(); removeDataDir(dataDir) }
})
