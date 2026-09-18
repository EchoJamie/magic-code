/**
 * 终端层 · 三条不变量（U23）。
 *
 * ## 这个文件在补什么
 *
 * 仓里八百多个用例测的都是「**视图对象**怎么变」——它们全绿的那两天，用户在真终端上
 * 连撞三跤（D8 状态行挤成两行 · D11 每行多写一个换行 ⇒ 帧高算一半 ⇒ 重复 ·
 * D13 首行吞换行 ⇒ 正文画两遍）。**一条都没拦住**，因为它们**都不在视图里**：
 * 视图那一侧分别看是「rows 没变」「一行一个元素」「宽度参数对」，全合法。
 * 坏的是**字节怎么写进终端**。这个文件就量那一层：
 *
 * ```
 * 标本字节 ──screenOf()──▶ 屏幕矩阵 ──三条不变量──▶ 空数组（干净）/ 违例清单
 * ```
 *
 * ## 标本从哪来（**这不是装饰，是反向验证**）
 *
 * `fixtures/` 里的字节是**真录的**（`record.ts`），不是手写的：
 *
 * - **`@head`**——当前工作区录的，期望**全过**（绿）；
 * - **`@4737930` / `@4ab8358`**——D11 / D13 **修复前**的提交录的，期望**当场红**；
 * - **`mismatch`**——渲染层被告知 120 列、终端只有 80 列（两个宽度分家）；
 * - **`@d11relapse`**——**当前代码 ＋ 把 D11 那个换行塞回去**录的（第 2 轮加）。
 *   它是「不夹空行」的**活体标本**：同一个 bug 换内联之后不再造重复了，
 *   只剩「每条内容行之间夹一个空行」这一副面孔，而 `≤1` 的旧判据拦不住它。
 *
 * **红标本一并入库**是这一层的关键设计：不变量只要有人「顺手放宽」，
 * 这些用例立刻红——「它咬得住」这件事本身也成了回归面。
 *
 * ## 两张网（缺一不可）
 *
 * - **现录现量**——`src` 坏了它才红（**回归哨兵**）；
 * - **回放标本**——标本是已知有缺陷的冻结字节，不变量必须当场红（**证明它咬得住**）。
 *
 * 只留标本 ⇒ 代码坏了没人知道；只留现录 ⇒ 不变量被人放宽了没人知道。
 *
 * ## 反向验证的硬结果（把修复倒回当前代码 · 实测）
 *
 * | 倒回哪一处 | 现录那一路 | 谁能咬住 |
 * | --- | --- | --- |
 * | **D13**（首行按宽度重切整段） | **红** ✓ | `duplicates`——`- README.md` 第 4/7 行… |
 * | **D11**（每行多写一个换行） | **红** ✓ | `entryBlanks`——每条 `allowed: 0` 而 `blanks ≥ 1` |
 *
 * ⚠️ D11 那格第 1 轮是**不红**的（当时的判据是「不空行 `≤1`」，那个形状恰恰落在边界内侧）。
 * 第 2 轮按规划侧裁决加了**收紧形**「不夹空行」（`entryBlanks`：**同一条目之内，空行数不许超过
 * 原文的段落分隔数**），它才咬得住——**别把这条收紧当成可有可无**：没有它，D11 那一格就是空的。
 *
 * ⚠️ **看失败信息**：违例对象带着行号与原文，`expect(...).toEqual([])` 失败时
 * 打印的是 bun 自己的深比较，直接读出「屏上第几行坏了、坏成什么样」。
 */

import { describe, expect, test } from 'bun:test'
import {
  blankRuns,
  duplicates,
  entryBlanks,
  entryBlocks,
  overflows,
  paragraphBreaks,
  recordArea,
} from './invariants.ts'
import type { EntrySpec } from './invariants.ts'
import { SCENARIOS, TERMINAL, bytesOf, readFixture, scenarioOf } from './record.ts'
import { escapeBytes, screenOf, unescapeBytes } from './terminal.ts'

/** 回放一份标本 → 屏幕矩阵（**按录制的终端尺寸**，否则量到的不是同一块屏）。 */
async function replay(name: string): Promise<Awaited<ReturnType<typeof screenOf>>> {
  return screenOf(readFixture(name).bytes, TERMINAL)
}

/** 标本的**原文账单**——按文件名里的场景名去 `SCENARIOS` 取（标签只说字节哪儿录的）。 */
function entriesOf(fixture: string): readonly EntrySpec[] {
  const scenario = scenarioOf(fixture)
  if (scenario === undefined) throw new Error(`标本 ${fixture} 没有对应的场景——取不到原文账单`)

  return scenario.entries
}

// —— 终端层自身：它得真会看屏 ——

describe('终端层 · 器械自检', () => {
  test('转义可逆——标本进出无损（入库的是转义文本，回放要还原成字节）', () => {
    const bytes = '\u001b[2K\u001b[1A甲乙\u001b[G\r\n\u0007'

    expect(unescapeBytes(escapeBytes(bytes))).toBe(bytes)
  })

  test('擦行与上移真的作用在屏上——字节里的 `\\e[1A\\e[2K` 是被解析的，不是当文本画的', async () => {
    const screen = await screenOf('甲\r\n乙\r\n\u001b[1A\u001b[2K\u001b[G丙', { columns: 20, rows: 5 })

    expect(screen.lines[0]).toBe('甲')
    expect(screen.lines[1]).toBe('丙')
    expect(screen.cursor.y).toBe(1)
  })

  test('写宽了会被终端折行（`isWrapped`）——「溢出」在终端层的唯一可判定形态', async () => {
    // ⚠️ 终端数的是**列**不是字符：汉字占两列，所以 4 列只放得下 2 个字
    // （这一条自己踩过：想当然按「4 个字符」写，当场被这条用例纠正）
    const screen = await screenOf('一二三四五', { columns: 4, rows: 5 })

    expect(screen.lines[0]).toBe('一二')
    expect(screen.lines[1]).toBe('三四')
    expect(screen.lines[2]).toBe('五')
    expect(screen.wrapped).toContain(true)
  })
})

// —— 绿：当前工作区（**两张网**）——
//
// 「现录」与「回放标本」缺一不可：
// - **现录**是**回归哨兵**——`src` 坏了它才红（标本是冻结字节，`src` 再坏也不会动它）；
// - **回放标本**证明**不变量自己咬得住**——标本是已知有缺陷的字节，必须当场红。
// 只留标本 ⇒ 代码坏了没人知道；只留现录 ⇒ 不变量被人放宽了没人知道。

describe('当前工作区 · 现录现量（回归哨兵——src 坏了这条才红）', () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario.name}——现录一遍，不变量全过`, async () => {
      const screen = await screenOf(await bytesOf(scenario), TERMINAL)

      // 防空转：找到的条目数必须＝场景声明写下的条数。
      // ⚠️ 少了这一条，「不夹空行」的标记只要写错一个字母就**一声不吭地全过**
      expect(entryBlocks(screen, scenario.entries)).toHaveLength(scenario.entries.length)
      expect(entryBlanks(screen, scenario.entries)).toEqual([])

      expect(duplicates(screen)).toEqual([])
      expect(blankRuns(screen)).toEqual([])
      expect(overflows(screen)).toEqual([])
    })
  }
})

describe('当前工作区 · 回放标本（不变量咬得住的锚点）', () => {
  for (const name of ['stream@head', 'leadblank@head', 'mismatch@head']) {
    test(`${name}——不重复 · 不空行 · 不夹空行 · 不溢出`, async () => {
      const screen = await replay(name)
      const entries = entriesOf(name)

      expect(entryBlocks(screen, entries)).toHaveLength(entries.length)
      expect(entryBlanks(screen, entries)).toEqual([])

      expect(duplicates(screen)).toEqual([])
      expect(blankRuns(screen)).toEqual([])
      expect(overflows(screen)).toEqual([])
    })
  }

  test('当前的分隔线认得出来——记录区不是靠猜划的（拿它当尺子，它自己得准）', async () => {
    const screen = await replay('stream@head')

    // 记录区停在分隔线之前：用户那行在内，交互区那几行在外
    const texts = recordArea(screen).map((entry) => entry.text)
    expect(texts.some((text) => text.startsWith('› 看看工作区里有什么'))).toBe(true)
    expect(texts.some((text) => text.includes('工作中——想插话'))).toBe(false)
  })
})

// —— 红：修复前的字节（反向验证）——

describe('不重复 · 咬得住的证据', () => {
  test('D11 修复前（4737930）——每行多一个换行 ⇒ 帧高算一半 ⇒ 上一帧留在屏上又画一遍', async () => {
    const screen = await replay('stream@4737930')
    const found = duplicates(screen)
    const readme = found.find((entry) => entry.text === '- README.md')

    // 同一行在第 5、9 行各一份（后一份带**续行缩进**——`trim` 之后才比得出来）
    expect(readme).toBeDefined()
    expect(readme?.rows.length).toBeGreaterThanOrEqual(2)
    // 残影不是「两条路同时在铺」——它带缩进，是同一行被擦剩下再画一遍的形状
    expect(screen.lines[readme?.rows[1] ?? 0]).not.toBe(screen.lines[readme?.rows[0] ?? 0])
  })

  test('D13 修复前（4ab8358）——首行吞掉前导换行 ⇒ 首行自己展开 ＋ 续行再画一遍 ⇒ 正文两遍', async () => {
    const screen = await replay('leadblank@4ab8358')
    const found = duplicates(screen)
    const body = found.find((entry) => entry.text === '甲乙丙丁')

    expect(body).toBeDefined()
    expect(body?.rows.length).toBeGreaterThanOrEqual(2)
  })

  test('当前工作区**不**重复——同一份标本，修后不再有那两份', async () => {
    const screen = await replay('leadblank@head')

    expect(duplicates(screen)).toEqual([])
    // 正文只有一条显示行：标记与正文同行（D13 修法的判据）
    expect(screen.lines.filter((line) => line.includes('甲乙丙丁'))).toEqual(['⏺ 甲乙丙丁'])
  })
})

describe('不空行 · 咬得住的证据', () => {
  test('4737930——屏上出现成片空行（全屏版面铺满窗口，内容没跟住）', async () => {
    const screen = await replay('stream@4737930')
    const runs = blankRuns(screen)

    expect(runs.length).toBeGreaterThan(0)
    expect(Math.max(...runs.map((run) => run.count))).toBeGreaterThanOrEqual(3)
  })

  // ⚠️ 这条规则**不是 D11 的哨兵**——拿 `4737930` 做对照实验（只摘掉那个多余的 `\\n`、其余不动）
  // 重录，屏上仍有 12 行空档（带 bug 时 7 行）。那一片是**旧全屏版面的留白**。
  // 而 D11 的逐行夹空行恰好是「一行」，正落在 `≤1` 边界内侧 ⇒ 抓 D11 的是 `duplicates`。
  // 留这条注释是因为「空行变多了」最容易被误读成那条换行的账——量过才知道不是。

  test('修后**允许**留的那一行分段不算违例——用户消息之前那一条（原型 · 密度）', async () => {
    const screen = await replay('leadblank@head')

    expect(blankRuns(screen)).toEqual([])
  })

  // 尺子的下限就在 1 与 2 之间——两头各钉一次，免得日后有人「顺手收紧成 0」把设计要的呼吸判成违例
  test('恰好一行分段：过', async () => {
    const screen = await screenOf(`甲\r\n\r\n乙\r\n${'─'.repeat(80)}`, { columns: 80, rows: 10 })

    expect(blankRuns(screen)).toEqual([])
  })

  test('两行空：不过', async () => {
    const screen = await screenOf(`甲\r\n\r\n\r\n乙\r\n${'─'.repeat(80)}`, { columns: 80, rows: 10 })

    expect(blankRuns(screen)).toEqual([{ from: 1, to: 2, count: 2 }])
  })
})

// —— 不夹空行（「不空行」的收紧形 · 第 2 轮）——
//
// 这一条**要场景给原文**才成立：屏上「空行多不多」没有绝对答案，
// 「条目之间夹一行」与「正文本来就有两个段落」在屏上长得一模一样。

describe('不夹空行 · 咬得住的证据（本轮的验收重头）', () => {
  test('D11 的新形态（把那个换行塞回当前代码录的标本）——条目内空行数远超段落数', async () => {
    const screen = await replay('stream@d11relapse')
    const entries = entriesOf('stream@d11relapse')
    const found = entryBlanks(screen, entries)

    // 防空转：三条都画出来了，判据才有资格说话
    expect(entryBlocks(screen, entries)).toHaveLength(entries.length)
    expect(found.length).toBeGreaterThan(0)

    // **指名道姓**：正文那一条——原文一个段落分隔都没有，屏上却每行夹一个空行
    const body = found.find((block) => block.marker === '⏺ ')
    expect(body).toBeDefined()
    expect(body?.allowed).toBe(0)
    expect(body?.blanks).toBeGreaterThanOrEqual(3)
  })

  test('D19 不误伤——正文**该有的**段落空行照留（两边相等）', async () => {
    const screen = await screenOf(
      `› 说两段\r\n⏺ 第一段\r\n\r\n第二段\r\n${'─'.repeat(80)}`,
      { columns: 80, rows: 10 },
    )
    const entries = [
      { marker: '› ', text: '说两段' },
      { marker: '⏺ ', text: '第一段\n\n第二段' },
    ] as const

    expect(entryBlocks(screen, entries)).toHaveLength(2)
    expect(entryBlanks(screen, entries)).toEqual([])

    // 反过来验一次判据确实看见了那个空行（否则「过」可能只是没量到）
    expect(entryBlocks(screen, entries)[1]?.blanks).toBe(1)
  })

  test('多轮：用户消息之前那一条**分段**落在上一条的尾部——不许算到上一条头上', async () => {
    // 两个来回——第二条用户消息之前那一行分段是**设计要的呼吸**（`needsSpacer`），
    // 它在屏上落进**上一条**（助手答话）的尾部。要是不掐掉尾部，「不夹空行」就会在
    // 任何多轮场景上**假红**——这是本轮选「只数内部」的直接理由，钉住它。
    const screen = await screenOf(
      `› 第一句\r\n⏺ 答一\r\n\r\n› 第二句\r\n⏺ 答二\r\n${'─'.repeat(80)}`,
      { columns: 80, rows: 12 },
    )
    const entries = [
      { marker: '› ', text: '第一句' },
      { marker: '⏺ ', text: '答一' },
      { marker: '› ', text: '第二句' },
      { marker: '⏺ ', text: '答二' },
    ] as const

    expect(entryBlocks(screen, entries)).toHaveLength(4)
    expect(entryBlanks(screen, entries)).toEqual([])
    // 那一行分段确实在屏上（不是没画出来才「过」的）
    expect(entryBlocks(screen, entries)[1]?.to).toBe(2)
  })

  test('段落分隔数怎么数：单个换行不算，前导空行不算', () => {
    // 同一段里的折行——不是段落分隔（D11 就是靠这一条被抓的）
    expect(paragraphBreaks('一段\n又一段\n还一段')).toBe(0)
    // 段落之间那一个空行才算
    expect(paragraphBreaks('第一段\n\n第二段')).toBe(1)
    // **前导**的 `\n\n` 不算（模型爱给，渲染层本来就该去掉——算进去就是白送额度）
    expect(paragraphBreaks('\n\n甲乙丙丁')).toBe(0)
    // 全空＝没有段落可言
    expect(paragraphBreaks('\n\n')).toBe(0)
  })
})

describe('不溢出 · 咬得住的证据', () => {
  test('4737930：根 Box 写死 `width: columns` —— 渲染层按 120 列画，终端只有 80 列', async () => {
    const screen = await replay('mismatch@4737930')
    const folded = overflows(screen)

    // 分隔线与状态行都被终端折了：折出来的那半截不是渲染层写的行
    expect(folded.length).toBeGreaterThanOrEqual(2)
    expect(folded.every((entry) => screen.wrapped[entry.row] === true)).toBe(true)
  })

  test('修后同一条件不再溢出——Ink 把文本钳在盒宽内（盒宽＝终端宽）', async () => {
    const screen = await replay('mismatch@head')

    expect(overflows(screen)).toEqual([])
  })
})
