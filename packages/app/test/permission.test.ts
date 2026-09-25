/**
 * 第 15 轮 · 阶段 2 波次 1 —— **端到端接线**的判据（装配根 × 权限域）。
 *
 * 两件都是「光看域内测试看不出来」的事：
 * - **`permissions.rules` 真的接进闸门了**吗——配置 → `parseRules` → `createPermissionGate`；
 *   接没接上，只有从装配跑一遍才看得见（权限域自己的测试注入的是现成规则数组）。
 * - **「总是允许」整条链通了吗**——外壳答复带 `remember` → 控制域原样转手 →
 *   装配递给闸门 → 工作区级账本生效（同类第二次不再问）。任何一跳断了，下面那两条就红。
 *
 * 走**真配置加载器**（`makeStage` 里的 `loadConfig`）与**真闸门**——只有模型是替身。
 *
 * ## ⚠️ U76 之后：只剩「带域名的那一类」还动得了（2026-09-25）
 *
 * 闸门换了底（`gate.ts` 头注那条链）：**默认通**——判轻的**不必先配规则**也不再弹卡；
 * 而**名单收缩到两条**（删除 · 改权限/属主/属性/ACL），那两类**任何规则与授权都放不出**
 * （名单即禁区）。两件事一起改变了本文件的**锚**：
 *
 * - 「不配规则就一律问」**不再是真的**（原第二例）——现在的真话是：判轻的照过、
 *   **名单那两条照问**；
 * - 规则／授权**唯一还够得着**的地方是**取网页**那一件（判重 · 外发 · **带域名**，
 *   `byHost` 是放行判据里仅存的规则口子）。故凡要「规则／授权真的改变了结果」的用例，
 *   夹的都是一发 `web_fetch`：`webSource` 注入替身、提炼那一跳走**环回夹具**
 *   （形制照 `web-fetch.test.ts`）——不这样的话，工具跑不出 `ok: true` 的结果。
 * - 只验「默认通」与「名单照问」的两件**不需要夹具**：一发只读命令 ＋ 一发 `rm` 就说得清。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent, PageFetch, WebSource } from '@magic/contracts'
import type { Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage } from './support.ts'
import { FAKE_API_KEY } from './ui/sandbox.ts'
import { startFixture } from './ui/fixture.ts'
import type { Fixture, FixtureTurn } from './ui/fixture.ts'

/** 一条只读命令（机械分析判「轻」、`ops: ['read']`）——**U76 起默认通**，不必配规则也不再弹卡。 */
const READ_ONLY_TURN = { toolCalls: [{ name: 'exec', args: { cmd: 'echo hello-magic' } }] }

/**
 * **名单里剩下那一条**（改权限）——不配规则也照问（名单即禁区），卡上那句判据是「系统级」。
 *
 * ⚠️ **U77 换的探针**：从前这里是**删除**（`rm -rf build`）；如今删除那一类
 * **直接拒、根本不问**（见下面 `REFUSED_TURN`），能造出"一张卡"的只剩改权限这一族。
 * 用 `chmod 755 .`（工作区目录本身）是**装置上的讲究**：它一定存在 ⇒ 命令跑得成
 * （`ok: true`），而 `755` 保留属主的 `rwx` ⇒ 不把后面几步走出毛病来。
 */
const GATED_TURN = { toolCalls: [{ name: 'exec', args: { cmd: 'chmod 755 .' } }] }

/** **删除那一类**——U77 起**直接拒**（不问、也没有卡），回执里指路 `trash`。 */
const REFUSED_TURN = { toolCalls: [{ name: 'exec', args: { cmd: 'rm -rf build' } }] }

/** 会话那一条连接上的模型（夹具回的话按请求里的名字记账——判据不看它，配置里得有）。 */
const SESSION_MODEL = 'MiniMax-M3'
/** 「取网页用的模型」——**另一条**（提炼那一跳走它，与会话那个不是同一个）。 */
const DISTILL_MODEL = 'distill-small'

/** 要取的那一页——**域名**那一格（`example.com`）正是规则与授权还够得着的东西。 */
const PAGE = 'https://example.com/a'
/** 提炼那一跳回的答案。 */
const ANSWER = '这一页说的是：example.com 这个域名专留作示例。'

/** 取网页那一发（**夹具剧本**形制：`kind: 'tool'`）——每次现造，免得两条用例共用同一个对象。 */
function fetchTurn(): FixtureTurn {
  return { kind: 'tool', name: 'web_fetch', args: { url: PAGE, prompt: '看什么' } }
}

/** 替身的取回面——记下被叫过的地址（真取网那一跳不出去）。 */
function fakeWeb(): WebSource & { readonly asked: string[] } {
  const asked: string[] = []

  return {
    asked,
    fetchPage: (url: string): Promise<PageFetch> => {
      asked.push(url)
      return Promise.resolve({
        ok: true,
        url,
        status: 200,
        bytes: 64,
        body: '<html><body><p>这一页说的是：example.com 这个域名专留作示例。</p></body></html>',
        contentType: 'text/html',
      })
    },
  }
}

/**
 * 一块接在受控端点上的沙地——**「取网页」那几件要真跑到提炼那一跳**（同 `web-fetch.test.ts`）。
 *
 * `webFetch` 那一格给了，那一件工具才走得到「取回 → 提炼 → 回执」（没配的话它当场收束，
 * 结果那是 `ok: false`——本文件第一条用例要的 `ok: true` 就出不来）。
 */
function stageOn(fixture: Fixture, options: { readonly rules?: readonly unknown[] } = {}) {
  return makeStage({
    config: {
      defaultProvider: 'local',
      providers: {
        local: { baseURL: fixture.baseURL, apiKey: FAKE_API_KEY, model: SESSION_MODEL },
      },
      webFetch: { provider: 'local', model: DISTILL_MODEL },
      ...(options.rules === undefined ? {} : { permissions: { rules: options.rules } }),
    },
  })
}

/**
 * 裸接控制面——订阅事件 ＋ **按需答复**。
 *
 * 不用 `attachShell`：它收到询问**当场自动批准**（验收装置的方便），答复那个窗口抓不住，
 * 「带不带 `remember`」也就无从谈起。这里要的正是那个窗口。
 */
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
    /** 答复一次询问——`remember` 给了就带上（与外壳按「总是允许」时发的**同一条消息**）。 */
    answer(id: number, opts?: { remember?: boolean }): void {
      assembly.shell.send({ type: 'decision.answer', id, decision: 'approve', ...opts })
    },
    dispose: off,
  }
}

/** 等条件成立（轮询——域是异步的，测试别假设时序）。 */
async function until(test: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(10)
  }
}

/**
 * 等这一轮**收束**（回到等待输入）。
 *
 * ⚠️ **收尾前要等它**：`agent.state{waiting}` 是这一轮**最后**一条事件，它之前落下来的
 * 都还在路上。夹具那几件（真模型链，字是一块一块流的）里，断言的锚到得比收束早得多，
 * 那时 `close()` 会让尾部的落账打进**已经关掉的库**（实测：报错落在下一条用例头上，
 * 看着像用例自己的毛病）。等到这里再收，才是「这一轮走完了」。
 */
async function untilSettled(shell: { readonly events: readonly KernelEvent[] }): Promise<void> {
  await until(
    () => eventsOfKind(shell.events, 'agent.state').some((event) => event.data.state === 'waiting'),
    '这一轮收束（回到等待输入）',
    20_000,
  )
}

describe('权限规则 —— 配置真的接进闸门', () => {
  /**
   * ⚠️ **加料由头（U76）**：原先把规则写在一条只读命令上（`{tool:'exec', op:'read'}`）——
   * 那条路如今**默认就通**，于是「没弹卡」不再能证明规则接上了（不配规则也不弹）。
   * 判据要的还是**规则真的改变了结果**，故挪到规则**唯一还够得着**的那一格上：
   * 取网页（判重 · 外发 · **带域名**）＋ 一条**写明域名**的规则。
   * ⚠️ **必闸禁区仍在**：写成 `{tool:'web_fetch'}`（不带域名）是**不命中**的
   * （`matchesHost`：这一次有域名时，没写域名的规则一律不命中）——规则放得动它，
   * 靠的正是「用户把往哪一家发**说出口**了」。
   */
  test('命中即自动放行——不问、裁者是 `auto`', async () => {
    const fixture = startFixture({
      model: SESSION_MODEL,
      turns: [fetchTurn(), { kind: 'text', text: ANSWER }, { kind: 'text', text: '好' }],
    })
    const stage = stageOn(fixture, { rules: [{ tool: 'web_fetch', host: 'example.com' }] })

    const web = fakeWeb()

    try {
      const assembly = stage.assemble({ modelGateway: undefined, webSource: web })

      // 装配侧先自证：规则经 `parseRules` 落了地（没被拒、条数对）
      expect(assembly.permissionRules).toEqual([{ tool: 'web_fetch', host: 'example.com' }])
      expect(assembly.rejectedRules).toEqual([])

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '跑一下' })
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '工具跑完')

      // 规则命中 ⇒ **闸门没问**（没有询问事件，自然也没有答复）
      expect(eventsOfKind(shell.events, 'tool.decision.request')).toEqual([])
      // 但裁决**照样留痕**——自动放行不是「没发生裁决」，是裁者是 `auto`
      const verdicts = eventsOfKind(shell.events, 'tool.decision')
      expect(verdicts.map((v) => [v.data.decision, v.data.decider])).toEqual([['approve', 'auto']])
      // 放行是真的：那一发**真跑到了结果**（取回 → 提炼 → 回执，`ok: true`），
      // 且**真取了一回**（放行不是空放——`webSource` 那一面被叫过一次，取的是那一个地址）
      expect(eventsOfKind(shell.events, 'tool.result')[0]?.data.ok).toBe(true)
      expect(web.asked).toEqual([PAGE])

      await untilSettled(shell)
      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
      await fixture.stop()
    }
    // 取网页那一轮要跑好几个来回（主轮 → 提炼 → 主轮）——`bun test` 缺省那 5 秒不够
  }, 30_000)

  /**
   * ⚠️ **原锚**：「键缺省 ＝ 无规则 ＝ **一律问**」（阶段 1 全人工门的姿态）。
   * **为何变**：U76 把链的底换了——**默认通**：判轻的不必配规则也不问。
   * ⚠️ **U77 又换了一次**：删除那一类从"要授权"整类移出、改成**直接拒**
   * ⇒ 能造出"一张卡"的只剩**改权限那一族**。
   * **新锚**：键缺省这一档下的**三半**各钉一下——判轻的**不问**（裁者 `auto`）、
   * **改权限照问**（名单里剩下那一条）、**删除照拒**（不问，也没跑）。三件一起看，
   * 才是现在的「无规则」。
   */
  test('键缺省 ＝ 无规则 ⇒ **默认通**：判轻的不问、改权限照问、删除照拒', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({
        turns: [READ_ONLY_TURN, GATED_TURN, REFUSED_TURN, { text: '完了' }],
      })
      expect(assembly.permissionRules).toEqual([])

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '跑三下' })
      await until(() => shell.requests.length >= 1, '改权限那一条问起')

      // 只问了改权限那一条——前一条只读命令**没弹卡**，它走的是 `auto`
      expect(shell.requests).toHaveLength(1)
      expect(eventsOfKind(shell.events, 'tool.decision').map((v) => v.data.decider)).toEqual(['auto'])

      // 问的那一条说得出凭什么（名单里只剩的那一类）
      const card = eventsOfKind(shell.events, 'tool.decision.request')[0]
      expect(card?.data.weight).toBe('heavy')
      expect(card?.data.material).toContain('改权限 · 属主 · 属性 / ACL（不可逆）')

      shell.answer(shell.requests[0] ?? -1)
      // 三发各有各的结局（第三发是**被拒**的那一条——它照样落一条 `tool.result`）
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 3, '三发都落定')

      // 三发各留各的痕：默认通的没人答过（`auto`）· 人答的那条 `user` ·
      // **被拒的那条也没有询问**（`auto` ＋ `reject`——见下面那条断言）
      expect(eventsOfKind(shell.events, 'tool.decision').map((v) => v.data.decider)).toEqual([
        'auto', // 判轻的：没问就**放行**
        'user', // 改权限：人答的
        'kernel', // 删除：没问就**拒**（⚠️ 不是 `auto`——那一格说的是「没问就放行」）
      ])

      const results = eventsOfKind(shell.events, 'tool.result')
      expect(results[2]?.data.ok, '删除那一条：**被拒、压根没跑**').toBe(false)
      const refusedText = (results[2]?.data.output as { text?: string } | undefined)?.text ?? ''
      expect(refusedText, '回执要说得出为什么').toContain('不可逆')
      expect(refusedText, '回执要指路').toContain('trash')

      await untilSettled(shell)
      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('被拒的规则条目**交回装配**（不静默丢弃——读不懂就不生效）', () => {
    const stage = makeStage({
      config: { permissions: { rules: [{ tool: 'exec', op: 'read' }, { tool: 'exec', pth: '/w' }] } },
    })

    try {
      const assembly = stage.assemble()

      expect(assembly.permissionRules).toEqual([{ tool: 'exec', op: 'read' }])
      expect(assembly.rejectedRules).toHaveLength(1)
      expect(assembly.rejectedRules[0]?.index).toBe(1) // 第 2 条（0 起）
      expect(assembly.rejectedRules[0]?.reason).toContain('pth')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('「总是允许」——全链（外壳答复 → 控制域 → 装配 → 授权账本）', () => {
  /**
   * ⚠️ **原锚**：「会话级记忆生效」——`a` 凝出的规则活在闸门实例里（新会话即清零）。
   * **为何变**：`U22` 把授权的落点改到**工作区**（技术方案 · 权限「授权的落点」：
   * 会话不是信任的边界）；闸门里那本账换成了注入的**工作区级账本**。
   * **新锚**：同一条链（答复带 `remember` → 控制域转手 → 装配 → 闸门）**仍然通**，
   * 只是记的地方跟着换——跨会话存活那一条在 `grants.test.ts` 里钉。
   *
   * ⚠️ **U76 又把夹具挪了一次**：授权如今**只放得出判重且带域名的那一类**
   * （`hit && byHost`）——原来那条只读命令的授权**一条都放不动**（每次都会照问），
   * 故「第二次不再问」只能落在**取网页**上：同一页取两遍，第一遍拨「总是允许」，
   * 第二遍由**域名那一条授权**自动放行。
   */
  test('答复带 `remember`：同类**第二次不再问**（授权落进工作区级账本）', async () => {
    const fixture = startFixture({
      model: SESSION_MODEL,
      turns: [
        // 主轮 1：要取那一页；接着是提炼那一跳回的答案
        fetchTurn(),
        { kind: 'text', text: ANSWER },
        // 主轮 2：**同一页再取一遍**——判据就在这一发上（它该被授权挡下，不再弹卡）
        fetchTurn(),
        { kind: 'text', text: ANSWER },
        // 主轮 3：收束
        { kind: 'text', text: '都看完了' },
      ],
    })
    const stage = stageOn(fixture)

    try {
      // 同一轮里两次**一模一样**的取网页：第一次要问，第二次该被记忆挡下
      const assembly = stage.assemble({ modelGateway: undefined, webSource: fakeWeb() })
      const shell = bareShell(assembly)

      assembly.shell.send({ type: 'input.submit', text: '同样的页面看两遍' })

      await until(() => shell.requests.length >= 1, '第一次询问')
      expect(shell.requests).toHaveLength(1)
      // 卡上写明了去向——「总是允许」记的**正是这一个域名**（没有域名就没有可记的授权）
      expect(eventsOfKind(shell.events, 'tool.decision.request')[0]?.data.host).toBe('example.com')

      // 外壳按「总是允许」时发的正是这一条（批准 ＋ remember 位）
      shell.answer(shell.requests[0] ?? -1, { remember: true })

      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 2, '两次都跑完')

      // 关键判据：**只问了那一次**——第二次没有再冒询问
      expect(shell.requests).toHaveLength(1)

      const verdicts = eventsOfKind(shell.events, 'tool.decision')
      expect(verdicts.map((v) => v.data.decider)).toEqual(['user', 'auto'])

      // 而它**真进了工作区级账本**（不是只在闸门里留了个印象）
      expect(assembly.grantsView().grants.map((row) => row.describe)).toEqual([
        '工具 web_fetch × 根内 × 操作 outbound × 域名 example.com',
      ])

      await untilSettled(shell)
      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
      await fixture.stop()
    }
  }, 30_000)

  test('不给 `remember` ＝ 一次性——同类第二次**照问**（向后兼容）', async () => {
    const fixture = startFixture({
      model: SESSION_MODEL,
      turns: [fetchTurn(), { kind: 'text', text: ANSWER }, fetchTurn(), { kind: 'text', text: ANSWER }, { kind: 'text', text: '都看完了' }],
    })
    const stage = stageOn(fixture)

    try {
      const assembly = stage.assemble({ modelGateway: undefined, webSource: fakeWeb() })
      const shell = bareShell(assembly)

      assembly.shell.send({ type: 'input.submit', text: '同样的页面看两遍' })

      await until(() => shell.requests.length >= 1, '第一次询问')
      shell.answer(shell.requests[0] ?? -1) // 与阶段 1 逐字同义的答复

      await until(() => shell.requests.length >= 2, '第二次仍然问起')
      expect(shell.requests).toHaveLength(2)
      shell.answer(shell.requests[1] ?? -1)

      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 2, '两次都跑完')

      expect(eventsOfKind(shell.events, 'tool.decision').map((v) => v.data.decider)).toEqual([
        'user',
        'user',
      ])

      // 没记就是没记——账本上一条都没有（下一次仍然照问）
      expect(assembly.grantsView().grants).toEqual([])

      await untilSettled(shell)
      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
      await fixture.stop()
    }
  }, 30_000)
})
