/**
 * 连接管理（T3.4 SRP 拆分 · 阶段二）——**重连、断开、接回快照的收与画**。
 *
 * 自 `shell.ts` 的 `createShell` 搬出。搬移纪律：行为不变——控制流、时序、文案逐字保留；
 * 原先闭包直摸的状态（`connected` / `reopening` / `view` / `exitWait`…）改经 `ConnectionHost`
 * 的取存器进出，取存器由外壳接线的写法与既有 picker（`createSessionPicker` 等）同一模式。
 *
 * 这一层管三件：
 * - **重连**（`reconnect`）——`options.reopen` 那一路：守 `reopening` 闸、成了之后刷新运行
 *   事实与历史、重发在途压缩的查询；
 * - **断开**（`disconnect`）——把「暂时无法确认」如实铺开：在途压缩降级 unknown、
 *   「提交中」的输入改标未确认、接回快照弃画、停止中如实带一句；
 * - **接回快照**（`hold` / `draw` / `finishCurrent`）——快照先收着，等记录区铺完再画
 *   （上界 `RESUME_SETTLE_MS`，不死等一个可能不来的重建）。
 */
import type { Command, RunSnapshot } from '@magic/contracts'
import {
  applyResume,
  appendReceipt,
  finishExecution,
  mergeLiveRows,
  patchStatus,
  withRunFacts,
  HINT_IDLE,
  HINT_LOST,
  type LogRow,
  type ShellView,
} from './view.ts'
import type { ShellEffect, ShellOptions } from './shell.ts'

const NONE: ShellEffect = { exit: false }

/**
 * 外壳递进来的取存面——**只给连接管理要摸的那几格**，不递整个壳。
 * 迟定义的依赖（`readHistory` / `settleDraft` / `exitWait`）由外壳用 lambda 包住递入，
 * 构造时不求值（同「事件只在订阅后到达」的既有前提）。
 */
export type ConnectionHost = {
  readonly isDisposed: () => boolean
  readonly isConnected: () => boolean
  readonly setConnected: (connected: boolean) => void
  readonly isReopening: () => boolean
  readonly setReopening: (reopening: boolean) => void
  readonly getView: () => ShellView
  readonly setView: (view: ShellView) => void
  readonly commit: (view: ShellView) => void
  readonly send: (command: Command) => void
  readonly readHistory: () => void
  readonly memoryReconnected: () => void
  readonly memoryDisconnected: () => void
  readonly clearSudoPassword: () => void
  readonly lastSubmitRef: () => string | null
  readonly settleDraft: (ref: string | undefined, keepDraft: boolean) => void
  readonly isRebuilding: () => boolean
  /** 读取并清掉「有停止在等退出」的意图——返回清掉之前有没有在等。 */
  readonly takeExitWait: () => boolean
  readonly options: ShellOptions
}

export function createConnectionControl(host: ConnectionHost): {
  readonly reconnect: () => ShellEffect
  readonly disconnect: (why?: string) => void
  readonly hold: (snapshot: RunSnapshot) => void
  readonly draw: () => void
  readonly finishCurrent: () => void
} {
  // —— 接回快照的收与画（原样搬入）——

  let pendingResume: RunSnapshot | null = null
  /** 那一份暂存的快照最多等多久（毫秒）——见 `draw`。 */
  const RESUME_SETTLE_MS = 300
  let resumeTimer: ReturnType<typeof setTimeout> | undefined

  const clearResume = (): void => {
    pendingResume = null
    if (resumeTimer !== undefined) clearTimeout(resumeTimer)
    resumeTimer = undefined
  }

  const draw = (): void => {
    if (resumeTimer !== undefined) {
      clearTimeout(resumeTimer)
      resumeTimer = undefined
    }
    if (pendingResume === null) return
    if (host.isRebuilding()) return // 记录区正在重建——等它铺完（`accumulate` 那一跳）
    const snapshot = pendingResume
    pendingResume = null
    const view = host.getView()
    const held = view
    const base = view.rows.length > 0 ? { ...view, rows: [] } : view
    const resumed = view.rows.length > 0
      ? mergeLiveRows(applyResume(base, snapshot), view.rows)
      : applyResume(view, snapshot)
    host.commit({ ...resumed, dock: held.dock, draft: held.draft, refs: held.refs, caret: held.caret, stashed: held.stashed, status: resumed.status })
  }

  /**
   * 收下一份快照，**等历史铺完再画**（见 `pendingResume` 的注）。
   *
   * 「等」有一个**上界**（`RESUME_SETTLE_MS`）：一旦这一趟并没有换会话（比如就那么
   * 重绑回原来那条），`session.history` 那一趟根本不会来——那时死等就是**把事实扣在手里**。
   * 到点照画：画的是**此刻的事实**，不是「等一个可能不来的东西」。
   */
  const hold = (snapshot: RunSnapshot): void => {
    pendingResume = snapshot
    if (resumeTimer !== undefined) clearTimeout(resumeTimer)
    resumeTimer = setTimeout(draw, RESUME_SETTLE_MS)
    resumeTimer.unref?.()
  }

  const finishCurrent = (): void => {
    clearResume()
    host.commit(finishExecution(host.getView()))
  }

  const reconnect = (): ShellEffect => {
    if (host.isReopening() || host.options.reopen === undefined) return NONE
    host.setReopening(true)
    host.commit(host.getView())
    void host.options.reopen().then(() => {
      if (host.isDisposed()) return
      host.setConnected(true)
      const view = host.getView()
      host.commit(appendReceipt(withRunFacts(patchStatus({ ...view, flash: null }, { state: 'idle', amount: null, hint: HINT_IDLE }), host.options.runs?.current() ?? view.runs), 'Magic Code 已连接，正在刷新当前会话。草稿未发送。'))
      host.readHistory()
      host.memoryReconnected()
      for (const one of view.compactions) if (['pending', 'running', 'unknown'].includes(one.state.state)) host.send({ type: 'compact.query', session: one.session, requestId: one.state.requestId })
    }, error => {
      if (!host.isDisposed()) host.commit(appendReceipt(host.getView(), `重新连接失败：${String(error)}`))
    }).finally(() => { host.setReopening(false); if (!host.isDisposed()) host.commit(host.getView()) })
    return NONE
  }

  const disconnect = (why?: string): void => {
    if (host.isDisposed() || !host.isConnected()) return
    host.setConnected(false)
    host.memoryDisconnected()
    let view = host.getView()
    view = { ...view, compactions: view.compactions.map(one => ['pending', 'running'].includes(one.state.state) ? { ...one, state: { ...one.state, state: 'unknown' } } : one) }
    view = { ...view, background: { commands: view.background?.commands ?? [], waiting: [], unknown: true }, sudo: null }
    host.clearSudoPassword()
    const unconfirmed = new Set([...view.settled, ...view.rows].filter(row => row.kind === 'user' && row.inputState === '提交中').map(row => row.kind === 'user' ? row.inputRef : undefined))
    const submittedRef = host.lastSubmitRef()
    if (submittedRef !== null && unconfirmed.has(submittedRef)) host.settleDraft(submittedRef, true)
    // **排队条里未受理的整组回输入框**（一期）：执行者不在了，没被 engine 收下的话不能丢。
    // 已受理的留在队列条——原稿在账上，恢复后继续。
    view = host.getView()
    const unacked = view.queued.filter(one => one.ack !== true)
    if (unacked.length > 0) {
      const text = unacked.map(one => one.text).join('\n\n')
      const offset = view.draft.length === 0 ? 0 : view.draft.length + 2
      const restoredRefs = unacked.flatMap(one => (one.refs ?? []).map(ref => ({ ...ref, start: ref.start + offset, end: ref.end + offset })))
      view = {
        ...view,
        queued: view.queued.filter(one => one.ack === true),
        draft: view.draft === '' ? text : `${view.draft}\n\n${text}`,
        caret: view.draft === '' ? text.length : view.caret,
        refs: [...view.refs, ...restoredRefs],
      }
    }
    const mark = (row: LogRow) => row.kind === 'user' && unconfirmed.has(row.inputRef) ? { ...row, inputState: '未确认接收（连接已断开）' } : row
    clearResume()
    const waiting = host.takeExitWait()
    host.setView(view)
    host.commit(patchStatus(appendReceipt({ ...view, settled: view.settled.map(mark), rows: view.rows.map(mark) }, `连接已断开${why ? `（${why}）` : ''}，暂时无法确认任务状态。${waiting ? '停止尚未确认。' : ''}`), { state: 'lost', amount: null, hint: HINT_LOST }))
  }

  return { reconnect, disconnect, hold, draw, finishCurrent }
}
