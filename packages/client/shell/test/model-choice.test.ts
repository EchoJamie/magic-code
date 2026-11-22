import { expect, spyOn, test } from 'bun:test'
import { createStage } from './screen.ts'
import { event } from './events.ts'
const pair = { provider: 'local', model: 'deepseek-chat' }
const configuredModels = { cantrip: pair, spell: pair, arcane: pair }
const entries = [{ effectiveReasoning: { [pair.model]: { levels: ['low', 'high'], disable: true } }, provider: 'local', vendor: 'deepseek', cache: { snapshot: { provider: 'local', scope: 'test', fetchedAt: 1, models: [{ id: pair.model, reasoning: { levels: ['low', 'high'], disable: true } }] } } }]
function settings(configured = true, stage = createStage()) {
  // 设置视图（映射编辑 ＋ 工作选择 ＋ 思考 ＋ 连接动作）从 **/config · 模型与连接** 进；
  // /model 本体是档位切换器（另测）。已有会话的切换（选定要发 `model.switch`）在此守。
  if (stage.shell.getView().sessionId === null) stage.feed([event('session.state', { active: 'fixture', sessions: [{ archived: false, id: 'fixture', title: '夹具会话', at: 1 }] })])
  stage.type('/config '); stage.press({ kind: 'enter' })
  stage.feed([
    event('model.catalog', { entries, configuredModels: configured ? configuredModels : {}, ...(configured ? { current: { protocol: 'chat-completions', endpoint: 'https://fixture.invalid/v1', choice: 'cantrip', ...pair } as const } : {}) }),
    event('mcp.catalog', { servers: [] }),
    event('web.state', { provider: 'local', cantrip: { provider: 'local', model: 'deepseek-chat' } }),
  ])
  pick(stage, 'model')
  stage.feed([event('model.catalog', { entries, configuredModels: configured ? configuredModels : {}, ...(configured ? { current: { protocol: 'chat-completions', endpoint: 'https://fixture.invalid/v1', choice: 'cantrip', ...pair } as const } : {}) })])
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
test('三档映射编辑；实际型号只在编辑层列出，思考不写入映射', () => {
  const stage = settings()
  expect(picker(stage).rows.slice(0, 5).map(row => row.value)).toEqual(['edit:cantrip', 'edit:spell', 'edit:arcane', 'choose', 'reasoning'])
  expect(picker(stage).hint).toContain('当前三个档位使用同一模型')
  pick(stage, 'edit:cantrip'); stage.press({ kind: 'enter' })
  expect(stage.commands().at(-1)).toEqual({ type: 'model.configure', choice: 'cantrip', ...pair })
  expect(stage.commands().some(one => one.type === 'model.switch')).toBe(false)
})
test('/model 是档位切换器：三档直选，选定即发 model.switch', () => {
  const stage = createStage()
  stage.feed([event('session.state', { active: 'fixture', sessions: [{ archived: false, id: 'fixture', title: '夹具会话', at: 1 }] })])
  stage.type('/model '); stage.press({ kind: 'enter' })
  stage.feed([event('model.catalog', { entries, configuredModels, current: { protocol: 'chat-completions', endpoint: 'https://fixture.invalid/v1', choice: 'cantrip', ...pair } as const })])
  expect(picker(stage).rows.map(row => row.value)).toEqual(['cantrip', 'spell', 'arcane'])
  expect(picker(stage).rows.find(row => row.value === 'cantrip')?.current).toBe(true)
  expect(picker(stage).hint).toContain('新会话也从它开始')
  pick(stage, 'spell')
  expect(stage.commands().at(-1)).toEqual({ type: 'model.switch', choice: 'spell' })
})
test('首次保存播种三档并记开局档位；保存成功回执后才应用，失败不报成功', () => {
  const stage = settings(false)
  pick(stage, 'edit:cantrip')
  expect(picker(stage).hint).toContain('使用此模型开始')
  stage.press({ kind: 'enter' })
  expect(stage.commands().at(-1)).toEqual({ type: 'model.configure', choice: 'cantrip', ...pair, initialize: true })
  expect(stage.commands().some(one => one.type === 'model.switch')).toBe(false)
  stage.feed([event('model.catalog', { entries, configuredModels, note: '已保存 Cantrip', saved: true })])
  expect(stage.commands().at(-1)).toEqual({ type: 'model.switch', choice: 'cantrip' })
  const failed = settings(false); pick(failed, 'edit:cantrip'); failed.press({ kind: 'enter' })
  failed.feed([event('model.catalog', { entries, configuredModels: {}, note: '配置保存失败' })])
  expect(failed.commands().some(one => one.type === 'model.switch')).toBe(false)
})
test('工作选择只列三个档位；缺档位仍可见、拒绝时不给执行命令', () => {
  const stage = settings(false); pick(stage, 'choose')
  expect(picker(stage).rows.map(row => row.label)).toEqual(['Cantrip', 'Spell', 'Arcane'])
  pick(stage, 'spell')
  expect(stage.commands().some(one => one.type === 'model.switch')).toBe(false)
  expect(stage.shell.getView().settled.some(row => JSON.stringify(row).includes('尚未配置'))).toBe(true)
})
test('思考独立修改有效当前组合；配置映射编辑不携带思考设置', () => {
  const stage = settings(); pick(stage, 'reasoning')
  expect(picker(stage).rows.map(row => row.label)).toEqual(['模型默认', '明确关闭', 'low', 'high'])
  stage.press({ kind: 'down' }); stage.press({ kind: 'down' }); stage.press({ kind: 'enter' })
  expect(stage.commands().at(-1)).toEqual({ type: 'model.switch', reasoning: { mode: 'level', level: 'low' } })
})
test('A 的首次保存迟到时保留配置结果，不关闭 B 的模型页或应用到 B', () => {
  const stage = createStage()
  const sessions = [
    { id: 'a', title: '工作 A', at: 1, archived: false },
    { id: 'b', title: '工作 B', at: 2, archived: false },
  ]
  stage.feed([event('session.state', { active: 'a', sessions }, { session: 'a' })])
  settings(false, stage)
  pick(stage, 'edit:cantrip')
  stage.press({ kind: 'enter' })
  expect(stage.commands().at(-1)).toMatchObject({ type: 'model.configure', initialize: true })
  stage.press({ kind: 'escape' })
  stage.press({ kind: 'escape' })
  stage.press({ kind: 'escape' })
  stage.type('/resume ')
  stage.press({ kind: 'enter' })
  stage.feed([event('session.state', { active: 'a', sessions }, { session: 'a' })])
  pick(stage, 'b')
  expect(stage.commands().some(command => command.type === 'session.open' && command.session === 'b')).toBe(true)
  stage.feed([event('session.state', { active: 'b', sessions }, { session: 'b' })])
  settings(false, stage)
  expect(stage.shell.getView().sessionId).toBe('b')
  const before = picker(stage)

  stage.feed([event('model.catalog', { entries, configuredModels, saved: true, note: '已保存 Cantrip' }, { session: 'a' })])

  expect(stage.shell.getView().sessionId).toBe('b')
  expect(picker(stage).source).toBe(before.source)
  expect(stage.shell.getView().configuredModels).toEqual(configuredModels)
  expect(stage.commands().filter(command => command.type === 'model.switch')).toEqual([])
  expect(JSON.stringify(stage.shell.getView().settled)).toContain('已保存 Cantrip')
  stage.shell.dispose()
})
test('普通映射保存离开后，迟到回执不关闭新开的会话目录', () => {
  const stage = settings()
  pick(stage, 'edit:cantrip')
  stage.press({ kind: 'enter' })
  stage.press({ kind: 'escape' })
  stage.press({ kind: 'escape' })
  stage.press({ kind: 'escape' })
  stage.type('/resume ')
  stage.press({ kind: 'enter' })
  stage.feed([event('session.state', { active: '', sessions: [] })])
  expect(picker(stage).source).toBe('session')
  const before = picker(stage)

  stage.feed([event('model.catalog', { entries, configuredModels, saved: true, note: '已保存 Cantrip' })])

  expect(picker(stage)).toEqual(before)
  expect(stage.shell.getView().configuredModels).toEqual(configuredModels)
  expect(stage.commands().filter(command => command.type === 'model.switch')).toEqual([])
  stage.shell.dispose()
})
test('退出映射层后返回同一映射，旧回执不关新页、不重发保存', () => {
  const stage = settings(false)
  pick(stage, 'edit:cantrip')
  stage.press({ kind: 'enter' })
  stage.press({ kind: 'escape' })
  pick(stage, 'edit:cantrip')
  stage.press({ kind: 'enter' })
  expect(stage.commands().filter(command => command.type === 'model.configure')).toHaveLength(1)

  stage.feed([event('model.catalog', { entries, configuredModels, saved: true, note: '已保存 Cantrip' })])

  expect(picker(stage).source).toBe('model')
  expect(stage.commands().filter(command => command.type === 'model.switch')).toEqual([])
  stage.press({ kind: 'enter' })
  expect(stage.commands().filter(command => command.type === 'model.configure')).toHaveLength(2)
  stage.shell.dispose()
})
test.each([false, true])('原映射页同步保存只关闭原页，仅首次初始化应用当前工作（已配置=%s）', configured => {
  const stage = settings(configured)
  pick(stage, 'edit:cantrip')
  const send = stage.spy.transport.send
  const replying = spyOn(stage.spy.transport, 'send').mockImplementation(command => {
    send(command)
    if (command.type === 'model.configure') {
      stage.feed([event('model.catalog', { entries, configuredModels, saved: true, note: '已保存 Cantrip' })])
    }
  })
  try {
    stage.press({ kind: 'enter' })
    expect(stage.shell.getView().dock.kind).toBe('input')
    expect(stage.shell.getView().configuredModels).toEqual(configuredModels)
    expect(stage.commands().filter(command => command.type === 'model.switch')).toEqual(configured ? [] : [
      { type: 'model.switch', choice: 'cantrip' },
    ])
  } finally {
    replying.mockRestore()
    stage.shell.dispose()
  }
})
test.each(['connect', 'manage'] as const)('模型页 %s 入口同步答复仍保存原模型层，Esc 返回原焦点', action => {
  const stage = settings()
  const send = stage.spy.transport.send
  const replying = spyOn(stage.spy.transport, 'send').mockImplementation(command => {
    send(command)
    if (command.type === 'provider.list') stage.feed([event('provider.catalog', { entries, vendors: [] })])
  })
  try {
    pick(stage, action)
    expect(picker(stage).source).toBe(action === 'connect' ? 'vendor' : 'provider')
    stage.press({ kind: 'escape' })
    expect(picker(stage).source).toBe('model')
    expect(picker(stage).rows[picker(stage).selected]?.value).toBe(action)
  } finally {
    replying.mockRestore()
    stage.shell.dispose()
  }
})
test('离开模型页后连接目录迟到，不重新打开连接页', () => {
  const stage = settings()
  pick(stage, 'connect')
  stage.press({ kind: 'escape' })
  stage.press({ kind: 'escape' })
  stage.press({ kind: 'escape' })
  stage.feed([event('provider.catalog', { entries, vendors: [] })])
  expect(stage.shell.getView().dock.kind).toBe('input')
  stage.shell.dispose()
})
test('从映射层等待连接目录时返回上层，迟到目录不抢回导航', () => {
  const stage = settings()
  pick(stage, 'edit:cantrip')
  pick(stage, 'connect')
  stage.press({ kind: 'escape' })
  const before = picker(stage)
  stage.feed([event('provider.catalog', { entries, vendors: [] })])
  expect(picker(stage).source).toBe('model')
  expect(picker(stage).rows).toEqual(before.rows)
  stage.shell.dispose()
})
test('编辑全局映射时，状态行思考仍来自当前工作的有效选择', () => {
  const stage = settings()
  stage.feed([event('model.catalog', {
    entries,
    configuredModels: { ...configuredModels, cantrip: pair },
    current: { ...pair, choice: 'cantrip', protocol: 'chat-completions', endpoint: 'https://fixture.invalid/v1', reasoning: { mode: 'level', level: 'high' } },
  })])
  pick(stage, 'edit:cantrip')
  stage.feed([event('provider.catalog', { entries, vendors: [] })])
  expect(stage.shell.getView().status.reasoning).toBe('high')
  stage.shell.dispose()
})
