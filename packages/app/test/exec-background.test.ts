/**
 * U70 · **`exec` 的后台那一形** —— 全链：交出去 · 跑完回一条给模型 · 按 id 停。
 *
 * 真家伙一圈（真装配 → 真沙箱 → 真闸门 → 真工具域 → 真对话域），**只有模型是替身**。
 * 本文件管的是**装配那一层新接的那两跳**（工具域 / 执行域各自的判据在它们自己的用例里）：
 *
 * | 判据 | 落在哪儿 |
 * | --- | --- |
 * | 交出去 ⇒ 这一轮不占着 | 工具回执当场落进会话，模型**接着说话**（第二轮） |
 * | 跑完 ⇒ 自动回一条给模型 | 那条消息带**输出文件路径**，且真出现在**下一次请求**里 |
 * | 它是一条 `user` 条目、**但不是用户说的** | 载荷带 `notice`；会话标题仍是用户说的第一句 |
 * | 给屏那一声 | `exec.background.done`（**不落库**），带 id / 路径 / 退出码 |
 * | dev server 那一形 | **永不结束 ⇒ 一条消息都不发**；按 id 停掉之后才发（标着「停的」） |
 *
 * ⚠️ **两件事分开**（设计明写）：给**模型**的那一条走交代通道（进上下文），
 * 给**屏**的那一声走瞬时事件——本文件两条各验一遍，不混验。
 */

import { describe, expect, test } from 'bun:test'
import type { FauxTurn } from '@magic/faux'
import { attachShell } from '../src/index.ts'
import type { ShellHandle } from '../src/shell.ts'
import { eventsOfKind, lastModel, makeStage, readDatabase } from './support.ts'

/** 后台命令吐的那一行——回读输出文件与「模型看到了什么」都按它认。 */
const MARK = 'BG_OUTPUT_MARK'

/** 等到条件成立（或超时）——第二轮是**内核自己**起的（不是 `submit` 发起的），得等。 */
async function until(probe: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !probe()) await Bun.sleep(10)
  if (!probe()) throw new Error('等不到那一下——超时了')
}

/** 等一条 `session.state`——会话命令的答复（命令面只发不收）。 */
async function nextState(handle: ShellHandle, timeoutMs = 5000): Promise<readonly { id: string; title?: string }[]> {
  const event = await handle.until((candidate) => candidate.kind === 'session.state', timeoutMs)
  if (event.kind !== 'session.state') throw new Error('等的就是 session.state')
  return [...event.data.sessions]
}

/** 一条模型消息的正文（判别联合：`role:'tool'` 那支的正文在 `output` 上）。 */
function textOf(message: { readonly role: string }): string {
  const any = message as { readonly content?: unknown; readonly name?: string; readonly output?: string }
  if (typeof any.content === 'string') return any.content
  if (Array.isArray(any.content)) {
    return (any.content as readonly { type: string; text?: string }[])
      .map((part) => (part.type === 'text' ? (part.text ?? '') : '〔图片〕'))
      .join('')
  }
  return `${any.name ?? ''}: ${any.output ?? ''}`
}

describe('U70 · 后台那一形（全链）', () => {
  test('交出去 ⇒ 立刻回执 ＋ 模型接着干；跑完 ⇒ 自动多一条带路径的消息', async () => {
    const stage = makeStage()

    try {
      const turns: readonly FauxTurn[] = [
        // ① 模型把命令交出去
        { toolCalls: [{ name: 'exec', args: { cmd: `sleep 0.2; echo ${MARK}`, background: true } }] },
        // ② **这一轮不等它**——模型接着说话（回执已经在手上了）
        { text: '已经交出去了，我接着做别的' },
        // ③ 由「跑完」那一条唤醒的那一轮
        { text: '看到后台跑完了' },
      ]
      const assembly = stage.assemble({ turns })
      const shell = attachShell(assembly.shell)

      await shell.submit('起一条后台命令')
      // 第二轮是**内核自己**投的那一条带起来的——等它落定
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= 3)

      // —— ① 这一轮不占着：交出去那一轮里模型**接着说了话** ——
      const model = lastModel(stage)
      expect(model.requests.length).toBe(3)

      // —— ② 回执：id ＋ 输出文件路径，当场给模型 ——
      const toolResult = eventsOfKind(shell.events, 'tool.result')[0]
      expect(toolResult?.data.ok).toBe(true)
      const receipt = textOfOutput(toolResult?.data.output)
      expect(receipt).toContain('bg-1')
      expect(receipt).toContain('.log')

      // —— ③ 跑完 ⇒ 给屏那一声（带 id / 路径 / 退出码） ——
      const done = eventsOfKind(shell.events, 'exec.background.done')
      expect(done.length).toBe(1)
      expect(done[0]?.data.id).toBe('bg-1')
      expect(done[0]?.data.ok).toBe(true)
      expect(done[0]?.data.exit).toBe(0)
      const outputPath = done[0]?.data.outputPath ?? ''
      // **工作区之外**（设计明写）
      expect(outputPath.startsWith(stage.workspace)).toBe(false)

      // —— ④ 跑完 ⇒ 给模型那一条：真出现在**下一次请求**里 ——
      const third = model.requests[2]
      expect(third).toBeDefined()
      const sent = (third?.messages ?? []).map(textOf).join('\n')
      expect(sent).toContain(outputPath)
      expect(sent).toContain('后台命令跑完了')

      // —— ⑤ 它是一条 `user` 条目，但**不是用户说的**（载荷带 notice） ——
      const users = eventsOfKind(shell.events, 'message.user')
      expect(users.length).toBe(2) // 真交代一条 ＋ 内核投的一条

      assembly.close()
      const raw = readDatabase(assembly.paths.database)
      try {
        const notices = raw.entries.filter(
          (entry) => entry.kind === 'user' && entry.payload?.includes('"notice":true') === true,
        )
        expect(notices.length).toBe(1)
        expect(notices[0]?.content_text).toContain(outputPath)
        // 真交代那一条**不带**这一位（只有内核投的才带）
        const spoken = raw.entries.filter((entry) => entry.kind === 'user')
        expect(spoken.length).toBe(2)
      } finally {
        raw.close()
      }
    } finally {
      stage.dispose()
    }
  })

  test('会话标题仍是用户说的第一句——内核投的那一条不许顶上去', async () => {
    const stage = makeStage()

    try {
      const turns: readonly FauxTurn[] = [
        { toolCalls: [{ name: 'exec', args: { cmd: 'echo 好了', background: true } }] },
        { text: '交了' },
        { text: '看到了' },
      ]
      const assembly = stage.assemble({ turns })
      const shell = attachShell(assembly.shell)

      await shell.submit('把构建交出去')
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= 3)

      shell.send({ type: 'session.list' })
      const sessions = await nextState(shell)
      const title = sessions.find((row) => row.id === assembly.session)?.title
      expect(title).toBe('把构建交出去')

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('dev server 那一形：一直挂着 ⇒ 一条消息都不发；按 id 停 ⇒ 才发一条（标着停的）', async () => {
    const stage = makeStage()

    try {
      const turns: readonly FauxTurn[] = [
        // 一条**永不结束**的命令（`sleep` 活到用例把它停掉为止）
        { toolCalls: [{ name: 'exec', args: { cmd: 'echo 起来了; sleep 60', background: true } }] },
        { text: '交出去了' },
        // 停掉之后那一轮（唤醒模型的那一条）
        { text: '知道它停了' },
      ]
      const assembly = stage.assemble({ turns })
      const shell = attachShell(assembly.shell)

      await shell.submit('起个服务')
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= 2)

      // —— 它在跑、而且**没有**「跑完」那一声（设计：输出安静 ≠ 结束） ——
      expect(eventsOfKind(shell.events, 'exec.background.done').length).toBe(0)
      await Bun.sleep(200)
      expect(eventsOfKind(shell.events, 'exec.background.done').length).toBe(0)

      // —— 按 id 停（第五格） ——
      const background = assembly.background
      if (background === undefined) throw new Error('这次装配没接后台那一形')
      const stopped = await background.stop('bg-1')
      expect(stopped.ok).toBe(true)

      await until(() => eventsOfKind(shell.events, 'exec.background.done').length >= 1)
      const done = eventsOfKind(shell.events, 'exec.background.done')[0]
      expect(done?.data.stopped).toBe(true)
      expect(done?.data.ok).toBe(false)

      // 停掉也回一条给模型（说得清是「停的」）——下一轮请求里看得到
      await until(() => eventsOfKind(shell.events, 'turn.end').length >= 3)
      const sent = (lastModel(stage).requests[2]?.messages ?? []).map(textOf).join('\n')
      expect(sent).toContain('后台命令已停掉')

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

/** `tool.result` 的载荷输出（判别式：内联文本 / blob 引用）——回执那一句按它取。 */
function textOfOutput(output: unknown): string {
  const source = output as { readonly text?: unknown } | undefined
  if (typeof source?.text === 'string') return source.text
  return JSON.stringify(output)
}
