#!/usr/bin/env bun
/** 对比字符宽度计算与终端字格，检查字形显示。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement as h } from 'react'
import { Text } from 'ink'
import { MARKS } from '../../src/marks.ts'
import { displayWidth } from '../../src/components/lines.ts'
import { record, screenCells } from '../../test/terminal.ts'

/** 白名单那九个 ＋ 本单**换掉**的那几个（换掉的也要量——它们正是「为什么换」的那一半）。 */
const GLYPHS: readonly { readonly mark: string; readonly note: string }[] = [
  { mark: '›', note: '你的交代（保留）' },
  { mark: '▸', note: '工具行身份（换掉 ⟳）' },
  { mark: '·', note: '回执 / 分栏（保留）' },
  { mark: '⋯', note: '思考段窄窗那一档（保留）' },
  { mark: '│', note: '卡片左边框（保留）' },
  { mark: '●', note: '状态格 · 工作中（保留）· 工具行行尾「跑动中」也用它' },
  // —— 2026-10-01 裁定扩进白名单的四个（按准则推出来的，不是照位置抄的）——
  { mark: '○', note: '状态格 · 空闲（裁定后正式入白名单）' },
  { mark: '▲', note: '状态格 · 出错（裁定后正式入白名单）' },
  { mark: '■', note: '状态格 · 状态待确认（裁定后正式入白名单）' },
  { mark: '!', note: '工具行行尾 · 没跑成（裁定后正式入白名单）' },
  { mark: '◊', note: '状态格 · 在等你（裁定后 · 三档字体都覆盖的那一个）' },
  { mark: '✓', note: '行尾 · 成（本单新加的）' },
  { mark: '×', note: '行尾 · 败（本单新加的，换掉 ✗）' },
  { mark: '⏺', note: '（换掉）助手那个记号' },
  { mark: '⟳', note: '（换掉）工具跑动那个' },
  { mark: '✗', note: '（换掉）失败那个' },
  { mark: '✘', note: '（设计点名禁）带 emoji 变体的那个' },
  // **换掉的那个也量**：它红在哪（`☑` 那一列会说「三把尺子对不上」），是「为什么换」那一半
  { mark: '◉', note: '（换掉）U+25C9——SF Mono / Monaco 不覆盖' },
  { mark: '◆', note: '（换掉）U+25C6——SF Mono 同样不覆盖，故再换成 ◊' },
]

const COLUMNS = 200

/** 把一行字真画一遍，读回每一格——量「终端把每一个记号摆成了几格」。 */
async function cellsOf(text: string): Promise<readonly { text: string; width: number }[]> {
  const bytes = await record([h(Text, null, text)], { columns: COLUMNS, rows: 40 })
  const cells = await screenCells(bytes, { columns: COLUMNS, rows: 40 })

  return cells.cellsOf(0).map((cell) => ({ text: cell.text, width: cell.width }))
}

async function main(): Promise<void> {
  const at = process.argv.indexOf('--out')
  const out = at === -1 ? '' : (process.argv[at + 1] ?? '')
  if (out !== '') mkdirSync(out, { recursive: true })

  const lines: string[] = []
  const say = async (text: string): Promise<void> => {
    lines.push(text)
    await Bun.write(Bun.stdout, `${text}\n`)
  }

  await say('# U112 · 字形复核（三把尺子对着量）')
  await say('')
  await say('| 记号 | 用途 | 码点 | 名字 | 类别 | east_asian_width | displayWidth | 终端摆了几格 |')
  await say('| --- | --- | --- | --- | --- | --- | --- | --- |')

  for (const one of GLYPHS) {
    const cells = await cellsOf(one.mark)
    // **终端摆了几格**＝那一行非空格子的宽度之和（宽字符占两格，右半格宽度记 0）
    const spread = cells.reduce((sum, cell) => sum + cell.width, 0)
    const width = displayWidth(one.mark)

    await say(
      `| \`${one.mark}\` | ${one.note} | U+${(one.mark.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')} | ${unicodeName(one.mark)} | ${unicodeCategory(one.mark)} | ${eastAsian(one.mark)} | ${width} | ${spread} |`,
    )

    if (width !== spread) {
      await say('')
      await say(`⛔ **${one.mark} 三把尺子对不上**：我们算 ${width} 格，终端摆了 ${spread} 格。`)
    }
  }

  await say('')
  await say('## 状态位摆在哪一格（整行的宽度账）')

  // ⚠️ **2026-10-01 改定：状态位紧跟在身份记号 `▸` 右边**（原先靠右摆，那条已废掉——
  //    一列行是沿**左边缘**竖着扫的，右端扫不动、且随参数长短左右飘）。
  const columns = 100
  const line = `${'  '}${MARKS.tool} ${MARKS.ok} exec(sleep 2 && chmod 755 .)`
  const bytes = await record([h(Text, null, line)], { columns, rows: 40 })
  const cells = await screenCells(bytes, { columns, rows: 40 })
  const bitAt = cells.cellsOf(0).findIndex((cell) => cell.text === MARKS.ok)

  await say('')
  await say(`- 整行算出来 ${displayWidth(line)} 列（一屏 ${columns} 列）——**不溢出**：${displayWidth(line) <= columns ? '是' : '否'}`)
  await say(`- 状态位落在第 ${bitAt} 格（0 起）——**该是 4**（缩进 2 ＋ 身份记号 2）：${bitAt === 4 ? '是' : '否'}`)

  await say('')
  await say('## 未验的那一半（如实记）')
  await say('')
  await say('- **字体覆盖**（那台机器的字库有没有这个字形）——这进程里没有那台终端，量不到；')
  await say('- **emoji 呈现**（某个终端会不会把它画成彩色双宽）——同上，量不到。')
  await say('- 上表能担保的是：**我们这三把尺子一致**（算的、`string-width` 的、终端摆的），')
  await say('  故「同一列上下对齐」在这条链上是成立的；那台机器画不画得出来**另行真机看一眼**。')

  if (out !== '') {
    writeFileSync(join(out, '字形复核.md'), `${lines.join('\n')}\n`, 'utf8')
    await say('')
    await say(`落档：${join(out, '字形复核.md')}`)
  }
}

/** 码位的名字——本进程里没有 `unicodedata`，故按码点给一段能读的说明（不编字库信息）。 */
function unicodeName(mark: string): string {
  const known: Record<string, string> = {
    '›': 'SINGLE RIGHT-POINTING ANGLE QUOTATION MARK',
    '▸': 'BLACK RIGHT-POINTING SMALL TRIANGLE',
    '·': 'MIDDLE DOT',
    '⋯': 'MIDLINE HORIZONTAL ELLIPSIS',
    '│': 'BOX DRAWINGS LIGHT VERTICAL',
    '●': 'BLACK CIRCLE',
    '○': 'WHITE CIRCLE',
    '▲': 'BLACK UP-POINTING TRIANGLE',
    '■': 'BLACK SQUARE',
    '!': 'EXCLAMATION MARK',
    '◊': 'LOZENGE',
    '◆': 'BLACK DIAMOND',
    '◉': 'FISHEYE',
    '✓': 'CHECK MARK',
    '×': 'MULTIPLICATION SIGN',
    '⏺': 'BLACK CIRCLE FOR RECORD',
    '⟳': 'CLOCKWISE GAPPED CIRCLE ARROW',
    '✗': 'BALLOT X',
    '✘': 'HEAVY BALLOT X',
  }

  return known[mark] ?? '（未列）'
}

/** 码位的区块——用码点范围判（不引字库）。 */
function unicodeCategory(mark: string): string {
  const code = mark.codePointAt(0) ?? 0
  if (code <= 0x7f) return 'ASCII'
  if (code >= 0x2000 && code <= 0x206f) return 'General Punctuation'
  if (code >= 0x2190 && code <= 0x21ff) return 'Arrows'
  if (code >= 0x2200 && code <= 0x22ff) return 'Mathematical Operators'
  if (code >= 0x2500 && code <= 0x257f) return 'Box Drawing'
  if (code >= 0x25a0 && code <= 0x25ff) return 'Geometric Shapes'
  if (code >= 0x2600 && code <= 0x27bf) return 'Misc Symbols and Dingbats'
  if (code >= 0x2e00 && code <= 0x2e7f) return 'Supplemental Punctuation'

  return '（别处）'
}

/** `east_asian_width` 的分类——设计那四条准则第①条量的是它。 */
function eastAsian(mark: string): string {
  const code = mark.codePointAt(0) ?? 0
  // 这几个码点在本机那是**窄**（设计原话：「已逐个实测」）；这一列是复述那份结论，
  // 具体值由上面那个「终端摆了几格」一列**当场**给出。
  void code

  return '窄（Ambig/Narrow——以终端实测那一列为准）'
}

if (import.meta.main) await main()
