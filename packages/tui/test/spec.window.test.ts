/**
 * U30 · **换过模型之后 ④ 的分母跟不跟得上** —— 规格即测试（外壳那半）。
 *
 * 出处：`交接/工单/U30.md`（依据 `进度台账` 的「换模型分母滞后」）。
 * 缺陷原样（本单元开跑时实测）：`model.switched` 只换 ③，④ 还是**前一个模型**的分母——
 * 于是屏上出现「新分子配旧分母」。
 *
 * 规格三条（逐条有用例）：
 *
 * 1. **换过去那一刻分母就换**——新模型多长**查表**；两条来路都算数
 *    （换供应商 / 只换模型），`model.call.start`（真跑用谁）同此；
 * 2. **查不到＝`null`**——不知道就说不知道，**不沿用**换之前那个模型的容量，
 *    屏上回退成只报已用量（`3.1k`，没有那个斜杠）；
 * 3. **没换成则原样不动**——切不动就不动（读数与选中一样保持现状）。
 *
 * 另有一条**老路径**的用例：没给窗长表时**一个数都不改**（分母只认开机那一格与条目表答复）——
 * 那是给「调用方没提供这张表」的场合留的退路，不是第二条规格。
 *
 * 取景沿用 U24/U20 那一套（真外壳 → 真终端 → 读屏）：`show()` 画一屏回来读状态行。
 */

import { describe, expect, test } from 'bun:test'
import { createShell } from '../src/shell.ts'
import type { ShellOptions } from '../src/shell.ts'
import type { WindowTable } from '../src/view.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
import { show } from './screen.ts'

const WIDE = { columns: 80, rows: 24 } as const

/**
 * 一份**真表**（内置容量表 ＋ 两条**按条目装**的声明）——数取自官方模型表，
 * 与装配递给外壳的那张同形（见 `@magic/model` 的 `WindowTable`）。
 *
 * `mm2` 声明了 `MiniMax-M2` 的另一种窗长（32,768），而 `mm` 挂的是**同一个模型**
 * ——两个条目的答案必须**各是各的**（跨条目不许串味）。
 */
const TABLE: WindowTable = {
  builtin: { 'MiniMax-M3': 1_000_000, 'MiniMax-M2': 204_800 },
  declared: {
    mm2: { model: 'MiniMax-M2', window: 32_768 },
    'mm-declared': { model: 'declared-model', window: 131_072 },
  },
}

/** 起一个真壳（表按用例给），并把「投事件 → 读屏」两件包好。 */
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

// ═══════════════════════════════════════════════════════════════════════
// 一 · 换过去那一刻：分母跟着新模型走
// ═══════════════════════════════════════════════════════════════════════

describe('U30 · 换过模型之后的分母', () => {
  test('已知 ⇒ 另一已知：③ 换成新模型，④ 的分母当场换成**新模型**那个数', async () => {
    const land = stage({ contextWindow: 1_000_000, windowTable: TABLE })
    land.feed([event('model.call.start', { model: 'MiniMax-M3', provider: 'mm' }), used()])

    // 换之前：M3 的 1M（`windowLabel` 把 1,000,000 写成 `1000k`）
    expect((await land.screen()).statusLine).toContain('3.1k/1000k')

    land.feed([event('model.switched', { ok: true, provider: 'mm2', model: 'MiniMax-M2' })])

    const after = await land.screen()
    expect(after.statusLine).toContain('MiniMax-M2')
    // `mm2` 给这个模型声明过 32768 ⇒ 报它声明的那个数（内置表的 204800 让位）
    expect(after.statusLine).toContain('3.1k/33k')
    expect(after.statusLine).not.toContain('1000k')
    // 回执照旧（「刚发生的事」进记录区）
    expect(after.has('· 已换模型 → MiniMax-M2')).toBe(true)

    land.shell.dispose()
  })

  test('已知 ⇒ 未知：分母变**没有**（只剩分子）——不沿用前一个模型的容量', async () => {
    const land = stage({ contextWindow: 1_000_000, windowTable: TABLE })
    land.feed([event('model.call.start', { model: 'MiniMax-M3', provider: 'mm' }), used()])

    land.feed([event('model.switched', { ok: true, provider: 'local', model: 'my-local-llama' })])

    const after = await land.screen()
    expect(after.statusLine).toContain('3.1k')
    expect(after.statusLine).not.toContain('3.1k/') // 没有分母就不写那个斜杠
    expect(after.statusLine).not.toContain('1000k') // 更不能凭空留着上一个的数
    expect(land.shell.getView().status.window).toBeNull()

    land.shell.dispose()
  })

  test('**只换模型**（同一条目）：查内置表——该条目原先那个数不跟过去', async () => {
    const land = stage({ contextWindow: 1_000_000, windowTable: TABLE })
    land.feed([event('model.call.start', { model: 'MiniMax-M3', provider: 'mm' }), used()])

    land.feed([event('model.switched', { ok: true, provider: 'mm', model: 'MiniMax-M2' })])
    expect((await land.screen()).statusLine).toContain('3.1k/205k')

    // 换到表外的模型名 ⇒ 不知道（同条目那个数也不顶上去）
    land.feed([event('model.switched', { ok: true, provider: 'mm', model: 'MiniMax-M9' })])
    expect((await land.screen()).statusLine).not.toContain('205k')

    land.shell.dispose()
  })

  test('**用户名下的声明**在它自己条目上算数（表里没有的模型也照报）', async () => {
    const land = stage({ contextWindow: 1_000_000, windowTable: TABLE })
    land.feed([event('model.call.start', { model: 'MiniMax-M3', provider: 'mm' }), used()])

    // `mm-declared` 这个条目声明了「我这个模型是 131072」——内置表根本不认得这个模型名
    land.feed([event('model.switched', { ok: true, provider: 'mm-declared', model: 'declared-model' })])

    expect((await land.screen()).statusLine).toContain('3.1k/131k')

    land.shell.dispose()
  })

  /**
   * **同名模型跨条目**（规划侧打回重做的那一条）：`mm2` 给 `MiniMax-M2` 声明了 32768，
   * 而 `mm` 挂的是**同一个模型**——轮到 `mm` 时**不许认那份声明**，按内置表报 204800。
   */
  test('**同名模型在别的条目**：声明不串味——各查各的', async () => {
    const land = stage({ contextWindow: 1_000_000, windowTable: TABLE })
    land.feed([event('model.call.start', { model: 'MiniMax-M3', provider: 'mm' }), used()])

    // 声明的那一条目：报它声明的数
    land.feed([event('model.switched', { ok: true, provider: 'mm2', model: 'MiniMax-M2' })])
    expect((await land.screen()).statusLine).toContain('3.1k/33k')

    // 换到**同名模型**的另一条目：内置表那个数（不是上一步那个 33k）
    land.feed([event('model.switched', { ok: true, provider: 'mm', model: 'MiniMax-M2' })])
    const after = await land.screen()
    expect(after.statusLine).toContain('3.1k/205k')
    expect(after.statusLine).not.toContain('33k')

    land.shell.dispose()
  })

  /**
   * **原型上有名字的模型名 / 条目名**（验收边界）：查表只认自有键——
   * 否则 `'toString'` 会读成 `Object.prototype.toString`（函数），分母当场变成一个函数 ✗。
   */
  test('`toString` 这类模型名 ⇒ 当未知（分母没有，不留原型上那个东西）', async () => {
    const land = stage({ contextWindow: 1_000_000, windowTable: TABLE })
    land.feed([event('model.call.start', { model: 'MiniMax-M3', provider: 'mm' }), used()])

    for (const name of ['toString', 'constructor', '__proto__']) {
      land.feed([event('model.switched', { ok: true, provider: 'mm', model: name })])
      expect(land.shell.getView().status.window).toBeNull()
    }

    const after = await land.screen()
    expect(after.statusLine).toContain('3.1k')
    expect(after.statusLine).not.toContain('3.1k/') // 没有分母就不写那个斜杠

    land.shell.dispose()
  })

  test('`toString` 这类**条目名** ⇒ 不摸原型，照查内置表（模型名对得上就给数）', async () => {
    const land = stage({ contextWindow: 1_000_000, windowTable: TABLE })
    land.feed([event('model.call.start', { model: 'MiniMax-M3', provider: 'mm' }), used()])

    land.feed([event('model.switched', { ok: true, provider: 'toString', model: 'MiniMax-M2' })])

    expect(land.shell.getView().status.window).toBe(204_800)
    expect((await land.screen()).statusLine).toContain('3.1k/205k')

    land.shell.dispose()
  })

  test('**没换成**：读数原样不动（切不动就不动）＋ 一行缘由', async () => {
    const land = stage({ contextWindow: 1_000_000, windowTable: TABLE })
    land.feed([event('model.call.start', { model: 'MiniMax-M3', provider: 'mm' }), used()])

    land.feed([event('model.switched', { ok: false, reason: '未知供应商「ghost」' })])

    const after = await land.screen()
    expect(after.statusLine).toContain('3.1k/1000k')
    expect(after.has('· 换模型未成：未知供应商「ghost」')).toBe(true)
    expect(land.shell.getView().status.model).toBe('MiniMax-M3')

    land.shell.dispose()
  })

  test('**真跑用谁**（`model.call.start`）也定分母——空手先换过的那种由此走上正轨', async () => {
    const land = stage({ contextWindow: 1_000_000, windowTable: TABLE })
    // 开机那一格是 M3 的 1M（外壳那时还不知道模型名），真跑用的是另一条目的 M2
    land.feed([event('model.call.start', { model: 'MiniMax-M2', provider: 'mm' }), used()])

    // 真跑那条是 `mm`（没声明过）⇒ 内置表那个数
    expect((await land.screen()).statusLine).toContain('3.1k/205k')

    land.shell.dispose()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 二 · 开机空态：一个字都不多
// ═══════════════════════════════════════════════════════════════════════

describe('U30 · 开机空态（不趁机扩张）', () => {
  test('还没有用量：④ 整格不出现——**不写一个伪造的 `0/…`**', async () => {
    const land = stage({ contextWindow: 1_000_000, windowTable: TABLE })

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
// 三 · 老路径——调用方没给这张表时，一个数都不改
// ═══════════════════════════════════════════════════════════════════════

describe('U30 · 没给窗长表时', () => {
  test('切换**不动分母**——老路径一字不改（不是第二条规格）', async () => {
    const land = stage({ contextWindow: 1_000_000 })
    land.feed([event('model.call.start', { model: 'MiniMax-M3', provider: 'mm' }), used()])
    land.feed([event('model.switched', { ok: true, provider: 'mm2', model: 'MiniMax-M2' })])

    const after = await land.screen()
    // ③ 换了、④ 还停在旧分母——这正是本单元要收掉的那条缺陷的形状
    expect(after.statusLine).toContain('MiniMax-M2')
    expect(after.statusLine).toContain('3.1k/1000k')

    land.shell.dispose()
  })
})
