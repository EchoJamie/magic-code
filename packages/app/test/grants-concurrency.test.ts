/**
 * U47 · **授权文件的并发前置**——「多个执行者同时改同一份 `grants.json`」收成四条判据。
 *
 * 收的是原先那一格「最后落盘的那个赢（**已知限度**）」：那在单进程下不显形，但多执行者
 * 一上来就不成立——**撤销失灵**是其中最重的一件（撤销是安全动作，被旧账本写回来＝用户
 * 以为自己撤掉了，其实没有）。
 *
 * 主判据四条：
 * - **不互相覆盖**——两个各持旧账本的写入者，后写的那一份把前一份的改动**留着**；
 * - **跨 dataDir**——不同数据目录共用同一份文件时同上（锁键是**文件路径**，与 dataDir 无关）；
 * - **撤销不得被复活**——撤销之后，持旧账本的那一方再写、以及它收尾时补落记账，都不把
 *   撤掉的那条写回来；
 * - **真进程并发**——N 个进程各改 M 次，一条不少（`grants-writer.ts`）。
 *
 * 另有锁本身的三条（`acquireLock` 的对外契约，`LOCK_*` 那几个常量是它的参数）：
 * **有界等待并给出具体原因**（到点抛、理由里带着锁文件与持有者）· 锁键按**规范化文件路径**
 * （同一份文件的两个写法锁在同一把锁上）· **残骸自己清掉**（主儿已不在，不把授权永久卡死）；
 * 外加失败方向的一条：**写不成的那一次攒到下一次**，不是丢了。
 *
 * 走**真配置加载器**与**真闸门**——只有模型是替身；`grantsFile` 指到沙地里（不碰真的
 * `~/.magic`）。除「真进程并发」外都在同一进程里确定性复现（「旧账本」是**内存事实**，
 * 不必真并发）；那一条非要真进程——它是「锁」本身在被测。
 */

import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { Command, KernelEvent } from '@magic/contracts'
import type { Grant } from '@magic/permission'
import type { Assembly } from '../src/index.ts'
import { commitGrants } from '../src/grants-file.ts'
import { eventsOfKind, makeStage, type Stage } from './support.ts'

/** 一条只读命令——机械分析判「轻」（`ops: ['read']`），故「总是允许」对它开放。 */
const READ_ONLY_TURN = { toolCalls: [{ name: 'exec', args: { cmd: 'echo hello-magic' } }] }
/** 工具与上一条**不同**的那一条——两次「总是允许」凝出的规则才不是同一条。 */
const OTHER_TOOL_TURN = { toolCalls: [{ name: 'ls', args: { path: '.' } }] }

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
type StoredFile = {
  readonly version: number
  readonly workspaces: Record<string, readonly Grant[]>
}

/** 读**盘上**那份授权文件——不是读内存里的账本（判据就在这一句）。 */
function stored(path: string): StoredFile {
  return JSON.parse(readFileSync(path, 'utf8')) as StoredFile
}

/** 手写一份授权文件（要「启动时账本里就有 G1」时用）。 */
function writeGrants(path: string, file: unknown): void {
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

/** 跑一轮：装配 → 提交一句 → 等闸门问。 */
async function askOnce(
  stage: Stage,
  turns: readonly unknown[],
  grantsFile: string,
): Promise<{ assembly: Assembly; shell: ReturnType<typeof bareShell> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const assembly = stage.assemble({ grantsFile, turns: turns as any })
  const shell = bareShell(assembly)
  assembly.shell.send({ type: 'input.submit', text: '跑一下' })
  await until(() => shell.requests.length >= 1, '闸门问了一次')

  return { assembly, shell }
}

/** 按一次「总是允许」并等它真的跑完（＝账本那一跳已经走完、盘已经落过）。 */
async function allowOnce(
  stage: Stage,
  turns: readonly unknown[],
  grantsFile: string,
): Promise<{ assembly: Assembly; shell: ReturnType<typeof bareShell> }> {
  const opened = await askOnce(stage, turns, grantsFile)
  opened.shell.answer(opened.shell.requests[0] as number, { remember: true })
  await until(() => eventsOfKind(opened.shell.events, 'tool.result').length >= 1, '工具跑完')

  return opened
}

/**
 * 跑一轮**不弹卡**的（已授权的工具被自动放行）——「持旧账本的那一方跑过一趟」用它。
 *
 * 与 `allowOnce` 的差别只在等什么：这条路上**没有** `tool.decision.request` 可等
 * （闸门没问），等它＝等一个永远不来的东西。
 */
async function runOnce(
  stage: Stage,
  turns: readonly unknown[],
  grantsFile: string,
): Promise<{ assembly: Assembly; shell: ReturnType<typeof bareShell> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const assembly = stage.assemble({ grantsFile, turns: turns as any })
  const shell = bareShell(assembly)
  assembly.shell.send({ type: 'input.submit', text: '跑一下' })
  await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '工具跑完')

  return { assembly, shell }
}

describe('U47 · 授权文件：多个写入者不互相覆盖', () => {
  test('各持旧账本的两个装配——后写的那一份**留着**前一份的改动', async () => {
    const stage = makeStage()
    try {
      const path = grantsPathOf(stage)
      // **两条都先装配**（此刻盘上还什么都没有）——于是两边手上的账本都是「空」，
      // 这正是并发里的那个起点：谁都不知道对方后来写了什么。
      const first = await askOnce(stage, [READ_ONLY_TURN, { text: '好' }], path)
      const second = await askOnce(stage, [OTHER_TOOL_TURN, { text: '好' }], path)

      first.shell.answer(first.shell.requests[0] as number, { remember: true })
      await until(() => eventsOfKind(first.shell.events, 'tool.result').length >= 1, '第一条跑完')

      const section = first.assembly.workspaceRoots[0] as string
      expect(stored(path).workspaces[section]?.map((grant) => grant.tool)).toEqual(['exec'])

      second.shell.answer(second.shell.requests[0] as number, { remember: true })
      await until(() => eventsOfKind(second.shell.events, 'tool.result').length >= 1, '第二条跑完')

      // **两条都在**——旧实现（整份快照覆写）到这儿只剩 `ls` 那一条
      expect(stored(path).workspaces[section]?.map((grant) => grant.tool).sort()).toEqual([
        'exec',
        'ls',
      ])

      first.shell.dispose()
      second.shell.dispose()
      first.assembly.close()
      second.assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**不同 dataDir 共用同一份 `grants.json`**——各写各的节，两边都在', async () => {
    const here = makeStage()
    const there = makeStage()
    try {
      // 两个沙地＝两个数据目录、两个工作区（分节键也不同），但**指同一份授权文件**
      const path = grantsPathOf(here)
      const first = await askOnce(here, [READ_ONLY_TURN, { text: '好' }], path)
      const second = await askOnce(there, [OTHER_TOOL_TURN, { text: '好' }], path)

      first.shell.answer(first.shell.requests[0] as number, { remember: true })
      await until(() => eventsOfKind(first.shell.events, 'tool.result').length >= 1, '第一条跑完')

      second.shell.answer(second.shell.requests[0] as number, { remember: true })
      await until(() => eventsOfKind(second.shell.events, 'tool.result').length >= 1, '第二条跑完')

      // 两个工作区各一节——旧实现到这儿只剩后写的那一节（前面那个数据目录的授权**没了**）
      const sections = Object.keys(stored(path).workspaces).sort()
      const mine = [
        first.assembly.workspaceRoots[0] as string,
        second.assembly.workspaceRoots[0] as string,
      ].sort()
      expect(sections).toEqual(mine)

      first.shell.dispose()
      second.shell.dispose()
      first.assembly.close()
      second.assembly.close()
    } finally {
      here.dispose()
      there.dispose()
    }
  })
})

describe('U47 · 授权文件：撤销不得被复活', () => {
  test('撤掉之后，持旧账本的那一方再写 ＋ 收尾补落记账——**都不把那条写回来**', async () => {
    const stage = makeStage()
    try {
      const path = grantsPathOf(stage)
      const section = sectionKeyOf(stage)
      const gone: Grant = { tool: 'exec', op: ['read'], grantedAt: 1 }
      writeGrants(path, { version: 1, workspaces: { [section]: [gone] } })

      // 持有 G1 的装配：装配完就跑一轮（G1 命中 → **自动放行**，攒下一笔命中记账等收尾补落）
      const held = await runOnce(stage, [READ_ONLY_TURN, { text: '好' }], path)
      expect(held.shell.requests).toEqual([]) // 没问＝真的是授权命中那条路
      expect(stored(path).workspaces[section]?.map((grant) => grant.tool)).toEqual(['exec'])

      // **另一处撤掉它**（并发的第二个写入者——走的就是落盘那一跳）
      commitGrants(path, [{ kind: 'revoke', workspace: section, index: 0, rule: gone }])
      expect(stored(path).workspaces[section]).toBeUndefined()

      // 持旧账本的那一方**再写一次**（换一条规则）——它内存里那条 G1 不许跟着回来
      const again = await allowOnce(stage, [OTHER_TOOL_TURN, { text: '好' }], path)
      expect(stored(path).workspaces[section]?.map((grant) => grant.tool)).toEqual(['ls'])

      // 收尾（把攒着的命中记账补落）——旧实现到这儿会拿**整份快照**把 G1 写回来
      held.shell.dispose()
      held.assembly.close()
      again.shell.dispose()
      again.assembly.close()

      expect(stored(path).workspaces[section]?.map((grant) => grant.tool)).toEqual(['ls'])
    } finally {
      stage.dispose()
    }
  })
})

describe('U47 · 授权文件：真进程并发（锁本身在这里被测）', () => {
  /** 几个写入者同时改。四个×六十次＝两百四十次读改写，全挤在同一个窗口里。 */
  const WRITERS = 4
  const EDITS = 60

  test('各改各的，落定之后**一条不少**', async () => {
    const stage = makeStage()
    try {
      const path = grantsPathOf(stage)
      const workspace = sectionKeyOf(stage)
      const go = join(stage.root, 'go')
      const writers = Array.from({ length: WRITERS }, (_, index) => {
        const who = `w${index}`
        const ready = join(stage.root, `ready-${who}`)
        const proc = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, 'grants-writer.ts'),
            path,
            workspace,
            who,
            String(EDITS),
            ready,
            go,
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        return { proc, ready, who }
      })

      // 报到是有界等待；中途死了的当场报出来（不然一次崩溃会看着像「慢」）
      const deadline = Date.now() + 30_000
      while (writers.some((writer) => !existsSync(writer.ready))) {
        for (const writer of writers) {
          if (writer.proc.exitCode === null) continue
          throw new Error(
            `${writer.who} 没报到就退出了（码 ${writer.proc.exitCode}）：` +
              `${await new Response(writer.proc.stderr).text()}`,
          )
        }
        if (Date.now() > deadline) throw new Error('等不到写入者报到')
        await Bun.sleep(5)
      }
      writeFileSync(go, '')

      for (const writer of writers) {
        const stdout = new Response(writer.proc.stdout).text()
        const code = await writer.proc.exited
        const out = await stdout
        const err = await new Response(writer.proc.stderr).text()
        if (code !== 0) throw new Error(`${writer.who} 退出码 ${code}：${err || out}`)
      }

      // **一条不少**：后写的那些若拿自己那份旧账本覆写，这里就会少（少多少看相撞几次）
      const grants = stored(path).workspaces[workspace] ?? []
      const names = new Set(grants.map((grant) => grant.path))
      expect(grants).toHaveLength(WRITERS * EDITS)
      expect(names.size).toBe(WRITERS * EDITS)

      // 四条写者各来六十条，一条不错位（不只是「总数对」——谁的那一条也得在）
      for (let index = 0; index < WRITERS; index += 1) {
        const mine = grants.filter((grant) => grant.path?.startsWith(`w-w${index}/`))
        expect(mine).toHaveLength(EDITS)
      }
    } finally {
      stage.dispose()
    }
  }, 120_000)

  test('拿不到锁**有界等待**并给出具体原因——不静默失败、不无限等', () => {
    const stage = makeStage()
    try {
      const path = grantsPathOf(stage)
      const lock = `${path}.lock`
      mkdirSync(dirname(path), { recursive: true })
      // 别人正握着（刚建的＝不旧，不会被当残骸清掉）——本轮应当等一会儿之后**响亮地**失败
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }))

      const started = Date.now()
      let thrown: Error | undefined
      try {
        commitGrants(path, [
          { kind: 'grant', workspace: '/work/w', grant: { tool: 'exec', grantedAt: 1 } },
        ])
      } catch (error) {
        thrown = error as Error
      }
      const waited = Date.now() - started

      const said = thrown?.message ?? ''
      expect(said).toContain('独占锁') // 说清卡在哪儿
      expect(said).toContain(lock) // 哪一把锁
      expect(said).toContain(String(process.pid)) // 谁握着
      expect(waited).toBeGreaterThanOrEqual(1_000) // 真的等了
      expect(waited).toBeLessThan(5_000) // **有界**，不是无限等
      expect(existsSync(path)).toBe(false) // 没写成（不静默地写一半）
    } finally {
      stage.dispose()
    }
  }, 30_000)

  test('锁键是**规范化文件路径**——同一份文件的两个写法锁在同一把锁上', () => {
    const stage = makeStage()
    try {
      const path = grantsPathOf(stage)
      mkdirSync(dirname(path), { recursive: true })

      // 同一个目录的**另一个写法**：绕一条符号链接（沙地路径在 macOS 上本来就还有一层
      // `/var` → `/private/var`——这条链不走符号链接也一样存在）
      const alias = join(stage.root, 'link')
      symlinkSync(dirname(path), alias)

      // 锁按**规范化**路径落（文件还不存在，故规范到「目录的 realpath ＋ 文件名」）
      const lock = `${join(realpathSync(dirname(path)), 'grants.json')}.lock`
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }))

      // 从**另一个写法**进来——字符串上完全是两个路径，锁的却是同一把
      let thrown: Error | undefined
      try {
        commitGrants(join(alias, 'grants.json'), [
          { kind: 'grant', workspace: '/work/w', grant: { tool: 'exec', grantedAt: 1 } },
        ])
      } catch (error) {
        thrown = error as Error
      }

      expect(thrown?.message).toContain('独占锁') // 撞上了同一把锁（字符串不同，锁相同）
      expect(existsSync(path)).toBe(false) // 于是没写成
    } finally {
      stage.dispose()
    }
  }, 30_000)

  test('写不成的那一次**不丢**——下一次落盘把它一并带上', async () => {
    const stage = makeStage()
    try {
      const path = grantsPathOf(stage)
      mkdirSync(dirname(path), { recursive: true })
      const lock = `${path}.lock`
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }))

      // 一趟脚本两轮：第一轮的授权写不成（盘被锁着），第二轮换一条规则再写
      const assembly = stage.assemble({
        grantsFile: path,
        turns: [READ_ONLY_TURN, { text: '好' }, OTHER_TOOL_TURN, { text: '好' }] as never,
      })
      const shell = bareShell(assembly)

      shell.send({ type: 'input.submit', text: '第一轮' })
      await until(() => shell.requests.length >= 1, '第一次问')
      shell.answer(shell.requests[0] as number, { remember: true })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '第一轮跑完')

      expect(existsSync(path)).toBe(false) // 没写成——按 `a` 那一下被锁挡住了

      rmSync(lock, { force: true }) // 对面放开了

      shell.send({ type: 'input.submit', text: '第二轮' })
      await until(() => shell.requests.length >= 2, '第二次问')
      shell.answer(shell.requests[1] as number, { remember: true })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 2, '第二轮跑完')

      // **第一轮那条也在**——没写成的攒到了下一次，不是丢了
      const section = assembly.workspaceRoots[0] as string
      expect(stored(path).workspaces[section]?.map((grant) => grant.tool).sort()).toEqual([
        'exec',
        'ls',
      ])

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  }, 30_000)

  test('残骸锁（主儿已经不在了）**自己清掉**——不把授权永久卡死', async () => {
    const stage = makeStage()
    try {
      const path = grantsPathOf(stage)
      mkdirSync(dirname(path), { recursive: true })

      // 一个**真死掉**的 pid（起一个就走的进程——不拿一个猜的大数当「死」）
      const gone = Bun.spawn([process.execPath, '-e', ''])
      await gone.exited

      const lock = `${join(realpathSync(dirname(path)), 'grants.json')}.lock`
      writeFileSync(lock, JSON.stringify({ pid: gone.pid, at: Date.now() - 60_000 }))
      const old = new Date(Date.now() - 60_000)
      utimesSync(lock, old, old) // 也很久没动过了——两个条件齐

      commitGrants(path, [
        { kind: 'grant', workspace: '/work/w', grant: { tool: 'exec', grantedAt: 1 } },
      ])

      expect(stored(path).workspaces['/work/w']).toHaveLength(1)
      expect(existsSync(lock)).toBe(false) // 清掉了，没留在盘上
    } finally {
      stage.dispose()
    }
  }, 30_000)
})
