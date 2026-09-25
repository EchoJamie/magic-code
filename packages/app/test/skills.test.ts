/**
 * U33 · 技能 —— **真装配的端到端**（第一轮：内核与真实应用闭环）。
 *
 * 判据落在四样真东西上（不是解析器的自证，也不是手工复写一条接线）：
 * - **真模型请求**——`lastModel(stage).requests[i].messages` 就是送去模型的那一份；
 * - **真控制入口**——结构化输入经 `shell.send({type:'input.submit', …})` 进内核（现有那条路）；
 * - **真记录**——直读库表（`readDatabase`），不看内存里的副本；
 * - **真工具通路**——模型自主选用走真的 `skill` 工具（真注册表 · 真闸门 · 真回填）。
 *
 * 沙地三块（数据目录 / 工作区 / 家目录）都由 `makeStage` 落在唯一临时目录里——
 * **家目录也在沙地里**（用户那一类技能来源在 `<home>/.magic/skills`，不沙地化就会去扫
 * 这台机器上真的那两个目录）。不碰任何真东西。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventStamper, KernelEvent, ModelGateway, ModelMessage, SkillRef } from '@magic/contracts'
import { createModelGateway } from '@magic/model'
// 机械分析面（`@magic/permission` 出口 ③）——**供外壳预览与测试直取**（见其头注）。
// U76 起判轻的不再过闸、也**不发请求事件**，故「这一格判轻」这件事只剩它答得出（见用例里的注）。
import { analyze } from '@magic/permission'
import { attachShell, runShellScript } from '../src/index.ts'
import type { ShellHandle } from '@magic/app'
import { eventsOfKind, lastModel, makeStage, readDatabase, type Stage } from './support.ts'
import { removeDir, tempDir, validConfig, writeConfig } from './tmp.ts'

/** CLI 入口——`--check` 那一屏的字由它产出（与 `rules.test.ts` 同一个取法）。 */
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

/**
 * 等「回到等待输入」攒够几次——无人值守里最省事的收场判据。
 *
 * 数的是**次数**（不是「有没有」）：忙时排队那几条用例要等的是**第 n 次**收场，
 * 只等一次会在第一条跑完时就放行，后面那几条还没出队。
 */
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

/** 递一条结构化交代并等它跑完（外壳侧不用 `submit`——那里只发纯文本）。 */
function sendAndWait(
  shell: ShellHandle,
  input: { readonly text: string; readonly skills?: readonly SkillRef[]; readonly ref?: string },
): Promise<void> {
  const before = shell.events.filter(
    (event: KernelEvent) => event.kind === 'agent.state' && event.data.state === 'waiting',
  ).length
  shell.send({ type: 'input.submit', ...input })
  return waitIdle(shell, before + 1)
}

/**
 * 等**一队**交代都排完——判据是「跑够 `turns` 轮」且「回到了等待输入」。
 *
 * 为什么要两件一起等：`agent.state{waiting}` 是**按队**发的（一次 drain 收尾发一条），
 * 忙时排队那几条用例里它是「整队结束」的信号；而它单看分不出「队里跑了几轮」。
 * 反过来只看轮数，会在最后一条收尾之前提前放行。两个一起等才是那一刻。
 */
function waitDrain(shell: ShellHandle, turns: number): Promise<void> {
  return new Promise((settle) => {
    const watch = setInterval(() => {
      const ended = shell.events.filter((event) => event.kind === 'turn.end').length
      const idle = shell.events.some(
        (event) => event.kind === 'agent.state' && event.data.state === 'waiting',
      )
      if (ended < turns || !idle) return
      clearInterval(watch)
      settle()
    }, 5)
  })
}

/** 在沙地里写一个文件（中间目录自动建）。 */
function put(where: string, relative: string, text: string): string {
  const path = join(where, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

/** 一份讲道理的 `SKILL.md`。 */
function skillText(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

/**
 * 工作区里那个技能目录——**绑定草稿时给的那一串**（不取真身）。
 *
 * 刻意用别名写法（`/var/folders/…` 而不是它的真身 `/private/var/folders/…`）：
 * 外壳与用户手上拿到的就是这一类路径，归位那一步得自己取真身——
 * 这条路上两把尺子不同的话，一处真在眼前的技能会被报成「不在任何来源底下」。
 */
function projectSkill(stage: Stage, name: string): string {
  return join(stage.workspace, '.magic', 'skills', name)
}

/** 同一处的**真路径**——记录里存的那一串（身份取真身，见 `Skill.path`）。 */
function realSkill(stage: Stage, name: string): string {
  return realpathSync(projectSkill(stage, name))
}

/**
 * 第 n 次模型请求的全部消息拼起来——「送到模型手上了吗」看它。
 *
 * 三种角色各取各的正文：`tool` 的是 `output`（**工具回填**），`assistant` 的还要带上
 * 它请求的调用（那才是「模型说了要干什么」）。只取 `content` 会把回填整段丢掉——
 * 「工具读回来的东西进没进上下文」这条判据当场变成永远为真。
 */
/**
 * 一条用户消息的正文（U37 起可能是**部件串**——带图那条）——只取文字那几件。
 *
 * 与 `requestText` 分开：那个取的是**整份请求的拼接文本**，这里要的是某一条消息本身。
 */
function textOfUser(message: ModelMessage | undefined): string {
  if (message === undefined || !('content' in message)) return ''
  const content = message.content

  return typeof content === 'string'
    ? content
    : content.map((part) => (part.type === 'text' ? part.text : '〔图片〕')).join('')
}

function requestText(stage: Stage, index: number): string {
  return (lastModel(stage).requests[index]?.messages ?? [])
    .map((message) => {
      if (message.role === 'tool') return message.output
      if (message.role === 'assistant') {
        const calls = (message.toolCalls ?? []).map((call) => `${call.name} ${JSON.stringify(call.args)}`)
        return [message.content, ...calls].join('\n')
      }
      return message.content
    })
    .join('\n')
}

/** 库里的 `user` 条目（直读——不经读 API）。 */
function userRows(assembly: { paths: { database: string } }) {
  const raw = readDatabase(assembly.paths.database)
  const rows = raw.entries.filter((row) => row.kind === 'user')
  raw.close()
  return rows
}

describe('U33 · 开局只发现元数据', () => {
  test('系统提示词里有名称与描述，**正文一个字都没有**；一条模型请求都没因此发生', async () => {
    const stage = makeStage()
    try {
      put(
        stage.workspace,
        '.magic/skills/pdf/SKILL.md',
        skillText('pdf', '处理 PDF：抽文本、填表、合并。用户提到 PDF 时用。', '正文：第一步先看一眼页数。'),
      )

      const assembly = stage.assemble({ turns: [{ text: '你好' }] })
      const shell = attachShell(assembly.shell)
      await shell.submit('你好')
      shell.dispose()

      const first = lastModel(stage).requests[0]
      const system = first?.messages[0]
      const prompt = system?.role === 'system' ? system.content : ''

      // 目录在：名字与描述都送出去了（模型据它自主选用）
      expect(prompt).toContain('## 可用技能')
      expect(prompt).toContain('`pdf`')
      expect(prompt).toContain('处理 PDF：抽文本、填表、合并')
      // 正文不在——**未选中的一份不进上下文**（判据的第一条）
      expect(prompt).not.toContain('第一步先看一眼页数')
      expect(requestText(stage, 0)).not.toContain('第一步先看一眼页数')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('一个技能都没有——**不出现技能块**（没有可说的就不说，不给一个空块）', async () => {
    const stage = makeStage()
    try {
      const assembly = stage.assemble({ turns: [{ text: '你好' }] })
      const shell = attachShell(assembly.shell)
      await shell.submit('你好')
      shell.dispose()

      const system = lastModel(stage).requests[0]?.messages[0]
      const prompt = system?.role === 'system' ? system.content : ''
      expect(prompt).not.toContain('## 可用技能')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

/**
 * 问一次「都发现了哪些技能」，拿答复。
 *
 * **先架等、后发命令**——控制面是同步的：命令一进去，答复当步就回来了，
 * 事后再 `until` 只会等一个不会重来的事件（同 `readouts.test.ts` 的 `askCatalog`）。
 */
async function askSkills(handle: ShellHandle): Promise<Extract<KernelEvent, { kind: 'skills.catalog' }>> {
  const armed = handle.until((event) => event.kind === 'skills.catalog')
  handle.send({ type: 'skills.list' })

  const event = await armed
  if (event.kind !== 'skills.catalog') throw new Error(`等来的不是技能目录：${event.kind}`)

  return event
}

describe('U33 · 技能目录的读侧（终端入口那一半的取材）', () => {
  test('`skills.list` → 名称 · 简述 · 身份 · 来源标签；**正文一个字都不带**', async () => {
    const stage = makeStage()

    try {
      put(
        stage.workspace,
        '.magic/skills/pdf/SKILL.md',
        skillText('pdf', '处理 PDF：抽文本、填表、合并。', '正文：第一步先看一眼页数。'),
      )

      const assembly = stage.assemble({ turns: [{ text: '你好' }] })
      const handle = attachShell(assembly.shell)

      const catalog = await askSkills(handle)

      expect(catalog.data.skills).toEqual([
        {
          name: 'pdf',
          description: '处理 PDF：抽文本、填表、合并。',
          // 身份＝**技能目录的真路径**（同名两份靠它分开、失效与否也按它判）
          path: realpathSync(join(stage.workspace, '.magic/skills/pdf')),
          label: '项目 .magic/skills',
          source: 'project',
          origin: 'magic',
        },
      ])
      expect(catalog.data.problems).toEqual([])
      // **不搬正文**——外壳列个候选不该把仓库里所有技能的主文读一遍
      expect(JSON.stringify(catalog.data)).not.toContain('第一步先看一眼页数')

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**每次现扫**：摆一份新的再问一次，答复跟着变（不是开屏那份快照）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({ turns: [{ text: '你好' }] })
      const handle = attachShell(assembly.shell)

      expect((await askSkills(handle)).data.skills).toEqual([])

      // 会话起来**之后**才摆——发现面现扫，故下一问就认
      put(stage.workspace, '.magic/skills/late/SKILL.md', skillText('late', '后来才有的', '正文。'))

      expect((await askSkills(handle)).data.skills.map((row) => row.name)).toEqual(['late'])

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**没读进来的那些**连缘由一起交回（静默丢弃会让人对着一个不生效的技能发呆）', async () => {
    const stage = makeStage()

    try {
      put(stage.workspace, '.magic/skills/broken/SKILL.md', '---\nname: broken\n---\n\n没有 description\n')

      const assembly = stage.assemble({ turns: [{ text: '你好' }] })
      const handle = attachShell(assembly.shell)
      const catalog = await askSkills(handle)

      expect(catalog.data.skills).toEqual([])
      expect(catalog.data.problems).toHaveLength(1)
      expect(catalog.data.problems[0]?.kind).toBe('error')
      expect(catalog.data.problems[0]?.message).toContain('description')

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  /**
   * **同档同名只留一条**（U58 · 2026-09-25 用户定）：同一个来源目录里两份，
   * 留**目录名字典序第一个**那一份，另一份**在发现结果里就不存在**。
   *
   * 这一条的旧判据是「两行的来源不同」（U33 独立验收退回①：那时同名并存、两行逐字相同，
   * 用户没有依据挑一份）。同名不再并存 ⇒ 改成咬「只留一条、留对了那一条」。
   * 名字取自 front-matter、不取目录名，故「同一处两份同名」是真能出现的。
   */
  test('**同档同名的两份**：读侧只交回来一条（字典序第一个那一份）', async () => {
    const stage = makeStage()

    try {
      put(stage.workspace, '.magic/skills/second/SKILL.md', skillText('twins', '独立验证技能', '第二份正文。'))
      put(stage.workspace, '.magic/skills/first/SKILL.md', skillText('twins', '独立验证技能', '第一份正文。'))

      const assembly = stage.assemble({ turns: [{ text: '你好' }] })
      const handle = attachShell(assembly.shell)
      const catalog = await askSkills(handle)

      expect(catalog.data.skills.map((row) => `${row.name}（${row.label}）`)).toEqual([
        'twins（项目 .magic/skills/first）',
      ])
      // 留下的那一份身份就是它自己的目录——按它读得到，按没留下的那一份读不到
      expect(catalog.data.skills.map((row) => row.path)).toEqual([
        realpathSync(join(stage.workspace, '.magic/skills/first')),
      ])
      // 正文仍不带（目录只搬元数据）
      expect(JSON.stringify(catalog.data)).not.toContain('第一份正文')

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**空手打开也照答**（还没有会话时，外壳照样问得出来）', async () => {
    const stage = makeStage()

    try {
      put(stage.workspace, '.magic/skills/pdf/SKILL.md', skillText('pdf', '处理 PDF', '正文。'))

      const assembly = stage.assemble({ turns: [{ text: '你好' }] })
      const handle = attachShell(assembly.shell)

      // 一条交代都还没发过——信封必带会话，故这一问顺带开一张空壳（同 `model.list`）
      expect((await askSkills(handle)).data.skills.map((row) => row.name)).toEqual(['pdf'])

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**跨档同名**只留一条，且是**项目那一份**（项目级 ＞ 用户级）', async () => {
    const stage = makeStage()

    try {
      put(stage.workspace, '.magic/skills/pdf/SKILL.md', skillText('pdf', '项目那一份', '正文。'))
      // `makeStage` 把家目录也落在沙地里（见 `support.ts` 那条注）——用户那一类来源就在它下面
      put(stage.root, '.magic/skills/pdf/SKILL.md', skillText('pdf', '用户那一份', '正文。'))

      const assembly = stage.assemble({ turns: [{ text: '你好' }] })
      const handle = attachShell(assembly.shell)
      const catalog = await askSkills(handle)

      expect(catalog.data.skills.map((row) => `${row.name}@${row.label}`)).toEqual([
        'pdf@项目 .magic/skills',
      ])
      expect(catalog.data.skills[0]?.description).toBe('项目那一份')

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U33 · 显式选定：随交代一并送达', () => {
  test('绑定的技能主文进**这条**用户消息；落账带来源与正文；回执在主文进了上下文之后', async () => {
    const stage = makeStage()
    try {
      const path = projectSkill(stage, 'pdf')
      put(
        stage.workspace,
        '.magic/skills/pdf/SKILL.md',
        skillText('pdf', '处理 PDF 的专项做法', '正文：先数页数，再抽文本。'),
      )
      put(stage.workspace, '.magic/skills/other/SKILL.md', skillText('other', '别的技能', '正文：别的做法。'))

      const assembly = stage.assemble({ turns: [{ text: '照它做' }] })
      const shell = attachShell(assembly.shell)

      const skills: readonly SkillRef[] = [{ name: 'pdf', path }]
      await sendAndWait(shell, { text: '照它做', skills, ref: 'draft-1' })
      shell.dispose()

      // —— 真模型请求：正文进了**用户消息**（不是系统提示词），另一份正文一个字没有 ——
      const messages = lastModel(stage).requests[0]?.messages ?? []
      const user = messages.filter((message) => message.role === 'user')
      expect(user).toHaveLength(1)
      const said = textOfUser(user[0])
      expect(said).toContain('〔本次使用技能：pdf（来源 项目 .magic/skills）〕')
      expect(said).toContain('先数页数，再抽文本')
      // 交代本身在材料之后——「先把这份技能摆上，再是这个任务」
      expect(said.indexOf('先数页数')).toBeLessThan(said.indexOf('照它做'))
      expect(requestText(stage, 0)).not.toContain('别的做法')

      // —— 真事件：回执 ＋ 收下（配对键原样带回） ——
      const used = eventsOfKind(shell.events, 'skill.used')
      expect(used).toHaveLength(1)
      expect(used[0]?.data.skills.map((one) => one.name)).toEqual(['pdf'])
      expect(used[0]?.data.skills[0]?.label).toBe('项目 .magic/skills')
      const settled = eventsOfKind(shell.events, 'input.settled')
      expect(settled).toHaveLength(1)
      expect(settled[0]?.data).toMatchObject({ ref: 'draft-1', ok: true })

      // 回执在**这一次请求真发出去之后**（第一条模型事件到手）：判据不是「装好了」，
      // 是「发出去了」——同步抛错 / 未发就中止的那些一条事件都不会来，回执因此不假报
      const kinds = shell.events.map((event) => event.kind)
      expect(kinds.indexOf('model.call.start')).toBeLessThan(kinds.indexOf('skill.used'))

      // —— 真记录：正文与身份都在条目载荷里（重放依据） ——
      const rows = userRows(assembly)
      expect(rows).toHaveLength(1)
      const payload = JSON.parse(rows[0]?.payload ?? '{}')
      expect(payload.skills[0]).toMatchObject({ name: 'pdf', source: realSkill(stage, 'pdf'), label: '项目 .magic/skills' })
      expect(payload.skills[0].text).toContain('先数页数')
      // 正文装的是**用户的话**——技能材料没混进正文（屏上那一行仍是他说的话）
      expect(rows[0]?.content_text).toBe('照它做')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U33 · 模型自主选用：走真工具通路', () => {
  test('模型调 `skill` 取正文与引用——真工具 · 真回填，材料进上下文', async () => {
    const stage = makeStage()
    try {
      put(
        stage.workspace,
        '.magic/skills/pdf/SKILL.md',
        skillText('pdf', '处理 PDF 的专项做法', '正文：先数页数。引用见 references/guide.md。'),
      )
      put(stage.workspace, '.magic/skills/pdf/references/guide.md', '引用正文：抽文本用 pdftotext。')

      const assembly = stage.assemble({
        turns: [
          { toolCalls: [{ name: 'skill', args: { name: 'pdf' } }] },
          { toolCalls: [{ name: 'skill', args: { name: 'pdf', relative: 'references/guide.md' } }] },
          { text: '照它做完了' },
        ],
      })
      const shell = attachShell(assembly.shell)
      await shell.submit('处理这个 PDF')
      shell.dispose()

      // —— 真工具跑了两次，都 ok（闸门放行过） ——
      const results = eventsOfKind(shell.events, 'tool.result')
      expect(results.map((event) => event.data.ok)).toEqual([true, true])

      // —— 闸门那一侧：**判轻不问**（U76）——两次 `skill` 都走自动放行、不留卡 ——
      //
      // ⚠️ **原锚**：「闸门问过，但问的是**轻档**」——`asked` 两条都是 `weight: 'light'`，
      // 材料里含「只读材料」；**为何变**：U76 起判轻的**默认通**，链上**根本不发
      // `tool.decision.request`**，故那两条判据的落点（请求事件）不存在了；**新锚**：
      // ①「不问」是可观察的（`asked` 为空 ＋ 两条裁决都是 `auto`——它们照旧过了闸门）；
      // ②「为什么算轻」改由**机械分析面**直取（`analyze` 是 `@magic/permission` 的公开面，
      //    头注写明「供外壳预览与测试直取」）——判据仍是原话：分析表里没有 `skill` 这一格
      //    的话，兜底是 `heavy · unknown`（`unclassifiable`——**表外兜底照旧是重档**），
      //    而那一档**照旧必问**（U76 放宽的只有 `exec` 那一路）。
      const asked = eventsOfKind(shell.events, 'tool.decision.request')
      expect(asked).toEqual([])
      expect(
        eventsOfKind(shell.events, 'tool.decision').map((event) => event.data.decider),
      ).toEqual(['auto', 'auto'])

      const root = realpathSync(stage.workspace)
      const skillFace = analyze(
        // `id` 是**链引用**（`tool.call` 那一头铸的），机械分析不看它——这里给一个占位
        { id: 'call-skill', name: 'skill', args: { name: 'pdf' } },
        // `skill` 这一格不吃 `PermissionContext`（它没有影响面词条）——给一份真的根，
        // 免得将来那一格真用上路径判据时，这里悄悄测的是一份空语境。
        { roots: [root], declaredRoots: [root], defaultRoot: root },
      )
      // ⚠️ `Analysis` 是判别联合（U77）：先确认它不是"直接拒"那一形，才读得到 `weight`
      if (skillFace.refusal !== undefined) throw new Error('技能读取不该被拒')
      expect(skillFace.weight).toBe('light')
      expect(skillFace.material).toContain('只读材料')

      // —— 回填真进了下一次请求 ——
      expect(requestText(stage, 2)).toContain('先数页数')
      expect(requestText(stage, 2)).toContain('抽文本用 pdftotext')

      // —— 工具读回来的那一份**是工具结果**，不是「用户交代」——
      // 技能说明与工具数据保持不同来源身份：它落在 tool-result 条目上，
      // 而不是被塞进某条 user 条目（重放时两条路各自复原）
      const raw = readDatabase(assembly.paths.database)
      const tools = raw.entries.filter((row) => row.kind === 'tool-result')
      expect(tools).toHaveLength(2)
      expect(tools[0]?.content_text).toContain('先数页数')
      expect(raw.entries.filter((row) => row.kind === 'user' && row.payload !== null)).toHaveLength(0)
      raw.close()

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  /**
   * 模型那一头只给名字（`skill` 工具的 `source` 参数随同名一起收掉了）——
   * 同名不再并存，故名字本身就是完整的地址，取到的是**发现留下的那一份**（项目级赢）。
   */
  test('模型只给名字：取**发现留下的那一份**（同名不再并存，无需指明来源）', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, '.magic/skills/dup/SKILL.md', skillText('dup', '项目那一份', '项目正文。'))
      put(stage.root, '.magic/skills/dup/SKILL.md', skillText('dup', '用户那一份', '用户正文。'))

      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'skill', args: { name: 'dup' } }] }, { text: '好了' }],
      })
      const shell = attachShell(assembly.shell)
      await shell.submit('用那个技能')
      shell.dispose()

      expect(eventsOfKind(shell.events, 'tool.result')[0]?.data.ok).toBe(true)

      // 工具那一趟带走的是**项目那一份**的身份（随工具结果落账，不是从回填正文里抠的）
      const raw = readDatabase(assembly.paths.database)
      const results = raw.entries.filter((row) => row.kind === 'tool-result')
      expect(JSON.parse(results[0]?.payload ?? '{}').skill).toEqual({
        name: 'dup',
        source: realSkill(stage, 'dup'),
        label: '项目 .magic/skills',
      })
      raw.close()

      expect(requestText(stage, 1)).toContain('项目正文')
      expect(requestText(stage, 1)).not.toContain('用户正文')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U33 · 回执只报一次（返工）', () => {
  test('显式技能走**多个工具轮**：仍只有一条 `skill.used` 与一条同 `ref` 的收下', async () => {
    // 返工一条：首轮把 `once(owed)` 造在**每一轮的循环里**，于是每开一轮就多一个
    // 「尚未兑现」的新包装——一条普通的多轮工作会反复报「本次使用技能」。
    const stage = makeStage()
    try {
      const path = projectSkill(stage, 'test')
      put(stage.workspace, '.magic/skills/test/SKILL.md', skillText('test', '说明', '正文'))

      const assembly = stage.assemble({
        turns: [
          { toolCalls: [{ name: 'ls', args: {} }] },
          { toolCalls: [{ name: 'ls', args: {} }] },
          { text: '做完了' },
        ],
      })
      const shell = attachShell(assembly.shell)

      await sendAndWait(shell, { text: '照它做', skills: [{ name: 'test', path }], ref: 'one-ref' })
      shell.dispose()

      // 三轮工具往返（请求数不止一次）——回执仍各只有一条
      expect(lastModel(stage).requests.length).toBeGreaterThanOrEqual(3)
      expect(eventsOfKind(shell.events, 'skill.used')).toHaveLength(1)
      expect(eventsOfKind(shell.events, 'input.settled').map((event) => event.data)).toEqual([
        { ref: 'one-ref', ok: true },
      ])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('模型自主取主文：**进下一趟请求之后**报一次；再取引用不再报整项技能', async () => {
    // 返工一条：首轮自主路径**零回执**——两个工具结果都成功、材料都进了请求，
    // 用户却收不到「本次使用技能」那一条。
    const stage = makeStage()
    try {
      put(stage.workspace, '.magic/skills/pdf/SKILL.md', skillText('pdf', '处理 PDF', '正文：先数页数。'))
      put(stage.workspace, '.magic/skills/pdf/references/x.md', '引用正文。')

      const assembly = stage.assemble({
        turns: [
          { toolCalls: [{ name: 'skill', args: { name: 'pdf' } }] },
          { toolCalls: [{ name: 'skill', args: { name: 'pdf', relative: 'references/x.md' } }] },
          // 再取一次主文——同一项技能，依旧不报第二遍
          { toolCalls: [{ name: 'skill', args: { name: 'pdf' } }] },
          { text: '做完了' },
        ],
      })
      const shell = attachShell(assembly.shell)
      await shell.submit('处理这个 PDF')
      shell.dispose()

      const used = eventsOfKind(shell.events, 'skill.used')
      expect(used).toHaveLength(1)
      expect(used[0]?.data.skills).toEqual([
        { name: 'pdf', source: realSkill(stage, 'pdf'), label: '项目 .magic/skills' },
      ])

      // **在带着这份材料的那次请求真发出去之后**才报：材料是第 2 次请求才摆进去的
      // （工具结果第 1 轮才落账），故回执落在**第 2 次模型调用开始之后**
      const kinds = shell.events.map((event) => event.kind)
      const firstCallStart = kinds.indexOf('model.call.start')
      const secondCallStart = kinds.indexOf('model.call.start', firstCallStart + 1)
      expect(kinds.indexOf('skill.used')).toBeGreaterThan(secondCallStart)

      // 身份**随工具结果落账**（不是从回填正文里抠的）——重放读得到
      const raw = readDatabase(assembly.paths.database)
      const results = raw.entries.filter((row) => row.kind === 'tool-result')
      const payloads = results.map((row) => JSON.parse(row.payload ?? '{}'))
      expect(payloads[0]?.skill).toEqual({
        name: 'pdf',
        source: realSkill(stage, 'pdf'),
        label: '项目 .magic/skills',
      })
      // 取引用那一趟**不带**交付身份（「后续引用不重复报整项技能」是结构上成立的）
      expect(payloads[1]?.skill).toBeUndefined()
      raw.close()

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('自主取不到（工具回填失败）：**不报成功**', async () => {
    const stage = makeStage()
    try {
      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'skill', args: { name: 'nope' } }] }, { text: '算了' }],
      })
      const shell = attachShell(assembly.shell)
      await shell.submit('用那个技能')
      shell.dispose()

      expect(eventsOfKind(shell.events, 'tool.result')[0]?.data.ok).toBe(false)
      expect(eventsOfKind(shell.events, 'skill.used')).toEqual([])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U33 · 失效与排队', () => {
  test('来源失效——这一条**不跑**（不换同名项、不忽略技能），同一队里别的照跑', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, '.magic/skills/alpha/SKILL.md', skillText('alpha', '甲的说明', '甲的做法。'))
      // 「绑草稿时它还在、出队那一刻它没了」——那条失效的真实样子
      const doomed = put(
        stage.workspace,
        '.magic/skills/doomed/SKILL.md',
        skillText('doomed', '会失效的技能', '乙的正文。'),
      ).replace(/\/SKILL\.md$/, '')
      // 同名顶替者：**另一处**、也叫 `doomed`——「不静默换同名项」这条要咬住它
      put(stage.workspace, '.magic/skills/doomed-v2/SKILL.md', skillText('doomed', '顶替者', '顶替正文。'))

      // 「绑草稿那一刻它还在」——先取到那一串身份，再把来源拿走（草图已绑、来源已失效）
      rmSync(doomed, { recursive: true, force: true })

      // 三条一起递（忙时排队）：第一条在跑，第二条（坏的）与第三条排着
      const assembly = stage.assemble({ turns: [{ text: '甲做完了' }, { text: '第三件做完了' }] })
      const shell = attachShell(assembly.shell)

      shell.send({
        type: 'input.submit',
        text: '照 alpha 做',
        skills: [{ name: 'alpha', path: projectSkill(stage, 'alpha') }],
      })
      shell.send({
        type: 'input.submit',
        text: '照 doomed 做',
        skills: [{ name: 'doomed', path: doomed }],
        ref: 'draft-bad',
      })
      shell.send({ type: 'input.submit', text: '第三件' })

      await waitDrain(shell, 2)
      shell.dispose()

      // —— 失败是**说得出是谁**的一条，且配对键对得上那份草稿 ——
      const settled = eventsOfKind(shell.events, 'input.settled')
      const failed = settled.filter((event) => event.data.ok === false)
      expect(failed).toHaveLength(1)
      expect(failed[0]?.data.ref).toBe('draft-bad')
      expect(failed[0]?.data.reason).toContain('doomed')

      // —— 没送出去：模型请求里没有「照 doomed 做」，也没有顶替者的正文 ——
      const all = lastModel(stage)
        .requests.map((_request, index) => requestText(stage, index))
        .join('\n')
      expect(all).not.toContain('照 doomed 做')
      expect(all).not.toContain('顶替正文')
      expect(all).not.toContain('乙的正文')

      // —— 没落条目：`user` 条目只有两条（甲那条与第三件），没有 doomed 那条 ——
      const rows = userRows(assembly)
      expect(rows.map((row) => row.content_text)).toEqual(['照 alpha 做', '第三件'])

      // —— 同一队里别的照跑：第三条交代真的开了一轮（它的用户消息在请求里，
      //    它的回复在流里——`requestText` 只看请求，故回复那半截看条目那一行） ——
      expect(all).toContain('甲做完了')
      expect(all).toContain('第三件')
      expect(
        shell.events.filter((event) => event.kind === 'message.assistant').length,
      ).toBeGreaterThanOrEqual(2)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('忙时两条不同技能——出队后**各自身份不串**（各取各的正文）', async () => {
    const stage = makeStage()
    try {
      const alpha = projectSkill(stage, 'alpha')
      const beta = projectSkill(stage, 'beta')
      put(stage.workspace, '.magic/skills/alpha/SKILL.md', skillText('alpha', '甲的说明', '甲的做法：先甲后乙。'))
      put(stage.workspace, '.magic/skills/beta/SKILL.md', skillText('beta', '乙的说明', '乙的做法：先乙后甲。'))

      const assembly = stage.assemble({ turns: [{ text: '甲做完了' }, { text: '乙也做完了' }] })
      const shell = attachShell(assembly.shell)

      shell.send({ type: 'input.submit', text: '做甲', skills: [{ name: 'alpha', path: alpha }] })
      shell.send({ type: 'input.submit', text: '做乙', skills: [{ name: 'beta', path: beta }] })
      await waitDrain(shell, 2)
      shell.dispose()

      const requests = lastModel(stage).requests
      expect(requests.length).toBeGreaterThanOrEqual(2)

      // 第一条请求：只有甲的正文；第二条：甲的历史 ＋ 乙的正文（各带各的来源）
      const first = requestText(stage, 0)
      expect(first).toContain('甲的做法')
      expect(first).not.toContain('乙的做法')

      const second = requestText(stage, 1)
      expect(second).toContain('乙的做法')
      expect(second).toContain('〔本次使用技能：beta（来源 项目 .magic/skills）〕')
      expect(second).toContain('〔本次使用技能：alpha（来源 项目 .magic/skills）〕')

      // 两条回执各报各的（没有串成同一条）
      const used = eventsOfKind(shell.events, 'skill.used')
      expect(used.map((event) => event.data.skills.map((one) => one.name))).toEqual([['alpha'], ['beta']])

      // 记录里两条各自的载荷（身份与正文都随自己那条）
      const rows = userRows(assembly)
      const payloads = rows.map((row) => JSON.parse(row.payload ?? '{}'))
      expect(payloads[0].skills[0]).toMatchObject({ name: 'alpha', source: realSkill(stage, 'alpha') })
      expect(payloads[0].skills[0].text).toContain('甲的做法')
      expect(payloads[1].skills[0]).toMatchObject({ name: 'beta', source: realSkill(stage, 'beta') })
      expect(payloads[1].skills[0].text).toContain('乙的做法')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U33 · 停下时清掉的排队输入', () => {
  test('**逐条配对 `ok:false`**（没进会话），且那一条不留条目——U50 起那句改说「未执行」', async () => {
    // 由头（2026-09-21 规划裁）：`input.settled` 的契约是「给了 `ref` 必有终态」——
    // 停下的那一刻，排着的那些的去处是**明确失败**，不是「也许以后会跑」。
    //
    // ⚠️ **U50 改了那句理由**（判据没放宽，条数一字不动）：从前说「请重新发送」——
    // 那是把一份**留着的**交代说成了一次**丢失**（用户得重打一遍）。设计那一行写的是
    // 「保留并标为未执行」：终态照给，话改成「标着「未执行」留着（没有接着跑）」。
    const stage = makeStage()
    try {
      const path = projectSkill(stage, 'test')
      put(stage.workspace, '.magic/skills/test/SKILL.md', skillText('test', '说明', '正文'))

      const assembly = stage.assemble({ turns: [{ text: '第一件' }], stepDelayMs: 25 })
      const shell = attachShell(assembly.shell, { timeoutMs: 8000 })

      const begun = shell.until((event) => event.kind === 'model.call.start', 8000)
      const done = shell.submit('先跑这件', 8000)
      await begun

      // 忙时再递一条（带技能与配对键）——它排着，随即被停下清掉
      shell.send({
        type: 'input.submit',
        text: '排队那句',
        skills: [{ name: 'test', path }],
        ref: 'queued-ref',
      })
      shell.send({ type: 'turn.interrupt' })
      await done
      shell.dispose()

      // **没进会话的排队项：一条 `ok:false`**（不是「没有终态」）
      expect(eventsOfKind(shell.events, 'input.settled').map((event) => event.data)).toEqual([
        { ref: 'queued-ref', ok: false, reason: '停下了——这一条还没轮到，标着「未执行」留着（没有接着跑）' },
      ])
      // 它确实没进会话：库里没有它那条用户条目
      expect(userRows(assembly).map((row) => row.content_text)).toEqual(['先跑这件'])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U33 · 历史不被材料刷新重写', () => {
  test('改过源文件再重开会话：**当时那份正文仍可追溯**，新调用取到的是新的一版', async () => {
    const stage = makeStage()
    try {
      const path = projectSkill(stage, 'doc')
      put(stage.workspace, '.magic/skills/doc/SKILL.md', skillText('doc', '写文档的做法', '第一版：先写提纲。'))

      const assembly = stage.assemble({ turns: [{ text: '先写' }] })
      const shell = attachShell(assembly.shell)
      await sendAndWait(shell, { text: '先写', skills: [{ name: 'doc', path }] })
      shell.dispose()

      const firstPayload = JSON.parse(userRows(assembly)[0]?.payload ?? '{}')
      expect(firstPayload.skills[0].text).toContain('第一版：先写提纲')

      assembly.close()

      // 源文件改了（换成第二版），**再开一条装配**（＝重开会话）
      put(stage.workspace, '.magic/skills/doc/SKILL.md', skillText('doc', '写文档的做法', '第二版：先写结论。'))

      const reopened = stage.assemble({ turns: [{ text: '再写' }] })
      const shell2 = attachShell(reopened.shell)
      await sendAndWait(shell2, { text: '再写', skills: [{ name: 'doc', path }] })
      shell2.dispose()

      // 新调用取的是**新的一版**
      expect(requestText(stage, 0)).toContain('第二版：先写结论')

      // 历史那一份**没被改写**：旧条目里的正文还是第一版（记录是 append-only）
      // ——不记版本串（2026-09-21 用户已定），「当时用的是哪一份」由**正文本身**答
      const rows = userRows(reopened)
      const old = JSON.parse(rows[0]?.payload ?? '{}')
      expect(old.skills[0].text).toContain('第一版：先写提纲')
      expect(old.skills[0].text).not.toContain('第二版')
      const fresh = JSON.parse(rows[1]?.payload ?? '{}')
      expect(fresh.skills[0].text).toContain('第二版：先写结论')
      // 身份没变（同一项技能、同一份来源）——变的是内容，材料动态读取本就是如此
      expect(fresh.skills[0]).toMatchObject({ name: old.skills[0].name, source: old.skills[0].source })

      reopened.close()
    } finally {
      stage.dispose()
    }
  })

  test('恢复重建：技能材料随条目复原（不是重新去读当前文件冒充历史）', async () => {
    const stage = makeStage()
    try {
      const path = projectSkill(stage, 'doc')
      put(stage.workspace, '.magic/skills/doc/SKILL.md', skillText('doc', '说明', '当时的那一版。'))

      const assembly = stage.assemble({ turns: [{ text: '做吧' }] })
      const shell = attachShell(assembly.shell)
      await sendAndWait(shell, { text: '做吧', skills: [{ name: 'doc', path }] })
      shell.dispose()

      // 源文件改成另一版，**然后**走恢复那条路：`history.read` → 真重建
      put(stage.workspace, '.magic/skills/doc/SKILL.md', skillText('doc', '说明', '后来改的那一版。'))

      const shell2 = attachShell(assembly.shell)
      const entries = new Promise<readonly { payload?: unknown }[]>((settle) => {
        const watch = setInterval(() => {
          const history = shell2.events.filter((event) => event.kind === 'session.history')
          const done = history.some((event) => event.data.done)
          if (!done) return
          clearInterval(watch)
          settle(history.flatMap((event) => event.data.entries))
        }, 5)
      })
      shell2.send({ type: 'history.read' })
      const read = await entries
      shell2.dispose()

      // 重建读到的那一份仍是**当时**的正文（历史不被材料刷新改写）
      const userEntry = read.find((entry) => (entry as { kind?: string }).kind === 'user')
      const payload = userEntry?.payload as { skills?: { text: string }[] } | undefined
      expect(payload?.skills?.[0]?.text).toContain('当时的那一版')
      expect(JSON.stringify(payload)).not.toContain('后来改的那一版')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U33 · 边界不越', () => {
  test('技能里的 `allowed-tools` **不改审批**：脚本照旧走闸门', async () => {
    const stage = makeStage()
    try {
      // 一份「想给自己放权」的技能：上游规范里的 allowed-tools 写着能跑命令
      put(
        stage.workspace,
        '.magic/skills/risky/SKILL.md',
        '---\nname: risky\ndescription: 会让人以为能随便跑命令的技能\nallowed-tools: Bash(rm:*) Write\n---\n\n正文：跑 `rm -rf /tmp/x` 收拾干净。\n',
      )

      const target = join(stage.workspace, 'built.txt')
      const assembly = stage.assemble({
        turns: [
          // 模型读了技能，然后照它说的跑两条：一条**删除**（内核直接拒）、一条**改权限**（照问）
          { toolCalls: [{ name: 'skill', args: { name: 'risky' } }] },
          { toolCalls: [{ name: 'exec', args: { cmd: `rm -f ${target}` } }] },
          { toolCalls: [{ name: 'exec', args: { cmd: `chmod 600 ${target}` } }] },
          { text: '好' },
        ],
      })
      // 无人值守替人答复：**改权限那一条拒绝**——「allowed-tools 不改审批」的判据看它
      const shell = attachShell(assembly.shell, {
        decide: (request) => (request.name === 'exec' ? 'reject' : 'approve'),
      })
      await shell.submit('照 risky 做')
      shell.dispose()

      // 技能主文确实进了上下文（模型读得到那句「跑 rm -rf」）
      expect(requestText(stage, 1)).toContain('收拾干净')
      // 但技能里写着 `allowed-tools: Bash(rm:*)` **一点也不管用**：
      //
      // ⚠️ **U77 换的锚**：删除那一条**内核直接拒**（连卡都不出——技能怎么写都改不了它），
      // 而改权限那一条**照旧过闸**（落在**重**档）——两半一起看，才是「审批归内核」。
      const asked = eventsOfKind(shell.events, 'tool.decision.request')
      expect(asked.map((event) => event.data.name)).toEqual(['exec'])
      expect(asked.map((event) => event.data.weight)).toEqual(['heavy'])

      // 三发各有着落：读技能成了；删的那条**被拒没跑**；改权限那条**被替身拒了也没跑**
      const results = eventsOfKind(shell.events, 'tool.result')
      expect(results.map((event) => event.data.ok)).toEqual([true, false, false])
      expect(existsSync(target)).toBe(false)

      // 被拒的那一条，回执里说得出**该用什么**（U77：只拒不说，模型只会换着花样再试）
      const refused = (results[1]?.data.output as { text?: string } | undefined)?.text ?? ''
      expect(refused).toContain('trash')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('技能目录里的引用**越不出去**：`../` 与绝对路径都拒（回填说清为什么）', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, '.magic/skills/one/SKILL.md', skillText('one', '说明', '正文。'))
      put(stage.workspace, 'secret.md', '工作区里的秘密')

      const assembly = stage.assemble({
        turns: [
          { toolCalls: [{ name: 'skill', args: { name: 'one', relative: '../../secret.md' } }] },
          { text: '算了' },
        ],
      })
      const shell = attachShell(assembly.shell)
      await shell.submit('读引用的那份')
      shell.dispose()

      const results = eventsOfKind(shell.events, 'tool.result')
      expect(results[0]?.data.ok).toBe(false)
      // 秘密**没有**进任何一次请求
      const all = lastModel(stage)
        .requests.map((_request, index) => requestText(stage, index))
        .join('\n')
      expect(all).not.toContain('工作区里的秘密')
      expect(all).toContain('越出了技能目录')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('配置里点名的补充目录也发现得了（`skills.sources` 走真加载器）', async () => {
    // `skills.sources` 走**真加载器**（漏接＝静默失效，这条用例咬住它）
    const land = tempDir('magic-skills-cfg-')
    try {
      const extra = join(land, 'shared-skills')
      put(extra, 'shared/SKILL.md', skillText('shared', '共享盘上的做法', '共享正文。'))
      const stage = makeStage({ config: { skills: { sources: [extra] } } })

      const assembly = stage.assemble({ turns: [{ text: '你好' }] })
      const shell = attachShell(assembly.shell)
      await shell.submit('你好')
      shell.dispose()

      const system = lastModel(stage).requests[0]?.messages[0]
      const prompt = system?.role === 'system' ? system.content : ''
      expect(prompt).toContain('`shared`')
      expect(prompt).toContain('共享盘上的做法')
      // 正文仍不提前送
      expect(prompt).not.toContain('共享正文')

      assembly.close()
      stage.dispose()
    } finally {
      removeDir(land)
    }
  })
})

describe('U33 · 真 CLI 帧 · `--check` 那一行', () => {
  test('报「发现了哪些、有哪些没读进来」——坏的那一条**指明来源与缘由**', async () => {
    const home = tempDir('magic-cli-skills-')
    mkdirSync(join(home, '.magic'), { recursive: true })
    writeConfig(join(home, '.magic'), validConfig({ dataDir: join(home, 'data') }))

    try {
      put(home, '.magic/skills/pdf/SKILL.md', skillText('pdf', '处理 PDF', '正文'))
      put(home, '.magic/skills/broken/SKILL.md', '---\nname: broken\n---\n\n没有 description\n')

      const proc = Bun.spawn([process.execPath, CLI, '--check'], {
        cwd: home,
        env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])

      expect(exitCode).toBe(0)
      expect(stdout).toContain('技能　　　')
      // 发现到的照报（名字 ＋ 来源）
      expect(stdout).toContain('pdf（项目 .magic/skills）')
      // 坏的那一条**一条两行**（路径一行、缘由一行）——用户照着去改
      expect(stdout).toContain('有 1 个没读进来')
      expect(stdout).toContain('broken')
      expect(stdout).toContain('description')
    } finally {
      removeDir(home)
    }
  })

  test('一个技能都没有：说清「放哪儿就来」，不留白', async () => {
    const home = tempDir('magic-cli-skills-')
    mkdirSync(join(home, '.magic'), { recursive: true })
    writeConfig(join(home, '.magic'), validConfig({ dataDir: join(home, 'data') }))

    try {
      const proc = Bun.spawn([process.execPath, CLI, '--check'], {
        cwd: home,
        env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stdout = await new Response(proc.stdout).text()
      await proc.exited

      expect(stdout).toContain('技能　　　无（放 .magic/skills/<名称>/SKILL.md 就来')
    } finally {
      removeDir(home)
    }
  })
})

describe('U33 · `--script` 的结构化步骤', () => {
  test('`{ "input": { text, skills, ref } }` 经**真脚本入口**递进去（与裸字符串同一条路）', async () => {
    const stage = makeStage()
    try {
      const path = projectSkill(stage, 'pdf')
      put(stage.workspace, '.magic/skills/pdf/SKILL.md', skillText('pdf', '处理 PDF', '正文：先数页数。'))

      const assembly = stage.assemble({ turns: [{ text: '照它做完了' }] })
      const script = {
        inputs: [{ input: { text: '照它做', skills: [{ name: 'pdf', path }], ref: 'draft-1' } }],
      }

      const handle = await runShellScript(assembly.shell, script)

      // 真模型请求里：主文送达（材料在用户消息之前）
      expect(requestText(stage, 0)).toContain('先数页数')
      expect(requestText(stage, 0)).toContain('照它做')

      // 回执与收下都从这条入口出来了（加宽位一路通到底）
      const used = eventsOfKind(handle.events, 'skill.used')
      expect(used.map((event) => event.data.skills.map((one) => one.name))).toEqual([['pdf']])
      const settled = eventsOfKind(handle.events, 'input.settled')
      expect(settled.map((event) => event.data)).toEqual([{ ref: 'draft-1', ok: true }])

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U33 · 纯文本不退化', () => {
  test('不带技能的交代：条目**不带载荷**、模型请求里没有技能块、没有多余事件', async () => {
    const stage = makeStage()
    try {
      put(stage.workspace, '.magic/skills/pdf/SKILL.md', skillText('pdf', 'PDF 的做法', '正文。'))

      const assembly = stage.assemble({ turns: [{ text: '普通一句' }] })
      const shell = attachShell(assembly.shell)
      await shell.submit('普通一句')
      shell.dispose()

      // 载荷栏是空的（与加这一条之前逐字同形——旧库照读、旧用例照绿）
      const rows = userRows(assembly)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.payload).toBeNull()
      expect(rows[0]?.content_text).toBe('普通一句')

      // 没有技能，就没有使用回执；没给配对键，也没有收下回执（旧路径一字不动）
      expect(eventsOfKind(shell.events, 'skill.used')).toEqual([])
      expect(eventsOfKind(shell.events, 'input.settled')).toEqual([])
      // 目录块在（有技能就报给模型），但正文不在
      expect(requestText(stage, 0)).not.toContain('正文。')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('不带技能的**大段正文**照旧转 blob（旧行为一字不动）', async () => {
    const stage = makeStage()
    try {
      const long = '长'.repeat(9000)
      const assembly = stage.assemble({ turns: [{ text: '收到' }] })
      const shell = attachShell(assembly.shell)
      await shell.submit(long)
      shell.dispose()

      const rows = userRows(assembly)
      expect(rows[0]?.content_kind).toBe('blob')
      expect(readFileSync(assembly.paths.database).length).toBeGreaterThan(0)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

// ══ 回执的兑现判据 · **真实网关**反例（U33 · 复验补正）════════════════
//
// 由头（独立复验）：返工曾把「事件流的第一条」当成「请求已发」，而真实模型域的
// 第一条**恒为本地产的 `model.call.start`**（`normalize.ts` 先 yield 它、之后才迭代
// 供应商流；`retry.ts` 迭代才调 SDK 的 streamer——参数校验与 fetch 都在其后）。
// 于是三种情形会假报：SDK 参数校验失败（`fetchCalls=0`，请求压根没发）、
// `call.start` 之后被中止、本地抛错。
//
// 这一组**走真实 `createModelGateway` ＋ 真 SDK ＋ 注入 fetch**（无网络、无真密钥，
// 假 key 只用于构造）。判据是**每次事件发生时 `fetchCalls` 是几**——回执必须落在
// fetch 之后；而反例那三种，`skill.used` / `input.settled` 一条都不许有。

/** 一段真实的 SSE 响应体——`chunks` 逐块给 `choices`。 */
function sse(...chunks: readonly unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

/** 一块 chunk——`delta` ＋ `finish_reason`。 */
function chunk(delta: Readonly<Record<string, unknown>>, finish: string | null = null): unknown {
  return {
    id: 'chat-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

/**
 * 一支**真实网关**（真 SDK）＋ 注入 fetch 的装配——`fetchCalls` 与请求体留在闭包里。
 *
 * `respond` 决定这一次 fetch 回什么；`localError` 给一个 SDK 本地就拒的参数
 * （`maxCompletionTokens: -1`）。
 */
function realGateway(options: {
  /** 这一次 fetch 回什么——**按调用序**（第 n 次调用给第 n 段；工具往返要换段，否则转圈）。 */
  readonly respond?: (callIndex: number) => Response | Promise<Response>
  readonly localError?: boolean
}) {
  const state = { fetchCalls: 0, bodies: [] as string[] }

  const make = (stamper: EventStamper): ModelGateway =>
    createModelGateway({
      providerId: 'test',
      config: { baseURL: 'http://test.invalid/v1', model: 'test', apiKey: 'fake-test-key' },
      env: {},
      stamper,
      maxCompletionTokens: options.localError === true ? -1 : 8192,
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      fetch: async (_input, init) => {
        state.fetchCalls += 1
        state.bodies.push(String(init?.body))
        // 真实 fetch 的 AbortSignal 语义：**派发前**已中止＝拒绝，一个字节都不出去
        if (init?.signal?.aborted === true) throw new DOMException('aborted before dispatch', 'AbortError')
        return options.respond === undefined
          ? sse(chunk({ content: '好' }), chunk({}, 'stop'))
          : options.respond(state.fetchCalls)
      },
    })

  return { make, state }
}

describe('U33 · 回执只在**真回来**之后（真实网关）', () => {
  test('健康路径：回执落在 fetch **之后**，且真发出去的那份请求体里有材料', async () => {
    const stage = makeStage()
    try {
      const path = projectSkill(stage, 'test')
      put(stage.workspace, '.magic/skills/test/SKILL.md', skillText('test', '说明', 'ACTUAL_MATERIAL_MARKER'))

      const gateway = realGateway({})
      const assembly = stage.assemble({ modelGateway: gateway.make })
      const seen: { kind: string; fetchCalls: number }[] = []
      const shell = attachShell(assembly.shell, {
        onEvent: (event) => {
          if (['model.call.start', 'skill.used', 'input.settled', 'model.call.end'].includes(event.kind)) {
            seen.push({ kind: event.kind, fetchCalls: gateway.state.fetchCalls })
          }
        },
      })

      await sendAndWait(shell, { text: '照它做', skills: [{ name: 'test', path }], ref: 'real-ref' })
      shell.dispose()

      // 那一刻「有没有事件」不是凭据：`call.start` 发生在 fetch **之前**
      expect(seen.find((one) => one.kind === 'model.call.start')?.fetchCalls).toBe(0)
      // **「已使用」落在 fetch 之后**——它是「材料真送进了模型」那句判据
      expect(seen.find((one) => one.kind === 'skill.used')?.fetchCalls).toBeGreaterThanOrEqual(1)
      // 而「收下了」是**会话这一侧**的事实：落账那一刻就成立，与发没发出去无关
      expect(seen.find((one) => one.kind === 'input.settled')?.fetchCalls).toBe(0)
      // **材料确实在那份发出去的请求体里**
      expect(gateway.state.bodies.some((body) => body.includes('ACTUAL_MATERIAL_MARKER'))).toBe(true)
      expect(eventsOfKind(shell.events, 'skill.used')).toHaveLength(1)
      expect(eventsOfKind(shell.events, 'input.settled')).toHaveLength(1)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**SDK 本地参数错**（`fetchCalls=0`）：请求压根没发——一条成功回执都不许有', async () => {
    const stage = makeStage()
    try {
      const path = projectSkill(stage, 'test')
      put(stage.workspace, '.magic/skills/test/SKILL.md', skillText('test', '说明', 'ACTUAL_MATERIAL_MARKER'))

      const gateway = realGateway({ localError: true })
      const assembly = stage.assemble({ modelGateway: gateway.make })
      const shell = attachShell(assembly.shell)
      await sendAndWait(shell, { text: '照它做', skills: [{ name: 'test', path }], ref: 'local-ref' })
      shell.dispose()

      expect(gateway.state.fetchCalls).toBe(0)
      // 失败**照旧看得见**（模型域报错 ＋ 本轮以错误收束）——只是不冒称「已使用」
      expect(eventsOfKind(shell.events, 'model.error').length).toBeGreaterThanOrEqual(1)
      expect(eventsOfKind(shell.events, 'skill.used')).toEqual([])
      // **收下归收下**（输入确实进了会话）——模型那边的失败不撤销它，也不诱导用户重发
      expect(eventsOfKind(shell.events, 'input.settled').map((event) => event.data)).toEqual([
        { ref: 'local-ref', ok: true },
      ])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**收到 `call.start` 之后被停止**：材料没交给传输——同样不报成功', async () => {
    const stage = makeStage()
    try {
      const path = projectSkill(stage, 'test')
      put(stage.workspace, '.magic/skills/test/SKILL.md', skillText('test', '说明', 'ACTUAL_MATERIAL_MARKER'))

      // 材料交给 SDK **之前**停——注入 fetch 按真实 AbortSignal 语义在派发前拒绝
      const gateway = realGateway({ respond: () => sse(chunk({ content: '好' }), chunk({}, 'stop')) })
      const assembly = stage.assemble({ modelGateway: gateway.make })
      const shell = attachShell(assembly.shell, {
        onEvent: (event) => {
          if (event.kind === 'model.call.start') shell.send({ type: 'turn.interrupt' })
        },
      })
      await sendAndWait(shell, { text: '照它做', skills: [{ name: 'test', path }], ref: 'stop-ref' })
      shell.dispose()

      // 停在发出去之前：**没有「已使用」**（材料没到模型手上）
      expect(eventsOfKind(shell.events, 'skill.used')).toEqual([])
      // 但输入已被会话收下（落账过了）——这一条不该被模型那边的中止抹掉
      expect(eventsOfKind(shell.events, 'input.settled').map((event) => event.data)).toEqual([
        { ref: 'stop-ref', ok: true },
      ])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('**空成功响应**（没有正文）与**纯工具响应**：都要闭合', async () => {
    const stage = makeStage()
    try {
      const path = projectSkill(stage, 'test')
      put(stage.workspace, '.magic/skills/test/SKILL.md', skillText('test', '说明', 'M'))

      // ① 空成功：一个字都没有，只有收束那一段
      const empty = realGateway({ respond: () => sse(chunk({}, 'stop')) })
      const first = stage.assemble({ modelGateway: empty.make })
      const shell = attachShell(first.shell)
      await sendAndWait(shell, { text: '一句', skills: [{ name: 'test', path }], ref: 'empty-ref' })
      shell.dispose()
      expect(eventsOfKind(shell.events, 'skill.used')).toHaveLength(1)
      first.close()

      // ② 纯工具响应：正文一个字没有，只有一条工具调用（**只第一趟**——第二趟收束，
      //    否则模型一直要工具，往返没有尽头）
      const toolOnly = realGateway({
        respond: (nth) =>
          nth === 1
            ? sse(
                chunk({
                  tool_calls: [
                    { index: 0, id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{}' } },
                  ],
                }),
                chunk({}, 'tool_calls'),
              )
            : sse(chunk({ content: '看见了' }), chunk({}, 'stop')),
      })
      const second = stage.assemble({ modelGateway: toolOnly.make })
      const shell2 = attachShell(second.shell)
      await sendAndWait(shell2, { text: '两句', skills: [{ name: 'test', path }], ref: 'tool-ref' })
      shell2.dispose()
      expect(eventsOfKind(shell2.events, 'skill.used')).toHaveLength(1)
      expect(eventsOfKind(shell2.events, 'tool.result').length).toBeGreaterThanOrEqual(1)
      second.close()
    } finally {
      stage.dispose()
    }
  })
})
