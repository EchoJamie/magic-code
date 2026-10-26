import type { KnowledgeAccess, KnowledgeCorrection, KnowledgeQuery } from '@magic/contracts'
import { defineTool, type ToolDefinition } from './registry.ts'
import { reasonOf, refused } from './toolkit.ts'

export const KNOWLEDGE_TOOL_NAMES = ['knowledge_search', 'knowledge_read', 'knowledge_source', 'knowledge_update'] as const
const sourceProperties = {
  session: { type: 'string' }, entry: { type: 'integer', minimum: 1 }, part: { type: 'integer', minimum: -1, description: '省略为完整材料；-1仅指真实用户原始正文，非负为引用序号。通用要求或明确重新记住可定位正文。' }, offset: { type: 'integer', minimum: 0 },
}
const sourceSchema = { type: 'object', required: ['session', 'entry'], properties: sourceProperties }
const dependencySchema = { type: 'array', items: { type: 'object', required: ['id', 'revision'], properties: { id: { type: 'string' }, revision: { type: 'integer', minimum: 1 } } } }

/** 咨询成员只装配读工具；写入端口同时校验身份，避免仅靠工具列表阻止越权。 */
export function defineKnowledgeTools(access: KnowledgeAccess, writable: boolean): readonly ToolDefinition[] {
  const search = defineTool({
    spec: { name: 'knowledge_search', summary: '查找当前范围的知识；可改写中文别称/英文查找词，不给查询则按主题分页发现。候选须核对成立条件后采用。', danger: { level: 'light' },
      parameters: { type: 'object', properties: { query: { type: 'string' }, topic: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
    prepare(args) { return args as KnowledgeQuery & Record<string, unknown> },
    run(query) { try { const page = access.search(query); return { ok: true, output: JSON.stringify({ ...page, knowledge: page.items.map(({ id, revision }) => ({ id, revision })) }) } } catch (error) { return refused(reasonOf(error)) } },
  })
  const read = defineTool({
    spec: { name: 'knowledge_read', summary: '按真实 id 精读最新知识、修订、条件及来源。纠正前必须先读；待判断或失效内容不能直接采用。', danger: { level: 'light' },
      parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    prepare(args) { return { id: requiredText(args.id, 'id') } },
    run({ id }) { const item = access.read(id); return item === undefined ? refused('知识不存在或不在当前范围') : { ok: true, output: JSON.stringify({ ...item, knowledge: [{ id: item.id, revision: item.revision }] }) } },
  })
  const source = defineTool({
    spec: { name: 'knowledge_source', summary: '读取所选知识的一条具体证据，可按返回 next 继续分页；不会开放来源会话的其他历史。', danger: { level: 'light' },
      parameters: { type: 'object', required: ['id', 'session', 'entry'], properties: { id: { type: 'string' }, ...sourceProperties, limit: { type: 'integer', minimum: 1 } } } },
    prepare(args) {
      const id = requiredText(args.id, 'id')
      const session = requiredText(args.session, 'session')
      if (!Number.isSafeInteger(args.entry) || (args.entry as number) < 1) throw new Error('entry 须为真实来源记录号')
      for (const name of ['offset', 'part', 'limit'] as const) {
        if (args[name] !== undefined && (!Number.isSafeInteger(args[name]) || (args[name] as number) < (name === 'limit' ? 1 : name === 'part' ? -1 : 0))) throw new Error(`${name} 无效`)
      }
      return { id, source: { session, entry: args.entry as number, ...(args.part === undefined ? {} : { part: args.part as number }),
        ...(args.offset === undefined ? {} : { offset: args.offset as number }), ...(args.limit === undefined ? {} : { limit: args.limit as number }) } }
    },
    async run({ id, source }) { try { return { ok: true, output: JSON.stringify(await access.source(id, source)) } } catch (error) { return refused(reasonOf(error)) } },
  })
  if (!writable) return [search, read, source]
  const update = defineTool({
    spec: { name: 'knowledge_update', summary: '先精读最新知识，再按用户纠正/反例提交局部变化，保留未涉及内容。条件不同不等于错误；不能改变范围。仅用户明确要求重新记住时，remember 填本次用户交代来源，同时重新给出完整结论和条件。', danger: { level: 'light' },
      parameters: { type: 'object', required: ['id', 'expectedRevision', 'changes'], properties: {
        id: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 1 }, remember: sourceSchema, changes: { type: 'object', properties: {
          topic: { type: 'string' }, terms: { type: 'array', items: { type: 'string' } }, conclusion: { type: 'string' }, conditions: { type: 'string' },
          evidence: { enum: ['fact', 'hypothesis', 'unresolved'] }, status: { enum: ['active', 'pending', 'invalid'] },
          sources: { type: 'array', items: sourceSchema }, dependencies: dependencySchema,
        } },
      } } },
    prepare(args) {
      const id = requiredText(args.id, 'id')
      if (!Number.isSafeInteger(args.expectedRevision) || (args.expectedRevision as number) < 1) throw new Error('expectedRevision 须为精读取得的修订')
      if (args.changes === null || typeof args.changes !== 'object' || Array.isArray(args.changes)) throw new Error('changes 须为局部修改对象')
      const changes = args.changes as KnowledgeCorrection['changes']
      const allowed = ['topic', 'terms', 'conclusion', 'conditions', 'evidence', 'status', 'sources', 'dependencies']
      if (Object.keys(changes).length === 0 || Object.keys(changes).some(key => !allowed.includes(key))) throw new Error('changes 为空或包含不可修改的字段')
      const remember = args.remember as KnowledgeCorrection['remember']
      if (remember !== undefined && (remember === null || typeof remember !== 'object' || typeof remember.session !== 'string' || !Number.isSafeInteger(remember.entry) || remember.entry < 1)) throw new Error('remember 须为本次明确用户交代来源')
      return { id, expectedRevision: args.expectedRevision as number, changes, ...(remember === undefined ? {} : { remember }) }
    },
    async run(change) { try { const result = await access.update(change); return { ok: result.ok, output: JSON.stringify({ ...result, ...(result.ok ? { knowledge: result.items.map(({ id, revision }) => ({ id, revision })) } : {}) }) } } catch (error) { return refused(reasonOf(error)) } },
  })
  return [search, read, source, update]
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 须为非空字符串`)
  return value
}
