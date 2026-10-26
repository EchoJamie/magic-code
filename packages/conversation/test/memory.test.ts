import { expect, test } from 'bun:test'
import type { MemoryItem, MemorySnapshot } from '@magic/contracts'
import { memoryBlock } from '../src/memory.ts'

const item = (id: string, fields: Partial<MemoryItem> = {}): MemoryItem => ({
  id, kind: 'fact', text: `简要结论 ${id}`, detail: `细节 ${id}`, evidence: 'fact', status: 'active',
  sources: [{ session: 'work', entry: 1 }], revision: 1, ...fields,
})
const snapshot = (items: readonly MemoryItem[]): MemorySnapshot => ({
  session: 'work', revision: 1, items, inspectedThrough: 1, summary: null, coveredThrough: null,
})

test('大量完成阶段细节退出日常上下文，全部有效要求与未决入口保留且记录不变', () => {
  const requirements = Array.from({ length: 27 }, (_, index) => item(`rule-${index}`, { kind: 'requirement', detail: `完整约束 ${index}：不可撤销的具体边界` }))
  const completed = Array.from({ length: 200 }, (_, index) => item(`done-${index}`, {
    kind: 'step', status: index % 2 === 0 ? 'resolved' : 'active', progress: 'completed', scope: '登录',
    detail: `已完成阶段细节 ${index} ${'历史过程'.repeat(1000)}`,
  }))
  const pending = Array.from({ length: 27 }, (_, index) => item(`question-${index}`, { kind: 'question', evidence: 'unresolved' }))
  const memory = snapshot([...requirements, ...completed, ...pending,
    item('current', { kind: 'step', progress: 'in_progress', scope: '登录', detail: '当前操作必须核对返回值' }),
    item('related', { kind: 'question', evidence: 'unresolved', scope: '登录', detail: '同一主题的未知结果不可重做' }),
    item('withdrawn', { kind: 'requirement', status: 'invalid', detail: '已撤回的旧约束' }),
  ])
  const before = JSON.stringify(memory)
  const block = memoryBlock(memory)
  for (const rule of requirements) expect(block).toContain(rule.detail!)
  for (const done of completed) { expect(block).toContain(done.text); expect(block).not.toContain(done.detail!) }
  for (const question of pending) { expect(block).toContain(question.text); expect(block).not.toContain(question.detail!) }
  expect(block).toContain('当前操作必须核对返回值')
  expect(block).toContain('同一主题的未知结果不可重做')
  expect(block).not.toContain('已撤回的旧约束')
  expect(block).toContain('work#1')
  expect(JSON.stringify(memory)).toBe(before)
})

test('没有计划时按最新交代中的事项或主题展开，回问完成阶段可以重新取得细节', () => {
  const memory = snapshot([
    item('question', { kind: 'question', evidence: 'unresolved', scope: '分页', detail: '分页需要核实游标失效条件' }),
    item('complete', { status: 'resolved', scope: '迁移', detail: '迁移阶段的执行事实' }),
    item('corrected', { kind: 'requirement', revision: 2, text: '改为只读核对', detail: '最新纠正禁止写入真实服务' }),
  ])
  expect(memoryBlock(memory, { latestInput: '继续核对分页' })).toContain('分页需要核实游标失效条件')
  expect(memoryBlock(memory, { latestInput: '继续核对分页' })).not.toContain('迁移阶段的执行事实')
  expect(memoryBlock(memory, { latestInput: '回查迁移' })).toContain('迁移阶段的执行事实')
  expect(memoryBlock(memory)).toContain('最新纠正禁止写入真实服务')
})

test('工作记忆分别显示实际采用和仅提供材料，不把旁支提供标成采用', () => {
  const memory = snapshot([item('finding', { knowledge: [{ id: 'adopted', revision: 2 }, { id: 'context-only', revision: 3, provided: true }] })])
  const block = memoryBlock(memory)
  expect(block).toContain('采用知识：adopted@2')
  expect(block).toContain('仅提供材料：context-only@3')
  expect(block).not.toContain('采用知识：adopted@2、context-only')
  expect(memory.items[0]?.knowledge).toEqual([{ id: 'adopted', revision: 2 }, { id: 'context-only', revision: 3, provided: true }])
})
