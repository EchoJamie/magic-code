/**
 * 步骤清单的**排版与视口**（U34 · 界面线）——纯函数那一层的判据。
 *
 * 两处都在这儿钉住，因为它们是**别处都拿不到的两笔账**：
 * - **预算**：动态区的余量怎么分给回复与清单（分错就是「清单把正文挤没了」）；
 * - **视口**：放不下时显示哪几行、翻一页到哪（翻错就是「有几步怎么翻都看不到」）。
 *
 * 屏上长什么样（方块、颜色、呼吸）不在这条路上——那要看帧（`spec.u34-tui.test.ts`）。
 */

import { describe, expect, test } from 'bun:test'
import {
  BREATH_MS,
  MARK_WIDTH,
  PLAN_KEEP_LINES,
  breathColor,
  breathOf,
  planBudgetOf,
  planMoreLabel,
  planMoreLine,
  planScrolled,
  planWindow,
  stepLines,
} from '../src/plan.ts'

// ══ 预算：给回复留够，其余给清单 ═════════════════════════════════════

describe('动态区余量的分配', () => {
  test('余量比「留给回复的那几行」还少时，清单一行都不占', () => {
    expect(planBudgetOf(0)).toBe(0)
    expect(planBudgetOf(1)).toBe(0)
    expect(planBudgetOf(PLAN_KEEP_LINES)).toBe(0)
  })

  test('扣掉留给回复的那几行，剩下的全给清单', () => {
    expect(planBudgetOf(10)).toBe(10 - PLAN_KEEP_LINES)
    expect(planBudgetOf(40)).toBe(40 - PLAN_KEEP_LINES)
  })
})

// ══ 一条步骤的折行 ═══════════════════════════════════════════════════

describe('步骤文字折行', () => {
  test('折的是文字那一截——方块那一格（两列）留出来', () => {
    // 10 列里文字占 8 列：`1234567890` 十列，折成 8 ＋ 2
    expect(stepLines('1234567890', 10)).toEqual(['12345678', '90'])
  })

  test('中文按两列算（与记录区同一把尺子）', () => {
    // 6 列里文字占 4 列：一行放得下两个汉字，第三个起折行
    expect(stepLines('一二三四五', 6)).toEqual(['一二', '三四', '五'])
  })

  test('Tab 按终端的规矩展开后再折（同一个 `\\t` 只该有一个宽度）', () => {
    expect(stepLines('a\tb', 12)).toEqual(['a       b'])
  })

  test('极窄窗口不把宽度算成 0 或负数', () => {
    expect(stepLines('ab', 1)).toEqual(['a', 'b'])
    expect(stepLines('ab', 0).length).toBeGreaterThan(0)
  })

  test('方块那一格是两列——与记录区的行首标记同宽', () => {
    expect(MARK_WIDTH).toBe(2)
  })
})

// ══ 行视口 ═══════════════════════════════════════════════════════════

describe('行视口', () => {
  test('放得下 ⇒ 全显示，且**不起提示行**', () => {
    const window = planWindow(3, 5, 0)

    expect(window).toEqual({ total: 3, top: 0, visible: 3, hiddenAbove: 0, hiddenBelow: 0 })
    // 提示行占的那一格只在溢出时花掉——正好放下时不该少显示一行
    expect(planWindow(5, 5, 0)?.visible).toBe(5)
  })

  test('放不下 ⇒ 留下一行给提示，其余归步骤', () => {
    const window = planWindow(20, 6, 0)

    expect(window?.visible).toBe(5)
    expect(window?.hiddenBelow).toBe(15)
    expect(window?.hiddenAbove).toBe(0)
  })

  test('视口位置夹在两头之间（计划变短、窗口变小都不留在半空）', () => {
    expect(planWindow(20, 6, 999)?.top).toBe(15)
    expect(planWindow(20, 6, -5)?.top).toBe(0)
    // 计划变短之后：夹到新的末尾，而不是停在一个空行号上
    expect(planWindow(6, 6, 99)?.top).toBe(0)
  })

  test('滚到底 ⇒ 上面的行数如实报出来，下面归零', () => {
    const window = planWindow(20, 6, 15)

    expect(window?.hiddenAbove).toBe(15)
    expect(window?.hiddenBelow).toBe(0)
  })

  test('没有清单 / 没地方 / 只剩一行（给不出视口）⇒ 一行都不画', () => {
    expect(planWindow(0, 10, 0)).toBeNull()
    expect(planWindow(3, 0, 0)).toBeNull()
    // budget 1：提示行要一格、步骤要一格——挤不下就不画（极矮窗口暂不绘清单）
    expect(planWindow(3, 1, 0)).toBeNull()
  })
})

describe('翻页', () => {
  test('一页 ＝ 这一窗显示的那几行（不是「屏高」——提示行已经扣过了）', () => {
    const window = planWindow(20, 6, 0)
    if (window === null) throw new Error('这一窗该有')

    expect(planScrolled(window, 1)).toBe(5)
  })

  test('到两头就停住（再按没有反应）', () => {
    const bottom = planWindow(20, 6, 99)
    if (bottom === null) throw new Error('这一窗该有')

    expect(planScrolled(bottom, 1)).toBe(bottom.top)
    expect(planScrolled(bottom, -1)).toBe(bottom.top - bottom.visible)

    const top = planWindow(20, 6, 0)
    if (top === null) throw new Error('这一窗该有')
    expect(planScrolled(top, -1)).toBe(0)
  })

  test('翻得动：从顶翻到底，每一页都落在整数个可见行上', () => {
    const first = planWindow(20, 6, 0)
    if (first === null) throw new Error('这一窗该有')

    const second = planWindow(20, 6, planScrolled(first, 1))
    expect(second?.top).toBe(5)

    const third = planWindow(20, 6, planScrolled(second ?? first, 1))
    expect(third?.top).toBe(10)

    // 最后一页：`top` 顶到 15，且**下面没有剩余的行**（所有步骤都翻到了）
    const last = planWindow(20, 6, planScrolled(third ?? first, 1))
    expect(last?.top).toBe(15)
    expect(last?.hiddenBelow).toBe(0)
  })
})

describe('溢出提示那一行', () => {
  test('只报真还有的那一头', () => {
    expect(planMoreLabel(0, 4)).toBe('下面还有 4 行 · PgUp/PgDn 翻页')
    expect(planMoreLabel(3, 0)).toBe('上面还有 3 行 · PgUp/PgDn 翻页')
    expect(planMoreLabel(3, 4)).toBe('上面 3 行 · 下面 4 行 · PgUp/PgDn 翻页')
  })

  test('窄窗截断——行数在前（先丢的是那句键位）', () => {
    const short = planMoreLine(12, 0, 20)

    expect(short.endsWith('…')).toBe(true)
    expect(short).toContain('12 行')
    expect(short).not.toContain('PgUp')
    // 再窄就只剩「还有几行」这半句了——**仍然是截断，不是折行**（折了账就少一行）
    expect(planMoreLine(12, 0, 12)).toBe('上面还有 12…')
  })

  test('宽窗一个字都不截', () => {
    expect(planMoreLine(3, 4, 80)).toBe('上面 3 行 · 下面 4 行 · PgUp/PgDn 翻页')
  })
})

// ══ 呼吸 ═════════════════════════════════════════════════════════════

describe('进行中那一格的呼吸', () => {
  test('一轮两秒；两端最暗、中点最亮', () => {
    expect(breathOf(0)).toBe(0)
    expect(breathOf(BREATH_MS / 2)).toBe(1)
    expect(breathOf(BREATH_MS)).toBe(0)
  })

  test('按轮循环（此刻取模，跨多少轮都一样）', () => {
    expect(breathOf(BREATH_MS + BREATH_MS / 4)).toBeCloseTo(breathOf(BREATH_MS / 4), 6)
  })

  test('半个周期里单调（不是闪，是渐变）', () => {
    const rising = [0, 200, 400, 600, 800, 1000].map((at) => breathOf(at))
    expect([...rising].sort((left, right) => left - right)).toEqual(rising)
  })

  test('亮度 1 ＝ 原色本身（不呼吸的那些状态用的就是原色）', () => {
    expect(breathColor('#e5c07b', 1)).toBe('#e5c07b')
  })

  test('亮度 0 ＝ 压暗的那一档——「轻微」：不熄灭、也不闪', () => {
    const dim = breathColor('#e5c07b', 0)

    expect(dim).toMatch(/^#[0-9a-f]{6}$/)
    expect(dim).not.toBe('#e5c07b')
    // 每一路都还在（不是黑色、也不是只剩一路）
    expect(dim).not.toBe('#000000')
  })

  test('认不出的色原样返回（不编一个拼出来的颜色）', () => {
    expect(breathColor('red', 0.5)).toBe('red')
    expect(breathColor('', 0.5)).toBe('')
  })
})
