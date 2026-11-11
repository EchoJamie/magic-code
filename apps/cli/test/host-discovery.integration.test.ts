import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, renameSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { connectApp, reopenApp } from '../src/run/spawn-manager.ts'
import { cliGround, fakeApp } from './resident-cli-fixture.ts'
import { locateHost, hostDiscoveryPath } from '../src/run/host-discovery.ts'







describe('Engine 发现与显式打开', () => {

  test('主动入口先读取选择，再通过独立控制入口启动 Engine，已有连接直接复用', async () => {
    const g = cliGround(), actions: string[] = []
    let server: ReturnType<typeof fakeApp> | undefined
    const control = async (action: 'status' | 'start' | 'stop') => {
      actions.push(action)
      if (action === 'status') return { state: 'stopped' as const, base: g.base }
      server = fakeApp(g); g.publish()
      return { state: 'ready' as const, base: g.base, record: g.discovery }
    }
    try {
      const first = await connectApp({ home: g.home, enginePath: g.identity.source, intent: 'open', env: {}, control })
      expect(first.client.identity).toEqual(g.identity); first.client.close()
      const again = await reopenApp({ home: g.home, enginePath: g.identity.source, env: {}, control })
      again.client.close()
      expect(actions).toEqual(['status', 'start'])
    } finally { server?.close(); g.close() }
  })
  test('版本、来源和原数据实例变化在握手前拒绝', async () => {
    const g = cliGround(), server = fakeApp(g)
    try {
      for (const [change, reason] of [
        [{ version: 'other' }, '版本不匹配'], [{ source: '/another/runtime' }, '来源不匹配'],
      ] as const) {
        g.publish({ ...g.discovery, ...change })
        await expect(connectApp({ home: g.home, enginePath: g.identity.source, env: {} })).rejects.toThrow(reason)
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
  const g = cliGround(), native = join(g.root, 'magic-engine')
  const marker = join(g.root, 'accepted'), release = join(g.root, 'release'), done = join(g.root, 'done')
  mkdirSync(dirname(native), { recursive: true })
  writeFileSync(native, `#!/usr/bin/python3
import os,time,json
from pathlib import Path
Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))
while not Path(${JSON.stringify(release)}).exists(): time.sleep(.01)
Path(${JSON.stringify(done)}).write_text('finished')
`, { mode: 0o700 })
  const source = new URL('../src/run/spawn-manager.ts', import.meta.url).pathname
  const parent = Bun.spawn([process.execPath, '-e', `import {controlEngine} from ${JSON.stringify(source)}; await controlEngine('stop', ${JSON.stringify({ home: g.home, enginePath: native, env: {} })})`], { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
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





describe('Engine 发现与显式打开', () => {
  test('发布版只按登记或显式选定的 Engine 定位，CLI 与 App 位置不参与服务来源', () => {
    const g = cliGround()
    try {
      const engine = join(g.root, 'independent-engine'), alias = join(g.root, 'engine-link')
      writeFileSync(engine, 'isolated executable fixture'); symlinkSync(engine, alias)
      const location = locateHost({ home: g.home, standalone: true, enginePath: alias })
      expect(location.source).toBe(realpathSync(engine)); expect(location.discoveryPath).toBe(hostDiscoveryPath(g.home))
      expect(location).not.toHaveProperty('app')
      const manifest = join(g.home, 'Library/Application Support/Magic Code/components.json')
      mkdirSync(dirname(manifest), { recursive: true }); writeFileSync(manifest, JSON.stringify({ engine }))
      expect(locateHost({ home: g.home, standalone: true }).source).toBe(realpathSync(engine))
      const moved = join(g.root, 'moved-engine'); renameSync(engine, moved)
      expect(() => locateHost({ home: g.home, standalone: true })).toThrow('组件不存在')
      writeFileSync(manifest, JSON.stringify({ engine: moved }))
      expect(locateHost({ home: g.home, standalone: true }).source).toBe(realpathSync(moved))
    } finally { g.close() }
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
})
