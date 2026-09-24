/**
 * U33 · **终端入口的留帧装置**（第二轮）——真 PTY ＋ 本地模型夹具，落成可核对的帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。判据（选谁、送没送到、失败保没保住稿）
 * 有一部分在 `packages/tui/test/spec.u33-tui.test.ts`（纯按键 → 视图 ＋ 命令）；
 * 这里补的是**只有真终端才说得清的那几件**：
 * - 屏上**长什么样**（布局 · 文案 · 层级 · 通读——`AGENTS.md` 的看帧四项）；
 * - **提交前零模型请求**、**提交后请求里带的是哪一份主文**（夹具的请求表是物证）；
 * - **窄窗**下候选还成不成行；
 * - 应用与夹具**由监督者收干净**（`close()` 的 `exit.by`：它自己走的 / 我们杀的）。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析，不是拿视图对象算的）。模型那一头是
 * **loopback 夹具**（`127.0.0.1`，端口自动分配，合成假 key）——**一个付费请求都不发**，
 * 真 `~/.magic` 零触碰（沙地见 `ui/sandbox.ts`）。
 *
 * 技能目录**在会话起来之后**才摆进去——发现面本来就是**每次现扫**的（「动态读取」），
 * 这正好也把那一句考了：摆下去就认。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u33-tui.ts --out <目录>
 * ```
 *
 * 出的那十几屏：`01-技能列表`（项目/用户同名 · 原生/兼容 · 软链接 · 配置点名）·
 * `02-选定之后`（草稿那一行）· `03-提交之后`（回执）· `04-取消`（`esc` 不留痕迹）·
 * `05-清草稿`· `06-来源失效`（保稿）· `07-窄窗`·`08a-内置-model`·`08b-同名技能`·
 * `11-窄窗长名`·`12-选定之前`·`13-补全之后接着打`·**`14-恢复之后`**（`--session` 接续）·
 * `15-宽窗长名`。
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUiSession, createSandbox, startFixture } from './ui/index.ts'
import type { Capture, UiSession } from './ui/index.ts'
import { readDatabase } from './support.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/**
 * 摆一份技能文件（中间目录自动建）——返回**技能目录**（发现面认的是它，不是那份文件）。
 *
 * `as` ＝ front-matter 里那个名字（缺省＝目录名）。**名字不取目录名**（规范允许两者不一致，
 * 见 `execution/skills.ts` 文件头注）——独立验收退回① 那两份同名技能就是这么摆的：
 * `first/` 与 `second/` 都自称 `twins`。
 */
function putSkill(
  root: string,
  segment: '.magic' | '.agents',
  name: string,
  description: string,
  body: string,
  as = name,
): string {
  const dir = join(root, segment, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${as}\ndescription: ${description}\n---\n\n${body}\n`,
    'utf8',
  )

  return dir
}

/** 一份**读得出来的**技能正文——请求里要认得出它，故写短一点（夹具只留最后那条 user 的前 200 字）。 */
const PDF_BODY = '第一步：先数页数。第二步：再抽文本。'

/** 留一屏——文本写进 `<out>/<序号>-<名字>.txt`，字格与光标写进同名 `.json`。 */
function keep(out: string, shot: Capture, label: string): void {
  writeFileSync(join(out, `${label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${label}.json`),
    `${JSON.stringify(
      {
        columns: shot.columns,
        rows: shot.rows,
        cursor: shot.cursor,
        scrollback: shot.scrollback,
        lines: shot.lines,
        runFiles: shot.files,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${label} ──\n${shot.text}`)
}


/**
 * 打一行字并**等它真出现在屏上**（按键丢了就等不到——不重发，如实失败）。
 *
 * 这条等待是记忆里那两处坑的正解：文本与回车**分两次写**，且**先等草稿上屏再回车**
 * （挤在同一次写里整段按键会被丢掉）。
 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** **开 `/skills` 抽屉**：打那条命令、回车、等列表铺开（抽屉由答复那一下开）。 */
async function openDrawer(session: UiSession, rows = '项目 .magic/skills'): Promise<void> {
  await typeLine(session, '/skills')
  await session.key('enter', { until: { text: rows }, timeoutMs: 10_000 })
}

/** 屏上有没有这一行。 */
function has(shot: Capture, needle: string): boolean {
  return shot.lines.some((line) => line.includes(needle))
}

/** 帧里的行号（找不到＝-1）。 */
function rowOf(shot: Capture, needle: string): number {
  return shot.lines.findIndex((line) => line.includes(needle))
}

// ══ ① 技能列表：四类来源都在一屏里 ═══════════════════════════════════

/**
 * 摆一份「来源齐全」的技能目录（U33 覆盖面的那一串）：
 * **项目/用户同名** · **原生/兼容** · **目录软链接** · **配置点名**。
 *
 * @returns 配置里该写的那条补充来源路径（调用方负责在起会话之前备好它）
 */
function putCatalog(session: UiSession, configured: string): void {
  const { workspace, home } = session.facts()

  // 项目 · 原生
  putSkill(workspace, '.magic', 'pdf', '处理 PDF：抽文本、填表、合并。提到 PDF 时用。', PDF_BODY)
  // 项目 · 兼容（同一个名字换个入口——列表里来源得说得清是哪一个）
  putSkill(workspace, '.agents', 'compat-check', '兼容入口那一份', '照它做。')
  // 用户 · 原生（**与项目那份同名**——两行都要在，来源可辨）
  putSkill(home, '.magic', 'pdf', '我个人的 PDF 做法', '个人版：先看目录。')
  // 用户 · 兼容
  putSkill(home, '.agents', 'notes', '记笔记的路子', '一行一条。')

  // 目录软链接：指向沙地外的另一处（规范里技能目录常常是指向别处的一份共享技能）
  const shared = join(tempDir('magic-u33-shared-'), 'audit')
  mkdirSync(shared, { recursive: true })
  writeFileSync(
    join(shared, 'SKILL.md'),
    `---\nname: audit\ndescription: 审一遍改动\n---\n\n逐个看过去。\n`,
    'utf8',
  )
  symlinkSync(shared, join(workspace, '.magic', 'skills', 'linked'))

  // 配置点名的那一处（`skills.sources`）——**直接指一份技能目录**（那一类也认，
  // 见执行域 `childrenOf` 里 `named` 那一支），不是「一摞技能」的容器
  const named = join(configured, 'named')
  mkdirSync(named, { recursive: true })
  writeFileSync(
    join(named, 'SKILL.md'),
    '---\nname: named\ndescription: 配置里点名的那一份\n---\n\n按它说的办。\n',
    'utf8',
  )
}

/** ①～③：选择 → 提交。**零请求在前，主文在请求里在后**，一件一件量。 */
async function pickAndSend(out: string, configured: string): Promise<void> {
  const session = await createUiSession({
    label: 'u33-选择与提交',
    artifacts: join(out, 'runs'),
    config: { skills: { sources: [configured] } },
    // 长一点、慢一点：提交那一下之后屏上要留得住「长出来的过程」
    turns: [{ kind: 'text', text: '照它做，先数页数。', chunks: 4, chunkDelayMs: 60 }],
  })

  try {
    putCatalog(session, configured)

    // —— ① `/skills`：四类来源列在一屏里 ——
    await openDrawer(session)
    const list = await session.capture({ label: '01-技能列表' })
    keep(out, list, '01-技能列表')

    check(has(list, 'pdf'), '列表里有 pdf')
    check(has(list, '项目 .magic/skills'), '项目那一份的来源报得出来')
    check(has(list, '用户 .magic/skills'), '**同名的那一份用户来源**也在列（两行，来源可辨）')
    check(has(list, '项目 .agents/skills'), '兼容入口那一份的来源与原生**分得开**')
    check(has(list, '配置来源 .magic/skills'), '**配置点名**的那一份在列')
    // 软链接那一份的名字取自**目标**里的 `SKILL.md`（`audit`）——它自己叫 `linked`，
    // 屏上出现的是目标的名字，正说明链接是**跟出去读的**
    check(has(list, 'audit'), '**目录软链接**的那一份在列（名字来自链接指向的那一处）')
    // 候选每项一行（简化同名的两份各占一行、不挤在一行里）
    check(
      rowOf(list, '项目 .magic/skills') !== rowOf(list, '用户 .magic/skills'),
      '同名的两份各占一行',
    )

    // —— ② 选定：草稿那一行，**此刻一个模型请求都没发** ——
    // 先把选中项挪到「项目那一份 pdf」上（`↓` 一格）——顺带把「上下选择」也走上
    await session.key('down')
    await session.key('enter', { until: { text: '› /pdf' }, timeoutMs: 5_000 })
    const bound = await session.capture({ label: '02-选定之后' })
    keep(out, bound, '02-选定之后')

    // ⚠️ 原判据锚的是 U33 那条**草稿材料行**（`技能：…（待发送）`）——U36 起它没了：
    //    引用直接写在正文里（原位）。故这里改判同一件事的现在时：**那一处引用在草稿上**，
    //    且**不再另列一行**（那正是 U36 删掉它的理由：同一件事不说两遍）。
    check(has(bound, '› /pdf'), '选定之后那一处引用就在草稿里（原位）')
    check(!has(bound, '（待发送）'), '不另列「待发送材料」那一行')
    check(session.requests().length === 0, '**选定不发模型请求**（夹具收到 0 条）')

    // —— ③ 提交：正文 ＋ 技能一次送出 ——
    // ⚠️ **前导空格不是凑数**（U51 补记）：选定之后草稿头一格就是那处引用（`/pdf`），
    //    紧跟正文而不隔一个空格的话，整个开头连成一个词（`/pdf把这份`）——外壳按
    //    「草稿以 `/` 起头」把它当成一条命令，当场回一句「不认得的命令」。
    //    引用与正文之间那句空格是**用户本来就会打的**（U36 的句子也是「再按 /review 检查 …」），
    //    故这里照打——不掩盖产品行为，只是把这一步写成真实的样子。
    await typeLine(session, ' 把这份 PDF 处理一下')
    await session.key('enter', { until: { text: '照它做，先数页数。' }, timeoutMs: 15_000 })
    const sent = await session.capture({ label: '03-提交之后' })
    keep(out, sent, '03-提交之后')

    const requests = session.requests()
    check(requests.length === 1, `提交之后**正好一次**模型请求（实测 ${requests.length} 条）`)
    const carried = requests[0]?.lastUser ?? ''
    check(carried.includes('第一步：先数页数。'), '**技能主文真的进了这次请求**（请求体里认得出它）', carried)
    check(carried.includes('把这份 PDF 处理一下'), '用户那句话也在同一条消息里')
    check(has(sent, '本次使用技能：pdf'), '模型真回来之后，回执给了一次')
    check(has(sent, '把这份 PDF 处理一下'), '用户那句话在记录区（斜杠那截不回显）')
    check(!has(sent, '› /skills'), '入口命令本身不回显')
  } finally {
    await close(session)
  }
}

// ══ ④ 取消：`esc` 不留痕迹 ═════════════════════════════════════════

async function cancel(out: string, configured: string): Promise<void> {
  const session = await createUiSession({
    label: 'u33-取消',
    artifacts: join(out, 'runs'),
    config: { skills: { sources: [configured] } },
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    putCatalog(session, configured)

    await openDrawer(session)
    await typeLine(session, 'pdf') // 筛到那一条上
    await session.key('esc', { until: { absent: '回车 定' }, timeoutMs: 5_000 })
    const shot = await session.capture({ label: '04-取消' })
    keep(out, shot, '04-取消')

    check(!has(shot, '/pdf'), '`esc` 之后草稿上没有挂任何技能')
    check(!has(shot, '项目 .magic/skills'), '抽屉收起了（列表那几行不在屏上）')
    check(session.requests().length === 0, '取消一路一个模型请求都没发')
  } finally {
    await close(session)
  }
}

// ══ ⑤ `esc`：清掉整份草稿（引用与正文一起）═══════════════════════════

/**
 * ⚠️ **本节 2026-09-24（U51）改判**：它原先叫「移除：材料摘掉，正文一个字不动」——
 * 判的是 U33 那条**草稿材料行**上「`esc` 先摘材料、正文留着」。
 * **那条约 U36 起不存在了**：草稿材料行整个删掉，引用直接写在正文里（原位）。
 * 现在的 `esc` 就是**清掉整份草稿**（引用与正文一起，既有语义「`esc` 清」）。
 *
 * 故本节改判**现在真实看得到的那件事**，并按「看图四项」留下那一帧——
 * **不是放宽判据**：旧判据说的那个界面已经没有地方可以判了（说的是删掉那一行）。
 */
async function remove(out: string, configured: string): Promise<void> {
  const session = await createUiSession({
    label: 'u33-清草稿',
    artifacts: join(out, 'runs'),
    config: { skills: { sources: [configured] } },
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    putCatalog(session, configured)

    await openDrawer(session)
    // 第一行是软链接那一份（`audit`）——目录名与名字不一致那一路，排在最前
    await session.key('enter', { until: { text: '› /audit' }, timeoutMs: 5_000 })
    await typeLine(session, ' 这一段话不要跟着技能走')

    await session.key('esc', { until: { absent: '/audit' }, timeoutMs: 5_000 })
    const shot = await session.capture({ label: '05-清草稿' })
    keep(out, shot, '05-清草稿')

    check(!has(shot, '/audit'), '引用跟着草稿一起清了')
    check(!has(shot, '这一段话不要跟着技能走'), '正文也清了（引用就在正文里，没有「只摘材料」那一步）')
    check(has(shot, '› 交代一件事，回车发送'), '回到空草稿的样子（占位那句话回来了）')
    check(session.requests().length === 0, '清草稿不发请求')
  } finally {
    await close(session)
  }
}

// ══ ⑥ 来源失效：保稿 ═══════════════════════════════════════════════

async function failure(out: string, configured: string): Promise<void> {
  const session = await createUiSession({
    label: 'u33-来源失效',
    artifacts: join(out, 'runs'),
    config: { skills: { sources: [configured] } },
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    putCatalog(session, configured)

    await openDrawer(session)
    await session.key('down') // 选中「项目那一份 pdf」
    await session.key('enter', { until: { text: '› /pdf' }, timeoutMs: 5_000 })

    // 选定之后、提交之前，那一份**没了**（改名 / 删掉 / 挪走都长这样）
    rmSync(join(session.facts().workspace, '.magic', 'skills', 'pdf'), { recursive: true, force: true })

    await typeLine(session, ' 照它做')
    await session.key('enter', { until: { text: '没送出' }, timeoutMs: 10_000 })
    const shot = await session.capture({ label: '06-来源失效' })
    keep(out, shot, '06-来源失效')

    check(has(shot, '没送出'), '失败**出声**（不是静默吞掉）')
    check(has(shot, 'pdf'), '缘由里点名了是哪一份来源')
    check(session.requests().length === 0, '**一个模型请求都没发**（读不到就不跑这一条）')
    // 保稿：交代回到输入行上（连技能一起）——屏上那两样都在
    // ⚠️ 原锚是 `› 照它做`（那时引用另占一行，草稿里只有正文）；现在引用**就在正文里**，
    //    草稿整行是 `› /pdf 照它做`——同一件事，形制变了。
    check(has(shot, '› /pdf 照它做'), '**交代回到草稿里**（正文与那处引用的位置都按原样找回）')
  } finally {
    await close(session)
  }
}

// ══ ⑦ 窄窗：候选仍每项一行 ═════════════════════════════════════════

async function narrow(out: string, configured: string): Promise<void> {
  const session = await createUiSession({
    label: 'u33-窄窗',
    artifacts: join(out, 'runs'),
    config: { skills: { sources: [configured] } },
    columns: 100,
    rows: 30,
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    putCatalog(session, configured)
    // 一条**很长的简述**——窄窗下它得被截掉，而不是折成第二行（折了高度账就分家）
    putSkill(
      session.facts().workspace,
      '.magic',
      'verbose',
      '这份简述故意写得很长很长，长到一百列都装不下，为的就是看窄窗下它有没有被截断，而不是折成第二行把高度账搞乱。',
      '照它做。',
    )

    await session.resize(60, 24)
    await openDrawer(session)
    const shot = await session.capture({ label: '07-窄窗' })
    keep(out, shot, '07-窄窗')

    check(has(shot, 'pdf'), '窄窗下列表还在')
    check(
      shot.lines.every((line) => line.length <= shot.columns),
      '没有一行溢出屏宽（截断在渲染层做，Ink 不再折）',
    )
    // 长简述那一条**只占一行**：它下面一行就是下一条（`desc` 的下一行是 `compat-check`）
    const at = rowOf(shot, 'verbose')
    check(
      at >= 0 && (shot.lines[at + 1] ?? '').includes('compat-check'),
      '长简述那一条**只占一行**（截断加 `…`，不折成第二行）',
      shot.lines[at + 1] ?? '（没有下一行）',
    )
  } finally {
    await close(session)
  }
}

// ══ ⑧ 内置同名：命令保留含义，技能仍可从 `/skills` 选 ═════════════

async function builtinClash(out: string, configured: string): Promise<void> {
  const session = await createUiSession({
    label: 'u33-内置同名',
    artifacts: join(out, 'runs'),
    config: { skills: { sources: [configured] } },
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    putCatalog(session, configured)
    putSkill(session.facts().workspace, '.magic', 'model', '我自己写的一份 model 技能', '按它做。')

    // `/model` 仍是**换模型**那个内置命令（开的是条目选择器，不是技能抽屉）
    await typeLine(session, '/model')
    // ⚠️ 锚换过（U51）：原先抄的是 `/resume` 那一屏的键位提示（带「打字筛 · tab 换范围」，
    //    那是 U49 给 `/resume` 加的）。`/model` 开的是**条目选择器**，提示就是常态那一句。
    await session.key('enter', { until: { text: '↑↓ 选 · 回车 定 · esc 收起' }, timeoutMs: 10_000 })
    const cmd = await session.capture({ label: '08a-内置-model' })
    keep(out, cmd, '08a-内置-model')
    check(has(cmd, 'local') || has(cmd, 'MiniMax'), '`/model` 开的是条目选择器（内置含义保留）')
    check(!has(cmd, '我自己写的一份 model 技能'), '它不是那份同名技能')

    // 收起条目选择器——**等它真收起再接着打**（`esc` 是单独一个字节，紧跟着打字会与它
    // 挤进同一次读：终端那半边要等到下一个字节才知道这是个孤立 ESC 还是转义序列的开头）
    await session.key('esc')
    await session.wait({ absent: '回车 定' }, { timeoutMs: 5_000 })

    // 同名技能没被吞掉：`/skills` 里列得出来
    await openDrawer(session)
    await session.send('model')
    const skills = await session.capture({ label: '08b-同名技能' })
    keep(out, skills, '08b-同名技能')
    check(has(skills, '我自己写的一份 model 技能'), '同名技能仍能从 `/skills` 选')
  } finally {
    await close(session)
  }
}

// ══ ⑨ 切会话：**判据作废，整节删掉**（2026-09-24 · U51）═══════════════

/**
 * 本节原判「换了会话，草稿上那份技能还在（材料属于草稿，不属于会话）」——
 * 观察点是 U33 那条**草稿材料行**。它自己那条注已经写明「本节已过期」：
 *
 * - U36 删掉了草稿材料行（引用改写在正文里），头一个锚没了；
 * - U44 撤掉了 `/session`（换成 `/clear`），那一处命令名也没了；
 * - 而它当时要等的第二样（`已新建一条会话` 那句回执）是 D28 甲 删掉的。
 *
 * **没有可判的地方了**，故整节删掉——留着就是「看起来有覆盖」的摆设
 * （`研发/界面验收工具`：别让摆设留着）。要看「翻页之后草稿怎么样」，
 * 那条判据归 `frames-u44-tui.ts`（翻页与 `/clear` 是那一单交付的）。
 */

// ══ ⑩～⑬ 独立验收退回的三处（真 PTY 复现）════════════════════════════

/** ⑪ 窄窗（**起手即 60 列**，不 resize）＋ 56 字符的名字：来源不能被名字挤没。 */
async function narrowLongName(out: string, configured: string): Promise<void> {
  const long = 'a'.repeat(56)
  const session = await createUiSession({
    label: 'u33-窄窗长名',
    artifacts: join(out, 'runs'),
    config: { skills: { sources: [configured] } },
    columns: 60,
    rows: 24,
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    const { workspace, home } = session.facts()
    putSkill(workspace, '.magic', long, '项目那一份', '项目正文。')
    putSkill(home, '.magic', long, '用户那一份', '用户正文。')

    await openDrawer(session, long.slice(0, 8))
    const shot = await session.capture({ label: '11-窄窗长名' })
    keep(out, shot, '11-窄窗长名')

    const rows = shot.lines.filter((line) => line.includes(long.slice(0, 8)))
    check(rows.length === 2, `两份各占一行（实测 ${rows.length} 行）`)
    check(rows[0]?.includes('项目 .magic/skills') === true, '第一行保住了「项目」来源', rows[0] ?? '')
    check(rows[1]?.includes('用户 .magic/skills') === true, '第二行保住了「用户」来源', rows[1] ?? '')
    check(
      rows.every((line) => line.length <= shot.columns),
      '每项仍是一行（没折行）',
    )
  } finally {
    await close(session)
  }
}

/** ⑮ 宽窗（100 列）＋ 60 字符的名字：**名称放得下就不许截它**（截的是简述）。 */
async function wideLongName(out: string, configured: string): Promise<void> {
  const long = 'a'.repeat(60)
  const note = '这份简述写得很长，长到整行装不下——宽窗下该被截断的是它，不是名称'
  const session = await createUiSession({
    label: 'u33-宽窗长名',
    artifacts: join(out, 'runs'),
    config: { skills: { sources: [configured] } },
    columns: 100,
    rows: 30,
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    putSkill(session.facts().workspace, '.magic', long, note, '照它做。')

    await openDrawer(session, long.slice(0, 8))
    const shot = await session.capture({ label: '15-宽窗长名' })
    keep(out, shot, '15-宽窗长名')

    const row = shot.lines.find((line) => line.includes(long.slice(0, 8))) ?? ''
    check(row.includes(long), '**名称整串都在**（宽窗下放得下就不截）', row)
    check(row[row.indexOf(long) + long.length] === '　', '名称之后不是省略号')
    check(row.includes('项目 .magic/skills'), '来源也在')
    check(!row.includes(note), '**截断落在简述身上**')
  } finally {
    await close(session)
  }
}

/**
 * ⑫ 补全成引用**不搬正文里的插入点**。
 *
 * ⚠️ **2026-09-24（U51）换过道具**：原先是「同档同名」那两份（`twins`）——那条路今天
 * 到不了终点（见 ⑩ 的说明），故改用一个**单独一份**的技能（`solo`）。**判据一个字没改**：
 * 还是「插入点在原地，补上来的东西落在它那儿，不是把整条草稿挪到末尾」。
 */
async function keepCaret(out: string, configured: string): Promise<void> {
  const session = await createUiSession({
    label: 'u33-插入点',
    artifacts: join(out, 'runs'),
    config: { skills: { sources: [configured] } },
    turns: [{ kind: 'text', text: '（这一轮不该发生）' }],
  })

  try {
    putSkill(session.facts().workspace, '.magic', 'solo', '单独一份', '单独正文。')

    await typeLine(session, 'abc d')
    // **光标真在**（`abc |d`）：先量末尾那一格，再左移一格看它跟不跟着退
    const atEnd = await session.capture({ label: '12a-光标在末尾' })
    await session.key('left')
    // 纯光标移动**屏上没有一个字会变**（这一屏是「等条件」等不到的）——照 Ink 的写档
    // （30fps）给一帧的余量，再读那一格
    await Bun.sleep(250)
    const before = await session.capture({ label: '12b-选定之前（光标在 abc |d）' })
    keep(out, before, '12-选定之前')
    check(
      before.cursor.x === atEnd.cursor.x - 1,
      `左移一格，真光标跟着退一列（${atEnd.cursor.x} → ${before.cursor.x}）`,
    )

    // **插入点在两段中间**的时候补全：`abc /solo|d` 里那个 `/solo` 就地变成引用。
    // ⚠️ 那个斜杠词要**自成一段**（前面隔一个空格）——候选是按插入点那个词筛的，
    //    写成 `abc/solo` 时它整串算一个词，候选栏根本不出来（U51 真跑里栽过）。
    await session.send('/solo', { until: { text: '/solo' } })
    await session.wait({ text: '单独一份' }, { timeoutMs: 10_000 })
    await session.key('tab', { until: { text: '› abc /solo' }, timeoutMs: 5_000 })
    await typeLine(session, 'Z')
    const after = await session.capture({ label: '13-补全之后接着打' })
    keep(out, after, '13-补全之后接着打')

    // 接着打 `Z` ⇒ `abc /soloZd`（插入点**没被搬到末尾**——那样会是 `abc /solodZ`）
    check(has(after, 'abc /soloZd'), '**字插在原位**（`abc /soloZd`）')
    check(!has(after, 'abc /solodZ'), '不是落到末尾（`abc /solodZ`）')
  } finally {
    await close(session)
  }
}

// ══ ⑬ 真 `--session <id>` 恢复（U33 立、U51 摘、U53 挂回来）════════════

/**
 * 第一程发一条**带技能的**交代、落账、退出；第二程拿那条会话 id 接续，屏上该认得出
 * 那条消息——**连同它的技能来源**。
 *
 * ## 它为什么被摘掉过（U51 · 2026-09-24）
 *
 * 第二程**记录区一个字都不铺**（`raw.bin` 2208 字节、不含正文；状态行照旧认得出那条会话，
 * 因为标题是从 `session.list` 那一跳来的）⇒ 本节一条判据都判不了。U51 一行产品代码没动，
 * 判它是**产品缺陷**并整节摘掉、在回报里点名（`研发/界面验收工具`：别让「看起来有覆盖」
 * 的摆设留着）——那一处缺陷即 **D33**。
 *
 * ## 挂回来时改了两处（U53）
 *
 * 1. **选定技能那一步的等待锚**：原判等的是草稿材料行的 `（待发送）`——U36 起那一行没了
 *    （引用就写在正文里）。今天选定之后屏上出现的是**草稿里那个引用**（`› /pdf`），
 *    故等它。⚠️ 接下去打正文要**先隔一个空格**：插入点落在引用末尾，紧着打会与它黏成
 *    一个词，那一下被当成命令（实测：`/pdf把这份` ⇒ 「不认得的命令」）。
 *    （记录区那一行来源的写法没变，仍是 `技能：pdf · 项目 .magic/skills`。）
 * 2. **两扇窗共用一块沙地**：原判拿 `config: { dataDir }` 让两个**各起一块**沙地的窗口
 *    落到同一条数据目录上——U48 之后不行了：运行目录按「基础目录 ＋ dataDir 指纹」算，
 *    两个 HOME 就是两个管理者，而「同一 dataDir 只有一个管理者」是设计的明文。
 *    故借**同一块沙地**（同一位管理者、同一条数据目录），与 `frames-u49-tui.ts` 同形。
 *
 * ## 它比「铺出来了」多判的那一件
 *
 * **来源读的是记录里那一份，不是重新读盘**：第二程起来之前把技能目录**从盘上撤掉**——
 * 屏上那一行来源若还在，只可能来自记录（材料是动态的，重读会拿到今天的，冒充当时那一份）。
 */
async function restored(out: string, configured: string): Promise<void> {
  const runs = join(out, 'runs')
  const fixture = startFixture({ turns: [{ kind: 'text', text: '照它做，先数页数。' }] })
  const sandbox = createSandbox({
    baseURL: fixture.baseURL,
    config: { skills: { sources: [configured] } },
  })
  const windows: UiSession[] = []

  try {
    // —— 第一程：一条带技能的交代 ——
    const first = await createUiSession({ label: 'u33-恢复-第一程', artifacts: runs, sandbox, fixture })
    windows.push(first)

    putCatalog(first, configured)
    await openDrawer(first)
    await first.key('down') // 头一行是 `audit`；选「项目那一份 pdf」（与正文对得上）
    // ⚠️ **选定之后屏上出现的是草稿里那个引用**（U36 起：材料行没了，引用就写在正文里）——
    //    故等的是它，不是原判那个 `（待发送）`（那是草稿材料行的写法，已经不存在了）
    await first.key('enter', { until: { text: '› /pdf' }, timeoutMs: 5_000 })
    // ⚠️ **头一个字符是空格**：引用是插在插入点上的（插入点落在引用**末尾**，见 U33 的
    //    「字插在原位」那一节）——紧接着打字会与它黏成一个词，那一下被当成命令
    //    （实测：`/pdf把这份` ⇒ 「不认得的命令」）。
    await typeLine(first, ' 把这份 PDF 处理一下')
    await first.key('enter', { until: { text: '照它做，先数页数。' }, timeoutMs: 15_000 })
    // **等它闲下来再收**——忙的时候 `ctrl+c` 是中断不是退出，助手那条就落不了账
    // （实测：收早了，恢复出来只剩用户那句、答复没了）
    await close(first)
    windows.length = 0

    let id = ''
    const db = readDatabase(join(sandbox.dataDir, 'records.db'))
    try {
      id = db.sessions[0]?.id ?? ''
      check(id !== '', '第一程落下了一条会话（记录库直读）')
      check(db.entries.length >= 2, '第一程的条目落了账（用户 ＋ 助手）')
    } finally {
      db.close()
    }

    // ⚠️ **把技能从盘上撤掉**（项目与用户两处）——第二程那一行来源只可能来自记录
    for (const root of [sandbox.workspace, sandbox.home]) {
      rmSync(join(root, '.magic', 'skills'), { recursive: true, force: true })
    }

    // —— 第二程：拿那条 id 起来 ——
    const second = await createUiSession({
      label: 'u33-恢复-第二程',
      artifacts: runs,
      sandbox,
      fixture,
      argv: ['--session', id],
    })
    windows.push(second)

    await second.wait({ text: '把这份 PDF 处理一下' }, { timeoutMs: 20_000 })
    // 历史**分块推**——用户那句在第一块就可能到了，助手那句在后头；等齐了再取帧
    await second.wait({ text: '照它做，先数页数。' }, { timeoutMs: 20_000 })
    const shot = await second.capture({ label: '14-恢复之后' })
    keep(out, shot, '14-恢复之后')

    check(has(shot, '把这份 PDF 处理一下'), '恢复出了那条交代的正文')
    check(has(shot, '技能：pdf · 项目 .magic/skills'), '**技能来源也在**（盘上已经撤掉，只可能来自记录）')
    check(has(shot, '照它做，先数页数。'), '助手那句也重建回来了（历史是整段铺的）')
    check(!has(shot, '本次使用技能'), '**不伪造使用回执**（那是当时的事，恢复不重放）')

    await close(second)
    windows.length = 0
  } finally {
    for (const window of windows) await window.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
  }
}

/**
 * 收摊——**看它是自己走的还是被杀的**（`exit.by`）。
 *
 * 判据：应用与夹具都得真退场（「所有应用 / 工具 / 本地端点由独立监督确认退出」）——
 * 这条不作「必过」，**如实报出来**：`sigkill` 才要当场喊。
 */
/** 收过摊的（同一会话只收一次——驱动的 `close` 没有二次调用守卫，收两遍会把沙地删两回）。 */
const closed = new WeakSet<UiSession>()

async function close(session: UiSession): Promise<void> {
  if (closed.has(session)) return
  closed.add(session)

  // 先等它**闲下来**——忙的时候 `ctrl+c` 是**中断**不是退出（外壳的既有语义：空闲＝退出 ·
  // 工作中＝中断），不等这一跳就按下去，量到的会是「中断生效了、进程还活着」。
  // 等不到也不硬等：下面照样收摊（SIGTERM 那条路仍在），只是 `by` 会如实记成我们杀的。
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 10_000 }).catch(() => undefined)

  // 再走「按两次」那条路（U46）——**让它自己走**，`by` 才说明得了「它认得收摊这件事」
  await session.quit()
  const report = await session.close({ graceMs: 3_000 })
  const how = `${report.exit.by}（code ${report.exit.code ?? '-'} / signal ${report.exit.signal ?? '-'}）`

  if (report.exit.by !== 'app') throw new Error(`应用不是自己走的（${how}）——收摊那条路没走完`)

  console.log(`  · 收摊：${how} · 帧 ${report.frames} 张 · 现场 ${report.runDir}`)
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const out = at === -1 ? tempDir('magic-frames-u33-') : (process.argv[at + 1] as string)
  mkdirSync(out, { recursive: true })

  // 配置点名的那一处：**起会话之前**就得在（配置是启动时读的），故建在沙地外
  const configured = tempDir('magic-u33-configured-')
  mkdirSync(configured, { recursive: true })

  try {
    await pickAndSend(out, configured)
    await cancel(out, configured)
    await remove(out, configured)
    await failure(out, configured)
    await narrow(out, configured)
    await builtinClash(out, configured)
    // 独立验收退回的三处（真 PTY 复现）
    await narrowLongName(out, configured)
    await wideLongName(out, configured)
    await keepCaret(out, configured)
    await restored(out, configured)
    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    removeDir(configured)
  }
}
