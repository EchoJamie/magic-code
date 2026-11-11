/**
 * **还在跑的后台命令**块 —— 送到模型手上的那一份（U89）。
 *
 * 出处：设计 · 提示词与指令 甲 ②（2026-09-26 定，参照面＝26 家）。那一节的原话：
 * 「它是这一格唯一一条**丢了会直接导致做错事**的：模型会**重复启动同一条命令**」；
 * ⇒ 「进那个每回合重建的块；**没有后台任务就不出现**」。
 *
 * ## 为什么挂在系统提示词上（同规约块与技能目录块那一条）
 *
 * 「哪几条还在跑」是**此刻的实况**，不是这次对话里谁说的话。混进消息流的话它会随会话
 * 历史漂（压缩、重放、切会话都得重新解释它算谁说的）；而 U70 那条「跑完那一刻」的消息
 * **只说得出一件事**：它**已经结束了**——「还在跑」这一半此前**没有任何地方说**。
 * 追加块的做法与**环境块**、**项目规约块**、**技能目录块**同一条先例
 * （`./assembly.ts`：四段冻结，追加块殿后）——只增不改。
 *
 * ## 每行三件（工单点名的三件）
 *
 * 1. **编号**——`〔bg-1〕`（与 U70 回执同一个词，模型据此与那条回执对得上）；
 * 2. **命令**——首行、够认出来是哪一条（多行只取首行：那一行才是「这是哪条命令」）；
 * 3. **还在跑这件事本身**——**逐行写着**，不只写在标题里：模型是从某一行认出一条命令的，
 *    而它最容易犯的错正是**把「读到过它」当成「它已经结束了」**（同 U70 那条回执末句的顾虑）。
 *
 * 输出文件那一截也带上（`输出文件 <路径>`）：它是**取输出的把手**——
 * 发起那一刻的回执给过一次，但它可能已经被压缩掉了，而这个块**压不掉**。
 *
 * ## 没有在跑的**就没有这一块**
 *
 * 同技能目录块那一条（「给一个空块递上去，等于每轮都告诉模型『这儿有，只是没有』，
 * 那不是没有，是一句假话」）。⚠️ **也别钉一句「当前没有后台任务」**（工单明文）——
 * 每一轮都占一行说一件没发生的事。
 */

import type { BackgroundRunning } from '@magic/contracts'
import { BACKGROUND_BLOCK_ID, BACKGROUND_HEADING, BLOCK_SEPARATOR } from './assembly.ts'
import type { PromptBlock } from './assembly.ts'

/**
 * 命令在行里留多长——**与 U70 那条完成消息同一个数**（`assembly.ts` 的
 * `backgroundNoticeText` 也按 80 裁首行）。
 *
 * 两处取同一个数不是巧合：同一条命令在「回执 / 完成消息」与这一块里**被裁成同一个样子**，
 * 模型才认得出它们说的是同一条（裁法两边不一，长的命令就会看着像两条）。
 */
const COMMAND_CHARS = 80

/** 那一行的命令——**首行**（多行命令只留第一行）＋ 超长截断。 */
function commandOf(command: string): string {
  const first = command.split('\n', 1)[0]?.trim() ?? ''
  return first.length > COMMAND_CHARS ? `${first.slice(0, COMMAND_CHARS)}…` : first
}

/**
 * 摆一个后台命令块——**一条在跑的都没有就返回 `undefined`**。
 *
 * 返回 `undefined` 与返回一个空块是两件不同的事：前者＝这一轮**不提后台这件事**
 * （原行为一字不动），后者＝每轮钉一句空话。工单要的是前者。
 */
export function renderBackgroundBlock(
  running: readonly BackgroundRunning[],
): PromptBlock | undefined {
  if (running.length === 0) return undefined

  const body = running.map(entryOf).join('\n')

  return {
    id: BACKGROUND_BLOCK_ID,
    heading: BACKGROUND_HEADING,
    body,
    text: `${BACKGROUND_HEADING}\n${body}`,
  }
}

/**
 * 一行一条——**编号 · 命令 · 还在跑（＋ 输出在哪儿）**。
 *
 * 分隔用行内那对 `（…）`（同技能目录块 `（来源 …）` 的写法）：行首那三件是**这条命令
 * 本身**，括号里是**它的现况与把手**——两半摆在一行上，模型一眼扫得完。
 */
function entryOf(run: BackgroundRunning): string {
  return `- 〔${run.id}〕${commandOf(run.command)}（还在跑 · 输出文件 ${run.outputPath}）`
}

/**
 * 把后台命令块接到系统提示词末尾——**没有在跑的就原样交回**。
 *
 * 追加在**技能目录块之后**：这一块是四块里唯一**随时刻变**的（环境 / 规约 / 技能都是
 * 「这个环境里一直成立的东西」）——「越往后越具体、越往后越当下」那一条次序在这儿收尾。
 */
export function withBackgroundRuns(base: string, running: readonly BackgroundRunning[]): string {
  const block = renderBackgroundBlock(running)
  return block === undefined ? base : `${base}${BLOCK_SEPARATOR}${block.text}`
}

/** 块的标识与标题——归 `./assembly.ts` 持有（块词汇一处，见其注）。 */
export { BACKGROUND_BLOCK_ID, BACKGROUND_HEADING } from './assembly.ts'
