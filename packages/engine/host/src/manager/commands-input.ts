/**
 * **输入账**（T1.7 SRP 拆分）——输入受理（事务性发件箱的落账）与 input.manage 各支
 * （账本迁移与立即消费/重试）的分治件。从 `commands.ts` 搬移（acceptInput 纯搬移；
 * input.manage 补齐契约 retry/consume 两支的 engine 路由——T1.1 契约闭环）；依赖同走
 * `ManagerContext`（与 `installCommands` 同形）。
 */
import type { ManagerContext } from './context.ts'
import type { ClientConn } from '../connections.ts'
import type { Command } from '@magic/contracts'
import { PENDING_INPUT_LIMIT, pendingViews } from '@magic/contracts'
import { bindSessionReferences } from '@magic/conversation'
import { readMemory } from '@magic/host'

export function installInputCommands(ctx: ManagerContext): {
  /**
   * **受理前移**（T1.1/T1.1b · 事务性发件箱）：deliver 前把输入落账。返回 `undefined`
   * ＝ 已拒（回执已发，容量），调用方直接返回。
   */
  readonly acceptInput: (conn: ClientConn, command: Extract<Command, { readonly type: 'input.submit' }>) => { readonly command: Command; readonly session: string } | undefined
  /** input.manage 各支（edit/withdraw/continue|consume/retry/list）——处理后返回 true。 */
  readonly handleInputManage: (conn: ClientConn, command: Extract<Command, { readonly type: 'input.manage' }>) => Promise<boolean>
} {
  const { now, store } = ctx

  function acceptInput(conn: ClientConn, command: Extract<Command, { readonly type: 'input.submit' }>): { readonly command: Command; readonly session: string } | undefined {
    const existing = conn.selectedSession
    const session = existing ?? crypto.randomUUID()
    const records = store.serviceFor(session)
    if (existing !== null && records.inputs.list().filter(one => one.state === 'pending').length >= PENDING_INPUT_LIMIT) {
      const ref = command.ref ?? crypto.randomUUID()
      records.inputs.reject({ ...command, ref }, '待办已满', now(), 'capacity')
      conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session, kind: 'input.settled', data: { ok: false, ref, reason: '待办已满', rejectedKind: 'capacity' } } })
      return undefined
    }
    if (existing === null) store.createSession(session, now())
    const ref = command.ref ?? crypto.randomUUID()
    records.inputs.accept({ ...command, ref }, now())
    return { command: { ...command, ref }, session }
  }

  async function handleInputManage(conn: ClientConn, command: Extract<Command, { readonly type: 'input.manage' }>): Promise<boolean> {
    const origin = conn.selectedSession
    const work = origin === null ? undefined : store.collaboration.collaborationForSession(origin)
    const member = command.member === undefined ? undefined : work === undefined ? undefined : store.collaboration.listMembers(work.collaborationId).find(one => one.agentId === command.member)
    const session = command.member === undefined ? origin : member?.sessionId
    if (session == null) { conn.link.send({ t: 'line', text: '当前输入目标不存在，未修改' }); return true }
    if (member?.purpose === 'consultation' && command.action !== 'list') { conn.link.send({ t: 'line', text: '咨询详情只供查看；相关纠正请补充给原工作' }); return true }
    const inputs = store.serviceFor(session).inputs
    let note: string | undefined
    if (command.action === 'edit') {
      try {
        const input = await bindSessionReferences(command.input, store)
        for (const ref of input.refs ?? []) {
          if (ref.kind === 'memory' && ref.scope.kind === 'session') throw new Error('旧事项引用已退出使用')
          if (ref.kind !== 'note') continue
          if (ref.session !== session) throw new Error('纠正对象与发送目标不一致')
          if (!(await readMemory(store, session, [], { path: ref.source })).notes?.page) throw new Error('所选笔记已不可读取；原稿保留')
        }
        note = inputs.edit(command.ref, command.revision, input) ? '已保存未消费输入' : '输入已消费或已改变，未修改'
      } catch (error) { note = `未修改输入：${String(error)}` }
    }
    if (command.action === 'withdraw') note = inputs.withdraw(command.ref, command.revision) ? '已撤回未消费输入' : '输入已消费或已改变，未撤回'
    // **立即消费**（consume，continue 为旧名同语义）与 **重试**（retry，failed/rejected→pending
    // 后重新送达——T1.1 契约的 engine 路由闭环）。两者的送达路径与 continue 相同。
    if (command.action === 'continue' || command.action === 'consume' || command.action === 'retry') {
      const row = inputs.get(command.ref)
      if (command.action === 'retry') {
        if (row === undefined || row.revision !== command.revision) note = '输入已消费或已改变，未重试'
        else if (row.state !== 'failed' && row.state !== 'rejected') note = '只有失败或被拒的输入才能重试——待办里的直接点「立即消费」'
        else if (!inputs.retry(command.ref, row.revision)) note = '输入已消费或已改变，未重试'
        else note = row.state === 'failed'
          ? (row.failedFrom === 'executing' ? '已重试——它可能已执行过一部分，重新送达' : '已重试，重新送达')
          : '已重新受理，重新送达'
      } else if (row?.state !== 'pending' || row.revision !== command.revision) {
        note = '输入已消费或已改变，未继续'
      }
      // 送达（retry 成功与 consume/continue 同路）：有活执行器直送，否则起一代。
      if (note === undefined) {
        const fresh = inputs.get(command.ref)
        if (fresh === undefined || fresh.state !== 'pending') note = '输入已消费或已改变，未继续'
        else {
          const executor = ctx.liveOf(session) ?? ctx.spawn({ session, explicit: true, cwd: member?.workspace[0] ?? conn.cwd, environment: conn.environment })
          if (executor === undefined) note = '当前执行者不可用，输入保留在待办'
          else {
            if (member === undefined) ctx.connections.bind(conn, executor)
            else ctx.collaborationInputs.set(fresh.ref, { conn, session: origin!, target: session, ref: fresh.ref })
            // retry 回待办后与 consume 同路送达（执行者按 pending 立即消费）。
            ctx.deliver(executor, { ...command, ref: fresh.ref, revision: fresh.revision, action: 'consume' } as Extract<Command, { readonly type: 'input.manage' }>)
          }
        }
      }
    }
    conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session, kind: 'input.pending', data: { inputs: pendingViews(inputs.list()), ...(note === undefined ? {} : { note }) } } })
    return true
  }

  return { acceptInput, handleInputManage }
}
