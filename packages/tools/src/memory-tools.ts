import type { MemoryAccess, MemoryUpdate, MemorySource } from '@magic/contracts'
import { defineTool, type ToolDefinition } from './registry.ts'

export const MEMORY_TOOL_NAMES: readonly string[] = ['memory_read', 'memory_update', 'source_read']
const source = { type: 'object', properties: { session: { type: 'string' }, entry: { type: 'integer' }, part: { type: 'integer', minimum: -1, description: '省略读取含引用的完整材料；-1只读真实用户原始正文，非负数只读该引用。保存独立用户要求可用-1避免混入引用依据。' }, offset: { type: 'integer' } }, required: ['session', 'entry'], additionalProperties: false }

export function defineMemoryTools(access: MemoryAccess): readonly ToolDefinition[] {
  const specs = [
    { name: 'memory_read', summary: '读取自身工作记忆、来源与最新修订；修改前先读取。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'memory_update', summary: '按预期修订增量新增/修正/失效具体事项，不覆盖无关事项。目标与步骤投影为计划。仅在实际检查后确认 inspectedThrough；无需改变认识时 changes 可为空。', parameters: {
      type: 'object', properties: {
        expectedRevision: { type: 'integer' }, inspectedThrough: { type: 'integer' },
        changes: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, kind: { type: 'string', enum: ['goal', 'requirement', 'fact', 'decision', 'question', 'step', 'verification'] },
          text: { type: 'string' }, detail: { type: 'string' }, scope: { type: 'string' },
          evidence: { type: 'string', enum: ['fact', 'hypothesis', 'unresolved'] }, status: { type: 'string', enum: ['active', 'resolved', 'invalid'] },
          reuse: { type: 'string', enum: ['project', 'user'], description: '仅重要且可复用的认识标记。user 只用于用户明确要求适用于所有工作的通用约定。' },
          knowledge: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, revision: { type: 'integer' },
            provided: { type: 'boolean', enum: [true], description: '仅提供材料的血缘，不表示已采用；保留读取到的用途，实际采用时省略此标记。' },
          }, required: ['id', 'revision'], additionalProperties: false } },
          sources: { type: 'array', items: source }, order: { type: 'number' }, progress: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        }, required: ['id', 'kind', 'text', 'evidence', 'status', 'sources'], additionalProperties: false } },
      }, required: ['expectedRevision', 'changes'], additionalProperties: false,
    } },
    { name: 'source_read', summary: '读取已绑定会话来源的公开正文，返回说话人、完整性和续读位置；不能传会话身份扩大权限。', parameters: { ...source, properties: { ...source.properties, limit: { type: 'integer' } } } },
  ] as const
  return specs.map(spec => defineTool({ spec: { ...spec, danger: { level: 'light' } }, prepare: args => args, async run(args) {
    try {
      if (spec.name === 'memory_read') return { ok: true, output: JSON.stringify(access.read()) }
      if (spec.name === 'source_read') return { ok: true, output: JSON.stringify(await access.source(args as MemorySource & { limit?: number })) }
      if (!Number.isSafeInteger(args['expectedRevision']) || !Array.isArray(args['changes'])) return { ok: false, output: '需要 expectedRevision 和 changes 数组' }
      const result = access.update(args as MemoryUpdate)
      return { ok: result.ok, output: JSON.stringify(result) }
    } catch (error) { return { ok: false, output: error instanceof Error ? error.message : String(error) } }
  } }))
}
