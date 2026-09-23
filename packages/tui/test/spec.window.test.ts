/**
 * **④ 的分母跟不跟得上** —— 规格即测试（外壳那半）。
 *
 * 出处：`交接/工单/U30.md`（依据 `进度台账` 的「换模型分母滞后」）；缺陷原样：
 * `model.switched` 只换 ③，④ 还是**前一个模型**的分母 ⇒ 屏上「新分子配旧分母」。
 *
 * ## 2026-09-23（U41 返修）**换了机制，判据一条没松**
 *
 * - **原锚**：外壳拿装配递进来的**窗长表**（`registry.windowTable → assembly → tui`）
 *   按「条目 ＋ 模型」自己查；表外＝未知。
 * - **为何变**：那条链是**第二份容量算法**（内核 `capacityOf` 那次解析才是正身），
 *   而它算出来的数**与出站 / 用量 / 压缩不同源**——复核点名「必须用同一有效读数服务请求、
 *   显示和压缩」。故旧链**整个撤掉**，分母改由**产生处**给：
 *   `model.switched.inputBudget` / `model.call.start.inputBudget` /
 *   `model.catalog.currentInputBudget`（三处都与 `Assembly.contextWindow` 同源）。
 * - **新锚**：同一条规格——**换过去那一刻分母就换**、**未知＝清空**、**没换成＝原样不动**、
 *   真跑用谁（`model.call.start`）也定分母——只是数由**事件带着来**，不再由外壳查表。
 *
 * ⚠️ 顺带撤掉的两条（它们钉的是**旧链**，不是规格）：老路径「调用方没给表时一个数都不改」、
 * 以及「查表只认自有键，`toString` 不当模型名」——后者是**外壳查表**才有的风险；
 * 现在数值来自内核，外壳一个键都不查（用例改钉「内核没给 ⇒ 清空」）。
 *
 * 取景沿用 U24/U20 那一套（真外壳 → 真终端 → 读屏）：`show()` 画一屏回来读状态行。
 */

import { describe, expect, test } from 'bun:test'
import { createShell } from '../src/shell.ts'
import type { ShellOptions } from '../src/shell.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
import { show } from './screen.ts'

const WIDE = { columns: 80, rows: 24 } as const

/** 起一个真壳（开机那一格按用例给），并把「投事件 → 读屏」两件包好。 */
function stage(seeded: ShellOptions = {}) {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport, seeded)

  return {
    shell,
    feed: (events: readonly Parameters<typeof spy.emit>[0][]): void => {
      for (const item of events) spy.emit(item)
    },
    /** 此刻的一屏（真终端回放）。 */
    screen: () => show([shell.getView()], WIDE, null),
  }
}

/** 一句已用量的底子（`3.1k`——原型状态行 ④ 的样例数）。 */
const used = (inputTokens = 3_100) => event('model.usage', { inputTokens, outputTokens: 40 })

/** 一次**真跑**（分母随之落定）——`inputBudget` 就是那一刻的有效输入预算。 */
const ran = (model: string, provider: string, inputBudget?: number) =>
  event('model.call.start', {
    model,
    provider,
    ...(inputBudget === undefined ? {} : { inputBudget }),
  })

// ═══════════════════════════════════════════════════════════════════════
// 一 · 换过去那一刻：分母跟着新模型走
// ═══════════════════════════════════════════════════════════════════════

describe('换过模型之后的分母', () => {
  test('已知 ⇒ 另一已知：③ 换成新模型，④ 的分母当场换成**新模型**那个数', async () => {
    const land = stage({ contextWindow: 1_000_000 })
    land.feed([ran('MiniMax-M3', 'mm', 1_000_000), used()])

    // 换之前：M3 的 1M（`windowLabel` 把 1,000,000 写成 `1000k`）
    expect((await land.screen()).statusLine).toContain('3.1k/1000k')

    // 切到另一个模型——**切换事件自己带着那个模型的预算**（32_768 ⇒ `33k`）
    land.feed([event('model.switched', { ok: true, provider: 'mm2', model: 'MiniMax-M2', inputBudget: 32_768 })])

    const after = await land.screen()
    expect(after.statusLine).toContain('MiniMax-M2')
    expect(after.statusLine).toContain('3.1k/33k')
    expect(after.statusLine).not.toContain('1000k')
    // 回执照旧（「刚发生的事」进记录区）
    expect(after.has('· 已换模型 → MiniMax-M2')).toBe(true)

    land.shell.dispose()
  })

  test('已知 ⇒ 未知：分母变**没有**（只剩分子）——不沿用前一个模型的容量', async () => {
    const land = stage({ contextWindow: 1_000_000 })
    land.feed([ran('MiniMax-M3', 'mm', 1_000_000), used()])

    // **内核没给这一位**＝那条模型没有窗长依据（不是「和上一个一样」）
    land.feed([event('model.switched', { ok: true, provider: 'local', model: 'my-local-llama' })])

    const after = await land.screen()
    expect(after.statusLine).toContain('3.1k')
    expect(after.statusLine).not.toContain('3.1k/') // 没有分母就不写那个斜杠
    expect(after.statusLine).not.toContain('1000k') // 更不能凭空留着上一个的数
    expect(land.shell.getView().status.window).toBeNull()

    land.shell.dispose()
  })

  test('**没给**这一位当未知——不管那个模型名长什么样（`toString` 也一样）', async () => {
    // 旧链要防「查表摸到 `Object.prototype`」；现在数值来自内核，外壳一个键都不查——
    // 这条改钉「内核没给就清空」，与上一条同一条规格，只换几个名字。
    const land = stage({ contextWindow: 1_000_000 })
    land.feed([ran('MiniMax-M3', 'mm', 1_000_000), used()])

    for (const name of ['toString', 'constructor', '__proto__', 'MiniMax-M9']) {
      land.feed([event('model.switched', { ok: true, provider: 'mm', model: name })])
      expect(land.shell.getView().status.window).toBeNull()
    }

    const after = await land.screen()
    expect(after.statusLine).toContain('3.1k')
    expect(after.statusLine).not.toContain('3.1k/')

    land.shell.dispose()
  })

  test('**没换成**：读数原样不动（切不动就不动）＋ 一行缘由', async () => {
    const land = stage({ contextWindow: 1_000_000 })
    land.feed([ran('MiniMax-M3', 'mm', 1_000_000), used()])

    land.feed([event('model.switched', { ok: false, reason: '未知供应商「ghost」' })])

    const after = await land.screen()
    expect(after.statusLine).toContain('3.1k/1000k')
    expect(after.has('· 换模型未成：未知供应商「ghost」')).toBe(true)
    expect(land.shell.getView().status.model).toBe('MiniMax-M3')

    land.shell.dispose()
  })

  test('**真跑用谁**（`model.call.start`）也定分母——空手先换过的那种由此走上正轨', async () => {
    const land = stage({ contextWindow: 1_000_000 })
    // 开机那一格是 M3 的 1M（外壳那时还不知道模型名），真跑用的是另一个模型（204_800）
    land.feed([ran('MiniMax-M2', 'mm', 204_800), used()])

    const after = await land.screen()
    expect(after.statusLine).toContain('3.1k/205k')
    expect(land.shell.getView().status.model).toBe('MiniMax-M2')

    land.shell.dispose()
  })

  test('真跑那一次**没给**预算 ⇒ 清空（不拿开机那一格顶着）', async () => {
    const land = stage({ contextWindow: 1_000_000 })
    land.feed([ran('my-local-llama', 'local'), used()])

    expect(land.shell.getView().status.window).toBeNull()
    expect((await land.screen()).statusLine).not.toContain('1000k')

    land.shell.dispose()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 二 · 开机空态：一个字都不多
// ═══════════════════════════════════════════════════════════════════════

describe('开机空态（不趁机扩张）', () => {
  test('还没有用量：④ 整格不出现——**不写一个伪造的 `0/…`**', async () => {
    const land = stage({ contextWindow: 1_000_000 })

    const frame = await land.screen()

    expect(frame.statusLine).toContain('○ 空闲')
    expect(frame.statusLine).not.toContain('0/') // 没有分子可编
    expect(frame.statusLine).not.toContain('1000k') // 有分母也不先摆出来
    // ③ 也不凭空报（开机没有模型名——那是「配置」，不是「状态」）
    expect(land.shell.getView().status.model).toBeNull()

    land.shell.dispose()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 三 · 读面那一屏：分母按 `current` 给（**不拿某一行推算**）
// ═══════════════════════════════════════════════════════════════════════

describe('`model.catalog` 那一格', () => {
  /** 一屏目录：一行是**连接默认**的读数，另一格是**当前选择**的读数。 */
  const catalog = (currentInputBudget?: number) =>
    event('model.catalog', {
      entries: [
        {
          provider: 'ds',
          vendor: 'deepseek',
          model: 'deepseek-chat',
          // ⚠️ 这一格是**该连接默认模型**的数——当前选中是另一个模型时**不许**拿它顶上
          contextWindow: 999_000,
        },
      ],
      current: { provider: 'ds', model: 'deepseek-reasoner' },
      ...(currentInputBudget === undefined ? {} : { currentInputBudget }),
    })

  test('答复给了 `currentInputBudget` ⇒ 用它（**不是** entries 那一行的数）', async () => {
    const land = stage()
    land.feed([used(), catalog(29_000)])

    expect((await land.screen()).statusLine).toContain('3.1k/29k')
    expect((await land.screen()).statusLine).not.toContain('999k')

    land.shell.dispose()
  })

  test('答复**没给** ⇒ 清空——绝不从默认那一行推算（拿错型号就是一个假数）', async () => {
    const land = stage({ contextWindow: 1_000_000 })
    land.feed([used(), catalog()])

    const after = await land.screen()
    expect(land.shell.getView().status.window).toBeNull()
    expect(after.statusLine).not.toContain('999k') // 默认行那个数与当前选择无关
    expect(after.statusLine).not.toContain('1000k') // 也不留着开机那个

    land.shell.dispose()
  })
})
