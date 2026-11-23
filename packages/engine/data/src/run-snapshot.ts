/**
 * 运行登记快照——宿主读写 `runs` 表的窄口，避免宿主直接触 SQLite。
 */
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRunRecords, type RunRecord } from './runs.ts'
import { createRecordsStore, DATABASE_FILE } from './store.ts'

/** 读一份运行快照（库不存在＝空）。 */
export function readRunsAt(dataDir: string): readonly RunRecord[] {
  const path = join(dataDir, DATABASE_FILE)
  if (!existsSync(path)) return []
  const db = new Database(path, { readonly: true })
  try {
    return createRunRecords(db).list()
  } catch {
    // 旧 schema / 半建库：运行登记读不出来＝没有登记；真正的迁移由 createRecordsStore 引导。
    return []
  } finally { db.close() }
}

/** 以全量快照替换运行登记（库不存在则建库）。 */
export function replaceRunsAt(dataDir: string, records: readonly RunRecord[]): void {
  const store = createRecordsStore({ dataDir, workspace: [], busyTimeoutMs: 5_000 })
  try { store.runs.replaceAll(records) } finally { store.close() }
}
