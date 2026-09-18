/**
 * 标本录制器（U23）——把一段**真渲染**录成字节标本，落进 `fixtures/`。
 *
 * 用法（在仓库根）：
 *
 * ```bash
 * bun run packages/tui/test/record.ts head          # 用当前工作区录，落 fixtures/<场景>@head.txt
 * bun run packages/tui/test/record.ts 4737930       # 用某个提交的 src 录（见下）
 * ```
 *
 * **录一段老提交的字节**（红证据的来源）——只让 `packages/tui/src` 变旧，其余原样：
 *
 * ```bash
 * git worktree add --detach /tmp/u23-old <提交>
 * ln -s "$PWD/node_modules" /tmp/u23-old/node_modules      # contracts / faux 在该区间零改动，挂过来等价
 * cp packages/tui/test/{terminal,record}.ts /tmp/u23-old/packages/tui/test/
 * cd /tmp/u23-old && bun run packages/tui/test/record.ts <标签>
 * ```
 *
 * ⚠️ **本文件要与 `terminal.ts` 一起拷**——它俩是这套东西的全部，不含别的测试侧依赖，
 * 这样任何提交只要 `src` 还在，都能被原样重录（这正是「标本可复现」的意思）。
 *
 * ## 场景是**时序**，不是一帧
 *
 * 一次录制的输入是**一串视图**：第 0 帧装载，其后每帧一次重绘。
 * 这不是讲究，是必需品——D11 那种残影**只在不干净的重绘里出现**，
 * 把同一份视图一次性画出来是看不见的（八百多个用例就是这么漏掉的）。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement as h } from 'react'
import { makeTestStamper } from '@magic/faux'
import { createView, reduce, appendEcho } from '../src/view.ts'
import type { ShellView } from '../src/view.ts'
import { AppView } from '../src/components/app.ts'
import { escapeBytes, record, unescapeBytes } from './terminal.ts'

const COLUMNS = 80
const ROWS = 24

/** 标本的录制尺寸——回放要按同一个终端大小，否则量到的不是同一块屏。 */
export const TERMINAL = { columns: COLUMNS, rows: ROWS } as const

/** 一次交代的样子（与真跑一致：用户回显 · 思考流 · 正文流 · 工具往返）。 */
const UTTERANCE = '看看工作区里有什么'

type Scenario = {
  readonly name: string
  /** 说明这个标本是录来干什么的——写进标本文件头，省得日后猜。 */
  readonly about: string
  /**
   * **渲染层被告知**的列数——缺省＝与终端一致。
   *
   * 只有 `mismatch` 故意填一个不一样的：那是「渲染层自算的宽度」与「终端实际宽度」分家
   * 的那一类（resize 那一瞬就是这个形状），不变量「不溢出」守的正是它。
   */
  readonly viewColumns?: number
  /** 逐帧的视图（第 0 帧＝装载）。 */
  readonly frames: () => readonly ShellView[]
}

/**
 * 造一轮流式：从**空态**起，逐步长出来。
 *
 * 为什么从空态起：空态是整个生命周期里最高的一帧（十几行），
 * 后面内容一变短，**擦行数算错**就露馅——D11 的残影正是这个形态。
 */
function streaming(body: string, thinking: string): readonly ShellView[] {
  const stamper = makeTestStamper({ session: 'u23', turn: 1 })
  const frames: ShellView[] = [createView()]

  let view = appendEcho(createView(), UTTERANCE)
  frames.push(view)

  view = reduce(view, stamper.stamp('turn.start', {}))
  view = reduce(view, stamper.stamp('model.call.start', { model: 'u23-model' }))
  frames.push(view)

  // 思考与正文都按小块流（真模型就是这么吐的）——**一帧就是一帧**，不合并。
  // ⚠️ 切块用 `[\s\S]` 而**不是 `.`**：`.` 不匹配换行，会把正文里的 `\n` **静默丢掉**——
  // 那样 D13 的 `\n\n` 前缀就没了、D11 的多行正文也塌成一行，**标本当场失去意义**
  // （实测踩过：改完场景红标本悄悄变绿，是不变量把这事抓出来的）。
  for (const piece of thinking.match(/[\s\S]{1,3}/g) ?? []) {
    view = reduce(view, stamper.stamp('model.delta', { channel: 'thinking', text: piece }))
    frames.push(view)
  }

  // 正文按小块流——**首块带着正文原样的开头**（D13 的 `\n\n` 就是在这里进来的）
  for (const piece of body.match(/[\s\S]{1,4}/g) ?? []) {
    view = reduce(view, stamper.stamp('model.delta', { channel: 'text', text: piece }))
    frames.push(view)
  }

  return frames
}

/** 空态起、长出两行内容——`mismatch` 用它，够画出一条分隔线与一行状态行就行。 */
function shortTurn(): readonly ShellView[] {
  const stamper = makeTestStamper({ session: 'u23', turn: 1 })

  let view = appendEcho(createView(), '看看工作区里有什么')
  view = reduce(view, stamper.stamp('turn.start', {}))
  view = reduce(view, stamper.stamp('model.call.start', { model: 'u23-model' }))
  view = reduce(view, stamper.stamp('model.delta', { channel: 'text', text: '工作区基本为空。' }))

  return [createView(), view]
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'stream',
    about: '一轮普通流式（多行正文）——擦行数算错时，屏上会留下上一帧的残影（D11 的形态）',
    frames: () =>
      streaming('工作区基本为空：\n- README.md\n- packages\n就这些 —— 需要我做什么？', '先列一下。'),
  },
  {
    name: 'leadblank',
    about: '正文以 \\n\\n 开头（模型实测如此）——首行吞换行时，同一段正文会被画两遍（D13 的形态）',
    frames: () => streaming('\n\n甲乙丙丁', '写四个字就好。'),
  },
  {
    name: 'mismatch',
    // 渲染层被告知 120 列，终端只有 80——**两个宽度分家**（resize 那一瞬就是这个形状）
    viewColumns: 120,
    about: '渲染层宽度(120) ≠ 终端宽度(80)——分隔线与状态行会被终端折行（不溢出的形态）',
    frames: shortTurn,
  },
]

/** 录一个场景 → 转义文本（含文件头：来源 · 尺寸 · 用途）。 */
/**
 * 把一个场景**现录**成字节——不落盘，直接给不变量量。
 *
 * ⚠️ 这一路与「回放标本」是**两件事，缺一不可**：
 * - **现录**（本函数）＝**回归哨兵**——`src` 坏了它才红。标本是冻结的字节，`src` 再坏也不会动它；
 * - **回放标本**＝**证明不变量咬得住**——标本是已知有缺陷的字节，不变量必须当场红。
 *
 * 两张网各管一头，别只留一张（只留标本 ⇒ 代码坏了没人知道；只留现录 ⇒ 不变量本身松了没人知道）。
 */
export async function bytesOf(scenario: Scenario): Promise<string> {
  const viewColumns = scenario.viewColumns ?? COLUMNS
  const views = scenario.frames()

  return record(
    views.map((view) => h(AppView, { key: 'specimen', view, columns: viewColumns, rows: ROWS })),
    { columns: COLUMNS, rows: ROWS },
  )
}

async function recordScenario(scenario: Scenario, tag: string): Promise<string> {
  const views = scenario.frames()
  const viewColumns = scenario.viewColumns ?? COLUMNS
  const bytes = await bytesOf(scenario)

  const header = [
    `# 标本：${scenario.name}@${tag}`,
    `# ${scenario.about}`,
    `# 尺寸：终端 ${COLUMNS}×${ROWS} · 渲染层被告知 ${viewColumns} 列`,
    `# 帧数：${views.length} · 字节：${bytes.length}`,
    `# 录法：bun run packages/tui/test/record.ts ${tag}（见 test/record.ts 头注）`,
    '# 下一行是字节流本身（转义写法：\\e＝ESC · \\n＝换行 · \\xNN＝其余控制字符）',
  ]

  return `${header.join('\n')}\n${escapeBytes(bytes)}\n`
}

async function main(): Promise<void> {
  const tag = process.argv[2] ?? 'head'

  for (const scenario of SCENARIOS) {
    const path = fileURLToPath(new URL(`./fixtures/${scenario.name}@${tag}.txt`, import.meta.url))
    writeFileSync(path, await recordScenario(scenario, tag))
    console.log(`录好 ${scenario.name}@${tag} → ${path}`)
  }
}

// 当脚本跑（而不是被测试 import）时才录
if (import.meta.main) await main()

/**
 * 读一份标本（去注释 ＋ 转义还原）。
 *
 * 导出在这里而不是测试里：**标本是这套东西的输入面**，读法与录法该放在一处，
 * 加新标本的人只要照着 `SCENARIOS` 添一条。
 */
export function readFixture(name: string): { readonly bytes: string; readonly header: readonly string[] } {
  const text = readFileSync(fileURLToPath(new URL(`./fixtures/${name}.txt`, import.meta.url)), 'utf8')
  const lines = text.split('\n')

  return {
    header: lines.filter((line) => line.startsWith('#')),
    bytes: unescapeBytes(lines.filter((line) => line !== '' && !line.startsWith('#')).join('')),
  }
}
