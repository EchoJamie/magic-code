/**
 * U17 · 运行时切换 —— **验收判据**：同一会话中途换到另一个供应商条目，
 * 上下文不丢、后续轮次走新模型。
 *
 * 与模型域那些用例的分工：那边钉的是注册表本身（路由 / 选中 / 各家 key 各归其位）；
 * 这边钉的是**装配之后**的那条真路——真配置（两个条目）· 真注册表 · 真取件层 ·
 * 真归一 · 真对话域 · 真记录域，**只有端点换成假的**（`modelFetch` 回放 SSE）。
 * 「上下文不丢」因此是**看得见**的：第二个端点收到的 messages 里带着第一轮的原话。
 *
 * 判据四条：
 * 1. **换成了**——换之前的请求打到甲家，换之后打到乙家，且模型名随之取乙家的默认；
 * 2. **上下文不丢**——乙家收到的那串 messages 里有第一轮的用户原话与甲的答复；
 * 3. **域外不动**——同一个会话 id、同一张记录库，条目连着长；对话域不知道发生过切换；
 * 4. **key 纪律**——两把 key 各归各家，且都不进事件与记录（直读库面证）。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EventStamper, KernelEvent, ModelGateway } from '@magic/contracts'
import { scriptOptions } from '../src/cli.ts'
import { assemble, attachShell, loadConfig, runShellScript } from '../src/index.ts'
import type { Assembly } from '../src/index.ts'
import { readDatabase } from './support.ts'
import { magicAt, removeDir, tempDir, validConfig, writeConfig } from './tmp.ts'

// ═══════════════════════════════════════════════════════════════════════
// 夹具 —— 两个条目，两个假端点
// ═══════════════════════════════════════════════════════════════════════

const ALPHA_KEY = 'sk-alpha-abcdefghijklmnop'
const BETA_KEY = 'sk-beta-abcdefghijklmnop'

const TWO_PROVIDERS = {
  alpha: { baseURL: 'https://alpha.example/v1', apiKey: ALPHA_KEY, model: 'alpha-1' },
  beta: { baseURL: 'https://beta.example/v1', apiKey: BETA_KEY, model: 'beta-1' },
}

type Seen = {
  readonly url: string
  readonly model: string
  readonly authorization: string | null
  readonly messages: readonly { readonly role: string; readonly content: unknown }[]
}

/**
 * 假端点——按 URL 认家，各回各的正文；每次请求（含线上形制）都留痕。
 * 「打对了家没有」由 URL ＋ 模型名 ＋ 正文三样一起证。
 */
function splitEndpoint(replies: { readonly alpha: string; readonly beta: string }): {
  readonly fetch: typeof globalThis.fetch
  readonly seen: Seen[]
} {
  const seen: Seen[] = []

  const fake = (async (input: unknown, init?: { body?: unknown; headers?: unknown }) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as {
      model?: string
      messages?: readonly { role: string; content: unknown }[]
    }
    seen.push({
      url,
      model: String(body.model),
      authorization: new Headers(init?.headers as Record<string, string>).get('authorization'),
      messages: body.messages ?? [],
    })

    const text = url.includes('alpha.example') ? replies.alpha : replies.beta
    const frame = (payload: Record<string, unknown>): string =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: body.model,
        ...payload,
      })}\n\n`

    return new Response(
      frame({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }) +
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as unknown as typeof globalThis.fetch

  return { fetch: fake, seen }
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
  const root = tempDir('magic-switch-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace, { recursive: true })

  const configPath = writeConfig(
    root,
    validConfig({ dataDir: join(root, 'data'), defaultProvider: 'alpha', providers: TWO_PROVIDERS }),
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
        prompt: { platform: 'darwin', date: '2026-09-18' },
        ...(modelFetch === undefined ? {} : { modelFetch }),
        ...(modelGateway === undefined ? {} : { modelGateway }),
      })
    },
    dispose: () => removeDir(root),
  }
}

function startModels(events: readonly KernelEvent[]): string[] {
  return events
    .filter((event) => event.kind === 'model.call.start')
    .map((event) => (event.kind === 'model.call.start' ? event.data.model : ''))
}

// ═══════════════════════════════════════════════════════════════════════
// 一 · 验收判据：同一会话中途换条目（上下文不丢 · 后续轮次走新模型）
// ═══════════════════════════════════════════════════════════════════════

describe('运行时切换 · 会话中途', () => {
  test('换到另一个条目：上下文不丢、后续轮次走新模型（两个条目都真）', async () => {
    const land = stage()
    const { fetch, seen } = splitEndpoint({ alpha: '记下了：17', beta: '你让我记的是 17' })

    try {
      const assembly = land.assemble({ modelFetch: fetch })
      const models = assembly.models
      expect(models).toBeDefined()
      if (models === undefined) return

      // 条目表读得出（加一条目即多一个）
      expect(models.list()).toEqual([
        { id: 'alpha', model: 'alpha-1' },
        { id: 'beta', model: 'beta-1' },
      ])

      const handle = attachShell(assembly.shell)

      await handle.submit('记住一个数：17')
      // **会话中途**——什么都没重建：同一个 assembly、同一个会话、同一张库
      expect(models.use({ provider: 'beta' })).toEqual({
        ok: true,
        selection: { provider: 'beta', model: 'beta-1' },
      })
      await handle.submit('我刚才让你记的数是多少')

      // ① 换成了：甲家一次、乙家一次，模型名随条目走
      expect(seen).toHaveLength(2)
      expect(seen[0]?.url).toBe('https://alpha.example/v1/chat/completions')
      expect(seen[0]?.model).toBe('alpha-1')
      expect(seen[1]?.url).toBe('https://beta.example/v1/chat/completions')
      expect(seen[1]?.model).toBe('beta-1')

      // ② 上下文不丢：乙家收到的那串消息里有第一轮原话与甲的答复（内核构造的上下文原样过去）
      const toBeta = seen[1]?.messages ?? []
      const flatten = JSON.stringify(toBeta)
      expect(flatten).toContain('记住一个数：17')
      expect(flatten).toContain('记下了：17')
      expect(flatten).toContain('我刚才让你记的数是多少')
      // 系统提示词照旧在最前（段结构不因换模型而变）
      expect(toBeta[0]?.role).toBe('system')

      // ③ 域外不动：同一会话、事件连着来、模型名按出场序
      expect(handle.events.every((event) => event.session === assembly.session)).toBe(true)
      expect(startModels(handle.events)).toEqual(['alpha-1', 'beta-1'])

      // ④ key 纪律：两把 key 各归各家，且一个字都不进事件与记录
      expect(seen.map((request) => request.authorization)).toEqual([
        `Bearer ${ALPHA_KEY}`,
        `Bearer ${BETA_KEY}`,
      ])
      expect(JSON.stringify(handle.events)).not.toContain(ALPHA_KEY)
      expect(JSON.stringify(handle.events)).not.toContain(BETA_KEY)

      handle.dispose()

      const db = readDatabase(assembly.paths.database)
      const dump = JSON.stringify(db.entries) + JSON.stringify(db.events)
      expect(dump).not.toContain(ALPHA_KEY)
      expect(dump).not.toContain(BETA_KEY)
      // 两轮都在同一张库、同一个会话里（条目连着长——记录域全程不知道换过模型）
      const session = assembly.session
      if (session === undefined) throw new Error('交代过之后该有会话了')
      expect(new Set(db.entries.map((entry) => entry.session))).toEqual(new Set([session]))
      expect(db.entries.length).toBeGreaterThanOrEqual(4)

      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('换模型不走对话域——换与不换，送出去的消息一字不差', async () => {
    const land = stage()
    const { fetch, seen } = splitEndpoint({ alpha: '甲答', beta: '乙答' })

    try {
      const assembly = land.assemble({ modelFetch: fetch })
      const handle = attachShell(assembly.shell)

      await handle.submit('第一轮')
      const beforeSwitch = JSON.stringify(seen[0]?.messages)

      assembly.models?.use({ provider: 'beta' })
      await handle.submit('第一轮')

      // 两轮的上下文同形（第二条请求＝同样的消息 ＋ 更长的历史）——切换动的是接缝下游
      expect(JSON.stringify(seen[1]?.messages)).toContain(JSON.stringify(JSON.parse(beforeSwitch)[1]))
      expect(seen[1]?.model).toBe('beta-1')
      expect(seen[1]?.url.startsWith('https://beta.example')).toBe(true)

      handle.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 二 · 脚本步骤：换模型（`--script` 的入口）
// ═══════════════════════════════════════════════════════════════════════

describe('运行时切换 · 脚本步骤', () => {
  test('`{ "switch": … }` 夹在交代之间——次序照写、换完即走下一步', async () => {
    const land = stage()
    const { fetch, seen } = splitEndpoint({ alpha: '甲答', beta: '乙答' })

    try {
      const assembly = land.assemble({ modelFetch: fetch })
      const handle = await runShellScript(
        assembly.shell,
        { inputs: ['第一轮', { switch: { provider: 'beta' } }, '第二轮'] },
        { onSwitch: (request) => assembly.models?.use(request) ?? { ok: false, reason: '无注册表' } },
      )

      expect(handle.switches).toEqual([
        { request: { provider: 'beta' }, selection: { provider: 'beta', model: 'beta-1' } },
      ])
      expect(seen.map((request) => request.model)).toEqual(['alpha-1', 'beta-1'])
      expect(startModels(handle.events)).toEqual(['alpha-1', 'beta-1'])

      handle.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  /**
   * 缺陷 D16 —— **脚本驱动的切换也留痕**。
   *
   * 钉的规格＝「**切换是会话的可观测事实**」（`assembly.switchModel` 的头注）：
   * 「何时改的、改成了谁、没改成是为什么」三件都得能回看，而 `model.call.start` 只说得出
   * 「这次用了谁」。
   *
   * 落法是**收拢产出、不收拢入口**——两条入口（命令面 / `--script`）都调
   * `assembly.switchModel`，产事件只在这一处发生。
   *
   * ⚠️ 接线取自 **`cli.ts` 的 `scriptOptions`**（不是一个写着同样内容的字面量）——
   * 这一条要咬的是**那一行接线**：D16 的病灶正是在 `cli.ts` 里（脚本那条直调注册表），
   * 用例自己重写一遍接线就咬不住它。
   */
  test('脚本的 `{ switch }` 与命令面**同产 `model.switched`**（D16）', async () => {
    const land = stage()
    const { fetch } = splitEndpoint({ alpha: '甲答', beta: '乙答' })

    try {
      const assembly = land.assemble({ modelFetch: fetch })
      const handle = await runShellScript(
        assembly.shell,
        { inputs: ['第一轮', { switch: { provider: 'beta' } }, '第二轮'] },
        scriptOptions(assembly, () => {}),
      )

      const switched = handle.events.filter((event) => event.kind === 'model.switched')

      expect(switched).toHaveLength(1)
      expect(switched[0]?.kind === 'model.switched' ? switched[0].data : undefined).toEqual({
        ok: true,
        provider: 'beta',
        model: 'beta-1',
      })
      expect(handle.switches).toHaveLength(1) // 驱动侧那份自记仍在（两处记的不是一件事）

      handle.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('换不动即**抛**——脚本当场停，不接着跑一个与脚本意图不符的会话', async () => {
    const land = stage()
    const { fetch, seen } = splitEndpoint({ alpha: '甲答', beta: '乙答' })

    try {
      const assembly = land.assemble({ modelFetch: fetch })

      await expect(
        runShellScript(
          assembly.shell,
          { inputs: ['第一轮', { switch: { provider: 'nowhere' } }, '第二轮'] },
          { onSwitch: (request) => assembly.models?.use(request) ?? { ok: false, reason: '无注册表' } },
        ),
      ).rejects.toThrow(/换模型不成功.*未知供应商「nowhere」/)

      // 第二轮没跑——只打了一次模型调用
      expect(seen).toHaveLength(1)
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('没接换模型的落点 → 同样抛（不静默吞掉脚本里那一步）', async () => {
    const land = stage()
    const { fetch } = splitEndpoint({ alpha: '甲答', beta: '乙答' })

    try {
      const assembly = land.assemble({ modelFetch: fetch })

      await expect(
        runShellScript(assembly.shell, { inputs: [{ switch: { provider: 'beta' } }] }),
      ).rejects.toThrow(/没接「换模型」的落点/)

      assembly.close()
    } finally {
      land.dispose()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 三 · 装配面：注册表在场与缺席
// ═══════════════════════════════════════════════════════════════════════

describe('运行时切换 · 装配面', () => {
  test('真路径有注册表；注入替身网关时**缺席**（看得见，不是静默失效）', () => {
    const land = stage()
    const { fetch } = splitEndpoint({ alpha: '甲答', beta: '乙答' })

    try {
      const real = land.assemble({ modelFetch: fetch })
      expect(real.models?.defaultProviderId()).toBe('alpha')
      expect(real.models?.has('beta')).toBe(true)
      real.close()

      // 替身那条路（Faux 一类）：单件网关，没有条目表可言
      const stub: ModelGateway = {
        stream: () => {
          throw new Error('替身：本用例不看它')
        },
      }
      const faked = land.assemble({ modelGateway: (_stamper: EventStamper) => stub })
      expect(faked.models).toBeUndefined()
      faked.close()
    } finally {
      land.dispose()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 三 · 命令面：`model.switch`（外壳那条斜杠命令走的就是这条路）
// 第 18 轮补锚 —— 结果落成 `model.switched`（**落库**），不再借兜底 `error`
// ═══════════════════════════════════════════════════════════════════════

describe('运行时切换 · 命令面（补锚：结果即事件）', () => {
  test('成了 —— 发一条 `model.switched{ok:true}`，带上落地后的选中', async () => {
    const land = stage()
    const { fetch } = splitEndpoint({ alpha: '甲答', beta: '乙答' })

    try {
      const assembly = land.assemble({ modelFetch: fetch })
      const events: KernelEvent[] = []
      const off = assembly.shell.subscribe((event) => events.push(event))

      // 先落一条消息——会话**懒建立**（第 19 轮 D5），没有会话就没有可记之处
      const handle = attachShell(assembly.shell)
      await handle.submit('起个头')

      assembly.shell.send({ type: 'model.switch', provider: 'beta' })
      off()
      handle.dispose()
      assembly.close()

      const switched = events.filter((event) => event.kind === 'model.switched')
      expect(switched).toHaveLength(1)
      expect(switched[0]?.kind === 'model.switched' ? switched[0].data : undefined).toEqual({
        ok: true,
        provider: 'beta',
        model: 'beta-1',
      })
      // **不借 `error` 兜底**（那条的语义留给「内核自身异常」）
      expect(events.map((event) => event.kind)).not.toContain('error')
    } finally {
      land.dispose()
    }
  })

  test('没成 —— `model.switched{ok:false, reason}`，仍**不是 `error`**（用户命令不成立是另一类）', async () => {
    const land = stage()
    const { fetch } = splitEndpoint({ alpha: '甲答', beta: '乙答' })

    try {
      const assembly = land.assemble({ modelFetch: fetch })
      const events: KernelEvent[] = []
      const off = assembly.shell.subscribe((event) => events.push(event))

      const handle = attachShell(assembly.shell)
      await handle.submit('起个头') // 同上：先有会话

      assembly.shell.send({ type: 'model.switch', provider: 'nowhere' })
      off()
      handle.dispose()
      assembly.close()

      const switched = events.filter((event) => event.kind === 'model.switched')
      expect(switched).toHaveLength(1)
      const data = switched[0]?.kind === 'model.switched' ? switched[0].data : undefined
      expect(data?.ok).toBe(false)
      expect(data?.reason).toContain('nowhere')
      // 切的这半句是判据：兜底 kind 不再被这条命令占用
      expect(events.map((event) => event.kind)).not.toContain('error')

      // 没成 ＝ 原选原样保留（切不动就不动）：注册表仍指 alpha
      expect(assembly.models?.selection()).toBeUndefined()
    } finally {
      land.dispose()
    }
  })
})
