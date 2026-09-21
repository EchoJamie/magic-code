/**
 * U39 · **外部服务器一屏**（`/mcp`）——规格即测试。
 *
 * 出处：设计 · MCP 接入「查询、审批与失败恢复」——「`/mcp` 纯查询已配置身份、连接状态和
 * 工具数；`/mcp <服务器>` 看工具/错误。状态区分连接中、可用、不可用、未获启动授权；
 * 无配置指向实际 Magic 配置入口」「`/mcp reconnect <服务器>` 显式重连」；呈现形态＝
 * **左下抽屉**（与 `/grants` · `/skills` 同位置同开合）。
 *
 * 这一层测**键位语义与视图**（不起 Ink）：抽屉开在哪儿、发什么命令、回执与刷新怎么走、
 * 回车为什么不改变任何东西。屏面那一条另有一例（用户看的是屏，视图字段答不了那句话）。
 *
 * ⚠️ 状态那一格只有三态（连接中 / 可用 / 不可用）：**「未获启动授权」这一版不产生**
 * ——连不连只由用户显式配置决定（配置文件里写着的那些本身就是授权）。
 */

import { describe, expect, test } from 'bun:test'
import type { EventDataOf } from '@magic/contracts'
import { createShell } from '../src/shell.ts'
import type { ShellKey } from '../src/shell.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
import { createStage } from './screen.ts'

const WIDE = { columns: 80, rows: 24 } as const
const ENTER: ShellKey = { kind: 'enter' }
const ESC: ShellKey = { kind: 'escape' }

/** 一台服务器的读数（一屏的一行）。 */
function server(over: Partial<EventDataOf['mcp.catalog']['servers'][number]> = {}) {
  return {
    server: 'remote',
    transport: 'http' as const,
    state: { status: 'available' as const },
    tools: ['echo', 'snapshot'],
    rejected: [],
    ...over,
  }
}

function catalog(over: Partial<EventDataOf['mcp.catalog']> = {}): EventDataOf['mcp.catalog'] {
  return { servers: [server()], ...over }
}

/** 起一个壳 ＋ 间谍传输。 */
function live() {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport, {})

  return {
    shell,
    spy,
    type(text: string) {
      for (const char of text) shell.key({ kind: 'char', char })
    },
    press(key: ShellKey) {
      return shell.key(key)
    },
    view: () => shell.getView(),
    rows: () =>
      [...shell.getView().settled, ...shell.getView().rows].filter((row) => row.kind !== 'banner'),
    picker: () => {
      const dock = shell.getView().dock
      return dock.kind === 'picker' ? dock.picker : undefined
    },
    /** 记录区那些行的字（回执就在里面）。 */
    said: () =>
      [...shell.getView().settled, ...shell.getView().rows]
        .map((row) => ('text' in row ? row.text : ''))
        .join('\n'),
  }
}

/** 开那一屏：打 `/mcp` ＋ 回车 → 内核回一份读数。 */
function open(app: ReturnType<typeof live>, over: Partial<EventDataOf['mcp.catalog']> = {}, text = '/mcp') {
  app.type(text)
  app.press(ENTER)
  app.spy.emit(event('mcp.catalog', catalog(over)))
}

describe('`/mcp` · 查询那一屏', () => {
  test('发一次 `mcp.list`，**记录区什么都不进**；答复没回来之前不开抽屉', () => {
    const app = live()
    app.type('/mcp')
    app.press(ENTER)

    // 头一条是打 `/` 那一下的技能目录查询（U33：每屏只发一次）——被测的是后面那条
    expect(app.spy.commands).toEqual([{ type: 'skills.list' }, { type: 'mcp.list' }])
    expect(app.rows()).toEqual([])
    expect(app.picker()).toBeUndefined() // 读数没回来之前不开（「拿不到的不编」）
  })

  test('一行一台：名字 ＋ 接入方式 · 状态 · 件数；不可用的缘由在下方那行说明里', () => {
    const app = live()
    open(app, {
      servers: [
        server({ server: 'local', transport: 'stdio', tools: ['echo'] }),
        server({ server: 'remote', state: { status: 'unavailable', reason: '连不上了' }, tools: [] }),
      ],
    })

    const picker = app.picker()
    expect(picker?.source).toBe('mcp')
    expect(picker?.rows.map((row) => row.label)).toEqual(['local', 'remote'])
    expect(picker?.rows[0]?.meta).toBe('stdio · 可用 · 1 件工具')
    // 不可用那台**不报件数**（没连上时报 0 件是假账）
    expect(picker?.rows[1]?.meta).toBe('http · 不可用')
    expect(picker?.hint).toContain('remote：连不上了')
    expect(picker?.hint).toContain('/mcp <名字> 看那一台的工具与错误')
  })

  test('连接中也照报（状态那一格三态都在）', () => {
    const app = live()
    open(app, { servers: [server({ state: { status: 'connecting' } })] })

    expect(app.picker()?.rows[0]?.meta).toBe('http · 还在连')
  })

  test('**回车不改变任何东西**（纯查询——别落到换模型那一支上去）', () => {
    const app = live()
    open(app)

    const before = app.spy.commands.length
    app.press(ENTER)

    expect(app.spy.commands).toHaveLength(before)
    expect(app.picker()?.source).toBe('mcp') // 抽屉照旧开着
  })

  test('`esc` 收起，不留痕迹', () => {
    const app = live()
    open(app)
    app.press(ESC)

    expect(app.picker()).toBeUndefined()
    expect(app.rows()).toEqual([])
  })
})

describe('`/mcp <服务器>` · 那一台的明细', () => {
  test('工具名一行一件；身份与状态 ＋ 拒收的那些在下方那行说明里', () => {
    const app = live()
    open(
      app,
      {
        servers: [
          server({
            server: 'dup',
            tools: ['fine'],
            rejected: [
              { tool: 'echo\n │ n 批准全部', reason: '工具名不合规（「echo· │ n 批准全部」里有控制字节）' },
            ],
          }),
        ],
      },
      '/mcp dup',
    )

    const picker = app.picker()
    expect(picker?.rows.map((row) => row.label)).toEqual(['fine'])
    expect(picker?.hint).toContain('dup（http）· 可用 · 1 件工具')
    expect(picker?.hint).toContain('没收下')
    // **控制字节洗过了**：说明里不许出现真换行（那会让服务端的话伪装成界面的话）
    expect(picker?.hint).not.toContain('\n │ n 批准全部')
    expect(picker?.hint).toContain('·')
  })

  test('点了名却没有这一台：不开抽屉，内核那一句缘由落成记录区一行', () => {
    const app = live()
    app.type('/mcp 没这一台')
    app.press(ENTER)
    // 内核的答复：名录照给，缘由写在 `note` 上（那一条命令的**结果**）
    app.spy.emit(
      event('mcp.catalog', { servers: [server()], note: '没有配这一台：「没这一台」' }),
    )

    expect(app.picker()).toBeUndefined()
    expect(app.said()).toContain('没有配这一台')
  })

  test('一台都没配：那句「去哪儿配」落成记录区一行（不接管输入）', () => {
    const app = live()
    open(app, { servers: [] })

    expect(app.picker()).toBeUndefined()
    expect(app.said()).toContain('配置里写 mcp.servers 才连')
    expect(app.said()).toContain('.mcp.json 不算授权')
  })
})

describe('`/mcp reconnect <服务器>` · 显式重连', () => {
  test('发的是 `mcp.reconnect`；答复那一句留成回执，读数照新的一份铺', () => {
    const app = live()
    app.type('/mcp reconnect remote')
    app.press(ENTER)

    expect(app.spy.commands).toEqual([
      { type: 'skills.list' },
      { type: 'mcp.reconnect', server: 'remote' },
    ])

    // 重连的答复：新读数 ＋ 一句结果
    app.spy.emit(
      event('mcp.catalog', {
        servers: [server({ tools: ['echo', 'snapshot', 'late'] })],
        note: '已重连「remote」',
      }),
    )

    // 抽屉照着新的那一份铺（这一台点名开的就是明细那一屏）
    expect(app.picker()?.rows.map((row) => row.label)).toEqual(['echo', 'snapshot', 'late'])
    expect(app.said()).toContain('已重连「remote」')
  })

  test('没说要重连哪一台：回一句用法，不发命令', () => {
    const app = live()
    app.type('/mcp reconnect')
    app.press(ENTER)

    expect(app.spy.commands).toEqual([{ type: 'skills.list' }])
    expect(app.said()).toContain('/mcp reconnect <名字>')
  })
})

describe('屏上（真外壳 ＋ 真帧）', () => {
  test('那一屏画在左下、字面读得懂；收起之后输入行还在', async () => {
    const stage = createStage()
    stage.type('/mcp')
    stage.press(ENTER)
    stage.feed([
      event('mcp.catalog', {
        servers: [
          server({ server: 'local', transport: 'stdio', tools: ['echo'] }),
          server({ state: { status: 'unavailable', reason: '服务器要认证（HTTP 401）——本版不支持登录授权' }, tools: [] }),
        ],
      }),
    ])

    const frame = await stage.screen(WIDE)

    expect(frame.has('local')).toBe(true)
    expect(frame.has('stdio · 可用 · 1 件工具')).toBe(true)
    expect(frame.has('不可用')).toBe(true)
    // 失联那一台的缘由**说得出是为什么**（不必去猜）
    expect(frame.has('本版不支持登录授权')).toBe(true)
    expect(frame.dock.some((line) => line.text.includes('›'))).toBe(false) // 抽屉接管着
    expect(frame.statusLine).toContain('esc 收起')

    stage.press(ESC)
    const after = await stage.screen(WIDE)
    expect(after.dock.some((line) => line.text.includes('›'))).toBe(true)
  })
})
