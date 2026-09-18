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
import { appendEcho, createView, reduce } from './view.ts'

/** 换模型那条斜杠命令——**只此一条**（交互词汇：自然语言优先、固定命令精简）。 */
const MODEL_COMMAND = '/model'

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
  /** 收摊——退订传输、清订阅者（此后的命令一律丢弃）。 */
  dispose(): void
}

/** 建会话壳——**构造即订阅**（先接订阅、后放开输入）。 */
export function createShell(transport: ControlTransport): Shell {
  const watchers = new Set<() => void>()
  let view = createView()
  let disposed = false

  const notify = (): void => {
    for (const watcher of [...watchers]) watcher()
  }

  const onEvent = (event: KernelEvent): void => {
    if (disposed) return
    view = reduce(view, event)
    notify()
  }

  const unsubscribeTransport = transport.subscribe(onEvent)

  const send = (command: Command): void => {
    if (disposed) return
    transport.send(command)
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

    dispose: () => {
      disposed = true
      unsubscribeTransport()
      watchers.clear()
    },
  }
}
