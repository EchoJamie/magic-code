import type { Command } from '@magic/contracts'
import { leftSpan, rightSpan, stepLeft, stepRight } from './components/composer.ts'
import { isPrintable } from './components/lines.ts'
import type { ShellKey } from './input.ts'
import type { PromptState } from './view.ts'

export type Ask = {
  /** 问的是什么——一行标签（密钥那一路会自动补上「输入不回显」）。 */
  readonly label: string

  /** 隐藏输入（密钥）：屏上只见圆点，真值只在壳里。 */
  readonly secret: boolean

  /** 初始值（改名时给现名；密钥一律空串）。 */
  readonly value: string
  readonly caret: number

  /** 空着时那一行的占位（一句实话）。 */
  readonly placeholder: string

  /** 底下那行补充说明（可省）。 */
  readonly note?: string

  /** 回车时**要发什么**——`null` ＝ 什么都不发（只是收起来）。 */
  readonly submit: (value: string) => Command | null
  readonly local?: (value: string) => void
  readonly change?: (value: string) => void
}

/** 本地字段自持明文，只有遮罩后的投影进入视图；不写入输入历史。 */
export function createPrompt({ present, send, popLayer, onSubmit }: {
  present: (prompt: PromptState | null) => void
  send: (command: Command) => void
  popLayer: () => void
  onSubmit: (command: Command, value: string) => boolean
}) {
  let asking: Ask | null = null

  const promptViewOf = (ask: Ask): PromptState => {
    if (!ask.secret) {
      return {
        label: ask.label,
        display: ask.value,
        caret: ask.caret,
        placeholder: ask.placeholder,
        ...(ask.note === undefined ? {} : { note: ask.note }),
      }
    }
    return {
      // 「输入不回显」是**这一屏的事实**，写在标签上——用户得知道自己打的字为什么看不见
      label: `${ask.label}（输入不回显）`,
      display: '•'.repeat([...ask.value].length),
      // 圆点一字符一格：插入点按**码点**数，与画出来的那一串同尺
      caret: [...ask.value.slice(0, ask.caret)].length,
      placeholder: ask.placeholder,
      ...(ask.note === undefined ? {} : { note: ask.note }),
    }
  }

  const openAsk = (ask: Ask): void => {
    asking = ask
    present(promptViewOf(ask))
  }

  const closeAsk = (): void => {
    asking = null
    present(null)
  }

  /** 编辑当前这一份小输入（值一变就重画——视图那一份是**派生**的，不另存）。 */
  const editAsk = (value: string, caret: number): void => {
    const held = asking
    if (held === null) return
    held.change?.(value)
    asking = { ...held, value, caret: Math.max(0, Math.min(caret, value.length)) }
    present(promptViewOf(asking))
  }

  /**
   * 按下回车——**交回给问的人**：`submit` 给一条命令就发出去，给 `null` 就只是收起来。
   *
   * ⚠️ **先落地、后发命令**（那条老次序）：进程内传输是同步直连的，反过来的话这次
   * `commit` 拿的是发命令**之前**的快照，会把答复刚写进去的东西盖掉。
   */
  const submitAsk = (): void => {
    const held = asking
    if (held === null) return
    if (held.local !== undefined) {
      held.local(held.value)
      return
    }
    const command = held.submit(held.value)
    if (command !== null && onSubmit(command, held.value)) return
    asking = null
    present(null)
    if (command !== null) send(command)
    return
  }

  /** 小输入那几键——只认**单行编辑**该认的那些（没有换行、没有历史、没有候选）。 */
  const askKey = (input: ShellKey): void => {
    const held = asking
    if (held === null) return
    switch (input.kind) {
      case 'char':
        if (!isPrintable(input.char)) return
        editAsk(
          held.value.slice(0, held.caret) + input.char + held.value.slice(held.caret),
          held.caret + input.char.length,
        )
        return
      case 'backspace': {
        const [from, to] = leftSpan(held.value, held.caret)
        if (from === to) return
        editAsk(held.value.slice(0, from) + held.value.slice(to), from)
        return
      }
      case 'delete': {
        const [from, to] = rightSpan(held.value, held.caret)
        if (from === to) return
        editAsk(held.value.slice(0, from) + held.value.slice(to), from)
        return
      }
      case 'right':
        editAsk(held.value, stepRight(held.value, held.caret))
        return
      case 'paste': {
        // **单行**：控制字符（含换行、Tab）不收——粘一串**带尾换行**的密钥是常事，
        // 而那一个换行落进值里就是一条查不出来的错（屏上是圆点，看不出多了一格）
        const text = [...input.text].filter((char) => isPrintable(char)).join('')
        if (text === '') return
        editAsk(
          held.value.slice(0, held.caret) + text + held.value.slice(held.caret),
          held.caret + text.length,
        )
        return
      }
      case 'left':
        editAsk(held.value, stepLeft(held.value, held.caret))
        return
      case 'escape':
        popLayer()
        return
      case 'enter':
        return submitAsk()
      // 上下键 / Tab / 换行在这一屏没有活——**什么都不做**（不当正文，也不装作有别的用法）
      default:
        return
    }
  }
  return {
    snapshot: () => asking,
    restore: (ask: Ask | null) => { asking = ask },
    clear: () => { asking = null },
    note: (note: string) => {
      if (asking === null) return
      asking = { ...asking, note }
      present(promptViewOf(asking))
    },
    show: () => { if (asking !== null) present(promptViewOf(asking)) },
    open: openAsk,
    close: closeAsk,
    key: askKey,
    submit: submitAsk,
  }
}
