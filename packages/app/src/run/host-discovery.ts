import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { NATIVE_PROTOCOL, SOFTWARE_VERSION, resolveMagicHome } from '@magic/contracts'
import type { HostDiscovery, MagicHome, ServiceIdentity } from '@magic/contracts'
import { loadConfig, type LoadedConfig } from '../config.ts'
import { normalizeDataDir } from './paths.ts'
import { softwareSource } from './runtime-launch.ts'

export type HostLocationOptions = {
  readonly home: string
  readonly executable?: string
  readonly standalone?: boolean
  /** 仅供源码开发与隔离测试显式指定；生产从 executable 反推所属 App。 */
  readonly appPath?: string
  readonly discoveryPath?: string
}

export type HostLocation = {
  readonly home: string
  readonly source: string
  readonly app?: string
  readonly discoveryPath: string
}

/**
 * 就绪记录的位置。**只有一个名字**（U109）：原先按 `development` 在两个名字之间分叉
 * （带 Dev 的那一个 / 不带的那一个）——那是旧的那套按 bundle 后缀分的身份留下的分叉。
 * 用户 2026-09-30 定：代码里不该留这种标记，一律按同一个形态处理，故这一格不再分叉。
 */
export function hostDiscoveryPath(home: string): string {
  return join(home, 'Library/Application Support', 'Magic Code', 'runtime/host.json')
}

/** 先解 executable 的符号链接，禁止按 App 名称搜索或猜另一份安装。 */
export function locateHost(options: HostLocationOptions): HostLocation {
  const home = options.home
  if (!(options.standalone ?? Bun.isStandaloneExecutable)) {
    return {
      home,
      source: softwareSource(),
      ...(options.appPath === undefined ? {} : { app: realpathSync(options.appPath) }),
      discoveryPath: options.discoveryPath ?? hostDiscoveryPath(home),
    }
  }

  const source = realpathSync(options.executable ?? process.execPath)
  const helpers = dirname(source)
  const contents = dirname(helpers)
  const app = dirname(contents)
  if (basename(helpers) !== 'Helpers' || basename(contents) !== 'Contents' ||
      !app.endsWith('.app') || basename(source) !== 'magic-runtime') {
    throw new Error(`CLI 不在所属 App 的 Contents/Helpers/magic-runtime 中：${source}；请从 App 重新安装终端命令`)
  }
  const plist = Bun.spawnSync([
    '/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleIdentifier', join(contents, 'Info.plist'),
  ], { stdout: 'pipe', stderr: 'pipe' })
  const bundle = plist.stdout.toString().trim()
  if (plist.exitCode !== 0 || bundle === '') throw new Error(`无法读取所属 App 的 bundle 身份：${app}`)
  return { home, source, app, discoveryPath: hostDiscoveryPath(home) }
}

/** 同版、同来源、同数据实例；有发现记录时还必须是同一宿主和服务代次。 */
export function assertHostIdentity(
  identity: ServiceIdentity,
  expected: Pick<ServiceIdentity, 'source'> & Partial<ServiceIdentity>,
): void {
  if (!identity || identity.protocol !== NATIVE_PROTOCOL || identity.version !== SOFTWARE_VERSION) {
    throw new Error('Magic Code 协议或软件版本不匹配；请退出原 App，再打开此 CLI 所属的同版 App')
  }
  if (identity.source !== expected.source) {
    throw new Error(`Magic Code 软件来源不匹配：CLI=${expected.source}，App=${identity.source}；请退出原 App 后再打开此版本`)
  }
  if (typeof identity.base !== 'string' || !isAbsolute(identity.base) ||
      typeof identity.hostInstance !== 'string' || identity.hostInstance === '' ||
      typeof identity.serviceInstance !== 'string' || identity.serviceInstance === '') {
    throw new Error('Magic Code 服务身份不完整：缺少数据实例、宿主或服务代次')
  }
  if (expected.base !== undefined && normalizeDataDir(identity.base) !== normalizeDataDir(expected.base)) {
    throw new Error(`Magic Code 数据实例不匹配：CLI=${expected.base}，App=${identity.base}；请在 App 设置中明确切换基础路径`)
  }
  if ((expected.hostInstance !== undefined && identity.hostInstance !== expected.hostInstance) ||
      (expected.serviceInstance !== undefined && identity.serviceInstance !== expected.serviceInstance)) {
    throw new Error('Magic Code 发现记录与当前宿主/服务代次不一致；请重新连接当前 App')
  }
}

/** 只读取 App 原子发布的发现文件；文件存在不代表服务还活着。 */
export function readHostDiscovery(location: HostLocation): HostDiscovery | undefined {
  let raw: string
  try {
    raw = readFileSync(location.discoveryPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`读不到 App 发现文件：${location.discoveryPath}`, { cause: error })
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch {
    throw new Error(`App 发现文件不是有效 JSON：${location.discoveryPath}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`App 发现文件形状无效：${location.discoveryPath}`)
  }
  const found = value as HostDiscovery
  assertHostIdentity(found, { source: location.source })
  for (const key of ['socket', 'app'] as const) {
    if (typeof found[key] !== 'string' || !isAbsolute(found[key])) {
      throw new Error(`App 发现文件 ${key} 必须是绝对路径：${location.discoveryPath}`)
    }
  }
  if (location.app !== undefined && normalizeDataDir(found.app) !== location.app) {
    throw new Error(`发现记录指向另一 App：${found.app}；当前 CLI 属于 ${location.app}`)
  }
  return found
}

/** base 已经含 .magic；未显式设置 MAGIC_HOME 时直接采用它，不再追加。 */
export function selectedHostConfig(
  discovery: HostDiscovery,
  options: { readonly home: string; readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> },
): { readonly magic: MagicHome; readonly loaded: LoadedConfig } {
  const explicit = (options.env['MAGIC_HOME']?.trim() ?? '') !== ''
  const base = explicit
    ? resolve(options.cwd, resolveMagicHome(options.env, options.home).base)
    : discovery.base
  const magic = { home: options.home, base }
  if (normalizeDataDir(base) !== normalizeDataDir(discovery.base)) {
    throw new Error(
      `Magic Code 数据实例不匹配：CLI 基础目录=${base}；` +
      `App 基础目录=${discovery.base}。` +
      '请在 App 设置中明确切换基础路径，或取消本次 MAGIC_HOME 后重试',
    )
  }
  return { magic, loaded: loadConfig({ magic }) }
}
