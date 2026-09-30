import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { createRecordsStore } from '@magic/records'
import { connectManager, type ManagerClient } from '../src/run/client.ts'
import { readRuns, startManager, type ExecutorRequest } from '../src/run/manager.ts'
import { reconcile, STORED_RUNS_LIMIT } from '../src/run/facts.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { magicAt, tempDir, removeDir } from './tmp.ts'

test('持久执行身份：未核销代次不受最近历史条数截断，重启核对仍保留原 token', async () => {
  const root = tempDir('collaboration-recovery-record-')
  const magic = magicAt(root)
  const dataDir = `${root}/data`
  const paths = runPathsOf(magic, dataDir, tmpdir())
  const store = createRecordsStore({ dataDir, workspace: [root] })
  const sessions = Array.from({ length: STORED_RUNS_LIMIT + 1 }, (_, index) => `work-${index}`)
  for (const session of sessions) store.setSessionTitle(session, session, Date.now())
  const launches: ExecutorRequest[] = []
  const started = await startManager({ paths, dataDir, magic, stopGraceMs: 10, stopKillMs: 10,
    launch: { spawn(request) {
      launches.push(request)
      let exit = (_reason: string) => {}
      return { pid: undefined, onExit(callback) { exit = callback }, kill() { exit('登记装置退出') } }
    } },
  })
  if (started.role !== 'manager') throw new Error('管理者未启动')
  const clients: ManagerClient[] = []
  try {
    for (const session of sessions) {
      const client = await connectManager(paths.socket, { session, expectedIdentity: started.manager.identity, cwd: root })
      if (client === undefined) throw new Error('无法连接登记装置')
      clients.push(client); client.send({ type: 'input.submit', text: '登记一份独立责任' })
    }
    const until = Date.now() + 3000
    while (launches.length < sessions.length && Date.now() < until) await Bun.sleep(5)
    expect(launches).toHaveLength(sessions.length)
    const persisted = readRuns(paths)
    expect(persisted).toHaveLength(sessions.length)
    for (const launch of launches) {
      const run = persisted.find(run => run.session === launch.session)!
      expect(run.executionId).toBe(launch.token)
      expect(reconcile(run, Date.now()).executionId).toBe(launch.token)
    }
  } finally {
    for (const client of clients) client.close()
    started.manager.stop('登记验证结束'); await started.manager.waitUntilExit()
    store.close(); removeDir(paths.dir); removeDir(root)
  }
})
