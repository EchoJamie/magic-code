/**
 * 外壳 · 会话壳（U09）——**只认控制面**。
 *
 * 一件：把注入的 `ControlTransport`（**外壳侧一端，装配注入——本层不构造**）接成
 * 「事件 → 视图 ＋ 视图 → 命令」的一条线。命令目录（技术方案 · 接入 · 消息目录）：
 * `input.submit` · `decision.answer` · `turn.interrupt`；事件＝事件流 kind 族（订阅收）。
 *
 * 三条纪律：
 * ① **先接订阅、后放开输入**——构造即订阅；未订阅时不发命令（`disposed` 后一律丢）。
 * ② **配对键＝请求事件 id**——答复原样带回 `tool.decision.request` 的 `id`
 *    （不是 payload 里的 `call`——两个 id 空间别混）。
 * ③ **呈现与介入**——视图归约在 `view.ts`；本层只管接线与本地回显。
 */

import type {
  Command,
  ControlTransport,
  Decision,
  KernelEvent,
  ModelSwitchRequest,
} from '@magic/contracts'
import type { ShellView } from './view.ts'
import { appendEcho, appendNoticeText, appendSessionList, createView, reduce } from './view.ts'

/** 换模型那条斜杠命令（U17）。 */
const MODEL_COMMAND = '/model'

/**
 * 会话那条斜杠命令（U16）——固定命令**只此两条**（交互词汇：自然语言优先、固定命令精简）。
 *
 * 四形，一望可记：
 * - `/session`——列出会话（带序号，当前那条有标记）
 * - `/session new`——新建一条
 * - `/session <序号>`——切到第几条（序号就是列表里那个数）
 * - `/session title <文本>`——给当前会话改个名字
 */
const SESSION_COMMAND = '/session'

/** 认出会话命令——**同样只认第一个词正好是 `/session`**（理由见 `parseModelSwitch`）。 */
function parseSession(text: string): { readonly rest: string } | undefined {
  if (text === SESSION_COMMAND) return { rest: '' }
  if (!text.startsWith(`${SESSION_COMMAND} `)) return undefined

  return { rest: text.slice(SESSION_COMMAND.length + 1).trim() }
}

/**
 * 认出换模型的斜杠命令——不认得就交回普通交代。
 *
 * **只认第一个词正好是 `/model`**：`/usr/bin 里有什么` 这类以斜杠开头的**人话**照旧发给模型
 * （用户嘴里说出一个路径是常事，别把他的话吃掉）。同理不做「疑似命令」的模糊匹配——
 * 猜错的代价是这条消息到不了模型。
 *
 * 参数按位取：`/model <供应商> [模型]`。**一个都不给也照发**——内核会回一句
 * 「不知道要换成什么」并列出已注册的条目（U17 的注册表就是这么报的），
 * 于是 `/model` 顺带成了「有哪些可选」的查询。
 */
function parseModelSwitch(text: string): ModelSwitchRequest | undefined {
  if (text !== MODEL_COMMAND && !text.startsWith(`${MODEL_COMMAND} `)) return undefined

  const [, provider, model] = text.split(/\s+/)

  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

export type Shell = {
  /** 当前视图（引用稳定——只在事件 / 本地回显后才换对象）。 */
  getView(): ShellView
  /** 订阅视图变化（供渲染层用——React 的 `useSyncExternalStore` 直接吃它）。 */
  subscribe(listener: () => void): () => void
  /** 提交用户输入（本地回显 ＋ `input.submit`）；空白丢弃。 */
  submit(text: string): void
  /**
   * 答复待裁决的询问（`decision.answer`）；无待裁决时忽略。
   *
   * 第二参 ＝**「总是允许」**（批准 ＋ 记住）：给了就把它带上，由控制域原样转手给权限域
   * （本层不解释它的含义）。
   */
  answer(decision: Decision, opts?: { remember?: boolean }): void
  /** 中断当前轮（`turn.interrupt`）。 */
  interrupt(): void
  /**
   * 安静地问一次会话目录（`session.list`）——启动时用：只为把当前会话与目录拿到手里
   * （状态行要显示当前会话），**不往对话流里塞目录块**（那是 `/session` 的事）。
   */
  refreshSessions(): void
  /** 收摊——退订传输、清订阅者（此后的命令一律丢弃）。 */
  dispose(): void
}

/** 建会话壳——**构造即订阅**（先接订阅、后放开输入）。 */
export function createShell(transport: ControlTransport): Shell {
  const watchers = new Set<() => void>()
  let view = createView()
  let disposed = false
  /** 问过目录、答复还没到——到了把目录块拼进对话流（`/session` 要看得见的那种问法）。 */
  let listing = false

  const notify = (): void => {
    for (const watcher of [...watchers]) watcher()
  }

  const onEvent = (event: KernelEvent): void => {
    if (disposed) return
    view = reduce(view, event)
    if (listing && event.kind === 'session.state') {
      view = appendSessionList(view)
      listing = false
    }
    notify()
  }

  /** 本地说一句（不去内核绕一圈——本地就有答案的事）。 */
  const say = (text: string): void => {
    view = appendNoticeText(view, text, 'error')
    notify()
  }

  const unsubscribeTransport = transport.subscribe(onEvent)

  const send = (command: Command): void => {
    if (disposed) return
    transport.send(command)
  }

  /**
   * 会话命令四形——**能本地判的一律本地判**：序号越界、没给标题文本这些事，
   * 内核帮不上忙（它不认识屏上的序号），发一条注定没用的命令只是把噪声过一趟协议。
   */
  const handleSession = (rest: string): void => {
    if (rest === '') {
      // 要看得见的那种问法——答复到了把目录块拼进来
      listing = true
      send({ type: 'session.list' })
      return
    }

    if (rest === 'new') {
      send({ type: 'session.new' })
      return
    }

    if (rest === 'title' || rest.startsWith('title ')) {
      const title = rest.slice('title'.length).trim()
      const active = view.status.session?.id
      if (active === undefined) {
        say('还不知道当前是哪个会话——先打个 `/session` 看看')
        return
      }
      if (title === '') {
        say('要改成什么？`/session title <文本>`')
        return
      }

      send({ type: 'session.rename', session: active, title })
      return
    }

    // 序号按**目录里的位置**解析（屏上那个数）——越界就说清楚，不猜用户指哪条
    const index = Number(rest)
    const row = Number.isInteger(index) ? view.sessions[index - 1] : undefined
    if (row === undefined) {
      say(`没有第 ${rest} 条会话——打个 \`/session\` 看看有哪些`)
      return
    }

    send({ type: 'session.open', session: row.id })
  }

  return {
    getView: () => view,

    subscribe: (listener) => {
      watchers.add(listener)

      return () => {
        watchers.delete(listener)
      }
    },

    submit: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return

      // 本地回显先落（事件只带条目引用，不含正文——见 view.ts 文件头）
      view = appendEcho(view, trimmed)
      notify()

      // 斜杠命令与普通交代**同一条入口**：「交代就写在这里」——用户不必先切模式
      const session = parseSession(trimmed)
      if (session !== undefined) {
        handleSession(session.rest)
        return
      }

      const request = parseModelSwitch(trimmed)
      if (request === undefined) send({ type: 'input.submit', text: trimmed })
      else send({ type: 'model.switch', ...request })
    },

    answer: (decision, opts) => {
      const pending = view.pending
      if (pending === null) return

      // 提示即时撤下（裁决留痕由随后的 `tool.decision` 事件补）
      view = { ...view, pending: null }
      notify()

      // 「总是允许」**只在给了才带上键**——通道按「JSON 往返无损」校验，
      // `remember: undefined` 是丢键（有损）→ 当场拒投。不给＝一次性，与阶段 1 逐字同义。
      send(
        opts?.remember === true
          ? { type: 'decision.answer', id: pending.id, decision, remember: true }
          : { type: 'decision.answer', id: pending.id, decision },
      )
    },

    interrupt: () => {
      send({ type: 'turn.interrupt' })
    },

    refreshSessions: () => {
      send({ type: 'session.list' })
    },

    dispose: () => {
      disposed = true
      unsubscribeTransport()
      watchers.clear()
    },
  }
}
