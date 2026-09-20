/**
 * U30 · 上下文容量来源与切换显示 —— **验收判据**（全链 · 经真控制面）。
 *
 * 出处：`交接/工单/U30.md`（依据 `进度台账` 的「换模型分母滞后」＋「`contextWindow`
 * 内置表」两条）。两条同属**一条用量读数链**：分母从哪来 · 换过模型之后跟不跟得上。
 *
 * 判据逐条锚「我要什么」：
 *
 * 1. **已知模型不要求用户自己补客观容量**——内置表（官方出处见 `capacity.ts`）命中
 *    就有分母，配置里不必写一行；
 * 2. **用户已明确配置的保持覆盖能力**——`providers.<id>.contextWindow` 声明了就用声明的数；
 * 3. **未知 ⇒ `null`**——不沿用前一个模型的容量、不模糊匹配、不编；
 * 4. **运行时换模型后分母立即更新**（那句「现在谁在干活，分母就得是谁的」）——
 *    **切换失败保持当前读数**；
 * 5. **开机空态不变**——还没有用量就不报用量（**不写一个伪造的 `0/…`**）。
 *
 * 这一层钉的是**全链**：真配置 · 真注册表 · 真对话域 · 真记录域 · 真控制面 ＋
 * **真外壳**（`createShell`，经 `tuiOptions` 那一条接线取件）——只有端点换成假的。
 * 域内那半（怎么查表、怎么合并）钉在 `@magic/model` 的用例里。
 *
 * ⚠️ **一条已知的接线缺口**（如实记 · 见回报）：这一跳 `tuiOptions → runTui → createShell`
 * 的最后一行在 `packages/tui/src/run.ts`（本轮所有权外）。用例在这里把 `tuiOptions` 的两件
 * **原样**递进 `createShell`——补丁落地后，`runTui` 那一行做的正是同一件事。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EventStamper, KernelEvent, ModelGateway } from '@magic/contracts'
import { createFauxGateway } from '@magic/faux'
import { createShell, usageLabel } from '@magic/tui'
import { assemble, attachShell, loadConfig } from '../src/index.ts'
import type { Assembly } from '../src/index.ts'
// 接线取件（照 `readouts.test.ts` 的先例）——不是写着同样内容的字面量
import { tuiOptions } from '../src/cli.ts'
import { readDatabase } from './support.ts'
import { removeDir, tempDir, validConfig, writeConfig } from './tmp.ts'

// ═══════════════════════════════════════════════════════════════════════
// 夹具 —— 三条目 × 三种容量来处（内置命中 / 声明覆盖 / 未知）
// ═══════════════════════════════════════════════════════════════════════

const KEY = 'sk-u30-not-a-real-key'

/**
 * 甲乙丙三格，正好是三种来处：
 * - `mm` —— 内置表命中（`MiniMax-M3` ⇒ 1,000,000），**配置里不写** `contextWindow`；
 * - `mm2` —— 模型也在内置表里（`MiniMax-M2` ⇒ 204,800），但**用户声明了** 32,768
 *   （本地端点 / 私有部署那一类：声明的数说了算）；
 * - `local` —— 表外模型（自建 llama），没声明 ⇒ **不知道**（分母 `null`）。
 */
const PROVIDERS = {
  mm: { baseURL: 'https://mm.example/v1', apiKey: KEY, model: 'MiniMax-M3' },
  mm2: { baseURL: 'https://mm2.example/v1', apiKey: KEY, model: 'MiniMax-M2', contextWindow: 32_768 },
  local: { baseURL: 'https://local.example/v1', apiKey: KEY, model: 'my-local-llama' },
}

/** 假端点：一路顺风（内容固定、每次回用量）——只为让「真调用 → 有会话」这条链走通。 */
function endpoint(): typeof globalThis.fetch {
  return (async () => {
    const frame = (payload: Record<string, unknown>): string =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-u30',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'MiniMax-M3',
        ...payload,
      })}\n\n`

    return new Response(
      frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '好' } }] }) +
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
        frame({ choices: [], usage: { prompt_tokens: 3_100, completion_tokens: 5, total_tokens: 3_105 } }) +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as unknown as typeof globalThis.fetch
}

function stage(): {
  readonly assemble: (options?: {
    readonly modelGateway?: ((stamper: EventStamper) => ModelGateway) | undefined
  }) => Assembly
  dispose(): void
} {
  const root = tempDir('magic-u30-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace, { recursive: true })

  const configPath = writeConfig(
    root,
    validConfig({ dataDir: join(root, 'data'), defaultProvider: 'mm', providers: PROVIDERS }),
  )

  return {
    assemble: (options = {}) =>
      assemble({
        cwd: workspace,
        config: loadConfig({ path: configPath, home: root }),
        // **授权文件也落沙地**（照 `support.ts` 的 `makeStage`）：缺省 `GRANTS_FILE` 是
        // `~/.magic/grants.json`——那是**用户真的那份**，装配级用例一律不许碰它
        grantsFile: join(root, 'magic', 'grants.json'),
        prompt: { platform: 'darwin', date: '2026-09-20' },
        modelFetch: endpoint(),
        ...(options.modelGateway === undefined ? {} : { modelGateway: options.modelGateway }),
      }),
    dispose: () => removeDir(root),
  }
}

/**
 * 起一个**真外壳**（`createShell`）——入参**从 `tuiOptions` 取件**（照 `readouts.test.ts`
 * 那条判据的姿势：别自己照接一遍，那样倒回接线照样绿）。
 */
function shellOf(assembly: Assembly) {
  const options = tuiOptions(assembly)
  return createShell(assembly.shell, {
    contextWindow: options.contextWindow,
    contextWindows: options.contextWindows,
  })
}

/** 一次真调用（让链上有会话——`model.switched` 要落在会话上）。 */
async function warm(assembly: Assembly): Promise<void> {
  const handle = attachShell(assembly.shell)
  await handle.submit('嗨')
  handle.dispose()
}

// ═══════════════════════════════════════════════════════════════════════
// 一 · 开机那一格：容量从哪来
// ═══════════════════════════════════════════════════════════════════════

describe('U30 · 开机那一格的分母', () => {
  test('**已知模型**：配置里没声明，也有分母（内置表命中 ⇒ M3 报 1M）', () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      // 这份配置只写了 endpoint / key / 模型名——窗长是我们已知的客观属性
      expect(tuiOptions(assembly).contextWindow).toBe(1_000_000)

      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('**用户声明的压过内置**：声明了 32768 就报 32768（不是内置的 204800）', () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      expect(assembly.switchModel({ provider: 'mm2' }).ok).toBe(true)

      expect(tuiOptions(assembly).contextWindow).toBe(32_768)

      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('**未知模型**：`null`——不编、不含糊匹配（自建 llama 就是你自己的事）', () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      expect(assembly.switchModel({ provider: 'local' }).ok).toBe(true)

      expect(tuiOptions(assembly).contextWindow).toBeNull()

      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('**窗长表**经装配给到外壳：内置 ∪ 声明都在，未知的**连键都不在**', () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const table = tuiOptions(assembly).contextWindows

      // 内置打底（换到哪一格都查得到）
      expect(table['MiniMax-M3']).toBe(1_000_000)
      expect(table['MiniMax-M2.5']).toBe(204_800)
      // 声明**按模型名**进表（`mm2` 那一格声明了 32768 ⇒ 这个模型名报 32768）
      expect(table[PROVIDERS.mm2.model]).toBe(32_768)
      // 不知道的：**不存在**（不是 0）——外壳 `?? null` 即「不知道」
      expect('my-local-llama' in table).toBe(false)

      assembly.close()
    } finally {
      land.dispose()
    }
  })

  /**
   * 表的口径**钉住**（免得日后成了「碰巧」）：一条目声明的窗长**按模型名**合一而查——
   * 同名的内置数被它盖掉，**在任何条目下都算数**。
   *
   * 这么定的由头：外壳手上只有「此刻走谁」（`model.switched` 的 provider ＋ model 两件，
   * 而 `model.call.start` 的 provider 还可以缺），拿「条目」当键就有一半问不出来；
   * 而用户写下的那个数本就是**他对自己那个模型 id 的声明**。代价如实记：
   * 两条目挂**同名模型**、其中一条声明了另一种窗长时，另一条也会用这个数
   * （配置事故级的情形，见回报「备案」）。
   */
  test('声明按**模型名**盖内置——同名的内置数让位（口径钉住，不是碰巧）', () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const table = tuiOptions(assembly).contextWindows

      // `MiniMax-M2` 官方 204800、声明 32768 ⇒ 表里是**声明的那个**
      expect(table['MiniMax-M2']).toBe(32_768)
      // 没声明过的同名族模型不受影响
      expect(table['MiniMax-M2.1']).toBe(204_800)

      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('注册表缺席（替身网关）⇒ 空表 ＋ `null`——与「不知道」同一条口径', () => {
    const land = stage()

    try {
      const assembly = land.assemble({
        modelGateway: (stamper) => createFauxGateway({ stamper, turns: [] }),
      })
      const options = tuiOptions(assembly)

      expect(options.contextWindow).toBeNull()
      expect(options.contextWindows).toEqual({})

      assembly.close()
    } finally {
      land.dispose()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 二 · 换过模型之后：分母跟不跟得上（真链路 · 真事件 · 真外壳）
// ═══════════════════════════════════════════════════════════════════════

describe('U30 · 换过模型之后的分母', () => {
  test('已知 ⇒ 另一已知：换过去那一刻分母就换成**新模型**的（不是旧那个）', async () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const shell = shellOf(assembly)
      await warm(assembly)

      // 跑过一句之后 ③④ 都有数（M3 ⇒ 1M）
      expect(shell.getView().status.model).toBe('MiniMax-M3')
      expect(shell.getView().status.window).toBe(1_000_000)

      // 真换：经装配那一条产出路径（命令面同一条），事件当场到壳（进程内直连）
      expect(assembly.switchModel({ provider: 'mm2' }).ok).toBe(true)
      expect(shell.getView().status.model).toBe('MiniMax-M2')
      expect(shell.getView().status.window).toBe(32_768)

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('切换**失败**：读数保持原样（换了未成，分母不动——切不动就不动）', async () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const shell = shellOf(assembly)
      await warm(assembly)

      expect(assembly.switchModel({ provider: 'ghost' }).ok).toBe(false)

      expect(shell.getView().status.model).toBe('MiniMax-M3')
      expect(shell.getView().status.window).toBe(1_000_000)

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('已知 ⇒ 未知：分母变 `null`——**不沿用**前一个模型的容量', async () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const shell = shellOf(assembly)
      await warm(assembly)

      expect(assembly.switchModel({ provider: 'local' }).ok).toBe(true)

      expect(shell.getView().status.window).toBeNull()
      // 分子还在（用量是既成事实），只是没有分母可配
      expect(shell.getView().status.usage).toBe(3_100)
      expect(usageLabel(shell.getView().status.usage, shell.getView().status.window)).toBe('3.1k')

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('**只换模型**（同一条目）：按模型名查表出数，不沿用该条目那个数', async () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const shell = shellOf(assembly)
      await warm(assembly)

      // 同一条目换到另一个模型——它自己的窗长（内置 204800），不是 M3 的 1M
      expect(assembly.switchModel({ model: 'MiniMax-M2.5' }).ok).toBe(true)
      expect(shell.getView().status.window).toBe(204_800)

      // 换到表里没有的模型名 ⇒ 不知道（同条目那个数也不顶上去）
      expect(assembly.switchModel({ model: 'MiniMax-M9' }).ok).toBe(true)
      expect(shell.getView().status.window).toBeNull()

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('**空手先换**（内核不发 `model.switched`）：第一条消息的 `call.start` 把分母带上正轨', async () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const shell = shellOf(assembly)

      // 还没有会话就换——注册表照换，但**没有可落账之处 ⇒ 不发事件**（内核的明写规矩）
      expect(assembly.switchModel({ provider: 'mm2' }).ok).toBe(true)
      // 壳上还是开机那一格（M3 的 1M）——没人告诉过它换了
      expect(shell.getView().status.window).toBe(1_000_000)

      await warm(assembly)

      // 真跑用谁，分母就跟着谁：「这次真用了谁」那条事件把读数带上正轨
      expect(shell.getView().status.model).toBe('MiniMax-M2')
      expect(shell.getView().status.window).toBe(32_768)

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })

  test('**开机空态**：还没有用量就不报用量——不写一个伪造的 `0/…`', () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const shell = shellOf(assembly)
      const status = shell.getView().status

      // 分母在（1M），但分子还没有 ⇒ ④ 整格不出现（`usageLabel` 直接返回 null）
      expect(status.window).toBe(1_000_000)
      expect(status.usage).toBeNull()
      expect(usageLabel(status.usage, status.window)).toBeNull()

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 三 · 旧路径原样（这一位没接线时）——接线落齐之前的行为，别当规格
// ═══════════════════════════════════════════════════════════════════════

describe('U30 · 没给窗长表时（未接线）', () => {
  test('切换**不动分母**——只认开机那一格（旧行为一字不改）', async () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const options = tuiOptions(assembly)
      // 表没传（＝`run.ts` 那一跳还没接上）：旧路径
      const shell = createShell(assembly.shell, { contextWindow: options.contextWindow })
      await warm(assembly)

      expect(shell.getView().status.window).toBe(1_000_000)
      expect(assembly.switchModel({ provider: 'mm2' }).ok).toBe(true)
      // 分母没跟着换（表不在手上，查不了）——如实记：这是接线缺口的样子，不是规格
      expect(shell.getView().status.window).toBe(1_000_000)

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })
})

/** 事件流里有没有那条 kind（判别式收窄用）。 */
function kinds(events: readonly KernelEvent[]): string[] {
  return events.map((event) => event.kind)
}

describe('U30 · 事件面（不顺带扩张）', () => {
  test('换模型只发 `model.switched` 一条——不发 `model.catalog`、不开会话、不加新 kind', async () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const shell = shellOf(assembly)
      await warm(assembly)

      const handle = attachShell(assembly.shell)
      const before = handle.events.length
      expect(assembly.switchModel({ provider: 'mm2' }).ok).toBe(true)
      const fresh = handle.events.slice(before)

      expect(kinds(fresh)).toEqual(['model.switched'])

      handle.dispose()
      shell.dispose()
      assembly.close()

      // 会话只有开头那一句开张的**一条**——切换不提前建会话、读面不发命令
      const db = readDatabase(assembly.paths.database)
      expect(db.sessions).toHaveLength(1)
      expect(db.events.map((event) => event.kind)).not.toContain('model.catalog')
      db.close()
    } finally {
      land.dispose()
    }
  })
})
