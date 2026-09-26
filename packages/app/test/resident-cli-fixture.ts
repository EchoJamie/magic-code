/** CLI/discovery/client 用的临时文件与真实 Unix socket；不会启动 App 或访问用户配置。 */
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { NATIVE_PROTOCOL, SOFTWARE_VERSION } from '@magic/contracts'
import type { ClientToManager, HostDiscovery, ManagerToClient, ServiceIdentity } from '@magic/contracts'
import { hostDiscoveryPath } from '../src/run/host-discovery.ts'
import { softwareSource } from '../src/run/runtime-launch.ts'
import { linkOf, socketHandlers, type Link } from '../src/run/wire.ts'

/** 供假服务与专用 stdin 真宿主共用；value 允许非法夹具以覆盖拒绝路径。 */
export function publishHostDiscovery(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function cliGround() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-cli-')))
  const home = join(root, 'home')
  const base = join(root, 'selected/.magic')
  const dataDir = join(root, 'data')
  const app = join(root, 'Magic ; test.app')
  for (const path of [home, base, dataDir, app]) mkdirSync(path, { recursive: true })
  writeFileSync(join(base, 'config.json'), JSON.stringify({ providers: {}, dataDir }))
  const discoveryPath = hostDiscoveryPath(home, true)
  const identity: ServiceIdentity = {
    protocol: NATIVE_PROTOCOL, version: SOFTWARE_VERSION, source: softwareSource(),
    hostInstance: 'host-one', serviceInstance: 'service-one', dataDir,
  }
  const discovery: HostDiscovery = { ...identity, app, base, socket: join(root, 's.sock') }
  return {
    root, home, base, dataDir, app, discoveryPath, discovery, identity,
    publish(value: unknown = discovery, path = discoveryPath) {
      publishHostDiscovery(path, value)
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  }
}

export function fakeApp(
  ground: ReturnType<typeof cliGround>,
  onHello?: (link: Link<ClientToManager>, hello: Extract<ClientToManager, { t: 'hello' }>) => void,
) {
  const messages: ClientToManager[] = []
  const links: Link<ClientToManager>[] = []
  const welcome: Extract<ManagerToClient, { t: 'welcome' }> = {
    t: 'welcome', identity: ground.identity, conn: 1, dataDir: ground.dataDir,
    mcp: [], runs: [], notices: [{ id: 'unread', session: 'real-session', kind: 'needs-you', at: 1, unread: true }],
  }
  const server = Bun.listen({
    unix: ground.discovery.socket,
    socket: socketHandlers((socket) => {
      const link = linkOf<ClientToManager>(socket as never)
      links.push(link)
      link.onMessage((message) => {
        messages.push(message)
        if (message.t === 'hello') {
          if (onHello) onHello(link, message)
          else link.send(welcome)
        }
      })
    }),
  })
  return { messages, links, welcome, close() { for (const link of links) link.close(); server.stop(true) } }
}

export async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待 CLI 测试事实超时')
    await Bun.sleep(2)
  }
}
