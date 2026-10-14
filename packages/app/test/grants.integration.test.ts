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
import { mkdirSync, writeFileSync } from 'node:fs'
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
