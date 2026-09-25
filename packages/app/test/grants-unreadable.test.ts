/**
 * D31 · **授权文件读不懂时被下一次写入抹掉** —— 修好之后的判据。
 *
 * ## 缺陷是什么（照缺陷档）
 *
 * `grants.json` 不是合法 JSON（或 `version` 不认）时，启动那一步的读给回**一份空账本**；
 * 此后用户**按一次 `a`**，就把他的**整份授权覆写掉**。**单进程、不并发也会踩**。
 * 根子在于：空账本**长得跟「真的没有授权」一样**，而写的那条路照它写。
 *
 * ## 本文件钉四件事（＝工单「处置」那四条）
 *
 * ① **读不懂 ⇒ 一律不覆写**——原文件**逐字节不动**（不改名 · 不备份 · 不另起新文件）；
 * ② **不是全拒**——该过闸的照过闸（用户可以再一次一次地批）；按 `a` 记下的那一条**进内存**
 *    （本次会话的名录里有它）、**不落盘**。
 *    ⚠️ **但「按 `a` 之后不再问」这一半 U76 起不成立了**：名单里的两类（删除 · 改权限）
 *    **不可授权**——`a` 换不来「不再问」那件事，同形的下一件照旧过闸（见那一组用例）。
 *    判轻的那些反而**不问**了（默认通），故本文件的 fixture 一律取**判重的**执行命令。
 * ③ **报得出来**——开机那一行点名**文件**与**缘由**，且**只报一次**；
 * ④ **改对之后自然恢复**——改回合法 JSON，**下一次启动**照旧读它、长期放行回来；无修复命令。
 *    那一条的「长期放行」取**按域名**的授权（U76 起唯一「配了授权 ⇒ 不再问」的形态，
 *    见那一组用例的头注）。
 *
 * ## 分界（本单没动的那些）
 *
 * **整份**读不懂才是不许写。**个别条目**读不懂是另一支（`rejected`）：文件整体读得懂，
 * 该落的改动照落（那几条不生效，缘由已经报过）——见最后那组用例。
 *
 * 走**真装配**（真配置加载器 · 真闸门 · 真文件），只有模型是替身；沙地里的 `grants.json`
 * 由本文件手写，**不碰真的 `~/.magic`**。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Command, KernelEvent } from '@magic/contracts'
import { commitGrants } from '../src/grants-file.ts'
import { loadGrants } from '../src/grants-file.ts'
import type { Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage, type Stage } from './support.ts'

/**
 * 一条**判重的**执行命令（名单第一类 · 删除）——本文件要的是「过闸 → 人批 → 试图落盘」
 * 那一跳，**只有判重的调用才有卡可答**（U76 起判轻的默认通、根本不问）。
 */
const DELETE_TURN = { toolCalls: [{ name: 'exec', args: { cmd: 'rm -rf build' } }] }

/**
 * 一次**判重却带域名**的调用（取网页）——「改对之后自然恢复」那一条靠它。
 *
 * 由头（U76）：判重的执行命令**不可授权**，故「读到一条授权 ⇒ 不再问」这条链只剩
 * **按域名**那一格走得通（`gate.ts`：判轻 ／ 判重却带域名）。它判重（外发），默认通
 * 放不了它——于是那一句 `decider: 'auto'` 只可能来自**读到的那条授权**。
 *
 * 这一趟**不出网**：没配「提炼用的模型」时工具在**取回之前**就收束
 * （`web-fetch-tool.ts` 的 `NOT_CONFIGURED`），故断言落不到网络上去。
 */
const WEB_TURN = {
  toolCalls: [
    { name: 'web_fetch', args: { url: 'https://example.com/pricing', prompt: '多少钱？' } },
  ],
}

/** 授权文件落在沙地里（**不碰真的 `~/.magic`**）。 */
function grantsPathOf(stage: Stage): string {
  return join(stage.root, 'magic', 'grants.json')
}

/**
 * 一份**合法**的授权文件（一条真授权）——「截断」与「会话中途坏掉」两处都用它。
 *
 * ⚠️ 它写的是 `{tool, op:['read']}` 那一条——**放不了任何东西**（U76：判轻的本就不问，
 * 判重的执行命令不可授权）。这一点正合那两处用例的用法：只要盘上是一份**读得懂**的文件，
 * 而它那条授权够不着下面要跑的那一件就够了。要「读到授权 ⇒ 不再问」得用 `webGrantFile`。
 */
function validGrants(section: string, tool = 'exec'): string {
  return `${JSON.stringify(
    {
      version: 1,
      workspaces: {
        [section]: [{ tool, op: ['read'], grantedAt: 1_700_000_000_000 }],
      },
    },
    null,
    2,
  )}\n`
}

/**
 * 写一份**截断**的授权文件（含一节真授权）——缺陷档那条触发路径：
 * 「文件读到一半被截断」（断电 · 盘满 · 外部编辑器存盘中途），不是「要故意做坏」。
 */
function writeTruncated(stage: Stage, section: string, keep = 40): string {
  const path = grantsPathOf(stage)
  mkdirSync(dirname(path), { recursive: true })
  const text = validGrants(section)
  const cut = text.slice(0, text.length - keep)
  writeFileSync(path, cut)
  return cut
}

/**
 * 一份**合法**的授权文件，那一条授权**按域名给**（取网页 · `example.com`）。
 *
 * 为什么不照 `validGrants` 用 `{tool:'exec', op:['read']}`：U76 起那种授权**放不了任何东西**
 * （判轻的本就不问，判重的执行命令不可授权）——「读到了它 ⇒ 不再问」这句就没法验。
 */
function webGrantFile(section: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      workspaces: {
        [section]: [
          {
            tool: 'web_fetch',
            op: ['outbound'],
            host: 'example.com',
            grantedAt: 1_700_000_000_000,
          },
        ],
      },
    },
    null,
    2,
  )}\n`
}

/** 盘上那一份的**原始字节**（逐字节比就是这个）——不是解析出来的对象。 */
function bytesOf(path: string): Buffer {
  return readFileSync(path)
}

/** 裸接控制面——订阅事件 ＋ 按需答复（同 `grants.test.ts`）。 */
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

/** 分节键＝**默认根的规范形**——先装配一次问它（同 `grants.test.ts`）。 */
function sectionKeyOf(stage: Stage): string {
  const probe = stage.assemble({ grantsFile: grantsPathOf(stage) })
  const key = probe.workspaceRoots[0] as string
  probe.close()
  return key
}

// ══ ① 写入口那一层：读不懂 ⇒ 一个字都不写 ══════════════════════════════════

describe('D31 · `commitGrants` 撞上读不懂的文件', () => {
  test('截断的文件 ＋ 一次写入 ⇒ **逐字节未动**（修前是「只剩这一次写进去的那一条」）', () => {
    const stage = makeStage()
    try {
      const path = grantsPathOf(stage)
      const before = writeTruncated(stage, '/work/proj')

      const done = commitGrants(path, [
        { kind: 'grant', workspace: '/work/proj', grant: { tool: 'exec', grantedAt: 2 } },
      ])

      expect(done.ok).toBe(false)
      expect(done.ok === false && done.reason).toContain('不是合法 JSON')
      // **一个字节都没动**——不是「改得差不多」，是**同一个 Buffer**
      expect(bytesOf(path).equals(Buffer.from(before, 'utf8'))).toBe(true)
    } finally {
      stage.dispose()
    }
  })

  test('`version` 不认也走这一支——那是**将来的**内核写的，本轮读不懂', () => {
    const stage = makeStage()
    try {
      const path = grantsPathOf(stage)
      mkdirSync(dirname(path), { recursive: true })
      const before = JSON.stringify({ version: 99, workspaces: { '/work/proj': [] } })
      writeFileSync(path, before)

      const done = commitGrants(path, [
        { kind: 'grant', workspace: '/work/proj', grant: { tool: 'exec', grantedAt: 2 } },
      ])

      expect(done.ok).toBe(false)
      expect(done.ok === false && done.reason).toContain('99')
      expect(bytesOf(path).equals(Buffer.from(before, 'utf8'))).toBe(true)
    } finally {
      stage.dispose()
    }
  })

  test('**文件不在**不是这一支——第一次用没有它就是常态，照写', () => {
    const stage = makeStage()
    try {
      const path = grantsPathOf(stage)
      const done = commitGrants(path, [
        { kind: 'grant', workspace: '/work/proj', grant: { tool: 'exec', grantedAt: 2 } },
      ])

      expect(done.ok).toBe(true)
      const file = JSON.parse(readFileSync(path, 'utf8')) as {
        workspaces: Record<string, unknown[]>
      }
      expect(file.workspaces['/work/proj']).toHaveLength(1)
    } finally {
      stage.dispose()
    }
  })

  test('**个别条目**读不懂不是这一支——文件整体读得懂，该落的改动照落', () => {
    const stage = makeStage()
    try {
      const path = grantsPathOf(stage)
      mkdirSync(dirname(path), { recursive: true })
      // 一条好的 ＋ 一条坏的（`tool` 不是字符串）——逐条裁，好的照收
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          workspaces: {
            '/work/proj': [{ tool: 'read', grantedAt: 1 }, { tool: 42 }],
          },
        }),
      )

      const done = commitGrants(path, [
        { kind: 'grant', workspace: '/work/proj', grant: { tool: 'exec', grantedAt: 2 } },
      ])

      expect(done.ok).toBe(true)
      const file = JSON.parse(readFileSync(path, 'utf8')) as {
        workspaces: Record<string, { tool: string }[]>
      }
      // 收下的那条还在（不是「整份重来」），新的一条加上了
      expect(file.workspaces['/work/proj']?.map((grant) => grant.tool)).toEqual(['read', 'exec'])
    } finally {
      stage.dispose()
    }
  })
})

// ══ ② 读入口那一层：两种「没有」分得开 ═════════════════════════════════════

describe('D31 · `loadGrants` 把「不在」与「读不懂」分开', () => {
  test('文件不在 ⇒ 空账本，但**不给** `unreadable`（那是空起点，写得）', () => {
    const stage = makeStage()
    try {
      const loaded = loadGrants(join(stage.root, 'never-written.json'))
      expect(loaded.unreadable).toBeUndefined()
      expect(loaded.file.workspaces).toEqual({})
    } finally {
      stage.dispose()
    }
  })

  test('截断 ⇒ 空账本 ＋ `unreadable`（缘由是给人看的一句话，不带解析器的英文前缀）', () => {
    const stage = makeStage()
    try {
      writeTruncated(stage, '/work/proj')
      const loaded = loadGrants(grantsPathOf(stage))

      expect(loaded.file.workspaces).toEqual({})
      expect(loaded.unreadable).toContain('不是合法 JSON')
      expect(loaded.unreadable).not.toContain('JSON Parse error') // 话头已经说过了，不重复
    } finally {
      stage.dispose()
    }
  })
})

// ══ ③ 装配那一层：报得出来 · 不落盘 · 一次一议 · 改对就恢复 ══════════════════

describe('D31 · 装配端到端（读不懂之后这一趟怎么走）', () => {
  test('开机那一行**点名文件与缘由**——且按 `a` 之后**不刷**第二句', async () => {
    const stage = makeStage()
    try {
      const section = sectionKeyOf(stage)
      writeTruncated(stage, section)

      const assembly = stage.assemble({
        grantsFile: grantsPathOf(stage),
        turns: [DELETE_TURN, { text: '好' }],
      })
      const said = assembly.notices

      expect(said).toHaveLength(1) // 授权这一摊只说一句
      expect(said[0]).toContain(grantsPathOf(stage)) // 哪个文件
      expect(said[0]).toContain('不是合法 JSON') // 读不懂在哪
      expect(said[0]).toContain('下次启动') // 怎么办

      // 按一次 `a`（这一趟会把授权记进内存、并试图落盘）
      const shell = bareShell(assembly)
      shell.send({ type: 'input.submit', text: '跑一下' })
      await until(() => shell.requests.length >= 1, '闸门问了一次')
      shell.answer(shell.requests[0] as number, { remember: true })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '工具跑完')

      // **还是那一句**（不是「每次写都刷」一句新的）
      expect(assembly.notices).toEqual(said)

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**一次一议**——读不懂不是「全拒」：该过闸的照过闸，批了就真跑；按 `a` 只进内存', async () => {
    const stage = makeStage()
    try {
      const section = sectionKeyOf(stage)
      const before = writeTruncated(stage, section)

      const assembly = stage.assemble({
        grantsFile: grantsPathOf(stage),
        turns: [
          DELETE_TURN,
          { text: '好' },
          DELETE_TURN,
          { text: '好' },
          DELETE_TURN,
          { text: '好' },
        ],
      })
      const shell = bareShell(assembly)

      // 第一件：过闸 → 人批（不按 `a`）→ **真跑了**（不是被静默挡住）
      shell.send({ type: 'input.submit', text: '第一件' })
      await until(() => shell.requests.length >= 1, '第一件过闸')
      shell.answer(shell.requests[0] as number)
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '第一件跑完')
      expect(eventsOfKind(shell.events, 'tool.result')).toHaveLength(1)

      // 第二件（同形）：**人批过的那一次不记**，故照旧过闸——「一次一议」就是这句话
      shell.send({ type: 'input.submit', text: '第二件' })
      await until(() => shell.requests.length >= 2, '第二件照旧过闸')
      shell.answer(shell.requests[1] as number, { remember: true }) // 这一下按 `a`
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 2, '第二件跑完')

      // ⚠️ **这一条 U76 换过**：旧版断言「第三件不再问（`a` 当场有效）」。默认通之后
      // **名单里的两类不可授权**——`a` 记下的那一条放不了删除 / 改权限，同形的下一件
      // **照旧过闸**。故这里断的是**新的事实**：第三次**照样问**，且裁者是**人**（不是 `auto`）。
      shell.send({ type: 'input.submit', text: '第三件' })
      await until(() => shell.requests.length >= 3, '第三件照旧过闸')
      shell.answer(shell.requests[2] as number)
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 3, '第三件跑完')
      expect(shell.requests).toHaveLength(3) // 问了第三次——名单里的东西授权不动它
      expect(eventsOfKind(shell.events, 'tool.decision').at(-1)?.data.decider).toBe('user')

      // 而 `a` **仍是有效的**——它进了**内存**（本次会话的名录里有那一条）：
      // 「不落盘」不是「什么都没记住」，这两件事在这个用例里分得开
      const remembered = assembly.grantsView().grants.map((row) => row.describe)
      expect(remembered).toHaveLength(1)
      expect(remembered[0]).toContain('delete') // 记的就是删除这一类

      shell.dispose()
      assembly.close()

      // **但不落盘**：盘上那份还是原来那串被截断的字节，一个字节都没动
      expect(bytesOf(grantsPathOf(stage)).equals(Buffer.from(before, 'utf8'))).toBe(true)
    } finally {
      stage.dispose()
    }
  })

  test('`/grants` 那一屏也念同一句——空名录＋不吭声＝在骗人', async () => {
    const stage = makeStage()
    try {
      const section = sectionKeyOf(stage)
      writeTruncated(stage, section)

      const assembly = stage.assemble({ grantsFile: grantsPathOf(stage) })
      const shell = bareShell(assembly)
      shell.send({ type: 'grants.list' })
      await until(() => eventsOfKind(shell.events, 'grants.catalog').length >= 1, '名录回来了')

      const catalog = eventsOfKind(shell.events, 'grants.catalog')[0]?.data
      expect(catalog?.grants).toEqual([])
      expect(catalog?.note).toContain('读不懂')
      expect(catalog?.note).toContain(grantsPathOf(stage))

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**改对之后自然恢复**——下一次启动读到它，长期放行回来（无修复命令、不留状态）', async () => {
    const stage = makeStage()
    try {
      const section = sectionKeyOf(stage)
      writeTruncated(stage, section)

      // 第一趟：读不懂
      const broken = stage.assemble({ grantsFile: grantsPathOf(stage) })
      expect(broken.grantsUnreadable).toBeDefined()
      broken.close()

      // 用户把它改对（就是原文件该有的样子）——没有别的动作
      writeFileSync(grantsPathOf(stage), webGrantFile(section))

      // 第二趟（＝关掉再开）：读得懂，那条授权生效 ⇒ **一次都不问**
      //
      // ⚠️ 这一条必须是**按域名**那一条授权（U76）：拿判轻的调用验「长期放行回来」是**空话**
      // ——判轻的本就默认通，不问不是那条授权的功劳。取网页判重，默认通放不了它，
      // 故这里那次 `auto` **只可能**来自刚读回来的那一条。
      const fixed = stage.assemble({
        grantsFile: grantsPathOf(stage),
        turns: [WEB_TURN, { text: '好' }],
      })
      expect(fixed.grantsUnreadable).toBeUndefined()
      expect(fixed.notices).toEqual([])

      const shell = bareShell(fixed)
      shell.send({ type: 'input.submit', text: '再跑一下' })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '跑完')

      expect(shell.requests).toEqual([])
      expect(eventsOfKind(shell.events, 'tool.decision').map((event) => event.data.decider)).toEqual([
        'auto',
      ])

      shell.dispose()
      fixed.close()
    } finally {
      stage.dispose()
    }
  })

  test('**会话中途**文件才坏掉——那一跳现读现发现，此后本次会话不再写它', async () => {
    const stage = makeStage()
    try {
      const section = sectionKeyOf(stage)
      const path = grantsPathOf(stage)
      mkdirSync(dirname(path), { recursive: true })
      // 起点是**好的**，且那条授权**够不着**下面要跑的那一件——故它照旧过闸，
      // 才有「按 `a` ⇒ 落盘」这一跳可看。
      // ⚠️ U76 之后有两重够不着：工具名对不上（`ls` × `exec`），且**删除这一类本就不授权**
      // ——即便那条授权写的是 `exec`，判重的执行命令也放不了（`gate.ts` 的放行判据只有
      // 「判轻」与「判重却带域名」两条）。
      writeFileSync(path, validGrants(section, 'ls'))

      const assembly = stage.assemble({
        grantsFile: path,
        turns: [DELETE_TURN, { text: '好' }],
      })
      expect(assembly.grantsUnreadable).toBeUndefined()

      // 会话开着的时候，外面把它写坏了（另一个编辑器 / 掉电）
      const broken = writeTruncated(stage, section)

      const shell = bareShell(assembly)
      shell.send({ type: 'input.submit', text: '跑一下' })
      await until(() => shell.requests.length >= 1, '过闸')
      shell.answer(shell.requests[0] as number, { remember: true })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '跑完')

      // 这一趟发现它读不懂了：立起闸（此后不再写），**盘上那份一字未动**
      expect(assembly.grantsUnreadable).toBeDefined()
      expect(bytesOf(path).equals(Buffer.from(broken, 'utf8'))).toBe(true)

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
