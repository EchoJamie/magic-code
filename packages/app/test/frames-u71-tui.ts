#!/usr/bin/env bun
/**
 * U71 · **`/config`：一屏看得见「现在配成什么样」**——真 PTY 逐屏留帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析，不是拿视图对象算的）。模型那一头是
 * loopback 夹具（合成假 key）——**一个付费请求都不发**，真 `~/.magic` 零触碰。
 *
 * ## 判的是哪一件事（工单 U71 的「领取者自行验收」四条）
 *
 * | 走 | 故事 | 判什么 |
 * | --- | --- | --- |
 * | **A** | `/config` 开屏 → 打字筛 → 退格 → 带筛按 `esc` | ① 每行看得到当前值且对得上 ② 打字即过滤、退格清过滤 ③ `esc` **一下**全收（不是先清过滤） |
 * | **B** | 选中「模型与连接」 ⇒ `/model` 那一屏；另起一趟**直接敲 `/model`** | ④ 两趟**逐字同形** |
 * | **C** | 在那一屏里换一个模型 → 回 `/config` 再看一遍 | ① 的后半：**改过之后值跟着变** |
 * | **D** | 选中「数据目录与工作区根」 | 第 4 项自己那一屏：**没缩过的全路径** |
 * | **E** | **手改 `config.json`**（加一条连接 ＋ 加一台外部工具）→ 用同一块沙地重开 | ① 的后半，**字面那一形**：配置改了，一屏上的值就跟着变 |
 * | **F** | **46 列窄窗**上开这一屏 | 布局那一关：长值**截断**（不折行、不把行撑乱），右列照旧对齐 |
 *
 * ⚠️ **A 那一趟的配置里带一台真的外部工具服务器**（`packages/mcp/test/support/fake-server.ts`
 * ——真进程、真 MCP 协议）：不配的话「外部工具」那一格只能是「还没配」，而这一屏要证的是
 * **每一格都报得出现在的实情**。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u71-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HINT_IDLE } from '@magic/tui'
import { REPO_ROOT, createSandbox, createUiSession } from './ui/index.ts'
import type { Capture, UiSession, WaitCondition } from './ui/index.ts'
import { tempDir } from './tmp.ts'

/** 写一次并等一个条件（驱动那个 `WriteUntil` 没有出包，按它那份形写一份）。 */
type WriteUntil = { readonly until: WaitCondition; readonly timeoutMs?: number }

/** 这一趟要等的锚——**只有那一屏才有**的那一句（拿别处也有的字当锚等于没等）。 */
const ANCHOR = {
  /** `/config` 那一屏：最后一行那个项名（五行都在时它才在，故它一到＝这一屏铺全了）。 */
  config: '数据目录与工作区根',
  /** `/model` 那一屏：末尾那三条常驻入口行（U41）。 */
  model: '连接供应商',
} as const

/** 那一趟的产物根——入口解析 `--out` 之后填。 */
let out = ''

/** 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/** 留一屏——文本写进 `<out>/<序号>-<名字>.txt`，字格与光标写进同名 `.json`。 */
function keep(shot: Capture, label: string): void {
  writeFileSync(join(out, `${label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${label}.json`),
    `${JSON.stringify(
      { columns: shot.columns, rows: shot.rows, lines: shot.lines, cursor: shot.cursor },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${label} ──\n${shot.text}`)
}

/** 打一行字并**等它真出现在屏上**（按键丢了就等不到——不重发，如实失败）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/**
 * 按一个**非文字键**——先等一小会儿再写。
 *
 * 由头与 `frames-u61-tui.ts` 那一条同：PTY 上两次写挨得太近时，应用一次 read 会把它们
 * 并成一块读进来（回车于是成了正文里的一个控制字符）。
 */
async function pressKey(
  session: UiSession,
  name: 'enter' | 'esc' | 'left' | 'right' | 'up' | 'down' | 'backspace',
  until?: WriteUntil,
): Promise<void> {
  await Bun.sleep(150)
  await session.key(name, until)
}

/** 屏上有没有这一行。 */
function has(shot: Capture, needle: string): boolean {
  return shot.lines.some((line) => line.includes(needle))
}

/** 那一行在屏上的第几条（找不到＝`-1`）。 */
function rowOf(shot: Capture, needle: string): number {
  return shot.lines.findIndex((line) => line.includes(needle))
}

/**
 * 开出 `/config` 那一屏（打命令 → 回车 → **等最后那一行项名**）。
 *
 * ⚠️ 等最后那一行而不等第一行，是有由头的：这一屏**三份读数齐了才开**，故最后一行项名
 * 上屏＝五行都铺全了、四格的值也都填上了（少一份它压根不开）。等第一行则会撞上
 * 「屏刚铺到一半」的那一刻。
 */
async function openConfig(session: UiSession): Promise<void> {
  await typeLine(session, '/config')
  await pressKey(session, 'enter', { until: { text: ANCHOR.config }, timeoutMs: 20_000 })
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u71-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  const sessions: UiSession[] = []
  const fakeServer = join(REPO_ROOT, 'packages', 'mcp', 'test', 'support', 'fake-server.ts')

  /**
   * 起一个真 UI 会话。
   *
   * 配置：**两条连接**（第二条是给走 C「换一个模型」用的）＋ **一台真外部工具服务器**
   * （`fake-server.ts`，真进程真协议）——故五行各有各的实情可报。
   */
  const open = (label: string, columns = 100, rows = 30) =>
    createUiSession({
      label,
      columns,
      rows,
      artifacts: join(out, 'runs'),
      config: {
        defaultProvider: 'local',
        providers: {
          local: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-fake-u71', model: 'MiniMax-M3' },
          backup: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-fake-u71', model: 'MiniMax-M2' },
        },
        mcp: {
          servers: {
            fake: {
              command: process.execPath,
              args: [fakeServer],
              env: { FAKE_MCP_NAME: 'fake' },
            },
          },
        },
      },
    })

  /** 等它起完（`○ 空闲` 那一格——外壳受理输入了）。 */
  const booted = async (session: UiSession): Promise<void> => {
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 25_000 })
  }

  const close = async (session: UiSession): Promise<void> => {
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 10_000 }).catch(() => undefined)
    await session.quit()
    const report = await session.close({ graceMs: 3_000 })
    const how = `${report.exit.by}（code ${report.exit.code ?? '-'}）`
    if (report.exit.by !== 'app') throw new Error(`应用不是自己走的（${how}）——收摊那条路没走完`)
    console.log(`  · 收摊：${how} · 帧 ${report.frames} 张 · 现场 ${report.runDir}`)
  }

  try {
    // ══ 走 A · 开屏四问：① 值 ② 筛 ③ `esc` ═════════════════════════
    {
      const session = await open('u71-开屏与筛')
      sessions.push(session)
      await booted(session)
      await openConfig(session)

      const first = await session.capture({ label: 'A1-开屏（每行都看得见现在是什么）' })
      keep(first, 'A1-开屏（每行都看得见现在是什么）')
      // ① 五行都在，且每行右边都有值（不是空着）
      // ⚠️ **U78 起多一行「取网页用的模型」**（设计 · 命令行与配置：那一项随该功能落地再加）
      check(
        ['模型与连接', '取网页用的模型', '本工作区授权', '外部工具', '数据目录与工作区根'].every((name) =>
          has(first, name),
        ),
        'A1：五个可配项都在这一屏上',
      )
      check(has(first, 'MiniMax-M3 · local'), 'A1：「模型与连接」报的是**此刻走哪一条**')
      check(has(first, '还没有'), 'A1：「本工作区授权」报的是本工作区的实情（这一趟没按过 a）')
      check(has(first, '1 台'), 'A1：「外部工具」报的是**配了几台**（配置里那台真服务器在）')
      check(has(first, '取网页用的模型'), 'A1：U78 那一行在（这一趟配置里没给 `webFetch`）')
      check(
        first.lines.some((line) => line.includes('取网页用的模型') && line.includes('还没配')),
        'A1：它报的是**还没配**（不留空、不编一个默认）',
        first.lines.find((line) => line.includes('取网页用的模型'))?.trim() ?? '（没有那一行）',
      )
      // **右列对齐**：五行的值起于同一列（屏上量的，不是拿视图对象算的）
      const values = ['MiniMax-M3 · local', '还没配', '还没有', '1 台']
      const cols = values.map((value) => {
        const line = first.lines[rowOf(first, value)] ?? ''
        return line.indexOf(value)
      })
      check(
        cols.every((col) => col > 0) && new Set(cols).size === 1,
        'A1：右列的值**对齐**（四格的起始列相同）',
        `量到 ${JSON.stringify(cols)}`,
      )
      check(
        first.lines.some((line) => line.includes('数据目录与工作区根')),
        'A1：末行（数据目录与工作区根）也在',
      )
      check(has(first, '打字筛'), 'A1：右位提示报出了「打字筛」（不报，用户不知道打进去的字去哪了）')

      // ② 打字即过滤——**不出第二个搜索框**，打进去的字也不进草稿
      await session.send('授权', { until: { text: '筛选「授权」' }, timeoutMs: 10_000 })
      const filtered = await session.capture({ label: 'A2-打字即过滤（筛词报在列表下方）' })
      keep(filtered, 'A2-打字即过滤（筛词报在列表下方）')
      check(has(filtered, '本工作区授权'), 'A2：筛出那一项')
      check(!has(filtered, '模型与连接'), 'A2：其余三项被筛掉了（**打字即过滤**，没有第二个搜索框）')
      check(has(filtered, '› /config') === false, 'A2：输入行没有留着一个「搜索框」')
      check(has(filtered, '筛选「授权」——接着打收窄，退格删一个字'), 'A2：列表下方报出了筛词')

      // 退格清过滤——退到空＝全表
      await pressKey(session, 'backspace')
      await pressKey(session, 'backspace', { until: { text: '模型与连接' }, timeoutMs: 10_000 })
      const cleared = await session.capture({ label: 'A3-退格清过滤（退到空＝全表）' })
      keep(cleared, 'A3-退格清过滤（退到空＝全表）')
      check(
        ['模型与连接', '取网页用的模型', '本工作区授权', '外部工具', '数据目录与工作区根'].every((name) =>
          has(cleared, name),
        ),
        'A3：退到空＝**全表**（五行都回来了）',
      )

      // ③ `esc` 一下就全收——**过滤还开着时**也是（不是「先清过滤、再全收」）
      await session.send('授权', { until: { text: '筛选「授权」' }, timeoutMs: 10_000 })
      await pressKey(session, 'esc', { until: { text: HINT_IDLE }, timeoutMs: 10_000 })
      const out2 = await session.capture({ label: 'A4-带过滤按 esc（一下就全收）' })
      keep(out2, 'A4-带过滤按 esc（一下就全收）')
      check(!has(out2, '本工作区授权'), 'A4：**一下**就走了（不是先清过滤、再来一下）')
      check(has(out2, '› '), 'A4：回到原稿（输入行那一行在）')
      check(has(out2, HINT_IDLE), 'A4：右位提示回到空闲那一句')
      await close(session)
    }

    // ══ 走 B · ④「进那一项」与**直接敲那条命令**逐字同形 ═════════════
    {
      const direct = await open('u71-直敲-model')
      sessions.push(direct)
      await booted(direct)
      await typeLine(direct, '/model')
      await pressKey(direct, 'enter', { until: { text: ANCHOR.model }, timeoutMs: 20_000 })
      const viaDirect = await direct.capture({ label: 'B1-直接敲那条命令' })
      keep(viaDirect, 'B1-直接敲那条命令')

      const through = await open('u71-经config进-model')
      sessions.push(through)
      await booted(through)
      await openConfig(through)
      await pressKey(through, 'enter', { until: { text: ANCHOR.model }, timeoutMs: 20_000 })
      const viaConfig = await through.capture({ label: 'B2-从-config-选中模型与连接' })
      keep(viaConfig, 'B2-从-config-选中模型与连接')

      const differ = viaDirect.lines.findIndex((line, index) => line !== viaConfig.lines[index])
      check(has(viaConfig, ANCHOR.model), 'B2：进了 `/model` 那一屏（末尾那三条入口行在）')
      check(
        differ === -1 && viaDirect.lines.length === viaConfig.lines.length,
        'B：两趟屏**逐字同形**（同一命令、同一条路 —— 不是照抄一份）',
        differ === -1
          ? ''
          : `第 ${differ} 行不同：直敲「${viaDirect.lines[differ]}」／经 config「${viaConfig.lines[differ]}」`,
      )
      // 层规矩：从 `/config` 进去的那一趟 `←` 退回的是**它**（栈的单位是那一屏）
      await pressKey(through, 'left', { until: { text: ANCHOR.config }, timeoutMs: 10_000 })
      const back = await through.capture({ label: 'B3-按-←-退回-config-那一屏' })
      keep(back, 'B3-按-←-退回-config-那一屏')
      check(has(back, ANCHOR.config) && !has(back, ANCHOR.model), 'B3：退回了 `/config`（底下压着的那一屏）')

      await close(through)
      await close(direct)
    }

    // ══ 走 C · ① 的后半：**改过之后，值跟着变** ═════════════════════
    {
      const session = await open('u71-值跟着变')
      sessions.push(session)
      await booted(session)
      await openConfig(session)
      const before = await session.capture({ label: 'C1-换之前' })
      keep(before, 'C1-换之前')
      check(has(before, 'MiniMax-M3 · local'), 'C1：换之前那一格是 local 的 MiniMax-M3')

      // 从这一屏进 `/model`，挪到另一条连接的那个模型，回车换过去
      await pressKey(session, 'enter', { until: { text: ANCHOR.model }, timeoutMs: 20_000 })
      await pressKey(session, 'down')
      await pressKey(session, 'enter', { until: { text: '已换模型' }, timeoutMs: 15_000 })

      // 回 `/config` 再看一遍——**那一格必须跟着变**（读的是内核的现况，不是开局那份陈账）
      await openConfig(session)
      const after = await session.capture({ label: 'C2-换之后再看一遍' })
      keep(after, 'C2-换之后再看一遍')
      check(has(after, 'MiniMax-M2 · backup'), 'C2：那一格跟着变了（走 backup 的 MiniMax-M2）')
      check(!has(after, 'MiniMax-M3 · local'), 'C2：旧的去向不在了（不是两句话并存）')
      await close(session)
    }

    // ══ 走 D · 第 4 项自己那一屏：**没缩过的全路径** ═════════════════
    {
      const session = await open('u71-路径那一屏')
      sessions.push(session)
      await booted(session)
      await openConfig(session)

      // ⚠️ **四下**：U78 起「取网页用的模型」占了第 2 行，末行（数据目录与工作区根）是第 5 行
      for (let step = 0; step < 4; step += 1) await pressKey(session, 'down')
      // ⚠️ 等的是**抽屉收了**（右位提示空闲那句），不是那块输出出现：那两件事不是同一刻，
      //    只等正文会让取帧落在「屏刚换、光标还没归位」那一瞬（实测两趟同屏、光标读数不同）。
      await pressKey(session, 'enter', { until: { text: HINT_IDLE }, timeoutMs: 10_000 })
      const shot = await session.capture({ label: 'D1-第 4 项自己那一屏' })
      keep(shot, 'D1-第 4 项自己那一屏')

      const facts = session.facts()
      // 工作区根那一行写的是**执行域 realpath 之后的规范形**（macOS 上 `/var` 是个软链）
      check(has(shot, `  数据目录　${facts.dataDir}`), 'D1：数据目录写的是**全路径**（列表里那一格是缩过的）')
      check(
        has(shot, `  工作区根　${realpathSync(facts.workspace)}`),
        'D1：工作区根写的是**全路径**',
        `屏上：${shot.lines.find((line) => line.includes('工作区根')) ?? '（没有那一行）'}`,
      )
      check(!has(shot, ANCHOR.config), 'D1：抽屉收了（进那一屏＝离开列表）')
      await close(session)
    }

    // ══ 走 E · ①的后半（**字面那一形**）：手改 config.json，再看一遍 ═══
    {
      // **一块沙地开两个会话**（同一个家目录、同一份库）——「关掉、改配置、再开」那条路
      const sandbox = createSandbox()

      try {
        const first = await createUiSession({
          label: 'u71-改配置-改前',
          sandbox,
          columns: 100,
          rows: 30,
          artifacts: join(out, 'runs'),
        })
        sessions.push(first)
        await booted(first)
        await openConfig(first)
        const before = await first.capture({ label: 'E1-改之前（一条连接 · 没配外部工具）' })
        keep(before, 'E1-改之前（一条连接 · 没配外部工具）')
        check(has(before, 'MiniMax-M3 · local'), 'E1：改之前走的是 local 的 MiniMax-M3')
        check(has(before, '还没配'), 'E1：改之前「外部工具」那一格是「还没配」')
        await close(first)

        // **手改配置文件**——原样读回来、改两处、写回去（用户那条路就是它）
        const config = JSON.parse(readFileSync(sandbox.configPath, 'utf8')) as Record<string, unknown>
        const providers = config['providers'] as Record<string, unknown>
        providers['second'] = {
          baseURL: 'http://127.0.0.1:9/v1',
          apiKey: 'sk-fake-u71',
          model: 'MiniMax-M2',
        }
        config['defaultProvider'] = 'second'
        config['mcp'] = {
          servers: {
            fake: { command: process.execPath, args: [fakeServer], env: { FAKE_MCP_NAME: 'fake' } },
          },
        }
        writeFileSync(sandbox.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

        const second = await createUiSession({
          label: 'u71-改配置-改后',
          sandbox,
          columns: 100,
          rows: 30,
          artifacts: join(out, 'runs'),
        })
        sessions.push(second)
        await booted(second)
        await openConfig(second)
        const after = await second.capture({ label: 'E2-改之后再看一遍' })
        keep(after, 'E2-改之后再看一遍')
        check(has(after, 'MiniMax-M2 · second'), 'E2：「模型与连接」跟着配置改了（新加的那条 ＋ 新的默认）')
        check(has(after, '1 台'), 'E2：「外部工具」也跟着改了（配置里多了一台）')
        await close(second)
      } finally {
        // 外借的沙地**归借出方收拾**（驱动不动它）
        sandbox.dispose()
      }
    }

    // ══ 走 F · 窄窗（46 列）：长值**截断**，右列照旧对齐 ═════════════
    {
      const session = await open('u71-窄窗', 46, 30)
      sessions.push(session)
      await booted(session)
      await openConfig(session)

      const shot = await session.capture({ label: 'F1-46 列窄窗' })
      keep(shot, 'F1-46 列窄窗')
      check(has(shot, ANCHOR.config), 'F1：窄窗上五项照旧都在')
      // 长值**截断**（行尾一个 `…`），不是折行——折行会把整屏撑乱，`oneLine` 那一格就是管它的
      const truncated = shot.lines.filter((line) => line.includes('…')).length
      check(truncated >= 1, 'F1：长值截断（行尾 `…`），没有折成第二行', `带省略号的行 ${truncated} 条`)
      // 前三格的值在 46 列上摆得下（摆不下的第 4 行上一条已经量过）——故照 A1 那把尺子量对齐
      const cols = ['MiniMax-M3 · local', '还没有', '1 台'].map((value) => {
        const at = shot.lines.findIndex((line) => line.includes(value))
        return at === -1 ? -1 : (shot.lines[at] ?? '').indexOf(value)
      })
      check(
        cols.every((col) => col > 0) && new Set(cols).size === 1,
        'F1：窄窗上值那一列照旧对齐（三格同起一列）',
        `量到 ${JSON.stringify(cols)}`,
      )
      await close(session)
    }
  } finally {
    for (const session of sessions) {
      // 上面每一趟自己收过了；这里是兜底（只清现场，不重复断言退出码）
      await session.close({ graceMs: 1_000, keepSandbox: true }).catch(() => undefined)
    }
  }

  console.log(`\n现场与帧：${out}`)
}
