import { describe, expect, test } from 'bun:test'
import type { KernelEvent, ManagerToClient, RunSnapshot } from '@magic/contracts'
import { createShell } from '@magic/tui'
import { connectManager, executionEnvironment } from '../src/run/client.ts'
import { connectApp } from '../src/run/spawn-manager.ts'
import { clientTransport, terminalOptions, terminalConnection } from '../src/run/terminal.ts'
import { cliGround, fakeApp, waitFor } from './resident-cli-fixture.ts'

function initialEvents(): KernelEvent[] {
  return [
    { id: 0, session: 'real-session', turn: null, at: 1, kind: 'session.state',
      data: { active: 'real-session', sessions: [{ id: 'real-session', at: 1, title: '工作' }] } },
    { id: 0, session: 'real-session', turn: null, at: 1, kind: 'session.history',
      data: { session: 'real-session', entries: [{ id: 1, kind: 'assistant', at: 1, content: { text: '初次历史内容不会丢失' } }], done: true } },
  ]
}

describe('resident-cli 客户端握手与纯观察', () => {
  test('hello 前接收，welcome 前后 ev/target 缓存至晚订阅，gen=null 的历史查询照发', async () => {
    const g = cliGround()
    const events = initialEvents()
    const server = fakeApp(g, (link) => {
      link.send({ t: 'target', gen: null, session: 'real-session' })
      link.send({ t: 'ev', gen: null, event: events[0]! })
      link.send(server.welcome)
      link.send({ t: 'ev', gen: null, event: events[1]! })
    })
    try {
      const client = (await connectManager(g.discovery.socket, { expectedIdentity: g.identity }))!
      await Bun.sleep(5) // 消息已到，但 UI 尚未装配。
      const targets: (string | null)[] = []
      const received: KernelEvent[] = []
      client.onTarget((target) => targets.push(target))
      const transport = clientTransport(client)
      const unsubscribe = transport.subscribe((event) => received.push(event))
      expect(received).toEqual([]) // 构造中不进行同步回放。
      await waitFor(() => received.length === 2)
      expect(received).toEqual(events)
      expect(targets).toEqual(['real-session'])
      expect(client.gen()).toBeNull()
      transport.send({ type: 'history.read', session: 'real-session' })
      await waitFor(() => server.messages.some((message) => message.t === 'cmd'))
      expect(server.messages.find((message) => message.t === 'cmd')).toEqual({ t: 'cmd', gen: null, cmd: { type: 'history.read', session: 'real-session' } })
      unsubscribe()
      server.links[0]!.send({ t: 'ev', gen: null, event: events[0]! })
      await Bun.sleep(5)
      expect(received).toHaveLength(2)
      client.close()
    } finally { server.close(); g.close() }
  })

  test('真实 createShell 构造能接收初次 state/history，无初始化异常，不合成假 session', async () => {
    const g = cliGround()
    const server = fakeApp(g, (link) => {
      for (const event of initialEvents()) link.send({ t: 'ev', gen: null, event })
      link.send(server.welcome)
    })
    try {
      const client = (await connectManager(g.discovery.socket))!
      const shell = createShell(clientTransport(client), { magicBase: '/test/.magic' })
      await waitFor(() => shell.getView().sessionId === 'real-session')
      expect(JSON.stringify(shell.getView())).toContain('初次历史内容不会丢失')
      shell.dispose()
      client.close()
    } finally { server.close(); g.close() }
  })

  test('只收到 welcome 的空白连接没有伪造的 session/target/event，快速查询后关闭可收尾', async () => {
    const g = cliGround()
    const server = fakeApp(g)
    try {
      for (let i = 0; i < 5; i++) {
        const client = (await connectManager(g.discovery.socket))!
        const events: KernelEvent[] = []
        const targets: (string | null)[] = []
        client.onEvent((event) => events.push(event))
        client.onTarget((target) => targets.push(target))
        client.send({ type: 'history.read' })
        client.close()
        await Bun.sleep(0)
        expect(client.closed).toBe(true)
        expect(events).toEqual([])
        expect(targets).toEqual([])
      }
    } finally { server.close(); g.close() }
  })

  test('身份协议/版本/source/base/宿主/服务代次必须匹配；welcome 两份 base 不许自相矛盾', async () => {
    for (const [patch, error] of [
      [{ protocol: 999 }, '协议或软件版本不匹配'],
      [{ version: 'wrong' }, '协议或软件版本不匹配'],
      [{ source: '/different/runtime' }, '软件来源不匹配'],
      [{ base: '/different/data' }, '数据实例不匹配'],
      [{ serviceInstance: 'new-service' }, 'Engine 代次不一致'],
    ] as const) {
      const g = cliGround()
      const server = fakeApp(g, (link) => link.send({ ...server.welcome, identity: { ...g.identity, ...patch } }))
      try {
        await expect(connectManager(g.discovery.socket, { expectedIdentity: g.identity })).rejects.toThrow(error)
      } finally { server.close(); g.close() }
    }
    const g = cliGround()
    const server = fakeApp(g, (link) => link.send({ ...server.welcome, base: '/other-data' }))
    try {
      await expect(connectManager(g.discovery.socket)).rejects.toThrow('welcome 的数据目录与服务身份不一致')
    } finally { server.close(); g.close() }
  })

  test('缺 welcome 身份不接受；有端点但无握手具体超时，不泛化为离线', async () => {
    const g = cliGround()
    let reply = true
    const server = fakeApp(g, (link) => {
      if (reply) link.send({ ...server.welcome, identity: undefined } as unknown as ManagerToClient)
    })
    try {
      await expect(connectManager(g.discovery.socket)).rejects.toThrow('协议或软件版本不匹配')
      reply = false
      await expect(connectManager(g.discovery.socket, { timeoutMs: 15 })).rejects.toThrow('等待 Magic Code 握手超时')
      expect(await connectManager(`${g.discovery.socket}.missing`)).toBeUndefined()
    } finally { server.close(); g.close() }
  })

  test('握手 line 后关闭与 welcome.refuse 保留原始拒绝，不被缓存回放吞掉', async () => {
    const g = cliGround()
    let useWelcome = false
    const server = fakeApp(g, (link) => {
      if (useWelcome) link.send({ ...server.welcome, refuse: '没有这条会话：real-session' })
      else link.send({ t: 'line', text: '软件来源不匹配：请退出原 App' })
      link.close()
    })
    try {
      await expect(connectManager(g.discovery.socket)).rejects.toThrow('软件来源不匹配：请退出原 App')
      useWelcome = true
      await expect(connectManager(g.discovery.socket)).rejects.toThrow('没有这条会话：real-session')
    } finally { server.close(); g.close() }
  })

  test('完整工作环境仅随明确输入传入；观察接入不带 environment，握手/summary 不发 read', async () => {
    const g = cliGround()
    const server = fakeApp(g)
    const env = { PATH: '/work/bin', SHELL: '/bin/zsh', LANG: 'zh_CN.UTF-8', LC_CTYPE: 'UTF-8', LC_SECRET: 'secret', API_KEY: 'secret', HOME: '/private-home', MAGIC_HOME: undefined }
    try {
      expect(executionEnvironment(env)).toEqual({ PATH: '/work/bin', SHELL: '/bin/zsh', LANG: 'zh_CN.UTF-8', LC_CTYPE: 'UTF-8', LC_SECRET: 'secret', API_KEY: 'secret', HOME: '/private-home' })
      g.publish()
      const passive = await connectApp({ home: g.home, env, connect: { environment: env } })
      const options = (await terminalOptions({ client: passive.client, loaded: passive.loaded, magic: passive.magic, cwd: g.root }))
      expect(options.receipts?.join(' ')).toContain('1')
      const configured = (await terminalOptions({ client: passive.client, loaded: { ...passive.loaded, config: { ...passive.loaded.config, motion: { reduced: true }, statusLine: { cells: [], color: false } } }, magic: passive.magic, cwd: g.root }))
      expect(configured.reducedMotion).toBe(true)
      expect(configured.statusLine).toEqual({ cells: [], color: false })
      expect(server.messages[0]).not.toHaveProperty('environment')
      expect(server.messages.some((message) => message.t === 'read')).toBe(false)
      passive.client.markRead(['unread'])
      await waitFor(() => server.messages.some((message) => message.t === 'read'))
      expect(server.messages.filter((message) => message.t === 'read')).toEqual([{ t: 'read', ids: ['unread'] }])
      passive.client.close()

      const active = await connectApp({ home: g.home, env, intent: 'open' })
      const hello = server.messages.filter((message) => message.t === 'hello').at(-1)!
      expect(hello).not.toHaveProperty('environment')
      active.client.send({ type: 'input.submit', text: '明确发起工作' })
      await waitFor(() => server.messages.some(message => message.t === 'cmd'))
      expect(server.messages.find(message => message.t === 'cmd')).toMatchObject({ environment: executionEnvironment(env) })
      expect(JSON.stringify(hello)).not.toContain('secret')
      active.client.close()
    } finally { server.close(); g.close() }
  })
})

test('首次历史和target随后立即关闭，晚订阅仍完整读到事实；不抛异步异常', async () => {
  const g = cliGround()
  const server = fakeApp(g, (link) => {
    link.send(server.welcome)
    link.send({ t: 'target', gen: null, session: 'real-session' })
    for (const event of initialEvents()) link.send({ t: 'ev', gen: null, event })
    link.close()
  })
  try {
    const client = (await connectManager(g.discovery.socket))!
    await waitFor(() => client.closed)
    const targets: (string | null)[] = []
    const received: KernelEvent[] = []
    client.onTarget((session) => targets.push(session))
    client.onEvent((event) => received.push(event))
    await waitFor(() => received.length === 2)
    expect(targets).toEqual(['real-session'])
    expect(received).toEqual(initialEvents())
  } finally { server.close(); g.close() }
})

test('detached只核销executor；稳定连接仅明确reopen，新client接全部订阅并隔离旧消息，Shell草稿不变', async () => {
  const a = cliGround(), b = cliGround()
  const first = fakeApp(a), second = fakeApp(b)
  a.publish()
  let opens = 0
  try {
    const initial = await connectApp({ home: a.home, env: {} })
    const oldEvents: ((event: KernelEvent, gen: number | null) => void)[] = []
    const subscribe = initial.client.onEvent.bind(initial.client)
    initial.client.onEvent = (listener) => { oldEvents.push(listener); subscribe(listener) }
    const connection = terminalConnection(initial.client, async (session) => {
      opens++
      expect(session).toBe('real-session')
      return (await connectManager(b.discovery.socket, { session }))!
    })
    const options = (await terminalOptions({ client: connection.client, loaded: initial.loaded, magic: initial.magic, cwd: a.root, reopen: connection.reopen }))
    const shell = createShell(options.transport, { magicBase: '/test/.magic', detached: options.detached, reopen: options.reopen })
    options.onGone?.(() => shell.hostGone())
    const detaches: string[] = []
    connection.client.onDetached((why) => detaches.push(why))
    const received: KernelEvent[] = []
    connection.client.onEvent((event) => received.push(event))
    first.links[0]!.send({ t: 'target', gen: 1, session: 'real-session' })
    for (const event of initialEvents()) first.links[0]!.send({ t: 'ev', gen: 1, event })
    await waitFor(() => shell.getView().sessionId === 'real-session')
    shell.key({ kind: 'paste', text: '保留草稿' })
    first.links[0]!.send({ t: 'detached', why: '本代已核销' })
    await waitFor(() => detaches.length === 1)
    expect(connection.client.gen()).toBeNull()
    expect(connection.client.closed).toBe(false)
    expect(shell.getView().sessionId).toBe('real-session')
    expect(shell.getView().draft).toBe('保留草稿')
    expect(opens).toBe(0)
    first.close()
    await waitFor(() => connection.client.closed)
    await Bun.sleep(5)
    expect(opens).toBe(0) // onGone/被动状态读取都没有触发 App。
    shell.key({ kind: 'ctrl+r' })
    await waitFor(() => opens === 1 && !connection.client.closed)
    expect(shell.getView().draft).toBe('保留草稿')
    expect(second.messages.find((message) => message.t === 'hello')).toMatchObject({ session: 'real-session' })
    const before = received.length
    for (const listener of oldEvents) listener(initialEvents()[0]!, 1)
    expect(received).toHaveLength(before)
    second.links[0]!.send({ t: 'ev', gen: null, event: initialEvents()[1]! })
    await waitFor(() => received.length === before + 1)
    expect(shell.getView().draft).toBe('保留草稿')
    shell.dispose()
    connection.client.close()
  } finally { first.close(); second.close(); a.close(); b.close() }
})

test('显式重连在途关闭终端，会关闭迟到新client；不会留下新订阅或假成功', async () => {
  const a = cliGround(), b = cliGround()
  const first = fakeApp(a), second = fakeApp(b)
  try {
    const initial = (await connectManager(a.discovery.socket))!
    const next = (await connectManager(b.discovery.socket))!
    initial.close()
    let release: (() => void) | undefined
    const ready = new Promise<void>((resolve) => { release = resolve })
    const connection = terminalConnection(initial, async () => { await ready; return next })
    const reopening = connection.reopen()
    connection.client.close()
    release!()
    await expect(reopening).rejects.toThrow('终端已经关闭')
    expect(next.closed).toBe(true)
    await expect(connection.reopen()).rejects.toThrow('终端已经关闭')
  } finally { first.close(); second.close(); a.close(); b.close() }
})

test('同gen真实target认领保留快照缓存、Shell历史与草稿；客户端不从任意事件猜目标', async () => {
  const g = cliGround()
  const server = fakeApp(g)
  const client = (await connectManager(g.discovery.socket))!
  const targets: (string | null)[] = []
  const snapshot: RunSnapshot = { watermark: 10, turnOpen: true, text: '正在输出的正文', tools: [], decisions: [] }
  const shell = createShell(clientTransport(client), { magicBase: '/test/.magic', resumed: { subscribe: (listener) => client.onResumed(listener) } })
  client.onTarget((session) => targets.push(session))
  try {
    const link = server.links[0]!
    link.send({ t: 'target', gen: 1, session: null })
    for (const event of initialEvents()) link.send({ t: 'ev', gen: 1, event })
    link.send({ t: 'resumed', gen: 1, snapshot })
    await waitFor(() => JSON.stringify(shell.getView()).includes(snapshot.text!))
    expect(targets).toEqual([null]) // session.state 可呈现，但不能代替管理者 target。
    shell.key({ kind: 'paste', text: '同代认领不丢的草稿' })
    const before = shell.getView()
    link.send({ t: 'target', gen: 1, session: 'real-session' })
    await waitFor(() => targets.at(-1) === 'real-session')
    expect(client.gen()).toBe(1)
    expect(shell.getView()).toBe(before)
    expect(shell.getView().draft).toBe('同代认领不丢的草稿')
    expect(JSON.stringify(shell.getView())).toContain('初次历史内容不会丢失')
    const late: RunSnapshot[] = []
    client.onResumed((_gen, value) => late.push(value))
    await waitFor(() => late.length === 1)
    expect(late).toEqual([snapshot])
    expect(server.messages.filter((message) => message.t === 'cmd').map(message=>message.cmd)).toEqual([{type:'history.read',session:'real-session'}])
    expect(server.messages.some((message) => message.t === 'read')).toBe(false)
  } finally { shell.dispose(); client.close(); server.close(); g.close() }
})
