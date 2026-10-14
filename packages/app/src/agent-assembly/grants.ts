import type { GrantRow } from '@magic/contracts'
import type { GrantEdit, GrantHit, PermissionRule } from '@magic/permission'
import { createGrantLedger } from '@magic/permission'
import { statSync } from 'node:fs'
import { configStamp as configStampOf } from '../cache-access.ts'
import { commitGrants, loadGrants } from '../grants-file.ts'
import { grantsTrouble } from '../run/observation.ts'

/** 授权名录的一屏（`Assembly.grantsView`）——**一处取，两处用**（`/grants` 与 `--check`）。 */
export type GrantsView = {
  /** 本工作区（分节键＝默认根的规范形）。 */
  readonly workspace: string
  /** 本工作区的授权（声明序）。 */
  readonly grants: readonly GrantRow[]
  /** **陈旧的节**——路径已不在的那些（`B11`）。 */
  readonly stale: readonly string[]
}

/** 工作区授权账本、命中合并与持久化；跨实例写锁仍由 grants-file 持有。 */
export function createAssemblyGrants(input: {
  path: string
  workspace: string
  now: () => number
}) {
  const { path: grantsPath, workspace, now } = input
  const loadedGrants = loadGrants(grantsPath)

  let grantsUnreadable = loadedGrants.unreadable
  let grantsStamp = configStampOf(grantsPath)
  function refreshGrants(): void {
    const stamp = configStampOf(grantsPath)
    if (stamp === grantsStamp) return
    const latest = loadGrants(grantsPath)
    grants.replace(latest.file)
    grantsUnreadable = latest.unreadable
    grantsStamp = stamp
  }

  const pendingHits = new Map<string, GrantHit>()
  /** 把攒下的记账收成**一项**改动。空表不该产出一项改动（那会白写一次盘）。 */
  const drainHits = (): readonly GrantEdit[] => {
    if (pendingHits.size === 0) return []
    const updates = [...pendingHits.values()]
    pendingHits.clear()
    return [{ kind: 'hit', updates }]
  }

  let grantsWriteError: string | undefined

  // 同一实例按序写授权，跨实例由文件锁收束；失败不重放旧授权。
  let grantsFlight = Promise.resolve()
  const persistGrants = (edits: readonly GrantEdit[]): Promise<void> => {
    grantsFlight = grantsFlight.catch(() => undefined).then(() => writeGrants(edits))
    return grantsFlight
  }
  const writeGrants = async (edits: readonly GrantEdit[]): Promise<void> => {
    if (edits.length === 0 || grantsUnreadable !== undefined) return

    try {
      const done = await commitGrants(grantsPath, edits)
      if (!done.ok) {
        // **会话中途它才读不懂**（启动时读得懂、盘上那份后来被写坏了）：这一跳现读现发现。
        // 立起闸、并**丢掉攒着的那些**（理由同上面「不攒」）——从这一刻起本次会话不再写它。
        grantsUnreadable = done.reason
        return
      }

      grantsWriteError = undefined
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      grantsWriteError = `授权没能写进 ${grantsPath}（${reason}）——本次保存未完成`
      throw error
    }
  }

  const grants = createGrantLedger({
    workspace: workspace,
    file: loadedGrants.file,
    now,
    onChange: async (edit: GrantEdit) => {
      if (edit.kind === 'hit') {
        for (const update of edit.updates) pendingHits.set(hitKey(update), update)
        return
      }

      await persistGrants([...drainHits(), edit])
    },
  })

  /** 陈旧节——路径**已不在**的那些（`B11`；只列不删，撤销入口在 `/grants`）。 */
  const staleSections = (): readonly string[] =>
    grants.sections().filter((section) => !isDirectory(section))

  const grantsView = (): GrantsView => ({
    workspace: workspace,
    grants: grants.view(),
    stale: staleSections(),
  })

  const grantsTroubleNote = (): string | undefined => grantsTrouble(grantsPath, grantsUnreadable)

  const grantsNotes = (): readonly string[] =>
    [grantsTroubleNote(), loadedGrants.note].filter((line): line is string => line !== undefined)

  return {
    path: grantsPath,
    ledger: grants,
    refresh: refreshGrants,
    view: grantsView,
    trouble: grantsTroubleNote,
    notes: grantsNotes,
    get unreadable() { return grantsUnreadable },
    get writeError() { return grantsWriteError },
    discardHits: () => pendingHits.clear(),
    flush: () => persistGrants(drainHits()),
  }
}

function hitKey(hit: GrantHit): string {
  const { workspace, rule } = hit
  return JSON.stringify([workspace, rule.tool, rule.path ?? null, opKeyOf(rule)])
}

/** 规则第三格（操作类型）的键——单值 / 数组 / 缺席三形归一（顺序无关的集合）。 */
function opKeyOf(rule: PermissionRule): string {
  return rule.op === undefined ? '' : (Array.isArray(rule.op) ? rule.op : [rule.op]).join(',')
}

/** 目录还在不在——陈旧节的判据（`B11`：「路径已不在 → 你删或留」）。 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
