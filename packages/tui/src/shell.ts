/**
 * 外壳 · 会话壳（缺陷轮 II 重画）——**只认控制面**。
 *
 * 一件：把注入的 `ControlTransport`（外壳侧一端，装配注入）接成「事件 → 视图 ＋ 键 → 命令」
 * 的一条线。**键位语义全在这层**（`key()` 收一个按键、改视图、必要时发命令）——
 * 组件只把 Ink 的键喂进来、把模型画出来。好处：接管 / 草稿 / 选择器这些规矩**不起终端就能测**。
 *
 * 四条纪律（原型 · 交互逻辑）：
 * ① **先接订阅、后放开输入**（构造即订阅）；
 * ② **slash 两种走法**——纯输出型（`/help`）：输出进记录区、**命令本身不回显**；
 *    交互配置型（`/session` · `/model`）：**记录区什么都不进**，只在左下开选择器，
 *    选定后留**一行回执**，`esc` 取消＝**不留痕迹**；
 * ③ **接管**（裁决挂着）——看得见（占位换掉）· 草稿不丢（收起来、答完归还、**不自动发送**）·
 *    **不静默吞键**（只认 y/a/n ＋ 全局 ctrl+c，其余忽略但当场说一句；粘贴一律拒）；
 * ④ **重建**（缺陷 D1）——`session.history` 分块收、收齐了按块重建记录区（**收拢**）。
 */

import type { Command, ControlTransport, Entry, KernelEvent, SessionId } from '@magic/contracts'
import type { ShellView } from './view.ts'
import {
  appendEcho,
  appendOutput,
  appendReceipt,
  closePicker,
  createView,
  movePicker,
  openPicker,
  picked,
  rebuild,
  reduce,
} from './view.ts'

/** 外壳认得的按键——组件把 Ink 的 `(input, key)` 收窄成这个（多出来的都算 `other`）。 */
export type ShellKey =
  | { readonly kind: 'char'; readonly char: string }
  | { readonly kind: 'enter' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'up' }
  | { readonly kind: 'down' }
  | { readonly kind: 'ctrl+c' }
  | { readonly kind: 'ctrl+o' }
  | { readonly kind: 'paste'; readonly text: string }
  | { readonly kind: 'other'; readonly label: string }

/** 按键的结果——`exit` 由组件去真退出（外壳不碰终端）。 */
export type ShellEffect = { readonly exit: boolean }

const NONE: ShellEffect = { exit: false }
const EXIT: ShellEffect = { exit: true }

export type Shell = {
  /** 当前视图（引用稳定——只在事件 / 按键之后才换对象）。 */
  getView(): ShellView
  /** 订阅视图变化（React 的 `useSyncExternalStore` 直接吃它）。 */
  subscribe(listener: () => void): () => void
  /** 一个按键。 */
  key(key: ShellKey): ShellEffect
  /** 主动读一次历史（开局接续 / 恢复之后调——重建记录区）。 */
  readHistory(session?: SessionId): void
  /** 收摊——退订传输、清订阅者。 */
  dispose(): void
}

/** `/help` 的正文（纯输出型）。 */
const HELP_TITLE = '可用命令'
const HELP_LINES: readonly string[] = [
  '/model　　换模型（列出可用条目，选定即切）',
  '/session　会话：列表 · 切换 · 新建 · 改名',
  '/help　　　这张表',
]

/** 一次「等内核回话再开选择器」的意图——`/session` 与 `/model` 各一种。 */
type PendingPicker = 'session' | 'model'

/** 建会话壳——**构造即订阅**（先接订阅、后放开输入）。 */
export function createShell(transport: ControlTransport): Shell {
  const watchers = new Set<() => void>()
  let view = createView()
  let disposed = false

  /** 输入历史（`↑` 取上一条）。 */
  const history: string[] = []
  let historyAt = -1

  /** 重建的攒块——按 `session.history` 的 `data.session` 分（不是当下那条的直接丢）。 */
  let rebuildFor: SessionId | null = null
  let rebuildEntries: Entry[] = []

  /** 等回话的选择器意图 ＋ 见过的模型条目（`/model` 的列表取材）。 */
  let waiting: PendingPicker | null = null
  const providers = new Map<string, string | undefined>()

  const notify = (): void => {
    for (const watcher of [...watchers]) watcher()
  }

  const commit = (next: ShellView): void => {
    view = next
    notify()
  }

  const send = (command: Command): void => {
    if (disposed) return
    transport.send(command)
  }

  // —— 事件 ——

  const onEvent = (event: KernelEvent): void => {
    if (disposed) return

    if (event.kind === 'session.history') {
      accumulate(event.data)
      return
    }

    // 见过的条目（`/model` 的列表取材——条目表不在事件里，见回报「与原型不符」）
    if (event.kind === 'model.call.start' && event.data.provider !== undefined) {
      providers.set(event.data.provider, event.data.model)
    }
    if (event.kind === 'model.switched' && event.data.provider !== undefined) {
      providers.set(event.data.provider, event.data.model)
    }

    const before = view.sessionId
    commit(reduce(view, event))

    if (event.kind === 'session.state') {
      // 换了会话 ⇒ 记录区已清空（`reduce` 里做）＋ 主动读一次历史（D1：换一条＝换一屏）
      if (before !== null && before !== event.data.active) readHistory(event.data.active)
      if (waiting === 'session') {
        waiting = null
        openSessionPicker()
      }
    }

    if (event.kind === 'model.switched' && waiting === 'model') {
      waiting = null
      openModelPicker(event.data.ok ? '' : (event.data.reason ?? ''))
    }
  }

  const accumulate = (data: Extract<KernelEvent, { kind: 'session.history' }>['data']): void => {
    if (view.sessionId !== null && data.session !== view.sessionId) return // 切走之后的尾巴——丢

    if (rebuildFor !== data.session) {
      rebuildFor = data.session
      rebuildEntries = []
    }

    rebuildEntries = [...rebuildEntries, ...data.entries]
    if (!data.done) return

    commit(rebuild(view, rebuildEntries))
    rebuildFor = null
    rebuildEntries = []
  }

  const unsubscribeTransport = transport.subscribe(onEvent)

  // —— 选择器 ——

  /** `/session`——目录已到手，开它。 */
  const openSessionPicker = (): void => {
    const catalog = view.catalog

    commit(
      openPicker(view, {
        source: 'session',
        selected: Math.max(0, catalog.findIndex((row) => row.id === view.sessionId)),
        rows: catalog.map((row) => ({
          label: row.title ?? '（无标题）',
          meta: row.id === view.sessionId ? '正在用' : '',
          current: row.id === view.sessionId,
          value: row.id,
        })),
        ...(catalog.length === 0 ? { hint: '还没有落过账的会话——交代一句就开张' } : {}),
      }),
    )
  }

  /**
   * `/model`——**条目表不在事件里**（契约没有读侧），故列表只有「见过的 ＋ 当前那条」，
   * 而内核回话里的缘由（它本就列出已注册的名字）作列表下方的说明 ✓ 不解析、只照贴。
   */
  const openModelPicker = (reason: string): void => {
    const current = view.status.model
    const rows = [...providers.entries()].map(([id, model]) => ({
      label: id,
      meta: model ?? '',
      current: model !== undefined && model === current,
      value: id,
    }))

    commit(
      openPicker(view, {
        source: 'model',
        selected: Math.max(0, rows.findIndex((row) => row.current)),
        rows,
        hint: reason === '' ? '也可直接打 `/model <条目>`' : reason,
      }),
    )
  }

  // —— 键 ——

  const exitOrInterrupt = (): ShellEffect => {
    const busy = view.status.state === 'working' || view.status.state === 'retrying'

    if (busy || view.dock.kind === 'decision') {
      send({ type: 'turn.interrupt' })
      return NONE
    }

    return EXIT
  }

  const key = (input: ShellKey): ShellEffect => {
    if (disposed) return NONE

    switch (input.kind) {
      case 'ctrl+c':
        return exitOrInterrupt()

      case 'ctrl+o':
        commit({ ...view, expanded: !view.expanded })
        return NONE

      case 'paste':
        if (view.dock.kind === 'decision') {
          commit(said(view, '先答复——此刻粘不了（这一轮在等你）。草稿在，答完接着打。'))
          return NONE
        }
        commit({ ...view, draft: view.draft + input.text })
        return NONE

      case 'escape':
        if (view.dock.kind === 'picker') return (commit(closePicker(view)), NONE)
        if (view.dock.kind === 'decision') return NONE // 接管期间 `esc` **无动作**
        commit(view.draft === '' ? { ...view, expanded: false } : { ...view, draft: '' })
        return NONE

      case 'up':
      case 'down': {
        const delta = input.kind === 'up' ? -1 : 1
        if (view.dock.kind === 'picker') {
          commit(movePicker(view, delta))
          return NONE
        }
        recallHistory(delta)
        return NONE
      }

      case 'enter':
        return submit()

      case 'backspace':
        if (view.dock.kind === 'decision') return refuse('退格')
        commit({ ...view, draft: view.draft.slice(0, -1) })
        return NONE

      case 'char':
        if (view.dock.kind === 'decision') return answer(input.char)
        if (view.dock.kind === 'picker') return NONE
        commit({ ...view, draft: view.draft + input.char })
        return NONE

      case 'other':
        return view.dock.kind === 'decision' ? refuse(input.label) : NONE
    }
  }

  /** 接管期间的作答键——只认 `y` / `a` / `n`（必闸类没有 `a`）。 */
  const answer = (char: string): ShellEffect => {
    const pending = view.dock.kind === 'decision' ? view.dock.pending : undefined
    if (pending === undefined) return NONE

    if (char === 'y') {
      send({ type: 'decision.answer', id: pending.id, decision: 'approve' })
      return NONE
    }
    if (char === 'n') {
      send({ type: 'decision.answer', id: pending.id, decision: 'reject' })
      return NONE
    }
    if (char === 'a') {
      if (pending.weight === 'heavy') {
        commit(said(view, '必闸类不可「总是允许」——按 y 批准这一次，或 n 拒绝。'))
        return NONE
      }
      send({ type: 'decision.answer', id: pending.id, decision: 'approve', remember: true })
      return NONE
    }

    return refuse(char)
  }

  /** 接管期间的非答复键——忽略，但**当场说一句**（「不静默吞键」）。 */
  const refuse = (label: string): ShellEffect => {
    const what = label === '' ? '这个键' : `「${label}」`
    commit(said(view, `先答复——${what}此刻不管用（这一轮在等你）。草稿在，答完接着打。`))
    return NONE
  }

  /** 回车——接管 / 选择器 / 输入三种归处。 */
  const submit = (): ShellEffect => {
    if (view.dock.kind === 'decision') return refuse('回车')

    if (view.dock.kind === 'picker') {
      const row = picked(view)
      if (row === undefined) return NONE

      if (view.dock.picker.source === 'session') {
        send({ type: 'session.open', session: row.value })
        // **选定后留一行回执**（原型 · 场景 10）；切过去之后重建由 `session.state` 触发
        commit(appendReceipt(closePicker(view), `已切到 ${row.label}`))
        return NONE
      }

      // 换模型：回执由内核的 `model.switched` 事件给（那才是真结果，不由外壳先报）
      send({ type: 'model.switch', provider: row.value })
      commit(closePicker(view))
      return NONE
    }

    const text = view.draft.trim()
    if (text === '') return NONE

    if (text.startsWith('/')) {
      commit(runSlash(view, text))
      return NONE
    }

    if (history[history.length - 1] !== text) history.push(text)
    historyAt = -1
    commit(appendEcho({ ...view, draft: '' }, text))
    send({ type: 'input.submit', text })

    return NONE
  }

  /** slash 分发——**两种走法在这一处落定**。 */
  const runSlash = (from: ShellView, text: string): ShellView => {
    const [word, ...rest] = text.split(/\s+/)
    const arg = rest.join(' ')
    const cleared: ShellView = { ...from, draft: '' }

    // —— 纯输出型：输出进记录区，**命令本身不回显** ——
    if (word === '/help') return appendOutput(cleared, HELP_TITLE, HELP_LINES)

    // —— 交互配置型：记录区什么都不进 ——
    if (word === '/session') {
      if (arg === '' || arg === 'list') {
        waiting = 'session'
        send({ type: 'session.list' })
        return cleared
      }
      if (arg === 'new') {
        send({ type: 'session.new' })
        return appendReceipt(cleared, '已新建一条会话（首条消息按下回车才落库）')
      }
      if (arg === 'title' || arg.startsWith('title ')) {
        const title = arg.slice('title'.length).trim()
        if (title === '' || from.sessionId === null) {
          return appendReceipt(cleared, '要改成什么？`/session title <文本>`')
        }
        send({ type: 'session.rename', session: from.sessionId, title })
        return cleared
      }

      return appendReceipt(cleared, '认得的用法：/session · /session new · /session title <文本>')
    }

    if (word === '/model') {
      if (arg !== '') {
        send({ type: 'model.switch', provider: arg })
        return cleared
      }
      // 不带参数 ⇒ 问内核「有哪些条目」（它的缘由本就列出已注册的名字）
      waiting = 'model'
      send({ type: 'model.switch' })
      return cleared
    }

    // 不认得的 slash——**如实说一句**（别静默丢，也别当交代发给模型）
    return appendReceipt(cleared, `不认得的命令「${word}」——试试 /help`)
  }

  const recallHistory = (delta: number): void => {
    if (history.length === 0) return

    const next = historyAt === -1 ? history.length - 1 : historyAt + delta
    if (next < 0 || next >= history.length) return

    historyAt = next
    commit({ ...view, draft: history[next] ?? '' })
  }

  const said = (from: ShellView, message: string): ShellView => ({ ...from, flash: message })

  const readHistory = (session?: SessionId): void => {
    send(session === undefined ? { type: 'history.read' } : { type: 'history.read', session })
  }

  return {
    getView: () => view,

    subscribe: (listener) => {
      watchers.add(listener)

      return () => {
        watchers.delete(listener)
      }
    },

    key,
    readHistory,

    dispose: () => {
      disposed = true
      unsubscribeTransport()
      watchers.clear()
    },
  }
}
