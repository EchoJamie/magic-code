/** 禁止清单回执（U129）——删除族统一指路 `trash`；`su` 与不合格 sudo 各有话说。 */

import { describe, expect, test } from 'bun:test'
import { execCall, makeToolDeps } from './helpers.ts'

describe('禁止清单回执', () => {
  test.each(['rm -rf x', 'shred x', 'srm x'])('%s → 已拒绝并指路 trash', async (cmd) => {
    const deps = makeToolDeps({ refusal: 'irreversible', trashAvailable: true })
    const outcome = await deps.runtime.invoke(execCall(cmd), {})
    expect(deps.sandbox.execs).toEqual([])
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('已拒绝')
    expect(outcome.output).toContain('trash')
  })

  test('su → 已拒绝，说明用单条 sudo -u', async () => {
    const deps = makeToolDeps({ refusal: 'su' })
    const outcome = await deps.runtime.invoke(execCall('su'), {})
    expect(deps.sandbox.execs).toEqual([])
    expect(outcome.output).toContain('已拒绝')
    expect(outcome.output).toContain('sudo -u')
  })

  test('sudo-unsupported → 说明只接受单行短命令与拆分方式', async () => {
    const deps = makeToolDeps({ refusal: 'sudo-unsupported' })
    const outcome = await deps.runtime.invoke(execCall("sudo sh -c 'ls'"), {})
    expect(deps.sandbox.execs).toEqual([])
    expect(outcome.output).toContain('sudo 只接受单行短命令')
    expect(outcome.output).toContain('拆成多条短命令')
  })
})
