#!/usr/bin/env bun
/**
 * U61 · **选择器的「层」与一套栈**——真 PTY 逐层走一遍，逐屏留帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析，不是拿视图对象算的）。模型那一头是
 * loopback 夹具（合成假 key）——**一个付费请求都不发**，真 `~/.magic` 零触碰。
 *
 * ## 判的是哪一件事
 *
 * 工单（U61）的验收原话：**真 PTY 逐层走一遍**——`/model` → `→` 详情 → 接入
 * （选供应商 → 选区域 → 问密钥），**每按一次 `←` 退一层**，逐屏留帧；**退到空那一跳＝收起**。
 * `Esc` 那一支对照：同一路上**任一深度**按 `Esc` **一律回到原稿**。
 *
 * ⚠️ **本单最容易做窄的一处**在这儿钉住：**栈的单位是「那一屏」，不是「那个选择器」**
 * ——接入那一路里**选择器与本地小输入交替**（选供应商 → 问密钥），**它们都是层**。
 * 走 B 与走 C 各走一趟这种交替（一条从命令行进、一条从入口行进）；只给 picker 加栈的
 * 实现在「问密钥那一屏按 `←` 」那一下当场露馅。
 *
 * ## 六趟
 *
 * | 走 | 故事 | 留下什么 |
 * | --- | --- | --- |
 * | **A** | `/model` → `→` 看详情 → `←` | 详情那一层退得回来，且列表焦点照旧 |
 * | **B** | `/model` →（入口行）连接供应商 → 选供应商 → 问密钥 →`←`×3 | **本单的要害**：选错家想重选 |
 * | **C** | `/model manage` → 明细 → 更新认证（问密钥）→`←`×2 | **选择器 → 本地小输入**交替的另一条 |
 * | **D** | 问密钥那一屏按 `Esc` | **一律全收**：与按之前逐字相同（对照走 B） |
 * | **E** | `/attachments` → 详情 →`←`×2 | **另一条多级的**（不能只给 `/model` 加层） |
 * | **F** | `/resume` → `←` | **一级的顺手统一**：`←` 也收起，不特殊对待 |
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u61-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HINT_IDLE } from '@magic/tui'
import { createUiSession } from './ui/index.ts'
import type { Capture, UiSession, WaitCondition } from './ui/index.ts'
import { tempDir } from './tmp.ts'

/** 写一次并等一个条件（驱动那个 `WriteUntil` 没有出包，按它那份形写一份）。 */
type WriteUntil = { readonly until: WaitCondition; readonly timeoutMs?: number }

/** 1×1 真 PNG（67 字节）——走 E 要一张**送过的图**。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 本趟要问的那几屏上**只在那一屏才有**的一句字（各自都是「抽屉真开了」的锚）。 */
const ANCHOR = {
  /** `/model` 列表：末尾那三条入口行（U41 起常驻）。 */
  list: '连接供应商',
  /** 挑一家那一屏：内置供应商的名字。 */
  vendor: 'DeepSeek',
  /** 问密钥那一屏：那行说明里的一句（`askKeyFor` 给）。 */
  key: '留空＝改用环境变量',
  /** 管理一览：下方那句说明。 */
  manage: '回车＝管理这一条',
  /** 管理明细：主语那一行。 */
  detail: '连接 local',
} as const

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
 * 由头与 `frames-u36-tui.ts` 那一条同：PTY 上两次写挨得太近时，应用一次 read 会把它们
 * 并成一块读进来（回车于是成了正文里的一个控制字符）。
 */
async function pressKey(
  session: UiSession,
  name: 'enter' | 'esc' | 'left' | 'right' | 'down',
  until?: WriteUntil,
): Promise<void> {
  await Bun.sleep(150)
  await session.key(name, until)
}

/** 屏上有没有这一行。 */
function has(shot: Capture, needle: string): boolean {
  return shot.lines.some((line) => line.includes(needle))
}

/** 那个抽屉（/ 小输入）此刻在不在屏上——判「这一屏退了没退」看它。 */
function shows(shot: Capture, needle: string): boolean {
  return has(shot, needle)
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u61-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  const sessions: UiSession[] = []
  /** 起一个真 UI 会话（都落在同一个产物根下；两条连接 ＋ 一个模型，`/model` 那一屏才有东西可列）。 */
  const open = (label: string, turns = [{ kind: 'text' as const, text: '收到，我在。' }]) =>
    createUiSession({
      label,
      columns: 100,
      rows: 30,
      artifacts: join(out, 'runs'),
      turns,
      config: {
        providers: {
          local: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-fake-u61', model: 'MiniMax-M3' },
          backup: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-fake-u61', model: 'MiniMax-M2' },
        },
      },
    })

  /**
   * 起一个**接在 loopback 夹具上**的会话（缺省配置）——**要真送出去一条**才用得上它。
   *
   * 上面那一支的 `baseURL` 指的是一台没人听的 `127.0.0.1:9`：走 A～D 只按键、不发请求，
   * 那一格无所谓；走 E 要**真送一张图**（`/attachments` 那一屏才有东西可列），故走缺省
   * （`createUiSession` 自己起的夹具，合成假 key、一个付费请求都不发）。
   */
  const openOnFixture = (label: string) =>
    createUiSession({
      label,
      columns: 100,
      rows: 30,
      artifacts: join(out, 'runs'),
      turns: [{ kind: 'text' as const, text: '看了，是空指针。', chunks: 3, chunkDelayMs: 40 }],
    })

  const close = async (session: UiSession): Promise<void> => {
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 10_000 }).catch(() => undefined)
    await session.quit()
    const report = await session.close({ graceMs: 3_000 })
    const how = `${report.exit.by}（code ${report.exit.code ?? '-'}）`
    if (report.exit.by !== 'app') throw new Error(`应用不是自己走的（${how}）——收摊那条路没走完`)
    console.log(`  · 收摊：${how} · 帧 ${report.frames} 张 · 现场 ${report.runDir}`)
  }

  /** 开 `/model` 那一屏（打命令 → 回车 → 等列表铺出来）。 */
  const openModel = async (session: UiSession): Promise<void> => {
    await typeLine(session, '/model')
    await pressKey(session, 'enter', { until: { text: ANCHOR.list }, timeoutMs: 15_000 })
  }

  try {
    // ══ 走 A · `/model` → `→` 看详情 → `←` 退回列表 ══════════════════
    {
      const session = await open('u61-详情那一层')
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await openModel(session)

      const list = await session.capture({ label: 'A1-模型列表' })
      keep(list, 'A1-模型列表')
      check(shows(list, ANCHOR.list), 'A1：列表铺出来了（末尾那三条入口行在）')
      check(
        list.lines.some((line) => line.includes('→ 看这条的详情')),
        'A1：下方说明报出了 `→` 那一层（进得去）',
      )

      // 挪到**第二条**再进详情——回来时焦点得还在这一格（「弹回来要回到原处」）
      await pressKey(session, 'down')
      await pressKey(session, 'right', { until: { text: '设为默认' }, timeoutMs: 10_000 })
      const detail = await session.capture({ label: 'A2-详情那一屏（按 → 进的一层）' })
      keep(detail, 'A2-详情那一屏（按 → 进的一层）')
      check(has(detail, '设为默认'), 'A2：进了详情那一屏（`→` 那一层）')
      check(has(detail, '← 退'), 'A2：键位提示报出了 `← 退`')

      await pressKey(session, 'left', { until: { text: ANCHOR.list }, timeoutMs: 10_000 })
      const back = await session.capture({ label: 'A3-按 ← 退回列表' })
      keep(back, 'A3-按 ← 退回列表')
      check(has(back, '→ 看这条的详情'), 'A3：退回列表那一屏（`←` 弹一层，不是全收）')

      await pressKey(session, 'left', { until: { text: HINT_IDLE }, timeoutMs: 10_000 })
      const gone = await session.capture({ label: 'A4-再按 ← 收起（弹到空）' })
      keep(gone, 'A4-再按 ← 收起（弹到空）')
      check(!has(gone, ANCHOR.list), 'A4：弹到空＝收起（列表不在了，回到输入行）')
      await close(session)
    }

    // ══ 走 B · 本单的要害：问密钥 →「←」→ 选供应商 ══════════════════
    {
      const session = await open('u61-接入那一路')
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await openModel(session)

      // 挪到入口行「连接供应商」（两条模型行之后）
      for (let step = 0; step < 2; step += 1) await pressKey(session, 'down')
      await pressKey(session, 'enter', { until: { text: ANCHOR.vendor }, timeoutMs: 15_000 })
      const vendor = await session.capture({ label: 'B1-接入第一步：挑一家' })
      keep(vendor, 'B1-接入第一步：挑一家')
      check(has(vendor, 'MiniMax') && has(vendor, 'DeepSeek'), 'B1：挑一家那一屏（内置两家都在）')

      // 选定一家 ⇒ **问密钥那一屏**（本地小输入——它也是一层）
      await pressKey(session, 'enter', { until: { text: ANCHOR.key }, timeoutMs: 10_000 })
      const ask = await session.capture({ label: 'B2-接入第二步：问密钥（本地小输入）' })
      keep(ask, 'B2-接入第二步：问密钥（本地小输入）')
      check(has(ask, '输入不回显'), 'B2：问密钥那一屏开着（不回显）')
      check(has(ask, '← 退'), 'B2：**这一屏的键位提示也带 `←`**（本地小输入也是层）')

      // ⚠️ 本单的要害：在这一屏按 `←` —— 退回选供应商（**不是全收**）
      await pressKey(session, 'left', { until: { text: ANCHOR.vendor }, timeoutMs: 10_000 })
      const popped = await session.capture({ label: 'B3-要害：问密钥按 ← 退回选供应商' })
      keep(popped, 'B3-要害：问密钥按 ← 退回选供应商')
      check(has(popped, 'MiniMax'), 'B3：退回了**选供应商**那一屏（本地小输入也是一层）')
      check(!has(popped, '输入不回显'), 'B3：问密钥那一屏真的下去了（不是叠着）')

      // 再按一次 ⇒ 退回 `/model` 列表（入口行进来的那一趟：底下压着列表）
      await pressKey(session, 'left', { until: { text: ANCHOR.list }, timeoutMs: 10_000 })
      const listAgain = await session.capture({ label: 'B4-再按 ← 退回模型列表' })
      keep(listAgain, 'B4-再按 ← 退回模型列表')
      check(has(listAgain, '→ 看这条的详情'), 'B4：退回了 `/model` 列表那一屏')

      // 再按一次 ⇒ 弹到空 ＝ 收起
      await pressKey(session, 'left', { until: { text: HINT_IDLE }, timeoutMs: 10_000 })
      const home = await session.capture({ label: 'B5-再按 ← 收起（弹到空）' })
      keep(home, 'B5-再按 ← 收起（弹到空）')
      check(!has(home, ANCHOR.list), 'B5：弹到空＝收起（回到输入行）')
      await close(session)
    }

    // ══ 走 C · 管理明细 → 更新认证（**选择器 → 本地小输入**的另一条）════
    {
      const session = await open('u61-管理那一趟')
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await typeLine(session, '/model manage')
      await pressKey(session, 'enter', { until: { text: ANCHOR.manage }, timeoutMs: 15_000 })
      await pressKey(session, 'enter', { until: { text: ANCHOR.detail }, timeoutMs: 15_000 })
      const detail = await session.capture({ label: 'C1-连接明细那一屏' })
      keep(detail, 'C1-连接明细那一屏')
      check(has(detail, '更新认证'), 'C1：明细那一屏（四件动作都在）')

      // 挪到「更新认证」⇒ 问密钥那一屏（本地小输入）
      await pressKey(session, 'down')
      await pressKey(session, 'enter', { until: { text: '输入不回显' }, timeoutMs: 10_000 })
      const ask = await session.capture({ label: 'C2-更新认证：问密钥那一屏' })
      keep(ask, 'C2-更新认证：问密钥那一屏')
      check(has(ask, '← 退'), 'C2：这一屏照样报 `←`')

      await pressKey(session, 'left', { until: { text: ANCHOR.detail }, timeoutMs: 10_000 })
      const back = await session.capture({ label: 'C3-按 ← 退回明细' })
      keep(back, 'C3-按 ← 退回明细')
      check(has(back, '更新认证') && has(back, '移除这条连接'), 'C3：退回了明细那一屏（一次一层）')

      await pressKey(session, 'left', { until: { text: ANCHOR.manage }, timeoutMs: 10_000 })
      const list = await session.capture({ label: 'C4-再按 ← 退回一览' })
      keep(list, 'C4-再按 ← 退回一览')
      check(has(list, ANCHOR.manage) && !has(list, '更新认证'), 'C4：退回了连接一览（明细那几件动作不在了）')

      await pressKey(session, 'left', { until: { text: HINT_IDLE }, timeoutMs: 10_000 })
      const home = await session.capture({ label: 'C5-再按 ← 收起' })
      keep(home, 'C5-再按 ← 收起')
      check(!has(home, ANCHOR.manage), 'C5：弹到空＝收起')
      await close(session)
    }

    // ══ 走 D · `Esc` 那一支对照：任一深度**一律全收** ════════════════
    {
      const session = await open('u61-esc对照')
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await typeLine(session, '/model connect')
      await pressKey(session, 'enter', { until: { text: ANCHOR.vendor }, timeoutMs: 15_000 })
      await pressKey(session, 'enter', { until: { text: ANCHOR.key }, timeoutMs: 10_000 })

      const deep = await session.capture({ label: 'D1-最深处：问密钥那一屏' })
      keep(deep, 'D1-最深处：问密钥那一屏')
      check(has(deep, '← 退') && has(deep, 'esc 取消'), 'D1：这一屏**两个键分开报**（`←` 退一层 / `esc` 取消）')

      // **一按到底**（不是退一层）——与走 B 的 `←` 对照
      await pressKey(session, 'esc', { until: { text: HINT_IDLE }, timeoutMs: 10_000 })
      const out2 = await session.capture({ label: 'D2-按 esc 一按到底（回到原稿）' })
      keep(out2, 'D2-按 esc 一按到底（回到原稿）')
      check(!has(out2, '输入不回显'), 'D2：`esc` **一律全收**（一按到底，不问深度）')
      check(!has(out2, ANCHOR.vendor), 'D2：底下那几屏也一并收掉了（栈随输入行清空）')
      check(has(out2, '› '), 'D2：回到输入行（原稿那一行在）')
      await close(session)
    }

    // ══ 走 E · `/attachments`：列表 → 详情（**另一条多级的**）═════════
    {
      const session = await openOnFixture('u61-图片那两屏')
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })

      // 先真送一张图（`@` 选入 → 提交）——`/attachments` 那一屏才有东西可列
      const { workspace } = session.facts()
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, '报错.png'), PNG)

      // ⚠️ 等的是**输入行上那一行**（`› 看`）——行尾那个空格会被抹掉，
      //    拿 `'看 '` 当锚是等不到的（实测超时）。
      await session.send('看 ', { until: { text: '› 看' }, timeoutMs: 10_000 })
      await session.send('@', { until: { text: '@' }, timeoutMs: 10_000 })
      await session.send('报错', { until: { text: '@报错' }, timeoutMs: 10_000 })
      await pressKey(session, 'enter', { until: { text: '报错.png' }, timeoutMs: 10_000 })
      await typeLine(session, '这张')
      await pressKey(session, 'enter', { until: { text: '看了，是空指针。' }, timeoutMs: 20_000 })
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })

      // ⚠️ 锚要挑**只有那一屏才有**的那一句：`加入本次输入` 也是命令候选那一行的字
      //    （`/attachments　送过的图片：查看原图 · 加入本次输入`），拿它当锚等于没等。
      await typeLine(session, '/attachments')
      await pressKey(session, 'enter', { until: { text: '选定一张看能做什么' }, timeoutMs: 15_000 })
      const list = await session.capture({ label: 'E1-图片列表那一屏' })
      keep(list, 'E1-图片列表那一屏')
      check(has(list, '报错.png'), 'E1：列表列着那张图')

      await pressKey(session, 'enter', { until: { text: '两条都只做那一件事' }, timeoutMs: 10_000 })
      const detail = await session.capture({ label: 'E2-详情那一屏（两条动作）' })
      keep(detail, 'E2-详情那一屏（两条动作）')
      check(has(detail, '查看原图') && has(detail, '加入本次输入'), 'E2：详情两条动作都在')

      await pressKey(session, 'left', { until: { text: '选定一张看能做什么' }, timeoutMs: 10_000 })
      const back = await session.capture({ label: 'E3-按 ← 退回列表' })
      keep(back, 'E3-按 ← 退回列表')
      check(has(back, '报错.png'), 'E3：退回了列表那一屏（**不是只给 `/model` 加层**）')

      await pressKey(session, 'left', { until: { text: HINT_IDLE }, timeoutMs: 10_000 })
      const home = await session.capture({ label: 'E4-再按 ← 收起' })
      keep(home, 'E4-再按 ← 收起')
      check(!has(home, '报错.png　'), 'E4：弹到空＝收起')
      await close(session)
    }

    // ══ 走 F · `/resume`：一级的按 `←` 也收起（顺手统一）═════════════
    {
      const session = await openOnFixture('u61-一级那些屏')
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await typeLine(session, '甲这一条')
      await pressKey(session, 'enter', { until: { text: '看了，是空指针。' }, timeoutMs: 20_000 })
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })

      await typeLine(session, '/resume')
      await pressKey(session, 'enter', { until: { text: '正在用' }, timeoutMs: 15_000 })
      const list = await session.capture({ label: 'F1-会话列表那一屏' })
      keep(list, 'F1-会话列表那一屏')
      check(has(list, '← 退'), 'F1：一级那一屏的提示里也报了 `←`')

      await pressKey(session, 'left', { until: { text: HINT_IDLE }, timeoutMs: 10_000 })
      const home = await session.capture({ label: 'F2-按 ← 收起（一级的也一样）' })
      keep(home, 'F2-按 ← 收起（一级的也一样）')
      check(!has(home, '正在用'), 'F2：一级的按 `←` 就是收起（不特殊对待）')
      await close(session)
    }
  } finally {
    for (const session of sessions) {
      // 上面每一趟自己收过了；这里是兜底（`close` 幂等由驱动那边保证不了，故只清现场）
      await session.close({ graceMs: 1_000, keepSandbox: true }).catch(() => undefined)
    }
  }

  console.log(`\n现场与帧：${out}`)
}
