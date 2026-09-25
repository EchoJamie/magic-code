#!/usr/bin/env bun
/**
 * U81 · **注入的话统一写成「事实陈述」** —— 真 PTY 留帧 ＋ 端点原文。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。跑法：
 *
 * ```
 * bun packages/app/test/frames-u81-tui.ts --out <目录> [--only <场名>]
 * ```
 *
 * ## 这一单判的是哪一件事
 *
 * 设计（本单权威 · `设计/提示词与指令`·丙，内文出自 Claude Code hooks 文档原文）：
 *
 * > **凡是我们往上下文里塞的话（不是用户说的、也不是模型自己生成的），一律写成「事实陈述」。**
 * > ❌「你应该去读 `<路径>`」／「**系统指令**：…」——**命令式**，会触发模型自己的注入防御，
 * > **它反而把那段上报给用户**。
 *
 * ## 这个装置取什么物证
 *
 * 判「注入的话读着像不像陈述」这件事，**屏上看不见**——那些话是发给模型的，不是给用户看的。
 * 故本装置取的物证是**受控端点收到的请求体**（`ui/fixture.ts` 的 `FixtureRequest.body`，
 * 出站原样）：把那条注入的话**逐字**从里面捞出来，写进 `<out>/注入原文-<场名>.txt`。
 *
 * | 场 | 那一处注入 | 该从端点收到什么 |
 * | --- | --- | --- |
 * | `后台` | **U70 那条后台完成消息**（已知那一处） | 两行，**两行都是陈述**：抬头那行说「怎么了 ＋ 哪一条 ＋ 退出码 ＋ 命令首行」，第二行**只报输出在哪儿**；**不许有**吩咐它做事的半句 |
 * | `计划` | **计划笔记那一条**（`plan.ts` 的 `planMaterialOf`） | 抬头 ＋ 正文 ＋ 一句「不是用户的新要求」——**全是陈述** |
 * | `原文` | 只有 `后台` 那一处的**取原文**（一条判据都不判） | 给「改前 / 改后」对照那一趟用：**在工作树之外另起一个基线检出**跑同一支、取同一格 |
 *
 * ## ⚠️ 反证那一格：造得出什么、造不出什么（如实记）
 *
 * 工单 ③ 要的是「**把某一处改回命令式 ⇒ 看得出模型把它当外部内容对待**」。分两半：
 *
 * - **造得出**——「命令式那一形**真会原样送到模型眼前**」。改前那一版（「完整输出在 … ——
 *   要看就用 read 读它。」）**不是猜的**：本装置的 `--only 原文` 在一份**基线检出**里
 *   真跑一遍，从同一个端点取出那一份原样（`注入原文-原文.txt`）。两次跑出来的两份**逐字
 *   并排**，差的就是这一单改的那一处。
 * - **造不出**——「**模型拿到它之后怎么办**」。受控端点是**脚本化模型**（`ui/fixture.ts`，
 *   按次取回合）：它没有「怎么对待」可言，拿它当证据就是自己演自己看。真供应商那一头
 *   设计明令不许冒充验收（`设计/模型与上下文`：「不取真 key 或发付费请求来冒充无条件验收」）。
 *   ⇒ 这一半**如实说造不出**，判据落在「形」上（那一句读着是吩咐还是陈述），依据是被引的
 *   那一句官方原文。
 *
 * ## 一条权限规则都不加
 *
 * 这一单不碰权限——命令取判轻的（`默认通`），屏上没有卡，也就没有「卡」那一维要判。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MagicHome } from '@magic/contracts'
import { MAGIC_IDLE_MARK, createSandbox, createUiSession, startFixture } from './ui/index.ts'
import type { Capture, Fixture, FixtureTurn, Sandbox, UiSession } from './ui/index.ts'
import { backgroundOutputDirOf, runPathsOf } from '../src/run/paths.ts'
import { tempDir } from './tmp.ts'

/** 这一趟的产物根——入口解析 `--out` 之后填。 */
let out = ''

/** 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/** 留一屏——文本 ＋ 字格（色与重量只能从 `.json` 的格子上看）。 */
function keep(shot: Capture): void {
  writeFileSync(join(out, `${shot.label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${shot.label}.json`),
    `${JSON.stringify(
      {
        columns: shot.columns,
        rows: shot.rows,
        cursor: shot.cursor,
        scrollback: shot.scrollback,
        lines: shot.lines,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${shot.label} ──（${shot.columns}×${shot.rows} · scrollback ${shot.scrollback}）\n${shot.text}`)
}

/** 屏上（可见那一屏 ＋ 滚进去的）有没有这句话。 */
function has(shot: Capture, needle: string): boolean {
  return shot.text.includes(needle) || shot.history.some((line) => line.includes(needle))
}

/** 收下一条**发给模型的话**——按文本写进 `<out>/<名字>.txt`，并回它的原文。 */
function keepPayload(name: string, text: string): string {
  writeFileSync(join(out, `${name}.txt`), `${text}\n`, 'utf8')
  console.log(`\n── ${name} ──（受控端点收到的原文 · 逐字）\n${text}`)
  return text
}

// ══ 从受控端点的请求体里捞那一条注入 ═══════════════════════════════

/** 一次请求里的消息（`role` ＋ 正文）——正文可能是字符串或部件串（只取文本块）。 */
function messagesOf(body: Record<string, unknown>): readonly { role: string; text: string }[] {
  const list = Array.isArray(body['messages']) ? body['messages'] : []

  return list.map((raw) => {
    const message = raw as { role?: unknown; content?: unknown }
    const role = typeof message.role === 'string' ? message.role : ''
    const content = message.content

    if (typeof content === 'string') return { role, text: content }
    if (!Array.isArray(content)) return { role, text: '' }

    const text = content
      .map((part) => {
        const one = part as { type?: unknown; text?: unknown }
        return one.type === 'text' && typeof one.text === 'string' ? one.text : ''
      })
      .join('')

    return { role, text }
  })
}

/** 端点收到的那一条**带某个记号**的消息——`{ role, text, n }`（`n` ＝ 第几次请求）。 */
function injectedFrom(
  fixture: Fixture,
  marker: string,
): { readonly role: string; readonly text: string; readonly n: number } | undefined {
  for (const request of fixture.requests()) {
    for (const message of messagesOf(request.body)) {
      if (message.text.includes(marker)) return { role: message.role, text: message.text, n: request.n }
    }
  }

  return undefined
}

/** 一条注入的话里**不许出现**的那些——吩咐它做事的口吻，与伪造成系统指令的抬头。 */
const FORBIDDEN: readonly string[] = [
  '要看就用',
  '你应该',
  '请你',
  '系统指令',
  '系统命令',
  '请务必',
]

/** 判这一条**读着是陈述**：不含命令式那几件，且不冒充系统指令。 */
function checkFactual(text: string, what: string): void {
  for (const bad of FORBIDDEN) {
    check(!text.includes(bad), `${what}：**不含**命令式那半句（「${bad}」）`, text)
  }
}

/** 后台那条命令的输出文件路径——按产品自己的那两件算（同 `frames-u70-tui.ts`）。 */
function outputPathOf(sandbox: Sandbox, id = 'bg-1'): string {
  const magic: MagicHome = { home: sandbox.home, base: join(sandbox.home, '.magic') }
  return join(backgroundOutputDirOf(runPathsOf(magic, sandbox.dataDir, tmpdir())), `${id}.log`)
}

/** 敲一行字并**等它真出现在屏上**（文本与回车分两次写——挤在一次里会丢键）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 等这一轮真收束（状态行回到空闲）。 */
async function settled(session: UiSession, timeoutMs = 30_000): Promise<void> {
  await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs })
}

/** 一帧的底架：一块新沙地 ＋ 一台夹具。 */
async function openScene(options: {
  readonly label: string
  readonly turns: readonly FixtureTurn[]
}): Promise<{ readonly session: UiSession; readonly sandbox: Sandbox; readonly fixture: Fixture }> {
  const fixture = startFixture({ turns: options.turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })

  const session = await createUiSession({
    label: options.label,
    artifacts: join(out, 'runs'),
    sandbox,
    fixture,
    columns: 100,
    rows: 30,
  })
  await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 20_000 })

  return { session, sandbox, fixture }
}

/** 收摊：先照产品的方式退，再停夹具、删沙地。 */
async function closeScene(scene: {
  readonly session: UiSession
  readonly sandbox: Sandbox
  readonly fixture: Fixture
}): Promise<void> {
  try {
    await scene.session.quit()
  } finally {
    await scene.session.close({ graceMs: 3_000 })
    await scene.fixture.stop()
    scene.sandbox.dispose()
  }
}

// ══ 场一 · 后台跑完那一条（已知那一处）════════════════════════════════

/**
 * **一条后台命令跑完 ⇒ 端点收到的那一条**。
 *
 * 剧本三拍：把命令交出去 → 它自己接着说一句（这一轮不等它）→ 由「跑完」那一条唤醒的一轮。
 * 判据落在**端点收到的那一份原文**上（屏上那一声是另一件事，见下面那一条备注）。
 */
async function sceneBackground(options: { readonly assert: boolean }): Promise<void> {
  const turns: FixtureTurn[] = [
    {
      kind: 'tool',
      name: 'exec',
      args: { cmd: 'echo U81起手; sleep 0.6; echo U81收工', background: true },
      text: '交出去了。',
    },
    { kind: 'text', text: '我接着做别的。' },
    { kind: 'text', text: '看到后台跑完了。' },
  ]

  const fixture = startFixture({ turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const outputPath = outputPathOf(sandbox)

  let session: UiSession | undefined
  try {
    session = await createUiSession({
      label: 'u81-后台',
      artifacts: join(out, 'runs'),
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 20_000 })

    await typeLine(session, '把这条交出去跑')
    await session.key('enter')
    // 等模型被那条注入唤醒、说完了最后一句（＝那一轮收束）
    await session.wait({ text: '看到后台跑完了' }, { timeoutMs: 30_000 })
    await settled(session)

    const shot = await session.capture({ label: '01-后台跑完了（给屏那一声）' })
    keep(shot)
    console.log(
      '\n（上面这一屏是**给屏**的那一声——那是 UI，不是注入；本单不改它，留它只作对照。）',
    )

    const found = injectedFrom(fixture, '后台命令跑完了')
    if (found === undefined) throw new Error('端点一次都没收到「后台命令跑完了」那一条——这一趟白跑了')

    const text = keepPayload(options.assert ? '端点原文-后台' : '端点原文', found.text)

    if (!options.assert) return

    const lines = text.split('\n')
    check(found.role === 'user', '① 它走的是**交代那条通道**（`user` 消息，不是伪造的 system）', found.role)
    check(lines.length === 2, '① **两行**（怎么了 ＋ 输出在哪儿）——不多说第三件', text)
    check(
      lines[0]?.startsWith('〔后台命令跑完了〕bg-1（exit 0）· echo U81起手;') === true,
      '① 第一行是**陈述**：哪一条 · 什么结局 · 退出码 · 命令首行',
      lines[0] ?? '',
    )
    check(
      lines[1] === `完整输出在 ${outputPath}`,
      '② 第二行**只报「输出在哪儿」这一件事实**——不再吩咐它去读',
      lines[1] ?? '',
    )
    checkFactual(text, '② 整条')

    // **给屏那一声**与给模型那一条是两件事（设计明写）——顺带把界线钉在这儿
    check(has(shot, 'bg-1 跑完了'), '③ 给屏那一声照旧（`· bg-1 跑完了（exit 0）· …`）——本单没动它', shot.text)
    // ⚠️ 按**路径尾巴**认，不按整条路径：屏上那一行会随宽度折行，整串在任一单行里都找不到
    //（同 `frames-u70-tui.ts` 那一处的判法）
    check(has(shot, `/bg/bg-1.log`), '③ 给屏那一声也带着那个路径', shot.text)
  } finally {
    if (session !== undefined) {
      try {
        await session.quit()
      } finally {
        await session.close({ graceMs: 3_000 })
      }
    }
    await fixture.stop()
    sandbox.dispose()
  }
}

// ══ 场二 · 计划笔记那一条（第二处注入）══════════════════════════════

/**
 * **计划笔记被清空 ⇒ 端点收到的那一条**（`plan.ts` 的 `planMaterialOf`）。
 *
 * 挑这一条作第二处：它**不是** U70 那条（本单要证明盘的不止已知那一处），而它**进上下文**
 * 这件事平时看不出来——它**不是**任何一次工具调用的回执，是我们**另起一条消息**塞进去的。
 * 触发条件：清空那一条在窗口里看得见、而更早那份计划的正文也还在（不消歧，旧计划会冒充
 * 「当前计划」）——故剧本是「建立一份 → 再清掉」。
 *
 * ⚠️ 它走的是 `role: 'assistant'`（`plan.ts` 明写：不用 system、也不伪造用户消息）——
 * 本单不动这个框架，只判**话读着是不是陈述**。
 */
async function scenePlan(): Promise<void> {
  const turns: FixtureTurn[] = [
    {
      kind: 'tool',
      name: 'plan_update',
      args: {
        plan: { steps: [{ text: '盘一遍注入点', status: 'in_progress' }], notes: 'U81 的活儿' },
      },
      text: '先把计划记下来。',
    },
    { kind: 'text', text: '记好了。' },
    { kind: 'tool', name: 'plan_update', args: { plan: null }, text: '这件事做完了。' },
    { kind: 'text', text: '计划清掉了。' },
  ]

  const scene = await openScene({ label: 'u81-计划', turns })

  try {
    await typeLine(scene.session, '记一份计划')
    await scene.session.key('enter')
    await scene.session.wait({ text: '记好了' }, { timeoutMs: 30_000 })
    await settled(scene.session)

    await typeLine(scene.session, '做完了，清掉计划')
    await scene.session.key('enter')
    await scene.session.wait({ text: '计划清掉了' }, { timeoutMs: 30_000 })
    await settled(scene.session)

    const shot = await scene.session.capture({ label: '02-计划清空（给屏）' })
    keep(shot)

    const found = injectedFrom(scene.fixture, '当前计划笔记已清空')
    if (found === undefined) throw new Error('端点没收到「当前计划笔记已清空」那一条——剧本没造出那一形')

    const text = keepPayload('端点原文-计划', found.text)
    const lines = text.split('\n')

    check(found.role === 'assistant', '① 这一条走的是 `assistant` 那条（`plan.ts` 的既定框架，本单不动）', found.role)
    check(lines[0]?.startsWith('〔当前计划笔记已清空 · 记录 #') === true, '① 抬头点得清是哪一条、在记录里的哪儿', lines[0] ?? '')
    check(
      lines[1] === '（此前那份计划已不再有效；过程仍在会话记录里。）',
      '② 第二行是**陈述**（说清「旧的那份不再有效」，不吩咐它做事）',
      lines[1] ?? '',
    )
    checkFactual(text, '② 整条')
  } finally {
    await closeScene(scene)
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u81-') : (process.argv[at + 1] as string)
  const only = process.argv.includes('--only')
    ? (process.argv[process.argv.indexOf('--only') + 1] as string)
    : ''
  mkdirSync(root, { recursive: true })
  out = root

  const wanted = (name: string): boolean => only === '' || only === name

  try {
    if (wanted('后台')) {
      console.log('\n══ 场一 · 后台跑完那一条（已知那一处）══')
      await sceneBackground({ assert: true })
    }

    if (wanted('计划')) {
      console.log('\n══ 场二 · 计划笔记那一条（第二处）══')
      await scenePlan()
    }

    if (wanted('原文')) {
      console.log('\n══ 取原文 · 只后台那一处（一条判据都不判，给改前/改后对照用）══')
      await sceneBackground({ assert: false })
    }
  } finally {
    console.log(`\n帧落在 ${out}`)
  }
}
