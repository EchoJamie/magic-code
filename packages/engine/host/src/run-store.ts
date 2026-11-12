/**
 * 运行登记文件——`<run-dir>/manager.json`（自报身份）与 `runs.json`（持久工具归属）。
 *
 * 0.2.0 的 `runs` / `run_journal` 表在数据服务里（`@magic/data`，见 `runs.ts`）；
 * 本文件是现有 manager 仍在用的文件形。接线迁移时只替换本文件的读写实现，
 * manager 的调用面不变。
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { StoredRun } from './facts.ts'
import { readRunsAt, replaceRunsAt, type RunRecord } from '@magic/data'
import type { RunPaths } from './paths.ts'

export type ManagerRecord = {
  readonly pid: number
  readonly at: number
  /** 数据目录的规范形——管理者就是按它认的自己这一摊。 */
  readonly dataDir: string
  readonly socket: string
  /** 本文件里那一版的形制——将来加字段时读的人据此判。 */
  readonly v: number
}

export const RECORD_VERSION = 1

/** 清掉路径上的尸首——**只在连也连不上时调**（判据在调用方）。 */
export function clearStale(socketPath: string): void {
  try {
    unlinkSync(socketPath)
  } catch {
    // 别人抢先清了 / 路径本来就没了：两种都等于「已经干净了」
  }
}

/** 自报身份那一份读得回来就读（读不懂＝没有——**它不是权威状态**）。 */
export function readRecord(paths: RunPaths): ManagerRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.record, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Partial<ManagerRecord>
    if (typeof record.pid !== 'number' || typeof record.socket !== 'string') return undefined
    return record as ManagerRecord
  } catch {
    return undefined
  }
}

export function writeRecord(paths: RunPaths, record: ManagerRecord): void {
  try {
    writeFileSync(paths.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // 写不下去只影响诊断——不为它把管理者拦下来
  }
}

export function clearRecord(paths: RunPaths): void {
  try {
    unlinkSync(paths.record)
  } catch {
    // 同上
  }
}

/** 持久运行登记——读 `runs` 表；库还不存在＝没有登记（不是错误）。 */
export function readRuns(paths: RunPaths): readonly StoredRun[] {
  return readRunsAt(paths.dataDir).map(toStored)
}

function toStored(run: RunRecord): StoredRun {
  const state = run.state === 'failed' || run.state === 'starting' ? 'unknown' : run.state
  return {
    session: run.session ?? null,
    gen: run.generation ?? 0,
    ...(run.id === undefined ? {} : { executionId: run.id }),
    startedAt: run.startedAt,
    ...(run.pid === undefined ? {} : { pid: run.pid }),
    ...(run.procStartedAt === undefined ? {} : { procStartedAt: run.procStartedAt }),
    workspace: run.workspace ?? [],
    state,
    since: run.updatedAt,
    ...(run.lastTurn === undefined ? {} : { lastTurn: run.lastTurn as StoredRun['lastTurn'] }),
    ...(run.stopReason === undefined ? {} : { why: run.stopReason }),
    ...(run.kind === undefined ? {} : { kind: run.kind as StoredRun['kind'] }),
    ...(run.owned === undefined ? {} : { owned: run.owned as StoredRun['owned'] }),
  }
}

function toRun(run: StoredRun, at: number): RunRecord {
  return {
    id: run.executionId ?? `${run.session ?? 'none'}:${run.gen}`,
    state: run.state === 'unknown' ? 'failed' : run.state,
    startedAt: run.startedAt,
    updatedAt: run.since,
    ...(run.pid === undefined ? {} : { pid: run.pid }),
    ...(run.procStartedAt === undefined ? {} : { procStartedAt: run.procStartedAt }),
    ...(run.session === null ? {} : { session: run.session }),
    ...(run.lastTurn === undefined ? {} : { lastTurn: run.lastTurn }),
    ...(run.why === undefined ? {} : { stopReason: run.why }),
    ...(run.kind === undefined ? {} : { kind: run.kind }),
    workspace: run.workspace,
    generation: run.gen,
    ...(run.owned === undefined ? {} : { owned: run.owned }),
    at,
  } as RunRecord
}

export function writeRuns(paths: RunPaths, runs: readonly StoredRun[], at: number): void {
  // 运行登记现在落在 records.db 的 runs 表；整份快照替换，保持原文件的语义。
  try {
    replaceRunsAt(paths.dataDir, runs.map(run => toRun(run, at)))
  } catch (error) {
    throw new Error(`运行归属登记失败：${String(error)}`)
  }
}
