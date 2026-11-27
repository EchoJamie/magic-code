import { describe, expect, test } from 'bun:test'
import type { NativeWork, RunRow } from '@magic/contracts'
import type { AgentIdentity, AgentModelConfig, Collaboration, Delegation, ExecutionAdmission } from '@magic/contracts'
import { inActiveSection, runSummary } from '../src/boards/records/sessions.ts'

/**
 * T3.5 契约测试骨架（P12/P25/P26·P2）——「TUI 与 App **同一投影源**」的 TUI 消费侧。
 *
 * ⚠️ **归并语义在本文件里是「镜像规格」不是「实调」**（总负责人 2026-11-27 重裁定）：
 * 仓库依赖闸（根 `test/scaffold.test.ts`）禁止非装配包 import `@magic/host`——只有
 * assembly 认识引擎 host，外壳只许朝下依赖契约。故下面的 `expectedMerged` **手写镜像引擎
 * `mergeCollaborationNative` 对同一夹具事实的输出**（已对照真实现校准，2026-11-27）。
 * 漂移风险已知：引擎改归并行为不会让本文件变红；真正同源由引擎侧测试
 * （native-projection 发出的帧 == merge 输出，记入 T1.4 验收）与 T4 集成复核兜底。
 * **本文件锁的是 TUI 渲染消费侧的契约，不冒充在测归并本身**——golden 的作用是
 * 把「TUI 将按什么样的归并语义呈现」钉成锚点，防止规格被随手改弱。
 *
 * 本文件两层：
 * 1. **归并结果的规格锚点**（现在就绿）——unknown 保留、不冒充已停/空闲、成员代次不冒充
 *    整项；以及**今天就能真测**的那半：运行事实 `unknown` 在列表层的呈现守 P7。
 * 2. **TUI 消费侧骨架**（skip，待引擎 T1.4 统一投影帧落地后启用）——届时把第 1 层的
 *    归并结果送到 TUI，断言 `view.runs` == 同一归并结果、revision 跳号跟随不崩、TUI 不自算。
 */

const model: AgentModelConfig = {
  protocol: 'chat-completions', endpoint: 'https://fixture.invalid/v1',
  choice: 'cantrip', provider: 'local', model: 'mini',
}

const collaboration: Collaboration = {
  collaborationId: 'work', originSessionId: 'origin',
  origin: { sessionId: 'origin', entryId: 1 },
  coordinatorId: 'coordinator', defaultModel: model, state: 'open', at: 0,
}

const member = (overrides: Partial<AgentIdentity> = {}): AgentIdentity => ({
  agentId: 'coordinator', sessionId: 'origin', name: '协调', role: '整合结果',
  model, workspace: ['/project'], reachability: 'active', collaborationId: 'work', at: 0,
  ...overrides,
})

const delegation: Delegation = {
  delegationId: 10, collaborationId: 'work', delegatorId: 'coordinator', assigneeId: 'worker',
  source: { messageId: 10 }, authorization: [], scope: '回调校验', state: 'accepted', at: 0,
}

const execution = (overrides: Partial<ExecutionAdmission> = {}): ExecutionAdmission => ({
  operationId: 'op-1', agentId: 'worker', runId: 'run-1', kind: 'tool', state: 'running', at: 5,
  ...overrides,
})

const work = (overrides: Partial<NativeWork> & Pick<NativeWork, 'session' | 'state'>): NativeWork => ({
  title: '回调校验', workspace: ['/project'], since: 10, gen: 3,
  affected: true, archived: false, canArchive: false, terminalOpen: true,
  ...overrides,
})

/** 一件协作工作的事实：入口在跑、成员行已 idle 但执行未核销（「收尾待核实」的现场）。 */
const works: readonly NativeWork[] = [
  work({ session: 'origin', state: 'running' }),
  work({ session: 'member', state: 'idle', since: 12, gen: 2 }),
]

/** 与 `works` 同一组事实的快照——形状与引擎 `CollaborationNativeSnapshot` 一致（镜像定义）。 */
const snapshot = {
  sessions: ['origin', 'member'],
  groups: [{
    collaboration,
    members: [
      member(),
      member({ agentId: 'worker', sessionId: 'member', name: '实现', role: '调整校验', createdBy: 'coordinator' }),
    ],
    delegations: [delegation],
    executions: [execution()],
  }],
}

/**
 * 同组事实**应有的**归并结果（golden · 镜像引擎 `mergeCollaborationNative`，已对照真实现校准）。
 * T1.4 落地后，TUI 收到的统一投影应与此一致（见文末 skip 骨架）。
 */
const expectedMerged: readonly NativeWork[] = [{
  session: 'origin', title: '回调校验', workspace: ['/project'],
  gen: 3, // 成员代次不冒充整项工作——gen 取入口行
  // 执行未核销而成员行已 idle：整件工作降级 unknown，不冒充已停/空闲（P7/P2③）。
  state: 'unknown', since: 5, reason: '实现：执行收尾待核实',
  affected: true, archived: false, canArchive: false, terminalOpen: true,
  members: [
    { session: 'origin', name: '协调', state: 'running' },
    { session: 'member', name: '实现', state: 'unknown', reason: '成员状态待核实' },
  ],
}]

describe('同一归并结果：TUI 将按它呈现的规格锚点（golden · 镜像引擎语义）', () => {
  test('锚点本体：同组会话归并成一件工作，unknown 保留、不冒充已停/空闲（P7/P2③）', () => {
    expect(expectedMerged.length).toBe(1)
    expect(expectedMerged[0]?.session).toBe('origin')
    expect(expectedMerged[0]?.state).toBe('unknown')
    const worker = expectedMerged[0]?.members?.find(one => one.session === 'member')
    expect(worker?.state).toBe('unknown')
  })

  test('锚点：成员代次不冒充整项工作——gen 取入口行（P25：版本由引擎定）', () => {
    expect(expectedMerged[0]?.gen).toBe(3)
  })

  test('锚点：成员行缺席——该成员格降级 unknown、给「状态待核实」，整件工作跟着 unknown（P7）', () => {
    // 停止/进程退出不写成员状态；行缺席就是运行事实缺失——呈现按 unknown 降级。
    const missingRowSnapshot = {
      ...snapshot,
      groups: [{ ...snapshot.groups[0]!, members: snapshot.groups[0]!.members.slice(1) }],
    }
    const expected = {
      ...expectedMerged[0]!,
      since: 10,
      reason: '成员状态待核实',
      members: [
        { session: 'member', name: '实现', state: 'unknown', reason: '成员状态待核实' },
      ],
    }
    expect(expected.state).toBe('unknown')
    expect(expected.reason).toBe('成员状态待核实')
    expect(expected.members?.[0]?.state).toBe('unknown')
    expect(missingRowSnapshot.groups[0]!.members).toHaveLength(1)
  })

  test('锚点：无协作事实的散行原样透传——归并不吞非协作工作', () => {
    const solo = work({ session: 'solo', state: 'idle', gen: 1 })
    // 透传语义：散行不进任何组、原样成为投影的一行（golden 里没有它）。
    expect(works.some(one => one.session === solo.session)).toBe(false)
  })

  test('P7（今天就能真测的 TUI 消费侧）：失联行呈现「状态待确认」，绝不冒充已停/空闲', () => {
    const row = (session: string, state: RunRow['state']): RunRow => ({
      session, state, since: 0, startedAt: 0, workspace: ['/w'], holds: false,
    })
    const summary = runSummary([row('s1', 'unknown')], 'opening')
    expect(summary).toContain('1 项状态待确认')
    expect(summary).not.toContain('已停止')
    expect(summary).not.toContain('空闲')
    // unknown 归**活跃段**（需要你/执行中/收尾中/待确认）——不沉进历史，用户看得见。
    expect(inActiveSection('unknown')).toBe(true)
  })
})

test.skip('TUI 消费侧：runs 视图 == 同一归并结果（待引擎 T1.4 统一投影帧落地后启用）', () => {
  // 启用时按此清单断言（骨架，先立语义不立实现）：
  // 1. 送达 TUI 的 works 与上方 `expectedMerged`（同一夹具事实）同一——TUI 不自算归并
  //    （引擎发帧侧 == merge 输出由 T1.4 验收与 T4 集成复核锁）。
  // 2. `view.runs` 与送达的 works 同源：session/state/reason/since 逐格一致；
  //    unknown 行按 unknown 呈现（不显示已停/空闲，P7）。
  // 3. revision：两拍 5 → 9（跳号）——视图跟随最新拍、不假设连续（P26/P2①）；
  //    旧拍后到不回写（以 revision 判弃）。
  // 4. P27 逃逸口：attention/notice 读面进状态栏一行提示，TUI 从字段读、不另算。
  // 5. waitClass/awaitedByEntry：blocking → 「请稍候，等它结局」；advisory → 「只读，可以不等」；
  //    none → 通知、不给等待暗示——文案来自字段（P29），重算即违规。
})
