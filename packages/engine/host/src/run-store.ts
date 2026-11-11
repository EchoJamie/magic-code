/**
 * 运行登记文件——`<run-dir>/manager.json`（自报身份）与 `runs.json`（持久工具归属）。
 *
 * 0.2.0 的 `runs` / `run_journal` 表在数据服务里（`@magic/data`，见 `runs.ts`）；
 * 本文件是现有 manager 仍在用的文件形。接线迁移时只替换本文件的读写实现，
 * manager 的调用面不变。
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { OwnedProcess } from '@magic/contracts'
import { RUNS_VERSION, type StoredRun, type StoredRuns } from './facts.ts'
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

/** 持久工具归属；存在但格式无效时拒绝启动，不能把未读懂的责任当作不存在。 */
export function readRuns(paths: RunPaths): readonly StoredRun[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(paths.runs, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`运行归属记录不可读：${paths.runs}`, { cause: error })
  }

  if (typeof parsed !== 'object' || parsed === null) throw new Error('运行归属记录形状无效')
  const runs = (parsed as Partial<StoredRuns>).runs
  if (!Array.isArray(runs)) throw new Error('运行归属记录缺少 runs')

  const kept: StoredRun[] = []
  for (const one of runs) {
    if (typeof one !== 'object' || one === null) throw new Error('运行归属条目无效')
    const run = one as Partial<StoredRun>
    if (run.session !== null && (typeof run.session !== 'string' || run.session === '')) throw new Error('运行归属缺少会话身份')
    if (typeof run.gen !== 'number' || typeof run.startedAt !== 'number') throw new Error('运行归属代次无效')
    if (!Array.isArray(run.workspace) || !run.workspace.every(root => typeof root === 'string')) throw new Error('运行归属工作区无效')

    const owned = ownedOf(run.owned)
    kept.push({
      session: run.session,
      gen: run.gen,
      ...(typeof run.executionId === 'string' ? { executionId: run.executionId } : {}),
      startedAt: run.startedAt,
      workspace: run.workspace,
      state: run.state ?? 'idle',
      since: typeof run.since === 'number' ? run.since : run.startedAt,
      ...(run.lastTurn === undefined ? {} : { lastTurn: run.lastTurn }),
      ...(typeof run.why === 'string' ? { why: run.why } : {}),
      ...(run.kind === undefined ? {} : { kind: run.kind }),
      ...(owned === undefined ? {} : { owned }),
    })
  }
  return kept
}

function ownedOf(raw: unknown): readonly OwnedProcess[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('工具归属账无效')

  const kept: OwnedProcess[] = []
  for (const one of raw) {
    if (typeof one !== 'object' || one === null) throw new Error('工具归属条目无效')
    const group = one as Partial<OwnedProcess>
    if (typeof group.pgid !== 'number' || !Number.isInteger(group.pgid) || group.pgid <= 0) throw new Error('工具归属进程组无效')
    if (typeof group.what !== 'string') throw new Error('工具归属名称无效')
    if (group.kind !== 'exec' && group.kind !== 'background' && group.kind !== 'mcp') throw new Error('工具归属种类无效')
    kept.push({
      pgid: group.pgid,
      startedAt: typeof group.startedAt === 'number' ? group.startedAt : undefined,
      kind: group.kind,
      what: group.what,
    })
  }

  return kept.length === 0 ? undefined : kept
}

export function writeRuns(paths: RunPaths, runs: readonly StoredRun[], at: number): void {
  const body: StoredRuns = { v: RUNS_VERSION, at, runs }
  const temp = `${paths.runs}.tmp-${process.pid}`
  try {
    writeFileSync(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 })
    renameSync(temp, paths.runs)
  } catch (error) {
    try { unlinkSync(temp) } catch { }
    throw new Error(`运行归属登记失败：${String(error)}`)
  }
}
