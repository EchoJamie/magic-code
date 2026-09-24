/**
 * U22 · **授权**（`grants.ts`）——形态 / 解析 / 账本。
 *
 * 两半各有各的判据：
 *
 * - **解析从严**（`parseGrants`）：读不懂的条目**不生效**（而不是退化成更宽的授权）——
 *   误放行比多问一次更坏。整份读不懂时**一条都不加载**（`version` 不认那条路）。
 * - **账本**（`createGrantLedger`）：纯内存、**不碰文件系统**——记（`a`）· 命中记账 ·
 *   撤销 · 整节撤 · 陈旧（久未命中）· 快照（空节不留）。
 *
 * 「落点＝工作区」那件事在本文件里是**分节键**那一格：一节一个工作区，互不串门
 * （跨会话存活那一条在 `rules.test.ts` 与 app 的端到端用例里钉）。
 */

import { describe, expect, test } from 'bun:test'
import type { GrantEdit, GrantsFile } from '../src/index.ts'
import {
  createGrantLedger,
  emptyGrants,
  GRANTS_VERSION,
  parseGrants,
  STALE_AFTER_MS,
} from '../src/index.ts'

/** 一个工作区（分节键）——本文件多数用例的那一节。 */
const HERE = '/work/proj'
const NOW = 1_700_000_000_000

// ══ 解析 ══════════════════════════════════════════════════════════════

describe('授权文件 · 解析（只读 · 从严）', () => {
  test('合法条目原样成授权——规则三格 ＋ 记账三位', () => {
    const parsed = parseGrants({
      version: 1,
      workspaces: {
        [HERE]: [{ tool: 'exec', op: ['read'], grantedAt: 1, lastHitAt: 2, hits: 3 }],
      },
    })

    expect(parsed.rejected).toEqual([])
    expect(parsed.file.workspaces[HERE]).toEqual([
      { tool: 'exec', op: ['read'], grantedAt: 1, lastHitAt: 2, hits: 3 },
    ])
  })

  test('记账位可缺（只点过、没用过）——缺了就不给那一位，**不编一个 0**', () => {
    const grant = parseGrants({ workspaces: { [HERE]: [{ tool: 'read', grantedAt: 7 }] } })
      .file.workspaces[HERE]?.[0]

    expect(grant).toEqual({ tool: 'read', grantedAt: 7 })
    expect('hits' in (grant ?? {})).toBe(false)
  })

  test('`version` 缺席＝按本版认（**文件是人手可写的**，缺个元数据键不该让整份失效）', () => {
    const parsed = parseGrants({ workspaces: { [HERE]: [{ tool: 'read', grantedAt: 1 }] } })

    expect(parsed.rejected).toEqual([])
    expect(parsed.file.version).toBe(GRANTS_VERSION)
  })

  test('`version` **不认**＝整份不收——那是**将来的**内核写的，本轮读不懂它', () => {
    const parsed = parseGrants({ version: 99, workspaces: { [HERE]: [{ tool: 'read', grantedAt: 1 }] } })

    expect(parsed.file.workspaces).toEqual({})
    expect(parsed.unreadable).toContain('99')
    // **整份读不懂**（不只是一条不生效）——盘上那份因此**不许写**（D31）
    expect(parsed.rejected).toEqual([])
  })

  test('整个值不是对象 / `workspaces` 不是对象——空文件 ＋ **整份读不懂**（不抛）', () => {
    expect(parseGrants(null).unreadable).toContain('对象')
    expect(parseGrants([1, 2]).unreadable).toContain('对象')
    expect(parseGrants({ workspaces: [] }).unreadable).toContain('workspaces')
    // 三条都不算「有坏条目」——**坏的是整份**（分界见 `GrantParseResult.unreadable`）
    expect(parseGrants(null).rejected).toEqual([])
  })

  test('**个别**条目读不懂不在这条线上——文件整体读得懂，`unreadable` 不给', () => {
    const parsed = parseGrants({ workspaces: { [HERE]: [{ tool: 'read', grantedAt: 1 }, { tool: 42 }] } })

    expect(parsed.unreadable).toBeUndefined()
    expect(parsed.rejected).toHaveLength(1)
  })

  test('一节不是数组——拒那一节，其余照收', () => {
    const parsed = parseGrants({
      workspaces: { [HERE]: { tool: 'read' }, '/work/other': [{ tool: 'read', grantedAt: 1 }] },
    })

    expect(parsed.file.workspaces[HERE]).toBeUndefined()
    expect(parsed.file.workspaces['/work/other']).toHaveLength(1)
    expect(parsed.rejected[0]?.workspace).toBe(HERE)
  })

  test('逐条拒——陌生键 / 缺 `grantedAt` / 记账位不是数（**不生效＝照旧问**）', () => {
    const bad: readonly unknown[] = [
      { tool: 'read', grantedAt: 1, pth: 'src/**' }, // 写错的键名不会被猜中
      { tool: 'read' }, // 缺记账位
      { tool: 'read', grantedAt: 'x' }, // 时刻不是数
      { tool: 'read', grantedAt: 1, hits: -1 }, // 计数为负
      { tool: 'read', grantedAt: 1, op: 'rm-rf' }, // 操作不在词表
      { tool: '' , grantedAt: 1 }, // 空工具名
    ]

    for (const entry of bad) {
      const parsed = parseGrants({ workspaces: { [HERE]: [entry] } })
      expect(parsed.file.workspaces[HERE], JSON.stringify(entry)).toBeUndefined()
      expect(parsed.rejected, JSON.stringify(entry)).toHaveLength(1)
    }
  })

  test('一条坏的不拖累好的——逐条裁，收下的原序留用', () => {
    const parsed = parseGrants({
      workspaces: { [HERE]: [{ tool: 'read', grantedAt: 1 }, { tool: 42 }, { tool: 'grep', grantedAt: 2 }] },
    })

    expect(parsed.file.workspaces[HERE]?.map((grant) => grant.tool)).toEqual(['read', 'grep'])
    expect(parsed.rejected.map((problem) => problem.index)).toEqual([1])
  })

  test('一条都不剩的节**不留**——空节只是噪音', () => {
    const parsed = parseGrants({ workspaces: { [HERE]: [{ tool: 42 }] } })
    expect(parsed.file.workspaces).toEqual({})
  })

  test('`emptyGrants()`＝本版空文件（没读过盘时的起点）', () => {
    expect(emptyGrants()).toEqual({ version: GRANTS_VERSION, workspaces: {} })
  })
})

// ══ 账本 ══════════════════════════════════════════════════════════════

/** 造一个账本——`now` 可注入（陈旧那条判据要看它）。 */
function book(file?: GrantsFile, now = (): number => NOW, onChange?: (edit: GrantEdit) => void) {
  return createGrantLedger({
    workspace: HERE,
    ...(file === undefined ? {} : { file }),
    now,
    ...(onChange === undefined ? {} : { onChange }),
  })
}

describe('账本 · 记（`a`）', () => {
  test('记一条——进名录，带上「什么时候点的」', () => {
    const ledger = book()
    ledger.remember({ tool: 'exec', op: ['read'] })

    // `rules()` 给的是**授权本身**（规则的超集：三格 ＋ 记账）——闸门拿它做匹配，
    // 只读前三格；记账那几位不参与判定（`matchRule` 一个都不看）
    expect(ledger.rules()).toMatchObject([{ tool: 'exec', op: ['read'], grantedAt: NOW }])
    expect(ledger.view()[0]?.describe).toBe('工具 exec × 根内 × 操作 read')
    expect(ledger.view()[0]?.grantedAt).toBe(NOW)
    // 还没用过——两位都不给（**不编**）
    expect(ledger.view()[0]?.hits).toBeUndefined()
    expect(ledger.view()[0]?.lastHitAt).toBeUndefined()
  })

  test('同形的再记一遍＝**不入册**（用户的话说过了，不必说两遍）', () => {
    const ledger = book()
    ledger.remember({ tool: 'exec', op: ['read'] })
    ledger.remember({ tool: 'exec', op: ['read'] })

    expect(ledger.view()).toHaveLength(1)
  })

  test('记新的一条报 `grant` 缘由——**装配据以立刻落盘**', () => {
    const seen: string[] = []
    const ledger = book(undefined, () => NOW, (edit) => void seen.push(edit.kind))

    ledger.remember({ tool: 'read' })
    ledger.remember({ tool: 'read' }) // 重复的不报（什么都没变）

    expect(seen).toEqual(['grant'])
  })
})

describe('账本 · 命中记账（久未命中的原料）', () => {
  test('命中一次——次数 ＋1、最近时刻刷新', () => {
    let at = NOW
    const ledger = book(undefined, () => at)
    ledger.remember({ tool: 'read' })

    at = NOW + 5_000
    ledger.hit({ tool: 'read' })
    at = NOW + 9_000
    ledger.hit({ tool: 'read' })

    expect(ledger.view()[0]?.hits).toBe(2)
    expect(ledger.view()[0]?.lastHitAt).toBe(NOW + 9_000)
  })

  test('不在册的命中＝**什么都不做**（报信的人搞错了，不替它补一条）', () => {
    const ledger = book()
    ledger.remember({ tool: 'read' })
    ledger.hit({ tool: 'exec' })

    expect(ledger.view()).toHaveLength(1)
    expect(ledger.view()[0]?.describe).toBe('工具 read × 根内 × 任意操作')
    expect(ledger.view()[0]?.hits).toBeUndefined()
  })

  test('命中报 `hit` 缘由——**攒着，不立刻落盘**（见 app 侧的接线）', () => {
    const seen: string[] = []
    const ledger = book(undefined, () => NOW, (edit) => void seen.push(edit.kind))

    ledger.remember({ tool: 'read' })
    ledger.hit({ tool: 'read' })

    expect(seen).toEqual(['grant', 'hit'])
  })
})

describe('账本 · 撤销（`/grants` 那两件里的第二件）', () => {
  test('撤一条——名录里没了，报 `revoke` 缘由', () => {
    const seen: string[] = []
    const ledger = book(undefined, () => NOW, (edit) => void seen.push(edit.kind))
    ledger.remember({ tool: 'read' })
    ledger.remember({ tool: 'grep' })

    expect(ledger.revoke(HERE, 0)).toBe(true)
    expect(ledger.view().map((row) => row.describe)).toEqual(['工具 grep × 根内 × 任意操作'])
    expect(seen.at(-1)).toBe('revoke')
  })

  test('越界 / 那一节不在——`false`，**不抛也不新建节**', () => {
    const ledger = book()
    ledger.remember({ tool: 'read' })

    expect(ledger.revoke(HERE, 5)).toBe(false)
    expect(ledger.revoke('/work/elsewhere', 0)).toBe(false)
    expect(ledger.sections()).toEqual([HERE]) // 没被「撤一条」顺手造出一节来
    expect(ledger.view()).toHaveLength(1)
  })

  test('**整节撤掉**（陈旧节那条路）——返回撤掉几条', () => {
    const ledger = book({
      version: 1,
      workspaces: { [HERE]: [{ tool: 'a', grantedAt: 1 }], '/work/gone': [{ tool: 'b', grantedAt: 1 }] },
    })

    expect(ledger.dropSection('/work/gone')).toBe(1)
    expect(ledger.sections()).toEqual([HERE])
    expect(ledger.dropSection('/work/gone')).toBe(0) // 再来一次＝零条（已不在）
  })
})

describe('账本 · 陈旧（久未命中）', () => {
  const base: GrantsFile = {
    version: 1,
    workspaces: {
      [HERE]: [
        { tool: 'fresh', grantedAt: NOW - 100, lastHitAt: NOW - 100 },
        { tool: 'old', grantedAt: NOW - STALE_AFTER_MS - 1, lastHitAt: NOW - STALE_AFTER_MS - 1 },
        { tool: 'never', grantedAt: NOW - STALE_AFTER_MS - 1 },
      ],
    },
  }

  test('判据＝**最近一次命中**（没命中过就看「什么时候点的」）', () => {
    const rows = book(base).view()

    expect(rows.map((row) => [row.describe.split(' ')[1], row.stale])).toEqual([
      ['fresh', false],
      ['old', true],
      ['never', true],
    ])
  })

  test('**只标不删**——`view()` 是读面，读它不该改任何东西', () => {
    const ledger = book(base)
    ledger.view()
    ledger.view()

    expect(ledger.view()).toHaveLength(3)
    expect(ledger.snapshot().workspaces[HERE]).toHaveLength(3)
  })
})

describe('账本 · 快照（落盘那一份）', () => {
  test('空节**不留**——撤销掉最后一条＝那一节也没了', () => {
    const ledger = book({
      version: 1,
      workspaces: { [HERE]: [{ tool: 'read', grantedAt: 1 }], '/work/gone': [{ tool: 'grep', grantedAt: 1 }] },
    })

    ledger.revoke(HERE, 0)
    expect(Object.keys(ledger.snapshot().workspaces)).toEqual(['/work/gone'])

    ledger.dropSection('/work/gone')
    expect(ledger.snapshot().workspaces).toEqual({})
  })

  test('快照是**副本**——拿去落盘之后，账本再变也不会改到那一份', () => {
    const ledger = book()
    ledger.remember({ tool: 'read' })

    const taken = ledger.snapshot()
    ledger.remember({ tool: 'grep' })

    expect(taken.workspaces[HERE]).toHaveLength(1)
    expect(ledger.snapshot().workspaces[HERE]).toHaveLength(2)
  })

  test('别的节原样带着——撤陈旧节要看到它们', () => {
    const ledger = book({
      version: 1,
      workspaces: { '/work/gone': [{ tool: 'grep', grantedAt: 1 }] },
    })

    expect(ledger.sections()).toEqual(['/work/gone'])
    expect(ledger.rules()).toEqual([]) // 本工作区还是空的
    expect(Object.keys(ledger.snapshot().workspaces)).toEqual(['/work/gone'])
  })
})
