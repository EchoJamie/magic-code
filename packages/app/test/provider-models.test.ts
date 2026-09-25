/**
 * U41 · 一条连接的闭环 —— 判据（工单「重点验收」第 1 条）：
 *
 * **一个只含连接认证、未枚举型号的配置** → 从供应商接口取到多个模型 → 刷新/列出 →
 * 选择 → 真实出站的 `model` 与选择一致 → 用量回来 → **配置没有因此增加模型条目**。
 *
 * 端点换假的（`modelFetch` 一次管两条路：`GET /models` 与 `POST /chat/completions`），
 * 但**控制面、装配、模型域、缓存落盘全是真的**——这一条钉的是「串起来真的能跑」。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent, ModelCatalogRow } from '@magic/contracts'
import { MAX_COMPLETION_TOKENS } from '@magic/model'
import { assemble, attachShell, loadConfig } from '../src/index.ts'
import { magicAt, removeDir, tempDir, writeConfig } from './tmp.ts'

// ═══════════════════════════════════════════════════════════════════════
// 假供应商：`GET /models` 回列表，`POST /chat/completions` 回一段 SSE
// ═══════════════════════════════════════════════════════════════════════

type Call = {
  readonly url: string
  readonly authorization: string | undefined
  readonly body: Record<string, unknown> | undefined
}

/** 一次 OpenAI 兼容的 SSE 帧。 */
function frame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'deepseek-flash',
    ...payload,
  })}\n\n`
}

/**
 * 假供应商——列表那一条回什么由 `listed` 给（缺省＝**只含 `id`/`object`/`owned_by` 的
 * 老形状**：那正是 MiniMax 实测的形状，也是这条链路此前的假设）。
 *
 * ⚠️ U91：DeepSeek 实测**多给几格**（`max_output_tokens` 等），故那几条用例整份照抄
 * 真响应传进来——形状一变，判据才咬得住。
 */
function fakeVendor(
  listed: readonly Record<string, unknown>[] = [
    { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
    { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
  ],
): { readonly fetch: typeof globalThis.fetch; readonly calls: Call[] } {
  const calls: Call[] = []

  const fetch = (async (input: unknown, init?: { headers?: unknown; body?: unknown }) => {
    const url = String(input)
    const headers = new Headers(init?.headers as Record<string, string> | undefined)
    calls.push({
      url,
      authorization: headers.get('authorization') ?? undefined,
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    })

    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: listed }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    return new Response(
      frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '收到' } }] }) +
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
        frame({
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        }) +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as unknown as typeof globalThis.fetch

  return { fetch, calls }
}

// ═══════════════════════════════════════════════════════════════════════
// 沙地：一条**只含连接认证**的连接（没有 model，也没有 baseURL）
// ═══════════════════════════════════════════════════════════════════════

function stage(): {
  readonly root: string
  readonly configPath: string
  readonly workspace: string
  readonly dataDir: string
  dispose(): void
} {
  const root = tempDir('magic-provider-')
  const workspace = join(root, 'ws')
  const dataDir = join(root, 'data')
  mkdirSync(workspace, { recursive: true })

  const configPath = writeConfig(root, {
    defaultProvider: 'ds',
    providers: { ds: { vendor: 'deepseek', apiKey: 'sk-not-a-real-key' } },
    dataDir,
  })

  return { root, configPath, workspace, dataDir, dispose: () => removeDir(root) }
}

type Extracted<K extends KernelEvent['kind']> = Extract<KernelEvent, { kind: K }>

/** 等一条事件（先架等、后发命令——控制面是同步的，答复当步就回来）。 */
function waitFor<K extends KernelEvent['kind']>(
  shell: { until(test: (event: KernelEvent) => boolean, timeoutMs?: number): Promise<KernelEvent> },
  kind: K,
): Promise<Extracted<K>> {
  return shell.until((event) => event.kind === kind, 3000) as Promise<Extracted<K>>
}

describe('一条连接的闭环', () => {
  test('列表来自接口 → 选择 → 出站 model 一致 → 用量回来 → 配置**没多出模型条目**', async () => {
    const land = stage()
    const vendor = fakeVendor()

    try {
      const assembly = assemble({
        cwd: land.workspace,
        config: loadConfig({ path: land.configPath, magic: magicAt(land.root) }),
        modelFetch: vendor.fetch,
        grantsFile: join(land.root, 'magic', 'grants.json'),
        magic: magicAt(land.root),
        prompt: { platform: 'darwin', date: '2026-09-23' },
      })
      const shell = attachShell(assembly.shell)
      await assembly.ready()

      // —— ① 一个连接下**多模型来自真实 HTTP 列表** ——
      //
      // ⚠️ 第一次问**未必**看得到：读面同步答复，获取是它顺手发起的**后台**那一趟
      //（设计：过期先回旧缓存、后台刷新）。假端点几乎是当步就回，两者谁先落定不定——
      // 故这里**反复问到看得见为止**（真实现里那是「再按一次 `/model`」）。
      let row: ModelCatalogRow | undefined
      for (let i = 0; i < 20 && (row?.cache?.snapshot?.models.length ?? 0) === 0; i += 1) {
        const armed = waitFor(shell, 'model.catalog')
        shell.send({ type: 'model.list' })
        row = (await armed).data.entries[0]
        if ((row?.cache?.snapshot?.models.length ?? 0) === 0) await Bun.sleep(10)
      }
      expect(row?.provider).toBe('ds')
      expect(row?.vendor).toBe('deepseek')
      // **两个模型都在**——而且它们**不在配置里**（配置只有认证）
      expect(row?.cache?.snapshot?.models.map((one) => one.id)).toEqual([
        'deepseek-flash',
        'deepseek-v4-pro',
      ])
      // 出站那一趟带的是这条连接的认证
      expect(vendor.calls[0]?.url).toBe('https://api.deepseek.com/models')
      expect(vendor.calls[0]?.authorization).toBe('Bearer sk-not-a-real-key')
      // 还没有默认选择（配置里没写、也没选过）
      expect(row?.model).toBeUndefined()

      // —— ② 选择：**实际出站的 model 与选择一致** ——
      expect(
        assembly.switchModel({ provider: 'ds', model: 'deepseek-v4-pro' }),
      ).toEqual({ ok: true, selection: { provider: 'ds', model: 'deepseek-v4-pro' } })

      await shell.submit('嗨')

      const chat = vendor.calls.find((call) => call.url.endsWith('/chat/completions'))
      expect(chat?.body?.['model']).toBe('deepseek-v4-pro')
      expect(chat?.url).toBe('https://api.deepseek.com/chat/completions')

      // —— ③ 用量回来（真取件层 → 真归一） ——
      const usages = shell.events.filter(
        (event): event is Extracted<'model.usage'> => event.kind === 'model.usage',
      )
      expect(usages).toHaveLength(1)
      expect(usages[0]?.data.inputTokens).toBe(12)
      expect(usages[0]?.data.outputTokens).toBe(3)

      // —— ④ 配置**没有因发现模型而膨胀** ——
      const onDisk = JSON.parse(readFileSync(land.configPath, 'utf8')) as {
        providers: Record<string, Record<string, unknown>>
      }
      expect(Object.keys(onDisk.providers)).toEqual(['ds'])
      expect(onDisk.providers['ds']).toEqual({ vendor: 'deepseek', apiKey: 'sk-not-a-real-key' })

      // —— ⑤ 保存默认：这一下**才**写配置（与换当前分开） ——
      const saved = waitFor(shell, 'model.catalog')
      shell.send({ type: 'model.default.set', provider: 'ds', model: 'deepseek-v4-pro' })
      await saved

      const after = JSON.parse(readFileSync(land.configPath, 'utf8')) as {
        defaultProvider: string
        providers: Record<string, Record<string, unknown>>
      }
      expect(after.defaultProvider).toBe('ds')
      expect(after.providers['ds']).toEqual({
        vendor: 'deepseek',
        apiKey: 'sk-not-a-real-key',
        model: 'deepseek-v4-pro',
      })
      // 仍然**只有那一条连接**、没有型号清单
      expect(Object.keys(after.providers)).toEqual(['ds'])

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('缓存真的落了盘：`<dataDir>/cache/models/` 下有一份，重开装配能读回来', async () => {
    const land = stage()
    const vendor = fakeVendor()

    try {
      const first = assemble({
        cwd: land.workspace,
        config: loadConfig({ path: land.configPath, magic: magicAt(land.root) }),
        modelFetch: vendor.fetch,
        grantsFile: join(land.root, 'magic', 'grants.json'),
        magic: magicAt(land.root),
        prompt: { platform: 'darwin', date: '2026-09-23' },
      })
      await first.ready()
      await first.modelInfo.refresh('ds') // 显式刷新：等它落定
      first.close()

      // 第二次装配（同一个 dataDir）——预热把盘上那份读回来，**不再打接口**
      const callsBefore = vendor.calls.length
      const second = assemble({
        cwd: land.workspace,
        config: loadConfig({ path: land.configPath, magic: magicAt(land.root) }),
        modelFetch: vendor.fetch,
        grantsFile: join(land.root, 'magic', 'grants.json'),
        magic: magicAt(land.root),
        prompt: { platform: 'darwin', date: '2026-09-23' },
      })
      await second.ready()

      const shell = attachShell(second.shell)
      const armed = waitFor(shell, 'model.catalog')
      shell.send({ type: 'model.list' })
      const listing = await armed

      expect(listing.data.entries[0]?.cache?.snapshot?.models.map((one) => one.id)).toEqual([
        'deepseek-flash',
        'deepseek-v4-pro',
      ])
      // 预热后那份是新鲜的 ⇒ **没有再打一次列表接口**
      expect(vendor.calls.length).toBe(callsBefore)

      shell.dispose()
      second.close()
    } finally {
      land.dispose()
    }
  })

  test('改连接显示名 / 设为默认都**不得偷切当前选择**（U41 返修）', async () => {
    const land = stage()
    const vendor = fakeVendor()

    try {
      const assembly = assemble({
        cwd: land.workspace,
        config: loadConfig({ path: land.configPath, magic: magicAt(land.root) }),
        modelFetch: vendor.fetch,
        grantsFile: join(land.root, 'magic', 'grants.json'),
        magic: magicAt(land.root),
        prompt: { platform: 'darwin', date: '2026-09-23' },
      })
      const shell = attachShell(assembly.shell)
      await assembly.ready()

      // 当前选 pro（配置里的默认是 flash）
      expect(assembly.switchModel({ provider: 'ds', model: 'deepseek-v4-pro' }).ok).toBe(true)

      // ① 只改显示名——那是**管理**动作，不是换模型
      const afterRename = waitFor(shell, 'provider.catalog')
      shell.send({ type: 'provider.save', provider: 'ds', name: '我的 DeepSeek' })
      await afterRename

      const renamed = await (async () => {
        const armed = waitFor(shell, 'model.catalog')
        shell.send({ type: 'model.list' })
        return armed
      })()
      expect(renamed.data.entries[0]?.name).toBe('我的 DeepSeek')
      // **当前仍是 pro**——重建注册表不该把用户的当前选择切回默认
      expect(renamed.data.current).toEqual({ provider: 'ds', model: 'deepseek-v4-pro' })

      // ② 把 flash 保存为**默认**——那是「以后用哪个」，不是「现在换到哪个」
      const saved = waitFor(shell, 'model.catalog')
      shell.send({ type: 'model.default.set', provider: 'ds', model: 'deepseek-flash' })
      const afterDefault = await saved

      expect(afterDefault.data.current).toEqual({ provider: 'ds', model: 'deepseek-v4-pro' })
      // 而配置里确实换成了 flash（两件事分开，各自都做对了）
      const onDisk = JSON.parse(readFileSync(land.configPath, 'utf8')) as {
        providers: Record<string, { model?: string }>
      }
      expect(onDisk.providers['ds']?.model).toBe('deepseek-flash')

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('**已保存的默认思考设置**在开局请求里生效（U41 返修）', async () => {
    const land = stage()
    const vendor = fakeVendor()

    try {
      // 配置里存着「明确关闭」——返修前这一位只读了 `model`，请求里一个参数都没有
      const configPath = writeConfig(land.root, {
        defaultProvider: 'ds',
        providers: {
          ds: {
            vendor: 'deepseek',
            apiKey: 'sk-not-a-real-key',
            model: 'deepseek-flash',
            reasoning: { mode: 'off' },
          },
        },
        dataDir: land.dataDir,
      })

      const assembly = assemble({
        cwd: land.workspace,
        config: loadConfig({ path: configPath, magic: magicAt(land.root) }),
        modelFetch: vendor.fetch,
        grantsFile: join(land.root, 'magic', 'grants.json'),
        magic: magicAt(land.root),
        prompt: { platform: 'darwin', date: '2026-09-23' },
      })
      const shell = attachShell(assembly.shell)
      await assembly.ready()

      await shell.submit('嗨')

      const chat = vendor.calls.find((call) => call.url.endsWith('/chat/completions'))
      // 官方文档的关闭形态：`thinking.type = disabled`
      expect(chat?.body?.['thinking']).toEqual({ type: 'disabled' })
      // 读面也照给（界面据它标「当前设置」）
      const armed = waitFor(shell, 'model.catalog')
      shell.send({ type: 'model.list' })
      expect((await armed).data.entries[0]?.reasoning).toEqual({ mode: 'off' })

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('**外部**改了配置 ⇒ 连接资料重读（不是只认本进程保存过的那份）', async () => {
    const land = stage()
    const vendor = fakeVendor()

    try {
      const assembly = assemble({
        cwd: land.workspace,
        config: loadConfig({ path: land.configPath, magic: magicAt(land.root) }),
        modelFetch: vendor.fetch,
        grantsFile: join(land.root, 'magic', 'grants.json'),
        magic: magicAt(land.root),
        prompt: { platform: 'darwin', date: '2026-09-23' },
      })
      const shell = attachShell(assembly.shell)
      await assembly.ready()

      const readKeySource = async (): Promise<string | undefined> => {
        const armed = waitFor(shell, 'model.catalog')
        shell.send({ type: 'model.list' })
        return (await armed).data.entries[0]?.keySource
      }

      // 开局：认证取自配置文件
      expect(await readKeySource()).toBe('config')

      // **外部**把配置文件改了（模拟另一个进程 / 手改）——去掉 `apiKey`
      writeConfig(land.root, {
        defaultProvider: 'ds',
        providers: { ds: { vendor: 'deepseek', model: 'deepseek-flash' } },
        dataDir: land.dataDir,
      })

      // 下一次读面就该看到**新**那份资料：认证不再来自配置文件
      //（若不重读，这里仍是 `'config'` —— 那会把旧 key 的请求贴上新范围）
      expect(await readKeySource()).not.toBe('config')

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('**当前选择**的预算三处同源：切换当下 / 读面 / 调用开始（U41 返修）', async () => {
    const land = stage()
    const vendor = fakeVendor()

    try {
      // 只给**非默认**的那个型号一条覆盖——这样「拿默认行推算」会当场露馅：
      // 默认行（deepseek-flash）**没有**窗长依据，而当前选中（deepseek-v4-pro）有
      const configPath = writeConfig(land.root, {
        defaultProvider: 'ds',
        providers: {
          ds: {
            vendor: 'deepseek',
            apiKey: 'sk-not-a-real-key',
            model: 'deepseek-flash',
            modelOverrides: {
              'deepseek-v4-pro': { limits: { maxContextTokens: 30_000, maxOutputTokens: 1_000 } },
            },
          },
        },
        dataDir: land.dataDir,
      })

      const assembly = assemble({
        cwd: land.workspace,
        config: loadConfig({ path: configPath, magic: magicAt(land.root) }),
        modelFetch: vendor.fetch,
        grantsFile: join(land.root, 'magic', 'grants.json'),
        magic: magicAt(land.root),
        prompt: { platform: 'darwin', date: '2026-09-23' },
      })
      const shell = attachShell(assembly.shell)
      await assembly.ready()

      // 先走一轮（**还没有会话时切换不发 `model.switched`**——那是既有语义：
      // 事件是「会话的可观测事实」，没有会话就没有可记之处）
      await shell.submit('先走一轮')
      // 缺省那个型号**没有窗长依据** ⇒ 这一轮的分母**缺席**（不知道就说不知道）
      const firstStart = shell.events.findLast(
        (event): event is Extracted<'model.call.start'> => event.kind === 'model.call.start',
      )
      expect(firstStart?.data.inputBudget).toBeUndefined()

      // ① **切换当下**：`model.switched` 就把新分母带上（不必等一次调用）
      const switched = waitFor(shell, 'model.switched')
      expect(assembly.switchModel({ provider: 'ds', model: 'deepseek-v4-pro' }).ok).toBe(true)
      const switchedEvent = await switched
      expect(switchedEvent.data.inputBudget).toBe(30_000 - 1_000)

      // ② **读面**：`currentInputBudget` 是**当前选中**那个型号的数——
      //    ⚠️ 而 `entries[0].contextWindow`（**该连接的默认模型**）这里**缺席**
      //    （flash 没有窗长依据）——外壳据「在不在」清空，不拿默认行推算
      const catalog = await (async () => {
        const armed = waitFor(shell, 'model.catalog')
        shell.send({ type: 'model.list' })
        return armed
      })()
      expect(catalog.data.current).toEqual({ provider: 'ds', model: 'deepseek-v4-pro' })
      expect(catalog.data.currentInputBudget).toBe(30_000 - 1_000)
      expect(catalog.data.entries[0]?.contextWindow).toBeUndefined()

      // ③ **调用开始**：`model.call.start` 与后面的 `model.usage` 是同一个数
      await shell.submit('换过之后再走一轮')
      const start = shell.events.findLast(
        (event): event is Extracted<'model.call.start'> => event.kind === 'model.call.start',
      )
      const usage = shell.events.findLast(
        (event): event is Extracted<'model.usage'> => event.kind === 'model.usage',
      )
      expect(start?.data.inputBudget).toBe(30_000 - 1_000)
      expect(usage?.data.contextWindow).toBe(30_000 - 1_000)

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('认证来处照给：环境变量那一支说「来自环境变量」；两处都没有就不给这一位', async () => {
    const land = stage()
    const vendor = fakeVendor()

    // 缺省那条**不写** `apiKey`（走环境变量回退）；另一条两处都没有——
    // 它**不是缺省**，故不会在构造期被预造网关（那条路缺 key 才抛）。
    const configPath = writeConfig(land.root, {
      defaultProvider: 'ds',
      providers: {
        ds: { vendor: 'deepseek' },
        other: { baseURL: 'https://x/v1', model: 'm' },
      },
      dataDir: land.dataDir,
    })

    process.env['MAGIC_DS_API_KEY'] = 'sk-not-a-real-key'
    try {
      const assembly = assemble({
        cwd: land.workspace,
        config: loadConfig({ path: configPath, magic: magicAt(land.root) }),
        modelFetch: vendor.fetch,
        grantsFile: join(land.root, 'magic', 'grants.json'),
        magic: magicAt(land.root),
        prompt: { platform: 'darwin', date: '2026-09-23' },
      })
      const shell = attachShell(assembly.shell)
      await assembly.ready()

      const armed = waitFor(shell, 'model.catalog')
      shell.send({ type: 'model.list' })
      const rows = (await armed).data.entries

      // **说的是来处，不是凭据**：那一格只有 `'config'` / `'env'` 两个取值
      expect(rows.find((one) => one.provider === 'ds')?.keySource).toBe('env')
      // 两处都没有 ⇒ **不给这一位**（不冒充「已设置」）
      expect(rows.find((one) => one.provider === 'other')?.keySource).toBeUndefined()
      // 凭据本身一个字都没进读面
      expect(JSON.stringify(rows)).not.toContain('sk-not-a-real-key')

      shell.dispose()
      assembly.close()
    } finally {
      delete process.env['MAGIC_DS_API_KEY']
      land.dispose()
    }
  })

  test('兼容接入的连接（没 `vendor`）照旧能用：**不自动列表**，但调用照走原协议', async () => {
    const land = stage()
    const vendor = fakeVendor()

    try {
      const configPath = writeConfig(land.root, {
        defaultProvider: 'mm',
        providers: {
          mm: { baseURL: 'https://api.minimaxi.com/v1', apiKey: 'sk-old', model: 'MiniMax-M3' },
        },
        dataDir: land.dataDir,
      })

      const assembly = assemble({
        cwd: land.workspace,
        config: loadConfig({ path: configPath, magic: magicAt(land.root) }),
        modelFetch: vendor.fetch,
        grantsFile: join(land.root, 'magic', 'grants.json'),
        magic: magicAt(land.root),
        prompt: { platform: 'darwin', date: '2026-09-23' },
      })
      const shell = attachShell(assembly.shell)
      await assembly.ready()

      const armed = waitFor(shell, 'model.catalog')
      shell.send({ type: 'model.list' })
      const listing = await armed

      const row = listing.data.entries[0]
      expect(row?.vendor).toBeUndefined() // 兼容接入：界面据此标明
      expect(row?.cache).toBeUndefined() // 没有自动获取能力，也就没有缓存读数

      // 调用照走原地址与原模型（**旧能力不删**）
      await shell.submit('嗨')
      const chat = vendor.calls.find((call) => call.url.endsWith('/chat/completions'))
      expect(chat?.url).toBe('https://api.minimaxi.com/v1/chat/completions')
      expect(chat?.body?.['model']).toBe('MiniMax-M3')
      // 没打过列表接口
      expect(vendor.calls.filter((call) => call.url.endsWith('/models'))).toHaveLength(0)
      // U91 **反面**：这条路没有模型信息可取（连列表都不打）⇒ 输出上限落回
      // 取件层那个**权宜**兜底——**不许**因此多出别的参数来
      expect(chat?.body?.['max_completion_tokens']).toBe(MAX_COMPLETION_TOKENS)

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// U91 · 输出上限取自模型信息 —— 判据落在**出站请求体**上
// ═══════════════════════════════════════════════════════════════════════

/**
 * DeepSeek 的列表响应 **逐字抄自实测**（2026-09-26 `GET https://api.deepseek.com/models`）——
 * 键序、名字、那几个数都是真的。`max_output_tokens` 就是本单要的那一格。
 */
const DEEPSEEK_LISTED: readonly Record<string, unknown>[] = [
  {
    id: 'deepseek-flash',
    object: 'model',
    owned_by: 'deepseek',
    name: 'DeepSeek-V4.1-Flash',
    context_window: 1_048_576,
    max_output_tokens: 393_216,
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
    effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
    api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } },
  },
  {
    id: 'deepseek-v4-pro',
    object: 'model',
    owned_by: 'deepseek',
    name: 'DeepSeek-V4-Pro',
    context_window: 1_048_576,
    max_output_tokens: 393_216,
    input_modalities: ['text'],
    output_modalities: ['text'],
    effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
    api_capabilities: { anthropic_messages: { system_prompt_update: 'leading-only' } },
  },
]

/**
 * 走一遍真路：装配 → 等列表**真落到缓存里** → 选模型 → 发一条 → 取**出站请求体**。
 *
 * 端点换假的（列表与对话同一把假 fetch），其余全真：控制面 · 装配 · 模型域 ·
 * 模型信息缓存 · 取件层。
 */
async function outboundBodyOf(
  listed: readonly Record<string, unknown>[],
  model: string,
): Promise<{ readonly body: Record<string, unknown>; readonly land: string }> {
  const land = stage()
  const vendor = fakeVendor(listed)

  try {
    const assembly = assemble({
      cwd: land.workspace,
      config: loadConfig({ path: land.configPath, magic: magicAt(land.root) }),
      modelFetch: vendor.fetch,
      grantsFile: join(land.root, 'magic', 'grants.json'),
      magic: magicAt(land.root),
      prompt: { platform: 'darwin', date: '2026-09-23' },
    })
    const shell = attachShell(assembly.shell)
    await assembly.ready()

    // 读面同步答复、获取是它顺手发起的**后台**那一趟——**问到看得见为止**（同首条用例）
    for (let i = 0; i < 20; i += 1) {
      const armed = waitFor(shell, 'model.catalog')
      shell.send({ type: 'model.list' })
      const row = (await armed).data.entries[0]
      if ((row?.cache?.snapshot?.models.length ?? 0) > 0) break
      await Bun.sleep(10)
    }

    expect(assembly.switchModel({ provider: 'ds', model }).ok).toBe(true)
    await shell.submit('嗨')

    const chat = vendor.calls.find((call) => call.url.endsWith('/chat/completions'))
    shell.dispose()
    assembly.close()
    // `land` 一并交回：临时工作区路径**就是请求体的一部分**（系统提示里写了它），
    // 对拍两条请求体时要把它抹平——否则红的是路径，不是产品行为
    return { body: chat?.body ?? {}, land: land.workspace }
  } finally {
    land.dispose()
  }
}

describe('U91 · 输出上限取自模型信息', () => {
  test('接口给了那一数 ⇒ 请求体里的输出上限就是它（不再是 4096）', async () => {
    const { body } = await outboundBodyOf(DEEPSEEK_LISTED, 'deepseek-flash')

    // 模型信息里那个数（`max_output_tokens`）一路落到请求体
    expect(body['max_tokens']).toBe(393_216)
    expect(body['max_tokens']).not.toBe(MAX_COMPLETION_TOKENS)
    // DeepSeek 没有参数名改写 ⇒ 仍是标准 `max_tokens`（U41 那条照旧）
    expect(body['max_completion_tokens']).toBeUndefined()
  })

  /**
   * ⚠️ **反面**：模型信息里**没有这一位**时**不许编**——落回权宜兜底，
   * 且**不因此多出别的参数**（同一把假端点，只是列表少给一格）。
   */
  test('接口没给那一数 ⇒ 落回权宜兜底（不编，也不多出别的参数）', async () => {
    const listed = DEEPSEEK_LISTED.map(({ max_output_tokens: _drop, ...rest }) => rest)

    const { body } = await outboundBodyOf(listed, 'deepseek-flash')

    expect(body['max_tokens']).toBe(MAX_COMPLETION_TOKENS)
    expect(body['max_completion_tokens']).toBeUndefined()
  })

  /**
   * ⚠️ **反面**：这一改**只动输出上限**——请求体里其余各格与改前逐字同形。
   *
   * 拿「给的那份」与「没给的那份」对拍：除 `max_tokens` 一个键之外，两份应当**一字不差**。
   * （这条判据是防我自己顺手把 `context_window` 之类也收进请求的。）
   */
  test('只动输出上限那一格：两份请求体**除它之外一字不差**', async () => {
    const withIt = await outboundBodyOf(DEEPSEEK_LISTED, 'deepseek-flash')
    const without = await outboundBodyOf(
      DEEPSEEK_LISTED.map(({ max_output_tokens: _drop, ...rest }) => rest),
      'deepseek-flash',
    )

    expect(withIt.body['max_tokens']).toBe(393_216)
    expect(without.body['max_tokens']).toBe(MAX_COMPLETION_TOKENS)

    // 把**那一格**（与临时工作区那条路径）抹掉之后，两份必须完全相同——
    // 多出 / 少了任何别的键，这里就红
    const strip = (one: { body: Record<string, unknown>; land: string }): string =>
      JSON.stringify(Object.fromEntries(Object.entries(one.body).filter(([key]) => key !== 'max_tokens')))
        .split(one.land)
        .join('<工作区>')

    expect(strip(withIt)).toBe(strip(without))
  })
})
