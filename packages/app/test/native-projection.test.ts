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
