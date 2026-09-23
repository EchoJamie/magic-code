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
    readonly text: string
    readonly truncated?: true
    readonly omitted?: number
    readonly external?: true
  }[]
} {
  return JSON.parse(row.payload ?? '{}') as never
}

// ══ 工单的示例场景 ════════════════════════════════════════════════════

describe('U36 · 「先读 @需求.md，再按 /review 检查 @src/login.ts」', () => {
  test('从真实输入到模型请求：三处引用按原句次序、材料各就各位', async () => {
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

      // —— 模型请求：那句原话连同三份材料，**次序与位置都在** ——
      const said = userText(stage, 0)
      // 正文一个字不剥——那一句原话的三个片段都还在（材料插在每一处引用**之后**，
      // 故整句不再连续：这是「就地展开」的代价，也正是它的意思）
      expect(said).toContain('先读 @需求.md')
      expect(said).toContain('，再按 /review')
      expect(said).toContain(' 检查 @src/login.ts')
      expect(said).toContain('要求：先看登录逻辑。')
      expect(said).toContain('逐条核对清单。')
      expect(said).toContain('export const login = () => 1')

      const needAt = said.indexOf('要求：先看登录逻辑。')
      const skillAt = said.indexOf('逐条核对清单。')
      const loginAt = said.indexOf('export const login = () => 1')
      expect(needAt).toBeLessThan(skillAt) // 需求 → 技能 → 登录（与句子同序）
      expect(skillAt).toBeLessThan(loginAt)
      // 每一份材料紧跟在它那一处引用**之后**（不是堆在最前面）
      expect(needAt).toBeGreaterThan(said.indexOf('@需求.md'))
      expect(skillAt).toBeGreaterThan(said.indexOf('/review'))
      expect(loginAt).toBeGreaterThan(said.indexOf('@src/login.ts'))

      // —— 真记录：位置 / 身份 / 实际交付内容三样都在 ——
      const rows = userRows(assembly)
      expect(rows).toHaveLength(1)
      const payload = payloadOf(rows[0] as { payload: string | null })
      expect(payload.refs?.map((ref) => [ref.kind, ref.at, ref.marker])).toEqual([
        ['file', 3, '@需求.md'],
        ['skill', 13, '/review'],
        ['file', 26, '@src/login.ts'],
      ])
      expect(payload.refs?.[0]?.text).toBe('要求：先看登录逻辑。')
      expect(payload.refs?.[1]?.source).toBe(review)
      expect(payload.refs?.[2]?.source).toBe(login)
      // **没有技能时一字不多**的旧形也不在了：这一条只写 `refs`
      expect(rows[0]?.payload).not.toContain('"skills"')
    } finally {
      stage.dispose()
    }
  })

  test('提交后改动 / 删掉源文件，重开会话：**已入会话的那一份仍取回**（历史不被改写）', async () => {
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
      first.close()

      // 源文件改了（换成第二版）
      put(stage.workspace, '需求.md', '第二版：改看注册。')

      // 重开（同一块沙地、同一个库）——历史那一条里的那一份**照旧**，新调用取的是新的那一版
      const second = stage.assemble({ turns: [{ text: '好' }] })
      const shell2 = attachShell(second.shell)
      put(stage.workspace, 'b.txt', '乙')

      await sendAndWait(shell2, {
        text: '再看 @需求.md 与 @b.txt',
        refs: [
          { kind: 'file', at: 3, marker: '@需求.md', source: join(stage.workspace, '需求.md') },
          { kind: 'file', at: 13, marker: '@b.txt', source: realpathSync(join(stage.workspace, 'b.txt')) },
        ],
        ref: 'draft-2',
      })
      shell2.dispose()

      // 新调用取的是**新的那一版**（材料动态读取：文件改了，下一趟读到的就是新的）
      expect(userText(stage, 0)).toContain('第二版：改看注册。')

      // 再把源文件**删掉**——已入会话的那两份快照仍取回（记录里存的是**当时那一份**，
      // 不依赖源文件还在）
      rmSync(join(stage.workspace, '需求.md'))

      // 历史那一条**没被改写**（记录 append-only）：当时送出去的那一份还在载荷里
      const rows = userRows(second)
      expect(payloadOf(rows[0] as { payload: string | null }).refs?.[0]?.text).toBe('第一版：先看登录。')
      expect(payloadOf(rows[1] as { payload: string | null }).refs?.[0]?.text).toBe('第二版：改看注册。')
      second.close()
    } finally {
      stage.dispose()
    }
  })
})

// ══ 边界（都有确定结果）════════════════════════════════════════════════

describe('U36 · 边界：目录 / 超限 / 二进制 / 工作区外', () => {
  test('目录：给的是**有界清单**（一层），未展开的部分如实报数', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, 'src/a.ts', 'a')
      put(stage.workspace, 'src/sub/b.ts', 'b')
      for (let at = 0; at < 205; at += 1) put(stage.workspace, `src/many/m${at}.txt`, 'x')

      const assembly = stage.assemble({ turns: [{ text: '好' }] })
      const shell = attachShell(assembly.shell)

      await sendAndWait(shell, {
        text: '看看 @src/',
        refs: [
          { kind: 'dir', at: 3, marker: '@src/', source: realpathSync(join(stage.workspace, 'src')) },
        ],
        ref: 'draft-1',
      })
      shell.dispose()

      const said = userText(stage, 0)
      expect(said).toContain('a.ts')
      expect(said).toContain('sub/')
      expect(said).not.toContain('sub/b.ts') // 不递归塞进整个项目

      const rows = userRows(assembly)
      const ref = payloadOf(rows[0] as { payload: string | null }).refs?.[0]
      expect(ref?.kind).toBe('dir')
      expect(ref?.omitted).toBeUndefined() // 一层目录里的条数不多：没有未列出的
    } finally {
      stage.dispose()
    }
  })

  test('目录超限：列到上限为止，**未列出的部分在模型面前说得出**（不静默缺材料）', async () => {
    const stage = makeStage()
    try {
      for (let at = 0; at < 205; at += 1) put(stage.workspace, `many/m${String(at).padStart(3, '0')}.txt`, 'x')

      const assembly = stage.assemble({ turns: [{ text: '好' }] })
      const shell = attachShell(assembly.shell)

      await sendAndWait(shell, {
        text: '看看 @many/',
        refs: [{ kind: 'dir', at: 3, marker: '@many/', source: realpathSync(join(stage.workspace, 'many')) }],
        ref: 'draft-1',
      })
      shell.dispose()

      // 材料到上限为止（200 项），**抬头里说清还有 5 项没列**——模型据此知道手里不是全份
      const said = userText(stage, 0)
      expect(said).toContain('只列了这一层，另有 5 项未列')
      expect(said.split('\n').filter((line) => line.startsWith('m')).length).toBe(200)

      const rows = userRows(assembly)
      expect(payloadOf(rows[0] as { payload: string | null }).refs?.[0]?.omitted).toBe(5)
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

  test('`↑` 召回带引用的那一句 → 编辑 → 再提交：请求里是**当时**的文件内容，记录两笔都在', async () => {
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
      expect(first).toContain('第一版')
      expect(first).toContain('逐条核对清单。')
      expect(first).toContain('先读 @a.txt')

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

      // ① 实际模型输入：**重新提交时才读** ⇒ 读到的是第二版（不是召回那一刻、更不是当初那一份）
      const second = lastUserText(stage, 1)
      expect(second).toContain('第二版')
      expect(second).not.toContain('第一版') // 这一次读到的是当时那一份，不是召回那一刻、更不是当初那一份
      expect(second).toContain('再看一遍')
      expect(second).toContain('逐条核对清单。') // 技能那处身份也随召回一起回来了

      // ② 记录：两笔各自留着当时那一份（历史不被改写），位置自证
      const rows = userRows(assembly)
      const [one, two] = rows.map((row) => payloadOf(row as { payload: string | null }))
      expect(one?.refs?.map((ref) => [ref.kind, ref.at, ref.marker, ref.text])).toEqual([
        ['file', 3, '@a.txt', '第一版'],
        ['skill', 13, '/review', '逐条核对清单。'],
      ])
      expect(two?.refs?.map((ref) => [ref.kind, ref.at, ref.marker, ref.text])).toEqual([
        ['file', 3, '@a.txt', '第二版'],
        ['skill', 13, '/review', '逐条核对清单。'],
      ])
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
      expect(refs.map((ref) => ref?.text)).toEqual(['甲的材料', '乙的材料'])
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
