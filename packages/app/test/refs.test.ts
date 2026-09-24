/**
 * U36 · 引用 —— **真装配的端到端**（从真实输入到模型请求、持久记录与恢复）。
 *
 * 判据落在四样真东西上（同 `skills.test.ts` 的取法）：
 * - **真模型请求**——`lastModel(stage).requests[i].messages` 就是送去模型的那一份；
 * - **真控制入口**——结构化输入经 `shell.send({type:'input.submit', …})` 进内核；
 * - **真记录**——直读库表（`readDatabase`），不看内存里的副本；
 * - **真工作区**——材料是沙地里那几个真文件（读的是当前内容，不是桩）。
 *
 * 沙地三块（数据目录 / 工作区 / 家目录）都由 `makeStage` 落在唯一临时目录里（不碰真东西）。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InputRef, KernelEvent } from '@magic/contracts'
import { createShell } from '@magic/tui'
import { attachShell } from '../src/index.ts'
import type { ShellHandle } from '@magic/app'
import { lastModel, makeStage, readDatabase, type Stage } from './support.ts'

// —— 夹具 ——

/** 在沙地里写一个文件（中间目录自动建）。 */
function put(where: string, relative: string, text: string): string {
  const path = join(where, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

/** 等「回到等待输入」攒够几次（同 `skills.test.ts` 的取法）。 */
function waitIdle(shell: ShellHandle, times: number): Promise<void> {
  return new Promise((settle) => {
    const watch = setInterval(() => {
      const idle = shell.events.filter(
        (event) => event.kind === 'agent.state' && event.data.state === 'waiting',
      )
      if (idle.length < times) return
      clearInterval(watch)
      settle()
    }, 5)
  })
}

function sendAndWait(shell: ShellHandle, input: { readonly text: string; readonly refs?: readonly InputRef[]; readonly ref?: string }): Promise<void> {
  const before = shell.events.filter(
    (event: KernelEvent) => event.kind === 'agent.state' && event.data.state === 'waiting',
  ).length
  shell.send({ type: 'input.submit', ...input })
  return waitIdle(shell, before + 1)
}

/** 第 n 次模型请求里 `user` 消息的正文（「送到模型手上了吗」看它）。 */
function userText(stage: Stage, index: number): string {
  const messages = lastModel(stage).requests[index]?.messages ?? []
  return messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n')
}

/**
 * 第 n 次请求里**最后那条** user 消息——**这一次交代本身**。
 *
 * 与 `userText` 的分工：那个把整场对话的 user 消息拼起来（上下文里当然有早先几条），
 * 判「这一次读到的材料是哪一版」只看最后这一条。
 */
function lastUserText(stage: Stage, index: number): string {
  const messages = lastModel(stage).requests[index]?.messages ?? []
  const found = [...messages].reverse().find((message) => message.role === 'user')
  if (found === undefined) return ''

  // U37 起用户消息的正文可能是**部件串**（带图那条）——这里只取文字那几件
  return typeof found.content === 'string'
    ? found.content
    : found.content.map((part) => (part.type === 'text' ? part.text : '〔图片〕')).join('')
}

/** 库里的 `user` 条目（直读——不经读 API）。 */
function userRows(assembly: { paths: { database: string } }) {
  const raw = readDatabase(assembly.paths.database)
  const rows = raw.entries.filter((row) => row.kind === 'user')
  raw.close()
  return rows
}

/** 一条 `user` 条目的载荷（解析出来——库里存的是 JSON 一列）。 */
function payloadOf(row: { readonly payload: string | null }): {
  readonly refs?: readonly {
    readonly kind: string
    readonly at: number
    readonly marker: string
    readonly source: string
    /** **选配**（U63）：自读那一版没有正文——有它的是旧记录与工作区外那份只读附件。 */
    readonly text?: string
    readonly truncated?: true
    readonly omitted?: number
    readonly external?: true
  }[]
} {
  return JSON.parse(row.payload ?? '{}') as never
}

// ══ 工单的示例场景 ════════════════════════════════════════════════════

describe('U36 · 「先读 @需求.md，再按 /review 检查 @src/login.ts」', () => {
  /**
   * ⚠️ **本组 U63 改判**：三支（文件 / 目录 / 技能）的送达方式从「引用即进」（正文随请求
   * 展开在那一处引用之后）改成「**模型按需自读**」——请求里只有引用那几个字，正文由模型
   * 自己用 `read` / `ls` / `skill` 去取。故下面断的是「**一个字都没展开**」＋「**收了尾**」。
   */
  test('从真实输入到模型请求：引用原样留在句子里，三份正文一个都没展开', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, '需求.md', '要求：先看登录逻辑。')
      put(stage.workspace, 'src/login.ts', 'export const login = () => 1')
      put(stage.workspace, '.magic/skills/review/SKILL.md', '---\nname: review\ndescription: 检查改动\n---\n\n逐条核对清单。')

      const assembly = stage.assemble({ turns: [{ text: '好' }] })
      const shell = attachShell(assembly.shell)

      const need = realpathSync(join(stage.workspace, '需求.md'))
      const login = realpathSync(join(stage.workspace, 'src/login.ts'))
      const review = realpathSync(join(stage.workspace, '.magic/skills/review'))

      const text = '先读 @需求.md，再按 /review 检查 @src/login.ts'
      const refs: readonly InputRef[] = [
        { kind: 'file', at: 3, marker: '@需求.md', source: need },
        { kind: 'skill', at: 13, marker: '/review', name: 'review', source: review },
        { kind: 'file', at: 26, marker: '@src/login.ts', source: login },
      ]

      await sendAndWait(shell, { text, refs, ref: 'draft-1' })
      shell.dispose()

      // —— 模型请求：那句原话**整句连着**，三份材料一个字都不在里面 ——
      const said = userText(stage, 0)
      expect(said).toContain(text) // 引用留在原位——它是用户表达的一部分
      expect(said).not.toContain('要求：先看登录逻辑。')
      expect(said).not.toContain('逐条核对清单。')
      expect(said).not.toContain('export const login = () => 1')

      // —— 真记录：位置 ＋ 身份在，**正文不在**（它由模型自己取，落在工具条目里）——
      const rows = userRows(assembly)
      expect(rows).toHaveLength(1)
      const payload = payloadOf(rows[0] as { payload: string | null })
      expect(payload.refs?.map((ref) => [ref.kind, ref.at, ref.marker])).toEqual([
        ['file', 3, '@需求.md'],
        ['skill', 13, '/review'],
        ['file', 26, '@src/login.ts'],
      ])
      expect(payload.refs?.every((ref) => ref.text === undefined)).toBe(true)
      expect(payload.refs?.[0]?.source).toBe(need)
      expect(payload.refs?.[1]?.source).toBe(review) // 技能那一份取自**读回来的**那一份
      expect(payload.refs?.[2]?.source).toBe(login)
      // **没有技能时一字不多**的旧形也不在了：这一条只写 `refs`
      expect(rows[0]?.payload).not.toContain('"skills"')

      // —— 收束时**说了话**（工单第 3 条）：模型一个工具都没调 ⇒ 三份都没读 ——
      const unread = shell.events.filter((event) => event.kind === 'input.unread')
      expect(unread).toHaveLength(1)
      expect(unread[0]?.kind === 'input.unread' && unread[0].data.markers).toEqual([
        '@需求.md',
        '/review',
        '@src/login.ts',
      ])
    } finally {
      stage.dispose()
    }
  })

  test('模型真去读了：请求里没有正文，而**工具那一趟**把正文取回来（读了就不报「没读」）', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, 'src/login.ts', 'export const login = () => 1')

      // 剧本：第一趟请求一个 `read`，第二趟给结论文——就是「按需自读」那个姿势
      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'read', args: { path: 'src/login.ts' } }] }, { text: '看过了。' }],
      })
      const shell = attachShell(assembly.shell)

      const text = '看 @src/login.ts'
      await sendAndWait(shell, {
        text,
        refs: [{ kind: 'file', at: 2, marker: '@src/login.ts', source: realpathSync(join(stage.workspace, 'src/login.ts')) }],
        ref: 'draft-1',
      })
      shell.dispose()

      // 第 1 趟：引用留在原位，正文不在
      const first = userText(stage, 0)
      expect(first).toContain(text)
      expect(first).not.toContain('export const login = () => 1')

      // 第 2 趟：**模型自己读回来的那一份**在请求里（这才是「本次实际交付的内容」）——
      // 它落在工具消息上（`role: 'tool'`），不是用户消息
      const messages = lastModel(stage).requests[1]?.messages ?? []
      const toolText = messages
        .filter((message) => message.role === 'tool')
        .map((message) => ('output' in message ? message.output : ''))
        .join('\n')
      expect(toolText).toContain('export const login = () => 1')

      // 记录里那一次调用与结果都在（自读的痕落在工具条目上）
      expect(shell.events.some((event) => event.kind === 'tool.call' && event.data.name === 'read')).toBe(true)

      // **读了就不报「没读」**——那一份已经进过请求了
      expect(shell.events.filter((event) => event.kind === 'input.unread')).toHaveLength(0)
    } finally {
      stage.dispose()
    }
  })

  /**
   * ⚠️ **本组 U63 改判**：原先断的是「当时送出去的那一份正文留在载荷里，源文件改了删了也照旧」
   * ——那是**引用即进**那一版的语义（正文随请求展开，故要存快照）。自读那一版里
   * **引用这一趟不留正文**（正文由模型自己取，落在**工具条目**里），故这里改断两件事：
   * ① 记录 append-only：已入会话那一条的位置与身份**一个字不动**；
   * ② 源没了之后**再引用它当场拦下**（校验那一趟的活——不静默、不换同名项）。
   */
  test('源改了：已入会话那一条**一个字不动**（记录 append-only）；源删了：再引用它当场拦下', async () => {
    const stage = makeStage()
    try {
      const need = put(stage.workspace, '需求.md', '第一版：先看登录。')

      const first = stage.assemble({ turns: [{ text: '好' }] })
      const shell = attachShell(first.shell)
      await sendAndWait(shell, {
        text: '读 @需求.md',
        refs: [{ kind: 'file', at: 2, marker: '@需求.md', source: realpathSync(need) }],
        ref: 'draft-1',
      })
      shell.dispose()

      // 源文件改了（换成第二版）——再交代一次，引用同一处
      put(stage.workspace, '需求.md', '第二版：改看注册。')
      put(stage.workspace, 'b.txt', '乙')

      const second = stage.assemble({ turns: [{ text: '好' }] })
      const shell2 = attachShell(second.shell)
      await sendAndWait(shell2, {
        text: '再看 @需求.md 与 @b.txt',
        refs: [
          { kind: 'file', at: 3, marker: '@需求.md', source: realpathSync(join(stage.workspace, '需求.md')) },
          { kind: 'file', at: 13, marker: '@b.txt', source: realpathSync(join(stage.workspace, 'b.txt')) },
        ],
        ref: 'draft-2',
      })

      // 两句交代各自记着**自己的那一处引用**（位置 ＋ 身份），互不覆盖
      const rows = userRows(second)
      expect(rows).toHaveLength(2)
      const refsOf = (at: number) => payloadOf(rows[at] as { payload: string | null }).refs
      expect(refsOf(0)?.map((ref) => [ref.at, ref.marker])).toEqual([[2, '@需求.md']])
      expect(refsOf(1)?.map((ref) => [ref.at, ref.marker])).toEqual([[3, '@需求.md'], [13, '@b.txt']])
      expect(refsOf(0)?.[0]?.source).toBe(refsOf(1)?.[0]?.source) // 同一份材料：身份同一条真路径

      // —— 把源文件**删掉**：再引用它**当场拦下**（校验那一趟的活），原稿还回输入区 ——
      rmSync(join(stage.workspace, '需求.md'))
      await sendAndWait(shell2, {
        text: '再读 @需求.md',
        refs: [{ kind: 'file', at: 3, marker: '@需求.md', source: join(stage.workspace, '需求.md') }],
        ref: 'draft-3',
      })
      shell2.dispose()

      const settled = shell2.events.filter((event) => event.kind === 'input.settled')
      const last = settled[settled.length - 1]
      expect(last?.kind === 'input.settled' && last.data.ok).toBe(false)
      expect(last?.kind === 'input.settled' && last.data.reason).toContain('不在了')
      // 第三条**没进会话**（那两句交代照旧两条）
      expect(userRows(second)).toHaveLength(2)

      second.close()
    } finally {
      stage.dispose()
    }
  })
})

// ══ 边界（都有确定结果）════════════════════════════════════════════════

describe('U36 · 边界：目录 / 超限 / 二进制 / 工作区外', () => {
  /**
   * ⚠️ **本组 U63 改判**：目录原先送的是「有界清单」（一层、最多 200 项、说清未列出的部分）。
   * 改成「模型按需自读」之后**清单不再进请求**——模型自己 `ls` 那一下才是它这一轮看到的。
   * 故这里断两件事：**请求里没有清单**；而模型 `ls` 之后，**那一趟的结果里是真清单**
   * （自读走的是同一条有界列目录的路）。
   */
  test('目录：清单不随请求展开——模型自己 `ls`，读回来的才是清单', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, 'src/a.ts', 'a')
      put(stage.workspace, 'src/sub/b.ts', 'b')

      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'ls', args: { path: 'src' } }] }, { text: '看过了' }],
      })
      const shell = attachShell(assembly.shell)

      await sendAndWait(shell, {
        text: '看看 @src/',
        refs: [
          { kind: 'dir', at: 3, marker: '@src/', source: realpathSync(join(stage.workspace, 'src')) },
        ],
        ref: 'draft-1',
      })
      shell.dispose()

      // ① 第一趟：引用留在原位，清单不在请求里
      const said = userText(stage, 0)
      expect(said).toContain('看看 @src/')
      expect(said).not.toContain('a.ts')
      expect(said).not.toContain('sub/')

      // ② 模型自己 `ls` 之后：清单在**工具那一趟**（一眼分得出文件与目录：目录带尾斜杠）
      const messages = lastModel(stage).requests[1]?.messages ?? []
      const toolText = messages
        .filter((message) => message.role === 'tool')
        .map((message) => ('output' in message ? message.output : ''))
        .join('\n')
      expect(toolText).toContain('a.ts')
      expect(toolText).toContain('sub/')
      expect(toolText).not.toContain('sub/b.ts') // 只列一层，不递归塞进整个项目

      // ③ 记录里那一处引用：位置 ＋ 身份在，**清单不在**（它由模型自己取）
      const ref = payloadOf(userRows(assembly)[0] as { payload: string | null }).refs?.[0]
      expect(ref?.kind).toBe('dir')
      expect(ref?.text).toBeUndefined()
      expect(ref?.omitted).toBeUndefined()

      // ④ **读了就不报「没读」**（`ls` 落在这一处，账认得出）
      expect(shell.events.filter((event) => event.kind === 'input.unread')).toHaveLength(0)
    } finally {
      stage.dispose()
    }
  })

  test('目录很大也只是目录：清单不进请求，故不再有「未列出的部分」要说', async () => {
    const stage = makeStage()
    try {
      // 250 项——原先这一条会撞上「一层最多 200 项、另有 N 项未列」那条有界清单
      for (let at = 0; at < 250; at += 1) put(stage.workspace, `many/m${String(at).padStart(3, '0')}.txt`, 'x')

      const assembly = stage.assemble({ turns: [{ text: '好' }] })
      const shell = attachShell(assembly.shell)

      await sendAndWait(shell, {
        text: '看看 @many/',
        refs: [{ kind: 'dir', at: 3, marker: '@many/', source: realpathSync(join(stage.workspace, 'many')) }],
        ref: 'draft-1',
      })
      shell.dispose()

      // 请求里一条清单都没有（也就无所谓「列到上限」那一说）
      expect(userText(stage, 0)).toContain('看看 @many/')
      expect(userText(stage, 0)).not.toContain('m000.txt')

      // 那一趟也没白跑：取它是为了**校验**（写的确实是个列得动的目录），故这一条跑得下去
      expect(userRows(assembly)).toHaveLength(1)
      expect(payloadOf(userRows(assembly)[0] as { payload: string | null }).refs?.[0]?.kind).toBe('dir')
    } finally {
      stage.dispose()
    }
  })

  test('二进制：**整条不跑**，把话说清（不糊一串乱码进上下文）', async () => {
    const stage = makeStage()
    try {
      const path = join(stage.workspace, 'png.bin')
      writeFileSync(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))

      const assembly = stage.assemble({ turns: [{ text: '好' }] })
      const shell = attachShell(assembly.shell)

      await sendAndWait(shell, {
        text: '看 @png.bin',
        refs: [{ kind: 'file', at: 2, marker: '@png.bin', source: realpathSync(path) }],
        ref: 'draft-1',
      })
      shell.dispose()

      // 模型一次都没被叫（这一条压根没跑）
      expect(lastModel(stage).requests).toHaveLength(0)
      // 一个条目都没落（没有「用户说了什么」这回事）
      expect(userRows(assembly)).toHaveLength(0)

      // 配对一次失败，并把缘由说清
      const settled = shell.events.filter((event) => event.kind === 'input.settled')
      expect(settled).toHaveLength(1)
      expect(settled[0]?.data.ok).toBe(false)
      expect(settled[0]?.data.reason).toContain('二进制')
    } finally {
      stage.dispose()
    }
  })

  test('工作区外：不带 `external` ⇒ 拒（`@` 与粘贴不获准）；明确选定 ⇒ 只读附件取到', async () => {
    const stage = makeStage()
    const outside = mkdtempSync(join(tmpdir(), 'magic-outside-'))
    try {
      const path = put(outside, 'notes.md', '外面的笔记')
      const real = realpathSync(path)

      const first = stage.assemble({ turns: [{ text: '好' }] })
      const shell = attachShell(first.shell)
      await sendAndWait(shell, {
        text: '看 @/notes.md',
        refs: [{ kind: 'file', at: 2, marker: '@/notes.md', source: real }],
        ref: 'draft-1',
      })
      shell.dispose()

      expect(lastModel(stage).requests).toHaveLength(0)
      const refused = shell.events.filter((event) => event.kind === 'input.settled')
      expect(refused[0]?.data.ok).toBe(false)
      expect(refused[0]?.data.reason).toContain('工作区外')

      // 用户明确选定（候选里按下回车那一下）——只读附件读得到
      const second = stage.assemble({ turns: [{ text: '好' }] })
      const shell2 = attachShell(second.shell)
      await sendAndWait(shell2, {
        text: '看 @/notes.md',
        refs: [{ kind: 'file', at: 2, marker: '@/notes.md', source: real, external: true }],
        ref: 'draft-2',
      })
      shell2.dispose()

      expect(userText(stage, 0)).toContain('外面的笔记')
      expect(userText(stage, 0)).toContain('工作区外 · 只读附件')

      // 记录里也标着它是外部附件（审计上说得清）
      const rows = userRows(second)
      expect(payloadOf(rows[0] as { payload: string | null }).refs?.[0]?.external).toBe(true)

      // **没赋予写工具新权限**：那一趟读没有动过工作区的根（沙箱的边界一条没松）——
      // 见 `packages/execution/test/materials.test.ts` 里那条同源的判据（外部路径
      // 取完之后仍解析不出落点）；这里从文件那一侧看：它一个字节都没被改写。
      expect(readFileSync(path, 'utf8')).toBe('外面的笔记')
    } finally {
      stage.dispose()
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

// ══ 输入历史（U36 · 验收退回那一项）══════════════════════════════════

describe('U36 · 输入历史：召回整份草稿，重新提交时才读当前材料', () => {
  /** 轮询到条件成立（真装配的答复是异步的）。 */
  async function until(check: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (check()) return
      await Bun.sleep(10)
    }
    throw new Error(`等「${what}」超时`)
  }

  /**
   * ⚠️ **本组 U63 改判**：原先断的是「请求里是**当时**的文件内容」（引用即进 ⇒ 再提交时
   * 重读当前那一份）。自读那一版里**引用不再展开正文**，故这里只断历史与记录那一半，
   * 正文那一半改由上面「模型真去读了」那条咬（模型自己读，落在工具条目里）。
   */
  test('`↑` 召回带引用的那一句 → 编辑 → 再提交：整份草稿往返，记录两笔都在', async () => {
    const stage = makeStage()
    try {
      const file = put(stage.workspace, 'a.txt', '第一版')
      put(
        stage.workspace,
        '.magic/skills/review/SKILL.md',
        '---\nname: review\ndescription: 检查改动\n---\n\n逐条核对清单。',
      )

      const assembly = stage.assemble({ turns: [{ text: '好。' }, { text: '好。' }] })
      // **真外壳**（TUI 的 `createShell`）＋ 真装配：键进外壳，命令经控制面进内核
      const shell = createShell(assembly.shell)
      const view = (): ReturnType<typeof shell.getView> => shell.getView()
      /** 候选行数（抽屉开着才有）。 */
      const candidateRows = (): number => {
        const dock = view().dock
        return dock.kind === 'picker' ? dock.picker.rows.length : 0
      }
      const type = async (text: string): Promise<void> => {
        for (const char of text) {
          shell.key({ kind: 'char', char })
          await Bun.sleep(5)
        }
      }

      // —— 第一条：@ 选入一个文件引用（真去看工作区），再选一处技能，回车提交 ——
      await type('先读 ')
      shell.key({ kind: 'char', char: '@' })
      await until(() => view().paths !== null, '路径候选答复')
      await until(() => candidateRows() > 0, '候选铺上')
      await type('a.txt')
      await until(() => candidateRows() === 1, '筛到那一条')
      shell.key({ kind: 'enter' })
      await until(() => view().dock.kind === 'input', '抽屉收起')

      await type('，再按 ')
      // `/` 之后**打了名字才列技能**（U33 那条分寸）——故先打 `rev` 再等候选
      await type('/rev')
      await until(() => (view().completion?.candidates.length ?? 0) > 0, '技能名进候选')
      shell.key({ kind: 'tab' }) // 句中那处技能：**显式选定**才绑上身份
      await type(' 检查')
      shell.key({ kind: 'enter' })
      await until(() => lastModel(stage).requests.length >= 1, '第一次模型请求')

      const first = userText(stage, 0)
      // 引用留在原位（那一句原话逐字在），而**正文一个都没展开**（U63：按需自读）
      expect(first).toContain('先读 @a.txt，再按 /review 检查')
      expect(first).not.toContain('第一版')
      expect(first).not.toContain('逐条核对清单。')

      // —— 改源文件：**已发送的那一份**不该被改写 ——
      put(stage.workspace, 'a.txt', '第二版')

      // —— 用户已经在打新的一条（原稿），这时按 `↑` 召回 ——
      await until(() => view().draft === '', '草稿已清')
      await type('原稿半句')
      shell.key({ kind: 'up' })

      const recalled = view()
      expect(recalled.draft).toBe('先读 @a.txt，再按 /review 检查')
      expect(recalled.refs.map((ref) => ref.kind)).toEqual(['file', 'skill'])
      expect(recalled.refs[0]?.source).toBe(realpathSync(file))
      expect(recalled.refs[1]?.source).toBe(realpathSync(join(stage.workspace, '.magic/skills/review')))
      // **翻历史不发命令**（一条模型请求都没多）
      expect(lastModel(stage).requests).toHaveLength(1)

      // 往回按一下 `↓` ⇒ 原稿整份回来（正文 ＋ 引用 ＋ 插入点）
      shell.key({ kind: 'down' })
      expect(view().draft).toBe('原稿半句')
      expect(view().refs).toEqual([])

      // —— 再召回来、接着编辑、提交 ——
      shell.key({ kind: 'up' })
      await until(() => view().draft.startsWith('先读 @a.txt'), '召回')
      await type(' 再看一遍')
      shell.key({ kind: 'enter' })
      await until(() => lastModel(stage).requests.length >= 2, '第二次模型请求')
      await until(() => userRows(assembly).length === 2, '第二条条目落账')

      // ① 实际模型输入：召回回来的那一句**逐字在**（正文与引用都在原处），正文仍不展开
      const second = lastUserText(stage, 1)
      expect(second).toContain('再看一遍')
      expect(second).toContain('@a.txt')
      expect(second).toContain('/review')
      expect(second).not.toContain('第一版')
      expect(second).not.toContain('第二版')
      expect(second).not.toContain('逐条核对清单。')

      // ② 记录：两笔各自留着**自己的那一处引用**（位置 ＋ 身份），历史不被改写
      const rows = userRows(assembly)
      const [one, two] = rows.map((row) => payloadOf(row as { payload: string | null }))
      expect(one?.refs?.map((ref) => [ref.kind, ref.at, ref.marker, ref.text])).toEqual([
        ['file', 3, '@a.txt', undefined],
        ['skill', 13, '/review', undefined],
      ])
      expect(two?.refs?.map((ref) => [ref.kind, ref.at, ref.marker, ref.text])).toEqual([
        ['file', 3, '@a.txt', undefined],
        ['skill', 13, '/review', undefined],
      ])
      // 技能那一处的身份取自**读回来的那一份**（两次都一样）
      expect(one?.refs?.[1]?.source).toBe(two?.refs?.[1]?.source)
      for (const [index, payload] of [one, two].entries()) {
        const text = rows[index]?.content_text ?? ''
        for (const ref of payload?.refs ?? []) {
          expect(text.slice(ref.at, ref.at + ref.marker.length)).toBe(ref.marker)
        }
      }

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  }, 30_000)

  test('半条纯文本也照旧：召回纯文本的那一条，不带任何引用', async () => {
    const stage = makeStage()
    try {
      const assembly = stage.assemble({ turns: [{ text: '好。' }] })
      const shell = createShell(assembly.shell)

      for (const char of '就是一句话') shell.key({ kind: 'char', char })
      shell.key({ kind: 'enter' })
      await until(() => lastModel(stage).requests.length >= 1, '模型请求')

      shell.key({ kind: 'up' })
      expect(shell.getView().draft).toBe('就是一句话')
      expect(shell.getView().refs).toEqual([])

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

// ══ 粘贴：原文照收（U36 · 独立复核）═══════════════════════════════════

describe('U36 · 粘进来的一段原文照收（Tab 与多行都留着）', () => {
  test('bracketed paste 带 Tab 与多行 ⇒ 模型请求与记录**逐字相同**', async () => {
    const stage = makeStage()
    try {
      const pasted = 'if ready:\n\tprint(1)\nleft\tright'

      const assembly = stage.assemble({ turns: [{ text: '好。' }] })
      const shell = createShell(assembly.shell)

      // 真外壳里的粘贴那一跳（`TuiApp` 把 bracketed paste 收成 `{kind:'paste'}`）
      shell.key({ kind: 'paste', text: pasted })
      expect(shell.getView().draft).toBe(pasted) // 草稿里逐字在（Tab 没被删）

      shell.key({ kind: 'enter' })
      await new Promise((resolve) => setTimeout(resolve, 400))

      // ① 真模型请求：那一段**逐字**在（缩进与分隔都在）
      const sent = lastUserText(stage, 0)
      expect(sent).toContain(pasted)
      expect(sent).toContain('\tprint(1)') // 行内那个 Tab 还在
      expect(sent).toContain('left\tright') // 行里那一处 Tab 也在

      // ② 真记录：条目正文逐字相同
      const rows = userRows(assembly)
      expect(rows[0]?.content_text).toBe(pasted)

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

// ══ 忙时 ══════════════════════════════════════════════════════════════

describe('U36 · 忙时：整份输入入队，出队不串', () => {
  test('两条交代各带各的材料：次序与载荷都不串', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, 'a.txt', '甲的材料')
      put(stage.workspace, 'b.txt', '乙的材料')

      const assembly = stage.assemble({ turns: [{ text: '好' }, { text: '好' }], stepDelayMs: 30 })
      const shell = attachShell(assembly.shell)

      const a = realpathSync(join(stage.workspace, 'a.txt'))
      const b = realpathSync(join(stage.workspace, 'b.txt'))

      // 两条几乎同时递进去（忙时排队那条路）
      const first = sendAndWait(shell, {
        text: '看 @a.txt',
        refs: [{ kind: 'file', at: 2, marker: '@a.txt', source: a }],
        ref: 'draft-1',
      })
      const second = sendAndWait(shell, {
        text: '看 @b.txt',
        refs: [{ kind: 'file', at: 2, marker: '@b.txt', source: b }],
        ref: 'draft-2',
      })
      await Promise.all([first, second])
      shell.dispose()

      const rows = userRows(assembly)
      expect(rows).toHaveLength(2)
      const refs = rows.map((row) => payloadOf(row as { payload: string | null }).refs?.[0])
      expect(refs.map((ref) => ref?.source)).toEqual([a, b])
      // 正文不在载荷里（U63：自读那一版不留正文），次序与身份照旧各归各的
      expect(refs.map((ref) => ref?.text)).toEqual([undefined, undefined])
      expect(refs.map((ref) => ref?.marker)).toEqual(['@a.txt', '@b.txt'])
    } finally {
      stage.dispose()
    }
  })

  test('旧纯文本输入照旧（不带引用的那一条一字不多）', async () => {
    const stage = makeStage()
    try {
      const assembly = stage.assemble({ turns: [{ text: '好' }] })
      const shell = attachShell(assembly.shell)

      await sendAndWait(shell, { text: '就说一句话', ref: 'draft-1' })
      shell.dispose()

      const rows = userRows(assembly)
      expect(rows[0]?.payload).toBeNull() // 载荷不写（与加这一条之前逐字同形）
      expect(userText(stage, 0)).toContain('就说一句话')
    } finally {
      stage.dispose()
    }
  })
})

// ══ U63 · 送达方式：文件 / 目录 / 技能 ⇒ 模型按需自读 ══════════════════

/**
 * 这一组咬两件事（工单第 1 条与第 3 条）：
 *
 * - **请求里不再展开正文**——引用留在原位，模型据它去读；
 * - **「读了要说，没读也要说」**——只配前一半不够：模型没读时那一轮结束屏上什么也没有，
 *   用户照样以为它看了 ⇒ 收束时报一句「本次没读：…」。
 *
 * 判据收在**真请求 ＋ 真事件**上（沙地里的文件是真文件、工具是真执行）。
 */
describe('U63 · 自读：账认得出「读了哪一份」', () => {
  /** 一条交代里那个「没读」回执报的是哪几份（没发＝空数组）。 */
  function unreadOf(events: readonly KernelEvent[]): readonly string[] {
    const found = events.find((event) => event.kind === 'input.unread')
    return found?.kind === 'input.unread' ? found.data.markers : []
  }

  const fileRefOf = (stage: { readonly workspace: string }, name: string, at: number): InputRef => ({
    kind: 'file',
    at,
    marker: `@${name}`,
    source: realpathSync(join(stage.workspace, name)),
  })

  test('`read` 读到那一份 ⇒ 不报「没读」', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, 'a.txt', '甲的正文')
      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'read', args: { path: 'a.txt' } }] }, { text: '看了' }],
      })
      const shell = attachShell(assembly.shell)

      await sendAndWait(shell, { text: '看 @a.txt', refs: [fileRefOf(stage, 'a.txt', 2)], ref: 'd' })
      shell.dispose()

      expect(unreadOf(shell.events)).toEqual([])
    } finally {
      stage.dispose()
    }
  })

  test('`grep` 在它上面那一层搜内容 ⇒ 算读过（读的宽度是「这一处以内的全部」）', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, 'src/a.ts', '甲的正文')
      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'grep', args: { pattern: '正文', path: 'src' } }] }, { text: '看了' }],
      })
      const shell = attachShell(assembly.shell)

      await sendAndWait(shell, {
        text: '看 @src/a.ts',
        refs: [fileRefOf(stage, 'src/a.ts', 2)],
        ref: 'd',
      })
      shell.dispose()

      expect(unreadOf(shell.events)).toEqual([])
    } finally {
      stage.dispose()
    }
  })

  test('`ls` 上一层只看见名字、没看见内容 ⇒ **仍报「没读」**（宁可多说一句）', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, 'src/a.ts', '甲的正文')
      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'ls', args: { path: 'src' } }] }, { text: '列了一下' }],
      })
      const shell = attachShell(assembly.shell)

      await sendAndWait(shell, {
        text: '看 @src/a.ts',
        refs: [fileRefOf(stage, 'src/a.ts', 2)],
        ref: 'd',
      })
      shell.dispose()

      expect(unreadOf(shell.events)).toEqual(['@src/a.ts'])
    } finally {
      stage.dispose()
    }
  })

  test('读了一个目录**里面**的文件 ⇒ 那一份目录引用算读过', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, 'src/a.ts', '甲的正文')
      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'read', args: { path: 'src/a.ts' } }] }, { text: '看了' }],
      })
      const shell = attachShell(assembly.shell)

      await sendAndWait(shell, {
        text: '看 @src/',
        refs: [{ kind: 'dir', at: 2, marker: '@src/', source: realpathSync(join(stage.workspace, 'src')) }],
        ref: 'd',
      })
      shell.dispose()

      expect(unreadOf(shell.events)).toEqual([])
    } finally {
      stage.dispose()
    }
  })

  test('读**失败**的那一趟不算读过（`ok:false` 不记）', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, 'a.txt', '甲的正文')
      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'read', args: { path: 'a.txt' } }] }, { text: '没读到' }],
      })
      const shell = attachShell(assembly.shell)

      await sendAndWait(shell, { text: '看 @a.txt', refs: [fileRefOf(stage, 'a.txt', 2)], ref: 'd' })
      shell.dispose()

      // 这一趟读成了（真文件在），故不报；下面另起一条真的读不成的情形
      expect(unreadOf(shell.events)).toEqual([])

      // 换成读一个**不在的**路径：那一趟 `ok:false`，不算读过
      const stage2 = makeStage()
      try {
        put(stage2.workspace, 'a.txt', '甲的正文')
        const assembly2 = stage2.assemble({
          turns: [{ toolCalls: [{ name: 'read', args: { path: '没有这个文件.txt' } }] }, { text: '没读到' }],
        })
        const shell2 = attachShell(assembly2.shell)
        await sendAndWait(shell2, { text: '看 @a.txt', refs: [fileRefOf(stage2, 'a.txt', 2)], ref: 'd' })
        shell2.dispose()

        expect(unreadOf(shell2.events)).toEqual(['@a.txt'])
      } finally {
        stage2.dispose()
      }
    } finally {
      stage.dispose()
    }
  })

  test('技能：显式引用**不再随请求展开**；模型读了才回「本次使用技能」', async () => {
    const stage = makeStage()
    try {
      put(
        stage.workspace,
        '.magic/skills/review/SKILL.md',
        '---\nname: review\ndescription: 检查改动\n---\n\n逐条核对清单。',
      )
      const review = realpathSync(join(stage.workspace, '.magic/skills/review'))

      // ① 模型**不读**：正文不进请求，回执一条都不发，收束时说「没读」
      const quiet = stage.assemble({ turns: [{ text: '好' }] })
      const shellA = attachShell(quiet.shell)
      await sendAndWait(shellA, {
        text: '按 /review 看看',
        refs: [{ kind: 'skill', at: 2, marker: '/review', name: 'review', source: review }],
        ref: 'd1',
      })
      shellA.dispose()

      expect(userText(stage, 0)).not.toContain('逐条核对清单。')
      expect(shellA.events.filter((event) => event.kind === 'skill.used')).toEqual([])
      expect(unreadOf(shellA.events)).toEqual(['/review'])

      // ② 模型**读了**（真走 `skill` 工具）：下一趟请求里才有正文，回执照说
      const loud = stage.assemble({
        turns: [{ toolCalls: [{ name: 'skill', args: { name: 'review' } }] }, { text: '照它做' }],
      })
      const shellB = attachShell(loud.shell)
      await sendAndWait(shellB, {
        text: '按 /review 看看',
        refs: [{ kind: 'skill', at: 2, marker: '/review', name: 'review', source: review }],
        ref: 'd2',
      })
      shellB.dispose()

      // 正文落在**工具那一趟**（模型自己取回来的那份）
      const messages = lastModel(stage).requests[1]?.messages ?? []
      const toolText = messages
        .filter((message) => message.role === 'tool')
        .map((message) => ('output' in message ? message.output : ''))
        .join('\n')
      expect(toolText).toContain('逐条核对清单。')

      const used = shellB.events.filter((event) => event.kind === 'skill.used')
      expect(used).toHaveLength(1)
      expect(used[0]?.kind === 'skill.used' && used[0].data.skills.map((one) => one.name)).toEqual(['review'])
      // 读了就不报「没读」
      expect(unreadOf(shellB.events)).toEqual([])
    } finally {
      stage.dispose()
    }
  })
})
