/** 协作边界（T2.2 · 约束写经帧）——P0 回归：发布失败必须上抛，不能 void 掉 Promise。 */
import { expect, test } from 'bun:test'
import { createCollaborationBoundary } from '../src/collaboration-boundary.ts'

/**
 * 最小记录桩——`userInput` 路径只碰 `binding()` 那三件（身份 / 协作 / 委派表）。
 * `publishConstraint` 直写在此是**禁区**：接了 `write` 还直写 ＝ 走错了分支。
 */
function recordsOf(): never {
  return {
    agentForSession: () => ({ agentId: 'a1', sessionId: 's', name: '入口', role: '', collaborationId: 'c1', workspace: [] }),
    getCollaboration: () => ({ collaborationId: 'c1', coordinatorId: 'a1', origin: { sessionId: 's', entryId: 1 } }),
    listDelegations: () => [],
    registerAgent: () => { throw new Error('不应现注册身份') },
    publishConstraint: () => { throw new Error('接了 write 还直写') },
  } as never
}

function boundaryOf(write: (request: { readonly action: string }) => Promise<{ readonly ok: boolean; readonly reason?: string }>) {
  return createCollaborationBoundary({
    records: recordsOf(),
    session: 's',
    runId: 'r',
    model: () => undefined,
    tools: () => undefined,
    changed: () => {},
    now: () => 1,
    write: write as never,
  }).boundary
}

test('经帧的约束写失败要上抛（P0 回归）——消费方据以拒收，不当成已收下', async () => {
  const boundary = boundaryOf(async () => ({ ok: false, reason: '宿主已关闭准入' }))
  await expect(boundary.userInput!(7, true)).rejects.toThrow('宿主已关闭准入')
})

test('经帧的约束写成功兑现：publishConstraint 走帧而非直写', async () => {
  const actions: string[] = []
  const boundary = boundaryOf(async request => { actions.push(request.action); return { ok: true, value: {} } })
  await expect(boundary.userInput!(7, true)).resolves.toBeUndefined()
  expect(actions).toEqual(['publishConstraint'])
})
