import type { MemorySource, MaterialPage } from '@magic/contracts'
import { defineTool, type ToolDefinition } from './registry.ts'

const source = { type: 'object', properties: { session: { type: 'string' }, entry: { type: 'integer' }, part: { type: 'integer', minimum: -1, description: '省略读取含引用的完整材料；-1只读真实用户原始正文，非负数只读该引用。保存独立用户要求可用-1避免混入引用依据。' }, offset: { type: 'integer' } }, required: ['session', 'entry'], additionalProperties: false }

/** 原始来源读取独立于旧事项模型。 */
export function defineSourceTool(read: (source: MemorySource & { limit?: number }) => Promise<MaterialPage>): ToolDefinition {
  return defineTool({
    spec: { name: 'source_read', summary: '读取本会话或已受理固定引用范围的真实来源正文',
      parameters: { ...source, properties: { ...source.properties, limit: { type: 'integer', minimum: 1, maximum: 32000 } } }, danger: { level: 'light' } },
    prepare: args => args,
    async run(args) {
      try { return { ok: true, output: JSON.stringify(await read(args as MemorySource & { limit?: number })) } }
      catch (error) { return { ok: false, output: error instanceof Error ? error.message : String(error) } }
    },
  })
}
