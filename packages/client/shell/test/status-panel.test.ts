import { expect, test } from 'bun:test'
import { createStage } from './screen.ts'
import { event } from './events.ts'

/**
 * `/status` 的会话信息面（2026-11-22 用户定稿的设计）：
 *
 * - **无标签列**——内容的形状自明（8 位十六进制＋标题＝会话、绝对路径＝工作区、
 *   档位开头＝模型组合、`输入 x/y`＝用量）；
 * - **不抄状态行**——面板给行上放不下的那一层（全路径、连接、思考档、回合时长）；
 * - **没消息不占行**——出错才有 ▲ 行，「未见异常」那种话不存在；
 * - **0 是事实**——新会话的用量就是 `0/…`，不是「还没上报」。
 */

const entries = [
  {
    provider: 'minimax',
    cache: { snapshot: { provider: 'minimax', scope: 'fixture', fetchedAt: 1, models: [{ id: 'MiniMax-M3', reasoning: { levels: ['low', 'high'], disable: true } }] } },
    effectiveReasoning: { 'MiniMax-M3': { levels: ['low', 'high'], disable: true, defaultLevel: 'high' } },
  },
]
const current = { protocol: 'chat-completions' as const, endpoint: 'https://fixture.invalid/v1', choice: 'cantrip' as const, provider: 'minimax', model: 'MiniMax-M3' }

function sessionStage() {
  const stage = createStage({ workspaceRoots: ['/Users/jamie/namespace/github/magic-code'] })
  stage.feed([
    event('session.state', { active: 'a1b2c3d4e5f6a7b8', sessions: [{ archived: false, id: 'a1b2c3d4e5f6a7b8', title: '修复时区处理…', at: 1, workspace: ['/Users/jamie/namespace/github/magic-code'] }] }),
    event('model.catalog', { entries, configuredModels: { cantrip: { provider: 'minimax', model: 'MiniMax-M3' } }, current }),
    event('model.switched', { ok: true, choice: 'cantrip', provider: 'minimax', model: 'MiniMax-M3', protocol: 'chat-completions', endpoint: 'https://fixture.invalid/v1', inputBudget: 29_672 }),
    event('model.usage', { inputTokens: 3100 }),
  ])
  return stage
}

function statusRows(stage: ReturnType<typeof sessionStage>): readonly string[] {
  stage.type('/status')
  stage.press({ kind: 'enter' })
  const settled = stage.shell.getView().settled
  const row = settled.at(-1)
  if (row === undefined || row.kind !== 'output') throw new Error('没有输出块')
  return row.lines
}

test('运行过的会话：四行＝身份（id 前 8 位·标题）/ 工作区全路径 / 模型组合 / 计量', () => {
  const rows = statusRows(sessionStage())
  expect(rows[0]).toBe('此刻')
  expect(rows[1]).toBe('a1b2c3d4 · 修复时区处理…')
  expect(rows[2]).toBe('/Users/jamie/namespace/github/magic-code')
  // 模型组合：档位 · 连接 / 型号 · 思考档（思考显示的就是值，不汉化、无前缀）
  expect(rows[3]).toBe('Cantrip · minimax / MiniMax-M3 · high')
  expect(rows[4]).toBe('输入 3.1k/30k')
})

test('思考跟着默认走 ⇒ 显示供应商声明的默认档；没声明才说「默认」', () => {
  const stage = sessionStage()
  stage.feed([event('model.switched', { ok: true, choice: 'cantrip', provider: 'minimax', model: 'MiniMax-M3', protocol: 'chat-completions', endpoint: 'https://fixture.invalid/v1' })])
  expect(statusRows(stage)[3]).toBe('Cantrip · minimax / MiniMax-M3 · high')

  const bare = createStage()
  bare.feed([
    event('session.state', { active: 'a1b2c3d4e5f6a7b8', sessions: [{ archived: false, id: 'a1b2c3d4e5f6a7b8', title: '修复时区处理…', at: 1 }] }),
    event('model.catalog', { entries: [{ provider: 'minimax' }], configuredModels: { cantrip: { provider: 'minimax', model: 'MiniMax-M3' } }, current }),
  ])
  expect(statusRows(bare)[2]).toBe('Cantrip · minimax / MiniMax-M3 · 默认')
})

test('新会话：如实说「新会话」＋启动根；用量是**真零**（0/…不是编的）；没轮次不提时长', () => {
  const stage = createStage({ workspaceRoots: ['/Users/jamie/namespace/github/magic-code'] })
  stage.feed([event('model.catalog', { entries, configuredModels: { cantrip: { provider: 'minimax', model: 'MiniMax-M3' } }, current })])
  const rows = statusRows(stage)
  expect(rows[1]).toBe('新会话')
  expect(rows[2]).toBe('/Users/jamie/namespace/github/magic-code')
  expect(rows[3]).toBe('Cantrip · minimax / MiniMax-M3 · high')
  expect(rows[4]).toBe('输入 0')
})

test('没消息不占行；最近一次调用出错才出 ▲ 行', () => {
  const stage = sessionStage()
  expect(statusRows(stage).some(one => one.startsWith('▲'))).toBe(false)

  const failed = sessionStage()
  failed.feed([event('model.error', { tier: 'terminal', message: 'key 不对' })])
  expect(statusRows(failed).at(-1)).toBe('▲ 上一次模型调用没成')
})

test('多根工作区全列（联合作用域）；旧账缺席＝整行不出现', () => {
  const stage = createStage({ workspaceRoots: ['/a', '/b'] })
  stage.feed([
    event('session.state', { active: 'a1b2c3d4e5f6a7b8', sessions: [{ archived: false, id: 'a1b2c3d4e5f6a7b8', title: '修复时区处理…', at: 1, workspace: ['/a', '/b'] }] }),
    event('model.catalog', { entries, configuredModels: { cantrip: { provider: 'minimax', model: 'MiniMax-M3' } }, current }),
  ])
  expect(statusRows(stage)[2]).toBe('/a ＋ /b')

  // 列加上之前落账的会话没有 workspace 字段＝无法知道，不编
  const legacy = createStage({ workspaceRoots: ['/a'] })
  legacy.feed([
    event('session.state', { active: 'a1b2c3d4e5f6a7b8', sessions: [{ archived: false, id: 'a1b2c3d4e5f6a7b8', title: '修复时区处理…', at: 1 }] }),
    event('model.catalog', { entries, configuredModels: { cantrip: { provider: 'minimax', model: 'MiniMax-M3' } }, current }),
  ])
  expect(statusRows(legacy).some(one => one.startsWith('/'))).toBe(false)
})
