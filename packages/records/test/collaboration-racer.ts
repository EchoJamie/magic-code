/** 真进程：开库后在文件栅栏等待，同时争夺同一 SQLite 事实。 */
import { existsSync, writeFileSync } from 'node:fs'
import { createRecordsStore } from '../src/index.ts'
import type { CollaborationRecords } from '@magic/contracts'

const [dir, ready, go, encoded] = process.argv.slice(2)
if (!dir || !ready || !go || !encoded) throw new Error('race arguments required')
const store = createRecordsStore({ dataDir: dir, workspace: ['/irrelevant-worker-workspace'] })
try {
  const { method, args } = JSON.parse(encoded) as { method: keyof CollaborationRecords; args: unknown[] }
  writeFileSync(ready, '')
  const deadline = Date.now() + 15000
  while (!existsSync(go)) {
    if (Date.now() >= deadline) throw new Error('barrier timeout')
    await Bun.sleep(2)
  }
  try {
    const fn = store.collaboration[method] as (...args: unknown[]) => unknown
    const value = fn(...args)
    process.stdout.write(JSON.stringify({ ok: true, value }))
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  }
} finally { store.close() }
