#!/usr/bin/env bun
/**
 * U60 · **「还没接供应商」这一形 ＋ 「接错了删不掉」**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真终端才说得清的那一件**：
 * 一个**干净机器**上第一次起 TUI 的人，**那一屏到底说了什么**。
 *
 * ## 为什么原先没人发现
 *
 * 留帧装置一直起的是「**一个合成供应商**」那一形（`createSandbox` 写死一条 `local`）
 * ⇒ 「0 供应商」**装置根本造不出来**，于是它一路没被验过——而它偏偏是新用户看见的第一屏。
 * 故本套第一件事就是**把那一形造出来**（`createSandbox({ provider: 'none' })`）。
 *
 * ## 四趟
 *
 * | 趟 | 起手那一屏 | 要看见什么 |
 * | --- | --- | --- |
 * | ① **零供应商** | 空配置（配置文件**根本不落**） | 起手就说缺什么/怎么接/在哪儿；发一句**当场说清**且**不装作在跑**；`/model` 照旧 |
 * | ② **接上再删掉** | 一条连接（就是当前那条） | 删得掉（原先死锁）· 删完**当场说清**· 当前回到「没有」 |
 * | ③ **删掉其中一条** | 两条连接 | 删非当前那条 ⇒ 只报「已断开」· **不悄悄换到另一条** |
 * | ④ **反面** | 一条连接（当前） | 那一屏**一个字都不许多**（起手那句不得常驻） |
 *
 * ## 判据怎么咬
 *
 * 三形都**逐行读过**（`keep` 落的帧就是读的那一份），且都拿**读数**做旁证：
 * ①的「不装作在跑」看状态那一格（`○ 空闲`，不是 `● 工作中`）与**没有 `▲ 出错`**；
 * ②③的「真删掉了」**读配置文件**，不看屏上那句话。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u60-tui.ts --out <目录>
 * ```
 */

import { readFileSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { placeholderOf } from '@magic/tui'
import { statusLineOf } from './ui/index.ts'
import { createSandbox, createUiSession } from './ui/index.ts'
import type { Capture, Sandbox, UiSession } from './ui/index.ts'
import { removeDir, tempDir } from './tmp.ts'

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

/** 留一屏——文本写进 `<out>/<序号-名字>.txt`，字格写进同名 `.json`。 */
function keep(shot: Capture): void {
  writeFileSync(join(out, `${shot.label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${shot.label}.json`),
    `${JSON.stringify({ lines: shot.lines, cells: shot.lines.map((_l, row) => shot.cellsOf(row)) }, null, 1)}\n`,
    'utf8',
  )
}

/** 折行的判据要**接起来读**（窄窗上长句会被劈成两截）。 */
const flat = (lines: readonly string[]): string => lines.map((line) => line.trim()).join('')

/** 屏上**记录区那一行**（`· ` 开头）——回执都长这样。 */
const receipts = (lines: readonly string[]): readonly string[] =>
  lines.map((line) => line.trim()).filter((line) => line.startsWith('· '))

/** 等一个条件在**可见屏**上成立（默认 20 秒）。 */
async function waitUntil(
  session: UiSession,
  what: string,
  ok: (lines: readonly string[]) => boolean,
  timeoutMs = 20_000,
): Promise<readonly string[]> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6
  for (;;) {
    const screen = await session.screen()
    const lines = screen.lines.map((line) => line.text)
    if (ok(lines)) return lines
    if (Bun.nanoseconds() > until) {
      throw new Error(`等「${what}」超时（${timeoutMs}ms）。屏：\n${lines.join('\n')}`)
    }
    await Bun.sleep(40)
  }
}

/** 等屏上出现某句话——起手那几句回执都是这么等的。 */
const waitText = (session: UiSession, text: string, timeoutMs?: number): Promise<readonly string[]> =>
  waitUntil(session, `屏上出现「${text}」`, (lines) => flat(lines).includes(text), timeoutMs)

/** 敲一行字（先等它落到输入行上，再交给调用方按回车）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 读一次沙地上的配置文件（没那份文件＝`undefined`——那正是「干净机器」那一形）。 */
function configOn(sandbox: Sandbox): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(sandbox.configPath, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 配置里那几条连接的 id（没有文件 / 没有 `providers` ⇒ 空数组）。 */
function connectionsOn(sandbox: Sandbox): readonly string[] {
  const providers = configOn(sandbox)?.['providers']

  return typeof providers === 'object' && providers !== null ? Object.keys(providers) : []
}

/**
 * 屏上**输入行**那一条（`› ` 那个框里的字；空着＝`''`）。
 *
 * 取法：状态行（`○ 空闲` / `● 工作中` …）往上**跳过那条分隔线**，第一条不是线的就是它。
 *
 * ⚠️ **为什么是「往上找」而不是「上面那一格」**（U67 顺手修的一处**存量红**）：
 * 这一段原写「状态行上面**紧挨着**的那一行就是它」，那对应的是**U59 之前**的布局
 * （记录区 → 分隔线 → 输入行 → 状态行）。U59 把下沿那条线挪到**输入区与状态行之间**
 * 之后，紧挨状态行的成了**那条线本身**——于是这一支恒返回 `────…`，
 * 「输入行是空的」那一条**在基线上就红着**（U67 复现确认：`2411fec` 上同样一处红，
 * 与 U67 无关）。故这儿改成按**布局**找（跳过线），不再按「差一格」找。
 *
 * ⚠️ **不能整屏找 `› `**：记录区里也有以它开头的行——那是**回显**，不是输入行。
 */
function inputLineOf(lines: readonly string[]): string {
  const status = lines.findIndex((line) => /[○●▲◇]\s/u.test(line.trim()))
  if (status <= 0) return ''

  let at = status - 1
  while (at > 0 && /^─+$/u.test((lines[at] ?? '').trim())) at -= 1

  return (lines[at] ?? '').replace(/^\s*›\s?/u, '').trim()
}

/** 打开一根抽屉并把它收起来（`esc`）——取一帧就走。 */
async function openAndKeep(session: UiSession, command: string, label: string): Promise<Capture> {
  await typeLine(session, command)
  await session.key('enter')
  await Bun.sleep(1_200)
  const shot = await session.capture({ label })
  keep(shot)

  return shot
}

/**
 * **① 零供应商那一趟**——干净机器上的第一个用户看见的东西。
 *
 * 宽窄各一遍（除了尺寸，判据一字不改）。窄窗上那句回执会折行，故判据一律 `flat` 接起来读。
 */
async function unconfigured(mark: string, columns: number, rows: number): Promise<void> {
  const sandbox = createSandbox({ provider: 'none' })
  let session: UiSession | undefined

  try {
    // **装置那一侧先立住**：配置文件**根本没落**（这才是干净机器的原样）
    check(
      configOn(sandbox) === undefined,
      `【${mark}】空配置的沙地：配置文件**不落**（干净机器那一形）`,
      sandbox.configPath,
    )
    check(connectionsOn(sandbox).length === 0, `【${mark}】沙地上一条连接都没有`)

    session = await createUiSession({
      label: `u60-零供应商-${mark}`,
      sandbox,
      columns,
      rows,
      artifacts: join(out, 'runs'),
    })
    await session.wait({ text: '空闲' }, { timeoutMs: 25_000 })

    // —— 形①：起手那一屏 ——
    const boot = await session.capture({ label: `${mark}-01-起手` })
    keep(boot)
    const bootText = flat(boot.lines)
    check(
      bootText.includes('还没有接上供应商'),
      '【形①】起手那一屏**说了缺什么**（还没有接上供应商）',
      bootText.slice(0, 300),
    )
    check(
      bootText.includes('/model connect'),
      '【形①】说了**怎么接**（/model connect）',
      receipts(boot.lines).join(' / '),
    )
    check(
      bootText.includes('/model 那一屏第一条就是它'),
      '【形①】说了**在哪儿**（/model 那一屏第一条就是它）',
      receipts(boot.lines).join(' / '),
    )
    check(
      statusLineOf(boot.lines).includes('○ 空闲'),
      '【形①】状态行**照旧**（没给「未配置」加常驻回显——那格仍是空闲）',
      statusLineOf(boot.lines),
    )

    // —— 形②：直接发一句 ——
    await typeLine(session, '你好')
    await session.key('enter')
    await waitText(session, '没送出')

    // ⚠️ **停一拍再看**：要判「没有装作在跑」，就不能在那一瞬取样——
    //    真出问题（改回走模型那一趟）时它会先闪「工作中」再落到「出错」，那一拍之后才分得出来
    await Bun.sleep(1_500)
    const sent = await session.capture({ label: `${mark}-02-发一句之后` })
    keep(sent)
    const sentText = flat(sent.lines)
    const sentStatus = statusLineOf(sent.lines)

    check(
      sentText.includes('没送出：还没有接上供应商'),
      '【形②】发一句**当场说清**为什么发不出去',
      receipts(sent.lines).join(' / '),
    )
    check(
      sentText.includes('/model connect'),
      '【形②】并且说了**怎么办**（/model connect）',
      receipts(sent.lines).join(' / '),
    )
    check(
      sentText.includes('原稿在 ↑ 里'),
      '【形②】说了**稿子去哪儿了**（原稿在 ↑ 里——下一步要敲的是命令，稿子不占着输入行）',
      receipts(sent.lines).join(' / '),
    )
    check(
      sentStatus.includes('○ 空闲') && !sentStatus.includes('出错'),
      '【形②】**没装作在跑**：状态那一格是「○ 空闲」，不是「● 工作中」也不是「▲ 出错」',
      sentStatus,
    )
    check(
      !sentText.includes('工作中'),
      '【形②】屏上**一处都没写「工作中」**（那一轮压根没开）',
      sentText.slice(0, 300),
    )
    check(
      !sentText.includes('另一条会话'),
      '【形②】没有那条**串门的回执**（「另一条会话出错了」——那一轮压根没开，自然没有它）',
      receipts(sent.lines).join(' / '),
    )
    // 输入行**空着**（稿子不占着它——下一步要敲的是 `/model connect`）
    check(
      !/^› .*你好/mu.test(sent.lines.slice(-4).join('\n')),
      '【形②】输入行**没被稿子占着**（`/` 那一下不会接在「你好」尾巴上）',
      sent.lines.slice(-4).join(' / '),
    )

    // —— 形③：`/model` 那一屏 ——
    const model = await openAndKeep(session, '/model', `${mark}-03-model-那一屏`)
    // ⚠️ **只在分隔线之下读**：记录区里也有「没送出…」那几行（它们带着同一个词）
    const divider = model.lines.findIndex((line) => /^─{8,}$/u.test(line.trim()))
    const dock = flat(divider === -1 ? [] : model.lines.slice(divider + 1))

    check(dock.includes('连接供应商'), '【形③】`/model` 那一屏第一条就是「连接供应商」', dock)
    check(
      dock.includes('还没有接上任何供应商'),
      '【形③】`/model` 那一屏照旧说了那句（它是好的，本单一个字都不动）',
      dock,
    )
    check(
      model.text.includes('/model connect') || dock.includes('连接供应商'),
      '【形③】起手那句指的**在哪儿**，正是这一屏',
    )

    await session.key('esc')
    await Bun.sleep(300)

    // —— 「原稿在 ↑ 里」那句**不是空口**（U60）——
    // 那一句是回执照抄给用户的一句实话：稿子不还回输入行，就得**真**翻得回来。
    // 不验的话，这句话就是我们在替产品吹牛（而它恰恰是这一形唯一的「东西没丢」凭证）。
    await typeLine(session, '改完再发')
    await session.key('enter')
    // ⚠️ **不能等「没送出」那三个字**：头一次那条回执还在屏上，条件**当场为真**
    //    （实测栽过——读到的还是没提交之前的那一帧）。数**第二条**才对得上。
    await waitUntil(
      session,
      '第二条也拦下了（两条「没送出」）',
      (lines) => lines.filter((line) => line.trim().startsWith('· 没送出')).length >= 2,
    )
    const beforeUp = await session.capture({ label: `${mark}-11-翻之前` })
    // 「空着」＝**它回到了那句占位提示**（空闲态那一句，产品自己的常量）
    check(
      inputLineOf(beforeUp.lines) === placeholderOf('idle'),
      '【形②·尾】拦下来之后输入行**是空的**（回到占位那一句——稿子不占着它）',
      `输入行＝「${inputLineOf(beforeUp.lines)}」`,
    )

    await session.key('up')
    await Bun.sleep(400)
    const recalled = await session.capture({ label: `${mark}-12-按上键翻回原稿` })
    keep(recalled)
    check(
      inputLineOf(recalled.lines).includes('改完再发'),
      '【形②·尾】按 `↑` **真翻得回来**（「原稿在 ↑ 里」那句是实话）',
      `输入行＝「${inputLineOf(recalled.lines)}」`,
    )
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
    sandbox.dispose()
  }
}

/**
 * **② 接上再删掉那一趟**——「接错了删不掉」那个死锁。
 *
 * ⚠️ **只有一条连接**（它同时是当前那条、也是缺省）：这正是原先死锁的形状
 * ——装配拦「正在用」、配置层拦「它是默认」，两边都没有别的可切。
 */
async function removeTheOnlyOne(mark: string): Promise<void> {
  const sandbox = createSandbox()
  let session: UiSession | undefined

  try {
    check(connectionsOn(sandbox).length === 1, `【${mark}】沙地起手就是一条连接`)

    session = await createUiSession({
      label: `u60-删到空-${mark}`,
      sandbox,
      columns: 100,
      rows: 30,
      artifacts: join(out, 'runs'),
    })
    await session.wait({ text: '空闲' }, { timeoutMs: 25_000 })

    // `/model manage` → 那一条 → 「移除这条连接」→ 回车
    await typeLine(session, '/model manage')
    await session.key('enter')
    // `/model manage` 开的就是**连接一览**（那一行写着「回车＝管理这一条」）
    await waitUntil(session, '连接一览铺开', (lines) => flat(lines).includes('回车＝管理这一条'))
    await session.key('enter') // 进这一条的管理明细
    await waitUntil(session, '管理明细里那一行「移除这条连接」', (lines) =>
      flat(lines).includes('移除这条连接'),
    )
    const before = await session.capture({ label: `${mark}-04-删除之前` })
    keep(before)
    check(
      !flat(before.lines).includes('正在用——先换'),
      '【之二】明细里**没有**「正在用——先换到别的连接」那句拦（它已经不在产品里了）',
      flat(before.lines).slice(0, 300),
    )

    // 光标挪到「移除这条连接」那一行再回车（明细的行是固定的几条）
    await moveToLabel(session, '移除这条连接')
    await session.key('enter')
    await waitText(session, '已断开')

    const after = await session.capture({ label: `${mark}-05-删掉之后` })
    keep(after)
    const afterText = flat(after.lines)

    check(afterText.includes('已断开'), '【之二】删掉之后**当场说清**（「已断开」那一条回执）', receipts(after.lines).join(' / '))
    check(
      afterText.includes('还没有接上供应商'),
      '【之二】并且说了**此刻是什么状态**（还没有接上供应商）',
      receipts(after.lines).join(' / '),
    )
    check(
      afterText.includes('/model connect'),
      '【之二】以及**去哪儿**（敲 /model connect 接一条）',
      receipts(after.lines).join(' / '),
    )

    // **读数做旁证**（不看屏上那句话）：配置文件里那条连接真没了、默认也一并清掉了
    const onDisk = configOn(sandbox)
    check(
      connectionsOn(sandbox).length === 0,
      '【之二】配置文件里那条连接**真的删掉了**（读数，不是屏上那句话）',
      JSON.stringify(onDisk),
    )
    check(
      onDisk?.['defaultProvider'] === undefined,
      '【之二】`defaultProvider` **一并清掉了**（不留一条指向已删对象的死引用）',
      JSON.stringify(onDisk),
    )
    check(
      onDisk?.['providers'] !== undefined,
      '【之二】配置**还是合法 JSON**（删到空＝`providers: {}`，不是把文件删掉）',
      JSON.stringify(onDisk),
    )

    // 回到「0 供应商」那一形：`/model` 那一屏照旧
    const model = await openAndKeep(session, '/model', `${mark}-06-删完之后-model`)
    const divider = model.lines.findIndex((line) => /^─{8,}$/u.test(line.trim()))
    const dock = flat(divider === -1 ? [] : model.lines.slice(divider + 1))
    check(
      dock.includes('还没有接上任何供应商'),
      '【之二】删到空之后 `/model` 那一屏**和 0 供应商时一模一样**（同一条路的两步）',
      dock,
    )
    await session.key('esc')
    await Bun.sleep(300)
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
    sandbox.dispose()
  }
}

/**
 * 把光标挪到明细里 `label` 那一行。
 *
 * ⚠️ **不能按「当前」那一行算**（那一屏没有它——「当前」是**连接一览**上的标记）：
 * 管理明细固定 `selected: 0`（`openManageDetail`），故按**屏上印的序号 － 1** 按几下 `down`。
 */
async function moveToLabel(session: UiSession, label: string): Promise<void> {
  const lines = await waitUntil(session, `「${label}」在屏上`, (all) => flat(all).includes(label))
  const divider = lines.findIndex((line) => /^─{8,}$/u.test(line.trim()))
  const dock = lines.slice(divider + 1)
  const row = dock.find((line) => line.includes(label)) ?? ''
  const matched = /^\s*(\d+) /u.exec(row)
  if (matched === null) throw new Error(`明细里「${label}」那一行读不出序号：「${row}」`)

  for (let step = 1; step < Number(matched[1]); step += 1) await session.key('down')
}

/**
 * **③ 删掉其中一条（不是当前那条）那一趟**——判「**不悄悄换到另一条**」。
 *
 * 两条连接：`local`（当前 · 缺省）与 `spare`。删的是**当前那条** ⇒ 当前回到「没有」，
 * 而**剩下的那条不许被扶正**——那才是设计要防的静默级联。
 */
async function removeTheCurrentOneOf(mark: string): Promise<void> {
  const sandbox = createSandbox({
    config: {
      providers: {
        local: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-fake-u40-not-a-real-key', model: 'MiniMax-M3' },
        spare: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-fake-u40-not-a-real-key', model: 'MiniMax-M3' },
      },
    },
  })
  let session: UiSession | undefined

  try {
    check(connectionsOn(sandbox).length === 2, `【${mark}】沙地起手两条连接`)

    session = await createUiSession({
      label: `u60-删当前那条-${mark}`,
      sandbox,
      columns: 100,
      rows: 30,
      artifacts: join(out, 'runs'),
    })
    await session.wait({ text: '空闲' }, { timeoutMs: 25_000 })

    await typeLine(session, '/model manage')
    await session.key('enter')
    await waitUntil(session, '连接一览铺开', (lines) => flat(lines).includes('回车＝管理这一条'))
    // 一览里挪到 `local` 那一条（当前那条也在这一屏里）——按屏上印的行号算差几下
    await moveToName(session, 'local')
    await session.key('enter')
    await waitUntil(session, 'local 的管理明细', (lines) => flat(lines).includes('移除这条连接'))
    await moveToLabel(session, '移除这条连接')
    await session.key('enter')
    await waitText(session, '已断开')

    const after = await session.capture({ label: `${mark}-07-删掉当前那条之后` })
    keep(after)
    const afterText = flat(after.lines)

    check(afterText.includes('已断开'), '【之三】删当前那条：当场说清（「已断开」）', receipts(after.lines).join(' / '))
    check(
      afterText.includes('还没有选好走哪个模型'),
      '【之三】说了**此刻的状态是「还没选好走哪个模型」**（连接还在，只是没有当前那条了）',
      receipts(after.lines).join(' / '),
    )
    check(
      afterText.includes('/model 挑一个'),
      '【之三】以及**去哪儿挑**（敲 /model 挑一个）',
      receipts(after.lines).join(' / '),
    )

    // **读数**：`local` 真没了、`spare` **原样在**、而**默认被清掉**（不是改成 spare）
    const onDisk = configOn(sandbox)
    check(
      connectionsOn(sandbox).join(',') === 'spare',
      '【之三】删的是 local，spare **原样在**（读数）',
      JSON.stringify(onDisk),
    )
    check(
      onDisk?.['defaultProvider'] === undefined,
      '【之三】**没悄悄换到 spare**：`defaultProvider` 清空了，而不是改写成 spare',
      JSON.stringify(onDisk),
    )
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
    sandbox.dispose()
  }
}

/**
 * 一览里挪到某条连接那一行。⚠️ 一览同样**没有「当前」标记**（`openManagePicker` 固定
 * `selected: 0`，行上印的是「回车＝管理这一条」）——故按**屏上印的序号 － 1** 按几下 `down`。
 */
async function moveToName(session: UiSession, name: string): Promise<void> {
  const lines = await waitUntil(session, `一览里「${name}」那一行`, (all) => flat(all).includes(name))
  const divider = lines.findIndex((line) => /^─{8,}$/u.test(line.trim()))
  const dock = lines.slice(divider + 1)
  const row = dock.find((line) => line.includes(name)) ?? ''
  const matched = /^\s*(\d+) /u.exec(row)
  if (matched === null) throw new Error(`一览里「${name}」那一行读不出序号：「${row}」`)

  for (let step = 1; step < Number(matched[1]); step += 1) await session.key('down')
}

/**
 * **⑤ 接了但没选那一趟**——**重启之后**起手那一屏也要出声。
 *
 * 由头：删掉当前那条之后（或者 `/model connect` 接完还没挑模型就退出），配置里**有连接、
 * 没有缺省**。那也是「干不了活」的一形，**下一次打开**起手那一屏要是静默的，
 * 判据「一路上没有一处是静默的」就漏了一格（前一趟只证明了**那一刻**有回执）。
 *
 * 沙地造法：给配置里塞一个 `defaultProvider: undefined`——`JSON.stringify` 会把它整键
 * 丢掉，落到盘上就是「有 providers、没有 defaultProvider」那一形（与 `/model connect`
 * 刚接完、还没挑模型时的配置一模一样）。
 */
async function connectedButUnselected(mark: string): Promise<void> {
  const sandbox = createSandbox({ config: { defaultProvider: undefined } })
  let session: UiSession | undefined

  try {
    check(configOn(sandbox)?.['defaultProvider'] === undefined, `【${mark}】盘上**没有** defaultProvider`)
    check(connectionsOn(sandbox).length === 1, `【${mark}】但连接**有一条**`)

    session = await createUiSession({
      label: `u60-接了没选-${mark}`,
      sandbox,
      columns: 100,
      rows: 30,
      artifacts: join(out, 'runs'),
    })
    await session.wait({ text: '空闲' }, { timeoutMs: 25_000 })

    const boot = await session.capture({ label: `${mark}-09-接了没选-起手` })
    keep(boot)
    const bootText = flat(boot.lines)

    check(
      bootText.includes('还没有选好走哪个模型'),
      '【之二·尾】接了没选那一形，起手也**出声**（还没有选好走哪个模型）',
      receipts(boot.lines).join(' / '),
    )
    check(
      bootText.includes('/model 挑一个'),
      '【之二·尾】说了**下一步**（敲 /model 挑一个）',
      receipts(boot.lines).join(' / '),
    )
    check(
      !bootText.includes('还没有接上供应商'),
      '【之二·尾】**没有说错话**：连接是有的，故不说「还没有接上供应商」',
      receipts(boot.lines).join(' / '),
    )

    // 发一句：**照样拦得住**，而且说的是这一形的那句
    await typeLine(session, '你好')
    await session.key('enter')
    await waitText(session, '没送出')
    const sent = await session.capture({ label: `${mark}-10-接了没选-发一句之后` })
    keep(sent)
    check(
      flat(sent.lines).includes('没送出：还没有选好走哪个模型'),
      '【之二·尾】发一句也当场说清（「还没有选好走哪个模型」——不是「还没接供应商」那句）',
      receipts(sent.lines).join(' / '),
    )
    check(
      statusLineOf(sent.lines).includes('○ 空闲') && !statusLineOf(sent.lines).includes('出错'),
      '【之二·尾】**没装作在跑**（同形②那一条）',
      statusLineOf(sent.lines),
    )
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
    sandbox.dispose()
  }
}

/**
 * **④ 反面那一趟**——**有**供应商（接好、选好）时，起手那一屏**一个字都不许多**。
 *
 * 判据是**逐行比对**：那一屏该有的东西一个不少，且**多出来的那几行**里不许有本单新加的话。
 */
async function configured(mark: string, columns: number, rows: number): Promise<void> {
  const sandbox = createSandbox()
  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: `u60-有供应商-${mark}`,
      sandbox,
      columns,
      rows,
      artifacts: join(out, 'runs'),
    })
    await session.wait({ text: '空闲' }, { timeoutMs: 25_000 })

    const boot = await session.capture({ label: `${mark}-08-有供应商-起手` })
    keep(boot)
    const bootText = flat(boot.lines)

    check(
      !bootText.includes('还没有接上供应商') && !bootText.includes('还没有选好走哪个模型'),
      '【反面】有供应商时那一屏**没有本单新加的那一句**（起手那句不得常驻）',
      receipts(boot.lines).join(' / ') || '（一条回执都没有——对的）',
    )
    check(
      receipts(boot.lines).length === 0,
      '【反面】有供应商时那一屏**一条回执都没有**（一个字都不多）',
      receipts(boot.lines).join(' / '),
    )
    check(
      bootText.includes('交代一件事'),
      '【反面】该在的还在（输入提示照旧）',
      bootText.slice(0, 200),
    )
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
    sandbox.dispose()
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u60-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    console.log('· ① 零供应商 · 常宽 100×30')
    await unconfigured('宽', 100, 30)
    console.log('· ① 零供应商 · 窄窗 46×30')
    await unconfigured('窄', 46, 30)
    console.log('· ② 接上再删掉（就那一条）')
    await removeTheOnlyOne('常数')
    console.log('· ③ 删掉当前那条（还有一条 spare）')
    await removeTheCurrentOneOf('常数')
    console.log('· ⑤ 接了但没选（重启之后那一形）')
    await connectedButUnselected('常数')
    console.log('· ④ 反面：有供应商 · 常宽')
    await configured('宽', 100, 30)
    console.log('· ④ 反面：有供应商 · 窄窗')
    await configured('窄', 46, 30)

    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    if (at === -1) removeDir(root)
  }
}
