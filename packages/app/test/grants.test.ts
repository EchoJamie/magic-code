/**
 * U22 · **授权的落点＝工作区** —— 端到端接线的判据（装配根 × 权限域 × 授权文件）。
 *
 * 四件都是「光看域内测试看不出来」的事：
 *
 * - **`a` 真的落盘了吗**——批准时按 `a` → 账本 → `grants.json`（原子写）；
 *   域内测试拿的是账本对象，**盘上有没有那一条**只有从装配跑一遍才看得见。
 * - **跨会话存活吗**——重起一次装配（＝关掉再开），同类**不再问**。
 *   这正是本单元治的那件事：授权活在**工作区**里，不在会话里。
 * - **`/grants` 那两条路通吗**——`grants.list` → `grants.catalog`（名录 ＋ 陈旧的节 ＋
 *   本会话的裁决分布）；`grants.revoke` → **盘上真少一条**。
 * - **优先级链没被这条新路捅穿吗**——最宽的授权也放不出必闸类（必闸禁区凌驾一切）。
 *
 * 走**真配置加载器**与**真闸门**——只有模型是替身；`grantsFile` 指到沙地里
 * （不碰真的 `~/.magic`）。
 *
 * ## ⚠️ U76 之后：夹具从「只读命令」挪到「取网页」（2026-09-25）
 *
 * 闸门换了底（`gate.ts` 头注那条链）：**默认通**——判轻的调用**根本走不到闸门那一问**
 * （`echo` 一类从此连卡都没有，自然也没有可拨的 `a`）；而**名单那两条**（删除 · 改权限族）
 * 的授权**放不出任何东西**（`hit && byHost` 是仅存的自动放行口，而名单类的 face 没有域名）。
 * ⇒ 「同类第二次不再问」这句话**只在带域名的那一件上还成立**：取网页（`web_fetch`）。
 * 本文件的夹具因此换成它——**不必配提炼模型**：卡挂在**执行之前**，判据要的
 * 「问没问 / 放没放」全在闸门那一跳，取回成不成不影响（`ok: false` 那一条是「没配」的
 * 正常收束，见 `web-fetch-tool.ts`）。
 * ⚠️ 反面那条（名单即禁区）照旧：`GATED_TURN` 一发 `rm -rf build` 就说得清。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FauxTurn } from '@magic/faux'
import type { Command, KernelEvent } from '@magic/contracts'
import type { Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage, type Stage } from './support.ts'

/**
 * 取网页那一发——**判重 · 外发 · 带域名**（`host: example.com`）。
 *
 * ⚠️ **U76 后的夹具就是它**（由头见文件头注）：默认通之下判轻的调用不再经过闸门那一问，
 * 而名单那两条的授权又放不出任何东西——**「总是允许」还发得动的地方只剩这一格**
 * （`hit && byHost`）。卡挂在**执行之前**，故这里**不配提炼模型**也照样有卡、
 * 照样记得下一条 `{tool, op, host}` 的授权；取回那一跳回了「还没配」并就地收束
 * （`web-fetch-tool.ts` 的 `NOT_CONFIGURED`），与本文件的判据无关。
 */
const WEB_FETCH_TURN = {
  toolCalls: [{ name: 'web_fetch', args: { url: 'https://example.com/a', prompt: '看什么' } }],
}
/** 一条必闸命令——`rm` 归删除（不可逆），且工作区外／内都入必闸清单。 */
const GATED_TURN = { toolCalls: [{ name: 'exec', args: { cmd: 'chmod 755 .' } }] }

/** 裸接控制面——订阅事件 ＋ 按需答复。 */
function bareShell(assembly: Assembly) {
  const events: KernelEvent[] = []
  const requests: number[] = []

  const off = assembly.shell.subscribe((event) => {
    events.push(event)
    if (event.kind === 'tool.decision.request') requests.push(event.id)
  })

  return {
    events,
    requests,
    /** 答复一次询问——`remember` 就是外壳按 `a` 时带的那一位。 */
    answer(id: number, opts?: { remember?: boolean }): void {
      assembly.shell.send({ type: 'decision.answer', id, decision: 'approve', ...opts })
    },
    send(command: Command): void {
      assembly.shell.send(command)
    },
    dispose: off,
  }
}

async function until(test: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(10)
  }
}

/** 授权文件落在沙地里（**不碰真的 `~/.magic`**）——多次装配共用同一个路径。 */
function grantsPathOf(stage: Stage): string {
  return join(stage.root, 'magic', 'grants.json')
}

/** 授权文件的落地形状（断言用——只取要看的那几格）。 */
type StoredGrant = {
  readonly tool: string
  readonly op?: readonly string[]
  /** 域名那一格（U72）——「取网页」的授权必须带上它（那一格缺了＝任意域名，见 `grantOf`）。 */
  readonly host?: string
  readonly grantedAt: number
}
type StoredFile = {
  readonly version: number
  readonly workspaces: Record<string, readonly StoredGrant[]>
}

/** 读**盘上**那份授权文件——不是读内存里的账本（「真的落盘了吗」的判据就在这一句）。 */
function stored(path: string): StoredFile {
  return JSON.parse(readFileSync(path, 'utf8')) as StoredFile
}

/** 手写一份授权文件（验陈旧节 / 最宽授权那几条路时用）。 */
function writeGrants(stage: Stage, file: unknown): void {
  const path = grantsPathOf(stage)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(file))
}

/** 分节键＝**默认根的规范形**——沙地路径在 macOS 上多半不是规范形，故先装配一次问它。 */
function sectionKeyOf(stage: Stage): string {
  const probe = stage.assemble({ grantsFile: grantsPathOf(stage) })
  const key = probe.workspaceRoots[0] as string
  probe.close()
  return key
}

/**
 * 跑一轮：装配 → 提交一句 → 等闸门问。返回装配与那一束观察面。
 *
 * ⚠️ `turns` 的类型**显式写着**（不靠缺省值推）：夹具换过两次（只读命令 → 取网页），
 * 而下面还有几条用例自己要给剧本（如必闸那条给 `GATED_TURN`）——不写类型，缺省值
 * 会把形参推成「只有取网页那一种形状」，递别的一发就编译不过（实测踩过）。
 */
async function askOnce(stage: Stage, turns: readonly FauxTurn[] = [WEB_FETCH_TURN, { text: '好' }]) {
  const assembly = stage.assemble({ grantsFile: grantsPathOf(stage), turns })
  const shell = bareShell(assembly)
  assembly.shell.send({ type: 'input.submit', text: '跑一下' })
  await until(() => shell.requests.length >= 1, '闸门问了一次')

  return { assembly, shell }
}

/** 收尾一次装配（关库 ＋ 退订）。 */
function finish(assembly: Assembly, shell: ReturnType<typeof bareShell>): void {
  shell.dispose()
  assembly.close()
}

describe('U22 · 「总是允许」的落点＝工作区（落盘 ＋ 跨会话存活）', () => {
  test('按 `a` → **写进 `grants.json`**（一个文件，按工作区绝对路径分节）', async () => {
    const stage = makeStage()
    try {
      const { assembly, shell } = await askOnce(stage)
      shell.answer(shell.requests[0] as number, { remember: true })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '工具跑完')
      finish(assembly, shell)

      const section = assembly.workspaceRoots[0] as string
      const file = stored(grantsPathOf(stage))

      expect(file.version).toBe(1)
      expect(Object.keys(file.workspaces)).toEqual([section])
      // ⚠️ **原锚**：`['exec', ['read']]`（那时夹具是一条只读命令）。
      // **为何变**：U76 后判轻的调用**不再经过闸门那一问**（默认通），那条路上没有 `a` 可拨；
      // **新锚**：能问出授权的只剩**取网页**，故条目是三格 `{工具 × 操作 outbound × 域名}`
      // ——域名那一格是**必须写上**的（缺了＝任意域名，见 `grantOf` 的注）。
      expect(file.workspaces[section]?.map((grant) => [grant.tool, grant.op, grant.host])).toEqual([
        ['web_fetch', ['outbound'], 'example.com'],
      ])
      expect(file.workspaces[section]?.[0]?.grantedAt).toBeNumber()
    } finally {
      stage.dispose()
    }
  })

  /**
   * ⚠️ **这条判据本身一个字没动**（U76 也只是换了夹具）：授权落在**工作区**里，
   * 重起一次装配它照样生效——只不过「同类」如今是**取网页那一类**（判重 ＋ 带域名）。
   * 名单那两条**没有**「重起不再问」这一说（它们是不可授权的），见下一条用例。
   */
  test('**重起不再问**——第二次装配读同一份文件，同类直接放行（裁者是 `auto`）', async () => {
    const stage = makeStage()
    try {
      // 第一趟：问 → 按 `a`
      const first = await askOnce(stage)
      first.shell.answer(first.shell.requests[0] as number, { remember: true })
      await until(() => eventsOfKind(first.shell.events, 'tool.result').length >= 1, '第一趟跑完')
      finish(first.assembly, first.shell)

      // 第二趟：**新装配**（＝关掉再开）——同一份 grants.json，同一个工作区
      const second = stage.assemble({ grantsFile: grantsPathOf(stage) })
      const shell2 = bareShell(second)
      second.shell.send({ type: 'input.submit', text: '再跑一下' })
      await until(() => eventsOfKind(shell2.events, 'tool.result').length >= 1, '第二趟跑完')

      expect(shell2.requests).toEqual([]) // **一次都没问**
      expect(eventsOfKind(shell2.events, 'tool.decision').map((event) => event.data.decider)).toEqual([
        'auto',
      ])
      finish(second, shell2)
    } finally {
      stage.dispose()
    }
  })

  test('**必闸禁区凌驾其上**——最宽的授权也放不出必闸类（照样问，且说得出为什么）', async () => {
    const stage = makeStage()
    try {
      // 照着**最宽的攻法**写一条授权：任意工具 × 任意路径 × 任意操作
      const key = sectionKeyOf(stage)
      writeGrants(stage, { version: 1, workspaces: { [key]: [{ tool: '*', grantedAt: 1 }] } })

      const { assembly, shell } = await askOnce(stage, [GATED_TURN, { text: '没删' }])

      // 必闸类**照样弹卡**——授权命中了也没用（清单即禁区）
      expect(shell.requests).toHaveLength(1)
      expect(eventsOfKind(shell.events, 'tool.decision.request')[0]?.data.material).toContain('禁区')
      expect(eventsOfKind(shell.events, 'tool.decision.request')[0]?.data.weight).toBe('heavy')

      shell.answer(shell.requests[0] as number)
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '跑完')
      finish(assembly, shell)
    } finally {
      stage.dispose()
    }
  })
})

describe('U22 · `/grants` 的两条路（读侧 ＋ 撤销）', () => {
  test('`grants.list` → `grants.catalog`：名录 ＋ 陈旧的节 ＋ 本会话的裁决分布', async () => {
    const stage = makeStage()
    try {
      const { assembly, shell } = await askOnce(stage)
      shell.answer(shell.requests[0] as number, { remember: true })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '跑完')

      shell.send({ type: 'grants.list' })
      await until(() => eventsOfKind(shell.events, 'grants.catalog').length >= 1, '名录回来了')

      const catalog = eventsOfKind(shell.events, 'grants.catalog')[0]?.data
      expect(catalog?.workspace).toBe(assembly.workspaceRoots[0] as string)
      // 名录那一行照四格报——**域名那一格在写了时才报**（U72；「不写」在取网页上＝不命中，
      // 报成「任意域名」会说反）。夹具换成取网页后，那一行多了「× 域名 example.com」。
      expect(catalog?.grants.map((row) => row.describe)).toEqual([
        '工具 web_fetch × 根内 × 操作 outbound × 域名 example.com',
      ])
      expect(catalog?.stale).toEqual([])
      // 放行区那一笔账（`B10` 口径的原料）：这一件是**人答的**（问了）⇒ uncovered＝1
      expect(catalog?.decisions).toEqual({ total: 1, uncovered: 1, vetoed: 0 })

      finish(assembly, shell)
    } finally {
      stage.dispose()
    }
  })

  test('撤销 → **盘上真少一条** ＋ 回话带一行回执；重起之后照问', async () => {
    const stage = makeStage()
    try {
      const { assembly, shell } = await askOnce(stage)
      shell.answer(shell.requests[0] as number, { remember: true })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '跑完')

      const section = assembly.workspaceRoots[0] as string
      expect(stored(grantsPathOf(stage)).workspaces[section]).toHaveLength(1)

      shell.send({ type: 'grants.revoke', index: 0 })
      await until(
        () => eventsOfKind(shell.events, 'grants.catalog').length >= 1,
        '撤销之后的名录回来了',
      )

      const after = eventsOfKind(shell.events, 'grants.catalog').at(-1)?.data
      expect(after?.grants).toEqual([])
      expect(after?.note).toContain('已撤销')
      // **盘上也真的没了**——空节不留，故那一节整个消失
      expect(stored(grantsPathOf(stage)).workspaces[section]).toBeUndefined()

      finish(assembly, shell)

      // 重起：授权没了 ⇒ 照问
      const again = await askOnce(stage)
      expect(again.shell.requests).toHaveLength(1)
      finish(again.assembly, again.shell)
    } finally {
      stage.dispose()
    }
  })

  test('**陈旧的节**（B11）——路径已不在的那些**列出来**，且**不自动删**', async () => {
    const stage = makeStage()
    try {
      const gone = join(stage.root, 'gone-project') // 从来没建过这个目录
      writeGrants(stage, { version: 1, workspaces: { [gone]: [{ tool: 'read', grantedAt: 1 }] } })

      const assembly = stage.assemble({ grantsFile: grantsPathOf(stage) })
      expect(assembly.grantsView().stale).toEqual([gone])

      const shell = bareShell(assembly)
      shell.send({ type: 'grants.list' })
      await until(() => eventsOfKind(shell.events, 'grants.catalog').length >= 1, '名录回来了')

      expect(eventsOfKind(shell.events, 'grants.catalog')[0]?.data.stale).toEqual([gone])
      // **不自动删**：问过之后盘上那一节照旧在（删用户数据不归内核）
      expect(Object.keys(stored(grantsPathOf(stage)).workspaces)).toEqual([gone])

      shell.send({ type: 'grants.revoke', workspace: gone }) // 选定即撤——这一下才真删
      await until(
        () => eventsOfKind(shell.events, 'grants.catalog').length >= 2,
        '撤销之后的名录回来了',
      )

      expect(stored(grantsPathOf(stage)).workspaces).toEqual({})
      finish(assembly, shell)
    } finally {
      stage.dispose()
    }
  })
})

/**
 * U28 · **历史累计**（`B10` 口径的跨会话面）——本会话那个数只够看「这一趟顺不顺」；
 * **「这个项目值不值得配规则」得跨会话**（`交接/进度台账.md` · 随批小修 12）。
 *
 * 判据锚的是「我要什么」：**重起之后，屏上那笔账仍然记得上一趟**——
 * 而它**不是**把本会话那个数直接改成累计（那就把两件事混成一件了）：
 * 两笔账各报各的（`decisions` / `history`），外壳那一侧两行分列。
 */
describe('U28 · 历史累计（跨会话那笔账）', () => {
  test('重起之后：本会话的账从头起，**历史把上一趟算进去**', async () => {
    const stage = makeStage()
    try {
      // 第一趟：一条调用 → 闸门问了 → 人答（`user`）
      const first = await askOnce(stage)
      first.shell.answer(first.shell.requests[0] as number)
      await until(() => eventsOfKind(first.shell.events, 'tool.result').length >= 1, '第一趟跑完')

      first.shell.send({ type: 'grants.list' })
      await until(() => eventsOfKind(first.shell.events, 'grants.catalog').length >= 1, '名录回来了')

      const before = eventsOfKind(first.shell.events, 'grants.catalog')[0]?.data
      expect(before?.decisions).toEqual({ total: 1, uncovered: 1, vetoed: 0 })
      // 历史＝库里那些（这一趟的裁决当场就落了库，故它已经在里头）
      expect(before?.history).toEqual({ total: 1, auto: 0 })
      finish(first.assembly, first.shell)

      // 第二趟（＝关掉再开）：本会话一条都还没走过，历史接着上一趟数
      const second = stage.assemble({ grantsFile: grantsPathOf(stage) })
      const shell2 = bareShell(second)
      second.shell.send({ type: 'grants.list' })
      await until(() => eventsOfKind(shell2.events, 'grants.catalog').length >= 1, '名录回来了')

      const after = eventsOfKind(shell2.events, 'grants.catalog')[0]?.data
      expect(after?.decisions).toEqual({ total: 0, uncovered: 0, vetoed: 0 })
      expect(after?.history).toEqual({ total: 1, auto: 0 })
      finish(second, shell2)
    } finally {
      stage.dispose()
    }
  })
})

describe('U22 · 启动那几句（审计第 13 条）', () => {
  test('被拒的权限规则**进记录区一行回执**——`Assembly.notices` 里备着那句话', () => {
    const stage = makeStage({
      config: { permissions: { rules: [{ tool: 'read', pth: 'src/**' }] } },
    })
    try {
      const assembly = stage.assemble({ grantsFile: grantsPathOf(stage) })

      // 那条规则**没生效**（`pth` 是写错的键名）——自检面照旧报得出缘由
      expect(assembly.rejectedRules).toHaveLength(1)
      expect(assembly.rejectedRules[0]?.reason).toContain('pth')
      // 而那句话**也备给了外壳**（原先只有 `--check` 会说，走 TUI 一声不响 ✗）
      expect(assembly.notices).toHaveLength(1)
      expect(assembly.notices[0]).toContain('读不懂')
      expect(assembly.notices[0]).toContain('--check')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('一切正常时**一句都不说**——`notices` 是空数组（空态不是「没事找话说」）', () => {
    const stage = makeStage()
    try {
      const assembly = stage.assemble({ grantsFile: grantsPathOf(stage) })
      expect(assembly.notices).toEqual([])
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
