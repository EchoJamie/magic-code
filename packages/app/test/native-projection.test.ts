import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordsStore } from '@magic/records'
import { projectWorks } from '../src/run/native-projection.ts'

test('异步目录读取途中换代，旧运行状态不能被新停止代次重新命名', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-projection-race-'))
  const store = createRecordsStore({ dataDir: root, workspace: [root] })
  try {
    store.setSessionTitle('work', '同一会话', 1)
    let gen = 1
    const pending = projectWorks(store, [{ session: 'work', state: 'running', action: '上一轮工具',
      since: 1, startedAt: 1, workspace: [root], holds: true,
    }], () => gen)
    gen = 2
    expect((await pending)[0]).toMatchObject({ state: 'running', action: '上一轮工具', gen: 1 })
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('只展开 Engine 候选摘要；普通历史和归档的正文不进入状态栏读取', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-projection-candidates-'))
  const store = createRecordsStore({ dataDir: root, workspace: [root] })
  try {
    store.serviceFor('open').appendEntry({ kind: 'user', content: { text: '仍打开的会话' }, at: 1 })
    store.serviceFor('history').appendEntry({ kind: 'user', content: { blob: 'not-a-readable-blob' }, at: 2 })
    store.serviceFor('archived').appendEntry({ kind: 'user', content: { blob: 'also-not-a-readable-blob' }, at: 3 })
    store.setSessionArchived('archived', true)
    const works = await projectWorks(store, [], () => null, {
      candidates: ['open', 'archived'], terminalOpen: () => true, canArchive: () => true,
    })
    expect(works).toHaveLength(1)
    expect(works[0]).toMatchObject({ session: 'open', terminalOpen: true, archived: false, canArchive: true, state: 'idle' })
    expect(works[0]?.currentNotice).toBeUndefined()
    expect(await projectWorks(store, [], () => null, { candidates: [], terminalOpen: () => false, canArchive: () => false })).toEqual([])
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
