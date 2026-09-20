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
 * **真外壳**——只有端点换成假的。域内那半（怎么判定、怎么装表）钉在 `@magic/model` 的用例里。
 *
 * **两条接线**，别混：
 * - 前两组从 `tuiOptions` **取件**递进 `createShell`（照 `readouts.test.ts` 的先例：
 *   自己照接一遍就只咬住半边）；
 * - 末一组走**真 `runTui`**（产品那条路本身）——屏上的字从 `runTui` 写出的**字节**里读，
 *   不是「同表达式手工接一遍」。
 */

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EventStamper, KernelEvent, ModelGateway } from '@magic/contracts'
import { createFauxGateway } from '@magic/faux'
import { windowOfSelection } from '@magic/model'
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
  /**
   * **同名模型的另一条**（`mm2` 挂的也是 `MiniMax-M2`）——规划侧点名的那一形：
   * 合法的两个端点可以给同名模型不同的窗长，声明**不许串到这一条头上**。
   */
  'mm-same': { baseURL: 'https://mm-same.example/v1', apiKey: KEY, model: 'MiniMax-M2' },
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
    windowTable: options.windowTable,
  })
}

/**
 * 窗长表的形态——**从 `tuiOptions` 的返回值上取**（`@magic/tui` 没把这个类型出到包外；
 * 结构类型认形状，不必 import）。
 */
type WindowTable = NonNullable<ReturnType<typeof tuiOptions>['windowTable']>

/**
 * `tuiOptions` 给的那张窗长表——`RunTuiOptions` 里这一位是可选位（真装配一定给），
 * 拆包时把「没给」当场当失败：**接线断了要红在接线那一句上**，不是红在后面对比的数上。
 */
function tableOf(assembly: Assembly): WindowTable {
  const table = tuiOptions(assembly).windowTable
  if (table === undefined) throw new Error('tuiOptions 没给窗长表——接线断了')

  return table
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

  test('**窗长表**经装配给到外壳：内置表原样 ＋ 声明**按条目装**，未知的**连键都不在**', () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const table = tableOf(assembly)

      // 内置表：按准确模型 id（与条目无关）——换到哪一格都查得到
      expect(table.builtin['MiniMax-M3']).toBe(1_000_000)
      expect(table.builtin['MiniMax-M2.5']).toBe(204_800)
      // 声明：挂在它那条目上（`mm2` 声明了「我这个 MiniMax-M2 是 32768」）
      expect(table.declared['mm2']).toEqual({ model: 'MiniMax-M2', window: 32_768 })
      // 没声明的条目**连键都不在**（不是 `{}` 占位）
      expect('mm' in table.declared).toBe(false)
      // 不知道的模型在内置表里也没有（≠ 0）——消费时 `?? null` 即「不知道」
      expect('my-local-llama' in table.builtin).toBe(false)

      assembly.close()
    } finally {
      land.dispose()
    }
  })

  /**
   * **同名模型跨条目**（规划侧打回重做的那一条）——口径**钉住**：
   * 声明只属于配置它的条目及对应模型，**不按模型名全局生效**。
   *
   * 由头：合法的两个端点可以给同名模型不同的窗长（本地部署量化过 / 网关另有一层裁法），
   * 一条声明盖到另一条头上＝**报错一个数**（比不报更坏）。
   */
  test('同名模型两条目：声明**不串味**——各是各的', () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const table = tableOf(assembly)
      const lookup = (provider: string) =>
        windowOfSelection(table, { provider, model: 'MiniMax-M2' })

      // 声明的那条：用它声明的数；同名模型的另一条：内置表那个数
      expect(lookup('mm2')).toBe(32_768)
      expect(lookup('mm-same')).toBe(204_800)
      // 内置表**没被声明改写**（它是模型的客观属性）
      expect(table.builtin['MiniMax-M2']).toBe(204_800)

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
      expect(options.windowTable).toEqual({ builtin: {}, declared: {} })

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

  /**
   * **同名模型跨条目**（规划侧打回重做的那一条）——在**真链路**上验：
   * 声明过 `MiniMax-M2` 的那条目用 32768，挂**同一个模型**的另一条目用内置表的 204800。
   */
  test('同名模型两条目：换到哪条就报哪条的——声明不串味', async () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const shell = shellOf(assembly)
      await warm(assembly)

      // 声明的那条（32768）
      expect(assembly.switchModel({ provider: 'mm2' }).ok).toBe(true)
      expect(shell.getView().status.model).toBe('MiniMax-M2')
      expect(shell.getView().status.window).toBe(32_768)

      // **同名模型**的另一条：内置表那个数（不是上一步的 32768）
      expect(assembly.switchModel({ provider: 'mm-same' }).ok).toBe(true)
      expect(shell.getView().status.model).toBe('MiniMax-M2')
      expect(shell.getView().status.window).toBe(204_800)

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
// 三 · 老路径（调用方没给这张表时）——别当规格
// ═══════════════════════════════════════════════════════════════════════

describe('U30 · 没给窗长表时', () => {
  test('切换**不动分母**——只认开机那一格（老路径一字不改）', async () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const options = tuiOptions(assembly)
      // 表没传：老路径
      const shell = createShell(assembly.shell, { contextWindow: options.contextWindow })
      await warm(assembly)

      expect(shell.getView().status.window).toBe(1_000_000)
      expect(assembly.switchModel({ provider: 'mm2' }).ok).toBe(true)
      // 表不在手上 ⇒ 查不了 ⇒ 分母原样（不是「查到了旧模型那个数」）
      expect(shell.getView().status.window).toBe(1_000_000)

      shell.dispose()
      assembly.close()
    } finally {
      land.dispose()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 四 · **真 `runTui` 那条路**——接线本身在不在（屏上的字从字节里读）
// ═══════════════════════════════════════════════════════════════════════
//
// 前三组是「取件 + 递进 `createShell`」：能钉住**给的值对不对**，钉不住
// **`runTui` 那一跳把值传下去了没有**（那是产品真走的一行）。这一组走真 `runTui`：
// 真装配 → `tuiOptions` → `runTui` → 外壳 → Ink 写出字节 → 从字节里剥出屏上的字。
//
// ⚠️ 剥 ANSI 是本文件里的**最小**一份（取景层那一套在 tui 侧；跨包相对引用会被
// 结构守护拦下——`test/scaffold.test.ts`「各包源码的引用不越出包边界」）。
// 这里只量「那一格的字在不在」，不量布局与色——那些归 tui 侧的取景层。

/** 剥掉 CSI / OSC 转义序列——只为在字节里认那几段字。 */
function visible(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9:;<=>?]*[@-~]/g, '')
}

/** 假终端——记下写出的每一个字节（`runTui` 只查 `isTTY`；Ink 要窗口尺寸）。 */
class CaptureTty extends EventEmitter {
  readonly isTTY = true
  readonly destroyed = false
  readonly writableEnded = false
  readonly columns = 100
  readonly rows = 30
  private readonly chunks: string[] = []

  write = (chunk: string): boolean => {
    this.chunks.push(String(chunk))
    return true
  }

  /** 此刻写出去的全部字节。 */
  bytes(): string {
    return this.chunks.join('')
  }
}

/**
 * 假 stdin——`runTui` 只查 `isTTY`；Ink 要一个流才肯挂。
 *
 * ⚠️ **喂键的姿势**（本仓第一次在用例里真喂键，记一笔）：Ink **不**监听 `'data'`，
 * 它挂 `'readable'` 然后 `while ((chunk = stdin.read()) !== null)` 取件
 * （`ink/build/components/App.js`）——故假流得**攒队列 ＋ 报 `readable`**，
 * 直接 `emit('data', …)` 一个字节都到不了 `useInput`（实测：ctrl+c 发不出去，
 * `waitUntilExit()` 永远不返回，用例卡到超时）。
 */
class FakeStdin extends EventEmitter {
  readonly isTTY = true
  private queue: string[] = []
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => this.queue.shift() ?? null

  /** 敲一个键（Ink 那一侧当它是终端上来的字节）。 */
  push(text: string): void {
    this.queue.push(text)
    this.emit('readable')
  }
}

/** 等屏上出现这段话（Ink 按 30fps 写档，给它几帧的余地）；等不到就如实报出此刻的屏。 */
async function until(tty: CaptureTty, needle: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (visible(tty.bytes()).includes(needle)) return
    await Bun.sleep(10)
  }

  throw new Error(`等不到「${needle}」——此刻屏上是：\n${visible(tty.bytes())}`)
}

describe('U30 · 真 `runTui` 那条路（接线在不在）', () => {
  test('换模型之后 **屏上那个分母**当场跟着换——经产品那一路走出来的', async () => {
    const land = stage()

    try {
      const assembly = land.assemble()
      const tty = new CaptureTty()
      const stdin = new FakeStdin()
      // 动态 import：与 `cli.ts` 同一条（启动路径不把 Ink 那棵树拖进模块图）
      const { runTui } = await import('@magic/tui')

      const handle = await runTui({
        ...tuiOptions(assembly),
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: tty as unknown as NodeJS.WriteStream,
      })

      // 真跑一句：命令经控制面直发（与手打一条同一路径）——④ 有分子、③ 有模型名
      const driver = attachShell(assembly.shell)
      await driver.submit('看下这个项目')
      driver.dispose()

      await until(tty, '3.1k/1000k') // M3 ⇒ 内置表 1M

      // 真换（经装配那条产出路径）⇒ 屏上换成新模型那个数
      expect(assembly.switchModel({ provider: 'mm-same' }).ok).toBe(true)
      await until(tty, '3.1k/205k')

      // 再换到未知模型 ⇒ 分母从屏上下去（只剩分子，没有那个斜杠）
      expect(assembly.switchModel({ provider: 'local' }).ok).toBe(true)
      await until(tty, 'my-local-llama · 3.1k')

      // 收摊：空闲时 ctrl+c ＝ 退出（与手打一致——键经 Ink 那条路真走一遍）
      stdin.push('\u0003')
      await handle.waitUntilExit()

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
