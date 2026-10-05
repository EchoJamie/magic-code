import { expect, test } from 'bun:test'
import { createStage } from './screen.ts'
import { event } from './events.ts'
const pair = { provider: 'local', model: 'deepseek-chat' }
const aliases = { default: pair, cantrip: pair, spell: pair, arcane: pair }
const entries = [{ provider: 'local', vendor: 'deepseek', cache: { snapshot: { provider: 'local', scope: 'test', fetchedAt: 1, models: [{ id: pair.model, reasoning: { levels: ['low', 'high'], disable: true } }] } } }]
function settings(configured = true) {
  const stage = createStage()
  stage.type('/model'); stage.press({ kind: 'enter' })
  stage.feed([event('model.catalog', { entries, aliases: configured ? aliases : {}, ...(configured ? { current: { alias: 'default', ...pair } as const } : {}) })])
  return stage
}
function pick(stage: ReturnType<typeof createStage>, value: string) {
  const dock = stage.shell.getView().dock
  if (dock.kind !== 'picker') throw new Error('未打开模型设置')
  const at = dock.picker.rows.findIndex(row => row.value === value)
  if (at < 0) throw new Error(`缺入口 ${value}`)
  for (let i = 0; i < (at - dock.picker.selected + dock.picker.rows.length) % dock.picker.rows.length; i++) stage.press({ kind: 'down' })
  stage.press({ kind: 'enter' })
}
function picker(stage: ReturnType<typeof createStage>) {
  const dock = stage.shell.getView().dock
  if (dock.kind !== 'picker') throw new Error('缺少选择器')
  return dock.picker
}
test('Default 与三档分开；只在映射编辑层列实际型号，思考不写入映射', () => {
  const stage = settings()
  expect(picker(stage).rows.slice(0, 6).map(row => row.value)).toEqual(['edit:default','edit:cantrip','edit:spell','edit:arcane','choose','reasoning'])
  expect(picker(stage).hint).toContain('当前三个档位使用同一模型')
  pick(stage, 'edit:cantrip'); stage.press({ kind: 'enter' })
  expect(stage.commands().at(-1)).toEqual({ type: 'model.alias.set', alias: 'cantrip', ...pair })
  expect(stage.commands().some(one => one.type === 'model.switch')).toBe(false)
})
test('首次明确使用才初始化；保存成功回执后才应用 Default，失败不报成功', () => {
  const stage = settings(false)
  pick(stage, 'edit:default')
  expect(picker(stage).hint).toContain('使用此模型开始')
  stage.press({ kind: 'enter' })
  expect(stage.commands().at(-1)).toEqual({ type: 'model.alias.set', alias: 'default', ...pair, initialize: true })
  expect(stage.commands().some(one => one.type === 'model.switch')).toBe(false)
  stage.feed([event('model.catalog', { entries, aliases, note: '已保存 Default' })])
  expect(stage.commands().at(-1)).toEqual({ type: 'model.switch', alias: 'default' })
  const failed = settings(false); pick(failed, 'edit:default'); failed.press({ kind: 'enter' })
  failed.feed([event('model.catalog', { entries, aliases: {}, note: '配置保存失败' })])
  expect(failed.commands().some(one => one.type === 'model.switch')).toBe(false)
})
test('工作选择只列四个配置来源；缺档位仍可见、拒绝时不给执行命令', () => {
  const stage = settings(false); pick(stage, 'choose')
  expect(picker(stage).rows.map(row => row.label)).toEqual(['Default','Cantrip','Spell','Arcane'])
  pick(stage, 'spell')
  expect(stage.commands().some(one => one.type === 'model.switch')).toBe(false)
  expect(stage.shell.getView().settled.some(row => JSON.stringify(row).includes('尚未配置'))).toBe(true)
})
test('思考独立修改有效当前组合；配置映射编辑不携带思考设置', () => {
  const stage = settings(); pick(stage, 'reasoning')
  expect(picker(stage).rows.map(row => row.label)).toEqual(['模型默认','明确关闭','low','high'])
  stage.press({ kind: 'down' }); stage.press({ kind: 'down' }); stage.press({ kind: 'enter' })
  expect(stage.commands().at(-1)).toEqual({ type: 'model.switch', reasoning: { mode: 'level', level: 'low' } })
})
