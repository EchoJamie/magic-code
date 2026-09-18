/**
 * 成本归因（U21 · **测量装置**）——把「流式那条延迟」拆到具体的函数上。
 *
 * ## 为什么要这一份
 *
 * `bench-stream.ts` 量出「每条 delta ~14ms、事件循环被占住」——**症状**有了，
 * 但**归因不许猜**（项目规矩）。这一份拿同一段正文，逐层量纯函数的耗时：
 *
 * | 量什么 | 归属 |
 * | --- | --- |
 * | `markdown(text)` | 正文 → 显示行（Markdown 解析） |
 * | `rowLines(assistant)` | 再挂标记与折行（`wrapSegments` → `wrap`） |
 * | `AppView` 一帧 | 以上两样 ＋ 逐行建 React 元素 ＋ `<Static>` 那一片 |
 *
 * **同一段正文，长度翻倍，看各层怎么长**——线性 ＝ 这一层不背锅；
 * 平方 ＝ 每一帧都把已经画过的部分重算了一遍，**那就是要改的那一处**。
 *
 * ## 跑法
 *
 * ```
 * FORCE_COLOR=0 bun packages/tui/test/bench-cost.ts
 * ```
 */

import type { LogRow } from '../src/view.ts'
import { markdown } from '../src/markdown.ts'
import { rowLines } from '../src/components/log.ts'
import { AppView } from '../src/components/app.ts'
import { createView } from '../src/view.ts'

const COLUMNS = 110
const ROWS = 40

/** 一次量到的最小耗时（毫秒）——`Bun.nanoseconds()` 是整数纳秒，够细。 */
const ns = (): number => Bun.nanoseconds()

/**
 * 反复跑 `body` 直到至少耗 `budgetMs`，返回**单次**耗时（毫秒，取总时长 ÷ 次数）。
 *
 * 为什么要这样：一次调用只有几十微秒，而 `performance.now()` 的分辨率就在那一档——
 * 量单次只会量到噪声。跑够长的一段再除，噪声就被摊薄了。
 */
function costOf(body: () => void, budgetMs = 120): number {
  // 先热身（JIT 与内联——不热身的话第一次那批会把均值拉高）
  for (let index = 0; index < 20; index += 1) body()

  const started = ns()
  const deadline = started + budgetMs * 1e6
  let runs = 0

  while (ns() < deadline) {
    body()
    runs += 1
  }

  return (ns() - started) / 1e6 / runs
}

/** 一段像模型的正文——每行一句话，行尾换行。 */
function corpus(lines: number): string {
  const out: string[] = []
  for (let index = 0; index < lines; index += 1) {
    out.push(`第 ${index} 行：这是一段**正文**，里面有 \`code\` 与一点说明文字，用来把这一行撑到差不多一行宽。`)
  }

  return out.join('\n')
}

/** 一条助手行（正文在长）——`key` 决定缓存归哪一条，故它是个入参。 */
function assistantRow(text: string, key = 'a:1'): LogRow {
  return { kind: 'assistant', key, text }
}

/** 已定局的一堆行（量 `<Static>` 那一片的账）。 */
function settledRows(count: number): readonly LogRow[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'receipt' as const,
    key: `s:${index}`,
    text: `第 ${index} 条回执`,
  }))
}

const OPTS = { columns: COLUMNS, expanded: false } as const

/**
 * 一个每轮都换的 key——逼出**冷**那一档（缓存键是行的 `key`，换 key ＝ 没得命中）。
 *
 * ⚠️ 这一档量的是**优化前**那个代价：`U21` 之前，每一帧都是这么算的。
 * 只量热的一档是自欺——`rowLines` 撞上缓存会报 `0.000ms`，而那个数什么也没说。
 */
let cold = 0

export function run(): void {
  console.log('【冷】每一帧都从头算（U21 之前的样子）——归因用')
  console.log('正文行数    markdown()      rowLines()      AppView(1 帧)   显示行数')

  for (const lines of [50, 100, 200, 400, 800]) {
    const text = corpus(lines)

    const md = costOf(() => void markdown(text))
    const rl = costOf(() => {
      cold += 1
      void rowLines(assistantRow(text, `cold:${cold}`), OPTS)
    })
    const height = rowLines(assistantRow(text, 'h'), OPTS).length

    const frame = costOf(() => {
      cold += 1
      const view = { ...createView(), rows: [assistantRow(text, `cold:${cold}`)] }
      void AppView({ view, columns: COLUMNS, rows: ROWS })
    })

    console.log(
      `${String(lines).padStart(6)}      ${md.toFixed(3).padStart(7)}ms    ${rl.toFixed(3).padStart(7)}ms    ${frame.toFixed(3).padStart(8)}ms    ${String(height).padStart(6)}`,
    )
  }

  console.log('\n【热】同一行再问一遍（一帧里被问两次的那个第二次）——缓存该吃掉它')
  {
    const text = corpus(800)
    const row = assistantRow(text, 'warm')
    void rowLines(row, OPTS) // 先算一次，把它喂进缓存
    console.log(`正文 800 行 · rowLines() 第二次：${costOf(() => void rowLines(row, OPTS)).toFixed(4)}ms`)
  }

  console.log('\n【增长】正文每帧只多一行——增量那一档该与**新增**成正比，不与全文成正比')
  console.log('正文行数    rowLines(每帧多一行)')
  for (const lines of [100, 200, 400, 800]) {
    // 模拟流式：先把前 `lines` 行铺好，再量「后面每加一行」的单帧代价
    const key = `grow:${lines}`
    let grown = corpus(lines)
    for (let index = 0; index < 20; index += 1) {
      grown += '\n一行新内容'
      void rowLines(assistantRow(grown, key), OPTS)
    }

    const cost = costOf(() => {
      grown += '\n一行新内容'
      void rowLines(assistantRow(grown, key), OPTS)
    })

    console.log(`${String(lines).padStart(6)}      ${cost.toFixed(4).padStart(7)}ms`)
  }

  // —— 历史区那一片的账：`<Static>` 的 items 每帧重建一次阵列，代价随会话长度长 ——
  console.log('\n已定局行数  spread+slice（每帧那两下）')
  for (const count of [100, 1000, 5000]) {
    const settled = settledRows(count)
    const cost = costOf(() => void [...settled].slice(settled.length))

    console.log(`${String(count).padStart(8)}      ${cost.toFixed(4).padStart(7)}ms`)
  }
}

if (import.meta.main) run()
