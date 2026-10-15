import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { NATIVE_PROTOCOL, SOFTWARE_VERSION, resolveMagicHome } from '@magic/contracts'
import type { HostDiscovery, MagicHome, ServiceIdentity } from '@magic/contracts'
import { loadConfig, type LoadedConfig } from '@magic/config'
import { normalizeDataDir } from './paths.ts'
import { softwareSource } from './runtime-launch.ts'
import { componentSource, readComponents } from '../components.ts'

export type HostLocationOptions = {
  readonly home: string
  /** 显式选定 Engine；未给时读安装记录，源码开发使用 engine.ts。 */
  readonly enginePath?: string
  readonly standalone?: boolean
  readonly discoveryPath?: string
}
export type HostLocation = {
  readonly home: string
  readonly source: string
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

/** 客户端位置不参与 Engine 身份；只读取已登记或显式选定的目标。 */
export function locateHost(options: HostLocationOptions): HostLocation {
  const installed = options.enginePath ?? readComponents(options.home)?.engine
  const source = installed === undefined
    ? !(options.standalone ?? Bun.isStandaloneExecutable) ? softwareSource() : undefined
    : componentSource(installed)
  if (!source) throw new Error('Magic Engine 未安装，请运行终端安装或 App 完整安装')
  return { home: options.home, source, discoveryPath: options.discoveryPath ?? hostDiscoveryPath(options.home) }
}

/** 同版、同来源、同数据实例；有发现记录时还必须是同一Engine 代次。 */
export function assertHostIdentity(
  identity: ServiceIdentity,
  expected: Pick<ServiceIdentity, 'source'> & Partial<ServiceIdentity>,
): void {
  if (!identity || identity.protocol !== NATIVE_PROTOCOL || identity.version !== SOFTWARE_VERSION) {
    throw new Error('Magic Engine 协议或软件版本不匹配；请使用同版组件')
  }
  if (identity.source !== expected.source) {
    throw new Error(`Magic Code 软件来源不匹配：选定 Engine=${expected.source}，实际服务=${identity.source}`)
  }
  if (typeof identity.base !== 'string' || !isAbsolute(identity.base) ||
      typeof identity.serviceInstance !== 'string' || identity.serviceInstance === '') {
    throw new Error('Magic Code 服务身份不完整：缺少数据实例、Engine 代次')
  }
  if (expected.base !== undefined && normalizeDataDir(identity.base) !== normalizeDataDir(expected.base)) {
    throw new Error(`Magic Code 数据实例不匹配：请求=${expected.base}，Engine=${identity.base}；请明确切换基础路径`)
  }
  if (expected.serviceInstance !== undefined && identity.serviceInstance !== expected.serviceInstance) {
    throw new Error('Magic Code 发现记录与当前 Engine 代次不一致；请重新连接当前 Engine')
  }
}

/** 只读取 Engine 原子发布的发现文件；文件存在不代表服务还活着。 */
export function readHostDiscovery(location: HostLocation): HostDiscovery | undefined {
  let raw: string
  try {
    raw = readFileSync(location.discoveryPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`读不到 Engine 发现文件：${location.discoveryPath}`, { cause: error })
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch {
    throw new Error(`Engine 发现文件不是有效 JSON：${location.discoveryPath}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Engine 发现文件形状无效：${location.discoveryPath}`)
  }
  const found = value as HostDiscovery
  assertHostIdentity(found, { source: location.source })
  if (typeof found.socket !== 'string' || !isAbsolute(found.socket)) throw new Error(`Engine 发现文件 socket 必须是绝对路径：${location.discoveryPath}`)
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
      `Engine 基础目录=${discovery.base}。` +
      '请明确切换基础路径，或取消本次 MAGIC_HOME 后重试',
    )
  }
  return { magic, loaded: loadConfig({ magic }) }
}
