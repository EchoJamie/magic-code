import { describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { locateHost, readHostDiscovery, selectedHostConfig, hostDiscoveryPath } from '../src/run/host-discovery.ts'
import { connectApp, openApplication, reopenApp } from '../src/run/spawn-manager.ts'
import { cliGround, fakeApp } from './resident-cli-fixture.ts'

describe('App 发现与显式打开', () => {
  test('发布版由 executable realpath 定位所属 bundle；正式与 .dev 身份使用各自发现路径', () => {
    const g = cliGround()
    try {
      const helper = join(g.app, 'Contents/Helpers/magic-runtime')
      mkdirSync(dirname(helper), { recursive: true })
      writeFileSync(helper, 'isolated executable fixture')
      const alias = join(g.root, 'magic')
      symlinkSync(helper, alias)
      // 原预期 → 新预期：原来按 bundle id 带不带 `.dev` **在两个目录之间分叉**
      // （带 Dev 的那个名字 / 不带的那一个）；U109 起**不再分叉**——两种身份都落在
      // **同一个**「Magic Code」下。依据：用户 2026-09-30 口径（代码里不留这种标记）。
      // **没变弱**：循环保留（两种 bundle id 都真跑一遍），断言从「跟着变」换成
      // 「**都一样**」——它现在显式钉住「不再分叉」，比原来那条只证「按 dev 分叉」更强。
      const seen: string[] = []
      for (const development of [false, true]) {
        writeFileSync(join(g.app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.magiccode.app${development ? '.dev' : ''}</string></dict></plist>`)
        const location = locateHost({ home: g.home, standalone: true, executable: alias, appPath: '/wrong.app', discoveryPath: '/wrong.json' })
        expect(location.app).toBe(realpathSync(g.app))
        expect(location.source).toBe(realpathSync(helper))
        expect(location.discoveryPath).toBe(hostDiscoveryPath(g.home))
        seen.push(location.discoveryPath)
      }
      expect(new Set(seen).size).toBe(1) // 两种 bundle id 落在同一处 ⇒ 不再有那一套单独的落点
      // 移动后以真实新位置为准，不依赖旧安装路径或 App 名称。
      const moved = join(g.root, 'Moved.app')
      renameSync(g.app, moved)
      expect(locateHost({ home: g.home, standalone: true, executable: join(moved, 'Contents/Helpers/magic-runtime') }).app).toBe(moved)
      expect(() => locateHost({ standalone: true, executable: process.execPath })).toThrow('CLI 不在所属 App')
    } finally { g.close() }
  })

  test('发现是只读：缺席、坏 JSON、缺字段均不创建或修复文件', () => {
    const g = cliGround()
    try {
      const location = locateHost({ home: g.home })
      expect(readHostDiscovery(location)).toBeUndefined()
      g.publish({ ...g.discovery, base: 'relative' })
      expect(() => readHostDiscovery(location)).toThrow('base 必须是绝对路径')
      writeFileSync(g.discoveryPath, '{broken')
      expect(() => readHostDiscovery(location)).toThrow('不是有效 JSON')
      expect(readFileSync(g.discoveryPath, 'utf8')).toBe('{broken')
    } finally { g.close() }
  })

  test('未设 MAGIC_HOME 采用 App 已选 base；不再追加 .magic，也不读默认家的坏配置', () => {
    const g = cliGround()
    try {
      mkdirSync(join(g.home, '.magic'))
      writeFileSync(join(g.home, '.magic/config.json'), 'bad default config')
      const selected = selectedHostConfig(g.discovery, { home: g.home, cwd: g.root, env: {} })
      expect(selected.magic.base).toBe(g.base)
      expect(selected.loaded.path).toBe(join(g.base, 'config.json'))
      expect(selected.loaded.config.dataDir).toBe(g.dataDir)
      for (const configured of ['selected', dirname(g.base), '  selected/  ']) {
        expect(selectedHostConfig(g.discovery, { home: g.home, cwd: g.root, env: { MAGIC_HOME: configured } }).magic.base).toBe(g.base)
      }
      // 原预期 → 新预期：消息里原来同时报**基础目录**与数据目录两半；U109 把守卫收窄成
      // **只比数据实例**（设计 `:99`/`:97` 说的就是「数据实例」「数据目录」）之后，消息里
      // 报的是**真正被比的那一位**。依据：U109 裁决（守卫只比 `dataDir`）。
      // **没变弱**：两条判据仍是「以那个理由拒绝」，且报出的正是**判据本身**——原来那两半里
      // 有一半（基础目录）根本不该参与比较。
      expect(() => selectedHostConfig(g.discovery, { home: g.home, cwd: g.root, env: { MAGIC_HOME: 'elsewhere' } })).toThrow('CLI 数据目录=')
      expect(() => selectedHostConfig(g.discovery, { home: g.home, cwd: g.root, env: { MAGIC_HOME: 'elsewhere' } })).toThrow('App 数据目录=')
    } finally { g.close() }
  })

  test('主动打开首次找不到服务时只打开自身 App，等新发布记录并核对真实 welcome', async () => {
    const g = cliGround()
    let server: ReturnType<typeof fakeApp> | undefined
    const opened: string[] = []
    try {
      const connected = await connectApp({
        home: g.home, appPath: g.app, intent: 'open', env: {},
        openApplication: async (app) => { opened.push(app); server = fakeApp(g); g.publish() },
      })
      expect(opened).toEqual([g.app])
      expect(connected.magic.base).toBe(g.base)
      expect(connected.client.identity).toEqual(g.identity)
      connected.client.close()
      const again = await reopenApp({ home: g.home, appPath: g.app, env: {}, openApplication: async (app) => { opened.push(app) } })
      again.client.close()
      expect(opened).toEqual([g.app])
    } finally { server?.close(); g.close() }
  })

  test('状态读取和旧 TUI 被动重连不打开 App；stale 文件不证明服务仍在', async () => {
    const g = cliGround()
    let opens = 0
    const options = { home: g.home, appPath: g.app, env: {}, openApplication: async () => { opens++ } }
    const server = fakeApp(g)
    try {
      g.publish()
      const connection = await connectApp(options)
      connection.client.close()
      server.close()
      await expect(connectApp(options)).rejects.toThrow('发现记录已过期或服务不可达')
      await expect(connectApp(options)).rejects.toThrow('被动连接不会打开')
      expect(opens).toBe(0)
      expect(JSON.parse(readFileSync(g.discoveryPath, 'utf8'))).toEqual(g.discovery)
    } finally { server.close(); g.close() }
  })

  test('源码模式没有显式可用宿主就报错，不启动备用后台；open 成功但服务未就绪也具体失败', async () => {
    const g = cliGround()
    let opens = 0
    try {
      await expect(connectApp({ home: g.home, intent: 'open', env: {}, openApplication: async () => { opens++ } })).rejects.toThrow('源码模式请先显式启动')
      expect(opens).toBe(0)
      await expect(connectApp({ home: g.home, intent: 'open', appPath: g.app, env: {}, timeoutMs: 15, openApplication: async () => { opens++ } })).rejects.toThrow('未能在 15ms 内连接就绪服务')
      expect(opens).toBe(1)
    } finally { g.close() }
  })

  test('版本/source/App/数据实例不符直接报差异，不连接别处或再次打开', async () => {
    const g = cliGround()
    let opens = 0
    try {
      const options = { home: g.home, appPath: g.app, intent: 'open' as const, env: {}, openApplication: async () => { opens++ } }
      for (const [change, message] of [
        [{ version: 'different' }, '版本不匹配'],
        [{ protocol: 100 }, '协议或软件版本不匹配'],
        [{ source: '/another/runtime' }, '软件来源不匹配'],
        [{ app: join(g.root, 'Other.app') }, '另一 App'],
        [{ dataDir: join(g.root, 'other-data') }, '数据实例不匹配'],
      ] as const) {
        g.publish({ ...g.discovery, ...change })
        await expect(connectApp(options)).rejects.toThrow(message)
      }
      g.publish()
      await expect(connectApp({ ...options, env: { MAGIC_HOME: join(g.root, 'other') } })).rejects.toThrow('请在 App 设置中明确切换')
      expect(opens).toBe(0)
    } finally { g.close() }
  })

  test('握手 line 后关闭保留正在退出/身份拒绝的原因，主动入口也不再次 open', async () => {
    const g = cliGround()
    let opens = 0
    const server = fakeApp(g, (link) => { link.send({ t: 'line', text: 'Magic Code 正在退出：拒绝新接入' }); link.close() })
    try {
      g.publish()
      await expect(connectApp({ home: g.home, appPath: g.app, intent: 'open', env: {}, openApplication: async () => { opens++ } })).rejects.toThrow('正在退出：拒绝新接入')
      expect(opens).toBe(0)
    } finally { server.close(); g.close() }
  })

  test('/usr/bin/open 按绝对路径参数调用，无 shell、无 -n 多实例参数，失败带回原因', async () => {
    const calls: unknown[] = []
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((command: unknown) => {
      calls.push(command)
      return { exited: Promise.resolve(1), stderr: new Response('controlled open failure').body, kill() {} }
    }) as typeof Bun.spawn)
    try {
      await expect(openApplication('/isolated/Magic ; test.app')).rejects.toThrow('controlled open failure')
      expect(calls).toEqual([['/usr/bin/open', '/isolated/Magic ; test.app']])
    } finally { spawn.mockRestore() }
  })
})

test('留屏明确重开时先核原数据实例，差异不发送hello/session也不打开App', async () => {
  const g = cliGround()
  const server = fakeApp(g)
  let opened = false
  g.publish()
  try {
    await expect(reopenApp({
      home: g.home, appPath: g.app, env: {}, connect: { session: 'same-looking-id' },
      expectedInstance: { base: '/previous/.magic', dataDir: '/previous/data' },
      openApplication: async () => { opened = true },
    })).rejects.toThrow('App 数据实例已改变')
    expect(opened).toBe(false)
    expect(server.messages).toEqual([])
  } finally { server.close(); g.close() }
})
