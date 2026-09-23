/**
 * D10 · 内核给三样读数 —— **验收判据**（全链 · 经真控制面）。
 *
 * 出处：`缺陷/D10 外壳要、内核没给的三样读数`。每一条锚一句「**我要什么**」：
 *
 * 1. **上下文窗口总量**——状态行 `12.4k/200k` 的**分母**从内核来：
 *    `providers.<id>.contextWindow` 声明了，就**随 `model.usage` 一起到**（同一次调用、
 *    同一刻）；没声明，这一位**就不在**（外壳显示不出分母就不显示——**不编**）。
 * 2. **重试上限**——`model.retry` 的 `attempt` 旁边必须有**上限**：策略里是多少就是多少
 *    （外壳不必自钉一个常量——这正是 `D10` 报的「`RETRY_MAX = 3` 是编的」）。
 * 3. **模型条目表**——`/model` 一次拿到**注册表全量**（**不只见过的**）＋「当前是哪条」；
 *    读面**不落库**；**空手打开**（D4：启动＝还没有会话）也照答，且**不落账**（D5）。
 *
 * 这一层钉的是**全链**：真配置 · 真注册表 · 真取件层 · 真归一 · 真对话域 · 真记录域 ·
 * 真控制面（命令进、事件出）——只有端点换成假的（`modelFetch` 回放 SSE）。
 * 域内那半（窗长怎么从配置进事件、上限怎么从策略进信号）钉在 `@magic/model` 的用例里。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EventStamper, KernelEvent, ModelGateway } from '@magic/contracts'
import { createFauxGateway } from '@magic/faux'
import { assemble, attachShell, loadConfig } from '../src/index.ts'
// 接线取件（照 `model-switch.test.ts` 取 `scriptOptions` 的先例）——不是写着同样内容的字面量
import { tuiOptions } from '../src/cli.ts'
import type { Assembly } from '../src/index.ts'
import { readDatabase } from './support.ts'
import { magicAt, removeDir, tempDir, validConfig, writeConfig } from './tmp.ts'

// ═══════════════════════════════════════════════════════════════════════
// 夹具 —— 两个条目（**甲声明了窗长、乙没声明**——两形对照），端点换假的
// ═══════════════════════════════════════════════════════════════════════

const ALPHA_KEY = 'sk-alpha-abcdefghijklmnop'
const BETA_KEY = 'sk-beta-abcdefghijklmnop'

const PROVIDERS = {
  alpha: {
    baseURL: 'https://alpha.example/v1',
    apiKey: ALPHA_KEY,
    model: 'alpha-1',
    contextWindow: 200_000,
  },
  beta: { baseURL: 'https://beta.example/v1', apiKey: BETA_KEY, model: 'beta-1' },
}

/** 一次回复的帧（OpenAI 兼容片；`usage` 那一帧只在收尾发——SDK 的 `include_usage`）。 */
function frame(model: string, payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model,
    ...payload,
  })}\n\n`
}

/** 假端点：一路顺风，**每次都回用量**（判据 1 的分子）。第 n 次调用的数按 n 递进，便于分辨。 */
function endpoint(): typeof globalThis.fetch {
  let calls = 0

  return (async () => {
    calls += 1
    const model = calls === 1 ? 'alpha-1' : 'beta-1'

    return new Response(
      frame(model, { choices: [{ index: 0, delta: { role: 'assistant', content: `第 ${calls} 答` } }] }) +
        frame(model, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
        frame(model, {
          choices: [],
          usage: { prompt_tokens: 11 * calls, completion_tokens: 5, total_tokens: 11 * calls + 5 },
        }) +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as unknown as typeof globalThis.fetch
}

/** 头一次限流（429）、之后顺风——退避重试的现场（判据 2）。 */
function throttledOnce(): typeof globalThis.fetch {
  let calls = 0

  return (async () => {
    calls += 1
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limit reached' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    }

    return new Response(
      frame('alpha-1', { choices: [{ index: 0, delta: { role: 'assistant', content: '重试之后成了' } }] }) +
        frame('alpha-1', { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as unknown as typeof globalThis.fetch
}

/** 一块沙地：真配置（两条目）＋ 真工作区根 ＋ 真数据目录，端点换假的。 */
function stage(): {
  readonly root: string
  readonly workspace: string
  readonly configPath: string
  assemble(options?: {
    readonly modelFetch?: typeof globalThis.fetch | undefined
    readonly modelGateway?: ((stamper: EventStamper) => ModelGateway) | undefined
  }): Assembly
  dispose(): void
} {
  const root = tempDir('magic-readouts-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace, { recursive: true })

  const configPath = writeConfig(
    root,
    validConfig({ dataDir: join(root, 'data'), defaultProvider: 'alpha', providers: PROVIDERS }),
  )

  return {
    root,
    workspace,
    configPath,
    assemble(options = {}): Assembly {
      const { modelFetch, modelGateway } = options
      return assemble({
        cwd: workspace,
        config: loadConfig({ path: configPath, magic: magicAt(root) }),
        magic: magicAt(root),
        prompt: { platform: 'darwin', date: '2026-09-19' },
        ...(modelFetch === undefined ? {} : { modelFetch }),
        ...(modelGateway === undefined ? {} : { modelGateway }),
      })
    },
    dispose: () => removeDir(root),
  }
}

/** 某 kind 的事件（判别联合照收）。 */
function eventsOfKind<K extends KernelEvent['kind']>(
  events: readonly KernelEvent[],
  kind: K,
): Extract<KernelEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<KernelEvent, { kind: K }> => event.kind === kind)
}

/**
 * 问一次「都有哪些条目」，拿答复。
 *
 * **先架等、后发命令**——控制面是同步的：命令一进去，答复当步就回来了，
 * 事后再 `until` 只会等一个不会重来的事件。
 */
async function askCatalog(handle: {
  send(command: { readonly type: 'model.list' }): void
  until(test: (event: KernelEvent) => boolean, timeoutMs?: number): Promise<KernelEvent>
}): Promise<Extract<KernelEvent, { kind: 'model.catalog' }>> {
  const armed = handle.until((event) => event.kind === 'model.catalog')
  handle.send({ type: 'model.list' })

  const event = await armed
  if (event.kind !== 'model.catalog') throw new Error(`等来的不是条目表：${event.kind}`)
  return event
}

// ═══════════════════════════════════════════════════════════════════════
// 判据 1 · 上下文窗口总量：分母跟着分子走
// ═══════════════════════════════════════════════════════════════════════

describe('读数 1 · 上下文窗口总量', () => {
  test('声明了窗长的条目：`model.usage` 上带着那个分母（同一次调用、同一刻）', async () => {
    const land = stage()

    try {
      const assembly = land.assemble({ modelFetch: endpoint() })
      const handle = attachShell(assembly.shell)

      await handle.submit('嗨')

      // 走的是甲（缺省条目）——它声明了 200k
      expect(eventsOfKind(handle.events, 'model.call.start').map((e) => e.data.provider)).toEqual([
        'alpha',
      ])
      expect(eventsOfKind(handle.events, 'model.usage').map((e) => e.data)).toEqual([
        { inputTokens: 11, outputTokens: 5, contextWindow: 200_000 },
      ])

      handle.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('没声明窗长的条目：这一位**就不在**（拿不到就不显示，不编）', async () => {
    const land = stage()

    try {
      const assembly = land.assemble({ modelFetch: endpoint() })
      const handle = attachShell(assembly.shell)

      await handle.submit('嗨')
      // 换到乙——配置里**没有** `contextWindow`
      expect(assembly.switchModel({ provider: 'beta' })).toEqual({
        ok: true,
        selection: { provider: 'beta', model: 'beta-1' },
      })
      await handle.submit('再来一句')

      expect(eventsOfKind(handle.events, 'model.call.start').map((e) => e.data.provider)).toEqual([
        'alpha',
        'beta',
      ])

      const usages = eventsOfKind(handle.events, 'model.usage').map((e) => e.data)
      expect(usages).toHaveLength(2)
      // 甲那份带着分母、乙那份**连键都没有**（不是 `undefined` 占位，是缺席）
      expect(usages[0]).toEqual({ inputTokens: 11, outputTokens: 5, contextWindow: 200_000 })
      expect(usages[1]).toEqual({ inputTokens: 22, outputTokens: 5 })
      expect('contextWindow' in (usages[1] ?? {})).toBe(false)

      handle.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 判据 2 · 重试上限：跟着策略走，外壳不必自钉常量
// ═══════════════════════════════════════════════════════════════════════

describe('读数 2 · 重试上限', () => {
  test('`model.retry` 报得出 `2/3` 的分子**和**分母——分母出自策略，不是外壳钉的', async () => {
    const land = stage()

    try {
      const assembly = land.assemble({ modelFetch: throttledOnce() })
      const handle = attachShell(assembly.shell)

      // ⚠️ 这一轮真等 800ms（缺省策略的退避步长）——装配没开口子注 `sleep`，
      // 如实等；换来的是「上限真的从策略走到了外壳」这条判据。
      await handle.submit('嗨')

      expect(eventsOfKind(handle.events, 'model.retry').map((e) => e.data)).toEqual([
        { attempt: 2, delayMs: 800, maxAttempts: 3, tier: 'transient' },
      ])
      // 重试过但内核只看见一次干净调用（内容不重复）——与 U17 的裁断一致
      expect(eventsOfKind(handle.events, 'model.call.start')).toHaveLength(1)
      expect(eventsOfKind(handle.events, 'message.assistant')).toHaveLength(1)

      handle.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 判据 3 · 模型条目表：全量 ＋ 当前那条
// ═══════════════════════════════════════════════════════════════════════

describe('读数 3 · 模型条目表', () => {
  test('`model.list` → 注册表**全量**（含从没调用过的那条）＋ 当前是哪条', async () => {
    const land = stage()

    try {
      const assembly = land.assemble({ modelFetch: endpoint() })
      const handle = attachShell(assembly.shell)

      await handle.submit('嗨')

      const catalog = await askCatalog(handle)
      // **乙一次都没调用过**，照样在表里——这正是「全量」与「见过的」之分
      expect(catalog.data.entries).toEqual([
        { provider: 'alpha', model: 'alpha-1', contextWindow: 200_000 },
        { provider: 'beta', model: 'beta-1' },
      ])
      expect(catalog.data.current).toEqual({ provider: 'alpha', model: 'alpha-1' })
      expect(catalog.data.note).toBeUndefined()

      // 换过之后，「当前」跟着走
      expect(assembly.switchModel({ provider: 'beta' }).ok).toBe(true)
      const afterSwitch = await askCatalog(handle)
      expect(afterSwitch.data.current).toEqual({ provider: 'beta', model: 'beta-1' })
      expect(afterSwitch.data.entries).toEqual(catalog.data.entries)

      handle.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('同条目换到别的模型：`current` 跟着换（表里那一行的默认模型不动）', async () => {
    const land = stage()

    try {
      const assembly = land.assemble({ modelFetch: endpoint() })
      const handle = attachShell(assembly.shell)

      expect(assembly.switchModel({ model: 'beta-x' }).ok).toBe(true)

      const catalog = await askCatalog(handle)
      // 选中**未必是表里的某一行**——表说的是「每条目默认用谁」，选中说的是「此刻用谁」
      expect(catalog.data.current).toEqual({ provider: 'alpha', model: 'beta-x' })
      expect(catalog.data.entries).toEqual([
        { provider: 'alpha', model: 'alpha-1', contextWindow: 200_000 },
        { provider: 'beta', model: 'beta-1' },
      ])

      handle.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('空手打开（还没有会话）也照答——且**不落账**（不铸 id、不占存储）', async () => {
    const land = stage()

    try {
      const assembly = land.assemble({ modelFetch: endpoint() })
      // 空手：一条会话都没有（D4：启动＝新会话，首条消息才开张）
      expect(assembly.session).toBeUndefined()

      const handle = attachShell(assembly.shell)
      const catalog = await askCatalog(handle)

      expect(catalog.data.entries).toHaveLength(2)
      expect(catalog.data.current).toEqual({ provider: 'alpha', model: 'alpha-1' })

      handle.dispose()
      assembly.close()

      // 「那一下开一张空壳」只为盖章——**空壳不落账**（sessions 表里一条都没有，
      // 目录因此塞不满空壳；D5）
      const db = readDatabase(assembly.paths.database)
      expect(db.sessions).toEqual([])
      db.close()
    } finally {
      land.dispose()
    }
  })

  test('读面**不落库**——`/model` 问几次，事件表里都不留痕', async () => {
    const land = stage()

    try {
      const assembly = land.assemble({ modelFetch: endpoint() })
      const handle = attachShell(assembly.shell)

      await handle.submit('嗨')
      await askCatalog(handle)
      await askCatalog(handle)

      handle.dispose()
      assembly.close()

      const db = readDatabase(assembly.paths.database)
      const kinds = db.events.map((event) => event.kind)
      // 答复确实来过（在事件流里）……
      expect(handle.events.filter((event) => event.kind === 'model.catalog')).toHaveLength(2)
      // ……但库里一个字都没有（读出来的东西不落库——照 `session.history` 的裁断）
      expect(kinds).not.toContain('model.catalog')
      db.close()
    } finally {
      land.dispose()
    }
  })

  test('没有注册表的那次装配：空表 ＋ 一句说明（不冒充「一条都没有」）', async () => {
    const land = stage()

    try {
      const assembly = land.assemble({
        modelGateway: (stamper) => createFauxGateway({ stamper, turns: [] }),
      })
      const handle = attachShell(assembly.shell)

      const catalog = await askCatalog(handle)
      expect(catalog.data.entries).toEqual([])
      expect(catalog.data.note).toContain('注册表')
      expect(catalog.data.current).toBeUndefined()

      handle.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 判据 1 的**开机那一跳**（U20 留的位 · U21 接上）
// ═══════════════════════════════════════════════════════════════════════
//
// 上面那一组钉的是「分母**经事件**到外壳」；这一组钉的是**另一条来路**——
// 用户还没跑过 `/model` 的时候，分母从**配置**直接进 `runTui`（`cli.ts` 的 `tuiOptions`）。
//
// **为什么必须有这一条**：`model.catalog` 只有 `/model` 会触发，故开机那一刻 ④ 是个光杆
// 分子（`3.1k`）。用户要的是 `3.1k/200k` 一开局就在。
//
// ⚠️ **判据取件、不复述**（缺陷 D16 那笔账）：接线只有 `cli.ts` 里那一跳，
// 用例要是自己「照同样方式接一遍」，倒回那一跳照样绿。故从 `tuiOptions` **取件**。
//
// ⚠️ **不能改成「开机发一次 `model.list`」**：装配的 `listModels` 在没会话时会
// `session.new`（要开一张空壳才盖得出信封），与 D5「空手打开不占存储」相抵——
// 故分母只从配置读。

describe('读数 1 · ④ 的分母在**开机**那一刻就有', () => {
  test('缺省条目声明了窗长 ⇒ 起外壳的入参里带着它（不必等 `/model`）', () => {
    const land = stage()

    try {
      // 缺省＝alpha（夹具里它声明了 `contextWindow: 200_000`）
      const assembly = land.assemble({ modelFetch: endpoint() })

      expect(tuiOptions(assembly).contextWindow).toBe(200_000)

      assembly.close()
    } finally {
      land.dispose()
    }
  })

  /**
   * 换到**没声明**的那一条（beta）⇒ `null`。
   *
   * 两件一起咬住了：① 「没声明就不编」；② 读数是**当下**那一条的窗，不是装配那一刻的快照
   * （`--provider` / `--model` 就是开局先换再起外壳——快照会把缺省条目的数报成选中条目的）。
   *
   * ⚠️ 这一条钉的是**装配给的数**；屏幕那一侧（换过模型之后分母跟不跟得上、同名模型
   * 跨条目串不串味）是另一笔账，归 `window.test.ts`（U30）——**别拿这条当那边也验过了**。
   */
  test('换到没声明窗长的那条 ⇒ `null`（回退成只报已用量——不编一个总量出来）', () => {
    const land = stage()

    try {
      const assembly = land.assemble({ modelFetch: endpoint() })
      const switched = assembly.switchModel({ provider: 'beta' })
      expect(switched.ok).toBe(true)

      expect(tuiOptions(assembly).contextWindow).toBeNull()

      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('注册表缺席（替身网关）⇒ `null`（同「拿不到就不编」）', () => {
    const land = stage()

    try {
      const assembly = land.assemble({
        modelGateway: (stamper) => createFauxGateway({ stamper, turns: [] }),
      })

      expect(tuiOptions(assembly).contextWindow).toBeNull()

      assembly.close()
    } finally {
      land.dispose()
    }
  })
})
