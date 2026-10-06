/** 终端字节与不变量：当前规格的现录、回放，以及解析和段落判据。旧尺寸冻结标本与专项测试随验收规格撤销。 */

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
    const screen = await screenOf('甲\r\n乙\r\n\u001b[1A\u001b[2K\u001b[G丙', { columns: 200, rows: 40 })

    expect(screen.lines[0]).toBe('甲')
    expect(screen.lines[1]).toBe('丙')
    expect(screen.cursor.y).toBe(1)
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

// —— 当前标本与判据边界 ——

describe('不重复 · 咬得住的证据', () => {

  test('当前工作区**不**重复——同一份标本，修后不再有那两份', async () => {
    const screen = await replay('leadblank@head')

    expect(duplicates(screen)).toEqual([])
    // 正文只有一条显示行：标记与正文同行（D13 修法的判据）
    expect(screen.lines.filter((line) => line.includes('甲乙丙丁'))).toEqual(['甲乙丙丁'])
  })
})

describe('不空行 · 咬得住的证据', () => {

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
    const screen = await screenOf(`甲\r\n\r\n乙\r\n${'─'.repeat(200)}`, { columns: 200, rows: 40 })

    expect(blankRuns(screen)).toEqual([])
  })

  test('两行空：不过', async () => {
    const screen = await screenOf(`甲\r\n\r\n\r\n乙\r\n${'─'.repeat(200)}`, { columns: 200, rows: 40 })

    expect(blankRuns(screen)).toEqual([{ from: 1, to: 2, count: 2 }])
  })
})

// —— 不夹空行（「不空行」的收紧形 · 第 2 轮）——
//
// 这一条**要场景给原文**才成立：屏上「空行多不多」没有绝对答案，
// 「条目之间夹一行」与「正文本来就有两个段落」在屏上长得一模一样。

describe('不夹空行 · 咬得住的证据（本轮的验收重头）', () => {

  test('D19 不误伤——正文**该有的**段落空行照留（两边相等）', async () => {
    const screen = await screenOf(
      `› 说两段\r\n⏺ 第一段\r\n\r\n第二段\r\n${'─'.repeat(200)}`,
      { columns: 200, rows: 40 },
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
      `› 第一句\r\n⏺ 答一\r\n\r\n› 第二句\r\n⏺ 答二\r\n${'─'.repeat(200)}`,
      { columns: 200, rows: 40 },
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

  test('修后同一条件不再溢出——Ink 把文本钳在盒宽内（盒宽＝终端宽）', async () => {
    const screen = await replay('mismatch@head')

    expect(overflows(screen)).toEqual([])
  })
})
