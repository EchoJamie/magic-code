/**
 * 工具集 v1 —— **七件**（`exec` ＋ `read` / `write` / `edit` / `grep` / `glob` / `ls`）。
 *
 * 出处：技术方案 · 工具「工具集 v1（阶段 2 · 规格）」的规格表 ＋ 契约的 `TOOLSET_V1` 冻结行。
 * 一域之内，件数与顺序都对着那张表——**顺序＝表的顺序**（送模型的次序稳定，好对照）。
 *
 * 默认集就是它：**机制在内、工具集在外**说的是「集可插拔」，不是「集必须由装配一件件摆」
 * （技术方案 · 工具域规则）。阶段 1 的默认集只有 `exec`（那时其余六件还没做）；
 * 工具集 v1 到站（U13）后，内核默认就有这七件——`options.tools` 仍是**追加**出口
 * （自定义工具 / 未来的 MCP 集从这里进来），不替换默认集。
 */

import { defineExecTool } from './exec-tool.ts'
import { defineEditTool, defineReadTool, defineWriteTool } from './file-tools.ts'
import type { ToolDefinition } from './registry.ts'
import { defineGlobTool, defineGrepTool, defineLsTool } from './search-tools.ts'

/** 造工具集 v1（七件，顺序照契约 `TOOLSET_V1`）。 */
export function defineToolsetV1(): readonly ToolDefinition[] {
  return [
    defineExecTool(),
    defineReadTool(),
    defineWriteTool(),
    defineEditTool(),
    defineGrepTool(),
    defineGlobTool(),
    defineLsTool(),
  ]
}
