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

import type { Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage, type Stage } from './support.ts'

/**
 * 一条**判重的**执行命令（名单第一类 · 删除）——本文件要的是「过闸 → 人批 → 试图落盘」
 * 那一跳，**只有判重的调用才有卡可答**（U76 起判轻的默认通、根本不问）。
 */
const DELETE_TURN = { toolCalls: [{ name: 'exec', args: { cmd: 'chmod 755 .' } }] }

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
      const said = (await assembly.notices())

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
      expect((await assembly.notices())).toEqual(said)

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
      // ⚠️ U77 起夹具是**改权限**（删除那一类不给授权了）——记的就是这一类
      expect(remembered[0]).toContain('system')

      shell.dispose()
      assembly.close()

      // **但不落盘**：盘上那份还是原来那串被截断的字节，一个字节都没动
      expect(bytesOf(grantsPathOf(stage)).equals(Buffer.from(before, 'utf8'))).toBe(true)
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
