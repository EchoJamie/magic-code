import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { locateHost, readHostDiscovery, selectedHostConfig, hostDiscoveryPath } from '../src/run/host-discovery.ts'
import { connectApp, reopenApp } from '../src/run/spawn-manager.ts'
import { cliGround, fakeApp } from './resident-cli-fixture.ts'

describe('App 发现与显式打开', () => {
  test('发布版由 executable realpath 定位所属 bundle；正式与 .dev 身份使用各自发现路径', () => {
    const g = cliGround()
    try {
      const helper = join(g.app, 'Contents/Helpers/magic-runtime')
      mkdirSync(dirname(helper), { recursive: true })
      writeFileSync(helper, 'isolated executable fixture')
      const choice = join(g.root, 'magic')
      symlinkSync(helper, choice)
      // 原预期 → 新预期：原来按 bundle id 带不带 `.dev` **在两个目录之间分叉**
      // （带 Dev 的那个名字 / 不带的那一个）；U109 起**不再分叉**——两种身份都落在
      // **同一个**「Magic Code」下。依据：用户 2026-09-30 口径（代码里不留这种标记）。
      // **没变弱**：循环保留（两种 bundle id 都真跑一遍），断言从「跟着变」换成
      // 「**都一样**」——它现在显式钉住「不再分叉」，比原来那条只证「按 dev 分叉」更强。
      const seen: string[] = []
      for (const development of [false, true]) {
        writeFileSync(join(g.app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.magiccode.app${development ? '.dev' : ''}</string></dict></plist>`)
        const location = locateHost({ home: g.home, standalone: true, executable: choice, appPath: '/wrong.app', discoveryPath: '/wrong.json' })
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
      expect(() => locateHost({ home: g.home, standalone: true, executable: process.execPath })).toThrow('CLI 不在所属 App')
    } finally { g.close() }
  })

  test('发现是只读：缺席、坏 JSON、缺字段均不创建或修复文件', () => {
    const g = cliGround()
    try {
      const location = locateHost({ home: g.home })
      expect(readHostDiscovery(location)).toBeUndefined()
      g.publish({ ...g.discovery, base: 'relative' })
      expect(() => readHostDiscovery(location)).toThrow('服务身份不完整')
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
      expect(selected.loaded.config).not.toHaveProperty('dataDir')
      for (const configured of ['selected', dirname(g.base), '  selected/  ']) {
        expect(selectedHostConfig(g.discovery, { home: g.home, cwd: g.root, env: { MAGIC_HOME: configured } }).magic.base).toBe(g.base)
      }
      // 原预期 → 新预期：消息里原来同时报**基础目录**与数据目录两半；U109 把守卫收窄成
      // **只比数据实例**（设计 `:99`/`:97` 说的就是「数据实例」「数据目录」）之后，消息里
      // 报的是**真正被比的那一位**。依据：U109 裁决（守卫只比 `dataDir`）。
      // **没变弱**：两条判据仍是「以那个理由拒绝」，且报出的正是**判据本身**——原来那两半里
      // 有一半（基础目录）根本不该参与比较。
      expect(() => selectedHostConfig(g.discovery, { home: g.home, cwd: g.root, env: { MAGIC_HOME: 'elsewhere' } })).toThrow('CLI 基础目录=')
      expect(() => selectedHostConfig(g.discovery, { home: g.home, cwd: g.root, env: { MAGIC_HOME: 'elsewhere' } })).toThrow('App 基础目录=')
    } finally { g.close() }
  })

  test('主动入口先读取选择，再通过同包控制启动 Engine，已有连接直接复用', async () => {
    const g = cliGround(), actions: string[] = []
    let server: ReturnType<typeof fakeApp> | undefined
    const control = async (action: 'status' | 'start' | 'stop') => {
      actions.push(action)
      if (action === 'status') return { state: 'stopped' as const, base: g.base }
      server = fakeApp(g); g.publish()
      return { state: 'ready' as const, base: g.base, record: g.discovery }
    }
    try {
      const first = await connectApp({ home: g.home, appPath: g.app, intent: 'open', env: {}, control })
      expect(first.client.identity).toEqual(g.identity); first.client.close()
      const again = await reopenApp({ home: g.home, appPath: g.app, env: {}, control })
      again.client.close()
      expect(actions).toEqual(['status', 'start'])
    } finally { server?.close(); g.close() }
  })
  test('被动连接只查询状态，残留记录不能证明在线', async () => {
    const g = cliGround(), actions: string[] = []
    try {
      g.publish()
      await expect(connectApp({ home: g.home, env: {}, control: async action => {
        actions.push(action); return { state: 'unreachable', base: g.base, record: g.discovery }
      } })).rejects.toThrow('刷新与重连不会启动')
      expect(actions).toEqual(['status'])
      expect(JSON.parse(readFileSync(g.discoveryPath, 'utf8'))).toEqual(g.discovery)
    } finally { g.close() }
  })
  test('未发布发现记录时也先核终端显式实例，差异不启动 Engine', async () => {
    const g = cliGround(), actions: string[] = []
    try {
      await expect(connectApp({ home: g.home, intent: 'open', env: { MAGIC_HOME: join(g.root, 'other') }, control: async action => {
        actions.push(action); return { state: 'stopped', base: g.base }
      } })).rejects.toThrow('数据实例不匹配')
      expect(actions).toEqual(['status'])
      await expect(connectApp({ home: g.home, intent: 'open', env: {} })).rejects.toThrow('须明确指定同来源的原生包')
    } finally { g.close() }
  })
  test('版本、来源和原数据实例变化在握手前拒绝', async () => {
    const g = cliGround(), server = fakeApp(g)
    try {
      for (const [change, reason] of [
        [{ version: 'other' }, '版本不匹配'], [{ source: '/another/runtime' }, '来源不匹配'],
        [{ app: join(g.root, 'Other.app') }, '另一 App'],
      ] as const) {
        g.publish({ ...g.discovery, ...change })
        await expect(connectApp({ home: g.home, appPath: g.app, env: {} })).rejects.toThrow(reason)
      }
      g.publish()
      await expect(reopenApp({ home: g.home, env: {}, expectedInstance: { base: '/previous/.magic' } })).rejects.toThrow('数据实例已改变')
      expect(server.messages).toEqual([])
    } finally { server.close(); g.close() }
  })
  test('握手中明确拒绝新准入的原因保留，不再次启动', async () => {
    const g = cliGround(), server = fakeApp(g, link => { link.send({ t: 'line', text: '正在停止：拒绝新接入' }); link.close() })
    try {
      g.publish()
      await expect(connectApp({ home: g.home, intent: 'open', env: {} })).rejects.toThrow('正在停止：拒绝新接入')
    } finally { server.close(); g.close() }
  })
})


test('终端发起者退出不挂断已开始的短时 Engine 控制', async () => {
  const g = cliGround(), native = join(g.app, 'Contents/MacOS/control')
  const marker = join(g.root, 'accepted'), release = join(g.root, 'release'), done = join(g.root, 'done')
  mkdirSync(dirname(native), { recursive: true })
  writeFileSync(join(g.app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.magiccode.controlled.dev</string><key>CFBundleExecutable</key><string>control</string></dict></plist>')
  writeFileSync(native, `#!/usr/bin/python3
import os,time,json
from pathlib import Path
Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))
while not Path(${JSON.stringify(release)}).exists(): time.sleep(.01)
Path(${JSON.stringify(done)}).write_text('finished')
`, { mode: 0o700 })
  const source = new URL('../src/run/spawn-manager.ts', import.meta.url).pathname
  const parent = Bun.spawn([process.execPath, '-e', `import {controlEngine} from ${JSON.stringify(source)}; await controlEngine('stop', ${JSON.stringify({ home: g.home, appPath: g.app, env: {} })})`], { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  let controller: number | undefined
  const until = async (check: () => boolean) => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('短控制状态未到'); await Bun.sleep(10) } }
  try {
    await until(() => existsSync(marker)); controller = Number(readFileSync(marker, 'utf8'))
    const group = Number(Bun.spawnSync(['/bin/ps', '-o', 'pgid=', '-p', String(controller)]).stdout.toString().trim())
    expect(group).not.toBe(parent.pid)
    process.kill(-parent.pid, 'SIGHUP'); await parent.exited
    expect(() => process.kill(controller!, 0)).not.toThrow()
    writeFileSync(release, 'continue')
    await until(() => existsSync(done))
    expect(readFileSync(done, 'utf8')).toBe('finished')
  } finally {
    if (parent.exitCode === null) { parent.kill('SIGKILL'); await parent.exited }
    if (controller) { try { process.kill(controller, 'SIGKILL') } catch {} }
    g.close()
  }
}, 10000)
