/**
 * 视图归约的**重建半边**（T3.4 SRP 拆分 · 阶段四）——`session.history` 的攒块与收尾归并。
 *
 * 自 `shell.ts` 的 `createShell` 搬出，行为不变。分寸说明：`onEvent` 是编排者——它把
 * 一条事件接到外壳的各子系统上（选择器、草稿、批次、协作、后台…触点遍及全壳），
 * **留在壳上**；这里搬的是它的**归约心脏**：历史攒块（`rebuildFor` / `rebuildEntries`）、
 * 收尾时的重建与用量接回、往输入历史里补「过去交过的那些」。
 *
 * `rebuildFor` 同时是「记录区正在重建吗」的那把闸（接回快照的 `draw` 等它）——
 * 故工厂把它露出来（`isRebuilding`），由外壳接进连接管理。
 */
import type { Command, Entry, KernelEvent } from '@magic/contracts'
import { patchStatus, rebuild, reduce, type ShellView } from './view.ts'

/**
 * **输入历史的一条**——**整份草稿**：正文 ＋ 它里面的引用（位置与身份）。
 * 翻回来的是**当时那一句**，那几处引用连同身份一起回来，不必重新选一遍。
 */
export type HistoryEntry = { readonly text: string; readonly refs: readonly import('./components/inline.ts').DraftRef[]; readonly inputRef?: string; readonly caret?: number; readonly cleared?: number }

/** 当前正文与目录预览共用保存历史的条目投影。本地输入已由引擎并入条目流（2026-11-24）。 */
export function historyEntries(data: Extract<KernelEvent, { kind: 'session.history' }>['data']): Entry[] {
  return [...data.entries]
}

/** 重建器要摸的外壳面——只给归约要动的那几格（同 picker 工厂的接线模式）。 */
export type HistoryHost = {
  readonly getView: () => ShellView
  readonly commit: (view: ShellView) => void
  readonly send: (command: Command) => void
  /** 外壳的输入历史这会儿是不是空的（空＝开机第一趟，要把「过去交过的」补回去）。 */
  readonly hasEmptyHistory: () => boolean
  /** 把「过去交过的那些」补进外壳的输入历史（按到达序追加）。 */
  readonly appendHistory: (inputs: readonly HistoryEntry[]) => void
  /** 记录区铺完那一下画暂存的接回快照（连接管理那一侧，lambda 递入解构造环）。 */
  readonly drawResumed: () => void
}

export function createHistoryAccumulator(host: HistoryHost): {
  readonly accumulate: (data: Extract<KernelEvent, { kind: 'session.history' }>['data']) => void
  readonly isRebuilding: () => boolean
} {
  /** 重建的攒块——按 `session.history` 的 `data.session` 分（不是当下那条的直接丢）。 */
  let rebuildFor: import('@magic/contracts').SessionId | null = null
  let rebuildEntries: Entry[] = []

  const accumulate = (data: Extract<KernelEvent, { kind: 'session.history' }>['data']): void => {
    const view = host.getView()
    if (view.sessionId !== null && data.session !== view.sessionId) return // 切走之后的尾巴——丢

    if (rebuildFor !== data.session) {
      rebuildFor = data.session
      rebuildEntries = []
    }

    rebuildEntries = [...rebuildEntries, ...historyEntries(data)]
    if (!data.done) return
    /**
     * 读取失败/降级时**不清屏**：已经收到的条目仍在，界面保留上一份内容并给一句
     * 可重试的说明。2026-11-21 的教训是「用着用着突然不能用了」——历史读失败
     * 不该等于历史消失。
     */
    if (data.error !== undefined && rebuildEntries.length === 0) {
      rebuildFor = null
      host.commit({ ...view, flash: data.error })
      return
    }

    rebuildEntries = [...rebuildEntries].sort((a,b)=>a.at-b.at||a.id-b.id)
    if (host.hasEmptyHistory()) {
      const past: { at: number; input: HistoryEntry }[] = []
      for (const entry of rebuildEntries) {
        if (entry.kind !== 'user' || !('text' in entry.content) || (entry.payload as { notice?: true } | undefined)?.notice === true) continue
        const payload = entry.payload as import('@magic/contracts').UserPayload | undefined
        const refs = payload?.local === true ? payload.inputRefs ?? [] : payload?.refs ?? []
        past.push({ at: entry.at, input: { text: entry.content.text, refs: refs.map(({ at, ...ref }) => ({ ...ref, start: at, end: at + ref.marker.length })) } })
      }
      const requests = new Set<string>()
      for (const event of data.compactions ?? []) if (!requests.has(event.data.requestId) && (event.data.accepted === true || ['pending', 'running', 'completed'].includes(event.data.state))) {
        requests.add(event.data.requestId)
        past.push({ at: event.at, input: { text: '/compact ' + (event.data.focus ?? ''), refs: [] } })
      }
      host.appendHistory(past.sort((a, b) => a.at - b.at).map(one => one.input))
    }
    let current = view
    for (const event of data.compactions ?? []) current = reduce(current, event)
    const unconfirmed = [...current.settled, ...current.rows].filter(row => row.kind === 'user' && row.inputState !== undefined && !current.pendingInputs.some(input => input.ref === row.inputRef && input.entry !== undefined))
    const rebuilt = rebuild(current, rebuildEntries, {
      ...(data.timing === undefined ? {} : { timing: data.timing }),
      ...(data.messages === undefined ? {} : { messages: data.messages }),
    })
    /**
     * **接回这条会话的用量读数**（`session.history.usage`，末块给）——状态行 ④ 放回离开那一刻
     * 那个数：`/resume` 与 `magic resume <id>` 换过去时那一格先按「不知道」省掉（见
     * `reduceSessionState` 与开机那一格），这里补上。
     *
     * 已经在报的数是更新的现场（这一趟跑出来的），**不盖**——拿历史里那份旧读数盖回去就是
     * 「用旧账压新账」。`0` 不算「已经报过」：那是开机／刚开一条新会话那一位（一个 token 都
     * 还没用），真实调用报回来的分子不会是这个数。
     */
    const live = current.status.usage !== null && current.status.usage !== 0
    const withUsage = live || data.usage === undefined ? rebuilt : patchStatus(rebuilt, {
      ...(data.usage.inputTokens === undefined ? {} : { usage: data.usage.inputTokens }),
      ...(data.usage.contextWindow === undefined ? {} : { window: data.usage.contextWindow }),
    })
    host.commit({
      ...withUsage,
      rows: [...withUsage.rows, ...unconfirmed],
      ...(data.truncated === true ? { flash: '记录过长，已显示部分内容' } : {}),
    })
    rebuildFor = null
    rebuildEntries = []

    // 计划不再搭历史帧（2026-11-24）——重建收尾后单独取一次当前计划：
    // 答复走 `plan.changed`（全文、零裁剪），清单由此上屏。
    host.send({ type: 'plan.read', requestId: crypto.randomUUID(), session: data.session })

    host.drawResumed()
  }

  return { accumulate, isRebuilding: () => rebuildFor !== null }
}
