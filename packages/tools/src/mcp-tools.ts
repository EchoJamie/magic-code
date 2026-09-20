/**
 * 外部工具的定义 —— **发现结果 → 工具定义**（U38）。
 *
 * 出处：首批功能建设 ·「MCP 外部工具」——「工具域复用注册、审批、调用、取消、记录和结果
 * 回填」。故这一支落在这儿：MCP 的工具**就是工具集里追加的那一类**（`options.tools`），
 * 走的是同一个注册表、同一个闸门、同一条回填路——**没有第二套调度**。
 *
 * 三件事各归各家：
 * - **适配器**（`@magic/mcp`）说清了「服务器是谁、有哪些工具、调一次回来什么」；
 * - **本文件**把那个结果**翻成工具定义**（注册名 · 规格 · 危险归类 · 执行体）；
 * - **权限域**照旧按名字与身份判定轻重、出材料（它不认识 MCP，只认 `ToolCall.external`
 *   与名字的形态——见 `@magic/permission` 的 `analyze`）。
 *
 * 两条规矩写在这儿：
 *
 * 1. **危险归类一律 `gated` · `reason: 'external'`**——**服务器自报的只读 / 幂等不算数**
 *    （MCP 的 `annotations` 是**服务器自己说的**，与「提示信息不可信」是同一条边界），
 *    故这一支不读它、也不因它放行；「不因自报就绕过审批或自动重试」在代码里就是这一行。
 * 2. **同名只取先到的那一件**——服务器报重名工具是**它自己的表有问题**；而内核注册表
 *    「重名即拒」是**自己表的规矩**（防的是静默打到另一份执行体上）。一个坏服务器不该
 *    把内置工具一起带走（设计明文：单个连接失败不拖垮内置工具），故这里**就地收掉**，
 *    不让它长到注册表那一关去抛。
 */

import type { McpConnection, McpPart, ToolSpec } from '@magic/contracts'
import { mcpToolName } from '@magic/contracts'
import {
  externalCanceledOutput,
  externalEmptyOutput,
  externalFailedOutput,
  externalNotSentOutput,
  externalPartNote,
  externalRefusedOutput,
} from './messages.ts'
import type { ToolDefinition } from './registry.ts'
import { refused } from './toolkit.ts'

/**
 * 一个连接 → 它的全部工具定义。
 *
 * **未连上 / 一件工具都没有** ⇒ 空表（不是错：服务器可以合法地一件工具都不提供）。
 * 名字按 `mcpToolName` 合成（`mcp__<服务器>__<工具>`）——跨服务器同名不碰撞，
 * 服务器身份从此**写在名字里**，记录、审批、模型看到的是同一个。
 */
export function defineMcpTools(connection: McpConnection): readonly ToolDefinition[] {
  const seen = new Set<string>()
  const definitions: ToolDefinition[] = []

  for (const tool of connection.tools()) {
    if (seen.has(tool.name)) continue // 服务器报重名——取先到的那一件（见文件头注 2）
    seen.add(tool.name)

    const external = { server: connection.server, tool: tool.name }

    definitions.push({
      spec: specOf(external.server, tool.name, tool.description, tool.parameters),
      external,
      run: (args, ctx) => call(connection, tool.name, args, ctx.signal),
    })
  }

  return definitions
}

/**
 * 工具规格——送模型的那四件。
 *
 * `summary` 取服务器给的说明；**没给就是一句实话**（「服务器没给说明」）——不编一句
 * 像样的假摘要：模型据描述选用工具，编出来的描述会把它引到错的地方去。
 *
 * `parameters` 原样带过（MCP 的 `inputSchema` 就是 JSON Schema）。
 */
function specOf(
  server: string,
  tool: string,
  description: string | undefined,
  parameters: ToolSpec['parameters'],
): ToolSpec {
  return {
    name: mcpToolName(server, tool),
    summary: description?.trim() === undefined || description.trim() === ''
      ? `${server} 的 ${tool}（服务器没给说明）`
      : `${description.trim()}（来自 ${server}）`,
    parameters,
    // 一律必闸（见文件头注 1）——服务器的只读 / 幂等自报在这儿不作数
    danger: { level: 'gated', reason: 'external' },
  }
}

/**
 * 调一次 —— **失败也回来**（超时 / 取消 / 断连各有确定的措辞，见 `messages.ts`）。
 *
 * 执行体**不抛**（抛出去会被分发捕成「工具执行异常」，那是给 bug 用的措辞）：
 * 「没收到结果」与「服务器说这次错了」都是正常结果的一种，模型要据此决定下一步。
 */
async function call(
  connection: McpConnection,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
): Promise<{ ok: boolean; output: string }> {
  const outcome = await connection.call(tool, args, signal === undefined ? {} : { signal })

  if (outcome.kind === 'failed') {
    // 三种失败各说各的（返工 A）：**取消**＝我们主动停的；**没发出去**＝什么都没发生；
    // 其余（超时 / 发出去之后断了）＝**效果未知**，要人核对
    if (outcome.failure === 'canceled') return refused(externalCanceledOutput(outcome.reason))
    if (outcome.failure === 'not-sent') return refused(externalNotSentOutput(outcome.reason))
    return refused(externalFailedOutput(outcome.reason))
  }

  const text = outcome.parts.map(renderPart).filter((line) => line !== '').join('\n')

  return outcome.ok
    ? { ok: true, output: text === '' ? externalEmptyOutput() : text }
    : refused(externalRefusedOutput(text))
}

/** 一个部件 → 交回模型的那段文本（非文本部件**说它来过**，不留白也不假装读懂了）。 */
function renderPart(part: McpPart): string {
  switch (part.kind) {
    case 'text':
      return part.text
    case 'structured':
      return part.text
    default:
      return externalPartNote(part.type, part.mimeType, part.bytes)
  }
}
