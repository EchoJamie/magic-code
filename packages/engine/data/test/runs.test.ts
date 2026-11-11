import { describe, expect, test } from 'bun:test'
import { createRecordsStore } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

const ROOTS = ['/work/alpha']

describe('执行状态与恢复索引', () => {
  test('upsert / list / finish 幂等，runs 不是会话事实', () => {
    const dir = tempDataDir()
    const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
    try {
      store.runs.upsert({
        id: 'run-1', session: 's-1', turn: 3, state: 'running',
        startedAt: 100, updatedAt: 100, generation: 2,
      })
      expect(store.runs.get('run-1')).toMatchObject({ id: 'run-1', session: 's-1', turn: 3, state: 'running', generation: 2 })
      expect(store.runs.list('s-1')).toHaveLength(1)

      store.runs.finish('run-1', { state: 'stopped', at: 200, stopReason: 'done', exitCode: 0 })
      store.runs.finish('run-1', { state: 'failed', at: 300 })
      expect(store.runs.get('run-1')).toMatchObject({ state: 'stopped', endedAt: 200, stopReason: 'done', exitCode: 0 })
    } finally { store.close(); removeDataDir(dir) }
  })

  test('journal 按 run 递增 seq，读回原样', () => {
    const dir = tempDataDir()
    const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
    try {
      store.runs.upsert({ id: 'run-2', state: 'running', startedAt: 1, updatedAt: 1 })
      store.runs.journal({ run: 'run-2', seq: 0, at: 2, kind: 'spawn', data: { pid: 42 } })
      store.runs.journal({ run: 'run-2', seq: 0, at: 3, kind: 'stop' })
      expect(store.runs.readJournal('run-2')).toEqual([
        { run: 'run-2', seq: 1, at: 2, kind: 'spawn', data: { pid: 42 } },
        { run: 'run-2', seq: 2, at: 3, kind: 'stop' },
      ])
    } finally { store.close(); removeDataDir(dir) }
  })
})
